import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREATE_SHARD_TRANSFER_LEDGER_SQL,
  RESERVE_SHARD_TRANSFER_SQL,
  CLAIM_SHARD_TRANSFER_SQL,
  MARK_SHARD_TRANSFER_UNKNOWN_SQL,
  RECORD_SHARD_TRANSFER_ACCEPTANCE_SQL,
  GET_SHARD_TRANSFER_SQL,
  MARK_SHARD_TRANSFER_COMPLETED_SQL,
  MARK_SHARD_TRANSFER_RECONCILED_FAILED_SQL,
} from "./shardTransferLedgerSql.js";

test("request ID is a durable unique key", () => {
  assert.match(CREATE_SHARD_TRANSFER_LEDGER_SQL, /request_id uuid PRIMARY KEY/);
  assert.match(RESERVE_SHARD_TRANSFER_SQL, /ON CONFLICT \(request_id\) DO NOTHING/);
});
test("claim is atomic and only possible from reserved state", () => {
  assert.match(CLAIM_SHARD_TRANSFER_SQL, /state = 'reserved'/);
  assert.match(CLAIM_SHARD_TRANSFER_SQL, /RETURNING request_id/);
});
test("uncertain transfers remain recorded for reconciliation", () => {
  assert.match(MARK_SHARD_TRANSFER_UNKNOWN_SQL, /state = 'unknown'/);
  assert.match(RECORD_SHARD_TRANSFER_ACCEPTANCE_SQL, /exchange_transfer_id = \$2::text/);
});
test("ledger enforces shard and amount boundaries", () => {
  assert.match(CREATE_SHARD_TRANSFER_LEDGER_SQL, /source_shard IN \(0, 2\)/);
  assert.match(CREATE_SHARD_TRANSFER_LEDGER_SQL, /destination_shard IN \(0, 2\)/);
  assert.match(CREATE_SHARD_TRANSFER_LEDGER_SQL, /amount_cents BETWEEN 1 AND 100000/);
});

test("lookup and reconciliation are restricted to the existing unique request", () => {
  assert.match(GET_SHARD_TRANSFER_SQL, /WHERE request_id = \$1::uuid/);
  assert.match(MARK_SHARD_TRANSFER_COMPLETED_SQL, /exchange_transfer_id = \$2::text/);
  assert.match(MARK_SHARD_TRANSFER_COMPLETED_SQL, /state IN \('submitted', 'unknown'\)/);
  assert.match(MARK_SHARD_TRANSFER_RECONCILED_FAILED_SQL, /state IN \('unknown', 'submitted'\)/);
});
