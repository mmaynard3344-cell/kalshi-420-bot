/**
 * Separate transfer execution from trading execution. Default-deny.
 * This does not invoke Kalshi and is safe to test.
 */
export function isManualShardTransferEnabled(env: Record<string, string | undefined>): boolean {
  return env["SHARD_TRANSFERS_ENABLED"] === "true"
    && env["SHARD_TRANSFER_OPERATOR_AUTH_CONFIGURED"] === "true"
    && env["SHARD_TRANSFER_IDEMPOTENCY_STORE_READY"] === "true";
}
export function requireManualShardTransferEnabled(env: Record<string, string | undefined>): void {
  if (!isManualShardTransferEnabled(env)) {
    throw new Error("Manual shard transfers are disabled until authentication and durable duplicate protection are configured");
  }
}
