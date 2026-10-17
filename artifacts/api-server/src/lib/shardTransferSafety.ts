/**
 * Manual shard transfer validation. No trading strategy imports.
 * Transfers remain disabled unless SHARD_TRANSFERS_ENABLED is explicitly true.
 */
export type ShardTransferRequest = {
  sourceExchangeShard: 0 | 2;
  destinationExchangeShard: 0 | 2;
  amountCents: number;
  confirmation: string;
  requestId: string;
};
export function validateShardTransferRequest(value: unknown): ShardTransferRequest {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid transfer request");
  const v = value as Record<string, unknown>;
  const source = v["sourceExchangeShard"];
  const destination = v["destinationExchangeShard"];
  if (!((source === 0 && destination === 2) || (source === 2 && destination === 0))) {
    throw new Error("Only transfers between shard 0 and shard 2 are allowed");
  }
  const amount = v["amountCents"];
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > 100_000) {
    throw new Error("Transfer must be between $0.01 and $1,000.00");
  }
  if (v["confirmation"] !== `TRANSFER $${(amount / 100).toFixed(2)} FROM ${source} TO ${destination}`) {
    throw new Error("Transfer confirmation does not match");
  }
  if (typeof v["requestId"] !== "string" || !/^[0-9a-f-]{36}$/i.test(v["requestId"])) {
    throw new Error("A unique request ID is required");
  }
  return {sourceExchangeShard: source, destinationExchangeShard: destination, amountCents: amount, confirmation: v["confirmation"], requestId: v["requestId"]};
}
