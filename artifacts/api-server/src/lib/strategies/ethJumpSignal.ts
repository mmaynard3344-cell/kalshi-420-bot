/**
 * Service B signal contract: the statistical jump is independent of martingale
 * order lifecycle and sizing, but preserves the proven historical behavior of
 * using Service A's current carried side as a read-only input.
 *
 * B never advances, resets, or settles A's sequence. A remains the sole owner
 * of martingale state; B only snapshots the side at the qualifying market.
 */
export interface EthJumpSignalInput {
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
  carriedSide?: "yes" | "no" | null;
}

export interface EthJumpSignalDecision {
  fires: boolean;
  band: "unavailable" | "below_p95" | "p95_to_p99" | "at_or_above_p99";
  side?: "yes" | "no";
}

export function evaluateEthJumpSignal(input: EthJumpSignalInput): EthJumpSignalDecision {
  const { currentMove, p95, p99 } = input;
  if (![currentMove, p95, p99].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return { fires: false, band: "unavailable" };
  }
  if (currentMove! < p95!) return { fires: false, band: "below_p95" };
  if (currentMove! >= p99!) return { fires: false, band: "at_or_above_p99" };
  // A qualifying jump without an authoritative carried side must fail closed;
  // Service B must never manufacture a directional rule that wasn't in the
  // historical strategy.
  if (input.carriedSide !== "yes" && input.carriedSide !== "no") {
    return { fires: false, band: "p95_to_p99" };
  }
  return { fires: true, band: "p95_to_p99", side: input.carriedSide };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Service B owns a fixed big-bet amount; Railway can override it in cents. */
export const ETH_JUMP_WAGER_CENTS = positiveIntegerEnv("ETH_B_WAGER_CENTS", 50_000);
export const ETH_JUMP_ORDER_TAG = "eth-jump-v1";
