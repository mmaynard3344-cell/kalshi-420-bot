/**
 * submitOrder — authenticated order submission with tier-version enforcement.
 *
 * Always fetches the current canonical tier list from GET /api/trade/tiers
 * before submitting, then includes the server-returned `version` as
 * `tier_version` in the POST body.  This ensures a browser client with stale
 * tier definitions is caught and rejected by the server before any dedup slot
 * or daily budget is reserved.
 *
 * The server's POST /trade/order requires tier_version — omitting it returns
 * HTTP 400; a version mismatch returns HTTP 409.  Both errors are surfaced as
 * thrown Error objects so callers can display the reason to the user.
 */

import { getTradeToken } from './tradeToken';

export interface OrderRequest {
  ticker:               string;
  side:                 'yes' | 'no';
  count:                number;
  outcome_price_cents:  number;
  trigger_bid_cents?:   number;
  client_order_id:      string;
}

export interface OrderResponse {
  order_id?:  string;
  status?:    string;
  [key: string]: unknown;
}

interface TiersPayload {
  tiers: Array<{ label: string; min: number; max: number }>;
  version: string;
}

/** Cached tier version — refreshed on every mismatch (409) from the server. */
let cachedTierVersion: string | null = null;

async function fetchTierVersion(): Promise<string> {
  const r = await fetch('/api/trade/tiers', { cache: 'no-store' });
  if (!r.ok) throw new Error(`GET /api/trade/tiers failed: ${r.status}`);
  const data = (await r.json()) as TiersPayload;
  if (!data.version) throw new Error('GET /api/trade/tiers returned no version field');
  cachedTierVersion = data.version;
  return data.version;
}

/**
 * Submit a single order.  Automatically:
 *   1. Fetches (or reuses) the current tier version from the server.
 *   2. Includes `tier_version` in the POST body.
 *   3. On HTTP 409 (version mismatch) clears the cache and retries once with a
 *      freshly fetched version — handles the case where a new server deploy
 *      changed the tiers between the fetch and the submit.
 *
 * Throws on any non-2xx response after the retry.
 */
export async function submitOrder(order: OrderRequest): Promise<OrderResponse> {
  const token = await getTradeToken();
  if (!token) throw new Error('Could not obtain trade auth token');

  // ── Attempt 1 (possibly with cached version) ─────────────────────────────
  const tierVersion = cachedTierVersion ?? (await fetchTierVersion());
  const body = { ...order, tier_version: tierVersion };

  const r1 = await fetch('/api/trade/order', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trade-Token': token },
    body:    JSON.stringify(body),
  });

  // HTTP 409 may mean tier version mismatch OR a dedup/position-guard block.
  // Only retry for tier version mismatches — the server includes
  // `server_tier_version` in the body or the error mentions "tier_version".
  // Dedup and position-guard 409s must NOT be retried; they are final.
  if (r1.status === 409) {
    const detail409 = await r1.json().catch(() => ({})) as Record<string, unknown>;
    const isTierMismatch =
      ('server_tier_version' in detail409) ||
      (typeof detail409['error'] === 'string' &&
        (detail409['error'] as string).includes('tier_version'));

    if (!isTierMismatch) {
      // Dedup slot held or position guard — do not retry.
      throw new Error(`Order failed (409): ${String(detail409['error'] ?? r1.statusText)}`);
    }

    cachedTierVersion = null;
    const freshVersion = await fetchTierVersion();
    const r2 = await fetch('/api/trade/order', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trade-Token': token },
      body:    JSON.stringify({ ...order, tier_version: freshVersion }),
    });
    if (!r2.ok) {
      const detail = await r2.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(`Order failed (${r2.status}): ${String(detail['error'] ?? r2.statusText)}`);
    }
    return (await r2.json()) as OrderResponse;
  }

  if (!r1.ok) {
    const detail = await r1.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Order failed (${r1.status}): ${String(detail['error'] ?? r1.statusText)}`);
  }
  return (await r1.json()) as OrderResponse;
}
