/**
 * Service C research-derived signal.
 *
 * Fire only when the immediately preceding adjacent ETH 15-minute outcomes end
 * in at least three NO settlements and the newly opening market's adjacent
 * floor-strike move lies in the rolling prior-28-day p95-to-p99 band.
 *
 * This module deliberately owns no martingale state and performs no I/O.
 */
export const ETH_REVERSAL_WAGER_CENTS = 50_000;
export const ETH_REVERSAL_SIDE = "yes" as const;
export const ETH_REVERSAL_ORDER_TAG = "eth-no3-reversal-v1";
export const ETH_REVERSAL_MIN_NO_STREAK = 3;

export interface EthNoStreakReversalInput {
  consecutiveNoOutcomes: number;
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
}

export interface EthNoStreakReversalDecision {
  fires: boolean;
  side: typeof ETH_REVERSAL_SIDE;
  wagerCents: typeof ETH_REVERSAL_WAGER_CENTS;
  reason: "signal" | "no_streak_too_short" | "thresholds_unavailable" | "below_p95" | "at_or_above_p99";
}

export function evaluateEthNoStreakReversal(input: EthNoStreakReversalInput): EthNoStreakReversalDecision {
  const base = { side: ETH_REVERSAL_SIDE, wagerCents: ETH_REVERSAL_WAGER_CENTS } as const;
  if (!Number.isInteger(input.consecutiveNoOutcomes) || input.consecutiveNoOutcomes < ETH_REVERSAL_MIN_NO_STREAK) {
    return { ...base, fires: false, reason: "no_streak_too_short" };
  }
  if (![input.currentMove, input.p95, input.p99].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return { ...base, fires: false, reason: "thresholds_unavailable" };
  }
  if (input.currentMove! < input.p95!) return { ...base, fires: false, reason: "below_p95" };
  if (input.currentMove! >= input.p99!) return { ...base, fires: false, reason: "at_or_above_p99" };
  return { ...base, fires: true, reason: "signal" };
}
