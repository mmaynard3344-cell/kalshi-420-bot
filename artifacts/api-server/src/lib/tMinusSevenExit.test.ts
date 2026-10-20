import assert from "node:assert/strict";
import test from "node:test";
import { decideTarget75Exit, executeTarget75Decision, PROFIT_TAKE_TARGET_CENTS } from "./tMinusSevenExit.js";
const close = 900_000;
const base = {
  strategyOwnedContracts: 2, confirmedExchangeContracts: 2,
  entryCostCents: 100, entryFeesCents: 2,
  executableBidCents: 75, executableBidDepthContracts: 2,
  estimatedExitFeesCents: 2, pendingExitContracts: 0,
  ownershipIsExclusive: true, exchangeOrderStateCertain: true,
};
test("sells exactly owned quantity when bid is at least 75 cents and net profitable", () => {
  assert.deepEqual(decideTarget75Exit(base), {
    action: "sell_ioc", contracts: 2, minimumPriceCents: 75,
    projectedNetProfitCents: 46,
  });
});
test("holds losses and break even", () => {
  assert.equal(decideTarget75Exit({...base, executableBidCents: 50}).action, "hold");
  assert.equal(decideTarget75Exit({...base, executableBidCents: 52}).action, "hold");
});
test("target is 75 cents regardless of time", () => {
  assert.equal(PROFIT_TAKE_TARGET_CENTS, 75);
  assert.equal(decideTarget75Exit({ ...base, executableBidCents: 74 }).action, "hold");
  assert.equal(decideTarget75Exit({ ...base, executableBidCents: 76 }).action, "sell_ioc");
});
test("fails closed on mixed ownership, pending exits and ledger mismatch", () => {
  assert.equal(decideTarget75Exit({...base, ownershipIsExclusive: false}).action, "hold");
  assert.equal(decideTarget75Exit({...base, pendingExitContracts: 1}).action, "hold");
  assert.equal(decideTarget75Exit({...base, confirmedExchangeContracts: 3}).action, "hold");
  assert.equal(decideTarget75Exit({...base, entryCostCents: null}).action, "hold");
  assert.equal(decideTarget75Exit({...base, executableBidDepthContracts: 1}).action, "hold");
});

test("execution submits only after durable reservation and post-start fence", async () => {
  const steps: string[] = [];
  const adapter = {
    async reserveOnce() { steps.push("reserve"); return true; },
    async markPostStarted() { steps.push("fence"); return true; },
    async submitIocSell(order: { minPriceCents: number; contracts: number }) {
      steps.push("post"); assert.equal(order.minPriceCents, 75);
      assert.equal(order.contracts, 2);
      return { status: "filled" as const, orderId: "example" };
    },
    async recordResult() { steps.push("reconcile"); return true; },
  };
  assert.equal(await executeTarget75Decision(adapter, {
    decisionKey: "strategy:market:close", ticker: "KXETH15M-test", heldSide: "yes", snapshot: base,
  }), "submitted");
  assert.deepEqual(steps, ["reserve", "fence", "post", "reconcile"]);
});
test("failed pre-POST durable fence prevents submission", async () => {
  let submitted = false;
  const adapter = {
    async reserveOnce() { return true; },
    async markPostStarted() { return false; },
    async submitIocSell() { submitted = true; return { status: "filled" as const, orderId: "test" }; },
    async recordResult() { return true; },
  };
  assert.equal(await executeTarget75Decision(adapter, {
    decisionKey: "x", ticker: "KXETH15M-test", heldSide: "yes", snapshot: base,
  }), "persistence_failed");
  assert.equal(submitted, false);
});
test("uncertain POST is never automatically retried", async () => {
  let posts = 0;
  const adapter = {
    async reserveOnce() { return true; },
    async markPostStarted() { return true; },
    async submitIocSell(): Promise<{ status: "filled"; orderId: string }> {
      posts++; throw new Error("transport uncertainty");
    },
    async recordResult() { return true; },
  };
  assert.equal(await executeTarget75Decision(adapter, {
    decisionKey: "x", ticker: "KXETH15M-test", heldSide: "yes", snapshot: base,
  }), "unknown");
  assert.equal(posts, 1);
});
