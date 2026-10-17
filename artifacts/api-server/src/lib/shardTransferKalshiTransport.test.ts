import assert from "node:assert/strict";
import { test } from "node:test";
import { createShardTransferKalshiTransport } from "./shardTransferKalshiTransport.js";

test("transport submits only on explicit invocation, with exactly one POST", async () => {
  const calls: Array<{method:string;path:string;body:unknown}> = [];
  const transport = createShardTransferKalshiTransport(async (method,path,body) => {
    calls.push({method,path,body});
    return {transfer_id:"simulated"};
  });
  assert.equal(calls.length,0);
  const payload = {
    source:"event_contract" as const,destination:"event_contract" as const,
    source_exchange_shard:0,destination_exchange_shard:2,
    source_subaccount:0,destination_subaccount:0,amount:10000,
  };
  assert.deepEqual(await transport(payload),{transfer_id:"simulated"});
  assert.equal(calls.length,1);
  assert.equal(calls[0]?.method,"POST");
  assert.equal(calls[0]?.path,"/portfolio/intra_exchange_instance_transfer");
  assert.deepEqual(calls[0]?.body,payload);
});
test("transport does not retry uncertain POST errors", async () => {
  let attempts=0;
  const transport=createShardTransferKalshiTransport(async () => {
    attempts++;throw new Error("simulated timeout");
  });
  await assert.rejects(transport({
    source:"event_contract",destination:"event_contract",source_exchange_shard:0,
    destination_exchange_shard:2,source_subaccount:0,destination_subaccount:0,amount:10000,
  }),/timeout/);
  assert.equal(attempts,1);
});
