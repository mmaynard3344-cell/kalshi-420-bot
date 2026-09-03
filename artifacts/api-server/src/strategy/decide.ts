/**
 * Pure strategy decision function — no I/O, no side effects.
 *
 * This module contains the signal logic only: time gate, price zone check,
 * derived-ask calculation, and limit price construction.
 *
 * It does NOT apply any guard logic (cooldown, dedup, budget, position).
 * Guards live in simulator.ts (replay) and placeOrder() (live).
 *
 * IMPORTANT: The constants below must stay in sync with autoTrader.ts.
 * When you change a constant:
 *   1. Update it here AND in autoTrader.ts.
 *   2. Bump STRATEGY_VERSION.
 *   3. Re-run tests to verify decide() and evaluate() produce the same signals.
 */

import type { StrategyInput, StrategyDecision, SkipDecision, TradeDecision, StrategySignal } from "./types.js";
// Single source of truth — import production constants so replay always mirrors live.
// OWNER-LOCKED: strategy constants are canonically defined in
// src/lib/autoTraderGuards.ts (see the owner-lock banner there). Any change
// requires explicit owner approval and a STRATEGY_VERSION bump below.
import { LIMIT_PRICE_BUFFER_CENTS } from "../lib/preflightGate.js";
import {
  ALERT_MIN,
  ALERT_MAX,
  TIME_ALERT_SECONDS,
  BTC_BET_DOLLARS,
  BTC_ENTRY_FLOOR_CENTS,
  BTC_ENTRY_CAP_CENTS,
  ETH_BET_DOLLARS,
  ETH_ENTRY_FLOOR_CENTS,
  ETH_ENTRY_CAP_CENTS,
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  SERIES_ENTRY_POLICY,
  isEntryPriceInBandForSeries,
} from "../lib/autoTraderGuards.js";

// Re-export so callers that do `import { ALERT_MIN } from "./decide.js"` keep working.
export { ALERT_MIN, ALERT_MAX, TIME_ALERT_SECONDS, LIMIT_PRICE_BUFFER_CENTS };

/**
 * Semantic version of this strategy.
 *
 * Bump the patch when you fix a bug without changing signal logic.
 * Bump the minor when you change constants (ALERT_MIN/MAX, TIME_ALERT_SECONDS, buffer).
 * Bump the major when you change the fundamental decision structure.
 *
 * Every replay result file stores this version verbatim so you can always
 * know which rules produced a given historical replay.
 *
 * OWNER-LOCKED: changing any strategy constant requires explicit owner
 * approval AND a bump of this version. Never change one without the other.
 */
export const STRATEGY_VERSION = "1.19.0";

/**
 * Exported snapshot of all constants — stored in every replay result.
 *
 * Includes the owner-locked sizing/guard constants (BTC/ETH cash-outlay caps,
 * PRICE_FLOOR_CENTS, PRICE_CAP_CENTS) so any change to them without a
 * STRATEGY_VERSION bump fails the version-snapshot test in
 * src/lib/strategyConstants.sync.test.ts, and replay files are never
 * ambiguous about which bet size / price band produced them.
 */
export const STRATEGY_CONFIG = {
  ALERT_MIN,
  ALERT_MAX,
  TIME_ALERT_SECONDS,
  LIMIT_PRICE_BUFFER_CENTS,
  BTC_BET_DOLLARS,
  BTC_ENTRY_FLOOR_CENTS,
  BTC_ENTRY_CAP_CENTS,
  ETH_BET_DOLLARS,
  ETH_ENTRY_FLOOR_CENTS,
  ETH_ENTRY_CAP_CENTS,
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
} as const;

export type StrategyConfigSnapshot = typeof STRATEGY_CONFIG;

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Seconds remaining until closeTime, floored at 0.
 * Returns null when closeTime is not a valid ISO string.
 * Uses the injected nowMs rather than Date.now() for testability.
 */
export function secondsUntilClose(closeTime: string, nowMs: number): number | null {
  const close = new Date(closeTime).getTime();
  if (isNaN(close)) return null;
  return Math.max(0, Math.floor((close - nowMs) / 1000));
}

/**
 * Calculate whole contracts affordable at `priceCents` with `dollars` budget.
 *   contracts = floor(dollars / (priceCents / 100))
 *
 * `priceCents` is always the **submitted limit price** derived from the live BBO
 * ask at decision time — never the signal/trigger price. Actual fills may execute
 * at a better (lower) price if the order is absorbed across multiple L2 levels.
 * The contract count is fixed at submission time and does not change regardless
 * of fill price improvement. Returns 0 when priceCents ≤ 0 or ≥ 100.
 */
export function contractsForPrice(priceCents: number, dollars: number): number {
  if (priceCents <= 0 || priceCents >= 100) return 0;
  return Math.floor(dollars / (priceCents / 100));
}

// ── Decision function ─────────────────────────────────────────────────────────

/**
 * Pure strategy decision function.
 *
 * Returns an array of zero, one, or two StrategyDecisions:
 *   • [] is not returned — at minimum one SkipDecision is always returned.
 *   • [SkipDecision] when outside the time window, no close time, or no zone hit.
 *   • [TradeDecision] when one side is in zone.
 *   • [TradeDecision, TradeDecision] when both sides are simultaneously in zone.
 *
 * Mirrors the evaluate() logic in autoTrader.ts:
 *   yesDerivedAsk = 100 − noBid   (what you'd pay for YES = what NO holders bid)
 *   noDerivedAsk  = 100 − yesBid  (what you'd pay for NO = what YES holders bid)
 */
export function decide(input: StrategyInput): StrategyDecision[] {
  const { closeTime, yesBid, noBid, betDollars, nowMs } = input;
  const entryCapCents = input.series === "KXBTC15M"
    ? SERIES_ENTRY_POLICY.KXBTC15M.entryCapCents
    : input.series === "KXETH15M"
      ? SERIES_ENTRY_POLICY.KXETH15M.entryCapCents
      : ALERT_MAX;

  // Time gate ─────────────────────────────────────────────────────────────────
  if (!closeTime) {
    return [skip("no_close_time")];
  }

  const secondsLeft = secondsUntilClose(closeTime, nowMs);
  if (secondsLeft === null || secondsLeft <= 0 || secondsLeft > TIME_ALERT_SECONDS) {
    return [skip("outside_time_window", null, null, secondsLeft ?? null)];
  }

  // Derived asks ───────────────────────────────────────────────────────────────
  const yesDerivedAsk = noBid  != null ? 100 - noBid  : null;
  const noDerivedAsk  = yesBid != null ? 100 - yesBid : null;

  const results: StrategyDecision[] = [];

  // YES trigger ────────────────────────────────────────────────────────────────
  if (yesDerivedAsk != null && isEntryPriceInBandForSeries(input.series, yesDerivedAsk)) {
    const limitCents = Math.min(yesDerivedAsk + LIMIT_PRICE_BUFFER_CENTS, entryCapCents, ALERT_MAX, 99);
    const maxCount   = contractsForPrice(limitCents, betDollars);
    const signal: StrategySignal = { side: "yes", triggerCents: yesDerivedAsk, limitCents, maxCount };
    const d: TradeDecision = { action: "buy_yes", signal, betDollars, yesDerivedAsk, noDerivedAsk, secondsLeft };
    results.push(d);
  }

  // NO trigger ─────────────────────────────────────────────────────────────────
  if (noDerivedAsk != null && isEntryPriceInBandForSeries(input.series, noDerivedAsk)) {
    const limitCents = Math.min(noDerivedAsk + LIMIT_PRICE_BUFFER_CENTS, entryCapCents, ALERT_MAX, 99);
    const maxCount   = contractsForPrice(limitCents, betDollars);
    const signal: StrategySignal = { side: "no", triggerCents: noDerivedAsk, limitCents, maxCount };
    const d: TradeDecision = { action: "buy_no", signal, betDollars, yesDerivedAsk, noDerivedAsk, secondsLeft };
    results.push(d);
  }

  if (results.length === 0) {
    return [skip("outside_price_zone", yesDerivedAsk, noDerivedAsk, secondsLeft)];
  }

  return results;
}

// ── Internal helper ───────────────────────────────────────────────────────────

function skip(
  reason:        string,
  yesDerivedAsk: number | null = null,
  noDerivedAsk:  number | null = null,
  secondsLeft:   number | null = null,
): SkipDecision {
  return { action: "skip", skipReason: reason, yesDerivedAsk, noDerivedAsk, secondsLeft };
}

