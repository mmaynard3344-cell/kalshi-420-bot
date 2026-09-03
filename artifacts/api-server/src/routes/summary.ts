import { Router, type IRouter } from "express";
import { GetSummaryResponse, ListSeriesResponse } from "@workspace/api-zod";
import { kalshiFetch, normalizeMarket } from "../lib/kalshi";

const router: IRouter = Router();

router.get("/summary", async (req, res): Promise<void> => {
  try {
    // Fetch open markets sorted by volume for top/trending
    const [marketsData, eventsData] = await Promise.all([
      kalshiFetch<{ markets?: unknown[]; cursor?: string }>(
        "/markets",
        { limit: 100, status: "open" },
      ),
      kalshiFetch<{ events?: unknown[]; cursor?: string }>(
        "/events",
        { limit: 200, status: "open" },
      ),
    ]);

    const rawMarkets = Array.isArray(marketsData?.markets) ? marketsData.markets : [];
    const markets = rawMarkets.map((m) => normalizeMarket(m as Record<string, unknown>));
    const totalEvents = Array.isArray(eventsData?.events) ? eventsData.events.length : 0;

    // Sort by volume descending for top volume
    const byVolume = [...markets].sort((a, b) => {
      const av = (a.volume as number) ?? 0;
      const bv = (b.volume as number) ?? 0;
      return bv - av;
    });

    // Sort by volume_24h descending for trending
    const byTrending = [...markets].sort((a, b) => {
      const av = (a.volume_24h as number) ?? 0;
      const bv = (b.volume_24h as number) ?? 0;
      return bv - av;
    });

    const summary = {
      total_open_markets: markets.length,
      total_events: totalEvents,
      top_volume_markets: byVolume.slice(0, 10),
      trending_markets: byTrending.slice(0, 10),
    };

    const result = GetSummaryResponse.safeParse(summary);
    res.json(result.success ? result.data : summary);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    res.status(e.status ?? 502).json({ error: e.message ?? "Failed to fetch summary" });
  }
});

router.get("/series", async (req, res): Promise<void> => {
  try {
    const data = await kalshiFetch<unknown>("/series");
    const result = ListSeriesResponse.safeParse(data);
    res.json(result.success ? result.data : data);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    res.status(e.status ?? 502).json({ error: e.message ?? "Failed to fetch series" });
  }
});

export default router;
