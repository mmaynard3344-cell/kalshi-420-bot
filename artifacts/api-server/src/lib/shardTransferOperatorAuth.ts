import { timingSafeEqual } from "node:crypto";

/** Independent secret. Never accept a trade-token or public dashboard token as transfer authority. */
export function verifyShardTransferOperatorToken(
  provided: string | undefined,
  operatorToken: string | undefined,
  tradeTokens: readonly string[],
): boolean {
  if (!operatorToken || operatorToken.length < 32 || !provided) return false;
  if (tradeTokens.some((token) => safeEqual(token, operatorToken))) return false;
  return safeEqual(provided, operatorToken);
}
function safeEqual(a: string, b: string): boolean {
  const lhs = Buffer.from(a, "utf8");
  const rhs = Buffer.from(b, "utf8");
  return lhs.length === rhs.length && timingSafeEqual(lhs, rhs);
}
