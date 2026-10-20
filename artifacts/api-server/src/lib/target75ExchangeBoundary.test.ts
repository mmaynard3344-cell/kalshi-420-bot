import assert from "node:assert/strict";
import test from "node:test";
import { makeTarget75Adapter } from "./target75ExchangeBoundary.js";
import type { ExitDb } from "./target75ExitStore.js";

const entry = { strategy:"G", entryId:"entry-1", ticker:"KXETH15M-TEST",
  heldSide:"yes" as const, bidCents:75, contracts:2 };
const failDb: ExitDb = {
  async execute() { throw Error("unexpected database operation"); },
  async transaction<T>() { throw Error("unexpected transaction"); },
};
test("ETH adapter rejects changed quantity before reserving", async () => {
  const adapter = makeTarget75Adapter(failDb, {async postOrder() {
    throw Error("unexpected exchange POST");
  }}, entry);
  assert.equal(await adapter.reserveOnce("exit-1",3),false);
});
test("ETH adapter rejects changed side before any exchange POST", async () => {
  let posts=0;
  const adapter = makeTarget75Adapter(failDb, {async postOrder() {
    posts++; return {providerOrderId:null,state:"unknown" as const};
  }}, entry);
  await assert.rejects(adapter.submitIocSell({
    decisionKey:"exit-1", ticker:entry.ticker, heldSide:"no",
    contracts:2, minPriceCents:75,
  }), /exit_order_identity_changed/);
  assert.equal(posts,0);
});
test("missing Kalshi order ID remains uncertain and not recorded as reconciled", async () => {
  const adapter = makeTarget75Adapter(failDb, {async postOrder(order) {
    assert.equal(order.side,"ask");
    assert.equal(order.time_in_force,"immediate_or_cancel");
    return {providerOrderId:null,state:"unfilled" as const};
  }}, entry);
  const ack=await adapter.submitIocSell({
    decisionKey:"exit-1",ticker:entry.ticker,heldSide:"yes",contracts:2,minPriceCents:75,
  });
  assert.deepEqual(ack,{status:"unknown",orderId:null});
  assert.equal(await adapter.recordResult("exit-1",ack),false);
});
