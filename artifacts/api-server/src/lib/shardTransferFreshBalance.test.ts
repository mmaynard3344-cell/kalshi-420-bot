import assert from "node:assert/strict";
import { test } from "node:test";
import { requireFreshShardBalanceCents } from "./shardTransferBalanceValidation.js";

test("accepts only fresh nonnegative integer shard balance", () => {
  assert.equal(requireFreshShardBalanceCents({stale:false,value:{balance:1250}}),1250);
  assert.equal(requireFreshShardBalanceCents({stale:false,value:{balance:0}}),0);
});
test("rejects stale, missing, malformed and negative shard cash", () => {
  for (const read of [
    {stale:true,value:{balance:500}},
    {stale:false,value:{}},
    {stale:false,value:{balance:"500"}},
    {stale:false,value:{balance:-1}},
    {stale:false,value:{balance:1.5}},
  ]) assert.throws(()=>requireFreshShardBalanceCents(read), /Transfer blocked/);
});
