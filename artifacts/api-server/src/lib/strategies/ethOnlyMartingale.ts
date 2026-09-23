/**
 * Execution-only ETH strategy — KXETH15M series only.
 *
 * Six-step martingale. Principals: $15, $30, $60, $120, $240, $320
 * (cents: 1500, 3000, 6000, 12000, 24000, 32000).
 * Side starts "no" each ET day. After a win: side flips yes↔no, step=0.
 * After a loss: side unchanged, step increments; after step 5 it resets to 0.
 * Daily state resets when the ET day changes (no timer).
 * Fail-closed if current day realized P&L ≤ -$250.00 (-25000 cents).
 *
 * Entry lifecycle: GTC resting limit at 50¢.
 *   1. reserve → durable principal + fee reservation in spent_cents.
 *   2. post_started → durable fence immediately before exchange POST.
 *   3. POST GTC order at 0.5000 (good_till_canceled).
 *   4. Exchange acknowledges → outcome = "resting" (open, partially filled, etc.)
 *      OR immediate full fill → outcome = "full_fill".
 *   5. A resting order finishes only via:
 *      a. Full fill (exchange fill_count_fp reaches requested_contracts).
 *      b. Explicit safety/reconciliation cancellation (DELETE /portfolio/events/orders/:id).
 *      c. Market terminal/settled (exchange auto-cancels).
 *   6. No artificial timer-based cancellation.
 *   7. Filled terminal outcomes advance the next side/ladder step from the
 *      official market result. A closed GTC proved terminal with zero fills,
 *      empty fill history, and zero ticker position is a no-attempt handoff
 *      that preserves the current side/step. Only filled contracts contribute
 *      to financial accounting.
 *   8. The durable reservation (spent_cents) remains active while the order is resting
 *      so replacement orders cannot exceed the intended stake for the step.
 *
 * The entry side (yes/no) is captured from sequence state at reservation time and
 * persisted on the order row so settlement never reads the mutable state table side.
 */
import { randomUUID } from "node:crypto";
import { kalshiAuthFetch } from "../kalshiAuth.js";
import { captureOrderbook } from "../orderbookCapture.js";
import { parseKalshiOrderResponse } from "../orderResponseParser.js";
import { easternDay } from "../dailyBudget.js";
import { isEthOrderSubmissionPermitted, setTradingHalted } from "../tradingKillSwitch.js";
import { logger } from "../logger.js";
import { kalshiFetch } from "../kalshi.js";
import { fetchFreshKalshiBalanceForExchangeRead, kalshiBalanceCents } from "../kalshiBalance.js";
import * as ethStore from "../tradeStore.js";
import { addDecimalStrings, normalizeKalshiFill, type KalshiFillWire } from "../kalshiFillNormalizer.js";
import { getAccountHistoryFingerprint } from "../kalshiAccountFingerprint.js";

export interface EthMarketState {
  ticker: string;
  /** Exact exchange returned by the live market discovery response. */
  exchangeIndex?: number | null;
  openTime: string | null;
  closeTime: string | null;
  status: string | null;
}

export const ETH_PRINCIPALS_CENTS = [50, 50, 50, 100, 250, 300] as const;
/** Loss stop: fail closed if realized daily P&L (even-money cents) is at or below this. */
export const ETH_DAILY_LOSS_STOP_CENTS = -120_000;
/** A pending row has not entered POST yet, so it can be released after this bound. */
export const ETH_PENDING_RESERVATION_EXPIRY_MS = 60_000;
/**
 * Minimum milliseconds before closeTime that we will attempt an entry.
 * GTC orders submitted with < 30 s left on an open market would be immediately
 * cancelled by the exchange on settlement — disallow them.
 */
export const ETH_ENTRY_LATEST_BEFORE_CLOSE_MS = 30_000;
/**
 * Fixed limit price for all ETH GTC resting orders (50 cents).
 * Both YES and NO orders rest at 0.5000 on the Kalshi wire.
 */
export const ETH_GTC_LIMIT_PRICE_CENTS = 50;

const active = new Set<string>();
// A proof run may allow exactly one POST across every ETH ticker. Unlike the
// normal per-ticker evaluator lock, this is process-wide and synchronous.
let liveProofPostClaimed = false;

export function isEthTicker(ticker: string): boolean {
  return /^KXETH15M-/.test(ticker);
}

/**
 * Returns true when the market is eligible for a new entry attempt.
 *
 * Rules:
 *  - status must be an active Kalshi market ("open" or the current "active"
 *    API value; not "settled", "closed", null, etc.)
 *  - closeTime must be parseable and at least ETH_ENTRY_LATEST_BEFORE_CLOSE_MS in the future
 *  - if openTime is provided it must be in the past (market has started)
 */
export function isEthMarketEligible(
  status: string | null,
  openTime: string | null,
  closeTime: string | null,
  now: number,
): boolean {
  if (status !== "open" && status !== "active") return false;
  if (closeTime == null) return false;
  const close = Date.parse(closeTime);
  if (!Number.isFinite(close)) return false;
  if (now >= close - ETH_ENTRY_LATEST_BEFORE_CLOSE_MS) return false;
  if (openTime != null) {
    const open = Date.parse(openTime);
    if (Number.isFinite(open) && now < open) return false;
  }
  return true;
}

export function ethPrincipalForStep(step: number): number {
  return ETH_PRINCIPALS_CENTS[Math.max(0, Math.min(5, step))]!;
}

/** Kalshi taker fee, rounded up to whole cents as charged by the exchange. */
export function ethTakerFeeCents(noPriceCents: number, contracts: number): number {
  if (!Number.isInteger(noPriceCents) || noPriceCents < 1 || noPriceCents > 99
    || !Number.isFinite(contracts) || contracts <= 0) return 0;
  return Math.ceil(0.07 * contracts * noPriceCents * (100 - noPriceCents) / 100);
}

/**
 * BUY NO GTC resting limit order at 50¢.
 * Kalshi wire convention: transport side "ask", price is the complement of the NO price.
 * At 50¢ the complement is also 50¢, so price = "0.5000".
 * TIF: "good_till_canceled" (Kalshi V2 API).
 * self_trade_prevention_type: "taker_at_cross" (standard project pattern).
 */
export function ethNoOrderPayload(
  ticker: string,
  clientOrderId: string,
  contracts: number,
  exchangeIndex: number,
) {
  return {
    ticker, client_order_id: clientOrderId, side: "ask",
    count: `${contracts}.00`, price: (ETH_GTC_LIMIT_PRICE_CENTS / 100).toFixed(4),
    time_in_force: "good_till_canceled", self_trade_prevention_type: "taker_at_cross",
    // Kalshi V2 defaults an omitted exchange_index to shard 0. Use -1
    // explicitly so the exchange auto-routes this ticker to its correct shard.
    exchange_index: exchangeIndex,
  };
}

/**
 * BUY YES GTC resting limit order at 50¢.
 * Kalshi wire convention: transport side "bid", price is the YES price directly.
 * At 50¢ the YES price is 50¢, so price = "0.5000".
 * TIF: "good_till_canceled" (Kalshi V2 API).
 * self_trade_prevention_type: "taker_at_cross" (standard project pattern).
 */
export function ethYesOrderPayload(
  ticker: string,
  clientOrderId: string,
  contracts: number,
  exchangeIndex: number,
) {
  return {
    ticker, client_order_id: clientOrderId, side: "bid",
    count: `${contracts}.00`, price: (ETH_GTC_LIMIT_PRICE_CENTS / 100).toFixed(4),
    time_in_force: "good_till_canceled", self_trade_prevention_type: "taker_at_cross",
    // Kalshi V2 defaults an omitted exchange_index to shard 0. Use -1
    // explicitly so the exchange auto-routes this ticker to its correct shard.
    exchange_index: exchangeIndex,
  };
}

function enabled(): boolean { return process.env["ETH_NO_MARTINGALE_ENABLED"] === "true"; }

type EthDependencies = {
  authFetch: typeof kalshiAuthFetch;
  marketFetch: typeof kalshiFetch;
  marketSettlementFetch: typeof kalshiAuthFetch;
  captureOrderbook: typeof captureOrderbook;
  isEthOrderSubmissionPermitted: typeof isEthOrderSubmissionPermitted;
  haltTrading: typeof setTradingHalted;
  accountFingerprint: typeof getAccountHistoryFingerprint;
  fetchAccountBalance: typeof fetchFreshKalshiBalanceForExchangeRead;
  stopAfterFirstPost: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setRetryTimer: typeof setTimeout;
  clearRetryTimer: typeof clearTimeout;
  store: Pick<typeof ethStore,
    "getEthMartingaleState" | "reserveEthMartingaleEntry" | "markEthMartingaleOrderPostStarted"
    | "expireEthMartingaleReservation" | "updateEthMartingaleOrder"
      | "rejectEthMartingaleOrder" | "resolveEthMartingaleProvenPhantom"
     | "listUnsettledEthMartingaleOrders" | "listEthMartingaleOrdersNeedingFillEconomics"
     | "listUnsettledEthMartingaleZeroFillOrders" | "advanceEthMartingaleLadderForZeroFill"
      | "recordEthMartingaleFillEconomics" | "settleEthMartingaleOrder"
      | "listEthMartingaleManualRecoveryTickers">;
};

type EthUnsettledOrder = Exclude<
  Awaited<ReturnType<typeof ethStore.listUnsettledEthMartingaleOrders>>,
  null
>[number];

const productionEthDependencies: EthDependencies = {
  authFetch: kalshiAuthFetch, marketFetch: kalshiFetch, marketSettlementFetch: kalshiAuthFetch, captureOrderbook,
  isEthOrderSubmissionPermitted, now: () => Date.now(),
  haltTrading: setTradingHalted,
  accountFingerprint: getAccountHistoryFingerprint,
  fetchAccountBalance: fetchFreshKalshiBalanceForExchangeRead,
  stopAfterFirstPost: () => process.env["ETH_MARTINGALE_STOP_AFTER_FIRST_POST"] === "true",
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setRetryTimer: setTimeout,
  clearRetryTimer: clearTimeout,
  store: ethStore,
};
let ethDependencies = productionEthDependencies;

/** Test-only seam; production always uses the authenticated exchange and SQL store. */
export function _setEthNoMartingaleDependenciesForTesting(overrides: Partial<EthDependencies> | null): void {
  if (overrides == null) {
    clearEthDurableRetry();
    setEthBlockerStatus("ready", "No unresolved ETH martingale exposure");
    liveProofPostClaimed = false;
  }
  ethDependencies = overrides == null ? productionEthDependencies : {
    ...productionEthDependencies, ...overrides,
    // Existing strategy tests exercise order lifecycle with no live Kalshi
    // account access. They receive a deliberately sufficient scoped balance
    // unless a case explicitly supplies exchange funds to test this preflight.
    fetchAccountBalance: overrides.fetchAccountBalance
      ?? (async () => ({ value: { balance: 1_000_000 }, stale: false })),
    // Existing test fixtures supply public-market responses via marketFetch.
    // Production never does: its settlement source is the signed client above.
    marketSettlementFetch: overrides.marketSettlementFetch
      ?? (overrides.marketFetch as unknown as typeof kalshiAuthFetch | undefined)
      ?? productionEthDependencies.marketSettlementFetch,
    // Some integration fixtures override only the store methods relevant to
    // their scenario. Keep inert defaults for newly added test-seam methods so
    // focused fakes do not reach the real SQL store.
    store: overrides.store == null
      ? productionEthDependencies.store
      : {
        ...overrides.store,
        listUnsettledEthMartingaleZeroFillOrders:
          overrides.store.listUnsettledEthMartingaleZeroFillOrders ?? (async () => []),
        advanceEthMartingaleLadderForZeroFill:
          overrides.store.advanceEthMartingaleLadderForZeroFill ?? (async () => true),
      },
  };
}

const ETH_RECONCILIATION_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const ETH_DURABLE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

export type EthMartingaleBlockerCode =
  | "ready"
  | "pending_pre_submission"
  | "unresolved_exchange_identity"
  | "resting_prior_order"
  | "partial_fill"
  | "awaiting_fill_economics"
  | "awaiting_settlement"
  | "settlement_write_retry"
  | "temporary_exchange_read_failure"
  | "durable_store_failure"
  | "zero_fill_verification_pending"
  | "daily_loss_stop"
  | "live_proof_complete"
  | "kill_switch"
  | "active_ticker_lock"
  | "missing_exchange_index"
  | "exchange_balance_unavailable"
  | "insufficient_exchange_balance"
  | "manual_recovery_position_unavailable"
  | "manual_recovery_residual_position";

export interface EthMartingaleBlockerStatus {
  code: EthMartingaleBlockerCode;
  message: string;
  retryScheduled: boolean;
  retryAttempt: number;
  ticker: string | null;
  orderId: string | null;
  outcome: string | null;
  filledContracts: number | null;
  requestedContracts: number | null;
  createdAtMs: number | null;
  exchangeIndex: number | null;
  availableBalanceCents: number | null;
  requiredBalanceCents: number | null;
  balanceStale: boolean;
}

let ethBlockerStatus: EthMartingaleBlockerStatus = {
  code: "ready",
  message: "No unresolved ETH martingale exposure",
  retryScheduled: false,
  retryAttempt: 0,
  ticker: null,
  orderId: null,
  outcome: null,
  filledContracts: null,
  requestedContracts: null,
  createdAtMs: null,
  exchangeIndex: null,
  availableBalanceCents: null,
  requiredBalanceCents: null,
  balanceStale: false,
};
let ethDurableRetryTimer: ReturnType<typeof setTimeout> | null = null;
let ethDurableRetryAttempt = 0;
let ethRetryableFailureInCurrentSweep = false;

function setEthBlockerStatus(
  code: EthMartingaleBlockerCode,
  message: string,
  order?: EthUnsettledOrder | null,
): void {
  ethBlockerStatus = {
    code,
    message,
    retryScheduled: ethDurableRetryTimer != null,
    retryAttempt: ethDurableRetryAttempt,
    ticker: order?.ticker ?? null,
    orderId: order?.kalshiOrderId ?? null,
    outcome: order?.outcome ?? null,
    filledContracts: order?.filledContracts ?? null,
    requestedContracts: order?.requestedContracts ?? null,
    createdAtMs: order?.createdAtMs ?? null,
    exchangeIndex: null,
    availableBalanceCents: null,
    requiredBalanceCents: null,
    balanceStale: false,
  };
}

function setEthExchangeBalanceBlocker(
  code: "exchange_balance_unavailable" | "insufficient_exchange_balance",
  message: string,
  exchangeIndex: number,
  availableBalanceCents: number | null,
  requiredBalanceCents: number,
  balanceStale: boolean,
): void {
  ethBlockerStatus = {
    code,
    message,
    retryScheduled: false,
    retryAttempt: 0,
    ticker: null,
    orderId: null,
    outcome: null,
    filledContracts: null,
    requestedContracts: null,
    createdAtMs: null,
    exchangeIndex,
    availableBalanceCents,
    requiredBalanceCents,
    balanceStale,
  };
}

/**
 * A manual settlement release intentionally leaves the actual Kalshi position
 * untouched. The durable recovery audit identifies every ticker that must be
 * flat before a later window can enter. This uses a direct authenticated read,
 * never a dashboard cache: unavailable or malformed exchange evidence blocks
 * the new entry rather than assuming a released position has disappeared.
 */
async function hasManualRecoveryResidualExposure(): Promise<{ ticker: string; contracts: number } | null | "unavailable"> {
  const recoveredTickers = await ethDependencies.store.listEthMartingaleManualRecoveryTickers();
  if (recoveredTickers == null) return "unavailable";

  for (const ticker of [...new Set(recoveredTickers)]) {
    try {
      const response = await ethDependencies.authFetch<{ market_positions?: Array<Record<string, unknown>> }>(
        "GET",
        `/portfolio/positions?ticker=${encodeURIComponent(ticker)}`,
      );
      if (!Array.isArray(response.market_positions)
        || response.market_positions.some((position) => position == null || typeof position !== "object")) {
        return "unavailable";
      }
      const row = response.market_positions.find((position) => position["ticker"] === ticker);
      if (row == null) continue;
      const rawPosition = row["position_fp"] ?? row["position"];
      const contracts = typeof rawPosition === "number"
        ? rawPosition
        : typeof rawPosition === "string" && rawPosition.trim() !== ""
          ? Number(rawPosition)
          : Number.NaN;
      if (!Number.isFinite(contracts)) return "unavailable";
      if (contracts !== 0) return { ticker, contracts };
    } catch (err) {
      logger.warn({ err, ticker }, "ETH entry blocked: manual-recovery position could not be verified");
      return "unavailable";
    }
  }
  return null;
}

/**
 * Reconcile again after a transient durable/read failure. This only performs
 * authenticated GETs and conditional durable transitions; it never re-enters
 * the order POST path. The single-flight reconciliation guard and SQL's
 * settlement_result IS NULL predicate keep repeated attempts exactly-once.
 */
function scheduleEthDurableRetry(
  code: "settlement_write_retry" | "temporary_exchange_read_failure" | "durable_store_failure" | "zero_fill_verification_pending",
  order?: EthUnsettledOrder | null,
  detail?: string,
): void {
  ethRetryableFailureInCurrentSweep = true;
  const pendingMessage = detail == null
    ? "ETH reconciliation remains blocked"
    : `ETH zero-fill verification remains blocked: ${detail}`;
  if (ethDurableRetryTimer != null || ethDurableRetryAttempt >= ETH_DURABLE_RETRY_DELAYS_MS.length) {
    setEthBlockerStatus(code, `${pendingMessage}; ${code === "zero_fill_verification_pending"
      ? "needs attention and will retry on the next lifecycle sweep"
      : "awaiting the next scheduled lifecycle sweep"}`, order);
    return;
  }
  const delayMs = ETH_DURABLE_RETRY_DELAYS_MS[ethDurableRetryAttempt++]!;
  setEthBlockerStatus(code, `${pendingMessage}; retrying in ${delayMs}ms`, order);
  ethDurableRetryTimer = ethDependencies.setRetryTimer(() => {
    ethDurableRetryTimer = null;
    ethRetryableFailureInCurrentSweep = false;
    void reconcileEthMartingaleSettlements().then((resolved) => {
      // A sweep can return true after keeping a durable order fenced. Only a
      // sweep with no retryable failure earns a fresh short-retry budget.
      if (resolved && !ethRetryableFailureInCurrentSweep) ethDurableRetryAttempt = 0;
    }).catch((err) => logger.warn({ err }, "ETH bounded reconciliation retry failed"));
  }, delayMs);
  ethDurableRetryTimer.unref?.();
}

function clearEthDurableRetry(): void {
  if (ethDurableRetryTimer != null) {
    ethDependencies.clearRetryTimer(ethDurableRetryTimer);
    ethDurableRetryTimer = null;
  }
  ethDurableRetryAttempt = 0;
  ethRetryableFailureInCurrentSweep = false;
}

export function getEthMartingaleBlockerStatus(): EthMartingaleBlockerStatus {
  return { ...ethBlockerStatus, retryScheduled: ethDurableRetryTimer != null, retryAttempt: ethDurableRetryAttempt };
}

function isTransientEthReadError(err: unknown): boolean {
  const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown } | null;
  const status = Number(candidate?.status ?? candidate?.statusCode);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN"]
    .includes(String(candidate?.code ?? ""));
}

/**
 * A POST transport failure remains ambiguous, but Kalshi's response-bearing
 * validation/not-found responses explicitly prove it did not create an order.
 * Require an exchange-supplied reason as well as the status so an HTML proxy
 * error or malformed response cannot accidentally release a reservation.
 */
function confirmedKalshiPostRejectionReason(err: unknown): string | null {
  if (typeof err !== "object" || err == null) return null;
  const candidate = err as { status?: unknown; body?: unknown };
  const status = Number(candidate.status);
  if (![400, 404, 422].includes(status)) return null;
  const body = candidate.body;
  const response = typeof body === "object" && body != null
    ? body as Record<string, unknown>
    : null;
  if (response == null) return null;
  const error = response?.["error"];
  const errorObject = typeof error === "object" && error != null
    ? error as Record<string, unknown>
    : null;
  // kalshiAuthFetch preserves an unparseable non-2xx body as raw text. That
  // could be an intermediary/proxy response, not an exchange rejection, so
  // only a structured Kalshi error object can prove no order was created.
  if (errorObject == null) return null;
  const reason = [
    errorObject?.["code"], errorObject?.["reason"], errorObject?.["message"],
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return reason == null ? null : reason.trim().slice(0, 500);
}

/**
 * Bounded retries are only for idempotent exchange reads. POST remains exactly
 * once and terminal state remains blocked when all read attempts are ambiguous.
 */
async function retryEthRead<T>(operation: string, read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ETH_RECONCILIATION_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await read();
    } catch (err) {
      lastError = err;
      if (!isTransientEthReadError(err) || attempt === ETH_RECONCILIATION_RETRY_DELAYS_MS.length - 1) {
        if (isTransientEthReadError(err)) {
          scheduleEthDurableRetry(
            "temporary_exchange_read_failure",
            null,
          );
        }
        throw err;
      }
      const delayMs = ETH_RECONCILIATION_RETRY_DELAYS_MS[attempt]!;
      logger.warn({ err, operation, retryAttempt: attempt + 1, delayMs },
        "ETH reconciliation read failed transiently; retrying without releasing exposure");
      await ethDependencies.sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Cancel an ETH GTC resting order via the exchange DELETE endpoint.
 *
 * Called during safety/reconciliation, including automatic close-time cleanup.
 * Confirms terminal status before
 * updating the local row. Returns true if the exchange confirmed cancellation.
 *
 * Never throws — failure is logged and returns false (fail closed: the resting
 * order continues to block new entries until it resolves).
 */
export async function cancelEthMartingaleGtcOrder(
  order: EthUnsettledOrder,
): Promise<boolean> {
  return (await cancelAndResolveEthMartingaleGtcOrder(order)) != null;
}

/**
 * Request cancellation and obtain explicit terminal evidence for the exact
 * order. A DELETE acknowledgement is not terminal proof: Kalshi can confirm
 * the cancellation asynchronously or omit the final count. In either case,
 * read the authenticated order detail before releasing any reservation.
 */
async function cancelAndResolveEthMartingaleGtcOrder(
  order: EthUnsettledOrder,
): Promise<EthUnsettledOrder | null> {
  if (!order.kalshiOrderId) return null;
  try {
    const raw = await ethDependencies.authFetch<Record<string, unknown>>(
      "DELETE", `/portfolio/events/orders/${encodeURIComponent(order.kalshiOrderId)}`,
    );
    const direct = terminalEthOrderEvidence(order, raw);
    let terminal = direct;
    if (terminal == null) {
      try {
        terminal = await readEthTerminalOrderEvidence(order);
      } catch (err) {
        // Kalshi can return 404 from the direct detail endpoint after accepting
        // a cancellation. A 404 proves nothing by itself, so only use the
        // authenticated terminal-history fallback below.
        if (!isKalshiNotFoundError(err)) throw err;
        terminal = await readEthTerminalOrderHistory(order);
      }
    }
    if (terminal == null) {
      scheduleEthDurableRetry(
        "zero_fill_verification_pending",
        order,
        "terminal order identity, status, or fill count is incomplete",
      );
      return null;
    }
    const { filled, feeCents, outcome } = terminal;
    const verifiedNoAttempt = outcome === "zero_fill"
      && await hasVerifiedClosedEthNoFillHandoff(order);
    if (outcome === "zero_fill" && !verifiedNoAttempt) {
      logger.warn({ ticker: order.ticker, orderId: order.kalshiOrderId },
        "ETH zero-fill cancellation remains fenced until independent fill and position evidence is complete");
      return null;
    }
    const durableOutcome = verifiedNoAttempt ? "zero_fill_verified" : outcome;
    const updated = await ethDependencies.store.updateEthMartingaleOrder({
      id: order.id, filledContracts: filled, filledFeeCents: feeCents, outcome: durableOutcome,
    });
    if (!updated) {
      scheduleEthDurableRetry("durable_store_failure", order);
      return null;
    }
    const fillCountChanged = filled !== (order.filledContracts ?? 0);
    return {
      ...order, filledContracts: filled, filledFeeCents: feeCents, outcome: durableOutcome,
      actualFillPriceCents: fillCountChanged ? null : order.actualFillPriceCents,
      actualNotionalDollars: fillCountChanged ? null : order.actualNotionalDollars,
      actualFeeDollars: fillCountChanged ? null : order.actualFeeDollars,
      fillEconomicsVerifiedContracts: fillCountChanged ? null : order.fillEconomicsVerifiedContracts,
    };
  } catch (err) {
    scheduleEthDurableRetry(
      "zero_fill_verification_pending",
      order,
      "terminal cancellation or history evidence is unavailable",
    );
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId },
      "ETH GTC close-time cancellation unresolved; leaving the prior window fenced");
    return null;
  }
}

function isKalshiNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err == null) return false;
  const candidate = err as { status?: unknown; statusCode?: unknown };
  return Number(candidate.status ?? candidate.statusCode) === 404;
}

type EthTerminalEvidence = {
  filled: number;
  feeCents: number;
  outcome: "zero_fill" | "partial_fill" | "full_fill";
};

function parseEthExplicitFillCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Kalshi decimal fixed-point fields must be a non-empty base-10 number.
  // Do not let Number() turn blank, exponent, or hexadecimal forms into fills.
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function terminalEthOrderEvidence(
  order: EthUnsettledOrder,
  raw: Record<string, unknown>,
): EthTerminalEvidence | null {
  const exchange = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
  const parsed = parseKalshiOrderResponse(
    { order: exchange },
    Math.max(0, order.requestedContracts - (order.filledContracts ?? 0)),
  );
  const TERMINAL = new Set(["canceled", "cancelled", "executed", "filled"]);
  const knownFilled = Math.max(0, order.filledContracts ?? 0);
  const explicitFill = exchange["fill_count_fp"] ?? exchange["fill_count"];
  const explicitCount = parseEthExplicitFillCount(explicitFill);
  const hasExactIdentity = exchange["order_id"] === order.kalshiOrderId
    && exchange["client_order_id"] === order.clientOrderId
    && exchange["ticker"] === order.ticker;
  const filled = explicitCount != null
    && explicitCount >= knownFilled
    && explicitCount >= 0
    && explicitCount <= order.requestedContracts
    ? explicitCount : null;
  if (parsed.rejectReason || !parsed.orderStatus || !TERMINAL.has(parsed.orderStatus)
    || !hasExactIdentity || filled == null) return null;
  return {
    filled,
    feeCents: parsed.reportedFeeCents ?? ethTakerFeeCents(order.noPriceCents, filled),
    outcome: filled === 0 ? "zero_fill"
      : filled >= order.requestedContracts ? "full_fill" : "partial_fill",
  };
}

async function readEthTerminalOrderEvidence(
  order: EthUnsettledOrder,
): Promise<EthTerminalEvidence | null> {
  if (!order.kalshiOrderId) return null;
  const raw = await retryEthRead(
    "ETH post-cancel terminal order detail",
    () => ethDependencies.authFetch<Record<string, unknown>>(
      "GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId!)}`,
    ),
  );
  return terminalEthOrderEvidence(order, raw);
}

/**
 * Inputs to the shared durable ETH GTC placement lifecycle. Callers must run
 * their own strategy-specific signal, balance, and exposure preflights before
 * invoking this gateway.
 */
export interface EthPlacementLifecycleRequest {
  state: EthMarketState;
  side: "yes" | "no";
  step: number;
  requestedPrincipalCents: number;
  requestedContracts: number;
  easternDate: string;
  /**
   * Immutable sequence snapshot used by the durable reservation to reject an
   * evaluation that became stale while its exchange preflight was running.
   */
  expectedMartingaleState: {
    easternDate: string;
    side: "yes" | "no";
    martingaleStep: number;
    realizedPnlCents: number;
  };
}

export type EthPlacementLifecycleGateway = (
  request: EthPlacementLifecycleRequest,
) => Promise<void>;

/**
 * The complete fail-closed ETH entry boundary.  This deliberately owns every
 * live preflight as well as placement, so another ETH strategy cannot copy a
 * subset of the checks and accidentally bypass reconciliation, the active
 * lock, manual-recovery exposure, or exchange-scoped balance verification.
 */
export interface EthPreflightAndPlacementRequest {
  state: EthMarketState;
  /**
   * A future approved strategy may supply its already-selected maximum
   * exposure.  The legacy caller omits this and uses its persisted ladder.
   */
  requestedPrincipalCents?: number;
  /**
   * A future approved strategy may supply its already-selected outcome side.
   * The legacy caller omits this and uses its persisted live ladder side.
   */
  side?: "yes" | "no";
  /**
   * A future approved strategy may supply its already-selected ladder step.
   * The legacy caller omits this and uses its persisted live ladder step.
   */
  step?: number;
  /**
   * A future approved strategy may supply its own current-day realized P&L for
   * its own loss-stop policy. The legacy caller omits this and uses its
   * persisted live ladder P&L.
   */
  realizedPnlCents?: number;
  /** Defaults to the legacy -$250 realized-loss stop. */
  dailyLossStopCents?: number;
}

export type EthPreflightAndPlacementGateway = (
  request: EthPreflightAndPlacementRequest,
) => Promise<void>;

/**
 * Runs the durable reservation through exchange acknowledgement lifecycle for
 * one already-approved ETH GTC entry. Reconciliation and all entry preflights
 * intentionally remain with the live evaluator.
 */
export const placeEthMartingaleGtcEntry: EthPlacementLifecycleGateway = async ({
  state, side, step, requestedPrincipalCents: _requestedPrincipalCents,
  requestedContracts: contracts, easternDate: date, expectedMartingaleState,
}) => {
  const exchangeIndex = state.exchangeIndex;
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
    setEthBlockerStatus("missing_exchange_index", "ETH order placement requires an exact exchange index");
    return;
  } // Kalshi auto-route by market ticker.
  const noPriceCents = ETH_GTC_LIMIT_PRICE_CENTS;
  const reservedFeeCents = ethTakerFeeCents(noPriceCents, contracts);
  const clientOrderId = `eth-${side}-${randomUUID()}`;
  // Preserve every prior attempt for audit/history while allowing a later
  // confirmed-rejection retry on the same ticker. The ticker claim remains
  // the single-attempt concurrency fence; the order-row primary key is unique
  // to this exact client order attempt.
  const id = `eth-entry:${ethStore.ETH_MARTINGALE_ACTIVE_GENERATION_KEY}:${state.ticker}:${clientOrderId}`;
  const proofMode = ethDependencies.stopAfterFirstPost();
  const reservation = await ethDependencies.store.reserveEthMartingaleEntry({
    ticker: state.ticker, easternDate: date, id, clientOrderId,
    side,
    martingaleStep: step, noPriceCents,
    requestedContracts: contracts, reservedFeeCents,
    expectedState: expectedMartingaleState,
    claimProofFence: proofMode,
  });
  if (reservation === "proof_already_claimed") {
    liveProofPostClaimed = true;
    ethDependencies.haltTrading(true);
    setEthBlockerStatus("live_proof_complete", "ETH live proof already made its one durable submission claim");
    return;
  }
  if (reservation !== "reserved" && (reservation as unknown) !== true) {
    setEthBlockerStatus("durable_store_failure", "ETH entry reservation could not be durably recorded");
    scheduleEthDurableRetry("durable_store_failure");
    return;
  }
  if (!await ethDependencies.store.markEthMartingaleOrderPostStarted(id)) {
    scheduleEthDurableRetry("durable_store_failure");
    return;
  }
  try {
    if (!ethDependencies.isEthOrderSubmissionPermitted(state.ticker)) {
      await ethDependencies.store.updateEthMartingaleOrder({
        id, filledContracts: 0, filledFeeCents: 0, outcome: "zero_fill",
      });
      return;
    }
    const payload = side === "yes"
      ? ethYesOrderPayload(state.ticker, clientOrderId, contracts, exchangeIndex)
      : ethNoOrderPayload(state.ticker, clientOrderId, contracts, exchangeIndex);
    if (proofMode) {
      if (liveProofPostClaimed) {
        setEthBlockerStatus("kill_switch", "ETH live proof already claimed its single order attempt");
        return;
      }
      liveProofPostClaimed = true;
      ethDependencies.haltTrading(true);
      logger.warn({ ticker: state.ticker }, "ETH live proof claim engaged before first order POST attempt");
    }
    logger.info({
      ticker: state.ticker, clientOrderId, side, contracts,
      exchangeRouting: exchangeIndex < 0 ? "ticker_auto" : exchangeIndex,
    }, "ETH A order POST starting");
    const raw = await ethDependencies.authFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", payload);
    const ack = parseKalshiOrderResponse(raw, contracts);
    if (ack.rejectReason) {
      logger.warn({
        ticker: state.ticker, clientOrderId, rejectReason: ack.rejectReason,
      }, "ETH A order POST rejected");
      if (!await ethDependencies.store.rejectEthMartingaleOrder({ id, rejectionReason: ack.rejectReason })) {
        scheduleEthDurableRetry("durable_store_failure");
      }
      return;
    }
    logger.info({
      ticker: state.ticker, clientOrderId, kalshiOrderId: ack.kalshiOrderId,
      orderStatus: ack.orderStatus, fillCount: ack.fillCount,
    }, "ETH A order POST acknowledged");
    if (!ack.kalshiOrderId) {
      await ethDependencies.store.updateEthMartingaleOrder({ id, outcome: "unresolved" });
      logger.error({ ticker: state.ticker }, "ETH GTC outcome unknown (no kalshi_order_id); permanent reservation retained");
      return;
    }
    const filled = Math.min(contracts, Math.max(0, ack.fillCount));
    if (filled >= contracts) {
      await ethDependencies.store.updateEthMartingaleOrder({
        id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
        filledFeeCents: ack.reportedFeeCents ?? ethTakerFeeCents(noPriceCents, filled),
        outcome: "full_fill",
      });
    } else {
      await ethDependencies.store.updateEthMartingaleOrder({
        id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
        filledFeeCents: ack.reportedFeeCents ?? (filled > 0 ? ethTakerFeeCents(noPriceCents, filled) : 0),
        outcome: "resting",
      });
    }
  } catch (err) {
    const candidate = err as { status?: unknown; body?: unknown; name?: unknown; code?: unknown } | null;
    const status = Number(candidate?.status);
    const body = typeof candidate?.body === "object" && candidate?.body != null
      ? candidate.body as Record<string, unknown>
      : null;
    const errorBody = typeof body?.["error"] === "object" && body?.["error"] != null
      ? body["error"] as Record<string, unknown>
      : null;
    logger.warn({
      ticker: state.ticker,
      clientOrderId,
      httpStatus: Number.isFinite(status) ? status : null,
      errorName: typeof candidate?.name === "string" ? candidate.name : null,
      errorCode: typeof errorBody?.["code"] === "string" ? errorBody["code"] : (typeof candidate?.code === "string" ? candidate.code : null),
      errorReason: typeof errorBody?.["reason"] === "string" ? errorBody["reason"] : null,
      errorMessage: typeof errorBody?.["message"] === "string" ? errorBody["message"] : null,
    }, "ETH A order POST failed");

    const rejectionReason = confirmedKalshiPostRejectionReason(err);
    if (rejectionReason != null) {
      if (!await ethDependencies.store.rejectEthMartingaleOrder({ id, rejectionReason })) {
        scheduleEthDurableRetry("durable_store_failure");
      }
      return;
    }

    // Ambiguous POST outcomes are reconciled by exact client id + ticker only.
    // Never resubmit here: a lost acknowledgement may still have created a live GTC.
    try {
      const lookup = await ethDependencies.authFetch<{ orders?: Array<Record<string, unknown>> }>(
        "GET",
        `/portfolio/orders?client_order_id=${encodeURIComponent(clientOrderId)}&ticker=${encodeURIComponent(state.ticker)}&limit=100`,
      );
      const matches = (lookup.orders ?? []).filter((order) =>
        order["client_order_id"] === clientOrderId && order["ticker"] === state.ticker,
      );
      if (matches.length === 1) {
        const rawOrder = matches[0]!;
        const parsed = parseKalshiOrderResponse({ order: rawOrder }, contracts);
        const recoveredOrderId = parsed.kalshiOrderId
          ?? (typeof rawOrder["order_id"] === "string" ? rawOrder["order_id"] : null);
        logger.warn({
          ticker: state.ticker,
          clientOrderId,
          kalshiOrderId: recoveredOrderId,
          orderStatus: parsed.orderStatus,
          fillCount: parsed.fillCount,
        }, "ETH A ambiguous POST recovered by exact client-order lookup");
        if (recoveredOrderId) {
          const filled = Math.min(contracts, Math.max(0, parsed.fillCount));
          await ethDependencies.store.updateEthMartingaleOrder({
            id,
            kalshiOrderId: recoveredOrderId,
            filledContracts: filled,
            filledFeeCents: parsed.reportedFeeCents ?? (filled > 0 ? ethTakerFeeCents(noPriceCents, filled) : 0),
            outcome: filled >= contracts ? "full_fill" : "resting",
          });
          return;
        }
      } else {
        logger.warn({ ticker: state.ticker, clientOrderId, exactMatches: matches.length },
          "ETH A ambiguous POST exact client-order lookup did not resolve uniquely");
      }
    } catch (lookupErr) {
      logger.warn({ err: lookupErr, ticker: state.ticker, clientOrderId },
        "ETH A ambiguous POST exact client-order lookup failed");
    }

    await ethDependencies.store.updateEthMartingaleOrder({ id, outcome: "unresolved" });
    logger.error({ err, ticker: state.ticker, clientOrderId }, "ETH GTC outcome unknown; permanent reservation retained");
  }
};

/**
 * Performs at most one permanently-reserved GTC entry attempt for an ETH market.
 *
 * GTC lifecycle:
 *  1. Reconcile any ambiguous prior orders (post_started / unresolved).
 *  2. Block if any unsettled order remains (pending, resting, partial_fill, unresolved).
 *  3. Reserve principal + fee atomically before submitting.
 *  4. POST GTC limit at ETH_GTC_LIMIT_PRICE_CENTS.
 *  5. On exchange acknowledgement: mark "resting" (unfilled or partially filled)
 *     or "full_fill" (immediately filled at 50¢).
 *  6. The reservation stays active (spent_cents reserved) while "resting".
 *
 * On restart: listUnsettledEthMartingaleOrders returns resting/partial rows,
 * which blocks new entries. reconcileEthMartingaleSettlements recovers
 * post_started/unresolved rows by querying the exchange for the client_order_id.
 */
export const runEthPreflightAndPlacement: EthPreflightAndPlacementGateway = async ({
  state,
  requestedPrincipalCents: requestedPrincipalOverride,
  side: requestedSide,
  step: requestedStep,
  realizedPnlCents: requestedRealizedPnlCents,
  dailyLossStopCents = ETH_DAILY_LOSS_STOP_CENTS,
}) => {
  if (!isEthTicker(state.ticker)) return;
  if (!enabled()) {
    setEthBlockerStatus("kill_switch", "ETH martingale is disabled by its runtime safety gate");
    return;
  }
  if (!isEthMarketEligible(state.status, state.openTime, state.closeTime, ethDependencies.now())) return;
  // Fail closed unless the authoritative market snapshot identifies the exact
  // Kalshi exchange. Balance authorization and order submission must use the same shard.
  const routingExchangeIndex = state.exchangeIndex;
  if (!Number.isInteger(routingExchangeIndex) || routingExchangeIndex < 0) {
    setEthBlockerStatus("missing_exchange_index", "ETH entry is blocked until the current market exchange index is known");
    return;
  }
  if (!ethDependencies.isEthOrderSubmissionPermitted(state.ticker)) {
    setEthBlockerStatus("kill_switch", "ETH order submission is blocked by a runtime safety gate");
    return;
  }
  if (active.has(state.ticker)) {
    setEthBlockerStatus("active_ticker_lock", "This ETH market is already being evaluated");
    return;
  }
  active.add(state.ticker);
  try {
    // Resolve any accepted-or-ambiguous prior GTC first; if unresolved, block new entries.
    if (!await reconcileEthMartingaleSettlements()) return;
    const unsettled = await ethDependencies.store.listUnsettledEthMartingaleOrders();
    // A failed list is never equivalent to an empty list: a transient database
    // timeout must not make a potentially live prior GTC invisible.
    // A terminal fill remains fenced until exact fill economics and settlement
    // have durably advanced (or preserved) the sequence. A zero-fill awaiting
    // its official result is excluded from this exposure list and must not
    // block a fresh window; a later sweep advances its sequence when the
    // result posts.
    if (unsettled == null) {
      scheduleEthDurableRetry("durable_store_failure");
      return;
    }
    if (unsettled.length > 0) return;

    const residualExposure = await hasManualRecoveryResidualExposure();
    if (residualExposure === "unavailable") {
      setEthBlockerStatus(
        "manual_recovery_position_unavailable",
        "ETH entry is blocked until exchange exposure from a manual recovery can be verified",
      );
      return;
    }
    if (residualExposure != null) {
      setEthBlockerStatus(
        "manual_recovery_residual_position",
        `ETH entry is blocked: manually released ${residualExposure.ticker} still has ${Math.abs(residualExposure.contracts)} contract(s) on Kalshi`,
      );
      return;
    }

    const sequence = await ethDependencies.store.getEthMartingaleState();
    if (!sequence) {
      scheduleEthDurableRetry("durable_store_failure");
      return; // storage health gate
    }

    const date = easternDay(new Date(ethDependencies.now()));

   // Day change resets daily accounting/risk only. The martingale sequence is continuous
// across midnight ET, so side and rung always come from the durable sequence unless
// an explicitly approved caller override is supplied.
const isNewDay = sequence.easternDate !== date;
const effectivePnl = requestedRealizedPnlCents == null
  ? (isNewDay ? 0 : sequence.realizedPnlCents)
  : Math.trunc(requestedRealizedPnlCents);
const effectiveStep = requestedStep == null
  ? sequence.martingaleStep
  : Math.max(0, Math.trunc(requestedStep));
const effectiveSide: "yes" | "no" = requestedSide ?? sequence.side;

    // Fail closed: loss stop
    if (effectivePnl <= dailyLossStopCents) {
      setEthBlockerStatus("daily_loss_stop", "ETH daily realized-loss stop is active");
      return;
    }

    // GTC at fixed 50¢: contracts = floor(principal / 50).
    // noPriceCents is always 50 for GTC orders (symmetric price).
    const noPriceCents = ETH_GTC_LIMIT_PRICE_CENTS;
    const requestedPrincipalCents = requestedPrincipalOverride ?? ethPrincipalForStep(effectiveStep);
    const contracts = Math.floor(requestedPrincipalCents / noPriceCents);
    if (contracts < 1) return;

    const reservedFeeCents = ethTakerFeeCents(noPriceCents, contracts);

const projectedFullLossPnlCents =
  effectivePnl - requestedPrincipalCents - reservedFeeCents;

if (projectedFullLossPnlCents < dailyLossStopCents) {
  setEthBlockerStatus(
    "daily_loss_stop",
    "ETH entry is blocked because a full loss on this wager would exceed the daily loss limit",
  );
  return;
}

const requiredBalanceCents = contracts * noPriceCents + reservedFeeCents;
    let accountBalance;
    try {
      accountBalance = await ethDependencies.fetchAccountBalance(routingExchangeIndex);
    } catch (err) {
      logger.warn({ err, ticker: state.ticker }, "ETH entry blocked: fresh routed-exchange balance read failed");
      setEthExchangeBalanceBlocker(
        "exchange_balance_unavailable",
        `ETH entry is blocked because exchange ${routingExchangeIndex} funds could not be verified; ${(requiredBalanceCents / 100).toFixed(2)} is required`,
        routingExchangeIndex,
        null,
        requiredBalanceCents,
        false,
      );
      return;
    }
    const availableBalanceCents = kalshiBalanceCents(accountBalance.value);
    if (accountBalance.stale || availableBalanceCents == null) {
      setEthExchangeBalanceBlocker(
        "exchange_balance_unavailable",
        `ETH entry is blocked because exchange ${routingExchangeIndex} balance is ${accountBalance.stale ? "stale" : "invalid"}; ${(requiredBalanceCents / 100).toFixed(2)} is required`,
        routingExchangeIndex,
        availableBalanceCents,
        requiredBalanceCents,
        accountBalance.stale,
      );
      return;
    }
    if (availableBalanceCents < requiredBalanceCents) {
      setEthExchangeBalanceBlocker(
        "insufficient_exchange_balance",
        `ETH entry is blocked: exchange ${routingExchangeIndex} has ${(availableBalanceCents / 100).toFixed(2)} available but requires ${(requiredBalanceCents / 100).toFixed(2)}`,
        routingExchangeIndex,
        availableBalanceCents,
        requiredBalanceCents,
        false,
      );
      return;
    }
    await placeEthMartingaleGtcEntry({
      state: { ...state, exchangeIndex: routingExchangeIndex }, side: effectiveSide, step: effectiveStep,
      requestedPrincipalCents,
      requestedContracts: contracts, easternDate: date,
      expectedMartingaleState: {
        easternDate: sequence.easternDate,
        side: sequence.side,
        martingaleStep: sequence.martingaleStep,
        realizedPnlCents: sequence.realizedPnlCents,
      },
    });
  } finally { active.delete(state.ticker); }
};

/**
 * Legacy strategy decision caller.  It intentionally contains no preflight,
 * reconciliation, balance, lifecycle, or POST logic: those all live in the
 * shared gateway above.
 */
export async function evaluateEthNoMartingale(state: EthMarketState): Promise<void> {
  await runEthPreflightAndPlacement({ state });
}

/**
 * Read-only diagnostic hints for the boundary orchestrator. Persisted order
 * sides remain authoritative only inside the existing settlement transaction;
 * this function never advances state, reserves, or writes.
 */
export async function getEthMartingalePriorOrderSideHints(): Promise<Array<{
  ticker: string; persistedSide: "yes" | "no"; persistedStep: number;
  winNextSide: "yes" | "no"; winNextStep: number;
  lossNextSide: "yes" | "no"; lossNextStep: number; createdAtMs: number;
}>> {
  const rows = await ethDependencies.store.listUnsettledEthMartingaleOrders();
  if (rows == null) return [];
  return rows
    .filter((row) => row.side === "yes" || row.side === "no")
    .map((row) => ({
      ticker: row.ticker,
      persistedSide: row.side,
      persistedStep: row.martingaleStep,
      winNextSide: row.side === "yes" ? "no" : "yes",
      winNextStep: 0,
      lossNextSide: row.side,
      lossNextStep: row.martingaleStep >= 5 ? 0 : row.martingaleStep + 1,
      createdAtMs: row.createdAtMs,
    }));
}

/**
 * Settlement/reconciliation sweep.
 *
 * For each unsettled ETH martingale order:
 *  - pending:          Expire if past the no-POST window (reservation not yet used).
 *  - post_started /
 *    unresolved:       Query exchange by client_order_id to recover fill count and status.
 *                      - "resting" status → update outcome to "resting" (stays active).
 *                      - "canceled" / "filled" → resolve to zero_fill / partial_fill / full_fill.
 *                      - Not found (no match) → leave unresolved (fail closed).
 *  - resting:          Poll exchange for updated fill count.
 *                      - Still resting → update filledContracts with latest partial fill.
 *                      - Filled / cancelled → finalize outcome.
 *                      - Once outcome is terminal, attempt market settlement.
 *  - full_fill /
 *    partial_fill:     Attempt to settle against the market result.
 *  - zero_fill /
 *    error / expired:  Terminal non-fill outcomes — skip settlement (not expected in unsettled list).
 */
let ethSettlementReconciliationInFlight: Promise<boolean> | null = null;

export function reconcileEthMartingaleSettlements(): Promise<boolean> {
  if (ethSettlementReconciliationInFlight != null) return ethSettlementReconciliationInFlight;
  const sweep = reconcileEthMartingaleSettlementsOnce();
  ethSettlementReconciliationInFlight = sweep;
  void sweep.finally(() => {
    if (ethSettlementReconciliationInFlight === sweep) ethSettlementReconciliationInFlight = null;
  });
  return sweep;
}

async function reconcileEthMartingaleSettlementsOnce(): Promise<boolean> {
  // Repair historical records first. The exchange fill ledger is authoritative
  // for price improvement and fees, so settled rows from before this code was
  // deployed are backfilled rather than permanently retaining their 50¢ limit.
  const economicsQueue = await ethDependencies.store.listEthMartingaleOrdersNeedingFillEconomics();
  if (economicsQueue == null) {
    scheduleEthDurableRetry("durable_store_failure");
    return false;
  }
  let durableEconomicsRepairPending = false;
  for (const order of economicsQueue) {
    if (!await reconcileEthMartingaleFillEconomics(order)) {
      if (getEthMartingaleBlockerStatus().code === "durable_store_failure") {
        durableEconomicsRepairPending = true;
      } else {
        setEthBlockerStatus("awaiting_fill_economics", "Exact exchange fill economics are not yet durable", order);
      }
    }
  }
  if (!await reconcileEthMartingaleZeroFillLadders()) return false;
  const unsettledOrders = await ethDependencies.store.listUnsettledEthMartingaleOrders();
  if (unsettledOrders == null) {
    scheduleEthDurableRetry("durable_store_failure");
    return false;
  }
  if (unsettledOrders.length === 0) {
    // A settled historical row can still require a durable exact-economics
    // repair. Keep its bounded retry alive even though no live exposure remains.
    if (durableEconomicsRepairPending) return false;
    clearEthDurableRetry();
    setEthBlockerStatus("ready", "No unresolved ETH martingale exposure");
    return true;
  }
  for (const order of unsettledOrders) {
    try {
      if (order.outcome === "pending") {
        if (order.submissionVersion >= 1
          && order.createdAtMs <= ethDependencies.now() - ETH_PENDING_RESERVATION_EXPIRY_MS
          // A pending row with any exchange identity, fill count, or fill
          // economics is not provably pre-POST. Leave it fail-closed for
          // reconciliation rather than releasing a potentially real order.
          && order.kalshiOrderId == null
          && order.filledContracts == null
          && order.filledFeeCents == null
          && order.actualFillPriceCents == null
          && order.actualNotionalDollars == null
          && order.actualFeeDollars == null
          && order.fillEconomicsVerifiedAtMs == null
          && order.fillEconomicsVerifiedContracts == null) {
          const released = await ethDependencies.store.expireEthMartingaleReservation(
            order.id, ethDependencies.now() - ETH_PENDING_RESERVATION_EXPIRY_MS,
          );
          if (!released) scheduleEthDurableRetry("durable_store_failure", order);
        } else {
          setEthBlockerStatus("pending_pre_submission", "Pre-submission reservation remains within its safe expiry window", order);
        }
        continue;
      }
      let reconciledOrder = order;
      if (order.outcome === "post_started" || order.outcome === "unresolved") {
        setEthBlockerStatus("unresolved_exchange_identity", "Exchange identity is not yet proven for this ETH order", order);
        const recoveredOrder = await recoverEthAmbiguousEntry(order);
        if (recoveredOrder == null) {
          const phantomResult = await resolveEthProvenPhantom(order);
          if (phantomResult === "released") {
            logger.warn({ ticker: order.ticker, id: order.id },
              "ETH unresolved entry released after complete authenticated absence evidence");
            // The durable release removed this exact pre-POST fence. Keep the
            // in-process status in sync for the single-row case; a later
            // unresolved row in this same sweep will immediately replace it.
            setEthBlockerStatus("ready", "No unresolved ETH martingale exposure");
            continue;
          }
          if (phantomResult === "incomplete") {
            setEthBlockerStatus("unresolved_exchange_identity",
              "ETH exchange absence evidence is incomplete; unresolved order remains fenced", order);
          }
          // A conflicting exchange identity/fill is intentionally kept fenced.
          continue;
        }
        // A recovered zero fill must wait for the next lifecycle pass to
        // obtain official-result evidence and apply its ladder transition.
        // Keep the entry fence intact in the meantime.
        if (recoveredOrder.outcome === "zero_fill") {
          setEthBlockerStatus("awaiting_settlement",
            "Zero-fill ETH order awaits official market-result ladder transition", recoveredOrder);
          return false;
        }
        if (recoveredOrder.outcome === "zero_fill_verified") {
          setEthBlockerStatus("ready", "Verified zero-fill ETH handoff preserved the current ladder state");
          continue;
        }
        // If it recovered to "resting", fall through to poll for latest state below.
        if (recoveredOrder.outcome === "resting") {
          // Re-fetch the updated row to get the kalshi_order_id for polling.
          // We skip settlement here; the next reconcile cycle will handle it.
          continue;
        }
        // The SQL store does not mutate the row object it was passed. Carry the
        // recovered terminal identity/count forward so this same close-handoff
        // sweep can verify immutable fills and settle before the next window.
        reconciledOrder = recoveredOrder;
      }
      // A terminal poll must continue through fill economics and settlement in
      // this sweep; otherwise an already-open next window waits for another
      // reconciliation interval despite confirmed exchange evidence.
      // A terminal partial/full row whose immutable fill chunks do not match
      // its stored count may have missed a final exchange fill before the
      // terminal response was persisted. Refresh its authenticated terminal
      // evidence only in that mismatch case, then retry economics below.
      if ((order.outcome === "partial_fill" || order.outcome === "full_fill")
        && !await reconcileEthMartingaleFillEconomics(order)) {
        if (getEthMartingaleBlockerStatus().code !== "durable_store_failure") {
          setEthBlockerStatus("awaiting_fill_economics", "Exact exchange fill economics are required before settlement", order);
        }
        const refreshedOrder = await pollEthRestingOrder(order);
        if (refreshedOrder == null) continue;
        if (refreshedOrder.outcome === "zero_fill") {
          setEthBlockerStatus("awaiting_settlement",
            "Zero-fill ETH order awaits official market-result ladder transition", refreshedOrder);
          return false;
        }
        if (refreshedOrder.outcome === "zero_fill_verified") {
          setEthBlockerStatus("ready", "Verified zero-fill ETH handoff preserved the current ladder state");
          continue;
        }
        if (refreshedOrder.outcome === "resting") {
          if (!await ethMartingaleMarketHasClosed(refreshedOrder.ticker)) continue;
          const canceledOrder = await cancelAndResolveEthMartingaleGtcOrder(refreshedOrder);
          if (canceledOrder == null) return false;
          if (canceledOrder.outcome === "zero_fill") {
            setEthBlockerStatus("awaiting_settlement",
              "Zero-fill ETH order awaits official market-result ladder transition", canceledOrder);
            return false;
          }
          if (canceledOrder.outcome === "zero_fill_verified") {
            setEthBlockerStatus("ready", "Verified zero-fill ETH handoff preserved the current ladder state");
            continue;
          }
          reconciledOrder = canceledOrder;
        } else {
          reconciledOrder = refreshedOrder;
        }
      }
      if (order.outcome === "resting") {
        setEthBlockerStatus(
          (order.filledContracts ?? 0) > 0 ? "partial_fill" : "resting_prior_order",
          (order.filledContracts ?? 0) > 0
            ? "A partially filled ETH order remains active on the exchange"
            : "A resting ETH order remains active on the exchange",
          order,
        );
        const polledOrder = await pollEthRestingOrder(order);
        if (polledOrder == null) continue;
        if (polledOrder.outcome === "zero_fill") {
          setEthBlockerStatus("awaiting_settlement",
            "Zero-fill ETH order awaits official market-result ladder transition", polledOrder);
          return false;
        }
        if (polledOrder.outcome === "zero_fill_verified") {
          setEthBlockerStatus("ready", "Verified zero-fill ETH handoff preserved the current ladder state");
          continue;
        }
        if (polledOrder.outcome === "resting") {
          // ETH entries are GTC only while their own 15-minute market remains
          // open. Once an authenticated market response proves close has
          // passed, cancel the remaining quantity. A failed lookup/cancel or
          // ambiguous terminal response remains a hard fence.
          if (!await ethMartingaleMarketHasClosed(polledOrder.ticker)) continue;
          const canceledOrder = await cancelAndResolveEthMartingaleGtcOrder(polledOrder);
          if (canceledOrder == null) return false;
          if (canceledOrder.outcome === "zero_fill") {
            setEthBlockerStatus("awaiting_settlement",
              "Zero-fill ETH order awaits official market-result ladder transition", canceledOrder);
            return false;
          }
          if (canceledOrder.outcome === "zero_fill_verified") {
            setEthBlockerStatus("ready", "Verified zero-fill ETH handoff preserved the current ladder state");
            continue;
          }
          // A partial/full close-time cancellation must verify immutable fill
          // economics and settle before this sweep can release its next window.
          reconciledOrder = canceledOrder;
        } else {
          reconciledOrder = polledOrder;
        }
      }
      // For full_fill or partial_fill: attempt market settlement.
      const raw = await retryEthRead(
        "authenticated market settlement lookup",
        () => ethDependencies.marketSettlementFetch<Record<string, unknown>>(
          "GET", `/markets/${encodeURIComponent(reconciledOrder.ticker)}`,
        ),
      ) as Record<string, unknown> | null;
      const market = raw?.["market"] as Record<string, unknown> | undefined;
      const result = market?.["result"];
      if (result === "yes" || result === "no") {
        if (await reconcileEthMartingaleFillEconomics(reconciledOrder)) {
          const settled = await ethDependencies.store.settleEthMartingaleOrder(reconciledOrder.id, result);
          if (!settled) {
            scheduleEthDurableRetry("settlement_write_retry", reconciledOrder);
            return false;
          }
        } else {
          if (getEthMartingaleBlockerStatus().code !== "durable_store_failure") {
            setEthBlockerStatus("awaiting_fill_economics", "Exact exchange fill economics are required before settlement", reconciledOrder);
          }
        }
      } else {
        setEthBlockerStatus("awaiting_settlement", "Market settlement result is not yet available", reconciledOrder);
      }
    } catch (err) {
      logger.warn({ err, ticker: order.ticker }, "ETH settlement reconciliation unavailable");
      if (isTransientEthReadError(err)) {
        scheduleEthDurableRetry("temporary_exchange_read_failure", order);
      } else {
        setEthBlockerStatus("unresolved_exchange_identity", "ETH reconciliation evidence is incomplete", order);
      }
      return false;
    }
  }
  return true;
}

/**
 * A regular zero-fill order has no fill economics or P&L, but is still one
 * completed martingale attempt. Advance its persisted side/step only after
 * authenticated market-result evidence is available. Closed GTC no-attempt
 * handoffs use the distinct `zero_fill_verified` terminal state and are
 * deliberately excluded from this queue.
 */
export async function reconcileEthMartingaleZeroFillLadders(): Promise<boolean> {
  const zeroFills = await ethDependencies.store.listUnsettledEthMartingaleZeroFillOrders();
  if (!zeroFills) {
    scheduleEthDurableRetry("durable_store_failure");
    return false;
  }

  for (const order of zeroFills) {
    try {
      const raw = await retryEthRead(
        "authenticated zero-fill market settlement lookup",
        () => ethDependencies.marketSettlementFetch<Record<string, unknown>>(
          "GET", `/markets/${encodeURIComponent(order.ticker)}`,
        ),
      ) as Record<string, unknown> | null;
      const market = raw?.["market"] as Record<string, unknown> | undefined;
      const result = market?.["result"];
      if (result !== "yes" && result !== "no") {
        setEthBlockerStatus("awaiting_settlement",
          "Zero-fill ETH order awaits an official market result", order);
        // An unresolved market result is not live exposure and must not fence
        // a new window. Leave this row for a later sweep while continuing to
        // reconcile the remaining zero-fill queue.
        continue;
      }

      const advanced = await ethDependencies.store.advanceEthMartingaleLadderForZeroFill(order.id, result);
      if (!advanced) {
        logger.warn({ id: order.id, ticker: order.ticker },
          "ETH zero-fill ladder transition was not applied; it will retry on the next sweep");
        scheduleEthDurableRetry("settlement_write_retry", order);
        return false;
      }
    } catch (err) {
      logger.warn({ err, ticker: order.ticker },
        "ETH zero-fill market-result reconciliation unavailable");
      if (isTransientEthReadError(err)) {
        scheduleEthDurableRetry("temporary_exchange_read_failure", order);
      } else {
        setEthBlockerStatus("awaiting_settlement",
          "Zero-fill ETH order awaits authenticated market-result evidence", order);
      }
      return false;
    }
  }
  return true;
}

/**
 * Read the durable ETH entry fence after a reconciliation pass.
 * `null` is deliberately distinct from false: an unavailable store must remain
 * fail-closed and should receive the same bounded retry as known exposure.
 */
export async function hasUnsettledEthMartingaleExposure(): Promise<boolean | null> {
  try {
    const orders = await ethDependencies.store.listUnsettledEthMartingaleOrders();
    return orders == null ? null : orders.length > 0;
  } catch (err) {
    logger.warn({ err }, "ETH unsettled exposure check unavailable; retaining reconciliation fence");
    return null;
  }
}

/** Fail closed unless an authenticated market response identifies this exact
 * ticker and supplies a valid close instant at or before reconciliation time. */
async function ethMartingaleMarketHasClosed(ticker: string): Promise<boolean> {
  try {
    const raw = await retryEthRead(
      "ETH close-time lookup",
      () => ethDependencies.authFetch<Record<string, unknown>>("GET", `/markets/${encodeURIComponent(ticker)}`),
    ) as Record<string, unknown> | null;
    const market = raw?.["market"] as Record<string, unknown> | undefined;
    if (market?.["ticker"] !== ticker) return false;
    const closeTime = market?.["close_time"] ?? market?.["closeTime"];
    const closeMs = typeof closeTime === "string" ? Date.parse(closeTime) : NaN;
    return Number.isFinite(closeMs) && ethDependencies.now() >= closeMs;
  } catch (err) {
    logger.warn({ err, ticker }, "ETH market close-time verification unavailable; zero-fill handoff remains fenced");
    return false;
  }
}

/**
 * Load all immutable fill chunks for a martingale order and store their exact
 * aggregate. No estimated order price/fee is accepted here: without complete
 * evidence the order stays pending for settlement and no new ladder entry can
 * be unlocked by a guessed P&L.
 */
async function reconcileEthMartingaleFillEconomics(
  order: EthUnsettledOrder,
): Promise<boolean> {
  if (order.actualNotionalDollars != null && order.actualFeeDollars != null
    && order.fillEconomicsVerifiedContracts === order.filledContracts) return true;
  if (!order.kalshiOrderId) return false;
  try {
    const raw = await retryEthRead(
      "fill economics lookup",
      () => ethDependencies.authFetch<{ fills?: KalshiFillWire[] }>(
        "GET", `/portfolio/fills?order_id=${encodeURIComponent(order.kalshiOrderId!)}`,
      ),
    );
    const fills = raw.fills ?? [];
    let contractsExact = "0";
    let weightedPrice = 0;
    let notional = "0";
    let fee = "0";
    for (const fill of fills) {
      const normalized = normalizeKalshiFill(fill, order.side);
      if (!normalized || !normalized.fillId) return false;
      contractsExact = addDecimalStrings(contractsExact, normalized.contractsExact);
      weightedPrice += normalized.fillPriceCents * normalized.contracts;
      notional = addDecimalStrings(notional, normalized.exactCostDollars);
      fee = addDecimalStrings(fee, normalized.exactFeeDollars);
    }
    // A fill ledger is only authoritative for this order when it exactly matches
    // the terminal quantity we observed from the order endpoint. This prevents a
    // partial GTC fill from being used after more contracts fill.
    // `count_fp` is a fixed-point quantity. Aggregate it as a decimal string:
    // 7.14 + 14.28 is 21.42, but JavaScript's numeric sum is
    // 21.419999999999998 and would incorrectly reject authoritative evidence.
    // Parsed order totals are normalized by Number/String into the same compact
    // decimal form, while the durable numeric column retains that value exactly.
    const contracts = Number(contractsExact);
    const expectedContractsExact = order.filledContracts == null ? null : String(order.filledContracts);
    if (!Number.isFinite(contracts) || contracts <= 0
      || expectedContractsExact == null || contractsExact !== expectedContractsExact) return false;
    const persisted = await ethDependencies.store.recordEthMartingaleFillEconomics({
      id: order.id, contracts, fillPriceCents: Math.round(weightedPrice / contracts),
      notionalDollars: notional, feeDollars: fee,
    });
    if (!persisted) scheduleEthDurableRetry("durable_store_failure", order);
    return persisted;
  } catch (err) {
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId },
      "ETH fill economics unavailable; settlement remains fail-closed");
    return false;
  }
}

/**
 * A terminal status alone is not fill evidence: a fill may have landed after
 * the last resting poll. Only an explicit final count can release a live
 * reservation. Never manufacture a zero count, and never accept an exchange
 * count that regresses known exposure.
 */
function resolveEthTerminalFillCount(
  order: EthUnsettledOrder,
  exchange: Record<string, unknown>,
): number | null {
  const explicitFill = exchange["fill_count_fp"] ?? exchange["fill_count"];
  const parsedFill = parseEthExplicitFillCount(explicitFill);
  const knownFilled = order.filledContracts;
  if (parsedFill == null || parsedFill < 0 || parsedFill > order.requestedContracts) return null;
  if (knownFilled != null && parsedFill < knownFilled) return null;
  return parsedFill;
}

/**
 * Poll a resting GTC order for updated fill state.
 *
 * Queries the exchange order detail endpoint and updates the local row:
 * - If still resting: update filledContracts with any partial fill.
 * - If terminal (filled/cancelled): update outcome to full_fill/partial_fill,
 *   or a verified no-attempt handoff for a closed zero-fill GTC.
 *
 * Called during reconcileEthMartingaleSettlements for "resting" outcome rows.
 * The reservation (spent_cents) release is handled by updateEthMartingaleOrder
 * when a terminal outcome is recorded.
 */
async function pollEthRestingOrder(
  order: EthUnsettledOrder,
): Promise<EthUnsettledOrder | null> {
  if (!order.kalshiOrderId) return null;
  try {
    const detailRaw = await retryEthRead(
      "resting order detail",
      () => ethDependencies.authFetch<Record<string, unknown>>(
        "GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId!)}`,
      ),
    );
    const exchange = (detailRaw["order"] as Record<string, unknown> | undefined) ?? detailRaw;
    if (exchange["order_id"] !== order.kalshiOrderId
      || exchange["client_order_id"] !== order.clientOrderId
      || exchange["ticker"] !== order.ticker) {
      scheduleEthDurableRetry(
        "zero_fill_verification_pending",
        order,
        "terminal order identity does not yet match the reserved order",
      );
      return null;
    }

    const ack = parseKalshiOrderResponse({ order: exchange }, order.requestedContracts);
    const filled = resolveEthTerminalFillCount(order, exchange);
    if (filled === null) {
      const TERMINAL_STATUSES = new Set(["canceled", "cancelled", "executed", "filled"]);
      if (ack.orderStatus != null && TERMINAL_STATUSES.has(ack.orderStatus)) {
        scheduleEthDurableRetry(
          "zero_fill_verification_pending",
          order,
          "terminal order fill count is missing, invalid, or regresses known exposure",
        );
      }
      return null; // Cannot determine fill count — skip.
    }

    const TERMINAL_STATUSES = new Set(["canceled", "cancelled", "executed", "filled"]);
    const isTerminal = ack.orderStatus != null && TERMINAL_STATUSES.has(ack.orderStatus);
    const outcome = isTerminal
      ? filled === 0 ? "zero_fill"
        : filled >= order.requestedContracts ? "full_fill" : "partial_fill"
      : "resting";
    const filledFeeCents = ack.reportedFeeCents ?? (filled > 0
      ? ethTakerFeeCents(order.noPriceCents, filled) : null);

    if (isTerminal) {
      // An exchange auto-cancel observed from detail is not an ordinary
      // zero-fill attempt. It must meet exactly the same close, fill-history,
      // and position proof as the explicit-cancellation and 404 paths.
      const durableOutcome = outcome === "zero_fill"
        && await hasVerifiedClosedEthNoFillHandoff(order)
        ? "zero_fill_verified" : outcome;
      if (outcome === "zero_fill" && durableOutcome !== "zero_fill_verified") {
        logger.warn({ ticker: order.ticker, orderId: order.kalshiOrderId },
          "ETH terminal zero fill remains fenced until closed-market and independent exposure evidence is complete");
        return null;
      }
      const updated = await ethDependencies.store.updateEthMartingaleOrder({
        id: order.id, filledContracts: filled, filledFeeCents, outcome: durableOutcome,
        terminalFillRefresh: (order.outcome === "partial_fill" || order.outcome === "full_fill")
          && filled > (order.filledContracts ?? 0),
        priorFilledContracts: order.filledContracts,
        priorFilledFeeCents: order.filledFeeCents,
      });
      // The exchange proof cannot unblock the next ticker until the durable
      // release is confirmed. A failed/ambiguous database write stays blocked.
      if (!updated) {
        scheduleEthDurableRetry("durable_store_failure", order);
        return null;
      }
    } else {
      // Still resting — update partial fill if changed.
      if (filled !== order.filledContracts) {
        const updated = await ethDependencies.store.updateEthMartingaleOrder({
          id: order.id, filledContracts: filled, filledFeeCents, outcome,
        });
        if (!updated) {
          // The exchange's newer fill count cannot become authoritative until
          // it is durable; preserve the prior persisted exposure and retry
          // reconciliation only.
          scheduleEthDurableRetry("durable_store_failure", order);
          return null;
        }
      }
    }
    const fillCountChanged = filled !== (order.filledContracts ?? 0);
    return {
      ...order, filledContracts: filled, filledFeeCents,
      outcome: isTerminal && outcome === "zero_fill" ? "zero_fill_verified" : outcome,
      actualFillPriceCents: fillCountChanged ? null : order.actualFillPriceCents,
      actualNotionalDollars: fillCountChanged ? null : order.actualNotionalDollars,
      actualFeeDollars: fillCountChanged ? null : order.actualFeeDollars,
      fillEconomicsVerifiedContracts: fillCountChanged ? null : order.fillEconomicsVerifiedContracts,
    };
  } catch (err) {
    // A direct order-detail 404 is never release evidence. Once the market has
    // closed, however, cancellation plus terminal history, fill history, and
    // position checks may establish a verified no-fill handoff.
    if (isKalshiNotFoundError(err)) {
      if (await ethMartingaleMarketHasClosed(order.ticker)) {
        return cancelAndResolveEthMartingaleGtcOrder(order);
      }
      scheduleEthDurableRetry(
        "zero_fill_verification_pending",
        order,
        "authenticated market closure has not been confirmed after order-detail absence",
      );
      return null;
    }
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId },
      "ETH resting order poll failed; order stays resting");
    return null;
  }
}

/** Link uncertain POSTs only through an exchange record bearing our client id. */
async function recoverEthAmbiguousEntry(
  order: EthUnsettledOrder,
): Promise<EthUnsettledOrder | null> {
  const ordersRaw = await retryEthRead(
    "ambiguous order discovery",
    () => ethDependencies.authFetch<{ orders?: Array<Record<string, unknown>> }>(
      "GET", `/portfolio/orders?${new URLSearchParams({ ticker: order.ticker, limit: "100" })}`,
    ),
  );
  const matching = (ordersRaw.orders ?? []).filter((exchange) =>
    exchange["client_order_id"] === order.clientOrderId && exchange["ticker"] === order.ticker
      && typeof exchange["order_id"] === "string",
  );
  if (matching.length !== 1) return null;
  const kalshiOrderId = String(matching[0]!["order_id"]);
  const detailRaw = await retryEthRead(
    "ambiguous order detail",
    () => ethDependencies.authFetch<Record<string, unknown>>(
      "GET", `/portfolio/orders/${encodeURIComponent(kalshiOrderId)}`,
    ),
  );
  const exchange = (detailRaw["order"] as Record<string, unknown> | undefined) ?? detailRaw;
  if (exchange["order_id"] !== kalshiOrderId
    || exchange["client_order_id"] !== order.clientOrderId
    || exchange["ticker"] !== order.ticker) {
    scheduleEthDurableRetry(
      "zero_fill_verification_pending",
      { ...order, kalshiOrderId },
      "recovered terminal order identity does not yet match the reserved order",
    );
    return null;
  }
  const ack = parseKalshiOrderResponse({ order: exchange }, order.requestedContracts);
  const filled = resolveEthTerminalFillCount(order, exchange);
  if (filled == null) {
    // Exchange order exists but fill count is unclear. Check for resting status.
    const RESTING_STATUSES = new Set(["resting", "open", "accepted"]);
    if (ack.orderStatus != null && RESTING_STATUSES.has(ack.orderStatus)) {
      // Preserve any already-durable fill quantity. A current resting status
      // establishes the order is still live, but an omitted count cannot
      // safely overwrite prior authenticated evidence with zero.
      const updated = await ethDependencies.store.updateEthMartingaleOrder({
        id: order.id, kalshiOrderId, outcome: "resting",
      });
      if (!updated) {
        scheduleEthDurableRetry("durable_store_failure", order);
        return null;
      }
      return { ...order, kalshiOrderId, outcome: "resting" };
    }
    const TERMINAL_STATUSES = new Set(["canceled", "cancelled", "executed", "filled"]);
    if (ack.orderStatus != null && TERMINAL_STATUSES.has(ack.orderStatus)) {
      scheduleEthDurableRetry(
        "zero_fill_verification_pending",
        { ...order, kalshiOrderId },
        "recovered terminal order fill count is missing, invalid, or regresses known exposure",
      );
    }
    return null;
  }
  const clamped = Math.min(order.requestedContracts, filled);

  // Check for resting/open status — GTC order still active on exchange.
  const RESTING_STATUSES = new Set(["resting", "open", "accepted"]);
  if (ack.orderStatus != null && RESTING_STATUSES.has(ack.orderStatus)) {
    const updated = await ethDependencies.store.updateEthMartingaleOrder({
      id: order.id, kalshiOrderId, filledContracts: clamped,
      filledFeeCents: ack.reportedFeeCents ?? (clamped > 0 ? ethTakerFeeCents(order.noPriceCents, clamped) : 0),
      outcome: "resting",
    });
    if (!updated) {
      scheduleEthDurableRetry("durable_store_failure", order);
      return null;
    }
    return {
      ...order, kalshiOrderId, filledContracts: clamped,
      filledFeeCents: ack.reportedFeeCents ?? (clamped > 0 ? ethTakerFeeCents(order.noPriceCents, clamped) : 0),
      outcome: "resting",
    };
  }

  // Terminal outcome.
  const outcome = clamped === 0 ? "zero_fill" : clamped === order.requestedContracts ? "full_fill" : "partial_fill";
  const recoveredOrder = { ...order, kalshiOrderId };
  const durableOutcome = outcome === "zero_fill"
    && await hasVerifiedClosedEthNoFillHandoff(recoveredOrder)
    ? "zero_fill_verified" : outcome;
  if (outcome === "zero_fill" && durableOutcome !== "zero_fill_verified") {
    logger.warn({ ticker: order.ticker, orderId: kalshiOrderId },
      "ETH recovered terminal zero fill remains fenced until closed-market and independent exposure evidence is complete");
    return null;
  }
  const updated = await ethDependencies.store.updateEthMartingaleOrder({
    id: order.id, kalshiOrderId, filledContracts: clamped,
    filledFeeCents: ack.reportedFeeCents ?? ethTakerFeeCents(order.noPriceCents, clamped),
    outcome: durableOutcome,
  });
  if (!updated) {
    scheduleEthDurableRetry("durable_store_failure", order);
    return null;
  }
  const fillCountChanged = clamped !== (order.filledContracts ?? 0);
  return {
    ...order, kalshiOrderId, filledContracts: clamped,
    filledFeeCents: ack.reportedFeeCents ?? ethTakerFeeCents(order.noPriceCents, clamped),
    outcome: durableOutcome,
    actualFillPriceCents: fillCountChanged ? null : order.actualFillPriceCents,
    actualNotionalDollars: fillCountChanged ? null : order.actualNotionalDollars,
    actualFeeDollars: fillCountChanged ? null : order.actualFeeDollars,
    fillEconomicsVerifiedContracts: fillCountChanged ? null : order.fillEconomicsVerifiedContracts,
  };
}

type EthPhantomResolution = "released" | "conflicting" | "incomplete";
type EthHistoryPage = {
  orders?: Array<Record<string, unknown>>;
  fills?: Array<Record<string, unknown>>;
  cursor?: unknown;
};

/** Find the exact canceled/executed order in fully paginated authenticated history. */
async function readEthTerminalOrderHistory(order: EthUnsettledOrder): Promise<EthTerminalEvidence | null> {
  for (const status of ["canceled", "executed"] as const) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const qs = new URLSearchParams({ ticker: order.ticker, status, limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const page = await retryEthRead(
        "ETH canceled-order history fallback",
        () => ethDependencies.authFetch<EthHistoryPage>("GET", `/portfolio/orders?${qs}`),
      );
      if (!Array.isArray(page.orders)) return null;
      for (const candidate of page.orders) {
        if (candidate == null || typeof candidate !== "object") return null;
        if (candidate["order_id"] !== order.kalshiOrderId
          || candidate["client_order_id"] !== order.clientOrderId
          || candidate["ticker"] !== order.ticker) continue;
        return terminalEthOrderEvidence(order, { order: candidate });
      }
      const next = page.cursor;
      if (next == null || next === "") break;
      if (typeof next !== "string" || seenCursors.has(next)) return null;
      seenCursors.add(next);
      cursor = next;
    }
  }
  return null;
}

/**
 * A confirmed terminal count is still not sufficient to call an old GTC a
 * no-attempt. Independently require a complete empty fill-history scan and a
 * fresh zero position for the exact ticker. Any malformed response, unreadable
 * page, matching fill, or nonzero position remains a hard fence.
 */
type EthNoFillVerification = { verified: true } | { verified: false; reason: string };

async function verifyEthNoFillEvidence(order: EthUnsettledOrder): Promise<EthNoFillVerification> {
  if (!order.kalshiOrderId || (order.filledContracts ?? 0) !== 0) {
    return { verified: false, reason: "terminal zero-fill order identity is incomplete" };
  }
  try {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const qs = new URLSearchParams({ order_id: order.kalshiOrderId, limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const page = await retryEthRead(
        "ETH zero-fill history verification",
        () => ethDependencies.authFetch<EthHistoryPage>("GET", `/portfolio/fills?${qs}`),
      );
      if (!Array.isArray(page.fills)) return { verified: false, reason: "fill-history response is incomplete" };
      for (const fill of page.fills) {
        if (fill == null || typeof fill !== "object") {
          return { verified: false, reason: "fill-history response contains an unreadable record" };
        }
        const ticker = fill["ticker"] ?? fill["market_ticker"];
        const matchingOrder = fill["order_id"] === order.kalshiOrderId
          || fill["client_order_id"] === order.clientOrderId;
        // The filtered response must not contain an unidentifiable fill for
        // this ticker: it could be the missing order identity.
        if (matchingOrder || (ticker === order.ticker
          && fill["order_id"] == null && fill["client_order_id"] == null)) {
          return { verified: false, reason: "matching or unidentifiable exchange fill was found" };
        }
      }
      const next = page.cursor;
      if (next == null || next === "") break;
      if (typeof next !== "string" || seenCursors.has(next)) {
        return { verified: false, reason: "fill-history pagination is incomplete" };
      }
      seenCursors.add(next);
      cursor = next;
    }

    const positions = await retryEthRead(
      "ETH zero-fill position verification",
      () => ethDependencies.authFetch<{ market_positions?: Array<Record<string, unknown>> }>(
        "GET", `/portfolio/positions?ticker=${encodeURIComponent(order.ticker)}`,
      ),
    );
    if (!Array.isArray(positions.market_positions)
      || positions.market_positions.some((position) => position == null || typeof position !== "object")) {
      return { verified: false, reason: "position response is incomplete" };
    }
    const position = positions.market_positions.find((row) => row["ticker"] === order.ticker);
    if (position == null) return { verified: true };
    const raw = position["position_fp"] ?? position["position"];
    const contracts = typeof raw === "number" ? raw
      : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    return Number.isFinite(contracts) && contracts === 0
      ? { verified: true }
      : { verified: false, reason: Number.isFinite(contracts)
        ? "a nonzero exchange position remains"
        : "exchange position value is unreadable" };
  } catch (err) {
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId },
      "ETH zero-fill verification unavailable; order remains fenced");
    return { verified: false, reason: "authenticated fill or position read is unavailable" };
  }
}

/**
 * A verification gap is never release evidence, but it must be visible and
 * actively retried. Short retries heal propagation/transport delays; after
 * that the production lifecycle sweep continues to retry on its cadence.
 */
async function hasVerifiedClosedEthNoFillHandoff(order: EthUnsettledOrder): Promise<boolean> {
  if (!await ethMartingaleMarketHasClosed(order.ticker)) {
    scheduleEthDurableRetry(
      "zero_fill_verification_pending",
      order,
      "authenticated market closure has not been confirmed",
    );
    return false;
  }
  const verification = await verifyEthNoFillEvidence(order);
  if (verification.verified) return true;
  scheduleEthDurableRetry("zero_fill_verification_pending", order, verification.reason);
  return false;
}

function isLocalPhantomCandidate(order: EthUnsettledOrder): boolean {
  return (order.outcome === "post_started" || order.outcome === "unresolved")
    && order.kalshiOrderId == null && order.filledContracts == null && order.filledFeeCents == null
    && order.actualFillPriceCents == null && order.actualNotionalDollars == null
    && order.actualFeeDollars == null && order.fillEconomicsVerifiedAtMs == null
    && order.fillEconomicsVerifiedContracts == null;
}

/**
 * Scan every authenticated page. A missing/malformed page, repeated cursor,
 * read error, or any possibly matching identity is unsafe and therefore does
 * not establish absence.
 */
async function hasCompleteEthHistoryAbsence(
  order: EthUnsettledOrder,
): Promise<"absent" | "conflicting" | "incomplete"> {
  const fingerprint = await ethDependencies.accountFingerprint();
  if (fingerprint.status === "unavailable") return "incomplete";

  const scopes: Array<{
    historyKind: "orders" | "fills";
    status?: "resting" | "executed" | "canceled";
  }> = [
    { historyKind: "orders", status: "resting" },
    { historyKind: "orders", status: "executed" },
    { historyKind: "orders", status: "canceled" },
    { historyKind: "fills" },
  ];
  for (const { historyKind, status } of scopes) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const qs = new URLSearchParams({ limit: "100" });
      if (historyKind === "orders") {
        qs.set("ticker", order.ticker);
        qs.set("status", status!);
      }
      if (cursor) qs.set("cursor", cursor);
      let page: EthHistoryPage;
      try {
        page = await retryEthRead(
          `complete ETH ${historyKind} absence history`,
          () => ethDependencies.authFetch<EthHistoryPage>("GET", `/portfolio/${historyKind}?${qs}`),
        );
      } catch {
        return "incomplete";
      }
      const rows = page[historyKind];
      if (!Array.isArray(rows)) return "incomplete";
      for (const row of rows) {
        const ticker = row["ticker"] ?? row["market_ticker"];
        const clientOrderId = row["client_order_id"];
        if (ticker !== order.ticker) continue;
        if (clientOrderId === order.clientOrderId) return "conflicting";
        // With no local Kalshi order id, a fill on the exact market cannot be
        // attributed away from this ambiguous submission safely.
        if (historyKind === "fills") return "conflicting";
      }
      const next = page.cursor;
      if (next == null || next === "") break;
      if (typeof next !== "string" || seenCursors.has(next)) return "incomplete";
      seenCursors.add(next);
      cursor = next;
    }
  }
  return "absent";
}

/**
 * The only path that converts a submitted-but-unidentified ETH row to zero
 * fill. It reads uncached authenticated history to completion before asking the
 * store for its conditional, atomic release.
 */
async function resolveEthProvenPhantom(order: EthUnsettledOrder): Promise<EthPhantomResolution> {
  if (!isLocalPhantomCandidate(order)) return "conflicting";
  const absence = await hasCompleteEthHistoryAbsence(order);
  if (absence !== "absent") return absence;
  const released = await ethDependencies.store.resolveEthMartingaleProvenPhantom(order.id);
  if (!released) {
    scheduleEthDurableRetry("durable_store_failure", order);
    return "incomplete";
  }
  return "released";
}
