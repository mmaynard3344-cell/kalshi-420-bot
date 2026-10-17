import { kalshiAuthFetch } from "./kalshiAuth.js";
import { SHARD_TRANSFER_CREATE_PATH } from "./shardTransferApiContract.js";
import type { buildShardTransferPayload } from "./shardTransferPayload.js";

/**
 * Single-attempt authenticated Kalshi transfer transport.
 * This module never submits on import. Caller MUST first enforce separate
 * operator auth, durable claim, and the default-off transfer gate.
 * The existing Kalshi auth client does not retry POST requests.
 */
export function createShardTransferKalshiTransport(
  post: (method: string, path: string, body: unknown) => Promise<unknown> = kalshiAuthFetch,
) {
  return async (payload: ReturnType<typeof buildShardTransferPayload>): Promise<unknown> =>
    post("POST", SHARD_TRANSFER_CREATE_PATH, payload);
}
