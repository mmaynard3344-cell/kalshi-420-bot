import { validateShardTransferRequest } from "./shardTransferSafety.js";

/**
 * Pure request formatter; does NOT submit a transfer.
 * Kalshi's intra-account transfer amount uses centicents (1/10,000 USD).
 * The dashboard accepts integer cents, so multiply by 100 exactly.
 * This module makes no network calls and is safe to test without moving money.
 */
export function buildShardTransferPayload(input: unknown) {
  const transfer = validateShardTransferRequest(input);
  const amount = transfer.amountCents * 100;
  if (!Number.isSafeInteger(amount)) throw new Error("Transfer amount is out of range");
  return {
    source: "event_contract" as const,
    client_transfer_id: transfer.requestId,
    destination: "event_contract" as const,
    source_exchange_shard: transfer.sourceExchangeShard,
    destination_exchange_shard: transfer.destinationExchangeShard,
    source_subaccount: 0,
    destination_subaccount: 0,
    amount,
  };
}
