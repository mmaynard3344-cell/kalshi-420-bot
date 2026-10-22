import { kalshiAuthFetch } from "./kalshiAuth.js";
import { getFreshShardTransferBalanceCents } from "./shardTransferFreshBalance.js";
import { buildShardTransferPayload } from "./shardTransferPayload.js";
import { createShardTransferKalshiTransport } from "./shardTransferKalshiTransport.js";
import { makeShardTransferDependencies } from "./shardTransferSubmissionAdapter.js";
import { submitManualShardTransfer } from "./shardTransferOrchestrator.js";

/**
 * Construct the verified signed transport and durable orchestration dependencies
 * without invoking either. The cash balance reader must be an independent,
 * uncached, exchange-scoped source injected by the operator-only controller.
 *
 * DO NOT CALL from public or trading routes before operator and CSRF protections,
 * schema migration, and an explicit production release decision.
 */
export function createUnenabledShardTransferRuntime(
  uncachedAvailableBalanceCents: (shard: 0 | 2) => Promise<number> = getFreshShardTransferBalanceCents,
) {
  const deps = makeShardTransferDependencies({
    uncachedAvailableBalanceCents,
    submitTransferOnce: createShardTransferKalshiTransport(
      (method, path, body) => kalshiAuthFetch(method, path, body),
    ),
  });
  return {
    // No authorization is performed by this helper. Do not expose it as a route.
    submit: (raw: unknown) => submitManualShardTransfer(raw, deps),
  };
}
