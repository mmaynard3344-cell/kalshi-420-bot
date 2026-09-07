/**
 * Service D research-derived signal: Breakout Reversal.
 *
 * Fire only when the immediately preceding adjacent ETH 15-minute outcomes end
 * in at least three NO settlements and the newly opening market's adjacent
 * floor-strike move lies in the UPPER HALF of the rolling prior-28-day p95-to-p99 band.
 *
 * Research result through 2026-08-25: 23/31 YES settlements (74.2%) for this
 * upper-half subset. This module owns no martingale state and performs no I/O.
 */
export const ETH_BREAKOUT_REVERSAL_WAGER_CENTS = 10_000;
export const ETH_BREAKOUT_REVERSAL_SIDE = "yes" as const;
export const ETH_BREAKOUT_REVERSAL_ORDER_TAG = "eth-no3-upperband-v1";
export const ETH_BREAKOUT_REVERSAL_MIN_NO_STREAK = 3;

export interface EthBreakoutReversalInput {
  consecutiveNoOutcomes: number;
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
}

export interface EthBreakoutReversalDecision {
  fires: boolean;
  side: typeof ETH_BREAKOUT_REVERSAL_SIDE;
  wagerCents: typeof ETH_BREAKOUT_REVERSAL_WAGER_CENTS;
  upperBandFloor: number | null;
  reason:
    | "signal"
    | "no_streak_too_short"
    | "thresholds_unavailable"
    | "invalid_threshold_band"
    | "below_upper_half"
    | "at_or_above_p99";
}

export function evaluateEthBreakoutReversal(input: EthBreakoutReversalInput): EthBreakoutReversalDecision {
  const base = { side: ETH_BREAKOUT_REVERSAL_SIDE, wagerCents: ETH_BREAKOUT_REVERSAL_WAGER_CENTS } as const;
  if (!Number.isInteger(input.consecutiveNoOutcomes) || input.consecutiveNoOutcomes < ETH_BREAKOUT_REVERSAL_MIN_NO_STREAK) {
    return { ...base, fires: false, upperBandFloor: null, reason: "no_streak_too_short" };
  }
  if (![input.currentMove, input.p95, input.p99].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return { ...base, fires: false, upperBandFloor: null, reason: "thresholds_unavailable" };
  }
  if (!(input.p99! > input.p95!)) {
    return { ...base, fires: false, upperBandFloor: null, reason: "invalid_threshold_band" };
  }
  const upperBandFloor = input.p95! + (input.p99! - input.p95!) / 2;
  if (input.currentMove! < upperBandFloor) {
    return { ...base, fires: false, upperBandFloor, reason: "below_upper_half" };
  }
  if (input.currentMove! >= input.p99!) {
    return { ...base, fires: false, upperBandFloor, reason: "at_or_above_p99" };
  }
  return { ...base, fires: true, upperBandFloor, reason: "signal" };
}
