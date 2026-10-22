import assert from "node:assert/strict";
import { test } from "node:test";
import { checkShardTransferReadOnly } from "./shardTransferReadOnlyReconciliation.js";

test("reads the exact single transfer and keeps pending uncompleted", async () => {
  const paths: string[] = [];
  const result = await checkShardTransferReadOnly(
    { state: "submitted", exchangeTransferId: "abc-123" },
    async (path) => { paths.push(path); return { transfer: { transfer_id: "abc-123", status: "pending" } }; },
  );
  assert.deepEqual(paths, ["/portfolio/intra_exchange_instance_transfers/abc-123"]);
  assert.equal(result, "no_change");
});
test("uncertain, malformed or failed reads require review, never mark completed", async () => {
  for (const response of [
    { transfer: { transfer_id: "mismatch", status: "pending" } },
    { transfer: { transfer_id: "abc", status: "completed" } },
    {},
  ]) {
    assert.equal(await checkShardTransferReadOnly(
      { state: "submitted", exchangeTransferId: "abc" }, async () => response,
    ), "manual_review");
  }
  assert.equal(await checkShardTransferReadOnly(
    { state: "unknown", exchangeTransferId: "abc" }, async () => { throw Error("network down"); },
  ), "manual_review");
});
test("never queries exchange without a valid, active local transfer", async () => {
  let calls = 0;
  const reader = async () => { calls++; return {}; };
  assert.equal(await checkShardTransferReadOnly({ state: "reserved", exchangeTransferId: "abc" }, reader), "no_change");
  assert.equal(await checkShardTransferReadOnly({ state: "submitted", exchangeTransferId: null }, reader), "manual_review");
  assert.equal(calls, 0);
});
