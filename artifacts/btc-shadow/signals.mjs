import { evaluateBtcJump, BTC_B_WINDOW_MS, BTC_B_HISTORY_MS } from "./btcJumpSignal.mjs";
export const STAKE_CENTS = 500;
export const SERVICES = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
export const ORDER_EXECUTION_ENABLED = false;
export const WINDOW_MS = BTC_B_WINDOW_MS;
export const HISTORY_MS = BTC_B_HISTORY_MS;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const quantile = (a, p) => {
  const i = (a.length - 1) * p, n = Math.floor(i);
  return a[n] + (a[Math.min(n + 1, a.length - 1)] - a[n]) * (i - n);
};
export function knownFacts(history, market) {
  const map = new Map();
  for (const f of history) {
    if (!/^KXBTC15M-[A-Z0-9-]+$/.test(f.ticker) || !Number.isSafeInteger(f.openTimeMs)
      || f.openTimeMs % WINDOW_MS !== 0 || !finite(f.floorStrike) || f.floorStrike <= 0
      || !f.finalized || !Number.isSafeInteger(f.finalizedAtMs)
      || f.finalizedAtMs < f.openTimeMs + WINDOW_MS || f.finalizedAtMs > market.observedAtMs
      || f.openTimeMs >= market.openTimeMs || f.openTimeMs < market.openTimeMs - HISTORY_MS - WINDOW_MS) continue;
    const existing = map.get(f.openTimeMs);
    if (existing && (existing.ticker !== f.ticker || existing.floorStrike !== f.floorStrike
      || (existing.result && f.result && existing.result !== f.result))) throw new Error("conflicting_btc_history");
    map.set(f.openTimeMs, f);
  }
  return map;
}
export function buildEvidence(market, history) {
  if (!/^KXBTC15M-[A-Z0-9-]+$/.test(market.ticker) || !Number.isSafeInteger(market.openTimeMs)
    || market.openTimeMs % WINDOW_MS !== 0 || !Number.isSafeInteger(market.observedAtMs)
    || market.observedAtMs < market.openTimeMs || market.observedAtMs >= market.openTimeMs + WINDOW_MS
    || !finite(market.floorStrike) || market.floorStrike <= 0) throw new Error("invalid_btc_market");
  const facts = knownFacts(history, market);
  const prior = facts.get(market.openTimeMs - WINDOW_MS);
  const signedMove = prior ? (market.floorStrike - prior.floorStrike) / prior.floorStrike : null;
  const moves = [];
  for (const fact of facts.values()) {
    const prev = facts.get(fact.openTimeMs - WINDOW_MS);
    if (!prev || fact.openTimeMs < market.openTimeMs - HISTORY_MS) continue;
    const move = Math.abs((fact.floorStrike - prev.floorStrike) / prev.floorStrike);
    if (finite(move)) moves.push(move);
  }
  moves.sort((a, b) => a - b);
  let noStreak = 0;
  for (let time = market.openTimeMs - WINDOW_MS; facts.get(time)?.result === "no"; time -= WINDOW_MS) noStreak++;
  const outcomes = [1, 2, 3].map((i) => facts.get(market.openTimeMs - i * WINDOW_MS)?.result ?? null);
  return { signedMove, absoluteMove: signedMove == null ? null : Math.abs(signedMove), noStreak, outcomes,
    historyCount: moves.length, p80: moves.length >= 50 ? quantile(moves, 0.80) : null,
    p90: moves.length >= 50 ? quantile(moves, 0.90) : null,
    p95: moves.length >= 50 ? quantile(moves, 0.95) : null,
    p99: moves.length >= 50 ? quantile(moves, 0.99) : null };
}
export function evaluateL(source, prior96, destinationOpenMs) {
  const valid = (c) => c && [c.open, c.high, c.low, c.close].every((x) => finite(x) && x > 0)
    && c.high >= Math.max(c.low, c.open, c.close) && c.low <= Math.min(c.open, c.close)
    && Number.isSafeInteger(c.openTimeMs) && c.openTimeMs % WINDOW_MS === 0
    && c.closeTimeMs - c.openTimeMs === WINDOW_MS && c.finalized;
  if (!valid(source) || source.closeTimeMs !== destinationOpenMs) return { fires: false, reason: "source_not_final_immediate_predecessor" };
  if (prior96.length !== 96 || prior96.some((c, i) => !valid(c)
    || (i > 0 && c.openTimeMs !== prior96[i - 1].closeTimeMs))
    || prior96[95].closeTimeMs !== source.openTimeMs) return { fires: false, reason: "prior_24h_history_unavailable" };
  const range = source.high - source.low;
  if (range <= 0) return { fires: false, reason: "zero_range" };
  const prior24hLow = Math.min(...prior96.map((c) => c.low));
  const body = Math.abs(source.close - source.open);
  const lowerWick = Math.min(source.open, source.close) - source.low;
  const evidence = { prior24hLow, body, lowerWick, midpoint: source.low + range / 2 };
  if (source.low > prior24hLow) return { fires: false, reason: "did_not_sweep_prior_24h_low", evidence };
  if (lowerWick < body) return { fires: false, reason: "lower_wick_smaller_than_body", evidence };
  if (source.close < evidence.midpoint) return { fires: false, reason: "close_below_midpoint", evidence };
  return { fires: true, side: "yes", reason: "signal", evidence };
}
/** J preserves its dependency; it never fabricates A or touches an ETH A order. */
export function evaluateJ(a, market, quote) {
  if (!a || a.ticker !== market.ticker || a.service !== "A" || a.mode !== "paper"
    || a.verified !== true || (a.side !== "yes" && a.side !== "no")) return { fires: false, reason: "no_btc_a_order" };
  const ask = a.side === "yes" ? quote?.yesAskCents : quote?.noAskCents;
  const depth = a.side === "yes" ? quote?.yesDepthAt50 : quote?.noDepthAt50;
  if (a.fillCount !== 0 || !["resting", "open"].includes(a.status)
    || !finite(ask) || ask <= 50 || ask > 90 || depth !== 0) return { fires: false, reason: "jackpot_trigger_not_met" };
  return { fires: true, side: a.side, reason: "signal" };
}
export function evaluateStrategy(service, evidence, extra = {}) {
  const e = evidence, m = e.absoluteMove, signed = e.signedMove;
  const yes = (fires, reason) => ({ fires, side: fires ? "yes" : null, reason: fires ? "signal" : reason });
  const inBand = (low, high) => [m, low, high].every(finite) && high > low && m >= low && m < high;
  switch (service) {
    case "B": return yes(inBand(e.p95, e.p99), "outside_btc_jump_band");
    case "C": return yes(e.noStreak >= 3 && inBand(e.p95, e.p99), "no3_or_jump_band_not_met");
    case "D": return yes(e.noStreak >= 3 && inBand(finite(e.p95) && finite(e.p99) ? (e.p95 + e.p99) / 2 : null, e.p99), "no3_or_upper_half_not_met");
    case "E": return yes(signed < 0 && inBand(e.p80, e.p90), "downward_p80_p90_not_met");
    case "F": return yes(signed < 0 && inBand(e.p90, e.p95), "downward_p90_p95_not_met");
    case "G": {
      const [one, two, three] = e.outcomes;
      if (![one, two, three].every((x) => x === "yes" || x === "no") || one !== two || three === one) return { fires: false, side: null, reason: "exact_two_streak_not_met" };
      return { fires: true, side: one === "yes" ? "no" : "yes", reason: "signal" };
    }
    case "H": return yes(finite(signed) && signed < 0 && -signed >= 0.007 && -signed < 0.0095, "ashley_decline_band_not_met");
    case "I": {
      const side = finite(signed) && signed < 0 && -signed >= 0.006 && -signed < 0.0099 ? "yes"
        : finite(signed) && signed > 0 && signed >= 0.005 && signed < 0.008 ? "no" : null;
      return { fires: side != null, side, reason: side ? "signal" : "ash_v2_band_not_met" };
    }
    case "J": return evaluateJ(extra.aOrder, extra.market, extra.quote);
    case "K": return { fires: false, side: null, reason: "weather_service_excluded_from_btc" };
    case "L": return evaluateL(extra.source, extra.prior96 ?? [], extra.market.openTimeMs);
    default: throw new Error("unknown_service");
  }
}
export function evaluatePortfolio({ market, history, candles = [], aOrder = null, quote = null }) {
  let evidence;
  try { evidence = buildEvidence(market, history); }
  catch (error) {
    return SERVICES.map((service) => ({ service, ticker: market?.ticker ?? null, stakeCents: STAKE_CENTS,
      fires: false, side: null, mode: "shadow", ordersEnabled: false, reason: error.message }));
  }
  const source = candles.find((c) => c.closeTimeMs === market.openTimeMs);
  const prior96 = source ? candles.filter((c) => c.closeTimeMs <= source.openTimeMs).sort((a, b) => a.openTimeMs - b.openTimeMs).slice(-96) : [];
  return SERVICES.map((service) => {
    const decision = service === "B" ? evaluateBtcJump({ market, history })
      : evaluateStrategy(service, evidence, { market, source, prior96, aOrder, quote });
    return { ...decision, service, ticker: market.ticker, stakeCents: STAKE_CENTS,
      limitPriceCents: service === "J" ? 90 : 50,
      orderTag: `btc-${service.toLowerCase()}-shadow-v1`, mode: "shadow", ordersEnabled: false,
      correlatedLongReversal: ["E", "H", "L"].includes(service) || (service === "I" && decision.side === "yes"),
      signalEvidence: service === "B" ? undefined : evidence };
  });
}
