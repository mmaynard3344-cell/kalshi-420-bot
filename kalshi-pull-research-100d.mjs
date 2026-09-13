#!/usr/bin/env node
/**
 * kalshi-pull-research-100d.mjs
 *
 * Pull raw KXETH15M market history from Kalshi for the last N days.
 *
 * IMPORTANT: this research pull is intentionally MARKET-DATA ONLY.
 * It does NOT request portfolio fills, orders, positions, balances, or any
 * other account/trading-history endpoint.
 *
 * Outputs:
 *   - historical-cutoff.json
 *   - raw/eth15m-markets-live.json
 *   - raw/eth15m-markets-historical.json
 *   - raw/eth15m-markets-merged.json
 *   - eth15m-markets.csv
 *   - manifest.json
 *
 * Optional environment:
 *   KALSHI_BASE_URL  default: https://external-api.kalshi.com/trade-api/v2
 *   DAYS_BACK        default: 100
 *   SERIES_TICKER    default: KXETH15M
 *   OUT_DIR          default: ./kalshi-100day-research
 *   PAGE_LIMIT       default: 1000
 *
 * Existing Kalshi credentials are accepted for authenticated GETs, but this
 * script never accesses portfolio/account data.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE_URL =
  process.env.KALSHI_BASE_URL ||
  "https://external-api.kalshi.com/trade-api/v2";
const DAYS_BACK = Number(process.env.DAYS_BACK || 100);
const SERIES_TICKER = process.env.SERIES_TICKER || "KXETH15M";
const OUT_DIR = path.resolve(process.env.OUT_DIR || "./kalshi-100day-research");
const PAGE_LIMIT = Math.min(1000, Math.max(1, Number(process.env.PAGE_LIMIT || 1000)));

const API_KEY_ID = process.env.KALSHI_API_KEY_ID;
let PRIVATE_KEY_PEM = process.env.KALSHI_PRIVATE_KEY;
if (!PRIVATE_KEY_PEM && process.env.KALSHI_PRIVATE_KEY_PATH) {
  PRIVATE_KEY_PEM = fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH, "utf8");
}

if (!API_KEY_ID || !PRIVATE_KEY_PEM) {
  console.error("Missing KALSHI_API_KEY_ID and/or KALSHI_PRIVATE_KEY (or KALSHI_PRIVATE_KEY_PATH).");
  process.exit(1);
}
if (!Number.isFinite(DAYS_BACK) || DAYS_BACK <= 0) {
  throw new Error(`Invalid DAYS_BACK=${process.env.DAYS_BACK}`);
}

const privateKey = crypto.createPrivateKey(PRIVATE_KEY_PEM);
const API_ORIGIN = BASE_URL.replace(/\/+$/, "").replace(/\/trade-api\/v2$/, "");
const API_PREFIX = "/trade-api/v2";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function signRequest(method, apiPath) {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method.toUpperCase()}${apiPath}`;
  const signature = crypto.sign("sha256", Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return {
    "KALSHI-ACCESS-KEY": API_KEY_ID,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

async function requestJson(relativePath, params = {}, { retries = 5 } = {}) {
  const apiPath = `${API_PREFIX}${relativePath}`;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const url = `${API_ORIGIN}${apiPath}${qs.size ? `?${qs.toString()}` : ""}`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", headers: signRequest("GET", apiPath) });
      if (res.ok) return await res.json();

      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) {
        throw new Error(`GET ${relativePath} failed ${res.status}: ${body.slice(0, 1000)}`);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(8000, 500 * 2 ** attempt);
      console.error(`  retry ${attempt + 1}/${retries} after ${waitMs}ms (${res.status})`);
      await sleep(waitMs);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function isoToSec(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function recordTimeSec(record, candidates) {
  for (const key of candidates) {
    const v = record?.[key];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "number") return v > 10_000_000_000 ? Math.floor(v / 1000) : Math.floor(v);
    if (/^\d+$/.test(String(v))) {
      const n = Number(v);
      return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
    }
    const sec = isoToSec(v);
    if (sec !== null) return sec;
  }
  return null;
}

function withinWindow(row, minTs, maxTs) {
  const t = recordTimeSec(row, ["settlement_ts", "close_time", "open_time", "created_time"]);
  return t === null ? true : t >= minTs && t <= maxTs;
}

function dedupeByTicker(items) {
  const map = new Map();
  for (const item of items) {
    if (!item?.ticker) continue;
    const existing = map.get(item.ticker);
    map.set(item.ticker, existing ? { ...existing, ...item } : item);
  }
  return [...map.values()];
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row?.[c])).join(","));
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

async function paginate({ label, relativePath, baseParams, minTs, historical = false }) {
  const out = [];
  let cursor;
  let page = 0;
  for (;;) {
    page += 1;
    const data = await requestJson(relativePath, {
      ...baseParams,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const rows = Array.isArray(data?.markets) ? data.markets : [];
    out.push(...rows);

    const times = rows
      .map((r) => recordTimeSec(r, ["settlement_ts", "close_time", "open_time", "created_time"]))
      .filter((x) => Number.isFinite(x));
    const oldest = times.length ? Math.min(...times) : null;
    console.error(`${label}: page ${page}, +${rows.length}, total ${out.length}` +
      (oldest ? `, oldest ${new Date(oldest * 1000).toISOString()}` : ""));

    cursor = data?.cursor || undefined;
    if (!cursor || rows.length === 0) break;
    if (historical && oldest !== null && oldest < minTs) break;
    await sleep(120);
  }
  return out;
}

function flattenMarket(m) {
  return {
    source: m._source || "",
    ticker: m.ticker,
    event_ticker: m.event_ticker,
    market_type: m.market_type,
    title: m.title,
    subtitle: m.subtitle,
    yes_sub_title: m.yes_sub_title,
    no_sub_title: m.no_sub_title,
    status: m.status,
    result: m.result,
    created_time: m.created_time,
    updated_time: m.updated_time,
    open_time: m.open_time,
    close_time: m.close_time,
    expiration_time: m.expiration_time,
    expected_expiration_time: m.expected_expiration_time,
    latest_expiration_time: m.latest_expiration_time,
    settlement_ts: m.settlement_ts,
    settlement_value_dollars: m.settlement_value_dollars,
    strike_type: m.strike_type,
    floor_strike: m.floor_strike,
    cap_strike: m.cap_strike,
    functional_strike: m.functional_strike,
    custom_strike: m.custom_strike,
    last_price_dollars: m.last_price_dollars,
    yes_bid_dollars: m.yes_bid_dollars,
    yes_ask_dollars: m.yes_ask_dollars,
    no_bid_dollars: m.no_bid_dollars,
    no_ask_dollars: m.no_ask_dollars,
    volume_fp: m.volume_fp ?? m.volume,
    volume_24h_fp: m.volume_24h_fp ?? m.volume_24h,
    open_interest_fp: m.open_interest_fp ?? m.open_interest,
    liquidity_dollars: m.liquidity_dollars,
    rules_primary: m.rules_primary,
    rules_secondary: m.rules_secondary,
    occurrence_datetime: m.occurrence_datetime,
    is_provisional: m.is_provisional,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const RAW_DIR = path.join(OUT_DIR, "raw");
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const nowSec = Math.floor(Date.now() / 1000);
  const minTs = nowSec - DAYS_BACK * 86400;

  console.error(`Base URL: ${BASE_URL}`);
  console.error(`Series: ${SERIES_TICKER}`);
  console.error(`Mode: MARKET DATA ONLY — no portfolio/account endpoints`);
  console.error(`Window: ${new Date(minTs * 1000).toISOString()} -> ${new Date(nowSec * 1000).toISOString()}`);

  console.error("\nFetching historical cutoff...");
  const cutoff = await requestJson("/historical/cutoff");
  writeJson(path.join(OUT_DIR, "historical-cutoff.json"), cutoff);

  console.error("\nFetching live ETH 15m markets...");
  const liveMarkets = await paginate({
    label: "live markets",
    relativePath: "/markets",
    baseParams: { series_ticker: SERIES_TICKER },
    minTs,
  });

  console.error("\nFetching historical ETH 15m markets...");
  const historicalMarkets = await paginate({
    label: "historical markets",
    relativePath: "/historical/markets",
    baseParams: { series_ticker: SERIES_TICKER },
    minTs,
    historical: true,
  });

  const marketsMergedRaw = dedupeByTicker([
    ...historicalMarkets.map((x) => ({ ...x, _source: "historical" })),
    ...liveMarkets.map((x) => ({ ...x, _source: "live" })),
  ])
    .filter((r) => withinWindow(r, minTs, nowSec))
    .sort((a, b) => String(a.open_time || "").localeCompare(String(b.open_time || "")));

  writeJson(path.join(RAW_DIR, "eth15m-markets-live.json"), liveMarkets);
  writeJson(path.join(RAW_DIR, "eth15m-markets-historical.json"), historicalMarkets);
  writeJson(path.join(RAW_DIR, "eth15m-markets-merged.json"), marketsMergedRaw);

  const columns = [
    "source","ticker","event_ticker","market_type","title","subtitle","yes_sub_title","no_sub_title",
    "status","result","created_time","updated_time","open_time","close_time","expiration_time",
    "expected_expiration_time","latest_expiration_time","settlement_ts","settlement_value_dollars",
    "strike_type","floor_strike","cap_strike","functional_strike","custom_strike",
    "last_price_dollars","yes_bid_dollars","yes_ask_dollars","no_bid_dollars","no_ask_dollars",
    "volume_fp","volume_24h_fp","open_interest_fp","liquidity_dollars","rules_primary",
    "rules_secondary","occurrence_datetime","is_provisional"
  ];
  writeCsv(path.join(OUT_DIR, "eth15m-markets.csv"), marketsMergedRaw.map(flattenMarket), columns);

  const manifest = {
    generated_at: new Date().toISOString(),
    mode: "eth15m-market-data-only",
    account_data_included: false,
    base_url: BASE_URL,
    days_back: DAYS_BACK,
    series_ticker: SERIES_TICKER,
    window_start: new Date(minTs * 1000).toISOString(),
    window_end: new Date(nowSec * 1000).toISOString(),
    historical_cutoff: cutoff,
    counts: {
      live_markets_downloaded: liveMarkets.length,
      historical_markets_downloaded: historicalMarkets.length,
      merged_eth15m_markets_in_window: marketsMergedRaw.length,
    },
  };
  writeJson(path.join(OUT_DIR, "manifest.json"), manifest);

  console.error("\nResearch package complete:");
  console.error("  account data: NONE");
  console.error(`  markets: ${marketsMergedRaw.length}`);
  console.error(`  folder:  ${OUT_DIR}`);

  const zipPath = `${OUT_DIR}.zip`;
  const zipCheck = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (zipCheck.status === 0) {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const parent = path.dirname(OUT_DIR);
    const base = path.basename(OUT_DIR);
    const zipped = spawnSync("zip", ["-rq", zipPath, base], { cwd: parent, stdio: "inherit" });
    if (zipped.status === 0) console.error(`  zip:     ${zipPath}`);
    else console.error("ZIP command failed; folder output is still complete.");
  } else {
    console.error("System `zip` command not found; folder output is still complete.");
  }
}

main().catch((err) => {
  console.error("\nFAILED:");
  console.error(err?.stack || err);
  process.exit(1);
});
