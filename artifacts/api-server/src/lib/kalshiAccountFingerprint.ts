/**
 * Kalshi account-history fingerprint.
 *
 * Computes a one-way hash of the account's oldest fill record. Because each
 * fill is immutable and tied to exactly one Kalshi account, the oldest fill's
 * fingerprint is a stable, account-scoped identity signal that:
 *   - requires a successful authenticated Kalshi API call to obtain
 *   - never exposes a credential or a raw account identifier
 *   - is directly comparable between two environments to confirm whether they
 *     reach the same Kalshi account (same fingerprint ↔ same account history)
 *
 * The function is safe to call frequently: a 1-hour in-process cache avoids
 * repeated full-history pagination.
 */

import { createHash } from "crypto";
import { kalshiAuthFetch } from "./kalshiAuth.js";

/** Maximum fills to paginate through before giving up. Mirrors dailyProfitStop. */
const MAX_FILLS = 50_000;

/** Cache TTL: the oldest fill never changes, so an hour is conservative. */
const CACHE_TTL_MS = 60 * 60_000;

export type AccountFingerprintStatus =
  | {
      status: "ok";
      fingerprint: string;
      fingerprint_algorithm: "sha256(fill_id+created_time+ticker).slice(0,16)";
      oldest_fill_at: string;
      fills_scanned: number;
      source: "GET /portfolio/fills (authenticated)";
      computed_at: string;
    }
  | {
      status: "no_fills";
      fingerprint: null;
      fills_scanned: 0;
      source: "GET /portfolio/fills (authenticated)";
      computed_at: string;
      reason: "Account has no fill history";
    }
  | {
      status: "unavailable";
      fingerprint: null;
      source: "GET /portfolio/fills (authenticated)";
      computed_at: string;
      auth_error: string;
    };

let _cache: { expiresAt: number; status: AccountFingerprintStatus } | null = null;

/** Test seam — replaces kalshiAuthFetch in unit tests. */
type KalshiFetch = <T>(method: string, path: string) => Promise<T>;
let _fetchForTesting: KalshiFetch | null = null;
export function _setAccountFingerprintFetchForTesting(fn: KalshiFetch | null): void {
  _fetchForTesting = fn;
  _cache = null;
}

function fetchKalshi<T>(method: string, path: string): Promise<T> {
  return (_fetchForTesting ?? kalshiAuthFetch)<T>(method, path);
}

type FillPage = { fills?: Array<{ fill_id?: unknown; created_time?: unknown; ticker?: unknown; market_ticker?: unknown }>; cursor?: string };

/**
 * Compute (or return cached) account-history fingerprint.
 *
 * Paginates through all fills on the authenticated Kalshi account to locate
 * the oldest fill record, then returns a one-way hash of that record's stable
 * fields (fill_id + created_time + ticker). On any auth or network failure the
 * status is "unavailable" so callers can distinguish "different account" from
 * "could not reach Kalshi".
 */
export async function getAccountHistoryFingerprint(): Promise<AccountFingerprintStatus> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now) return _cache.status;

  const computedAt = new Date(now).toISOString();

  try {
    let cursor: string | undefined;
    let fillsScanned = 0;

    // Track the oldest fill seen: compare by created_time ascending.
    let oldestFillId: string | null = null;
    let oldestCreatedTime: string | null = null;
    let oldestTicker: string | null = null;

    for (;;) {
      const qs = new URLSearchParams({ limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const page = await fetchKalshi<FillPage>("GET", `/portfolio/fills?${qs}`);

      const fills = Array.isArray(page.fills) ? page.fills : [];
      fillsScanned += fills.length;

      for (const fill of fills) {
        const fillId = typeof fill.fill_id === "string" && fill.fill_id.trim() ? fill.fill_id : null;
        const createdTime = typeof fill.created_time === "string" && fill.created_time.trim() ? fill.created_time : null;
        // market_ticker is the more specific field; fall back to ticker.
        const ticker = typeof fill.market_ticker === "string" && fill.market_ticker.trim()
          ? fill.market_ticker
          : typeof fill.ticker === "string" && fill.ticker.trim()
            ? fill.ticker
            : null;

        if (!fillId || !createdTime) continue;

        // Identify the chronologically oldest fill: take the earliest created_time.
        if (
          oldestCreatedTime === null ||
          createdTime < oldestCreatedTime // ISO 8601 strings sort lexicographically
        ) {
          oldestFillId = fillId;
          oldestCreatedTime = createdTime;
          oldestTicker = ticker;
        }
      }

      const nextCursor = typeof page.cursor === "string" && page.cursor.length > 0 ? page.cursor : undefined;
      if (!nextCursor || fillsScanned >= MAX_FILLS) break;
      cursor = nextCursor;
    }

    if (oldestFillId === null || oldestCreatedTime === null) {
      const status: AccountFingerprintStatus = {
        status: "no_fills",
        fingerprint: null,
        fills_scanned: 0,
        source: "GET /portfolio/fills (authenticated)",
        computed_at: computedAt,
        reason: "Account has no fill history",
      };
      // Cache briefly — account could get its first fill soon.
      _cache = { expiresAt: now + 5 * 60_000, status };
      return status;
    }

    const hashInput = [oldestFillId, oldestCreatedTime, oldestTicker ?? ""].join("|");
    const fingerprint = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

    const status: AccountFingerprintStatus = {
      status: "ok",
      fingerprint,
      fingerprint_algorithm: "sha256(fill_id+created_time+ticker).slice(0,16)",
      oldest_fill_at: oldestCreatedTime,
      fills_scanned: fillsScanned,
      source: "GET /portfolio/fills (authenticated)",
      computed_at: computedAt,
    };
    _cache = { expiresAt: now + CACHE_TTL_MS, status };
    return status;
  } catch (err) {
    const authError = err instanceof Error ? err.message : String(err);
    const status: AccountFingerprintStatus = {
      status: "unavailable",
      fingerprint: null,
      source: "GET /portfolio/fills (authenticated)",
      computed_at: computedAt,
      auth_error: authError,
    };
    // Cache error briefly to avoid hammering Kalshi on repeated calls.
    _cache = { expiresAt: now + 30_000, status };
    return status;
  }
}
