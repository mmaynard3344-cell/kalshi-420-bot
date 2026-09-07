import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH_BREAKOUT_REVERSAL_ORDER_TAG,
  ETH_BREAKOUT_REVERSAL_SIDE,
  ETH_BREAKOUT_REVERSAL_WAGER_CENTS,
  evaluateEthBreakoutReversal,
} from "./ethBreakoutReversal.js";

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
