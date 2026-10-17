import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "@workspace/db";
import { CREATE_SHARD_TRANSFER_LEDGER_SQL } from "./shardTransferLedgerSql.js";
import { makeShardTransferDependencies } from "./shardTransferSubmissionAdapter.js";
import { submitManualShardTransfer } from "./shardTransferOrchestrator.js";
const enabled = process.env.SHARD_TRANSFER_TEST_DATABASE === "1"
  && process.env.NODE_ENV === "test"
  && process.env.SHARD_TRANSFER_DISPOSABLE_DB_CONFIRMED === "yes";
test("simulated exchange accepts one transfer only, preserving durable acceptance", {skip: !enabled}, async () => {
  await pool.query(CREATE_SHARD_TRANSFER_LEDGER_SQL);
  const requestId = randomUUID();
  const req = {requestId,sourceExchangeShard:0,destinationExchangeShard:2,amountCents:100,confirmation:"TRANSFER $1.00 FROM 0 TO 2"};
  let posts = 0;
  const deps = makeShardTransferDependencies({
    uncachedAvailableBalanceCents: async () => 1000,
    submitTransferOnce: async payload => {
      posts++;
      assert.equal(payload.amount, 10000);
      return {transfer_id:"fake-test-id"};
    },
  });
  try {
    assert.deepEqual(await submitManualShardTransfer(req,deps),{status:"submitted",transferId:"fake-test-id"});
    assert.deepEqual(await submitManualShardTransfer(req,deps),{status:"duplicate"});
    assert.equal(posts,1);
    const {rows} = await pool.query("SELECT state, exchange_transfer_id FROM operator_shard_transfers WHERE request_id = $1",[requestId]);
    assert.equal(rows[0]?.state,"submitted");
    assert.equal(rows[0]?.exchange_transfer_id,"fake-test-id");
  } finally {
    await pool.query("DELETE FROM operator_shard_transfers WHERE request_id = $1",[requestId]);
  }
});
if(enabled) test.after(async()=>{await pool.end()});
