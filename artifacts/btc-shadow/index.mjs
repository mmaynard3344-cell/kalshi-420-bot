import http from "node:http";
import { evaluatePortfolio, SERVICES, WINDOW_MS, HISTORY_MS } from "./signals.mjs";
import { bootstrapHistory, parseFact, selectCurrent, parseCandles, publicJson, PUBLIC_BASE } from "./client.mjs";

// This executable has no credentials, database, account, or exchange-order client.
// Setting TRADING_ENABLED or any *_LIVE_ENABLED variable cannot enable orders.
let history = [], candles = [], lastHistoryMs = 0, lastCandleMs = 0, busy = false;
let initializing = true, lastError = null, candleError = null, lastSuccessMs = null, currentTicker = null, evaluations = [];
const startedAtMs = Date.now();
const totals = Object.fromEntries(SERVICES.map((service) => [service, { evaluations: 0, qualifyingWindows: 0 }]));
const seenSignals = new Set();
const json = (event) => console.log(JSON.stringify({ ...event, ordersEnabled: false, mode: "shadow" }));
const status = () => ({ service: "BTC B-L Shadow", version: process.env.COMMIT_SHA ?? "unknown", mode: "shadow",
  ordersEnabled: false, stakeCents: 500, initializing, lastSuccessMs, currentTicker, lastError, candleError, countersSinceMs: startedAtMs,
  historyCount: history.length, candleCount: candles.length,
  healthy: !initializing && lastSuccessMs != null && Date.now() - lastSuccessMs < 60_000,
  services: evaluations.map((e) => ({ ...e, totals: totals[e.service] })),
  exclusions: { A: "not_requested", J: "waiting_for_btc_A_order; no BTC A is running", K: "weather_only" } });
const esc = (s) => String(s ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const server = http.createServer((req, res) => {
  const s = status();
  if (req.method !== "GET") { res.writeHead(405); res.end("read only"); return; }
  if (req.url === "/health" || req.url === "/status") {
    res.writeHead(req.url === "/health" && !s.healthy ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(s)); return;
  }
  if (req.url !== "/") { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>BTC B–L Shadow</title><style>body{background:#101722;color:#e7eef7;font:16px system-ui;max-width:1080px;margin:32px auto;padding:0 16px}h1{font-size:26px}p{color:#a9b9cd}.badge{color:#8adbc1}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;border-bottom:1px solid #2c3949;padding:12px 8px}.wrap{overflow:auto}.yes{color:#8adbc1}.quiet{color:#a9b9cd}footer{margin-top:24px;color:#a9b9cd;font-size:13px}</style></head><body><h1>BTC B–L</h1><p class="badge">SHADOW · Real-money orders disabled · $5 hypothetical stake</p><p>${esc(currentTicker)} · Updated ${esc(lastSuccessMs ? new Date(lastSuccessMs).toISOString() : "initializing")}</p><div class="wrap"><table><thead><tr><th>Service</th><th>Signal</th><th>Side</th><th>Stake</th><th>Reason</th><th>Windows</th></tr></thead><tbody>${s.services.map((e) => `<tr><td>${esc(e.service)}</td><td class="${e.fires ? "yes" : "quiet"}">${e.fires ? "QUALIFIES" : "WAITING"}</td><td>${esc(e.side?.toUpperCase())}</td><td>${e.service === "K" ? "—" : "$5.00"}</td><td>${esc(e.reason)}</td><td>${e.totals.qualifyingWindows}</td></tr>`).join("")}</tbody></table></div><footer>Signals only. No simulated fills or profit claims. B always YES. J waits for a BTC A order; BTC A is excluded. K remains on weather. L uses finalized Kraken BTC candles. ETH services are separate.</footer></body></html>`);
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => json({ event: "btc_shadow_http_started", port: Number(process.env.PORT ?? 8080) }));

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    if (!history.length) history = await bootstrapHistory(now);
    if (now - lastHistoryMs > 30_000) {
      const settled = await publicJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=32`);
      if (!Array.isArray(settled.markets)) throw new Error("invalid_settled_catalog");
      const map = new Map(history.map((f) => [f.ticker, f]));
      for (const row of settled.markets) { const fact = parseFact(row); if (fact) map.set(fact.ticker, fact); }
      history = [...map.values()].filter((f) => f.openTimeMs >= now - HISTORY_MS - 2 * WINDOW_MS);
      lastHistoryMs = now;
    }
    const open = await publicJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M&status=open&limit=20`);
    if (!Array.isArray(open.markets)) throw new Error("invalid_open_catalog");
    const market = selectCurrent(open.markets, Date.now());
    if (!market) throw new Error("current_btc_market_unavailable");
    if (now - lastCandleMs > 60_000) {
      try { candles = parseCandles(await publicJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=15"), Date.now()); candleError = null; }
      catch { candles = []; candleError = "kraken_completed_btc_candles_unavailable"; }
      lastCandleMs = now;
    }
    evaluations = evaluatePortfolio({ market, history, candles });
    if (candleError) evaluations = evaluations.map((e) => e.service === "L" ? { ...e, reason: candleError } : e);
    for (const e of evaluations) {
      totals[e.service].evaluations++;
      const key = `${e.service}:${e.ticker}`;
      if (e.fires && !seenSignals.has(key)) { seenSignals.add(key); totals[e.service].qualifyingWindows++; }
    }
    if (seenSignals.size > 10_000) seenSignals.clear();
    initializing = false; lastError = null; lastSuccessMs = Date.now(); currentTicker = market.ticker;
    json({ event: "btc_shadow_evaluation", timestamp: new Date(lastSuccessMs).toISOString(), ticker: currentTicker,
      stakeCents: 500, historyCount: history.length, candleCount: candles.length,
      services: evaluations.map(({ service, fires, side, reason }) => ({ service, fires, side, reason })) });
  } catch (error) {
    lastError = error instanceof Error ? error.message : "evaluation_failed";
    json({ event: "btc_shadow_error", error: lastError });
  } finally { busy = false; }
}
void tick();
const timer = setInterval(() => void tick(), 10_000);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
