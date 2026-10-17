import { validateShardTransferRequest } from "./shardTransferSafety.js";
import { buildShardTransferPayload } from "./shardTransferPayload.js";

/**
 * Operator-visible preflight. Pure calculation, never queries or submits
 * to Kalshi. A preview is NOT authorization to transfer funds.
 */
export function previewManualShardTransfer(raw: unknown) {
  const request = validateShardTransferRequest(raw);
  const payload = buildShardTransferPayload(request);
  return {
    requestId: request.requestId,
    sourceShard: request.sourceExchangeShard,
    destinationShard: request.destinationExchangeShard,
    amountCents: request.amountCents,
    exchangeAmount: payload.amount,
    wouldSubmit: false as const,
    warning: "Preview only; no exchange transfer requested",
  };
}
