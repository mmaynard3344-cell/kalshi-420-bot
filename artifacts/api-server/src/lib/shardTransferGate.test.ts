import assert from "node:assert/strict";
import { test } from "node:test";
import { isManualShardTransferEnabled, requireManualShardTransferEnabled } from "./shardTransferGate.js";

test("transfers default to disabled", () => {
  assert.equal(isManualShardTransferEnabled({}), false);
  assert.throws(() => requireManualShardTransferEnabled({}));
});
test("one or two enabled flags never unlock transfers", () => {
  const vars = ["SHARD_TRANSFERS_ENABLED", "SHARD_TRANSFER_OPERATOR_AUTH_CONFIGURED", "SHARD_TRANSFER_IDEMPOTENCY_STORE_READY"];
  for (const key of vars) assert.equal(isManualShardTransferEnabled({[key]:"true"}), false);
  for (const missing of vars) {
    const env = Object.fromEntries(vars.filter(v => v!==missing).map(v=>[v,"true"]));
    assert.equal(isManualShardTransferEnabled(env),false);
  }
});
test("all readiness flags are required", () => {
  const env = {
    SHARD_TRANSFERS_ENABLED:"true",
    SHARD_TRANSFER_OPERATOR_AUTH_CONFIGURED:"true",
    SHARD_TRANSFER_IDEMPOTENCY_STORE_READY:"true",
  };
  assert.equal(isManualShardTransferEnabled(env), true);
  assert.doesNotThrow(() => requireManualShardTransferEnabled(env));
});
