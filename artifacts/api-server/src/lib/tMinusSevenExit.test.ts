import assert from "node:assert/strict";
import test from "node:test";
import { decideTMinusSevenExit, T_MINUS_SEVEN_MS } from "./tMinusSevenExit.js";
const close = 900_000;
const base = {
  nowMs: close - T_MINUS_SEVEN_MS, marketCloseMs: close,
  strategyOwnedContracts: 2, confirmedExchangeContracts: 2,
  entryCostCents: 100, entryFeesCents: 2,
  executableBidCents: 65, executableBidDepthContracts: 2,
  estimatedExitFeesCents: 2, pendingExitContracts: 0,
  ownershipIsExclusive: true, exchangeOrderStateCertain: true,
};
test("sells exactly owned quantity at T-7 if net profitable", () => {
  assert.deepEqual(decideTMinusSevenExit(base), {
    action: "sell_ioc", contracts: 2, minimumPriceCents: 65,
    projectedNetProfitCents: 26,
  });
});
test("holds losses and break even", () => {
  assert.equal(decideTMinusSevenExit({...base, executableBidCents: 50}).action, "hold");
  assert.equal(decideTMinusSevenExit({...base, executableBidCents: 52}).action, "hold");
});
test("only exact T-7 window is eligible", () => {
  assert.equal(decideTMinusSevenExit({...base, nowMs: close - T_MINUS_SEVEN_MS - 1}).action, "hold");
  assert.equal(decideTMinusSevenExit({...base, nowMs: close - T_MINUS_SEVEN_MS + 5001}).action, "hold");
});
test("fails closed on mixed ownership, pending exits and ledger mismatch", () => {
  assert.equal(decideTMinusSevenExit({...base, ownershipIsExclusive: false}).action, "hold");
  assert.equal(decideTMinusSevenExit({...base, pendingExitContracts: 1}).action, "hold");
  assert.equal(decideTMinusSevenExit({...base, confirmedExchangeContracts: 3}).action, "hold");
  assert.equal(decideTMinusSevenExit({...base, entryCostCents: null}).action, "hold");
  assert.equal(decideTMinusSevenExit({...base, executableBidDepthContracts: 1}).action, "hold");
});
