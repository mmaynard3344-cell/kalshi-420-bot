import { Router, type IRouter } from "express";
import {
  ListMarketsQueryParams,
  GetMarketParams,
  GetMarketResponse,
  GetMarketOrderbookParams,
  GetMarketOrderbookResponse,
  ListMarketsResponse,
} from "@workspace/api-zod";
import { kalshiFetch, normalizeMarket } from "../lib/kalshi";

const router: IRouter = Router();

// ── Short-lived cache for /markets list responses ─────────────────────────────
// The UI polls /markets every ~10 s per component; without a cache each poll
// creates a fresh Kalshi request that competes with the autoTrader REST fallback
// and reconcile timer, burning Kalshi rate-limit quota and causing 429s.
// 10 s TTL is short enough that price data stays fresh for the UI.
interface CacheEntry { data: unknown; expiresAt: number }
const listCache = new Map<string, CacheEntry>();
// 45 s matches the autoTrader reconcile interval — the UI gets a fresh snapshot
// every reconcile cycle but doesn't independently burn Kalshi quota on each poll.
const LIST_CACHE_TTL_MS = 45_000;

function cacheKey(params: Record<string, unknown>): string {
  return JSON.stringify(params, Object.keys(params).sort());
}

router.get("/markets", async (req, res): Promise<void> => {
  const parsed = ListMarketsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const key = cacheKey(parsed.data as Record<string, unknown>);
  const cached = listCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.data);
    return;
  }

  try {
    const data = await kalshiFetch<{ markets?: unknown[]; cursor?: string }>("/markets", parsed.data);
    const normalized = {
      markets: (data.markets ?? []).map((m) => normalizeMarket(m as Record<string, unknown>)),
      cursor: data.cursor ?? null,
    };
    listCache.set(key, { data: normalized, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
    res.json(normalized);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    res.status(e.status ?? 502).json({ error: e.message ?? "Failed to fetch markets" });
  }
});

router.get("/markets/:ticker/orderbook", async (req, res): Promise<void> => {
  const params = GetMarketOrderbookParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const data = await kalshiFetch<unknown>(`/markets/${params.data.ticker}/orderbook`);
    const result = GetMarketOrderbookResponse.safeParse(data);
    res.json(result.success ? result.data : data);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    res.status(e.status ?? 502).json({ error: e.message ?? "Failed to fetch orderbook" });
  }
});

router.get("/markets/:ticker", async (req, res): Promise<void> => {
  const params = GetMarketParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const raw = await kalshiFetch<{ market?: Record<string, unknown> }>(`/markets/${params.data.ticker}`);
    const marketData = normalizeMarket((raw?.market ?? raw) as Record<string, unknown>);
    const result = GetMarketResponse.safeParse(marketData);
    res.json(result.success ? result.data : marketData);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 404) {
      res.status(404).json({ error: "Market not found" });
    } else {
      res.status(e.status ?? 502).json({ error: e.message ?? "Failed to fetch market" });
    }
  }
});

export default router;
