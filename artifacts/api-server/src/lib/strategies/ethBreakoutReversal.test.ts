import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH_BREAKOUT_REVERSAL_ORDER_TAG,
  ETH_BREAKOUT_REVERSAL_SIDE,
  ETH_BREAKOUT_REVERSAL_WAGER_CENTS,
  evaluateEthBreakoutReversal,
} from "./ethBreakoutReversal.js";
import {
  _readEthBreakoutReversalDirectAdjacentMoveForTesting,
  _setEthBreakoutReversalMarketFetcherForTesting,
} from "./ethBreakoutReversalRuntime.js";

const p95 = 0.004;
const p99 = 0.008;
const upperBandFloor = 0.006;

test("Service D is fixed $100 YES with a distinct order tag", () => {
  assert.equal(ETH_BREAKOUT_REVERSAL_WAGER_CENTS, 10_000);
  assert.equal(ETH_BREAKOUT_REVERSAL_SIDE, "yes");
  assert.equal(ETH_BREAKOUT_REVERSAL_ORDER_TAG, "eth-no3-upperband-v1");
});

test("Service D fires only for 3+ NO and the upper half of p95-p99", () => {
  assert.deepEqual(evaluateEthBreakoutReversal({ consecutiveNoOutcomes: 3, currentMove: upperBandFloor, p95, p99 }), {
    fires: true,
    side: "yes",
    wagerCents: 10_000,
    upperBandFloor,
    reason: "signal",
  });
  assert.equal(evaluateEthBreakoutReversal({ consecutiveNoOutcomes: 4, currentMove: 0.0079, p95, p99 }).fires, true);
  assert.equal(evaluateEthBreakoutReversal({ consecutiveNoOutcomes: 2, currentMove: 0.007, p95, p99 }).reason, "no_streak_too_short");
  assert.equal(evaluateEthBreakoutReversal({ consecutiveNoOutcomes: 3, currentMove: 0.0059, p95, p99 }).reason, "below_upper_half");
  assert.equal(evaluateEthBreakoutReversal({ consecutiveNoOutcomes: 3, currentMove: p99, p95, p99 }).reason, "at_or_above_p99");
});

test("Service D fails closed on unavailable or malformed percentile evidence", () => {
  assert.equal(evaluateEthBreakoutReversal({ consecutiveNoOutcomes: 3, currentMove: null, p95, p99 }).reason, "thresholds_unavailable");
  assert.equal(evaluateEthBreakoutReversal({ consecutiveNoOutcomes: 3, currentMove: 0.007, p95: 0.008, p99: 0.004 }).reason, "invalid_threshold_band");
});

test("Service D direct fallback computes only the exact adjacent Kalshi strike move", async () => {
  const currentOpenMs = Date.parse("2026-09-08T11:15:00.000Z");
  const priorOpenMs = currentOpenMs - 15 * 60_000;
  const ticker = "KXETH15M-26SEP080730-30";
  _setEthBreakoutReversalMarketFetcherForTesting((async (path: string) => {
    if (path === `/markets/${ticker}`) {
      return { market: { ticker, open_time: new Date(currentOpenMs).toISOString(), floor_strike: 2502 } };
    }
    if (path === "/markets") {
      return { markets: [
        { ticker: "KXETH15M-PRIOR", open_time: new Date(priorOpenMs).toISOString(), floor_strike: 2500 },
        { ticker: "KXETH15M-OLDER", open_time: new Date(priorOpenMs - 15 * 60_000).toISOString(), floor_strike: 2490 },
      ] };
    }
    throw new Error("unexpected path");
  }) as never);

  try {
    const move = await _readEthBreakoutReversalDirectAdjacentMoveForTesting({
      ticker,
      easternDate: "2026-09-08",
      observedAtMs: currentOpenMs,
      floorStrike: null,
      openTimeMs: currentOpenMs,
    });
    assert.equal(move, Math.abs(2502 - 2500) / 2500);
  } finally {
    _setEthBreakoutReversalMarketFetcherForTesting(null);
  }
});

test("Service D direct fallback fails closed when exact prior strike is ambiguous", async () => {
  const currentOpenMs = Date.parse("2026-09-08T11:30:00.000Z");
  const priorOpenMs = currentOpenMs - 15 * 60_000;
  const ticker = "KXETH15M-26SEP080745-45";
  _setEthBreakoutReversalMarketFetcherForTesting((async (path: string) => {
    if (path === `/markets/${ticker}`) {
      return { market: { ticker, open_time: new Date(currentOpenMs).toISOString(), floor_strike: 2505 } };
    }
    if (path === "/markets") {
      return { markets: [
        { ticker: "KXETH15M-PRIOR-A", open_time: new Date(priorOpenMs).toISOString(), floor_strike: 2500 },
        { ticker: "KXETH15M-PRIOR-B", open_time: new Date(priorOpenMs).toISOString(), floor_strike: 2501 },
      ] };
    }
    throw new Error("unexpected path");
  }) as never);

  try {
    const move = await _readEthBreakoutReversalDirectAdjacentMoveForTesting({
      ticker,
      easternDate: "2026-09-08",
      observedAtMs: currentOpenMs,
      floorStrike: null,
      openTimeMs: currentOpenMs,
    });
    assert.equal(move, null);
  } finally {
    _setEthBreakoutReversalMarketFetcherForTesting(null);
  }
});
