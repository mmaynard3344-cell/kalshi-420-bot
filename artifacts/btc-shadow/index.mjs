import http from "node:http";
import { createHash, createSign } from "node:crypto";
import { evaluatePortfolio, SERVICES, WINDOW_MS, HISTORY_MS } from "./signals.mjs";
import { bootstrapHistory, parseFact, selectCurrent, parseCandles, publicJson, PUBLIC_BASE } from "./client.mjs";

const LIVE_ENABLED = process.env.BTC_LIVE_ENABLED === "true" && process.env.TRADING_ENABLED === "true";
const ORDER_EXECUTION_ENABLED =
  process.env.ORDER_EXECUTION_ENABLED === "true";
const STAKE_CENTS = 500;
const TRADE_BASE = "https://external-api.kalshi.com/trade-api/v2";

let history = [], candles = [], lastHistoryMs = 0, lastCandleMs = 0, busy = false;
let initializing = true, lastError = null, candleError = null, lastSuccessMs = null, currentTicker = null, evaluations = [];
const startedAtMs = Date.now();
const totals = Object.fromEntries(SERVICES.map((service) => [service, { evaluations: 0, qualifyingWindows: 0, orderAttempts: 0, acceptedOrders: 0, skippedOrders: 0 }]));
const seenSignals = new Set();
const countedSignals = new Set();
const activeOrders = new Set();
const RETRYABLE_ORDER_RESULTS = new Set(["retry"]);
let lastOrderEvent = null;
const recentOrders = [];
let lastReconcileMs = 0;
let historyHydrated = false;

const json = (event) => console.log(JSON.stringify({ ...event, ordersEnabled: LIVE_ENABLED, mode: LIVE_ENABLED ? "live" : "shadow" }));

function normalizePem(raw) {
  let s = raw.replace(/\\n/g, "\n").trim();
  const m = s.match(/^(-----BEGIN [^-]+-----)\s+([A-Za-z0-9+/\s=]+?)\s*(-----END [^-]+-----)$/s);
  if (m) {
    const body = m[2].replace(/\s+/g, "");
    s = [m[1], ...(body.match(/.{1,64}/g) ?? []), m[3]].join("\n");
  }
  return s;
}

function authHeaders(method, path) {
  const keyId = process.env.KALSHI_API_KEY_ID;
  const rawKey = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !rawKey) throw new Error("kalshi_credentials_missing");
  const timestamp = Date.now().toString();
  const cleanPath = path.split("?")[0];
  const sign = createSign("SHA256");
  sign.update(timestamp + method.toUpperCase() + "/trade-api/v2" + cleanPath);
  sign.end();
  const signature = sign.sign({ key: normalizePem(rawKey), padding: 6, saltLength: 32 }).toString("base64");
  return {
    "content-type": "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

async function authJson(method, path, body) {
  const response = await fetch(TRADE_BASE + path, {
    method,
    headers: authHeaders(method, path),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? payload?.error ?? response.statusText;
    throw new Error("kalshi_" + response.status + ":" + String(detail));
  }
  return payload;
}

function quoteCents(market, side) {
  const raw = side === "yes" ? (market.yes_ask ?? market.yes_ask_dollars) : (market.no_ask ?? market.no_ask_dollars);
  if (typeof raw === "number") {
    if (raw >= 1 && raw <= 99) return Math.round(raw);
    if (raw > 0 && raw < 1) return Math.round(raw * 100);
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      if (n >= 1 && n <= 99) return Math.round(n);
      if (n > 0 && n < 1) return Math.round(n * 100);
    }
  }
  return null;
}

function deterministicUuid(service, ticker) {
  const hex = createHash("sha256").update("btc-b-l-live-v1:" + service + ":" + ticker).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = (8 + (parseInt(hex[16], 16) % 4)).toString(16);
  const h = hex.join("");
  return h.slice(0,8) + "-" + h.slice(8,12) + "-" + h.slice(12,16) + "-" + h.slice(16,20) + "-" + h.slice(20);
}

function orderPayload(ticker, side, clientOrderId, contracts, outcomePriceCents) {
  return {
    ticker,
    client_order_id: clientOrderId,
    side: side === "yes" ? "bid" : "ask",
    count: contracts + ".00",
    price: ((side === "yes" ? outcomePriceCents : 100 - outcomePriceCents) / 100).toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };
}

async function alreadySubmitted(ticker, clientOrderId) {
  const qs = new URLSearchParams({ ticker, limit: "100" });
  const raw = await authJson("GET", "/portfolio/orders?" + qs.toString());
  return Array.isArray(raw.orders) && raw.orders.some((o) => o?.ticker === ticker && o?.client_order_id === clientOrderId);
}

async function freshBalanceCents() {
  const raw = await authJson("GET", "/portfolio/balance");
  const n = Number(raw.balance ?? raw.available_balance ?? raw.available_balance_cents);
  if (!Number.isFinite(n)) throw new Error("kalshi_balance_unavailable");
  return Math.floor(n);
}

async function executeDecision(decision, market) {
  if (!LIVE_ENABLED || !decision.fires || (decision.side !== "yes" && decision.side !== "no")) return "terminal";
  if (decision.service === "J" || decision.service === "K") return "terminal";

  const key = decision.service + ":" + decision.ticker;
  if (activeOrders.has(key)) return "retry";
  activeOrders.add(key);
  totals[decision.service].orderAttempts++;

  try {
    const limitPriceCents = Number(decision.limitPriceCents ?? 50);
    const fresh = await publicJson(`${PUBLIC_BASE}/markets/${encodeURIComponent(decision.ticker)}`);
    const quoteMarket = fresh?.market ?? fresh;
    const askCents = quoteCents(quoteMarket, decision.side);
    if (!Number.isInteger(askCents) || askCents < 1 || askCents > 99) {
      totals[decision.service].skippedOrders++;
      json({ event: "btc_live_order_skipped", service: decision.service, ticker: decision.ticker, side: decision.side, reason: "executable_ask_unavailable", retryable: true });
      return "retry";
    }
    if (askCents > limitPriceCents) {
      totals[decision.service].skippedOrders++;
      json({ event: "btc_live_order_skipped", service: decision.service, ticker: decision.ticker, side: decision.side, askCents, limitPriceCents, reason: "ask_above_limit", retryable: true });
      return "retry";
    }

    const contracts = Math.floor(STAKE_CENTS / askCents);
    if (contracts < 1) {
      totals[decision.service].skippedOrders++;
      json({ event: "btc_live_order_skipped", service: decision.service, ticker: decision.ticker, side: decision.side, askCents, reason: "stake_too_small", retryable: false });
      return "terminal";
    }

    const balance = await freshBalanceCents();
    const required = contracts * askCents;
    if (balance < required) {
      totals[decision.service].skippedOrders++;
      json({ event: "btc_live_order_skipped", service: decision.service, ticker: decision.ticker, side: decision.side, balanceCents: balance, requiredCents: required, reason: "insufficient_fresh_balance", retryable: true });
      return "retry";
    }

    const clientOrderId = deterministicUuid(decision.service, decision.ticker);
    if (await alreadySubmitted(decision.ticker, clientOrderId)) {
      totals[decision.service].skippedOrders++;
      json({ event: "btc_live_order_skipped", service: decision.service, ticker: decision.ticker, side: decision.side, clientOrderId, reason: "exchange_duplicate_exists", retryable: false });
      return "terminal";
    }

    if (!ORDER_EXECUTION_ENABLED) {
      totals[decision.service].skippedOrders++;
      lastOrderEvent = {
        at: new Date().toISOString(), service: decision.service, ticker: decision.ticker, side: decision.side,
        askCents, contracts, principalCents: required, clientOrderId,
        status: "verification_only",
      };
      json({ event: "btc_live_order_would_submit", ...lastOrderEvent, reason: "review_branch_execution_disabled" });
      return "terminal";
    }

    const raw = await authJson("POST", "/portfolio/events/orders",
      orderPayload(decision.ticker, decision.side, clientOrderId, contracts, askCents));
    totals[decision.service].acceptedOrders++;
    lastOrderEvent = {
      at: new Date().toISOString(), service: decision.service, ticker: decision.ticker, side: decision.side,
      askCents, contracts, principalCents: required, clientOrderId,
      orderId: raw?.order?.order_id ?? raw?.order_id ?? null,
      status: raw?.order?.status ?? raw?.status ?? "accepted",
    };
    const order = raw?.order ?? raw ?? {};
    const filledContracts = firstFinite(order.fill_count_fp, order.fill_count, order.filled_count_fp, order.filled_count) ?? 0;
    const remainingContracts = firstFinite(order.remaining_count_fp, order.remaining_count);
    const yesPx = firstFinite(order.yes_price_dollars, order.yes_price);
    const noPx = firstFinite(order.no_price_dollars, order.no_price);
    const outcomePx = decision.side === "yes" ? yesPx : noPx;
    const avgFillCents = outcomePx == null ? null : (outcomePx <= 1 ? outcomePx * 100 : outcomePx);
    const feeUsd = firstFinite(order.taker_fees_dollars, order.maker_fees_dollars, order.fees_dollars, order.fee_dollars);
    addRecentOrder({
      at: lastOrderEvent.at, service: decision.service, ticker: decision.ticker, side: decision.side,
      requestedPrincipalCents: required, requestedContracts: contracts, filledContracts, remainingContracts,
      avgFillCents, feeUsd, pnlUsd: null, clientOrderId, orderId: lastOrderEvent.orderId, status: lastOrderEvent.status,
    });
    json({ event: "btc_live_order_submitted", ...lastOrderEvent });
    return "submitted";
  } catch (error) {
    totals[decision.service].skippedOrders++;
    json({ event: "btc_live_order_error", service: decision.service, ticker: decision.ticker, side: decision.side,
      error: error instanceof Error ? error.message : "order_failed", retryable: true });
    return "retry";
  } finally {
    activeOrders.delete(key);
  }
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function addRecentOrder(row) {
  const key = String(row.orderId ?? row.clientOrderId ?? "");
  if (key) {
    const existing = recentOrders.findIndex((candidate) =>
      String(candidate.orderId ?? candidate.clientOrderId ?? "") === key);
    if (existing >= 0) recentOrders.splice(existing, 1);
  }
  recentOrders.unshift(row);
  recentOrders.sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
  if (recentOrders.length > 100) recentOrders.length = 100;
}

function centsFromOrderPrice(order, side) {
  const dollars = firstFinite(
    side === "yes" ? order?.yes_price_dollars : order?.no_price_dollars,
  );
  if (dollars != null) return dollars <= 1 ? Math.round(dollars * 100) : Math.round(dollars);
  const legacy = firstFinite(side === "yes" ? order?.yes_price : order?.no_price);
  if (legacy == null) return null;
  return legacy <= 1 ? Math.round(legacy * 100) : Math.round(legacy);
}

function dollarsFromFillPrice(fill, side) {
  const dollars = firstFinite(
    side === "yes" ? fill?.yes_price_dollars : fill?.no_price_dollars,
  );
  if (dollars != null) return dollars <= 1 ? dollars : dollars / 100;
  const legacy = firstFinite(side === "yes" ? fill?.yes_price : fill?.no_price);
  if (legacy == null) return null;
  return legacy <= 1 ? legacy : legacy / 100;
}

function serviceForExchangeOrder(order) {
  const ticker = String(order?.ticker ?? order?.market_ticker ?? "");
  const clientOrderId = String(order?.client_order_id ?? order?.clientOrderId ?? "");
  if (!/^KXBTC15M-[A-Z0-9-]+$/.test(ticker) || !clientOrderId) return null;
  for (const service of SERVICES) {
    if (service === "J" || service === "K") continue;
    if (deterministicUuid(service, ticker) === clientOrderId) return service;
  }
  return null;
}

async function hydrateRecentOrdersFromExchange() {
  if (historyHydrated) return;
  const raw = await authJson("GET", "/portfolio/orders?limit=100");
  const orders = Array.isArray(raw?.orders) ? raw.orders : [];
  for (const order of orders) {
    const service = serviceForExchangeOrder(order);
    if (!service) continue;
    const ticker = String(order?.ticker ?? order?.market_ticker ?? "");
    const sideValue = String(order?.side ?? "").toLowerCase();
    const action = String(order?.action ?? "buy").toLowerCase();
    let economicSide = sideValue;
    if (sideValue === "bid") economicSide = "yes";
    else if (sideValue === "ask") economicSide = "no";
    else if (action === "sell" && sideValue === "yes") economicSide = "no";
    else if (action === "sell" && sideValue === "no") economicSide = "yes";
    if (economicSide !== "yes" && economicSide !== "no") continue;
    const requestedContracts = firstFinite(order?.initial_count_fp, order?.initial_count, order?.count_fp, order?.count) ?? 0;
    const filledContracts = firstFinite(order?.fill_count_fp, order?.fill_count, order?.filled_count_fp, order?.filled_count) ?? 0;
    const outcomePriceCents = centsFromOrderPrice(order, economicSide);
    const created = order?.created_time ?? order?.created_at ?? order?.createdAt ?? new Date().toISOString();
    addRecentOrder({
      at: created,
      service,
      ticker,
      side: economicSide,
      requestedPrincipalCents: outcomePriceCents == null ? null : Math.round(requestedContracts * outcomePriceCents),
      requestedContracts,
      filledContracts,
      remainingContracts: firstFinite(order?.remaining_count_fp, order?.remaining_count),
      avgFillCents: null,
      feeUsd: null,
      pnlUsd: null,
      marketResult: null,
      outcome: filledContracts > 0 ? "PENDING" : "NO FILL",
      clientOrderId: order?.client_order_id ?? order?.clientOrderId ?? null,
      orderId: order?.order_id ?? order?.orderId ?? null,
      status: order?.status ?? "accepted",
    });
  }
  historyHydrated = true;
}

async function reconcileRecentOrders() {
  if (!recentOrders.length) return;
  const [fillRaw, marketRaw] = await Promise.all([
    authJson("GET", "/portfolio/fills?limit=200"),
    publicJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=100`),
  ]);
  const fills = Array.isArray(fillRaw?.fills) ? fillRaw.fills : [];
  const settledMarkets = Array.isArray(marketRaw?.markets) ? marketRaw.markets : [];
  const resultByTicker = new Map(
    settledMarkets
      .filter((market) => ["yes", "no"].includes(String(market?.result ?? "").toLowerCase()))
      .map((market) => [String(market.ticker), String(market.result).toLowerCase()]),
  );
  const fillsByOrder = new Map();
  for (const fill of fills) {
    const id = String(fill?.order_id ?? fill?.orderId ?? "");
    if (!id) continue;
    const rows = fillsByOrder.get(id) ?? [];
    rows.push(fill);
    fillsByOrder.set(id, rows);
  }

  for (const row of recentOrders) {
    const orderFills = fillsByOrder.get(String(row.orderId ?? "")) ?? [];
    let filledContracts = 0;
    let principalUsd = 0;
    let feesUsd = 0;
    let weightedCents = 0;
    for (const fill of orderFills) {
      const contracts = firstFinite(fill?.count_fp, fill?.count) ?? 0;
      const priceUsd = dollarsFromFillPrice(fill, row.side);
      if (!(contracts > 0) || priceUsd == null) continue;
      const fillFee = firstFinite(fill?.fee_cost_dollars, fill?.fee_cost, 0) ?? 0;
      filledContracts += contracts;
      principalUsd += contracts * priceUsd;
      feesUsd += fillFee;
      weightedCents += contracts * priceUsd * 100;
    }
    if (filledContracts > 0) {
      row.filledContracts = filledContracts;
      row.avgFillCents = weightedCents / filledContracts;
      row.feeUsd = feesUsd;
      row.status = filledContracts >= Number(row.requestedContracts ?? 0) ? "EXECUTED" : "PARTIAL FILL";
    } else if (row.filledContracts == null) {
      row.filledContracts = 0;
    }

    const result = resultByTicker.get(String(row.ticker)) ?? null;
    row.marketResult = result;
    if (!result) {
      row.outcome = filledContracts > 0 ? "PENDING" : "NO FILL";
      row.pnlUsd = null;
      continue;
    }
    if (filledContracts <= 0) {
      row.outcome = result.toUpperCase() + " · NO FILL";
      row.pnlUsd = 0;
      row.feeUsd = row.feeUsd ?? 0;
      row.status = "NO FILL";
      continue;
    }
    const won = row.side === result;
    row.outcome = result.toUpperCase() + (won ? " · WIN" : " · LOSS");
    row.pnlUsd = won
      ? filledContracts - principalUsd - feesUsd
      : -principalUsd - feesUsd;
  }
}

function renderRecentOrders(rows) {
  if (!rows.length) return '<tr><td colspan="11">No BTC orders found in recent exchange history.</td></tr>';
  return rows.map((o) => {
    const when = o.at ? new Date(o.at).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '—';
    const avg = o.avgFillCents == null ? '—' : Number(o.avgFillCents).toFixed(1) + '¢';
    const fee = o.feeUsd == null ? '—' : '$' + Number(o.feeUsd).toFixed(2);
    const pnl = o.pnlUsd == null ? 'Pending' : (Number(o.pnlUsd) >= 0 ? '+$' : '-$') + Math.abs(Number(o.pnlUsd)).toFixed(2);
    const requested = o.requestedPrincipalCents == null ? '—' : '$' + (Number(o.requestedPrincipalCents) / 100).toFixed(2);
    return '<tr><td>' + esc(when) + '</td><td>' + esc(o.service) + '</td><td>' + esc(o.ticker) + '</td><td>' + esc(o.side?.toUpperCase()) + '</td><td>' + requested + '</td><td>' + esc(o.filledContracts ?? 0) + '/' + esc(o.requestedContracts ?? '—') + '</td><td>' + avg + '</td><td>' + esc(o.status) + '</td><td>' + esc(o.outcome ?? 'Pending') + '</td><td>' + fee + '</td><td>' + pnl + '</td></tr>';
  }).join('');
}
const status = () => ({
  service: "BTC B-L",
  version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? "unknown",
  mode: LIVE_ENABLED ? "live" : "shadow",
  ordersEnabled: LIVE_ENABLED,
  stakeCents: STAKE_CENTS,
  initializing, lastSuccessMs, currentTicker, lastError, candleError, lastOrderEvent,
  countersSinceMs: startedAtMs, historyCount: history.length, candleCount: candles.length,
  healthy: !initializing && lastSuccessMs != null && Date.now() - lastSuccessMs < 60_000,
  services: evaluations.map((e) => ({ ...e, totals: totals[e.service] })),
  recentOrders: recentOrders.slice(0,50),
  exclusions: { A: "not_requested", J: "requires BTC A order; no BTC A is running", K: "weather_only" },
});

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
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>BTC B–L</title><style>body{background:#101722;color:#e7eef7;font:16px system-ui;max-width:1080px;margin:32px auto;padding:0 16px}h1{font-size:26px}p{color:#a9b9cd}.badge{color:#8adbc1}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;border-bottom:1px solid #2c3949;padding:12px 8px}.wrap{overflow:auto}.yes{color:#8adbc1}.quiet{color:#a9b9cd}footer{margin-top:24px;color:#a9b9cd;font-size:13px}</style></head><body><h1>BTC B–L</h1><p class="badge">${LIVE_ENABLED ? "LIVE · Real-money IOC orders enabled" : "SHADOW · Real-money orders disabled"} · $5 principal cap per signal</p><p>${esc(currentTicker)} · Updated ${esc(lastSuccessMs ? new Date(lastSuccessMs).toISOString() : "initializing")}</p><h2>Recent BTC Orders</h2><div class="wrap"><table><thead><tr><th>Time ET</th><th>Service</th><th>Ticker</th><th>Side</th><th>Requested</th><th>Filled</th><th>Avg Fill</th><th>Status</th><th>Outcome</th><th>Fee</th><th>P&amp;L</th></tr></thead><tbody>${renderRecentOrders(s.recentOrders)}</tbody></table></div><h2>Signal Status</h2><div class="wrap"><table><thead><tr><th>Service</th><th>Signal</th><th>Side</th><th>Stake</th><th>Reason</th><th>Orders</th></tr></thead><tbody>${s.services.map((e) => `<tr><td>${esc(e.service)}</td><td class="${e.fires ? "yes" : "quiet"}">${e.fires ? "QUALIFIES" : "WAITING"}</td><td>${esc(e.side?.toUpperCase())}</td><td>${e.service === "K" ? "—" : "$5.00"}</td><td>${esc(e.reason)}</td><td>${e.totals.acceptedOrders}</td></tr>`).join("")}</tbody></table></div><footer>B always YES. Live signals use executable ask ≤ strategy limit, IOC, and a maximum $5 principal. J remains inactive without BTC A. K remains weather-only. ETH services are separate.</footer></body></html>`);
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => json({ event: "btc_runtime_http_started", port: Number(process.env.PORT ?? 8080) }));

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    if (!history.length) history = await bootstrapHistory(now);
    if (!historyHydrated) {
      try { await hydrateRecentOrdersFromExchange(); }
      catch (error) { json({ event: "btc_order_history_hydration_error", error: error instanceof Error ? error.message : "history_hydration_failed" }); }
    }
    if (now - lastReconcileMs >= 30_000) {
      try {
        await reconcileRecentOrders();
        lastReconcileMs = now;
      } catch (error) {
        json({ event: "btc_order_reconciliation_error", error: error instanceof Error ? error.message : "order_reconciliation_failed" });
      }
    }
    if (now - lastHistoryMs > 30_000) {
      const settled = await publicJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=32`);
      if (!Array.isArray(settled.markets)) throw new Error("invalid_settled_catalog");
      const map = new Map(history.map((f) => [f.ticker, f]));
      for (const row of settled.markets) { const fact = parseFact(row); if (fact) map.set(fact.ticker, fact); }
      history = [...map.values()].filter((f) => f.openTimeMs >= now - HISTORY_MS - 2 * WINDOW_MS);
      lastHistoryMs = now;
    }
    let open = null;
    let market = null;
    for (let attempt = 0; attempt < 3 && !market; attempt++) {
      open = await publicJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M&status=open&limit=20`);
      if (!Array.isArray(open.markets)) throw new Error("invalid_open_catalog");
      market = selectCurrent(open.markets, Date.now());
      if (!market && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
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
      if (e.fires && !seenSignals.has(key)) {
        if (!countedSignals.has(key)) {
          countedSignals.add(key);
          totals[e.service].qualifyingWindows++;
        }
        const result = await executeDecision(e, market);
        if (!RETRYABLE_ORDER_RESULTS.has(result)) seenSignals.add(key);
      }
    }
    if (seenSignals.size > 10_000) seenSignals.clear();
    if (countedSignals.size > 10_000) countedSignals.clear();
    initializing = false; lastError = null; lastSuccessMs = Date.now(); currentTicker = market.ticker;
    json({ event: "btc_runtime_evaluation", timestamp: new Date(lastSuccessMs).toISOString(), ticker: currentTicker,
      stakeCents: STAKE_CENTS, historyCount: history.length, candleCount: candles.length,
      services: evaluations.map(({ service, fires, side, reason }) => ({ service, fires, side, reason })) });
  } catch (error) {
    lastError = error instanceof Error ? error.message : "evaluation_failed";
    json({ event: "btc_runtime_error", error: lastError });
  } finally { busy = false; }
}
void tick();
const timer = setInterval(() => void tick(), 10_000);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
