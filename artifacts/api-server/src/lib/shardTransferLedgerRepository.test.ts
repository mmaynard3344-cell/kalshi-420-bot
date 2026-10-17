import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { CREATE_SHARD_TRANSFER_LEDGER_SQL } from "./shardTransferLedgerSql.js";
import { test } from "node:test";
import {
  reserveShardTransfer,
  claimShardTransfer,
  markShardTransferUnknown,
  readShardTransfer,
} from "./shardTransferLedgerRepository.js";

/**
 * Integration tests deliberately require an explicit disposable database opt-in.
 * NEVER set SHARD_TRANSFER_TEST_DATABASE=1 on a trading production database.
 */
const enabled = process.env["SHARD_TRANSFER_TEST_DATABASE"] === "1"
  && process.env["NODE_ENV"] === "test"
  && process.env["SHARD_TRANSFER_DISPOSABLE_DB_CONFIRMED"] === "yes";
test("durable reservation permits one claim and disallows duplicate request IDs", { skip: !enabled }, async () => {
  await pool.query(CREATE_SHARD_TRANSFER_LEDGER_SQL);
  const requestId = randomUUID();
  const request = {
    sourceExchangeShard: 0 as const,
    destinationExchangeShard: 2 as const,
    amountCents: 100,
    confirmation: "TRANSFER $1.00 FROM 0 TO 2",
    requestId,
  };
  assert.equal(await reserveShardTransfer(request), true);
  assert.equal(await reserveShardTransfer(request), false);
  assert.equal(await claimShardTransfer(requestId), true);
  assert.equal(await claimShardTransfer(requestId), false);
  assert.equal(await markShardTransferUnknown(requestId), undefined);
  const record = await readShardTransfer(requestId);
  assert.equal(record?.["state"], "unknown");
  await pool.query("DELETE FROM operator_shard_transfers WHERE request_id = $1::uuid", [requestId]);
});

// The pooled client otherwise keeps Node's test process alive after assertions.
if (enabled) {
  test.after(async () => { await pool.end(); });
}
