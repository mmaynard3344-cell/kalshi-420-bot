import { Router } from "express";
import type { Response } from "express";
import { kalshiStream } from "../lib/kalshiStream";
import { tradeEvents, PE_MONITOR_INCIDENT } from "../lib/tradeEvents";
import type { ProtectiveExitMonitorIncident } from "../lib/tradeStore";

const router = Router();

// Track all active SSE response objects so trade-side events can push to them.
const _sseClients = new Set<Response>();

function _broadcastToClients(data: string): void {
  for (const client of _sseClients) {
    try { client.write(data); } catch { /* client disconnected */ }
  }
}

// Forward protective-exit monitor incidents to every connected SSE client
// the moment they are recorded — no poll delay.
tradeEvents.on(PE_MONITOR_INCIDENT, (incident: ProtectiveExitMonitorIncident) => {
  _broadcastToClients(`data: ${JSON.stringify({ type: "pe_monitor_incident", incident })}\n\n`);
});

/**
 * GET /stream
 * Server-Sent Events — pushes normalized market ticker updates in real time.
 * Each event: data: { type: "ticker", market: NormalizedMarket }
 */
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // prevent nginx buffering
  res.flushHeaders();

  _sseClients.add(res);

  // Send initial connection status
  res.write(`data: ${JSON.stringify({ type: "connected", live: kalshiStream.isConnected() })}\n\n`);

  // Keepalive ping every 20s so proxies don't drop the connection
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);

  const onTicker = (market: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ type: "ticker", market })}\n\n`);
  };

  const onTrade = (trade: { ticker: string; last_price: number }) => {
    res.write(`data: ${JSON.stringify({ type: "trade", ...trade })}\n\n`);
  };

  kalshiStream.on("ticker", onTicker);
  kalshiStream.on("trade", onTrade);

  req.on("close", () => {
    _sseClients.delete(res);
    clearInterval(heartbeat);
    kalshiStream.off("ticker", onTicker);
    kalshiStream.off("trade", onTrade);
  });
});

export default router;
