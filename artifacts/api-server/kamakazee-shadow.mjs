/*
 * Service K — Kamakazee! LIVE
 * Isolated ETH 15-minute strategy. No imports from, writes to, or control over A–J.
 */
import { createSign, randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const PUBLIC_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const TRADE_BASE = "https://external-api.kalshi.com/trade-api/v2";
const SERIES = "KXETH15M";
const INTERVAL_MS = 15 * 60 * 1000;
const EFFICIENCY_THRESHOLD = 0.85;
const POLL_MS = 30_000;
const PRINCIPAL_CENTS = [10_000, 20_000, 40_000];
const LIMIT_CENTS = 50;
let inFlight = false;

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "K", strategy: "Kamakazee!", mode: "LIVE", event, ...data }));
}

function normalizePem(raw) {
  let value = raw.replace(/\\n/g, "\n").trim();
  const match = value.match(/^(-----BEGIN [^-]+-----)\s+([A-Za-z0-9+/\s=]+?)\s*(-----END [^-]+-----)$/s);
  if (match) {
    const body = match[2].replace(/\s+/g, "");
    value = [match[1], ...(body.match(/.{1,64}/g) ?? []), match[3]].join("\n");
  }
  return value;
}

function authHeaders(method, path) {
  const keyId = process.env.KALSHI_API_KEY_ID;
  const rawKey = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !rawKey) throw new Error("K credentials missing");
  const timestamp = Date.now().toString();
  const cleanPath = path.split("?")[0];
  const signer = createSign("SHA256");
  signer.update(timestamp + method.toUpperCase() + cleanPath);
  signer.end();
  const signature = signer.sign({ key: normalizePem(rawKey), padding: 6, saltLength: 32 });
  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

async function authFetch(method, path, body) {
  const response = await fetch(TRADE_BASE + path, {
    method,
    headers: authHeaders(method, "/trade-api/v2" + path),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!response.ok) throw Object.assign(new Error(`Kalshi HTTP ${response.status}`), { status: response.status, body: parsed });
  return parsed;
}

async function publicFetch(path, params = {}) {
  const url = new URL(PUBLIC_BASE + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Kalshi market-data HTTP ${response.status}`);
  return response.json();
}

function normalize(raw) {
  const ticker = typeof raw?.ticker === "string" ? raw.ticker : null;
  const openMs = typeof raw?.open_time === "string" ? Date.parse(raw.open_time) : NaN;
  const strike = Number(raw?.floor_strike);
  const result = typeof raw?.result === "string" ? raw.result.toUpperCase() : null;
  if (raw?.status !== "finalized" || !ticker?.startsWith("KXETH15M-") || !Number.isFinite(openMs)
      || openMs % INTERVAL_MS !== 0 || !Number.isFinite(strike) || strike <= 0
      || (result !== "YES" && result !== "NO")) return null;
  return { ticker, openMs, strike, result };
}

function directionalEfficiency(points) {
  if (points.length !== 4) return null;
  const net = Math.abs(points[3].strike - points[0].strike);
  let path = 0;
  for (let i = 1; i < points.length; i++) path += Math.abs(points[i].strike - points[i - 1].strike);
  return path > 0 ? net / path : null;
}

function orderFields(raw) {
  const order = raw?.order ?? raw;
  const orderId = typeof order?.order_id === "string" ? order.order_id : null;
  const status = typeof order?.status === "string" ? order.status.toLowerCase() : null;
  const filled = Number(order?.fill_count_fp ?? order?.fill_count ?? 0);
  const remaining = Number(order?.remaining_count_fp ?? order?.remaining_count ?? 0);
  return { orderId, status, filled: Number.isFinite(filled) ? filled : 0, remaining: Number.isFinite(remaining) ? remaining : 0 };
}

async function init() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS kamakazee_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 2),
      last_signal_ticker TEXT,
      updated_at_ms BIGINT NOT NULL
    )`);
  await db.execute(sql`
    INSERT INTO kamakazee_state(singleton, step, updated_at_ms)
    VALUES (1, 0, ${Date.now()}) ON CONFLICT (singleton) DO NOTHING`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS kamakazee_orders (
      target_ticker TEXT PRIMARY KEY,
      signal_ticker TEXT NOT NULL,
      client_order_id TEXT UNIQUE NOT NULL,
      kalshi_order_id TEXT,
      step INTEGER NOT NULL,
      principal_cents INTEGER NOT NULL,
      requested_contracts INTEGER NOT NULL,
      filled_contracts NUMERIC,
      order_status TEXT NOT NULL,
      official_result TEXT,
      transition_applied BOOLEAN NOT NULL DEFAULT FALSE,
      raw_json JSONB,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`);
}

async function state() {
  const result = await db.execute(sql`SELECT step, last_signal_ticker FROM kamakazee_state WHERE singleton=1`);
  return result.rows[0];
}

async function reconcile() {
  const result = await db.execute(sql`
    SELECT * FROM kamakazee_orders
    WHERE transition_applied=FALSE
    ORDER BY created_at_ms ASC LIMIT 10`);
  for (const row of result.rows) {
    if (!row.kalshi_order_id) {
      log("FAIL_CLOSED", { reason: "submission_identity_unknown", targetTicker: row.target_ticker });
      return false;
    }
    let exchange;
    try { exchange = await authFetch("GET", `/portfolio/orders/${encodeURIComponent(row.kalshi_order_id)}`); }
    catch (error) {
      log("FAIL_CLOSED", { reason: "order_read_unavailable", targetTicker: row.target_ticker, error: String(error?.message ?? error) });
      return false;
    }
    const parsed = orderFields(exchange);
    await db.execute(sql`
      UPDATE kamakazee_orders SET filled_contracts=${parsed.filled}, order_status=${parsed.status ?? "unknown"},
      raw_json=${JSON.stringify(exchange)}::jsonb, updated_at_ms=${Date.now()} WHERE target_ticker=${row.target_ticker}`);
    let market;
    try { market = await publicFetch(`/markets/${encodeURIComponent(row.target_ticker)}`); }
    catch { return false; }
    const rawMarket = market.market ?? market;
    const official = typeof rawMarket.result === "string" ? rawMarket.result.toUpperCase() : null;
    if (rawMarket.status !== "finalized" || (official !== "YES" && official !== "NO")) return false;
    if (parsed.filled <= 0) {
      await db.execute(sql`UPDATE kamakazee_orders SET official_result=${official}, transition_applied=TRUE,
        order_status='zero_fill', updated_at_ms=${Date.now()} WHERE target_ticker=${row.target_ticker}`);
      log("ZERO_FILL", { targetTicker: row.target_ticker, step: row.step, sequenceNeutral: true });
      continue;
    }
    const win = official === "NO";
    const nextStep = win || Number(row.step) === 2 ? 0 : Number(row.step) + 1;
    const transitioned = await db.execute(sql`
      UPDATE kamakazee_orders SET official_result=${official}, transition_applied=TRUE, updated_at_ms=${Date.now()}
      WHERE target_ticker=${row.target_ticker} AND transition_applied=FALSE RETURNING target_ticker`);
    if (transitioned.rows.length === 1) {
      await db.execute(sql`UPDATE kamakazee_state SET step=${nextStep}, updated_at_ms=${Date.now()} WHERE singleton=1`);
      log("SETTLED", { targetTicker: row.target_ticker, result: official, filledContracts: parsed.filled, win, priorStep: row.step, nextStep });
    }
  }
  const unresolved = await db.execute(sql`SELECT COUNT(*)::int AS count FROM kamakazee_orders WHERE transition_applied=FALSE`);
  return Number(unresolved.rows[0]?.count ?? 0) === 0;
}

async function evaluate() {
  if (process.env.KAMAKAZEE_LIVE_ENABLED !== "true") {
    log("FAIL_CLOSED", { reason: "live_disabled" });
    return;
  }
  if (!(await reconcile())) return;
  const raw = await publicFetch("/markets", { series_ticker: SERIES, status: "settled", limit: 20 });
  const markets = (raw.markets ?? []).map(normalize).filter(Boolean).sort((a, b) => a.openMs - b.openMs);
  if (markets.length < 5) return;
  const recent = markets.slice(-5);
  for (let i = 1; i < recent.length; i++) if (recent[i].openMs - recent[i - 1].openMs !== INTERVAL_MS) return;
  const latest = recent[4];
  const currentState = await state();
  if (currentState?.last_signal_ticker === latest.ticker) return;
  const hour = recent.slice(1, 5);
  const efficiency = directionalEfficiency(hour);
  const previousTwo = hour.slice(-2).map((market) => market.result);
  const qualifies = efficiency != null && efficiency >= EFFICIENCY_THRESHOLD
    && previousTwo[0] === "YES" && previousTwo[1] === "YES";
  log("EVALUATION", { latestFinalizedTicker: latest.ticker, previousTwo,
    directionalEfficiency: efficiency == null ? null : Number(efficiency.toFixed(6)), threshold: EFFICIENCY_THRESHOLD, qualifies });
  await db.execute(sql`UPDATE kamakazee_state SET last_signal_ticker=${latest.ticker}, updated_at_ms=${Date.now()} WHERE singleton=1`);
  if (!qualifies) return;

  const targetOpenMs = latest.openMs + INTERVAL_MS;
  const openRaw = await publicFetch("/markets", { series_ticker: SERIES, status: "open", limit: 100 });
  const candidates = (openRaw.markets ?? []).filter((market) =>
    typeof market?.ticker === "string" && market.ticker.startsWith("KXETH15M-")
    && typeof market?.open_time === "string" && Date.parse(market.open_time) === targetOpenMs);
  if (candidates.length !== 1) {
    log("FAIL_CLOSED", { reason: "exact_target_market_unavailable", signalTicker: latest.ticker, targetOpenMs });
    return;
  }
  const targetTicker = candidates[0].ticker;
  const step = Number(currentState?.step ?? 0);
  if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("invalid durable K step");
  const principalCents = PRINCIPAL_CENTS[step];
  const contracts = Math.floor(principalCents / LIMIT_CENTS);
  const clientId = `${targetTicker}:kamakazee-k-v1`;
  const reserved = await db.execute(sql`
    INSERT INTO kamakazee_orders(target_ticker, signal_ticker, client_order_id, step, principal_cents,
      requested_contracts, order_status, created_at_ms, updated_at_ms)
    VALUES(${targetTicker}, ${latest.ticker}, ${clientId}, ${step}, ${principalCents},
      ${contracts}, 'reserved', ${Date.now()}, ${Date.now()})
    ON CONFLICT (target_ticker) DO NOTHING RETURNING target_ticker`);
  if (reserved.rows.length !== 1) return;

  const payload = {
    ticker: targetTicker,
    client_order_id: clientId,
    side: "ask",
    count: `${contracts}.00`,
    price: "0.5000",
    time_in_force: "good_till_canceled",
    self_trade_prevention_type: "taker_at_cross",
    cancel_order_on_pause: true,
    exchange_index: Number(candidates[0].exchange_index),
  };
  if (!Number.isInteger(payload.exchange_index) || payload.exchange_index < 0) {
    await db.execute(sql`UPDATE kamakazee_orders SET order_status='blocked_missing_exchange_index', updated_at_ms=${Date.now()} WHERE target_ticker=${targetTicker}`);
    log("FAIL_CLOSED", { reason: "missing_exchange_index", targetTicker });
    return;
  }
  try {
    const response = await authFetch("POST", "/portfolio/orders", payload);
    const parsed = orderFields(response);
    if (!parsed.orderId) throw new Error("V2 create response missing order identity");
    await db.execute(sql`UPDATE kamakazee_orders SET kalshi_order_id=${parsed.orderId},
      filled_contracts=${parsed.filled}, order_status=${parsed.status ?? "submitted"},
      raw_json=${JSON.stringify(response)}::jsonb, updated_at_ms=${Date.now()} WHERE target_ticker=${targetTicker}`);
    log("ORDER_SUBMITTED", { targetTicker, side: "NO", principalDollars: principalCents / 100,
      step, contracts, limitPriceCents: LIMIT_CENTS, timeInForce: "GTC", kalshiOrderId: parsed.orderId });
  } catch (error) {
    log("FAIL_CLOSED", { reason: "submission_failed_or_unknown", targetTicker,
      error: String(error?.message ?? error), status: error?.status ?? null, body: error?.body ?? null });
  }
}

await init();
await authFetch("GET", "/portfolio/balance");
log("STARTUP", { executable: true, live: process.env.KAMAKAZEE_LIVE_ENABLED === "true",
  series: SERIES, endpoint: "/portfolio/orders", limitPriceCents: LIMIT_CENTS,
  principalLadderDollars: PRINCIPAL_CENTS.map((value) => value / 100), orderType: "GTC" });
await evaluate();
setInterval(() => {
  if (inFlight) return;
  inFlight = true;
  evaluate().catch((error) => log("FAIL_CLOSED", { reason: "unexpected_evaluation_error", error: String(error?.message ?? error) }))
    .finally(() => { inFlight = false; });
}, POLL_MS);
