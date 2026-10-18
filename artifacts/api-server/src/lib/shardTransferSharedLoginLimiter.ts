import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

/**
 * Distributed fail-closed login throttle. Requires the migration to be applied
 * before enabling operator login; no implicit table creation in a live request.
 */
export const SHARD_OPERATOR_LOGIN_LIMIT_SQL = `
INSERT INTO shard_operator_login_attempts (identity_hash, window_start_ms, attempts)
VALUES ($1, $2, 1)
ON CONFLICT (identity_hash) DO UPDATE SET
 window_start_ms = CASE WHEN shard_operator_login_attempts.window_start_ms <= $3
   THEN EXCLUDED.window_start_ms ELSE shard_operator_login_attempts.window_start_ms END,
 attempts = CASE WHEN shard_operator_login_attempts.window_start_ms <= $3
   THEN 1 ELSE shard_operator_login_attempts.attempts + 1 END
RETURNING attempts, window_start_ms
`;

export async function allowSharedShardOperatorLogin(identity: string, nowMs = Date.now()): Promise<boolean> {
  if (!identity || identity.length > 256 || !Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  const hash = createHash("sha256").update(identity).digest("hex");
  const windowMs = 15 * 60_000;
  try {
    const result = await pool.query(SHARD_OPERATOR_LOGIN_LIMIT_SQL, [hash, nowMs, nowMs - windowMs]);
    const row = result.rows[0] as { attempts?: number; window_start_ms?: string | number } | undefined;
    return !!row && Number(row.attempts) <= 3 && Number(row.window_start_ms) <= nowMs;
  } catch {
    return false;
  }
}
