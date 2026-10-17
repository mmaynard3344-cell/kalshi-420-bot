/** Kalshi transfer endpoint paths. No network calls in this module. */
export const SHARD_TRANSFER_CREATE_PATH = "/portfolio/intra_exchange_instance_transfer";
export const SHARD_TRANSFER_HISTORY_PATH = "/portfolio/intra_exchange_instance_transfers";
export function parseShardTransferCreationResponse(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Missing transfer acceptance response");
  }
  const id = (raw as Record<string, unknown>)["transfer_id"];
  if (typeof id !== "string" || !id.trim() || id.length > 256) {
    throw new Error("Exchange did not return a valid transfer_id; outcome uncertain");
  }
  return id;
}
