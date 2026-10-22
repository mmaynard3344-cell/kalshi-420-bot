import assert from "node:assert/strict";
import { test } from "node:test";
import { makeShardTransferDependencies } from "./shardTransferSubmissionAdapter.js";
import type { ShardTransferDependencies } from "./shardTransferOrchestrator.js";

// This tests formatting and result parsing without a database or an exchange.
// The adapter's database ports are replaced before any transfer is attempted.
test("transport remains injected: no automatic exchange calls", () => {
  let calls = 0;
  const deps: ShardTransferDependencies = makeShardTransferDependencies({
    uncachedAvailableBalanceCents: async () => 1000,
    submitTransferOnce: async () => { calls++; return {transfer_id:"fake"}; },
  });
  assert.equal(typeof deps.submitOnce, "function");
  assert.equal(calls, 0);
});
test("adapter converts $1 to 10,000 fixed-point units and validates acceptance", async () => {
  let captured: unknown;
  const deps = makeShardTransferDependencies({
    uncachedAvailableBalanceCents: async () => 1000,
    submitTransferOnce: async payload => { captured=payload; return { transfer_id:"test-transfer-123" }; },
  });
  const result = await deps.submitOnce({
    requestId:"69e61066-4170-4eb4-bfca-1b33800ca633",
    sourceExchangeShard:0,
    destinationExchangeShard:2,
    amountCents:100,
    confirmation:"TRANSFER $1.00 FROM 0 TO 2",
  });
  assert.deepEqual(result,{transferId:"test-transfer-123"});
  assert.equal((captured as {amount:number}).amount,10000);
});
