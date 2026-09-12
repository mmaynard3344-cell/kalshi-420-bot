#!/usr/bin/env node
/**
 * kalshi-pull-research-100d.mjs
 *
 * Pull a complete Kalshi research package for the last N days:
 *   1) Live + historical portfolio fills
 *   2) Live + historical portfolio orders
 *   3) Live + historical KXETH15M market metadata (targets/floor strikes + results)
 *   4) Historical cutoff metadata
 *
 * Outputs both raw JSON and flattened CSV, then creates a ZIP if the system `zip`
 * command is available.
 *
 * Requires:
 *   KALSHI_API_KEY_ID
 *   KALSHI_PRIVATE_KEY       full PEM contents
 *     OR
 *   KALSHI_PRIVATE_KEY_PATH  path to PEM file
 *
 * Optional:
 *   KALSHI_BASE_URL     default: https://external-api.kalshi.com/trade-api/v2
 *   DAYS_BACK           default: 100
 *   SERIES_TICKER       default: KXETH15M
 *   OUT_DIR             default: ./kalshi-100day-research
 *   PAGE_LIMIT          default: 1000
 *
 * Usage:
 *   KALSHI_API_KEY_ID=xxx \
 *   KALSHI_PRIVATE_KEY="$(cat key.pem)" \
 *   node kalshi-pull-research-100d.mjs
 *
 * Node 18+ required (built-in fetch).
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
  console.error(
    "Missing KALSHI_API_KEY_ID and/or KALSHI_PRIVATE_KEY " +
      "(or KALSHI_PRIVATE_KEY_PATH)."
  );
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

async function requestJson(relativePath, params = {}, { auth = true, retries = 5 } = {}) {
  const apiPath = `${API_PREFIX}${relativePath}`;
  const qs = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, String(value));
    }
  }

  const url = `${API_ORIGIN}${apiPath}${qs.size ? `?${qs.toString()}` : ""}`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = auth ? signRequest("GET", apiPath) : {};
      const res = await fetch(url, { method: "GET", headers });

      if (res.ok) return await res.json();

      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;

      if (!retryable || attempt === retries) {
        throw new Error(
          `GET ${relativePath} failed ${res.status}: ${body.slice(0, 1000)}`
        );
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

function firstFinite(...values) {
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function recordTimeSec(record, candidates) {
  for (const key of candidates) {
    const v = record?.[key];
    if (v === null || v === undefined || v === "") continue;

    if (typeof v === "number") {
      // APIs may return Unix seconds; tolerate milliseconds.
      return v > 10_000_000_000 ? Math.floor(v / 1000) : Math.floor(v);
    }

    if (/^\d+$/.test(String(v))) {
      const n = Number(v);
      return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
    }

    const sec = isoToSec(v);
    if (sec !== null) return sec;
  }
  return null;
}

function dedupeBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const existing = map.get(key);
    // Prefer the later item so richer live records can replace older copies.
    if (!existing) map.set(key, item);
    else map.set(key, { ...existing, ...item });
  }
  return [...map.values()];
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row?.[c])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function paginate({
  label,
  relativePath,
  arrayKey,
  baseParams = {},
  minTs = null,
  timeFields = [],
  historical = false,
}) {
  const out = [];
  let cursor;
  let page = 0;

  for (;;) {
    page += 1;
    const params = {
      ...baseParams,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    };

    // Live endpoints support min_ts/max_ts for fills/orders. Historical endpoints
    // may only expose max_ts, so historical pagination is filtered/stopped locally.
    const data = await requestJson(relativePath, params, { auth: true });
    const rows = Array.isArray(data?.[arrayKey]) ? data[arrayKey] : [];
    out.push(...rows);

    let oldest = null;
    if (minTs !== null && rows.length) {
      const times = rows
        .map((r) => recordTimeSec(r, timeFields))
        .filter((x) => Number.isFinite(x));
      if (times.length) oldest = Math.min(...times);
    }

    console.error(
      `${label}: page ${page}, +${rows.length}, total ${out.length}` +
        (oldest ? `, oldest ${new Date(oldest * 1000).toISOString()}` : "")
    );

    cursor = data?.cursor || undefined;

    if (!cursor || rows.length === 0) break;

    // Historical endpoints return archived data; once the oldest item on the
    // current page crosses our 100-day boundary, later pages are older still.
    if (historical && minTs !== null && oldest !== null && oldest < minTs) {
      break;
    }

    await sleep(120);
  }

  return out;
}

function flattenFills(rows, source) {
  return rows.map((f) => ({
    source,
    fill_id: f.fill_id,
    trade_id: f.trade_id,
    order_id: f.order_id,
    ticker: f.ticker || f.market_ticker,
    market_ticker: f.market_ticker,
    side: f.side,
    action: f.action,
    outcome_side: f.outcome_side,
    book_side: f.book_side,
    count_fp: f.count_fp ?? f.count,
    yes_price_dollars: f.yes_price_dollars,
    no_price_dollars: f.no_price_dollars,
    price: f.price,
    is_taker: f.is_taker,
    fee_cost: f.fee_cost,
    created_time: f.created_time,
    ts: f.ts,
    subaccount_number: f.subaccount_number,
  }));
}

function flattenOrders(rows, source) {
  return rows.map((o) => ({
    source,
    order_id: o.order_id,
    client_order_id: o.client_order_id,
    ticker: o.ticker,
    side: o.side,
    action: o.action,
    outcome_side: o.outcome_side,
    book_side: o.book_side,
    type: o.type,
    status: o.status,
    yes_price_dollars: o.yes_price_dollars,
    no_price_dollars: o.no_price_dollars,
    price: o.price,
    fill_count_fp: o.fill_count_fp ?? o.fill_count,
    remaining_count_fp: o.remaining_count_fp ?? o.remaining_count,
    initial_count_fp: o.initial_count_fp ?? o.initial_count,
    taker_fill_cost_dollars: o.taker_fill_cost_dollars,
    maker_fill_cost_dollars: o.maker_fill_cost_dollars,
    taker_fees_dollars: o.taker_fees_dollars,
    maker_fees_dollars: o.maker_fees_dollars,
    expiration_time: o.expiration_time,
    created_time: o.created_time,
    last_update_time: o.last_update_time,
    self_trade_prevention_type: o.self_trade_prevention_type,
    order_group_id: o.order_group_id,
    cancel_order_on_pause: o.cancel_order_on_pause,
    subaccount_number: o.subaccount_number,
  }));
}

function flattenMarkets(rows, source) {
  return rows.map((m) => ({
    source,
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
  }));
}

function withinWindowByAnyTime(row, minTs, maxTs, timeFields) {
  const t = recordTimeSec(row, timeFields);
  if (t === null) return true; // preserve unknown-timestamp rows rather than silently lose data
  return t >= minTs && t <= maxTs;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const RAW_DIR = path.join(OUT_DIR, "raw");
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const nowSec = Math.floor(Date.now() / 1000);
  const minTs = nowSec - DAYS_BACK * 86400;

  console.error(`Base URL: ${BASE_URL}`);
  console.error(`Series: ${SERIES_TICKER}`);
  console.error(`Window: ${new Date(minTs * 1000).toISOString()} -> ${new Date(nowSec * 1000).toISOString()}`);

  // Historical cutoff is public metadata, but signing it is harmless and keeps
  // all requests consistent with authenticated environments.
  console.error("\nFetching historical cutoff...");
  const cutoff = await requestJson("/historical/cutoff", {}, { auth: true });
  writeJson(path.join(OUT_DIR, "historical-cutoff.json"), cutoff);

  // ---- FILLS ----
  console.error("\nFetching live fills...");
  const liveFills = await paginate({
    label: "live fills",
    relativePath: "/portfolio/fills",
    arrayKey: "fills",
    baseParams: { min_ts: minTs, max_ts: nowSec },
    minTs,
    timeFields: ["ts", "created_time"],
  });

  console.error("\nFetching historical fills...");
  const historicalFills = await paginate({
    label: "historical fills",
    relativePath: "/historical/fills",
    arrayKey: "fills",
    baseParams: { max_ts: nowSec },
    minTs,
    timeFields: ["ts", "created_time"],
    historical: true,
  });

  const histFills100 = historicalFills.filter((r) =>
    withinWindowByAnyTime(r, minTs, nowSec, ["ts", "created_time"])
  );

  const fillsMergedRaw = dedupeBy(
    [
      ...historicalFills.map((x) => ({ ...x, _source: "historical" })),
      ...liveFills.map((x) => ({ ...x, _source: "live" })),
    ],
    (x) => x.fill_id || x.trade_id || `${x.order_id}|${x.ts}|${x.ticker}`
  ).filter((r) => withinWindowByAnyTime(r, minTs, nowSec, ["ts", "created_time"]));

  // ---- ORDERS ----
  console.error("\nFetching live orders...");
  const liveOrders = await paginate({
    label: "live orders",
    relativePath: "/portfolio/orders",
    arrayKey: "orders",
    baseParams: { min_ts: minTs, max_ts: nowSec },
    minTs,
    timeFields: ["last_update_time", "created_time"],
  });

  console.error("\nFetching historical orders...");
  const historicalOrders = await paginate({
    label: "historical orders",
    relativePath: "/historical/orders",
    arrayKey: "orders",
    baseParams: { max_ts: nowSec },
    minTs,
    timeFields: ["last_update_time", "created_time"],
    historical: true,
  });

  const ordersMergedRaw = dedupeBy(
    [
      ...historicalOrders.map((x) => ({ ...x, _source: "historical" })),
      ...liveOrders.map((x) => ({ ...x, _source: "live" })),
    ],
    (x) => x.order_id || x.client_order_id
  ).filter((r) =>
    withinWindowByAnyTime(r, minTs, nowSec, ["last_update_time", "created_time"])
  );

  // ---- KXETH15M MARKETS ----
  // Live markets can be filtered by series but archived markets must be pulled
  // from /historical/markets. We filter to the 100-day window client-side using
  // settlement/close/open timestamps. Series-level pagination avoids needing to
  // know every ticker in advance.
  console.error("\nFetching live ETH 15m markets...");
  const liveMarkets = await paginate({
    label: "live markets",
    relativePath: "/markets",
    arrayKey: "markets",
    baseParams: { series_ticker: SERIES_TICKER },
    minTs,
    timeFields: ["settlement_ts", "close_time", "open_time", "created_time"],
  });

  console.error("\nFetching historical ETH 15m markets...");
  const historicalMarkets = await paginate({
    label: "historical markets",
    relativePath: "/historical/markets",
    arrayKey: "markets",
    baseParams: { series_ticker: SERIES_TICKER },
    minTs,
    timeFields: ["settlement_ts", "close_time", "open_time", "created_time"],
    historical: true,
  });

  const marketsMergedRaw = dedupeBy(
    [
      ...historicalMarkets.map((x) => ({ ...x, _source: "historical" })),
      ...liveMarkets.map((x) => ({ ...x, _source: "live" })),
    ],
    (x) => x.ticker
  ).filter((r) =>
    withinWindowByAnyTime(r, minTs, nowSec, [
      "settlement_ts",
      "close_time",
      "open_time",
      "created_time",
    ])
  );

  // ---- RAW JSON ----
  writeJson(path.join(RAW_DIR, "fills-live.json"), liveFills);
  writeJson(path.join(RAW_DIR, "fills-historical.json"), histFills100);
  writeJson(path.join(RAW_DIR, "fills-merged.json"), fillsMergedRaw);

  writeJson(path.join(RAW_DIR, "orders-live.json"), liveOrders);
  writeJson(path.join(RAW_DIR, "orders-historical.json"), historicalOrders);
  writeJson(path.join(RAW_DIR, "orders-merged.json"), ordersMergedRaw);

  writeJson(path.join(RAW_DIR, "eth15m-markets-live.json"), liveMarkets);
  writeJson(path.join(RAW_DIR, "eth15m-markets-historical.json"), historicalMarkets);
  writeJson(path.join(RAW_DIR, "eth15m-markets-merged.json"), marketsMergedRaw);

  // ---- CSV ----
  const fillsCsv = fillsMergedRaw.map((x) => flattenFills([x], x._source || "")[0]);
  const ordersCsv = ordersMergedRaw.map((x) => flattenOrders([x], x._source || "")[0]);
  const marketsCsv = marketsMergedRaw
    .map((x) => flattenMarkets([x], x._source || "")[0])
    .sort((a, b) => String(a.open_time || "").localeCompare(String(b.open_time || "")));

  writeCsv(path.join(OUT_DIR, "fills.csv"), fillsCsv, [
    "source","fill_id","trade_id","order_id","ticker","market_ticker","side","action",
    "outcome_side","book_side","count_fp","yes_price_dollars","no_price_dollars","price",
    "is_taker","fee_cost","created_time","ts","subaccount_number"
  ]);

  writeCsv(path.join(OUT_DIR, "orders.csv"), ordersCsv, [
    "source","order_id","client_order_id","ticker","side","action","outcome_side","book_side",
    "type","status","yes_price_dollars","no_price_dollars","price","fill_count_fp",
    "remaining_count_fp","initial_count_fp","taker_fill_cost_dollars","maker_fill_cost_dollars",
    "taker_fees_dollars","maker_fees_dollars","expiration_time","created_time","last_update_time",
    "self_trade_prevention_type","order_group_id","cancel_order_on_pause","subaccount_number"
  ]);

  writeCsv(path.join(OUT_DIR, "eth15m-markets.csv"), marketsCsv, [
    "source","ticker","event_ticker","market_type","title","subtitle","yes_sub_title","no_sub_title",
    "status","result","created_time","updated_time","open_time","close_time","expiration_time",
    "expected_expiration_time","latest_expiration_time","settlement_ts","settlement_value_dollars",
    "strike_type","floor_strike","cap_strike","functional_strike","custom_strike",
    "last_price_dollars","yes_bid_dollars","yes_ask_dollars","no_bid_dollars","no_ask_dollars",
    "volume_fp","volume_24h_fp","open_interest_fp","liquidity_dollars","rules_primary",
    "rules_secondary","occurrence_datetime","is_provisional"
  ]);

  const manifest = {
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    days_back: DAYS_BACK,
    series_ticker: SERIES_TICKER,
    window_start: new Date(minTs * 1000).toISOString(),
    window_end: new Date(nowSec * 1000).toISOString(),
    historical_cutoff: cutoff,
    counts: {
      live_fills: liveFills.length,
      historical_fills_in_window: histFills100.length,
      merged_fills: fillsMergedRaw.length,
      live_orders: liveOrders.length,
      historical_orders_downloaded: historicalOrders.length,
      merged_orders: ordersMergedRaw.length,
      live_markets_downloaded: liveMarkets.length,
      historical_markets_downloaded: historicalMarkets.length,
      merged_eth15m_markets_in_window: marketsMergedRaw.length,
    },
  };

  writeJson(path.join(OUT_DIR, "manifest.json"), manifest);

  console.error("\nResearch package complete:");
  console.error(`  fills:   ${fillsMergedRaw.length}`);
  console.error(`  orders:  ${ordersMergedRaw.length}`);
  console.error(`  markets: ${marketsMergedRaw.length}`);
  console.error(`  folder:  ${OUT_DIR}`);

  // Optional ZIP packaging.
  const zipPath = `${OUT_DIR}.zip`;
  const zipCheck = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (zipCheck.status === 0) {
    try {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      const parent = path.dirname(OUT_DIR);
      const base = path.basename(OUT_DIR);
      const zipped = spawnSync("zip", ["-rq", zipPath, base], {
        cwd: parent,
        stdio: "inherit",
      });
      if (zipped.status === 0) {
        console.error(`  zip:     ${zipPath}`);
      } else {
        console.error("ZIP command failed; folder output is still complete.");
      }
    } catch (err) {
      console.error(`ZIP packaging skipped: ${err.message}`);
    }
  } else {
    console.error("System `zip` command not found; folder output is still complete.");
  }
}

main().catch((err) => {
  console.error("\nFAILED:");
  console.error(err?.stack || err);
  process.exit(1);
});
