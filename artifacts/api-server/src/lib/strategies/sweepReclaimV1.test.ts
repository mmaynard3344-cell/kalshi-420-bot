import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH_15M_MS,
  PRIOR_24H_CANDLES,
  assessLongReversalExposure,
  evaluateSweepReclaimV1,
  isImmediateFollowingEth15mWindow,
  loadSweepReclaimRuntimeConfig,
  type Eth15mCandle,
} from "./sweepReclaimV1.js";

function history(endOpenMs = 0, low = 100): Eth15mCandle[] {
  const start = endOpenMs - PRIOR_24H_CANDLES * ETH_15M_MS;
  return Array.from({ length: PRIOR_24H_CANDLES }, (_, i) => ({
    openTimeMs: start + i * ETH_15M_MS,
    closeTimeMs: start + (i + 1) * ETH_15M_MS,
    open: 110,
    high: 120,
    low,
    close: 115,
    finalized: true,
  }));
}

function source(overrides: Partial<Eth15mCandle> = {}): Eth15mCandle {
  return {
    openTimeMs: 0,
    closeTimeMs: ETH_15M_MS,
    open: 104,
    high: 110,
    low: 99,
    close: 105,
    finalized: true,
    ...overrides,
  };
}

test("qualifies only on finalized YES-only sweep/reclaim setup", () => {
  const decision = evaluateSweepReclaimV1(source(), history(0, 100));
  assert.equal(decision.qualifies, true);
  if (decision.qualifies) assert.equal(decision.side, "yes");
});

test("low above prior 24h low rejects; equality and below pass sweep condition", () => {
  assert.equal(evaluateSweepReclaimV1(source({ low: 101, open: 105, close: 106 }), history(0, 100)).qualifies, false);
  const equal = evaluateSweepReclaimV1(source({ low: 100 }), history(0, 100));
  assert.equal(equal.evidence?.sweptPrevious24hLow, true);
  const below = evaluateSweepReclaimV1(source({ low: 99 }), history(0, 100));
  assert.equal(below.evidence?.sweptPrevious24hLow, true);
});

test("wick smaller than body rejects and exact equality passes wick condition", () => {
  const reject = evaluateSweepReclaimV1(source({ open: 101, low: 100, high: 120, close: 110 }), history(0, 100));
  assert.equal(reject.qualifies, false);
  assert.equal(reject.evidence?.wickCondition, false);

  const pass = evaluateSweepReclaimV1(source({ open: 104, low: 100, high: 112, close: 108 }), history(0, 100));
  assert.equal(pass.evidence?.lowerWick, pass.evidence?.body);
  assert.equal(pass.evidence?.wickCondition, true);
});

test("close below midpoint rejects and exact midpoint passes upper-half condition", () => {
  const reject = evaluateSweepReclaimV1(source({ low: 100, high: 110, open: 104, close: 104 }), history(0, 100));
  assert.equal(reject.evidence?.upperHalfClose, false);
  const exact = evaluateSweepReclaimV1(source({ low: 100, high: 110, open: 105, close: 105 }), history(0, 100));
  assert.equal(exact.evidence?.upperHalfClose, true);
});

test("incomplete, zero-range, insufficient, or non-contiguous history fails closed", () => {
  assert.equal(evaluateSweepReclaimV1(source({ finalized: false }), history(0)).qualifies, false);
  assert.equal(evaluateSweepReclaimV1(source({ low: 100, high: 100, open: 100, close: 100 }), history(0)).qualifies, false);
  assert.equal(evaluateSweepReclaimV1(source(), history(0).slice(1)).qualifies, false);
  const broken = history(0);
  broken[50] = { ...broken[50]!, openTimeMs: broken[50]!.openTimeMs + 1 };
  assert.equal(evaluateSweepReclaimV1(source(), broken).qualifies, false);
});

test("destination must be the immediate following 15-minute window", () => {
  const s = source();
  assert.equal(isImmediateFollowingEth15mWindow(s, s.closeTimeMs, s.closeTimeMs + ETH_15M_MS), true);
  assert.equal(isImmediateFollowingEth15mWindow(s, s.openTimeMs, s.closeTimeMs), false);
  assert.equal(isImmediateFollowingEth15mWindow(s, s.closeTimeMs + ETH_15M_MS, s.closeTimeMs + 2 * ETH_15M_MS), false);
});

test("runtime config is disabled and activation-incomplete by default", () => {
  const cfg = loadSweepReclaimRuntimeConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.activationReady, false);
  assert.deepEqual(cfg.unresolved.sort(), [
    "max_entry_price_cents",
    "minimum_seconds_remaining",
    "order_type",
    "shared_correlated_exposure_cap_cents",
    "stake_cents",
  ].sort());
});

test("runtime activation requires every authoritative literal setting", () => {
  const cfg = loadSweepReclaimRuntimeConfig({
    L_SWEEP_RECLAIM_ENABLED: "true",
    L_SWEEP_RECLAIM_MAX_ENTRY_PRICE_CENTS: "51",
    L_SWEEP_RECLAIM_STAKE_CENTS: "1000",
    ETH_LONG_REVERSAL_SHARED_CAP_CENTS: "2500",
    L_SWEEP_RECLAIM_MIN_SECONDS_REMAINING: "30",
    L_SWEEP_RECLAIM_ORDER_TYPE: "example-only",
  });
  assert.equal(cfg.activationReady, true);
  assert.deepEqual(cfg.unresolved, []);
});

test("shared correlated exposure allows exact cap and rejects one cent over", () => {
  assert.equal(assessLongReversalExposure(100, 50, 150).allowed, true);
  assert.equal(assessLongReversalExposure(100, 51, 150).allowed, false);
});
