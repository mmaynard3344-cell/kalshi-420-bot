// SOL / XRP / DOGE G: deterministic, pure strategy core (review-only).
// No database writes, network requests or order execution.
export const ASSET_SERIES = Object.freeze({
  SOL: "KXSOL15M",
  XRP: "KXXRP15M",
  DOGE: "KXDOGE15M",
});
export const G_STAKES_CENTS = Object.freeze([200, 400, 800, 1600, 3200, 6400]);
export const WINDOW_MS = 15 * 60_000;

export function assertAsset(asset) {
  if (!Object.hasOwn(ASSET_SERIES, asset)) throw new Error("unsupported_g_asset");
  return ASSET_SERIES[asset];
}

// An explicit per-asset key prevents accidental reuse of BTC's live state.
export function ladderKey(asset) {
  assertAsset(asset);
  return `G:${asset}`;
}

export function initialLadder(asset) {
  return Object.freeze({ asset, key: ladderKey(asset), step: 0, pendingOrderId: null, version: 0 });
}
function validatedState(state) {
  if (!state || state.key !== ladderKey(state.asset) || !Number.isInteger(state.step) ||
      state.step < 0 || state.step >= G_STAKES_CENTS.length ||
      !Number.isSafeInteger(state.version) || state.version < 0 ||
      (state.pendingOrderId != null && typeof state.pendingOrderId !== "string")) {
    throw new Error("invalid_g_ladder_state");
  }
  return state;
}
export function stakeCents(state) {
  return G_STAKES_CENTS[validatedState(state).step];
}
export function reserve(state, id) {
  validatedState(state);
  if (state.pendingOrderId !== null) throw new Error("g_order_pending");
  if (typeof id !== "string" || id.length === 0) throw new Error("invalid_g_order_id");
  return Object.freeze({ ...state, pendingOrderId: id, version: state.version + 1 });
}
export function applyVerifiedResult(state, id, result) {
  validatedState(state);
  if (state.pendingOrderId !== id || !id) throw new Error("g_order_mismatch");
  if (result !== "win" && result !== "loss" && result !== "zero_fill") throw new Error("unverified_g_result");
  return Object.freeze({
    ...state,
    step: result === "win" ? 0 : result === "loss" ? (state.step + 1) % G_STAKES_CENTS.length : state.step,
    pendingOrderId: null,
    version: state.version + 1,
  });
}

// Inputs MUST be three contiguous, finalized Kalshi outcomes in chronological
// order (oldest first). Do not infer a result from prices or unresolved markets.
export function decideG(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length !== 3 ||
      !outcomes.every(x => x === "yes" || x === "no")) {
    return Object.freeze({ fires: false, side: null, reason: "outcomes_not_verified" });
  }
  const [previous, first, second] = outcomes;
  if (first !== second || previous === first) {
    return Object.freeze({ fires: false, side: null, reason: "exact_two_streak_not_met" });
  }
  return Object.freeze({ fires: true, side: first === "yes" ? "no" : "yes", reason: "signal" });
}

// Validate candidate contract against the expected series and time window.
// This is deliberately fail-closed and does not itself fetch Kalshi markets.
export function selectGMarket(asset, market, observedAtMs) {
  const series = assertAsset(asset);
  if (!market || typeof market.ticker !== "string" ||
      !market.ticker.startsWith(series + "-") ||
      !/^[A-Z0-9-]+$/.test(market.ticker) ||
      !["active", "open"].includes(market.status)) return null;
  const close = Date.parse(market.close_time);
  const listedOpen = Date.parse(market.open_time);
  const strike = Number(market.floor_strike);
  const windowStart = close - WINDOW_MS;
  if (!Number.isSafeInteger(close) || close % WINDOW_MS !== 0 ||
      !Number.isSafeInteger(listedOpen) || listedOpen > observedAtMs ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs < windowStart || observedAtMs >= close ||
      !Number.isFinite(strike) || strike <= 0) return null;
  return Object.freeze({ asset, ticker: market.ticker, floorStrike: strike, openTimeMs: windowStart, observedAtMs });
}
