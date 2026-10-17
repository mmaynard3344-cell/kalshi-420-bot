import { SHARD_TRANSFER_CREATE_PATH } from "./shardTransferApiContract.js";
import type { buildShardTransferPayload } from "./shardTransferPayload.js";

export type TransferPost = (method: string, path: string, body: unknown) => Promise<unknown>;

/**
 * A transport adapter with no side effects on import.
 * The caller supplies the signed Kalshi client only after authentication,
 * durable reservation and the manual-transfer gate are independently enforced.
 * This module is safe to test without initializing the trading runtime.
 */
export function createShardTransferKalshiTransport(post: TransferPost) {
  return async (payload: ReturnType<typeof buildShardTransferPayload>): Promise<unknown> =>
    post("POST", SHARD_TRANSFER_CREATE_PATH, payload);
}
