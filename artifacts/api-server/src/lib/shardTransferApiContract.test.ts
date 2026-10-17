import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARD_TRANSFER_CREATE_PATH, SHARD_TRANSFER_HISTORY_PATH, parseShardTransferCreationResponse } from "./shardTransferApiContract.js";
test("uses the documented singular POST and plural read endpoint", () => {
  assert.equal(SHARD_TRANSFER_CREATE_PATH, "/portfolio/intra_exchange_instance_transfer");
  assert.equal(SHARD_TRANSFER_HISTORY_PATH, "/portfolio/intra_exchange_instance_transfers");
});
test("requires valid transfer ID for asynchronous acceptance", () => {
  assert.equal(parseShardTransferCreationResponse({transfer_id: "abc-123"}), "abc-123");
  for (const result of [null, {}, {transfer_id: 42}, {transfer_id: ""}, {id: "wrong"}]) {
    assert.throws(() => parseShardTransferCreationResponse(result), /transfer|response/);
  }
});