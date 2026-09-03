/**
 * Fill reconciler — fired as a fire-and-forget background task after a filled
 * order. Fetches the fills detail from Kalshi's fills API, then:
 *  1. Persists each individual fill chunk to order_fills in SQL.
 *  2. Updates order_attempts.fill_price_cents with the verified weighted average
 *     and sets reconciled=true so fill prices survive server restarts.
 *  3. Sets fill_price_source = 'actual' on the order_attempts row.
 *  4. Calls analytics.recordReconciliation() with confirmed values.
 *
 * Retries with exponential backoff because Kalshi's fills endpoint has a brief
 * propagation delay after an IOC order completes — hitting it immediately
 * returns a 404 even for a legitimate order ID.
 *
 * Retry schedule: attempt 1 after 2 s, attempt 2 after 5 s, attempt 3 after 10 s.
 * If all attempts fail, recordReconciliationFailed() is called so the order row
 * carries a permanent reconcile_failed flag instead of silently staying estimated.
 *
 * This never blocks order submission, never modifies trading state, and never
 * throws into its caller.
 */

import { kalshiAuthFetch } from "./kalshiAuth.js";
import { logger } from "./logger.js";
import { easternDay } from "./dailyBudget.js";
import {
  recordReconciliation,
  recordReconciliationFailed,
  type ReconciliationParams,
} from "./analytics.js";
import {
  loadUnreconciledFilledOrders,
  loadKnownOrderIdsForEasternDate,
  persistVerifiedFillReconciliation,
  persistReconciliationFailureAudit,
  verifyReconciliationOwnership,
  loadKalshiOrderIdsForDate,
  persistSweepCompletion,
  upsertMarketResultInSql,
  markWonForSettledTicker,
  type OrderFillRow,
} from "./tradeStore.js";
import {
  normalizeKalshiFill,
  type KalshiFillWire,
  type KalshiAllFillsWire,
  inferSideFromAllFillsWire,
} from "./kalshiFillNormalizer.js";

interface KalshiOrderFillsResponse {
  fills?: KalshiFillWire[];
  [key: string]: unknown;
}

interface KalshiHistoryFill extends KalshiFillWire {
  order_id?: unknown;
}

/** Per-fill data returned from fetchFills alongside the aggregated params. */
interface FillsResult {
  params:   ReconciliationParams;
  fillRows: OrderFillRow[];
}

/**
 * Build the stable primary-key string for an order_fills row.
 *
 * When Kalshi provides a fill_id (their exchange-assigned UUID), use it so
 * that repeated fetches of the same fill — even in a different response order
 * — always map to the same SQL row.  Fall back to the position-based format
 * for fills that arrive without a fill_id (pre-migration wire responses).
 */
function fillRowPk(orderId: string, fillId: string | null, seqIndex: number): string {
  return fillId != null ? `${orderId}:fid:${fillId}` : `${orderId}:${seqIndex}`;
}
/** Millisecond delays between attempts (before attempt 1, before attempt 2, before attempt 3). */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test-only injection points ────────────────────────────────────────────────
// Allows unit tests to swap out the HTTP call without mocking the whole module.
// In production this always points to fetchFills defined below.

// The test injection seam uses the internal fetchFills signature which now
// carries an optional sqlAttemptId; tests that don't care about it can ignore it.
type FetchFillsFn = typeof fetchFills;
let _fetchFillsImpl: FetchFillsFn | null = null; // null = use the real fetchFills

// Allows tests to intercept kalshiAuthFetch at the level below fetchFills, so
// the URL path can be asserted without going through the real Kalshi network.
type KalshiAuthFetchFn = typeof kalshiAuthFetch;
let _kalshiAuthFetchImpl: KalshiAuthFetchFn | null = null;
type LoadKnownOrderIdsForEasternDateFn = typeof loadKnownOrderIdsForEasternDate;
let _loadKnownOrderIdsForEasternDateImpl: LoadKnownOrderIdsForEasternDateFn | null = null;
type VerifyReconciliationOwnershipFn = typeof verifyReconciliationOwnership;
let _verifyReconciliationOwnershipImpl: VerifyReconciliationOwnershipFn | null = null;
const reconciliationMetrics = {
  scheduled: 0, missingAttemptId: 0, missingKalshiOrderId: 0, noFillsAfterRetries: 0,
  persistenceSuccess: 0, persistenceFailure: 0, storageUnavailable: 0,
};
let recoverySweepInFlight = false;
let exchangeCoverageInFlight = false;
let exchangeCoverageStatus: {
  easternDate: string;
  checkedAt: string | null;
  unmatchedOrderCount: number | null;
  complete: boolean | null;
  truncated: boolean;
  lastError: string | null;
} = {
  easternDate: easternDay(new Date()),
  checkedAt: null,
  unmatchedOrderCount: null,
  complete: null,
  truncated: false,
  lastError: null,
};

export function getFillReconciliationStatus() {
  return { ...reconciliationMetrics };
}

/**
 * Exchange coverage is separate from per-order fill repair. It never writes to
 * Kalshi and it never imports an unmatched order: a same-day exchange fill with
 * no durable local parent makes verification incomplete until its provenance is
 * recovered or explicitly reviewed.
 */
export function getExchangeCoverageStatus() {
  const today = easternDay(new Date());
  if (exchangeCoverageStatus.easternDate !== today) {
    return {
      easternDate: today, checkedAt: null, unmatchedOrderCount: null,
      complete: null, truncated: false, lastError: null,
    };
  }
  return { ...exchangeCoverageStatus };
}

/**
 * Read-only exchange-history coverage. The optional ceiling exists solely as a
 * circuit breaker for tests/operators; production callers omit it and consume
 * every cursor page. A ceiling never reports coverage as complete.
 */
export async function checkExchangeFillCoverage(maxFills?: number): Promise<void> {
  if (exchangeCoverageInFlight) return;
  exchangeCoverageInFlight = true;
  const today = easternDay(new Date());
  try {
    const knownOrderIds = await (_loadKnownOrderIdsForEasternDateImpl ?? loadKnownOrderIdsForEasternDate)(today);
    const unmatchedOrderIds = new Set<string>();
    let cursor: string | undefined;
    let fetched = 0;

    while (true) {
      const remaining = maxFills == null ? 100 : maxFills - fetched;
      if (remaining <= 0) break;
      const limit = Math.min(100, remaining);
      const qs = new URLSearchParams({ limit: String(limit) });
      if (cursor) qs.set("cursor", cursor);
      const data = await (_kalshiAuthFetchImpl ?? kalshiAuthFetch)<{
        fills?: KalshiHistoryFill[];
        cursor?: string;
      }>("GET", `/portfolio/fills?${qs}`);
      const fills = data.fills ?? [];
      const nextCursor = typeof data.cursor === "string" && data.cursor.length > 0
        ? data.cursor
        : undefined;
      fetched += fills.length;

      for (const fill of fills) {
        const orderId = typeof fill.order_id === "string" ? fill.order_id : "";
        const created = typeof fill.created_time === "string" ? new Date(fill.created_time) : null;
        if (!orderId || !created || Number.isNaN(created.getTime()) || easternDay(created) !== today) continue;
        if (!knownOrderIds.has(orderId)) unmatchedOrderIds.add(orderId);
      }

      // Kalshi can legally return a short page with a cursor. The cursor, not
      // page length, is authoritative for whether history remains unread.
      if (!nextCursor) {
        cursor = nextCursor;
        break;
      }
      cursor = nextCursor;
    }
    const truncated = cursor !== undefined && maxFills != null && fetched >= maxFills;

    exchangeCoverageStatus = {
      easternDate: today,
      checkedAt: new Date().toISOString(),
      // A capped sample cannot prove exchange coverage. Do not report a zero
      // unmatched count as complete when a later page was not inspected.
      unmatchedOrderCount: truncated ? null : unmatchedOrderIds.size,
      complete: !truncated,
      truncated,
      lastError: truncated ? "exchange coverage is limited; additional fills were not checked" : null,
    };
    logger.info(
      { easternDate: today, fetched, unmatchedOrderCount: unmatchedOrderIds.size, truncated },
      truncated
        ? "fillReconciler: exchange fill coverage check limited by request cap"
        : "fillReconciler: exchange fill coverage check complete",
    );
  } catch (err) {
    exchangeCoverageStatus = {
      easternDate: today,
      checkedAt: new Date().toISOString(),
      unmatchedOrderCount: null,
      complete: false,
      truncated: false,
      lastError: "exchange history check failed",
    };
    logger.warn({ err, easternDate: today }, "fillReconciler: exchange fill coverage check failed");
  } finally {
    exchangeCoverageInFlight = false;
  }
}

export function _resetFillReconciliationStatusForTesting(): void {
  for (const key of Object.keys(reconciliationMetrics) as Array<keyof typeof reconciliationMetrics>) reconciliationMetrics[key] = 0;
}

/** Reset bounded exchange-coverage state between unit tests. */
export function _resetExchangeCoverageStatusForTesting(): void {
  exchangeCoverageInFlight = false;
  exchangeCoverageStatus = {
    easternDate: easternDay(new Date()),
    checkedAt: null,
    unmatchedOrderCount: null,
    complete: null,
    truncated: false,
    lastError: null,
  };
}

/** Replace the fetchFills implementation for testing. Pass null to restore production behaviour. */
export function _setFetchFillsForTesting(fn: FetchFillsFn | null): void {
  _fetchFillsImpl = fn;
}

/**
 * Replace kalshiAuthFetch at the fetchFills level.  This lets tests verify the
 * exact URL path (e.g. /portfolio/fills?order_id=…) without hitting the network.
 * Pass null to restore the real implementation.
 */
export function _setKalshiAuthFetchForTesting(fn: KalshiAuthFetchFn | null): void {
  _kalshiAuthFetchImpl = fn;
}

/** Override the durable ownership reader used by exchange coverage tests. */
export function _setLoadKnownOrderIdsForEasternDateForTesting(
  fn: LoadKnownOrderIdsForEasternDateFn | null,
): void {
  _loadKnownOrderIdsForEasternDateImpl = fn;
}

/** Test-only ownership verifier seam. Production always checks persisted SQL ownership. */
export function _setVerifyReconciliationOwnershipForTesting(
  fn: VerifyReconciliationOwnershipFn | null,
): void {
  _verifyReconciliationOwnershipImpl = fn;
}

/**
 * Pure calculation: given a list of Kalshi fill records and the outcome side,
 * compute the weighted-average fill price, total contracts, total notional, and
 * total fee. Returns null when there are no valid contracts.
 *
 * Exported so unit tests can exercise the arithmetic without mocking HTTP calls.
 *
 * Price interpretation:
 *   - Kalshi fill prices are in decimal: 0.86 = 86¢
 *   - For YES orders: outcome cost per contract = yes_price × 100 cents
 *   - For NO orders:  outcome cost per contract = no_price  × 100 cents
 *   - fee_cost is a dollar-decimal string (same format as yes_price/no_price), e.g. "0.0010" = $0.001
 */
export function computeFillParams(
  fills: readonly KalshiFillWire[],
  side: "yes" | "no",
): ReconciliationParams | null {
  let totalContracts        = 0;
  let weightedPriceCentsSum = 0;
  let totalNotionalDollars  = 0;
  let totalFeeDollars       = 0;

  for (const fill of fills) {
    const normalized = normalizeKalshiFill(fill, side);
    if (!normalized) continue;
    const { contracts: count, fillPriceCents: priceCents, exactCostDollars, feeDollars } = normalized;

    totalContracts        += count;
    weightedPriceCentsSum += priceCents * count;
    // Use exact string-based cost (BigInt multiplication) so fractional-cent
    // prices don't accumulate floating-point drift across many fills.
    totalNotionalDollars  += Number(exactCostDollars);
    totalFeeDollars       += feeDollars;
  }

  if (totalContracts === 0) return null;

  const avgFillPriceCents = Math.round(weightedPriceCentsSum / totalContracts);
  // Do not derive cost from the rounded average: split fills can have different
  // prices, and the parent P&L must equal the sum of Kalshi's actual chunks.
  const notionalDollars   = totalNotionalDollars;
  const feeDollars        = totalFeeDollars;

  return { contracts: totalContracts, fillPriceCents: avgFillPriceCents, notionalDollars, feeDollars };
}
/**
 * Attempt one fetch to the fills endpoint.
 * Returns parsed params + individual fill rows on success,
 * null when the endpoint returns empty fills, and throws on network / auth errors.
 *
 * The per-chunk fillRows loop runs alongside the aggregate calculation so both
 * can be built in a single pass. computeFillParams() is the exported pure
 * equivalent used by unit tests (no HTTP, no fillRows).
 *
 * @param sqlAttemptId - When provided, stored as order_fills.attempt_id (FK → order_attempts.id).
 *   Must be the raw SQL primary key UUID.  Defaults to attemptId when omitted (recovery sweep
 *   path, where both IDs are the same SQL PK).
 */
async function fetchFills(
  orderId:      string,
  attemptId:    string,
  side:         "yes" | "no",
  ticker:       string,
  sqlAttemptId?: string,
): Promise<FillsResult | null> {
  const authFetch = (_kalshiAuthFetchImpl ?? kalshiAuthFetch) as typeof kalshiAuthFetch;
  const data = await authFetch<KalshiOrderFillsResponse>(
    "GET",
    `/portfolio/fills?order_id=${encodeURIComponent(orderId)}`,
  );

  const fills = data.fills ?? [];
  if (fills.length === 0) {
    logger.debug({ orderId, attemptId }, "fillReconciler: no fills returned from API");
    return null;
  }

  let totalContracts        = 0;
  let weightedPriceCentsSum = 0;
  let totalNotionalDollars  = 0;
  let totalFeeDollars       = 0;

  const fillRows: OrderFillRow[] = [];

  for (let i = 0; i < fills.length; i++) {
    const fill  = fills[i]!;
    const normalized = normalizeKalshiFill(fill, side);
    // A fill without Kalshi's immutable identity cannot enter the forward ledger.
    // Any fill in the response missing its identity makes the ENTIRE response
    // unsafe — reject it completely so no partial subset is ever persisted.
    if (!normalized || !normalized.fillId) {
      logger.warn(
        { orderId, attemptId, fillIndex: i },
        "fillReconciler: fill missing identity or exact economics — rejecting entire response (fail-closed)",
      );
      return null;
    }
    const {
      fillId,
      contracts: count,
      fillPriceCents: priceCents,
      exactPriceDollars,
      exactCostDollars,
      feeDollars: validFee,
      exactFeeDollars,
      fillTimestamp,
    } = normalized;

    totalContracts        += count;
    weightedPriceCentsSum += priceCents * count;
    // Use exact string-based cost (BigInt multiplication) so fractional-cent
    // prices don't accumulate floating-point drift across many fills.
    totalNotionalDollars  += Number(exactCostDollars);
    totalFeeDollars       += validFee;

    const costDollars = Number(exactCostDollars);
    const feeDollars  = validFee; // already in dollars — no /100

    fillRows.push({
      seqIndex:          i,
      fillId,
      orderId,
      // Use the SQL primary key (order_attempts.id) as the FK value stored in
      // order_fills.attempt_id.  When callers pass a compound analytics ID
      // (e.g. "${clientOrderId}-${attemptNumber}"), they must also supply the
      // raw UUID via sqlAttemptId so the JOIN to order_attempts is never broken.
      attemptId:      sqlAttemptId ?? attemptId,
      ticker,
      side,
      fillPriceCents:    priceCents,
      contracts:         count,
      costDollars,
      feeDollars,
      exactPriceDollars,
      exactCostDollars,
      exactFeeDollars,
      fillTimestamp,
    });
  }

  if (totalContracts === 0) {
    logger.debug({ orderId, attemptId }, "fillReconciler: fills parsed but no contracts counted");
    return null;
  }

  const avgFillPriceCents = Math.round(weightedPriceCentsSum / totalContracts);
  // Notional is the exact sum of the fill chunks, not contracts × a rounded
  // weighted average price.
  const notionalDollars   = totalNotionalDollars;
  const feeDollars        = totalFeeDollars;

  const params: ReconciliationParams = {
    contracts:       totalContracts,
    fillPriceCents:  avgFillPriceCents,
    notionalDollars,
    feeDollars,
  };

  return { params, fillRows };
}

/**
 * Reconcile a filled order against Kalshi's fills endpoint.
 * Retries up to RETRY_DELAYS_MS.length times with exponential backoff before giving up.
 *
 * @param attemptId    - The in-memory analytics ID (from recordOrderAttempt; used for
 *                       recordReconciliation / recordReconciliationFailed lookups).
 *                       From autoTrader this is "${clientOrderId}-${attemptNumber}".
 * @param orderId      - Kalshi's order ID (from the order response)
 * @param side         - The outcome side the bot bought ("yes" | "no")
 * @param limitCents   - The limit price in outcome cents (kept for API compatibility; unused)
 * @param ticker       - The Kalshi market ticker (used when writing order_fills rows)
 * @param sqlAttemptId - The SQL primary key of the order_attempts row (order_attempts.id),
 *                       stored as order_fills.attempt_id so JOINs to order_attempts work.
 *                       When omitted, attemptId is used for both roles (recovery sweep path,
 *                       where loadUnreconciledFilledOrders already returns the SQL PK).
 */
export async function reconcileOrder(
  attemptId:     string,
  orderId:       string,
  side:          "yes" | "no",
  limitCents:    number,
  ticker?:       string,
  sqlAttemptId?: string,
): Promise<void> {
  reconciliationMetrics.scheduled++;
  if (!attemptId) { reconciliationMetrics.missingAttemptId++; return; }
  if (!orderId) { reconciliationMetrics.missingKalshiOrderId++; return; }

  void limitCents; // kept in signature for API compatibility; not needed post-retry

  const resolvedTicker = ticker ?? "";
  const persistedAttemptId = sqlAttemptId ?? attemptId;
  if (!resolvedTicker || !persistedAttemptId) {
    logger.warn({ orderId, attemptId }, "fillReconciler: reconciliation ownership identity missing; refusing all writes");
    return;
  }
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    // Always wait before each attempt — Kalshi needs propagation time even on the first try.
    const delayMs = RETRY_DELAYS_MS[attempt]!;
    await sleep(delayMs);

    try {
      // The order finalisation is asynchronous, so verify after the normal
      // propagation delay immediately before the first fills read. This still
      // happens before every possible reconciliation write, while allowing the
      // just-acknowledged exchange ID to become durably bound to its parent.
      // The persistence transaction repeats the tuple check to close races
      // between this preflight and the actual durable mutation.
      if (attempt === 0) {
        const owned = await (_verifyReconciliationOwnershipImpl ?? verifyReconciliationOwnership)({
          attemptId: persistedAttemptId, orderId, ticker: resolvedTicker,
        });
        if (!owned) {
          logger.warn({ orderId, attemptId: persistedAttemptId, ticker: resolvedTicker },
            "fillReconciler: ownership tuple not persisted and real; refusing reconciliation");
          return;
        }
      }
      const result = await (_fetchFillsImpl ?? fetchFills)(orderId, attemptId, side, resolvedTicker, persistedAttemptId);

      if (result === null) {
        // Empty fills: may still be propagating — retry unless this is the last attempt.
        if (attempt < RETRY_DELAYS_MS.length - 1) {
          logger.debug(
            { orderId, attemptId, attempt: attempt + 1, nextDelayMs: RETRY_DELAYS_MS[attempt + 1] },
            "fillReconciler: empty fills response — will retry",
          );
          continue;
        }
        // All retries exhausted with empty fills.
        logger.warn(
          { orderId, attemptId, attempts: attempt + 1, analytics_error: true },
          "fillReconciler: no fills after all retries — marking reconcile_failed",
        );
        recordReconciliationFailed(attemptId);
        try {
          await persistReconciliationFailureAudit({
            orderId, attemptId: persistedAttemptId, ticker: resolvedTicker, reason: "empty_fills", retryAttempt: attempt + 1,
          });
        } catch (persistErr) {
          logger.warn({ err: persistErr, orderId }, "fillReconciler: unable to persist reconciliation failure audit");
        }
        reconciliationMetrics.noFillsAfterRetries++;
        return;
      }

      const { params, fillRows } = result;

      // Persist child chunks and the parent fee/notional totals in one
      // transaction. A durable P&L reader can therefore never observe partial
      // reconciliation (such as fills present while fee_dollars remains zero).
      // Production fetches always produce one row per valid fill. A row-less
      // result exists only through the unit-test injection seam, where there is
      // no SQL store to persist to.
      if (fillRows.length > 0) {
        await persistVerifiedFillReconciliation(fillRows, params);
      }
      reconciliationMetrics.persistenceSuccess++;

      // Update in-memory analytics only after durable reconciliation succeeds.
      recordReconciliation(attemptId, params);
      logger.debug(
        {
          orderId, attemptId, attempt: attempt + 1,
          fillChunks:        fillRows.length,
          totalContracts:    params.contracts,
          avgFillPriceCents: params.fillPriceCents,
          feeDollars:        params.feeDollars,
        },
        "fillReconciler: reconciliation complete",
      );
      return;

    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      reconciliationMetrics.persistenceFailure++;
      if (e.message?.includes("storage unavailable")) reconciliationMetrics.storageUnavailable++;
      const isLast = attempt === RETRY_DELAYS_MS.length - 1;

      if (isLast) {
        // All retries exhausted — store the failure flag and log a warning.
        logger.warn(
          { err, orderId, attemptId, status: e.status, attempts: attempt + 1, analytics_error: true },
          "fillReconciler: reconcileOrder failed after all retries — marking reconcile_failed",
        );
        recordReconciliationFailed(attemptId);
        try {
          await persistReconciliationFailureAudit({
            orderId, attemptId: persistedAttemptId, ticker: resolvedTicker, reason: "request_error",
            httpStatus: e.status, retryAttempt: attempt + 1,
          });
        } catch (persistErr) {
          logger.warn({ err: persistErr, orderId }, "fillReconciler: unable to persist reconciliation failure audit");
        }
        reconciliationMetrics.noFillsAfterRetries++;
      } else {
        // Transient failure (e.g. 404 propagation delay) — log at debug and retry.
        logger.debug(
          { orderId, attemptId, attempt: attempt + 1, status: e.status, message: e.message },
          "fillReconciler: attempt failed — will retry",
        );
      }
    }
  }
}

/**
 * Repair filled orders left unreconciled by an earlier restart or a temporary
 * fills-endpoint failure. This includes rows previously marked reconcile_failed:
 * that flag only records that the short initial retry window elapsed, not that
 * Kalshi can never publish the fill. Runs sequentially to avoid a burst of
 * Kalshi API requests; it never submits, changes, or cancels an order.
 */
export async function reconcileUnreconciledFilledOrders(maxOrders = 50): Promise<void> {
  if (recoverySweepInFlight) {
    logger.debug("fillReconciler: recovery sweep already in progress");
    return;
  }
  recoverySweepInFlight = true;
  try {
    const orders = await loadUnreconciledFilledOrders(maxOrders);
    if (orders.length === 0) return;

    logger.info({ count: orders.length }, "fillReconciler: repairing unreconciled filled orders");
    for (const order of orders) {
      await reconcileOrder(order.attemptId, order.orderId, order.side, 0, order.ticker, order.attemptId);
    }
  } finally {
    recoverySweepInFlight = false;
  }
}

/**
 * Tracks per-day discovery sweep status. Reset on server restart so the sweep
 * re-runs after each deployment (makes it safe to re-run indefinitely).
 */
interface SweepStatus {
  complete:           boolean;
  discoveredCount:    number;
  unmatchedBotFillCount: number;
  lastRunAt:       number;
  error:           string | null;
  /**
   * True when the fetch was halted by the safety page cap with a remaining
   * cursor — some fills may not have been seen.  When true, complete stays false
   * so the dashboard continues to show the "verifying" state and the sweep can
   * be re-triggered.
   */
  truncated:       boolean;
}

type PersistSweepCompletionFn = (easternDate: string, discoveredCount: number) => Promise<void>;

let _discoverySweepInFlight = false;

type LoadKalshiOrderIdsForDateFn    = (easternDate: string) => Promise<Set<string>>;

/** Kalshi enforces a maximum of 100 fills per page on GET /portfolio/fills. */
const DISCOVERY_PAGE_SIZE    = 100;

/**
 * Safety cap: halt pagination if a cursor remains after this many pages.
 * When hit with a remaining cursor the fetch is reported as truncated so the
 * sweep marks itself incomplete and the dashboard stays in "verifying" state.
 * At 100 fills/page and 288 max bot orders/day (96 windows × 3 markets) this
 * cap (50 pages = 5 000 fills) is never expected to be reached in practice.
 */
const DISCOVERY_SAFETY_PAGES = 50;

/** True when the exchange-history discovery sweep has completed for `easternDate` without being truncated. */
export function isExchangeDiscoverySweepComplete(easternDate: string): boolean {
  const s = _sweepStatus.get(easternDate);
  return (s?.complete ?? false) && !(s?.truncated ?? false);
}

/**
 * Discovers Kalshi bot fills for `easternDate` that are absent from the local
 * `order_attempts` ledger — e.g. because storage was degraded when the order
 * was placed and the row was never written.  For each discovered fill:
 *
 *   1. Creates a synthetic order_attempts row (idempotent: no-op if already present).
 *   2. Fires background fill reconciliation to write order_fills child chunks.
 *   3. Sets won immediately if the market has already settled.
 *
 * After a successful sweep isExchangeDiscoverySweepComplete(easternDate) is
 * true, and getDailyRealizedPnl() can include all discovered fills.
 *
 * Safe to call multiple times — all steps are idempotent.
 * Only tracks tickers from KXBTC15M / KXETH15M series.
 */
export async function discoverAndReconcileMissingBotFills(easternDate: string): Promise<void> {
  if (_discoverySweepInFlight) {
    logger.debug({ easternDate }, "fillReconciler: discovery sweep already in progress");
    return;
  }
  _discoverySweepInFlight = true;
  _sweepStatus.set(easternDate, _makeSweepStatus({ complete: false, discoveredCount: 0 }));

  try {
    logger.info({ easternDate }, "fillReconciler: starting exchange-history discovery sweep");

    // 1. Fetch all fills for the target Eastern day from Kalshi (paginates to exhaustion)
    const { fills: allFills, truncated } = await fetchAllFillsForDate(easternDate);
    logger.info({ easternDate, fillCount: allFills.length, truncated }, "fillReconciler: exchange fills fetched");

    // 2. Group fills by Kalshi order_id
    const fillsByOrderId = new Map<string, KalshiAllFillsWire[]>();
    for (const fill of allFills) {
      const orderId = typeof fill.order_id === "string" && fill.order_id.length > 0
        ? fill.order_id
        : null;
      if (!orderId) continue;
      const bucket = fillsByOrderId.get(orderId) ?? [];
      bucket.push(fill);
      fillsByOrderId.set(orderId, bucket);
    }

    // 3. Compare with locally known order_ids for the date
    const knownOrderIds = await (_loadKalshiOrderIdsForDateImpl ?? loadKalshiOrderIdsForDate)(easternDate);
    const missingOrderIds = [...fillsByOrderId.keys()].filter((id) => !knownOrderIds.has(id));

    if (missingOrderIds.length === 0) {
      logger.info({ easternDate, truncated }, "fillReconciler: discovery — no missing bot orders found");
      const allMatchedComplete = !truncated;
      _sweepStatus.set(easternDate, _makeSweepStatus({ complete: allMatchedComplete, discoveredCount: 0, truncated }));
      if (allMatchedComplete) {
        try {
          await (_persistSweepCompletionImpl ?? persistSweepCompletion)(easternDate, 0);
        } catch (err) {
          logger.warn({ err, easternDate }, "fillReconciler: discovery — watermark write failed; sweep stays incomplete");
          _sweepStatus.set(easternDate, _makeSweepStatus({ complete: false, discoveredCount: 0, truncated }));
        }
      }
      return;
    }

    logger.info(
      { easternDate, missingCount: missingOrderIds.length },
      "fillReconciler: discovery — found exchange fills absent from local ledger",
    );

    let discoveredCount = 0;
    let unmatchedBotFillCount = 0;

    for (const orderId of missingOrderIds) {
      const orderFills = fillsByOrderId.get(orderId)!;
      const sampleFill = orderFills[0]!;

      // Only track bot series
      const ticker = typeof sampleFill.market_ticker === "string" && sampleFill.market_ticker.length > 0
        ? sampleFill.market_ticker
        : null;
      if (!ticker) {
        logger.warn({ orderId }, "fillReconciler: discovery — fill missing market_ticker, skipping");
        continue;
      }

      const series = ticker.startsWith("KXBTC15M") ? "KXBTC15M"
                   : ticker.startsWith("KXETH15M") ? "KXETH15M"
                   : null;
      if (!series) {
        logger.debug({ orderId, ticker }, "fillReconciler: discovery — non-bot ticker, skipping");
        continue;
      }

      // Infer YES/NO side from price magnitudes (wire side field is unreliable)
      const side = inferSideFromAllFillsWire(sampleFill);
      if (!side) {
        logger.warn({ orderId, ticker }, "fillReconciler: discovery — cannot infer side, skipping");
        continue;
      }

      // 4. Count as unmatched — do NOT create synthetic parent row.
      //    Ticker-prefix alone is not durable bot provenance (a manual trade
      //    on the same series would share the prefix). Importing unverified
      //    fills would corrupt the verified P&L ledger. Instead we increment
      //    unmatchedBotFillCount so the sweep stays incomplete, blocking the
      //    verified daily total until the gap is closed by a full restart with
      //    a complete local ledger.
      unmatchedBotFillCount++;
      logger.warn(
        { orderId, ticker, side },
        "fillReconciler: discovery — bot-series fill absent from local ledger; " +
        "cannot verify ownership without local parent — excluded from verified P&L",
      );
    }

    // Complete only when pagination was not truncated AND every bot-series fill
    // in the exchange history has a matching local parent record.
    const sweepComplete = !truncated && unmatchedBotFillCount === 0;
    _sweepStatus.set(easternDate, _makeSweepStatus({ complete: sweepComplete, discoveredCount, truncated, unmatchedBotFillCount }));
    logger.info(
      { easternDate, discoveredCount, unmatchedBotFillCount, totalMissing: missingOrderIds.length, truncated },
      truncated
        ? "fillReconciler: exchange-history discovery sweep truncated — retry to see remaining pages"
        : unmatchedBotFillCount > 0
          ? "fillReconciler: exchange-history discovery sweep incomplete — unmatched bot fills block verified P&L"
          : "fillReconciler: exchange-history discovery sweep complete",
    );
    // Persist the per-day sweep watermark so restarts skip already-swept dates.
    // Await so that a DB write failure rolls back the in-memory "complete" flag.
    if (sweepComplete) {
      try {
        await (_persistSweepCompletionImpl ?? persistSweepCompletion)(easternDate, discoveredCount);
      } catch (err) {
        logger.warn({ err, easternDate }, "fillReconciler: discovery — watermark write failed; sweep stays incomplete");
        _sweepStatus.set(easternDate, _makeSweepStatus({ complete: false, discoveredCount, truncated, unmatchedBotFillCount }));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    _sweepStatus.set(easternDate, _makeSweepStatus({ complete: false, discoveredCount: 0, error: msg }));
    logger.warn({ err, easternDate }, "fillReconciler: exchange-history discovery sweep failed");
  } finally {
    _discoverySweepInFlight = false;
  }
}
/**
 * Returns the earliest Eastern date (YYYY-MM-DD) that the startup exchange-
 * history sweep should begin from.  Defaults to the configured inception date;
 * overrideable via EXCHANGE_SWEEP_START_DATE for deployments where the bot
 * started on a different day.
 */
export function getSweepStartDate(): string {
  const env = process.env["EXCHANGE_SWEEP_START_DATE"];
  if (isTrustedSweepDate(env)) return env;
  if (env) {
    logger.warn(
      { configuredStartDate: env, earliestAllowedDate: DEFAULT_BOT_INCEPTION_DATE },
      "fillReconciler: ignoring invalid or pre-inception EXCHANGE_SWEEP_START_DATE",
    );
  }
  return DEFAULT_BOT_INCEPTION_DATE;
}

/** Reject malformed calendar dates and any date that predates bot operation. */
export function isTrustedSweepDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && value >= DEFAULT_BOT_INCEPTION_DATE;
}

/**
 * Fetches all Kalshi fills whose Eastern date equals `easternDate`, paginating
 * to exhaustion. Passes approximate UTC epoch-second bounds as a hint to the
 * API and then re-filters client-side with easternDay() so the result is
 * correct regardless of whether the fills endpoint honours min_ts/max_ts.
 *
 * Returns { fills, truncated } — truncated=true when the safety page cap was
 * hit while a cursor remained, meaning some fills may have been missed.
 */
async function fetchAllFillsForDate(easternDate: string): Promise<FetchFillsResult> {
  const authFetch = (_kalshiAuthFetchImpl ?? kalshiAuthFetch) as typeof kalshiAuthFetch;
  const fills: KalshiAllFillsWire[] = [];
  let cursor: string | undefined;
  let pages = 0;

  // DST-safe UTC bounds covering any Eastern day.
  //   Earliest Eastern midnight = EDT (UTC-4): UTC T04:00Z
  //   Latest Eastern midnight   = EST (UTC-5): next-day UTC T05:00Z
  // The bounds may overshoot by up to 1 hour on each edge (which is fine
  // because client-side easternDay() filtering is authoritative).
  const [yearStr, monthStr, dayStr] = easternDate.split("-");
  const year  = Number(yearStr);
  const month = Number(monthStr);
  const day   = Number(dayStr);
  const dayStartMs = Date.UTC(year, month - 1, day);
  const dayEndMs   = Date.UTC(year, month - 1, day + 1); // JS handles month/day overflow
  const dayStartSec = Math.floor(dayStartMs / 1_000) + 4 * 3_600;  // EDT midnight
  const dayEndSec   = Math.floor(dayEndMs   / 1_000) + 5 * 3_600;  // next day EST midnight

  do {
    const qs = new URLSearchParams({
      limit:  String(DISCOVERY_PAGE_SIZE),
      min_ts: String(dayStartSec),
      max_ts: String(dayEndSec),
    });
    if (cursor) qs.set("cursor", cursor);

    const data = await authFetch<KalshiFillsListResponse>(
      "GET",
      `/portfolio/fills?${qs.toString()}`,
    );

    for (const fill of data.fills ?? []) {
      const createdStr = typeof fill.created_time === "string" ? fill.created_time : null;
      if (!createdStr) continue;
      if (easternDay(new Date(createdStr)) === easternDate) {
        fills.push(fill as KalshiAllFillsWire);
      }
    }

    cursor = typeof data.cursor === "string" && data.cursor.length > 0
      ? data.cursor
      : undefined;
    pages++;
  } while (cursor && pages < DISCOVERY_SAFETY_PAGES);

  const truncated = cursor !== undefined; // cursor remained after hitting the safety cap
  if (truncated) {
    logger.warn(
      { easternDate, pages, fillsSeenSoFar: fills.length },
      "fillReconciler: fetchAllFillsForDate hit safety page cap — sweep marked truncated",
    );
  }

  return { fills, truncated };
}

/** For tests only — clear all sweep status. */
export function _resetExchangeDiscoverySweepStatusForTesting(): void {
  _sweepStatus.clear();
}

function _makeSweepStatus(
  overrides: Partial<SweepStatus> & Pick<SweepStatus, "complete" | "discoveredCount">,
): SweepStatus {
  return {
    lastRunAt:             Date.now(),
    error:                 null,
    truncated:             false,
    unmatchedBotFillCount: 0,
    ...overrides,
  };
}

/** Diagnostic snapshot of per-day sweep state. */
export function getExchangeDiscoverySweepStatus(): Record<string, SweepStatus> {
  return Object.fromEntries(_sweepStatus);
}

interface KalshiFillsListResponse {
  fills?:  KalshiAllFillsWire[];
  cursor?: string;
  [key: string]: unknown;
}


const _sweepStatus = new Map<string, SweepStatus>();

/**
 * Re-run the discovery sweep for every date that has a recorded but incomplete
 * entry in the in-memory sweep-status map.  Intended for use by a periodic timer
 * so markets that were open during the initial sweep are retried once they settle.
 *
 * Sweeps are run sequentially, oldest-first, so the in-flight guard inside
 * `discoverAndReconcileMissingBotFills` never fires during iteration.
 */
export async function retrySweepIncompleteHistory(): Promise<void> {
  const incomplete = [..._sweepStatus.entries()]
    .filter(([, s]) => !s.complete)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [date] of incomplete) {
    await discoverAndReconcileMissingBotFills(date);
  }
}

interface FetchFillsResult {
  fills:     KalshiAllFillsWire[];
  /** True when the safety page cap was reached while a cursor was still present. */
  truncated: boolean;
}

/** For tests only — override the tradeStore DB read used by the discovery sweep. */
export function _setLoadKalshiOrderIdsForDateForTesting(fn: LoadKalshiOrderIdsForDateFn | null): void {
  _loadKalshiOrderIdsForDateImpl = fn;
}

let _loadKalshiOrderIdsForDateImpl:    LoadKalshiOrderIdsForDateFn    | null = null;

/**
 * Fetches the settled market result from Kalshi for `ticker` and persists it to
 * the local market_results table, then sets won on any discovered rows via
 * markWonForSettledTicker.
 *
 * Returns "yes" | "no" when the market is settled and result was persisted.
 * Returns null when the market is not yet settled, the API returned an
 * unrecognised status, or the request failed.
 *
 * Never throws — errors are logged as warnings.
 */
async function fetchAndPersistMarketResult(
  ticker:    string,
  authFetch: typeof kalshiAuthFetch,
): Promise<"yes" | "no" | null> {
  try {
    const data   = await authFetch<KalshiMarketResponse>("GET", `/markets/${ticker}`);
    const result = data.market?.result;
    if (result === "yes" || result === "no") {
      upsertMarketResultInSql(ticker, result);
      await markWonForSettledTicker(ticker, result);
      logger.info(
        { ticker, result },
        "fillReconciler: discovery — fetched and persisted market settlement result from Kalshi",
      );
      return result;
    }
    // Market is valid but not yet settled (result is null / "" / "pending")
    return null;
  } catch (err) {
    logger.warn({ err, ticker }, "fillReconciler: discovery — could not fetch market result from Kalshi");
    return null;
  }
}

let _persistSweepCompletionImpl: PersistSweepCompletionFn | null = null;

/** For tests only — override the tradeStore sweep-watermark write. */
export function _setPersistSweepCompletionForTesting(fn: PersistSweepCompletionFn | null): void {
  _persistSweepCompletionImpl = fn;
}

interface KalshiMarketResponse {
  market?: {
    result?:   string;
    status?:   string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const DEFAULT_BOT_INCEPTION_DATE = "2026-07-01";
