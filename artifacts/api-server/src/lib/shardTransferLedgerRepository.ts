import { pool } from "@workspace/db";
import type { ShardTransferRequest } from "./shardTransferSafety.js";
import {
  RESERVE_SHARD_TRANSFER_SQL,
  CLAIM_SHARD_TRANSFER_SQL,
  RECORD_SHARD_TRANSFER_ACCEPTANCE_SQL,
  MARK_SHARD_TRANSFER_UNKNOWN_SQL,
  GET_SHARD_TRANSFER_SQL,
} from "./shardTransferLedgerSql.js";

/**
 * Durable repository only. Never creates tables automatically and never calls
 * the exchange. Database schema must be installed in a disposable environment
 * and explicitly verified before wiring any money-moving route.
 */
export async function reserveShardTransfer(request: ShardTransferRequest): Promise<boolean> {
  const result = await pool.query(RESERVE_SHARD_TRANSFER_SQL, [
    request.requestId, request.sourceExchangeShard,
    request.destinationExchangeShard, request.amountCents,
  ]);
  return result.rowCount === 1;
}
export async function claimShardTransfer(requestId: string): Promise<boolean> {
  const result = await pool.query(CLAIM_SHARD_TRANSFER_SQL, [requestId]);
  return result.rowCount === 1;
}
export async function recordShardTransferAcceptance(requestId: string, transferId: string): Promise<void> {
  const result = await pool.query(RECORD_SHARD_TRANSFER_ACCEPTANCE_SQL, [requestId, transferId]);
  if (result.rowCount !== 1) throw new Error("Unable to persist Kalshi transfer acceptance");
}
export async function markShardTransferUnknown(requestId: string): Promise<void> {
  const result = await pool.query(MARK_SHARD_TRANSFER_UNKNOWN_SQL, [requestId]);
  if (result.rowCount !== 1) throw new Error("Unable to mark transfer outcome unknown");
}
export async function readShardTransfer(requestId: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query(GET_SHARD_TRANSFER_SQL, [requestId]);
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}
