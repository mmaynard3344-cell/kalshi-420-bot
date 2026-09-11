import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEthBigBetSettlement,
  estimateEthBigBetFullFillFeeCents,
  ethBigBetCapitalRiskCents,
  ethBigBetContracts,
  ethBigBetOrderId,
  mayEvaluateBigBetMarket,
} from "./ethBigBetLifecycle.js";

test("B/C order identity is strategy-specific and market-specific", () => {
  assert.equal(ethBigBetOrderId({ ticker: "KXETH15M-X", orderTag: "eth-jump-v1" }), "KXETH15M-X:eth-jump-v1");
  assert.equal(ethBigBetOrderId({ ticker: "KXETH15M-X", orderTag: "eth-no3-reversal-v1" }), "KXETH15M-X:eth-no3-reversal-v1");
});

test("B/C contract sizing is flat and independent of any ladder", () => {
  assert.equal(ethBigBetContracts(42_000, 50), 840);
  assert.equal(ethBigBetContracts(50_000, 50), 1000);
  assert.equal(ethBigBetContracts(50_000, 65), 769);
});

test("capital risk includes conservative full-fill fee headroom", () => {
  assert.equal(estimateEthBigBetFullFillFeeCents(42_000, 50), 1_470);
  assert.equal(ethBigBetCapitalRiskCents(42_000, 50), 43_470);
  assert.equal(estimateEthBigBetFullFillFeeCents(50_000, 50), 1_750);
  assert.equal(ethBigBetCapitalRiskCents(50_000, 50), 51_750);
  assert.equal(ethBigBetCapitalRiskCents(0, 50), 0);
});

test("zero fill is accounting-neutral, not a loss or lifecycle blocker", () => {
  assert.deepEqual(accountEthBigBetSettlement({
    orderId: "x", strategy: "jump", ticker: "KXETH15M-X", side: "no", result: "yes",
    filledContracts: 0, notionalCents: 0, feeCents: 0,
  }), { pnlCents: 0, won: null });
});

test("settlement computes accounting P&L without sequence transition", () => {
  assert.deepEqual(accountEthBigBetSettlement({
    orderId: "x", strategy: "reversal", ticker: "KXETH15M-X", side: "yes", result: "yes",
    filledContracts: 1000, notionalCents: 50_000, feeCents: 1_750,
  }), { pnlCents: 48_250, won: true });
  assert.deepEqual(accountEthBigBetSettlement({
    orderId: "y", strategy: "reversal", ticker: "KXETH15M-Y", side: "yes", result: "no",
    filledContracts: 1000, notionalCents: 50_000, feeCents: 1_750,
  }), { pnlCents: -51_750, won: false });
});

test("an unresolved prior market does not block a later B/C market", () => {
  assert.equal(mayEvaluateBigBetMarket({ targetOrderId: "B:new", unresolvedOrderIds: ["B:old"] }), true);
  assert.equal(mayEvaluateBigBetMarket({ targetOrderId: "B:new", unresolvedOrderIds: ["B:new"] }), false);
});
