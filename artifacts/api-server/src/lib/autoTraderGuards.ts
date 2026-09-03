/**
 * autoTraderGuards.ts — pure guard logic and shared in-process state for the
 * auto-trader.
 *
 * This module intentionally has NO imports from logger, kalshi, kalshiAuth,
 * kalshiStream, or routes/trade. Keeping it pino-free lets it be bundled by
 * esbuild's ESM test runner (pino uses dynamic require() which esbuild cannot
 * bundle in ESM mode).
 *
 * autoTrader.ts imports everything it needs from here.
 * autoTraderGuards.test.ts also imports from here directly (no pino pollution).
 */

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  ⚠️  OWNER-LOCKED STRATEGY CONSTANTS — DO NOT CHANGE WITHOUT APPROVAL  ⚠️   ║
// ╠═══════════════════════════════════════════════════════════════════════════╣
// ║  The following values define the LIVE trading strategy and are locked by  ║
// ║  the project owner:                                                       ║
// ║                                                                           ║
// ║    TIME_ALERT_SECONDS   = 120   (entry window: last 2:00 before close)    ║
// ║    ALERT_MIN            = 90    (entry-zone floor, ¢)                     ║
// ║    ALERT_MAX            = 95    (entry-zone ceiling, ¢)                   ║
// ║    PRICE_FLOOR_CENTS    = 90    (hard guard floor, ¢)                     ║
// ║    PRICE_CAP_CENTS      = 95    (hard guard cap, ¢)                       ║
// ║    BTC_BET_DOLLARS      = 1     (BTC per-window cash-outlay cap)           ║
// ║    BTC_ENTRY            = 90–95 (BTC executable entry band, ¢)            ║
// ║    ETH_BET_DOLLARS      = 1     (ETH per-window cash-outlay cap)           ║
// ║    ETH_ENTRY_FLOOR_CENTS = 90   (ETH entry floor, ¢)                       ║
// ║                                                                           ║
// ║  ANY change — including "fixing" an apparent drift between two files —    ║
// ║  requires: (1) explicit approval from the project owner in the chat,      ║
// ║  (2) a STRATEGY_VERSION bump in src/strategy/decide.ts, and (3) updating  ║
// ║  the mirrored literals in src/routes/restingOrderSim.ts and               ║
// ║  src/lib/passiveObserver.ts.                                              ║
// ║                                                                           ║
// ║  History: a task agent once resolved a 120-vs-180 drift in the WRONG      ║
// ║  direction and shipped a live strategy change (entry window widened 50%)  ║
// ║  disguised as a test fix. If two files disagree, the values in THIS file  ║
// ║  are canonical — but do not "fix" the other file without owner approval;  ║
// ║  ask the owner which value is intended.                                   ║
// ║                                                                           ║
// ║  src/lib/strategyConstants.sync.test.ts (run by `pnpm test` and the       ║
// ║  strategy-constants validation) fails if the mirrors drift.               ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ── Evaluation time-window constant ───────────────────────────────────────────
//
// The bot only evaluates (and may place orders) during the final
// TIME_ALERT_SECONDS of each 15-minute market window.
// This constant is shared across ALL series (BTC and ETH use the same threshold).
// Exported here (pino-free module) so tests can assert against it directly.

export const TIME_ALERT_SECONDS = 120; // evaluate in the last 2:00 before close — owner-approved 2026-08-03

// ── Hard price guard constants ─────────────────────────────────────────────────
//
// Absolute outer limits: the bot will NEVER submit an order if the outcome-side
// price is outside [PRICE_FLOOR_CENTS, PRICE_CAP_CENTS].
//
// For YES orders: validated against the YES purchase price.
// For NO  orders: validated against the NO  purchase price — NOT the complementary
//                 YES wire price (100 − noPrice). The book-side translation only
//                 happens when building the Kalshi API body, AFTER this check.

export const PRICE_FLOOR_CENTS = 90;  // inclusive lower bound (¢) — OWNER-LOCKED
export const PRICE_CAP_CENTS   = 95;  // inclusive upper bound (¢) — OWNER-LOCKED

// ── Entry-zone constants (canonical) ──────────────────────────────────────────
//
// OWNER-LOCKED. Canonical home of the entry zone; preflightGate.ts re-exports
// these so existing `import { ALERT_MIN } from "./preflightGate.js"` call
// sites keep working.

/** Inclusive entry-zone floor (¢). BBO-derived ask must be ≥ this to trigger. OWNER-LOCKED. */
export const ALERT_MIN = 90;

/** Inclusive entry-zone ceiling (¢). BBO-derived ask must be ≤ this to trigger. OWNER-LOCKED. */
export const ALERT_MAX = 95;

/**
 * The tracked automated series.  Keep this union narrow so an unknown prefix
 * cannot accidentally inherit a permissive entry policy.
 */
export type TrackedSeries = "KXBTC15M" | "KXETH15M";

/** BTC per-window cash-outlay cap. OWNER-APPROVED. */
export const BTC_BET_DOLLARS = 1;

/** BTC may enter only at an outcome-side executable price of 90–95¢ inclusive. */
export const BTC_ENTRY_FLOOR_CENTS = 90;
export const BTC_ENTRY_CAP_CENTS = 95;

/** ETH per-window cash-outlay cap. OWNER-APPROVED. */
export const ETH_BET_DOLLARS = 1;

/** ETH may enter only at an outcome-side executable price of 90–95¢ inclusive. */
export const ETH_ENTRY_FLOOR_CENTS = 90;
export const ETH_ENTRY_CAP_CENTS = PRICE_CAP_CENTS;

export const SERIES_ENTRY_POLICY: Record<TrackedSeries, {
  betDollars: number;
  entryFloorCents: number;
  entryCapCents: number;
}> = {
  KXBTC15M: {
    betDollars: BTC_BET_DOLLARS,
    entryFloorCents: BTC_ENTRY_FLOOR_CENTS,
    entryCapCents: BTC_ENTRY_CAP_CENTS,
  },
  KXETH15M: {
    betDollars: ETH_BET_DOLLARS,
    entryFloorCents: ETH_ENTRY_FLOOR_CENTS,
    entryCapCents: ETH_ENTRY_CAP_CENTS,
  },
};

export function isTrackedSeries(series: string): series is TrackedSeries {
  return series === "KXBTC15M" || series === "KXETH15M";
}

/** Returns true only when price satisfies both global and per-series entry bands. */
export function isEntryPriceInBandForSeries(series: string, priceCents: number): boolean {
  if (!isTrackedSeries(series)) return false;
  const policy = SERIES_ENTRY_POLICY[series];
  return isPriceInBand(priceCents) &&
    priceCents >= policy.entryFloorCents &&
    priceCents <= policy.entryCapCents;
}

/** Human-readable per-series entry band for audit logs and telemetry. */
export function entryPriceBandForSeries(series: string): string {
  if (!isTrackedSeries(series)) return "untracked";
  const policy = SERIES_ENTRY_POLICY[series];
  return `${policy.entryFloorCents}¢–${policy.entryCapCents}¢`;
}

// ── Canonical price tiers ──────────────────────────────────────────────────────
//
// Single source of truth for tier boundaries used by:
//   - passiveObserver.ts  (hypotheticalTier field on recorded observations)
//   - GET /api/trade/tiers  (served to the browser for Portfolio tier stats)
//   - Portfolio.tsx  (fetches from the endpoint rather than hardcoding)
//
// Adding or renaming a tier here propagates everywhere automatically.

export interface PriceTier {
   /** Human-readable label, e.g. "80–89¢" */
  label: string;
  /** Inclusive lower bound in cents */
  min: number;
  /** Inclusive upper bound in cents */
  max: number;
}

/**
 * Canonical tier list, ordered highest-to-lowest (matching display order in
 * the Portfolio breakdown table).  Boundaries must be contiguous and must
 * collectively cover the active executable entry band.
 */
export const PRICE_TIERS: PriceTier[] = [
  { label: '90–95¢', min: 90, max: PRICE_CAP_CENTS   },
];

/**
 * Deterministic version tag derived from PRICE_TIERS.
 *
 * Recomputed at module load time so it always reflects the actual tier array.
 * Any change to a tier label, min, or max produces a different string.
 *
 * Usage:
 *   - Returned by GET /api/trade/tiers as { tiers, version }
 *   - Clients SHOULD include it as tier_version in POST /trade/order bodies
 *   - The POST handler rejects orders with a mismatched tier_version (409)
 *     so a client with stale tier definitions cannot silently cause a
 *     double-buy or mis-sized order.
 *
 * Format: "tier:<label>:<min>-<max>" entries joined by "|"
 * Example: "tier:90–95¢:90-95"
 */
export const PRICE_TIERS_VERSION: string = PRICE_TIERS
  .map((t) => `tier:${t.label}:${t.min}-${t.max}`)
  .join("|");

/**
 * Maps an outcome-side price (in cents) to its canonical tier label.
 * Returns "other" for prices outside all defined tiers.
 */
export function tierLabel(price: number): string {
  for (const tier of PRICE_TIERS) {
    if (price >= tier.min && price <= tier.max) return tier.label;
  }
  return "other";
}

/**
 * Builds the SQL CASE expression used by getVerifiedPnlByTier to map
 * `trigger_price_cents` (or any supplied column name) to a tier label.
 *
 * This is the SINGLE source of truth for the SQL-side boundary logic.
 * getVerifiedPnlByTier in tradeStore.ts calls this function instead of
 * hand-writing the CASE string, so any change to PRICE_TIERS propagates
 * to both the observation tier stamp (tierLabel) and the P&L SQL query
 * automatically and testably.
 *
 * Example output for PRICE_TIERS = [{ label: '90–95¢', min: 90, max: 95 }]:
 *   "CASE WHEN trigger_price_cents >= 90 AND trigger_price_cents <= 95 THEN '90–95¢' ELSE 'other' END"
 *
 * @param column SQL column name to evaluate (default: "trigger_price_cents")
 */
export function buildTierSqlCaseString(column = "trigger_price_cents"): string {
  const caseWhen = PRICE_TIERS
    .map((t) => `WHEN ${column} >= ${t.min} AND ${column} <= ${t.max} THEN '${t.label}'`)
    .join(" ");
  return `CASE ${caseWhen} ELSE 'other' END`;
}

/**
 * Returns true when `priceCents` is within the allowed outcome-side trading band.
 *
 * Exported so tests can verify the guard in isolation without mocking any I/O.
 *
 * Examples:
 *   isPriceInBand(35) → false   (below floor — the reported failure case)
 *   isPriceInBand(88) → false   (below floor)
 *   isPriceInBand(89) → false   (below floor)
 *   isPriceInBand(90) → true    (floor, inclusive)
 *   isPriceInBand(95) → true    (cap, inclusive)
 *   isPriceInBand(96) → false   (above cap)
 */
export function isPriceInBand(priceCents: number): boolean {
  return priceCents >= PRICE_FLOOR_CENTS && priceCents <= PRICE_CAP_CENTS;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * How many whole contracts can be bought at `priceCents` with `dollars`.
 * Returns 0 when price is at the boundaries (0 or 100) to guard against
 * divide-by-zero or near-zero prices.
 */
export function contractsForPrice(priceCents: number, dollars: number): number {
  if (priceCents <= 0 || priceCents >= 100) return 0;
  return Math.floor(dollars / (priceCents / 100));
}

// ── Shared in-process state ────────────────────────────────────────────────────
//
// These Maps/Sets are module singletons used by autoTrader.ts.
// They live here (not in autoTrader.ts) so they can be inspected and reset
// by tests without pulling in any I/O dependencies.

/** Per-window spend tracker: ticker → dollars already filled (actuals, not limit). */
export const spendTracker = new Map<string, number>();

/**
 * In-flight notional tracker: ticker → cents committed to a Kalshi API call
 * currently in transit. Counted against the window budget so concurrent
 * evaluate() ticks cannot double-book the same budget before the response arrives.
 */
export const pendingNotionalByTicker = new Map<string, number>();

/**
 * Per-ticker pre-flight lock.  Set SYNCHRONOUSLY (before the first await) at
 * the top of checkAndPlace.  Prevents two concurrent evaluate() calls from
 * both starting an L2 fetch for the same ticker.
 *
 * Lock key: ticker only (not ticker+side) — same reasoning as submissionInFlight:
 * the position guard already prevents YES+NO orders on the same ticker.
 *
 * Scope: covers the ENTIRE checkAndPlace execution (L2 fetch + gate decision +
 * placeOrder call), cleared in a finally block.  submissionInFlight is an inner
 * lock acquired AFTER SQL pre-commit inside placeOrder; it is kept for
 * defense-in-depth and for callers that bypass checkAndPlace (tests, etc.).
 */
export const preflightInFlight = new Set<string>();

/**
 * Per-ticker in-flight lock. Held for the duration of a Kalshi API call.
 * Prevents overlapping order submissions for the same ticker from near-
 * simultaneous WS ticks, regardless of side.
 */
export const submissionInFlight = new Set<string>();

/**
 * Maps each in-flight ticker to its clientOrderId for the current submission.
 *
 * Populated when submissionInFlight.add(ticker) is called inside placeOrder.
 * Cleared in placeOrder's finally block alongside submissionInFlight.delete().
 *
 * Used by the SIGTERM handler to log each interrupted submission's full
 * correlation ID so post-incident SQL queries can find and reconcile the
 * order_attempts row left in "pending" state.
 */
export const submissionOrderIds = new Map<string, string>();

/** Per-key cooldown: last time an order was attempted for `${ticker}-${SIDE}`. */
export const orderCooldown = new Map<string, number>();

// ── Zero-fill suppression cache ───────────────────────────────────────────────
//
// When a live IOC order expires without any fill, the next REST-fallback tick
// (every 5 seconds) would otherwise re-submit the identical order and get the
// same zero-fill again.  This cache suppresses identical retries by recording
// the full quote snapshot at the time of the zero-fill.
//
// Key: `${ticker}-${SIDE}` (e.g. "KXBTC15M-26JUL300930-30-NO")
// Value: the 5-field snapshot present at the time of the zero-fill.
//
// Suppression is lifted when:
//   - Any field in the snapshot changes (new prices → new order opportunity)
//   - The IOC succeeds (full or partial fill clears the entry)
//   - The window rolls over (handleWindowRollover clears by ticker prefix)
//
// Design note: this replaced a former BBO-derived executability pre-check that
// blocked IOC submissions when noAsk === 100 − yesBid on the assumption that
// equality meant no real NO-side depth.  Live evidence on 2026-07-30 13:28 UTC
// (KXBTC15M and KXETH15M -26JUL300930-30) showed both orders fully filling at
// exactly that spread — proving the assumption is wrong.  The corrected policy:
// always allow the first IOC; suppress retries only after a confirmed zero-fill
// on the identical 5-field snapshot.

export interface ZeroFillSnapshot {
  limitCents: number;
  yesAsk:     number | null;
  noAsk:      number | null;
  yesBid:     number | null;
  noBid:      number | null;
  /** Epoch ms when this entry was written; used to expire after ZERO_FILL_SUPPRESS_TTL_MS. */
  cachedAt:   number;
  /**
   * Why this entry was seeded:
   *   "zero_fill"      — a real IOC order was POSTed to Kalshi and filled 0 contracts.
   *   "preflight_skip" — the L2 pre-flight gate returned a non-submit decision;
   *                      NO order was ever sent to Kalshi.
   * Distinguishes the suppression log/guard-outcome so preflight skips are never
   * mistaken for real zero-fill orders. Absent (legacy entries) → treated as "zero_fill".
   */
  origin?:    "zero_fill" | "preflight_skip";
}

/**
 * How long (ms) to wait before retrying after a zero-fill on an identical BBO
 * snapshot. The first 30 s after a zero-fill the entry is considered "fresh"
 * and the tick is suppressed. After 5 s the next retry is allowed, and the
 * cycle repeats until the window closes or a fill is recorded.
 */
export const ZERO_FILL_RETRY_DELAY_MS = 5_000;

/**
 * @deprecated Use ZERO_FILL_RETRY_DELAY_MS.
 * Kept as an alias so existing test or log references don't break during
 * the migration period.
 */
export const ZERO_FILL_SUPPRESS_TTL_MS = ZERO_FILL_RETRY_DELAY_MS;

/**
 * Maximum number of thin-book zero-fill retries allowed per ticker+side per
 * window. Set to Infinity so retries continue every ZERO_FILL_RETRY_DELAY_MS
 * until the window closes or a fill is recorded.
 */
export const MAX_ZERO_FILL_RETRIES = Infinity;

export const zeroFillSuppressionCache = new Map<string, ZeroFillSnapshot>();

/**
 * Per-window retry counter for thin-book zero-fills.
 *
 * Key: `${ticker}-${SIDE}` (same as zeroFillSuppressionCache).
 * Value: number of retry attempts already made this window.
 *
 * Incremented each time the 5 s TTL expires and a retry is allowed.
 * Cleared when the window rolls over (handleWindowRollover clears by prefix).
 */
export const zeroFillRetryCount = new Map<string, number>();

// ── Zero-fill retry poll scheduler ──────────────────────────────────────────
//
// Guarantees a REST-driven evaluation tick fires within 32 s of every
// zero-fill, closing the tail-of-window gap where neither passive trigger is
// guaranteed to arrive in time:
//   • the 45 s reconcile interval exceeds the 30 s retry delay (and can be
//     skipped entirely by the stream-refresh guard window, worst case 90 s),
//   • the 5 s fallback poller only fires after the WS has been stale for
//     30 s — for a zero-fill at T−40 s that means the first fallback fetch
//     lands at ~T−5 s, after the retry-eligible moment at T−10 s.
// A one-shot timer armed at zero-fill time removes both dependencies.

/**
 * Margin added to ZERO_FILL_RETRY_DELAY_MS so the poll lands strictly AFTER
 * the suppression entry has expired (avoids ms-level jitter re-suppressing
 * the tick). Total delay must stay ≤ 32 s per the tail-of-window requirement.
 */
export const ZERO_FILL_RETRY_POLL_MARGIN_MS = 1_500;

/** One-shot poll timers keyed by `${ticker}-${SIDE}`. */
export const zeroFillRetryPollTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Arm (or re-arm) the one-shot retry poll for a ticker+side. `pollFn` runs
 * once, ZERO_FILL_RETRY_DELAY_MS + ZERO_FILL_RETRY_POLL_MARGIN_MS after the
 * zero-fill. Re-arming replaces any pending timer for the same key so at most
 * one poll is outstanding per ticker+side.
 */
export function scheduleZeroFillRetryPoll(
  ticker:  string,
  side:    "yes" | "no",
  pollFn:  () => void,
  delayMs: number = ZERO_FILL_RETRY_DELAY_MS + ZERO_FILL_RETRY_POLL_MARGIN_MS,
): void {
  const key = `${ticker}-${side.toUpperCase()}`;
  const existing = zeroFillRetryPollTimers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => {
    zeroFillRetryPollTimers.delete(key);
    pollFn();
  }, delayMs);
  // Never keep the process alive just for a retry poll.
  (t as { unref?: () => void }).unref?.();
  zeroFillRetryPollTimers.set(key, t);
}

/**
 * Cancel all pending retry polls whose key starts with `tickerPrefix`.
 * Called on window rollover so a poll armed in the old window never fires
 * a REST fetch for a closed market.
 */
export function cancelZeroFillRetryPolls(tickerPrefix: string): void {
  for (const [k, t] of zeroFillRetryPollTimers) {
    if (k.startsWith(tickerPrefix)) {
      clearTimeout(t);
      zeroFillRetryPollTimers.delete(k);
    }
  }
}

// ── Testing helpers ────────────────────────────────────────────────────────────
// Prefixed with _ to signal they are not part of the production API.
// autoTrader.ts re-exports these so callers need only one import path.

/**
 * Run an async function while holding the pre-flight lock for a ticker.
 *
 * Returns `{ blocked: true, reason }` if either `preflightInFlight` or
 * `submissionInFlight` is already held for the ticker; the lock is NOT
 * acquired and fn() is NOT called.  The caller is responsible for logging
 * and recording the guard outcome.
 *
 * Returns `{ blocked: false, result }` if the lock was acquired, fn() ran to
 * completion or threw, and the lock was released in the finally block.  If
 * fn() throws, the error propagates out of runWithPreflightLock normally —
 * the lock is still released.
 *
 * This is the single implementation of the pre-flight lock pattern shared
 * between production (autoTrader.ts checkAndPlace) and the concurrency test
 * suite.  Tests call it directly with injectable mock callbacks — they do not
 * re-implement or imitate the lock logic.
 *
 * Lock ordering:
 *   preflightInFlight  — outer lock; held for the entire checkAndPlace call
 *                        (L2 fetch + gate decision + placeOrder HTTP call).
 *   submissionInFlight — inner lock; acquired INSIDE placeOrder (after SQL
 *                        pre-commit, before the Kalshi HTTP request).
 *   Checking both here prevents a new evaluate() tick from starting an L2
 *   fetch for a ticker whose submission is still awaiting a Kalshi response.
 */
export async function runWithPreflightLock<T>(
  ticker: string,
  fn:     () => Promise<T>,
): Promise<
  | { blocked: true;  reason: "preflight_in_flight" | "submission_in_flight" }
  | { blocked: false; result: T }
> {
  // Both checks and the .add() must be synchronous — no await before here —
  // so they are atomic within a single event-loop turn.
  if (preflightInFlight.has(ticker)) {
    return { blocked: true, reason: "preflight_in_flight" };
  }
  if (submissionInFlight.has(ticker)) {
    return { blocked: true, reason: "submission_in_flight" };
  }
  preflightInFlight.add(ticker);
  try {
    return { blocked: false, result: await fn() };
  } finally {
    preflightInFlight.delete(ticker);
  }
}

/** Reset ALL in-process auto-trader state. Call in beforeEach() for isolated tests. */
export function _resetAutoTraderStateForTesting(): void {
  spendTracker.clear();
  pendingNotionalByTicker.clear();
  preflightInFlight.clear();
  submissionInFlight.clear();
  submissionOrderIds.clear();
  orderCooldown.clear();
  zeroFillSuppressionCache.clear();
  zeroFillRetryCount.clear();
  for (const t of zeroFillRetryPollTimers.values()) clearTimeout(t);
  zeroFillRetryPollTimers.clear();
}

/** Returns the cached zero-fill snapshot for a ticker+side key, or undefined. */
export function _getZeroFillSuppressionForTesting(
  ticker: string,
  side:   "yes" | "no",
): ZeroFillSnapshot | undefined {
  return zeroFillSuppressionCache.get(`${ticker}-${side.toUpperCase()}`);
}

/** Manually inject a zero-fill suppression entry (for suppression tests). */
export function _setZeroFillSuppressionForTesting(
  ticker:   string,
  side:     "yes" | "no",
  snapshot: ZeroFillSnapshot,
): void {
  zeroFillSuppressionCache.set(`${ticker}-${side.toUpperCase()}`, snapshot);
}

/** Returns the number of thin-book retries used so far for a ticker+side this window. */
export function _getZeroFillRetryCountForTesting(
  ticker: string,
  side:   "yes" | "no",
): number {
  return zeroFillRetryCount.get(`${ticker}-${side.toUpperCase()}`) ?? 0;
}

/** Manually set the retry counter for a ticker+side (for retry-budget tests). */
export function _setZeroFillRetryCountForTesting(
  ticker: string,
  side:   "yes" | "no",
  count:  number,
): void {
  if (count <= 0) {
    zeroFillRetryCount.delete(`${ticker}-${side.toUpperCase()}`);
  } else {
    zeroFillRetryCount.set(`${ticker}-${side.toUpperCase()}`, count);
  }
}

/** Returns true if the pre-flight gate is currently locked for this ticker. */
export function _isPreflightInFlightForTesting(ticker: string): boolean {
  return preflightInFlight.has(ticker);
}

/** Manually set the preflight lock for a ticker (simulates a concurrent evaluation in tests). */
export function _forcePreflightInFlightForTesting(ticker: string): void {
  preflightInFlight.add(ticker);
}

/** Release the preflight lock for a ticker (cleanup after _forcePreflightInFlightForTesting). */
export function _clearPreflightInFlightForTesting(ticker: string): void {
  preflightInFlight.delete(ticker);
}

/** Returns true if a Kalshi submission is currently in-flight for this ticker. */
export function _isSubmissionInFlightForTesting(ticker: string): boolean {
  return submissionInFlight.has(ticker);
}

/** Manually mark a ticker as having a submission in-flight (for guard tests). */
export function _forceSubmissionInFlightForTesting(ticker: string): void {
  submissionInFlight.add(ticker);
}

/** Returns pending notional cents for a ticker (in-flight, not yet filled). */
export function _getPendingNotionalForTesting(ticker: string): number {
  return pendingNotionalByTicker.get(ticker) ?? 0;
}

/** Manually set pending notional for a ticker (for budget-guard tests). */
export function _setPendingNotionalForTesting(ticker: string, cents: number): void {
  if (cents <= 0) {
    pendingNotionalByTicker.delete(ticker);
  } else {
    pendingNotionalByTicker.set(ticker, cents);
  }
}

/** Returns the window spend (filled actuals) for a ticker, in dollars. */
export function _getSpendTrackerForTesting(ticker: string): number {
  return spendTracker.get(ticker) ?? 0;
}

/** Manually set the window spend for a ticker, in dollars (for budget-guard tests). */
export function _setSpendTrackerForTesting(ticker: string, dollars: number): void {
  if (dollars <= 0) {
    spendTracker.delete(ticker);
  } else {
    spendTracker.set(ticker, dollars);
  }
}

/** Returns the clientOrderId currently mapped for an in-flight ticker (undefined if none). */
export function _getSubmissionOrderIdForTesting(ticker: string): string | undefined {
  return submissionOrderIds.get(ticker);
}

/** Manually register a ticker → clientOrderId mapping (for SIGTERM handler tests). */
export function _setSubmissionOrderIdForTesting(ticker: string, clientOrderId: string): void {
  submissionOrderIds.set(ticker, clientOrderId);
}

/**
 * Compute remaining budget for a ticker given current filled spend + pending
 * notional. Returns { remainingDollars, count } so tests can verify the budget
 * guard without mocking any of placeOrder's I/O dependencies.
 */
export function _computeRemainingBudgetForTesting(
  ticker:            string,
  betDollars:        number,
  outcomePriceCents: number,
): { remainingDollars: number; count: number } {
  const alreadySpent    = spendTracker.get(ticker) ?? 0;
  const pendingCents    = pendingNotionalByTicker.get(ticker) ?? 0;
  const totalCommitted  = alreadySpent + pendingCents / 100;
  const remainingDollars = Math.max(0, betDollars - totalCommitted);
  const count = contractsForPrice(outcomePriceCents, remainingDollars);
  return { remainingDollars, count };
}
