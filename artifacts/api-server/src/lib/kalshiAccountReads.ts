/**
 * Coordinated, quota-aware read path for authenticated Kalshi account views.
 *
 * Dashboard-facing reads (balance, positions, fills) all flow through
 * quota-aware single-flight caches that share one rate-limit gate:
 *
 *   - Concurrent callers coalesce into one upstream request (single-flight).
 *   - A fresh successful value is reused for the cache TTL, so any number of
 *     open browser tabs polling the API server cannot multiply exchange calls.
 *   - A Kalshi HTTP 429 trips a shared cooldown gate. While the gate is
 *     closed, NO cached read path issues new upstream requests — callers are
 *     served the last known value marked `stale` instead of producing a
 *     retry burst.
 *   - Non-429 upstream failures also serve the last known value as stale
 *     when one exists, so a transient blip degrades to stale data rather
 *     than an error page.
 *
 * Order-safety paths (order placement, per-order fill reconciliation,
 * protective exits) intentionally do NOT use these caches: they must always
 * see live exchange state and their error handling is fail-closed.
 */

import { kalshiAuthFetch } from "./kalshiAuth.js";

/** How long a 429 pauses all cached account reads. */
export const RATE_LIMIT_COOLDOWN_MS = 15_000;

/** Positions change at fill/settlement cadence — 15 s freshness is plenty
 * for a dashboard that polls every 30–60 s. */
export const POSITIONS_CACHE_TTL_MS = 15_000;

/** Fills views are paginated history reads; same dashboard cadence. */
export const FILLS_CACHE_TTL_MS = 15_000;

export function isRateLimitError(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 429;
}

/**
 * Shared cooldown gate. One 429 from any cached account read closes the gate
 * for every cached account read, because Kalshi's limit is account-wide.
 */
export function createRateLimitGate(now: () => number = Date.now) {
  let blockedUntil = 0;
  return {
    trip(cooldownMs: number = RATE_LIMIT_COOLDOWN_MS): void {
      const until = now() + cooldownMs;
      if (until > blockedUntil) blockedUntil = until;
    },
    isBlocked(): boolean {
      return now() < blockedUntil;
    },
  };
}

export type RateLimitGate = ReturnType<typeof createRateLimitGate>;

export interface CachedRead<T> {
  value: T;
  /** True when the value is older than the TTL and was served because the
   * upstream is rate-limited or temporarily failing. */
  stale: boolean;
}

/**
 * Quota-aware single-flight cache.
 *
 * Success values are cached for `ttlMs` and additionally retained as a
 * last-known-good fallback. A 429 trips the shared gate and is surfaced as
 * stale data (when possible) instead of an error; while the gate is closed no
 * upstream request is issued at all.
 */
export function createQuotaAwareCache<T>(opts: {
  ttlMs: number;
  gate: RateLimitGate;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  let fresh: { value: T; expiresAt: number } | null = null;
  let lastKnown: T | null = null;
  let hasLastKnown = false;
  let inFlight: Promise<CachedRead<T>> | null = null;

  return {
    get(load: () => Promise<T>): Promise<CachedRead<T>> {
      if (fresh && fresh.expiresAt > now()) {
        return Promise.resolve({ value: fresh.value, stale: false });
      }
      if (inFlight) return inFlight;

      // Rate-limit cooldown: never touch the exchange; serve stale or fail.
      if (opts.gate.isBlocked()) {
        if (hasLastKnown) return Promise.resolve({ value: lastKnown as T, stale: true });
        return Promise.reject(
          Object.assign(new Error("Kalshi rate limited — no cached value available"), { status: 429 }),
        );
      }

      const request = load().then(
        (value): CachedRead<T> => {
          fresh = { value, expiresAt: now() + opts.ttlMs };
          lastKnown = value;
          hasLastKnown = true;
          return { value, stale: false };
        },
        (err: unknown): CachedRead<T> => {
          if (isRateLimitError(err)) opts.gate.trip();
          if (hasLastKnown) return { value: lastKnown as T, stale: true };
          throw err;
        },
      );
      inFlight = request;
      void request.then(
        () => { if (inFlight === request) inFlight = null; },
        () => { if (inFlight === request) inFlight = null; },
      );
      return request;
    },
    clear(): void {
      fresh = null;
    },
  };
}

/**
 * Keyed variant for parameterised reads (e.g. fills pages by limit). Each key
 * has its own cache; all keys share the rate-limit gate.
 */
export function createKeyedQuotaAwareCache<T>(opts: {
  ttlMs: number;
  gate: RateLimitGate;
  now?: () => number;
  maxKeys?: number;
}) {
  const caches = new Map<string, ReturnType<typeof createQuotaAwareCache<T>>>();
  const maxKeys = opts.maxKeys ?? 32;
  return {
    get(key: string, load: () => Promise<T>): Promise<CachedRead<T>> {
      let cache = caches.get(key);
      if (!cache) {
        // Bound memory: drop the oldest key when the map grows past the cap.
        if (caches.size >= maxKeys) {
          const oldest = caches.keys().next().value;
          if (oldest !== undefined) caches.delete(oldest);
        }
        cache = createQuotaAwareCache<T>(opts);
        caches.set(key, cache);
      }
      return cache.get(load);
    },
  };
}

// ── Shared instances used by the API routes ─────────────────────────────────

export const kalshiAccountReadGate = createRateLimitGate();

type PositionsResponse = {
  market_positions?: Array<Record<string, unknown>>;
  event_positions?: Array<Record<string, unknown>>;
};

const positionsCache = createQuotaAwareCache<PositionsResponse>({
  ttlMs: POSITIONS_CACHE_TTL_MS,
  gate: kalshiAccountReadGate,
});

/** Shared, coalesced GET /portfolio/positions?limit=100 for account views. */
export function fetchSharedKalshiPositions(): Promise<CachedRead<PositionsResponse>> {
  return positionsCache.get(() =>
    kalshiAuthFetch<PositionsResponse>("GET", "/portfolio/positions?limit=100"),
  );
}

export const sharedFillsViewCache = createKeyedQuotaAwareCache<unknown>({
  ttlMs: FILLS_CACHE_TTL_MS,
  gate: kalshiAccountReadGate,
});
