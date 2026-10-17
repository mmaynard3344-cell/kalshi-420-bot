import assert from "node:assert/strict";
import {test} from "node:test";
import {submitManualShardTransfer, type ShardTransferDependencies} from "./shardTransferOrchestrator.js";

const request = {
  sourceExchangeShard: 0,
  destinationExchangeShard: 2,
  amountCents: 2500,
  confirmation: "TRANSFER $25.00 FROM 0 TO 2",
  requestId: "123e4567-e89b-42d3-a456-426614174000",
};
function fakeDeps() {
  const calls: string[] = [];
  const deps: ShardTransferDependencies = {
    reserve: async () => {calls.push("reserve"); return true;},
    claim: async () => {calls.push("claim"); return true;},
    freshAvailableCents: async () => {calls.push("balance"); return 10000;},
    submitOnce: async () => {calls.push("post"); return {transferId: "kalshi-transfer-1"};},
    accepted: async () => {calls.push("accepted");},
    unknown: async () => {calls.push("unknown");},
  };
  return {deps, calls};
}
test("requires balance, reservation and atomic claim before a single submit", async () => {
  const {deps, calls} = fakeDeps();
  assert.deepEqual(await submitManualShardTransfer(request,deps), {status:"submitted",transferId:"kalshi-transfer-1"});
  assert.deepEqual(calls,["balance","reserve","claim","post","accepted"]);
});
test("insufficient balance does not reserve or POST", async () => {
  const {deps, calls} = fakeDeps();
  deps.freshAvailableCents = async () => 2499;
  assert.deepEqual(await submitManualShardTransfer(request,deps),{status:"insufficient_balance"});
  assert.deepEqual(calls,[]);
});
test("duplicate durable reservation never submits", async () => {
  const {deps,calls} = fakeDeps();
  deps.reserve = async () => false;
  assert.deepEqual(await submitManualShardTransfer(request,deps),{status:"duplicate"});
  assert.deepEqual(calls,["balance"]);
});
test("exchange timeout is unknown and not retried", async () => {
  const {deps,calls} = fakeDeps();
  deps.submitOnce = async () => {calls.push("post"); throw new Error("timeout");};
  assert.deepEqual(await submitManualShardTransfer(request,deps),{status:"unknown"});
  assert.deepEqual(calls,["balance","reserve","claim","post","unknown"]);
});

test("failure to persist exchange acceptance is uncertain, not retried", async () => {
  const {deps,calls} = fakeDeps();
  deps.accepted = async () => {calls.push("accepted"); throw new Error("database temporarily unavailable");};
  assert.deepEqual(await submitManualShardTransfer(request,deps),{status:"unknown"});
  assert.deepEqual(calls,["balance","reserve","claim","post","accepted","unknown"]);
});
test("failure to claim reservation never reaches the exchange", async () => {
  const {deps,calls} = fakeDeps();
  deps.claim = async () => { calls.push("claim"); return false; };
  assert.deepEqual(await submitManualShardTransfer(request,deps),{status:"duplicate"});
  assert.deepEqual(calls,["balance","reserve","claim"]);
});

test("failure to record uncertainty never reports a completed transfer", async () => {
  const {deps,calls} = fakeDeps();
  deps.submitOnce = async () => {calls.push("post"); throw new Error("network timeout");};
  deps.unknown = async () => {calls.push("unknown"); throw new Error("database failure");};
  await assert.rejects(submitManualShardTransfer(request,deps), /operator review required/);
  assert.deepEqual(calls,["balance","reserve","claim","post","unknown"]);
});
