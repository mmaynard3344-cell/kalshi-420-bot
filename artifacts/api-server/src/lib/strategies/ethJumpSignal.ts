/**
 * Service B signal contract: the statistical jump is independent of martingale
 * ladder state. It answers only whether the current adjacent floor-strike move
 * is inside the rolling p95-to-p99 band.
 */
export interface EthJumpSignalInput {
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
}

export interface EthJumpSignalDecision {
  fires: boolean;
  band: "unavailable" | "below_p95" | "p95_to_p99" | "at_or_above_p99";
}

export function evaluateEthJumpSignal(input: EthJumpSignalInput): EthJumpSignalDecision {
  const { currentMove, p95, p99 } = input;
  if (![currentMove, p95, p99].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return { fires: false, band: "unavailable" };
  }
  if (currentMove! < p95!) return { fires: false, band: "below_p95" };
  if (currentMove! >= p99!) return { fires: false, band: "at_or_above_p99" };
  return { fires: true, band: "p95_to_p99" };
}

/** Service B owns a fixed big-bet amount; it never derives size from a ladder. */
export const ETH_JUMP_WAGER_CENTS = 42_000;
export const ETH_JUMP_ORDER_TAG = "eth-jump-v1";
