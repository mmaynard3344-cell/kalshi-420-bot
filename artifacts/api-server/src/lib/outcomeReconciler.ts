/**
 * Market outcome reconciler — scheduled ~3 minutes after a window closes.
 *
 * Fetches the final market result from Kalshi, then calls
 * analytics.recordOutcomeResult() to write win/loss and gross/net P&L for
 * every filled order on that ticker.
 *
 * Also exports runStartupBackfill(), which reconciles any historical filled
 * orders that were recorded before outcome reconciliation existed.  It reads
 * data/market-result-cache.json (the same cache used by the fills route)
 * and writes outcome-patched records synchronously to the NDJSON files so
 * they are available immediately when the first report endpoint is called.
 *
 * Design:
 *  - Fires via setTimeout; timer is unref'd so it never blocks process exit.
 *  - Retries once (2 min later) if the market has not yet settled.
 *  - All errors are caught and logged — this never throws into its caller.
 *  - Never imports autoTrader.ts, trade.ts, or any replay file.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join }                                                 from "path";
import { kalshiAuthFetch }                                      from "./kalshiAuth.js";
import { logger }                                               from "./logger.js";
import { easternDay }                                           from "./dailyBudget.js";
import { loadOrdersFromDateRange }                              from "./analyticsStore.js";
import {
  getFilledAttemptsByTicker,
  recordOutcomeResult,
  type OrderAttemptRecord,
  type OutcomeResultParams,
} from "./analytics.js";
import { canonicalUnreconciledFilledOrders } from "./orderCanonicalization.js";
import {
  upsertMarketResultInSql,
  recordForwardOrderSettlementInSql,
  recordWindowSettlementInSql,
  updatePreflightMarketResultsInSql,
  markWonForSettledTicker,
  settleEth420CounterfactualEntriesForTicker,
} from "./tradeStore.js";
import { wlSetSettlementResult }  from "./windowLog.js";
import { loadPreflightDecisions } from "./preflightStore.js";
import {
  enrichMandelbrotWithFilledOrders,
  recordMandelbrotSettlement,
} from "./mandelbrotInstability.js";

/** Minutes to wait after window close before fetching the market result. */
const INITIAL_DELAY_MIN = 3;
/** Minutes to wait before a single retry if the market is not yet settled. */
const RETRY_DELAY_MIN   = 2;
/** Maximum number of retries per ticker (prevents infinite retry loops). */
const MAX_RETRIES        = 3;

// ── Kalshi API types ──────────────────────────────────────────────────────────

interface KalshiMarket {
  result?: string;   // "yes", "no", or absent/empty if not yet settled
  status?: string;   // "finalized", "open", "closed", etc.
  [key: string]: unknown;
}

interface KalshiMarketResponse {
  market?: KalshiMarket;
  [key: string]: unknown;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Schedule outcome reconciliation for a closed window.
 *
 * @param ticker          - The full Kalshi ticker (e.g. "KXBTC15M-26JUL290730-30")
 * @param windowCloseTime - ISO-8601 UTC close time from the market data (may be null)
 */
export function scheduleOutcomeReconciliation(
  ticker: string,
  windowCloseTime: string | null,
): void {
  if (!ticker) return;

  const closeMs   = windowCloseTime ? new Date(windowCloseTime).getTime() : Date.now();
  const delayMs   = Math.max(
    INITIAL_DELAY_MIN * 60_000,
    closeMs - Date.now() + INITIAL_DELAY_MIN * 60_000,
  );

  _schedule(ticker, closeMs, delayMs, 0);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _schedule(
  ticker:    string,
  closeMs:   number,
  delayMs:   number,
  retryCount: number,
): void {
  const timer = setTimeout(() => {
    _reconcile(ticker, closeMs, retryCount).catch(() => {/* already logged inside */});
  }, delayMs);
  if (timer.unref) timer.unref();

  logger.debug({ ticker, delayMs, retryCount }, "outcomeReconciler: scheduled");
}

async function _reconcile(
  ticker:     string,
  closeMs:    number,
  retryCount: number,
): Promise<void> {
  try {
    const data   = await kalshiAuthFetch<KalshiMarketResponse>("GET", `/markets/${ticker}`);
    const market = data.market;

    if (!market) {
      logger.warn({ ticker, analytics_error: true }, "outcomeReconciler: no market object in response");
      return;
    }

    const result = market.result;

    // Market not yet settled
    if (result !== "yes" && result !== "no") {
      if (retryCount < MAX_RETRIES) {
        logger.debug(
          { ticker, result, status: market.status, retryCount },
          "outcomeReconciler: market not yet settled — retrying",
        );
        _schedule(ticker, closeMs, RETRY_DELAY_MIN * 60_000, retryCount + 1);
      } else {
        logger.warn(
          { ticker, result, status: market.status, analytics_error: true },
          "outcomeReconciler: market still not settled after max retries — giving up",
        );
      }
      return;
    }

    // Always persist the settlement result to SQL + window log regardless of
    // whether any unreconciled orders remain.  This ensures the YES/NO badge
    // survives restarts even when a backfill already reconciled the orders.
    upsertMarketResultInSql(ticker, result);
    recordWindowSettlementInSql(ticker, result as "yes" | "no");
    wlSetSettlementResult(ticker, result as "yes" | "no");

    // B/C settlement is accounting-only. It consumes the already-authoritative
    // market result, never mutates martingale state, and must never interrupt
    // the existing outcome reconciliation path if its own evidence is incomplete.
    if (/^KXETH15M-/.test(ticker)) {
      try {
        const { reconcilePersistedEthBigBetsForTicker } = await import(
          "./strategies/ethBigBetSettlementReconciler.js"
        );
        const bigBetAccounting = await reconcilePersistedEthBigBetsForTicker(
          ticker,
          result as "yes" | "no",
        );
        if (bigBetAccounting.settled > 0 || bigBetAccounting.unresolved > 0) {
          logger.info(
            { ticker, result, ...bigBetAccounting },
            "B/C accounting sidecar processed authoritative ETH settlement",
          );
        }
      } catch (err) {
        logger.warn(
          { err, ticker, result },
          "B/C accounting sidecar unavailable; normal outcome reconciliation continues",
        );
      }
    }
    if (process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] === "true") {
      try {
        const { upsertPhase4BMarketOutcomeInSql } = await import("./tradeStore.js");
        upsertPhase4BMarketOutcomeInSql({
          marketId: ticker, result: result as "yes" | "no", settlementTimestampMs: closeMs,
          reconciledAtMs: Date.now(), settlementStatus: market.status ?? "finalized", schemaVersion: "1",
        });
      } catch { /* passive research never affects reconciliation */ }
    }
    // The unfinished passive study is opt-in and must have no default import,
    // queue, or storage activity on the settlement path.
    if (process.env["RECOVERABILITY_CAPTURE_ENABLED"] === "true") {
      void import("./recoverabilityCapture.js")
        .then(({ enqueueRecoverabilityOutcome }) => enqueueRecoverabilityOutcome(ticker, result as "yes" | "no"))
        .catch((err) => logger.warn({ err }, "recoverabilityCapture: outcome enqueue unavailable"));
    }
    // Counterfactual ETH 420 rehearsal only. This path consumes the already
    // confirmed market result and persists a zero-fill assumption; it has no
    // exchange order, reservation, claim, or placement behavior.
    try {
      // Capture is separately opt-in, but a durable pending record must always
      // be recoverable—even after capture is disabled.
      const settled = await settleEth420CounterfactualEntriesForTicker(ticker, result as "yes" | "no");
      if (settled) logger.info({ ticker, result, settled }, "ETH 420 counterfactual entries settled from authoritative outcome");
    } catch (err) {
      logger.warn({ err, ticker }, "ETH 420 counterfactual settlement sidecar failed");
    }

    // Update any exchange-discovered rows for this ticker that were inserted
    // before settlement was known (won IS NULL). These rows are NOT in the
    // analytics in-memory store so recordOrderWonInSql never fires for them via
    // the loop below. Called unconditionally — before the early return — so
    // discovered fills are always updated even when the in-memory order list is
    // empty (the common case on a day where storage was degraded at order time).
    void markWonForSettledTicker(ticker, result as "yes" | "no");

    // Find unreconciled filled orders for this ticker
    const orders = canonicalUnreconciledFilledOrders(getFilledAttemptsByTicker(ticker));

    if (orders.length === 0) {
      // Research-only sidecar runs after the normal reconciliation decision and
      // only reads already-confirmed analytics fills. This records a settled
      // no-fill result too, without making a market/order request.
      if (process.env["MANDELBROT_INSTABILITY_CAPTURE_ENABLED"] === "true") {
        enrichMandelbrotWithFilledOrders(ticker, result as "yes" | "no", getFilledAttemptsByTicker(ticker)
          .map((order) => ({
            side: order.side,
            fillPriceCents: order.fillPriceCents.value ?? order.limitPriceCents,
            contracts: order.contracts.value > 0 ? order.contracts.value : order.fillCount,
            feeDollars: order.feeDollars.value,
            netPnlDollars: order.netPnlDollars ?? null,
          })));
      }
      logger.debug({ ticker, result }, "outcomeReconciler: no unreconciled filled orders — settlement persisted to window_log");
      return;
    }

    const now            = Date.now();
    const windowClosedAtMs = closeMs;

    for (const order of orders) {
      // Use confirmed fill price if available, otherwise fall back to limit price
      const fillPrice  = order.fillPriceCents.value ?? order.limitPriceCents;
      const contracts  = order.contracts.value > 0 ? order.contracts.value : order.fillCount;
      const notional   = order.notionalDollars.value > 0
        ? order.notionalDollars.value
        : (fillPrice * contracts) / 100;
      const fees       = order.feeDollars.value;

      const won            = order.side === result;
      const grossPnlDollars = won
        ? ((100 - fillPrice) * contracts) / 100
        : -((fillPrice * contracts) / 100);
      const netPnlDollars  = grossPnlDollars - fees;
      const roi            = notional > 0 ? grossPnlDollars / notional : 0;
      const holdMs         = Math.max(0, windowClosedAtMs - order.timestampMs);

      const params: OutcomeResultParams = {
        marketResult:     result as "yes" | "no",
        win:              won,
        grossPnlDollars,
        netPnlDollars,
        roi,
        windowClosedAtMs,
        holdMs,
        reconciledAtMs:   now,
      };

      recordOutcomeResult(order.id, params);

      // Persist won/lost to the order_attempts SQL row so it survives restarts
      // without depending on the NDJSON file being present.
      recordForwardOrderSettlementInSql(order.clientOrderId, result as "yes" | "no", closeMs);
    }

    // Run strictly after normal order outcome persistence. It sees all confirmed
    // filled attempts (including fills reconciled by an earlier pass) but cannot
    // change an order, its strategy decision, or the just-recorded outcome.
    if (process.env["MANDELBROT_INSTABILITY_CAPTURE_ENABLED"] === "true") {
      const researchFills = getFilledAttemptsByTicker(ticker).map((order) => {
        const fillPriceCents = order.fillPriceCents.value ?? order.limitPriceCents;
        const contracts = order.contracts.value > 0 ? order.contracts.value : order.fillCount;
        const won = order.side === result;
        const grossPnlDollars = won
          ? ((100 - fillPriceCents) * contracts) / 100
          : -((fillPriceCents * contracts) / 100);
        return {
          side: order.side,
          fillPriceCents,
          contracts,
          feeDollars: order.feeDollars.value,
          netPnlDollars: grossPnlDollars - order.feeDollars.value,
        };
      });
      enrichMandelbrotWithFilledOrders(ticker, result as "yes" | "no", researchFills);
    }

    logger.info(
      { ticker, result, ordersReconciled: orders.length },
      "outcomeReconciler: outcome reconciliation complete — settlement written to window_log and order_attempts",
    );
  } catch (err) {
    const e = err as { status?: number; message?: string };
    logger.warn(
      { err, ticker, status: e.status, retryCount, analytics_error: true },
      "outcomeReconciler: _reconcile failed",
    );
  }
}

// ── Startup backfill ──────────────────────────────────────────────────────────

const ANALYTICS_DIR = join(process.cwd(), "data", "analytics");
const RESULT_CACHE_PATH = join(process.cwd(), "data", "market-result-cache.json");
const MAX_LINE_BYTES = 65_536;

/**
 * Select one local attempt for each externally-confirmed exchange order.
 * A duplicate retry can share the same order ID after an interrupted response;
 * it must never receive a second settlement record.
 */
/**
 * Reconcile any historical filled orders that predate the outcome reconciler.
 *
 * Reads data/market-result-cache.json, loads all NDJSON order files, and for
 * every fill that has no outcomeReconciledAt and whose ticker appears in the
 * cache, writes a patched record synchronously back to the same NDJSON file.
 *
 * Uses the same P&L formula as _reconcile(). Writes are synchronous so the
 * records are on disk before the first report endpoint is served.
 *
 * Idempotent: if run twice the second pass finds outcomeReconciledAt already
 * set and skips every record. NDJSON last-write-wins dedup prevents doubles.
 *
 * Never throws — all errors are caught and logged with analytics_error: true.
 */
export function runStartupBackfill(): void {
  try {
    // ── Load the market result cache ─────────────────────────────────────────
    if (!existsSync(RESULT_CACHE_PATH)) {
      logger.debug("startupBackfill: no market-result-cache.json — nothing to backfill");
      return;
    }

    let resultMap: Record<string, string>;
    try {
      resultMap = JSON.parse(readFileSync(RESULT_CACHE_PATH, "utf8")) as Record<string, string>;
    } catch (err) {
      logger.warn({ err, analytics_error: true }, "startupBackfill: could not parse market-result-cache.json");
      return;
    }

    // ── Load all historical orders from disk ─────────────────────────────────
    const allOrders = loadOrdersFromDateRange(0); // 0 = all available files

    const unreconciled = canonicalUnreconciledFilledOrders(allOrders);

    if (unreconciled.length === 0) {
      logger.debug("startupBackfill: all filled orders already reconciled — nothing to do");
      return;
    }

    const now = Date.now();
    let patched = 0;
    let skipped = 0;

    for (const order of unreconciled) {
      const result = resultMap[order.ticker];
      if (result !== "yes" && result !== "no") {
        skipped++;
        continue; // market result not yet in cache
      }

      try {
        const fillPrice      = order.fillPriceCents.value ?? order.limitPriceCents;
        const contracts      = order.contracts.value > 0 ? order.contracts.value : order.fillCount;
        const notional       = order.notionalDollars.value > 0
          ? order.notionalDollars.value
          : (fillPrice * contracts) / 100;
        const fees           = order.feeDollars.value;
        const won            = order.side === result;
        const grossPnlDollars = won
          ? ((100 - fillPrice) * contracts) / 100
          : -((fillPrice * contracts) / 100);
        const netPnlDollars  = grossPnlDollars - fees;
        const roi            = notional > 0 ? grossPnlDollars / notional : 0;

        // Use windowClosedAtMs from existing field if present, else estimate
        // from ticker name (not critical for historical reports).
        const windowClosedAtMs = order.windowClosedAtMs ?? order.timestampMs;
        const holdMs           = Math.max(0, windowClosedAtMs - order.timestampMs);

        const patched_record: OrderAttemptRecord = {
          ...order,
          marketResult:       result as "yes" | "no",
          win:                won,
          grossPnlDollars,
          netPnlDollars,
          roi,
          windowClosedAtMs,
          holdMs,
          outcomeReconciledAt: now, // number (ms) — matches OrderAttemptRecord type
        };

        // Synchronous write so patches are on disk before the first endpoint call.
        // Last-write-wins dedup in parseNdjsonFile means repeated runs are safe.
        try { mkdirSync(ANALYTICS_DIR, { recursive: true }); } catch { /* exists */ }
        const date = easternDay(new Date(order.timestampMs));
        const path = join(ANALYTICS_DIR, `orders-${date}.ndjson`);
        const line = JSON.stringify(patched_record) + "\n";
        if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES) {
          appendFileSync(path, line, "utf8");
          patched++;
        } else {
          logger.warn({ recordId: order.id, analytics_error: true }, "startupBackfill: record too large, skipped");
          skipped++;
        }
      } catch (err) {
        logger.warn({ err, recordId: order.id, analytics_error: true }, "startupBackfill: failed to patch record");
        skipped++;
      }
    }

    logger.info(
      { total: unreconciled.length, patched, skipped },
      "startupBackfill: historical outcome reconciliation complete",
    );
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "startupBackfill: unexpected error — backfill aborted");
  }
}

// ── Preflight settlement backfill ─────────────────────────────────────────────

/**
 * Patch the marketResult field on preflight-decision NDJSON records that were
 * written with marketResult: null (the default at decision time).
 *
 * Algorithm:
 *  1. Read data/market-result-cache.json → ticker → "yes"|"no" map.
 *  2. Scan every preflight-decisions-YYYY-MM-DD.ndjson file in ANALYTICS_DIR.
 *  3. For any entry whose ticker appears in the map and whose marketResult is
 *     still null, append a patched copy of the record to the same file.
 *  4. The last-write-wins dedup in loadPreflightDecisions() (keyed on
 *     ticker:side:timestampMs) ensures the patched entry shadows the original.
 *  5. Also bulk-update the SQL preflight_decisions table via
 *     updatePreflightMarketResultsInSql() so SQL queries return correct data.
 *
 * Idempotent: a second run finds marketResult already set and patches nothing.
 * Never throws — all errors are caught and logged with analytics_error: true.
 */
export function runPreflightSettlementBackfill(): void {
  try {
    // 1. Load the market-result cache
    if (!existsSync(RESULT_CACHE_PATH)) {
      logger.debug("preflightSettlementBackfill: no market-result-cache.json — nothing to backfill");
      return;
    }

    let resultMap: Record<string, string>;
    try {
      resultMap = JSON.parse(readFileSync(RESULT_CACHE_PATH, "utf8")) as Record<string, string>;
    } catch (err) {
      logger.warn({ err, analytics_error: true }, "preflightSettlementBackfill: could not parse market-result-cache.json");
      return;
    }

    // 2. Always update SQL regardless of NDJSON presence — SQL rows exist even
    //    when NDJSON files have been pruned or were never written.
    updatePreflightMarketResultsInSql(resultMap);

    // 3. Discover available NDJSON date files
    let dateFiles: string[] = [];
    try {
      dateFiles = readdirSync(ANALYTICS_DIR)
        .filter((f) => f.startsWith("preflight-decisions-") && f.endsWith(".ndjson"))
        .map((f) => f.replace("preflight-decisions-", "").replace(".ndjson", ""));
    } catch (err) {
      logger.warn({ err, analytics_error: true }, "preflightSettlementBackfill: could not list analytics directory");
      // SQL has already been updated; log and finish cleanly.
      logger.info({ patched: 0, skipped: 0, ndjsonFiles: 0 }, "preflightSettlementBackfill: SQL updated; NDJSON skipped (directory unreadable)");
      return;
    }

    if (dateFiles.length === 0) {
      logger.info({ patched: 0, skipped: 0, ndjsonFiles: 0 }, "preflightSettlementBackfill: SQL updated; no NDJSON files found");
      return;
    }

    // 4. Patch NDJSON files with settlement outcomes
    let patched = 0;
    let skipped = 0;

    for (const date of dateFiles) {
      try {
        const decisions = loadPreflightDecisions(date);
        const topatch   = decisions.filter(
          (d) => d.marketResult == null && (resultMap[d.ticker] === "yes" || resultMap[d.ticker] === "no"),
        );

        if (topatch.length === 0) continue;

        const filePath = join(ANALYTICS_DIR, `preflight-decisions-${date}.ndjson`);
        for (const d of topatch) {
          try {
            const patchedRecord = { ...d, marketResult: resultMap[d.ticker] };
            const line          = JSON.stringify(patchedRecord) + "\n";
            if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES) {
              appendFileSync(filePath, line, "utf8");
              patched++;
            } else {
              logger.warn(
                { ticker: d.ticker, timestampMs: d.timestampMs, analytics_error: true },
                "preflightSettlementBackfill: record too large, skipped",
              );
              skipped++;
            }
          } catch (err) {
            logger.warn({ err, ticker: d.ticker, analytics_error: true }, "preflightSettlementBackfill: failed to patch record");
            skipped++;
          }
        }
      } catch (err) {
        logger.warn({ err, date, analytics_error: true }, "preflightSettlementBackfill: failed to process date file");
      }
    }

    logger.info(
      { ndjsonFiles: dateFiles.length, patched, skipped },
      "preflightSettlementBackfill: preflight settlement backfill complete",
    );
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "preflightSettlementBackfill: unexpected error — backfill aborted");
  }
}
