import { Router, type IRouter } from "express";
import {
  ListEventsQueryParams,
  GetEventParams,
  GetEventResponse,
  ListEventsResponse,
} from "@workspace/api-zod";
import { kalshiFetch, normalizeMarket } from "../lib/kalshi";

const router: IRouter = Router();

router.get("/events", async (req, res): Promise<void> => {
  const parsed = ListEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const data = await kalshiFetch<unknown>("/events", parsed.data);
    const result = ListEventsResponse.safeParse(data);
    res.json(result.success ? result.data : data);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    res.status(e.status ?? 502).json({ error: e.message ?? "Failed to fetch events" });
  }
});

router.get("/events/:event_ticker", async (req, res): Promise<void> => {
  const params = GetEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const raw = await kalshiFetch<unknown>(
      `/events/${params.data.event_ticker}`,
      { with_nested_markets: true },
    );
    const result = GetEventResponse.safeParse(raw);
    res.json(result.success ? result.data : raw);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 404) {
      res.status(404).json({ error: "Event not found" });
    } else {
      res.status(e.status ?? 502).json({ error: e.message ?? "Failed to fetch event" });
    }
  }
});

export default router;
