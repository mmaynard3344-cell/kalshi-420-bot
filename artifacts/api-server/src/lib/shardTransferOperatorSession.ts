import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless, short-lived operator session primitives. Not wired to production
 * routes. The server must authenticate the operator independently before
 * issuing a session; never use the dashboard trade token as that proof.
 */
export const SHARD_OPERATOR_SESSION_MAX_AGE_SECONDS = 900;
export const SHARD_OPERATOR_COOKIE_NAME = "__Host-shard_operator";
export const SHARD_OPERATOR_COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Strict; Path=/";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
function validSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 32;
}
export function createOperatorSession(secret: string, nowMs: number = Date.now()) {
  if (!validSecret(secret) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Session configuration invalid");
  const csrf = randomBytes(32).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ version: 1, issuedAt: nowMs, nonce, csrf }), "utf8").toString("base64url");
  return { token: payload + "." + sign(payload, secret), csrf };
}
export function validateOperatorSession(token: string | undefined, secret: string | undefined, nowMs: number = Date.now()): { csrf: string } | null {
  if (!validSecret(secret) || !token || token.length > 1024 || !Number.isSafeInteger(nowMs)) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const provided = Buffer.from(parts[1], "utf8");
  const expected = Buffer.from(sign(parts[0], secret), "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    if (data.version !== 1 || typeof data.issuedAt !== "number" || !Number.isSafeInteger(data.issuedAt)
      || data.issuedAt > nowMs || nowMs - data.issuedAt > SHARD_OPERATOR_SESSION_MAX_AGE_SECONDS * 1000
      || typeof data.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.csrf)
      || typeof data.nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(data.nonce)) return null;
    return { csrf: data.csrf };
  } catch { return null; }
}
export function validateOperatorCsrf(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a,b);
}
