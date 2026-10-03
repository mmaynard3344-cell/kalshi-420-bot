// artifacts/api-server/src/lib/strategies/btcJumpSignal.ts
var BTC_B_WAGER_CENTS = 500;
var BTC_B_HISTORY_MS = 28 * 24 * 60 * 60 * 1e3;
var BTC_B_WINDOW_MS = 15 * 60 * 1e3;
var BTC_B_MIN_HISTORY = 50;
function percentile(sorted, q) {
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const fraction = index - lo;
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * fraction;
}
function validIdentity(fact) {
  return /^KXBTC15M-[A-Z0-9-]+$/.test(fact.ticker) && Number.isSafeInteger(fact.openTimeMs) && fact.openTimeMs > 0 && fact.openTimeMs % BTC_B_WINDOW_MS === 0 && Number.isFinite(fact.floorStrike) && fact.floorStrike > 0;
}
function evaluateBtcJump(input) {
  const { market } = input;
  const result = {
    fires: false,
    side: null,
    wagerCents: BTC_B_WAGER_CENTS,
    signedMove: null,
    absoluteMove: null,
    p95: null,
    p99: null,
    historyMoveCount: 0,
    reason: "invalid_market"
  };
  if (!validIdentity(market) || !Number.isSafeInteger(market.observedAtMs) || market.observedAtMs < market.openTimeMs || market.observedAtMs >= market.openTimeMs + BTC_B_WINDOW_MS) return result;
  const oldestReturnMs = market.openTimeMs - BTC_B_HISTORY_MS;
  const byOpen = /* @__PURE__ */ new Map();
  for (const fact of input.history) {
    if (!validIdentity(fact) || !fact.finalized || !Number.isSafeInteger(fact.finalizedAtMs) || fact.finalizedAtMs < fact.openTimeMs + BTC_B_WINDOW_MS || fact.finalizedAtMs > market.observedAtMs || fact.openTimeMs < oldestReturnMs - BTC_B_WINDOW_MS || fact.openTimeMs >= market.openTimeMs) continue;
    const existing = byOpen.get(fact.openTimeMs);
    if (existing && (existing.ticker !== fact.ticker || existing.floorStrike !== fact.floorStrike)) {
      return { ...result, reason: "invalid_history" };
    }
    byOpen.set(fact.openTimeMs, fact);
  }
  const moves = [];
  for (const fact of byOpen.values()) {
    if (fact.openTimeMs < oldestReturnMs) continue;
    const prior2 = byOpen.get(fact.openTimeMs - BTC_B_WINDOW_MS);
    if (!prior2) continue;
    const move = Math.abs((fact.floorStrike - prior2.floorStrike) / prior2.floorStrike);
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
    ...result,
    fires: true,
    reason: "signal",
    side: "yes"
  };
}
export {
  BTC_B_HISTORY_MS,
  BTC_B_MIN_HISTORY,
  BTC_B_WAGER_CENTS,
  BTC_B_WINDOW_MS,
  evaluateBtcJump
};
