import { WINDOW_MS, HISTORY_MS } from "./signals.mjs";
export const PUBLIC_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export async function publicJson(url, fetcher = fetch) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")
    || !(target.hostname === "api.elections.kalshi.com"
      && (target.pathname === "/trade-api/v2/markets" || target.pathname.startsWith("/trade-api/v2/markets/")))
      && !(target.hostname === "api.kraken.com" && target.pathname === "/0/public/OHLC")) throw new Error("unapproved_public_source");
  const response = await fetcher(url, { method: "GET", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`public_source_http_${response.status}`);
  return response.json();
}
export function parseFact(row) {
  const f = { ticker: row.ticker, openTimeMs: Date.parse(row.open_time), floorStrike: Number(row.floor_strike),
    finalized: row.status === "finalized" || row.status === "settled", finalizedAtMs: Date.parse(row.settlement_ts), result: row.result };
  if (!/^KXBTC15M-[A-Z0-9-]+$/.test(f.ticker) || !Number.isSafeInteger(f.openTimeMs)
    || f.openTimeMs % WINDOW_MS !== 0 || !Number.isFinite(f.floorStrike) || f.floorStrike <= 0
    || !f.finalized || !Number.isSafeInteger(f.finalizedAtMs) || f.finalizedAtMs < f.openTimeMs + WINDOW_MS
    || !["yes", "no"].includes(f.result)) return null;
  return f;
}
export async function bootstrapHistory(nowMs, fetcher = fetch) {
  const cutoff = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS - HISTORY_MS - WINDOW_MS;
  let cursor = "", facts = [], earliest = Infinity;
  const seen = new Set();
  for (let page = 0; page < 12; page++) {
    const url = new URL(`${PUBLIC_BASE}/markets`);
    url.searchParams.set("series_ticker", "KXBTC15M"); url.searchParams.set("status", "settled"); url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const body = await publicJson(url.toString(), fetcher);
    if (!Array.isArray(body.markets)) throw new Error("invalid_market_catalog");
    const batch = body.markets.map(parseFact).filter(Boolean);
    facts.push(...batch);
    earliest = Math.min(earliest, ...batch.map((f) => f.openTimeMs));
    cursor = body.cursor;
    if (earliest <= cutoff || !cursor) break;
    if (seen.has(cursor)) throw new Error("repeated_market_cursor");
    seen.add(cursor);
  }
  if (earliest > cutoff) throw new Error("incomplete_28_day_btc_history");
  return facts.filter((f) => f.openTimeMs >= cutoff);
}
export function btcCurrentTicker(nowMs) {
  const closeTimeMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "2-digit", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(closeTimeMs)).map((part) => [part.type, part.value]));
  return `KXBTC15M-${parts.year}${parts.month.toUpperCase()}${parts.day}${parts.hour}${parts.minute}-${parts.minute}`;
}
export async function fetchCurrentBtcMarket(nowMs, fetcher = fetch) {
  const ticker = btcCurrentTicker(nowMs);
  const body = await publicJson(`${PUBLIC_BASE}/markets/${ticker}`, fetcher);
  if (!body || !body.market || body.market.ticker !== ticker) return null;
  return selectCurrent([body.market], nowMs);
}
export function selectCurrent(rows, nowMs) {
  // Kalshi open_time is the time order entry begins, which may precede
  // the 15-minute outcome window. Close time defines the window boundary.
  const matches = rows.filter((r) => {
    const closeTimeMs = Date.parse(r.close_time);
    const listedOpenMs = Date.parse(r.open_time);
    const windowStartMs = closeTimeMs - WINDOW_MS;
    return /^KXBTC15M-[A-Z0-9-]+$/.test(r.ticker)
      && ["active", "open"].includes(r.status)
      && Number.isSafeInteger(closeTimeMs) && closeTimeMs % WINDOW_MS === 0
      && Number.isSafeInteger(listedOpenMs) && listedOpenMs <= nowMs
      && nowMs >= windowStartMs && nowMs < closeTimeMs;
  });
  if (matches.length !== 1) return null;
  const row = matches[0];
  const floorStrike = Number(row.floor_strike), closeTimeMs = Date.parse(row.close_time);
  if (!Number.isFinite(floorStrike) || floorStrike <= 0) return null;
  return { ticker: row.ticker, floorStrike, openTimeMs: closeTimeMs - WINDOW_MS, observedAtMs: nowMs };
}
export function parseCandles(body, nowMs) {
  if (Array.isArray(body.error) && body.error.length) throw new Error("kraken_candle_error");
  const data = Object.entries(body.result ?? {}).filter(([key]) => key !== "last");
  if (data.length !== 1 || !Array.isArray(data[0][1])) throw new Error("invalid_btc_candles");
  const candles = data[0][1].map((r) => ({ openTimeMs: Number(r[0]) * 1000, closeTimeMs: Number(r[0]) * 1000 + WINDOW_MS,
    open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), finalized: Number(r[0]) * 1000 + WINDOW_MS <= nowMs }));
  return candles.filter((c) => c.finalized).sort((a, b) => a.openTimeMs - b.openTimeMs);
}
