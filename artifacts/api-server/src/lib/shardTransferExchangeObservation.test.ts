import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectKalshiTransferObservation as inspect } from "./shardTransferExchangeObservation.js";
test("Kalshi's documented single-transfer pending response cannot complete transfer", () => {
  assert.deepEqual(inspect({ transfer: { transfer_id: "abc", status: "pending", source_exchange_shard: 0, destination_exchange_shard: 2, amount: "1.0000" } }, "abc"), { status: "pending" });
});
test("unknown states and mismatched IDs require review, never completion", () => {
  for (const sample of [
    { transfer: { transfer_id: "other", status: "pending" } },
    { transfer: { transfer_id: "abc", status: "complete" } },
    { transfer: { transfer_id: "abc", status: "failed" } },
    { transfer: null }, {},
  ]) assert.deepEqual(inspect(sample, "abc"), { status: "manual_review" });
});
