/** BTC B: pure jump evaluation, independent of Service A.
 * The approved side is fixed YES with a $5 principal cap.
 * This module has no order, database, credential, or live-runtime imports.
 */
export const BTC_B_WAGER_CENTS = 500;
export const BTC_B_HISTORY_MS = 28 * 24 * 60 * 60 * 1000;
export const BTC_B_WINDOW_MS = 15 * 60 * 1000;
export const BTC_B_MIN_HISTORY = 50; // Preserve the deployed B minimum sample.
export interface BtcJumpFact {
  ticker: string;
  openTimeMs: number;
  floorStrike: number;
  finalized: boolean;
  /** When authoritative finalization was actually known, for replay safety. */
  finalizedAtMs: number;
}

export interface BtcJumpMarket {
  ticker: string;
  openTimeMs: number;
  observedAtMs: number;
  floorStrike: number;
}
export interface BtcJumpDecision {
  fires: boolean;
  side: "yes" | null;
  wagerCents: 500;
  signedMove: number | null;
  absoluteMove: number | null;
  p95: number | null;
  p99: number | null;
  historyMoveCount: number;
  reason: "invalid_market" | "invalid_history" | "missing_adjacent_market"
    | "insufficient_history" | "below_p95" | "at_or_above_p99" | "signal";
}

function percentile(sorted: number[], q: number): number {
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const fraction = index - lo;
  return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * fraction;
}
function validIdentity(fact: { ticker: string; openTimeMs: number; floorStrike: number }): boolean {
  return /^KXBTC15M-[A-Z0-9-]+$/.test(fact.ticker)
    && Number.isSafeInteger(fact.openTimeMs) && fact.openTimeMs > 0
    && fact.openTimeMs % BTC_B_WINDOW_MS === 0
    && Number.isFinite(fact.floorStrike) && fact.floorStrike > 0;
}

/** p95 <= abs(adjacent strike change) < p99 using finalized BTC-only history.
 * The user-approved side is always YES, for either sign of qualifying jump.
 * Current-window data never enters the percentile sample. Gaps are not returns.
 * A carried-side, directional forecast, and martingale state are never inputs.
 */
export function evaluateBtcJump(input: {
  market: BtcJumpMarket;
  history: readonly BtcJumpFact[];
}): BtcJumpDecision {
  const { market } = input;
  const result: BtcJumpDecision = {
    fires: false, side: null, wagerCents: BTC_B_WAGER_CENTS,
    signedMove: null, absoluteMove: null, p95: null, p99: null,
    historyMoveCount: 0, reason: "invalid_market",
  };
  if (!validIdentity(market) || !Number.isSafeInteger(market.observedAtMs)
    || market.observedAtMs < market.openTimeMs
    || market.observedAtMs >= market.openTimeMs + BTC_B_WINDOW_MS) return result;

  const oldestReturnMs = market.openTimeMs - BTC_B_HISTORY_MS;
  const byOpen = new Map<number, BtcJumpFact>();
  for (const fact of input.history) {
    // Exclude other assets, unfinished markets, future evidence, and current window.
    if (!validIdentity(fact) || !fact.finalized || !Number.isSafeInteger(fact.finalizedAtMs)
      || fact.finalizedAtMs < fact.openTimeMs + BTC_B_WINDOW_MS
      || fact.finalizedAtMs > market.observedAtMs
      || fact.openTimeMs < oldestReturnMs - BTC_B_WINDOW_MS
      || fact.openTimeMs >= market.openTimeMs) continue;
    const existing = byOpen.get(fact.openTimeMs);
    // Conflicting identities/strikes at one window cannot be silently selected.
    if (existing && (existing.ticker !== fact.ticker || existing.floorStrike !== fact.floorStrike)) {
      return { ...result, reason: "invalid_history" };
    }
    byOpen.set(fact.openTimeMs, fact);
  }
  const moves: number[] = [];
  for (const fact of byOpen.values()) {
    if (fact.openTimeMs < oldestReturnMs) continue;
    const prior = byOpen.get(fact.openTimeMs - BTC_B_WINDOW_MS);
    if (!prior) continue;
    const move = Math.abs((fact.floorStrike - prior.floorStrike) / prior.floorStrike);
    if (Number.isFinite(move)) moves.push(move);
  }
  moves.sort((a, b) => a - b);
  result.historyMoveCount = moves.length;
  const prior = byOpen.get(market.openTimeMs - BTC_B_WINDOW_MS);
  if (!prior) return { ...result, reason: "missing_adjacent_market" };
  result.signedMove = (market.floorStrike - prior.floorStrike) / prior.floorStrike;
  result.absoluteMove = Math.abs(result.signedMove);
  if (!Number.isFinite(result.signedMove)) return { ...result, signedMove: null, absoluteMove: null, reason: "invalid_market" };
  if (moves.length < BTC_B_MIN_HISTORY) return { ...result, reason: "insufficient_history" };
  result.p95 = percentile(moves, 0.95);
  result.p99 = percentile(moves, 0.99);
  if (result.absoluteMove < result.p95) return { ...result, reason: "below_p95" };
  if (result.absoluteMove >= result.p99) return { ...result, reason: "at_or_above_p99" };
  return {
    ...result, fires: true, reason: "signal",
    side: "yes",
  };
}
