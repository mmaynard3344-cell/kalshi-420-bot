/**
 * Database-backed idempotency contract for operator-initiated shard transfers.
 * No migrations or transfers run by importing this module.
 *
 * request_id is the one-time idempotency key. Once reserved, a request ID
 * can never be reused — including when submission times out or fails.
 */
export const CREATE_SHARD_TRANSFER_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS operator_shard_transfers (
  request_id uuid PRIMARY KEY,
  source_shard integer NOT NULL CHECK (source_shard IN (0, 2)),
  destination_shard integer NOT NULL CHECK (destination_shard IN (0, 2)),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000),
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'submitting', 'submitted', 'completed', 'failed', 'unknown')),
  exchange_transfer_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_shard <> destination_shard)
);
`;

export const RESERVE_SHARD_TRANSFER_SQL = `
INSERT INTO operator_shard_transfers
  (request_id, source_shard, destination_shard, amount_cents, state)
VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'reserved')
ON CONFLICT (request_id) DO NOTHING
RETURNING request_id;
`;

export const CLAIM_SHARD_TRANSFER_SQL = `
UPDATE operator_shard_transfers
SET state = 'submitting', updated_at = now()
WHERE request_id = $1::uuid AND state = 'reserved'
RETURNING request_id, source_shard, destination_shard, amount_cents;
`;

export const RECORD_SHARD_TRANSFER_ACCEPTANCE_SQL = `
UPDATE operator_shard_transfers
SET state = 'submitted', exchange_transfer_id = $2::text, updated_at = now()
WHERE request_id = $1::uuid AND state IN ('submitting', 'unknown')
RETURNING request_id;
`;

export const MARK_SHARD_TRANSFER_UNKNOWN_SQL = `
UPDATE operator_shard_transfers
SET state = 'unknown', updated_at = now()
WHERE request_id = $1::uuid AND state = 'submitting'
RETURNING request_id;
`;
