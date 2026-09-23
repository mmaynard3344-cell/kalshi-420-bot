import { logger } from "./logger";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ── Exponential backoff with jitter on 429 ────────────────────────────────────
// Attempts: 1st retry after ~15 s, 2nd after ~30 s, 3rd after ~60 s.
// Jitter of ±20 % prevents synchronized retries when multiple callers back off.
async function fetchWithBackoff(url: URL, options: RequestInit): Promise<Response> {
  let baseDelayMs = 15_000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url.toString(), options);
    if (resp.status !== 429) return resp;

    const retryAfterSec = parseInt(resp.headers.get("Retry-After") ?? "", 10);
    const base = isNaN(retryAfterSec)
      ? baseDelayMs
      : Math.max(retryAfterSec * 1_000, baseDelayMs);
    const jitter  = (Math.random() * 0.4 - 0.2) * base; // ±20 %
    const waitMs  = Math.min(Math.round(base + jitter), 60_000);

    logger.warn(
      { url: url.toString(), attempt: attempt + 1, waitMs },
      "Kalshi rate limited (429) — exponential backoff before retry",
    );
    await new Promise<void>((r) => setTimeout(r, waitMs));
    baseDelayMs = Math.min(baseDelayMs * 2, 60_000); // 15 s → 30 s → 60 s
  }
  // Final attempt — caller handles any remaining error
  return fetch(url.toString(), options);
}

export async function kalshiFetch<T>(
  path: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): Promise<T> {
  const url = new URL(`${KALSHI_BASE}${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetchWithBackoff(url, { headers: { Accept: "application/json" } });

  if (!response.ok) {
    logger.warn({ status: response.status, url: url.toString() }, "Kalshi API error");
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(`Kalshi API error ${response.status}`), {
      status: response.status,
      body:   text,
    });
  }

  return response.json() as Promise<T>;
}

// ── Per-series market data cache + request coalescing ─────────────────────────
//
// All components that need the current open market for a series
// (autoTrader REST fallback, reconcile timer, WS ticker refresh,
//  /api/markets UI route) call kalshiSeriesFetch().
//
// • Concurrent callers for the same series share ONE in-flight Promise — the
//   burst of 4-8 simultaneous Kalshi requests at window boundaries collapses
//   to at most ONE per series.
// • Results are cached for SERIES_CACHE_TTL_MS, so rapid-fire callers never
//   create duplicate HTTP requests within the same poll cycle.

const SERIES_CACHE_TTL_MS = 8_000;
/** Enough to cover the remaining 15-minute ETH markets in a trading day. */
const UNOPENED_MARKET_FETCH_LIMIT = 100;
const ETH_15M_SERIES = "KXETH15M";
const ETH_15M_BOUNDARY_MS = 15 * 60_000;

interface SeriesCacheEntry {
  raw:       Record<string, unknown> | null;
  fetchedAt: number;
}
const _seriesCache    = new Map<string, SeriesCacheEntry>();
const _seriesInflight = new Map<string, Promise<Record<string, unknown> | null>>();
export interface KalshiSeriesFetchOptions {
  /** Bypass a prior response, while still coalescing concurrent fresh callers. */
  forceFresh?: boolean;
  /** Defaults to the current active market. `unopened` is discovery-only. */
  status?: "open" | "unopened";
}

/**
 * Kalshi does not document an ordering guarantee for /markets. Unopened
 * discovery must therefore choose the nearest valid future market itself,
 * rather than trusting the first API row.
 */
export function selectNearestFutureUnopenedMarket(
  markets: Array<Record<string, unknown>>,
  nowMs: number,
): Record<string, unknown> | null {
  const futureMarkets = markets
    .map((market) => ({
      market,
      openTimeMs: typeof market["open_time"] === "string"
        ? Date.parse(market["open_time"])
        : NaN,
    }))
    .filter(({ openTimeMs }) => Number.isFinite(openTimeMs) && openTimeMs > nowMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  return futureMarkets[0]?.market ?? null;
}

/**
 * Returns the raw (un-normalized) market object for the current open window of
 * a series, or null if none is found or the request fails.
 *
 * Coalesces concurrent callers and caches for 8 s. For ETH 15-minute open-market
 * discovery, a cache entry fetched before the current wall-clock boundary is
 * never allowed to survive across that boundary. That preserves coalescing while
 * preventing a pre-boundary active ticker from being reused after the new market
 * should be live.
 */
export async function kalshiSeriesFetch(
  series: string,
  options: KalshiSeriesFetchOptions = {},
): Promise<Record<string, unknown> | null> {
  const status = options.status ?? "open";
  const cacheKey = `${series}:${status}`;
  const nowMs = Date.now();
  const cached = _seriesCache.get(cacheKey);
  const currentEthBoundaryMs = series === ETH_15M_SERIES && status === "open"
    ? Math.floor(nowMs / ETH_15M_BOUNDARY_MS) * ETH_15M_BOUNDARY_MS
    : null;
  const cacheCrossedEthBoundary = currentEthBoundaryMs != null
    && cached != null
    && cached.fetchedAt < currentEthBoundaryMs;
  const requiresFresh = options.forceFresh === true || cacheCrossedEthBoundary;

  if (!requiresFresh && cached && nowMs - cached.fetchedAt < SERIES_CACHE_TTL_MS) return cached.raw;

  // A boundary-fresh/force-fresh caller never attaches to a pre-boundary normal
  // request. Fresh callers still coalesce with one another via their separate key.
  const inflightKey = requiresFresh ? `${cacheKey}:fresh` : cacheKey;
  const inflight = _seriesInflight.get(inflightKey);
  if (inflight) return inflight;

  const promise = (async (): Promise<Record<string, unknown> | null> => {
    try {
      const data = await kalshiFetch<{ markets?: Array<Record<string, unknown>> }>(
        "/markets",
        {
          series_ticker: series,
          status,
          limit: status === "unopened" ? UNOPENED_MARKET_FETCH_LIMIT : 1,
        },
      );
      const raw = status === "unopened"
        ? selectNearestFutureUnopenedMarket(data.markets ?? [], Date.now())
        : data.markets?.[0] ?? null;
      _seriesCache.set(cacheKey, { raw, fetchedAt: Date.now() });
      return raw;
    } catch {
      return null;
    } finally {
      _seriesInflight.delete(inflightKey);
    }
  })();

  _seriesInflight.set(inflightKey, promise);
  return promise;
}

export const KALSHI_ETH_15M_INTERVAL_MS = 15 * 60_000;
export const KALSHI_ETH_15M_HISTORY_DAYS = 28;
const ETH_15M_BOOTSTRAP_MAX_PAGES = 10;

export interface KalshiEth15mHistoricalFact {
  ticker: string;
  openTimeMs: number;
  floorStrike: number;
}

export type KalshiSettledMarketPageFetcher = (params: {
  series_ticker: string; status: "settled"; limit: number; cursor?: string;
}) => Promise<{ markets?: Array<Record<string, unknown>>; cursor?: unknown }>;

function inspectEth15mHistoricalFact(raw: Record<string, unknown>): {
  fact: KalshiEth15mHistoricalFact | null; malformed: boolean; openTimeMs: number | null;
} {
  const ticker = raw["ticker"];
  const openTime = raw["open_time"];
  const floorStrike = raw["floor_strike"];
  const openTimeMs = typeof openTime === "string" ? Date.parse(openTime) : NaN;
  if (raw["status"] !== "finalized" || typeof ticker !== "string" || !/^KXETH15M-/.test(ticker)
    || !Number.isFinite(openTimeMs) || !Number.isInteger(openTimeMs)
    || openTimeMs % KALSHI_ETH_15M_INTERVAL_MS !== 0) return { fact: null, malformed: true, openTimeMs: null };
  // An otherwise well-formed finalized market with no usable strike is excluded
  // from moves, never guessed or substituted.
  if (typeof floorStrike !== "number" || !Number.isFinite(floorStrike) || floorStrike <= 0) {
    return { fact: null, malformed: false, openTimeMs };
  }
  return { fact: { ticker, openTimeMs, floorStrike }, malformed: false, openTimeMs };
}

/**
 * Reads a complete, current 28-day window from Kalshi's public settled catalog.
 * It deliberately returns null rather than a partial result: bootstrap history
 * must never create a threshold from a truncated or inconsistent page stream.
 */
export async function fetchCompleteEth15mSettledHistory(
  currentLiveOpenMs: number,
  fetchPage: KalshiSettledMarketPageFetcher = (params) => kalshiFetch("/markets", params),
): Promise<KalshiEth15mHistoricalFact[] | null> {
  if (!Number.isInteger(currentLiveOpenMs) || currentLiveOpenMs % KALSHI_ETH_15M_INTERVAL_MS !== 0) return null;
  const earliestRequiredMs = currentLiveOpenMs
    - KALSHI_ETH_15M_HISTORY_DAYS * 86_400_000
    - KALSHI_ETH_15M_INTERVAL_MS;
  const facts = new Map<string, KalshiEth15mHistoricalFact>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let hasExactPredecessor = false;
  for (let pageNumber = 0; pageNumber < ETH_15M_BOOTSTRAP_MAX_PAGES; pageNumber++) {
    let page: { markets?: Array<Record<string, unknown>>; cursor?: unknown };
    try {
      page = await fetchPage({ series_ticker: "KXETH15M", status: "settled", limit: 1000, cursor });
    } catch {
      return null;
    }
    if (!Array.isArray(page.markets)) return null;
    for (const raw of page.markets) {
      if (!raw || typeof raw !== "object") return null;
      const { fact, malformed, openTimeMs } = inspectEth15mHistoricalFact(raw);
      if (malformed) return null;
      // Reaching the boundary proves retrieval coverage even if its strike is
      // unusable; that strike merely removes the first adjacent pair.
      if (openTimeMs === earliestRequiredMs) hasExactPredecessor = true;
      if (!fact) continue; // Invalid/missing strikes are excluded, never repaired or inferred.
      const key = `${fact.ticker}:${fact.openTimeMs}`;
      const prior = facts.get(key);
      if (prior && prior.floorStrike !== fact.floorStrike) return null;
      facts.set(key, fact);
    }
    if (hasExactPredecessor) break;
    if (page.cursor == null || page.cursor === "") return null;
    if (typeof page.cursor !== "string" || cursors.has(page.cursor)) return null;
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
  if (!hasExactPredecessor) return null;
  return [...facts.values()]
    .filter((fact) => fact.openTimeMs >= earliestRequiredMs && fact.openTimeMs < currentLiveOpenMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs || a.ticker.localeCompare(b.ticker));
}

// ── Market normalization ───────────────────────────────────────────────────────

function dollarsToCents(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(String(val));
  if (isNaN(n)) return null;
  return Math.round(n * 100);
}

function fpToInt(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(String(val));
  if (isNaN(n)) return null;
  return Math.round(n);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeMarket(m: Record<string, any>): Record<string, unknown> {
  return {
    ticker:           m.ticker,
    event_ticker:     m.event_ticker,
    series_ticker:    m.series_ticker ?? null,
    // Orders must be routed to the same Kalshi exchange as their discovered
    // market. ETH markets currently use a non-default exchange index.
    exchange_index:   (() => {
      const raw = m.exchange_index;
      const parsed = typeof raw === "number" ? raw
        : typeof raw === "string" && /^\\d+$/.test(raw.trim()) ? Number(raw.trim())
        : NaN;
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    })(),
    title:            m.title,
    subtitle:         m.yes_sub_title ?? m.subtitle ?? null,
    status:           m.status === "active" ? "open" : (m.status ?? "unknown"),
    result:           m.result || null,
    yes_bid:          dollarsToCents(m.yes_bid_dollars)     ?? dollarsToCents(m.yes_bid),
    yes_ask:          dollarsToCents(m.yes_ask_dollars)     ?? dollarsToCents(m.yes_ask),
    no_bid:           dollarsToCents(m.no_bid_dollars)      ?? dollarsToCents(m.no_bid),
    no_ask:           dollarsToCents(m.no_ask_dollars)      ?? dollarsToCents(m.no_ask),
    last_price:       dollarsToCents(m.last_price_dollars)  ?? dollarsToCents(m.last_price),
    previous_price:   dollarsToCents(m.previous_price_dollars) ?? dollarsToCents(m.previous_price),
    volume:           fpToInt(m.volume_fp)     ?? (typeof m.volume     === "number" ? m.volume     : null),
    volume_24h:       fpToInt(m.volume_24h_fp) ?? (typeof m.volume_24h === "number" ? m.volume_24h : null),
    open_interest:    fpToInt(m.open_interest_fp) ?? (typeof m.open_interest === "number" ? m.open_interest : null),
    liquidity:        dollarsToCents(m.liquidity_dollars) ?? (typeof m.liquidity === "number" ? m.liquidity : null),
    close_time:       m.close_time       ?? null,
    expiration_time:  m.expiration_time  ?? null,
    open_time:        m.open_time        ?? null,
    category:         m.category         ?? null,
    risk_limit_cents: typeof m.risk_limit_cents === "number" ? m.risk_limit_cents : null,
    rules_primary:    m.rules_primary    ?? null,
    rules_secondary:  m.rules_secondary  ?? null,
    floor_strike:     typeof m.floor_strike === "number" ? m.floor_strike
                    : typeof m.cap_strike   === "number" ? m.cap_strike
                    : null,
  };
}