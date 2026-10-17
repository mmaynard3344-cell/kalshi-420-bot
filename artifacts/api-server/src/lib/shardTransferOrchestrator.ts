import { validateShardTransferRequest } from "./shardTransferSafety.js";
import type { ShardTransferRequest } from "./shardTransferSafety.js";

/**
 * Fail-closed orchestration for manual transfers.
 * Injection keeps this module independent of the trading engine and permits
 * tests with a fake exchange and fake durable database.
 *
 * IMPORTANT: This must only be called behind separately verified operator
 * authentication and a durable, unique reservation.
 */
export interface ShardTransferDependencies {
  /** Must atomically insert a unique durable reservation before any POST. */
  reserve(request: ShardTransferRequest): Promise<boolean>;
  /** Must atomically claim an existing reserved request. */
  claim(requestId: string): Promise<boolean>;
  /** Live uncached exchange-scoped available balance. */
  freshAvailableCents(shard: 0 | 2): Promise<number>;
  /** Performs exactly one exchange POST; never retries automatically. */
  submitOnce(request: ShardTransferRequest): Promise<{transferId: string}>;
  /** Persist returned exchange ID; errors must be raised to an operator. */
  accepted(requestId: string, transferId: string): Promise<void>;
  /** Mark uncertain outcome for manual/exchange reconciliation. */
  unknown(requestId: string): Promise<void>;
  /** Mark a request failed when no exchange submission was attempted. */
  failedBeforeSubmission(requestId: string): Promise<void>;
}
export type ShardTransferOutcome =
  | { status: "duplicate" }
  | { status: "insufficient_balance" }
  | { status: "submitted"; transferId: string }
  | { status: "unknown" };

export async function submitManualShardTransfer(
  raw: unknown,
  deps: ShardTransferDependencies,
): Promise<ShardTransferOutcome> {
  const request = validateShardTransferRequest(raw);
  // Fail without side effects when source data cannot be confirmed.
  const available = await deps.freshAvailableCents(request.sourceExchangeShard);
  if (!Number.isSafeInteger(available) || available < request.amountCents) {
    return {status: "insufficient_balance"};
  }
  if (!await deps.reserve(request)) return {status: "duplicate"};
  if (!await deps.claim(request.requestId)) return {status: "duplicate"};

  let posted = false;
  try {
    // Once this line is reached, a timeout is UNCERTAIN, never safe to retry.
    posted = true;
    const result = await deps.submitOnce(request);
    if (!result.transferId) throw new Error("Exchange did not return a transfer ID");
    await deps.accepted(request.requestId, result.transferId);
    return {status: "submitted", transferId: result.transferId};
  } catch (error) {
    if (posted) {
      // If reconciliation persistence fails, surface the failure and keep
      // the claimed DB row non-retryable. Never submit again.
      await deps.unknown(request.requestId);
      return {status: "unknown"};
    }
    await deps.failedBeforeSubmission(request.requestId);
    throw error;
  }
}
