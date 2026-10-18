import { createOperatorSession } from "./shardTransferOperatorSession.js";
import { verifyShardTransferOperatorToken } from "./shardTransferOperatorAuth.js";

/**
 * Independent operator sign-in decision. Intentionally not exposed as a route.
 * Credentials must be sent through a separately protected HTTPS login flow
 * with per-identity rate limits, audit logs, and no browser-shipped secrets.
 */
export function issueShardOperatorSession(input: {
  presentedOperatorCredential: string | undefined;
  configuredOperatorCredential: string | undefined;
  sessionSigningKey: string | undefined;
  tradeTokens: readonly string[];
  nowMs?: number;
}): { token: string; csrf: string } | null {
  if (!verifyShardTransferOperatorToken(
    input.presentedOperatorCredential,
    input.configuredOperatorCredential,
    input.tradeTokens,
  )) return null;
  const key = input.sessionSigningKey;
  if (!key || Buffer.byteLength(key, "utf8") < 32 ||
      key === input.configuredOperatorCredential ||
      input.tradeTokens.includes(key)) return null;
  return createOperatorSession(key, input.nowMs);
}
