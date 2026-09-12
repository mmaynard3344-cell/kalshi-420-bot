import http from "node:http";
import { logger } from "./lib/logger.js";
import { startJackpotService, JACKPOT_MAX_PRICE_CENTS, JACKPOT_WAGER_CENTS } from "./lib/strategies/ethJackpotService.js";

const port = Number(process.env["PORT"] ?? "8080");
if (!Number.isInteger(port) || port <= 0) throw new Error("Jackpot requires a valid PORT");

const liveEnabled = process.env["JACKPOT_LIVE_ENABLED"] === "true";
let ready = false;
let startupError: string | null = null;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.statusCode = ready ? 200 : 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: ready,
      service: "J",
      name: "Jackpot",
      live: liveEnabled,
      wager_cap_cents: JACKPOT_WAGER_CENTS,
      max_price_cents: JACKPOT_MAX_PRICE_CENTS,
      startup_error: startupError,
      commit_sha: process.env["COMMIT_SHA"] ?? "unknown",
    }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(port, "0.0.0.0", () => {
  logger.info({ port, service: "J", name: "Jackpot", live: liveEnabled }, "Jackpot HTTP service listening");
});

if (!liveEnabled) {
  // A disabled Jackpot service is deliberately a true no-touch state: it does
  // not poll A, read/cancel A orders, capture candidate telemetry, or submit J.
  // This makes the kill switch safe even though the live path legitimately
  // cancels a proven-zero A order before replacing it with the Jackpot IOC.
  ready = true;
  logger.info({ service: "J", name: "Jackpot", live: false }, "Jackpot disabled; no A polling or order actions started");
} else {
  void startJackpotService().then(() => {
    ready = true;
    logger.info({ service: "J", name: "Jackpot", live: true }, "Jackpot runtime ready");
  }).catch((err) => {
    startupError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Jackpot startup failed");
  });
}

const shutdown = (signal: string) => {
  logger.info({ signal, service: "J" }, "Jackpot shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
