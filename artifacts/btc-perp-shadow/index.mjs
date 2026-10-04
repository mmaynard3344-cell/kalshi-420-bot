import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { evaluatePortfolio, WINDOW_MS, HISTORY_MS } from "../btc-shadow/signals.mjs";
import { bootstrapHistory, parseFact, selectCurrent, PUBLIC_BASE } from "../btc-shadow/client.mjs";

const SERVICES = new Set(["B", "G", "H", "I"]);
const TPS = [0.0020, 0.0030, 0.0040, 0.0050];
const SLS = [0.0015, 0.0020, 0.0025, 0.0030];
const HOLDS_MIN = [15, 30, 45, 60];
const NOTIONAL_USD = Number(process.env.PERP_SHADOW_NOTIONAL_USD ?? 10);
const LEVERAGE = 1;
const FEE_BPS_PER_SIDE = Number(process.env.PERP_TAKER_FEE_BPS ?? 12);
const FEE_RATE = FEE_BPS_PER_SIDE / 10_000;
const POLL_MS = 10_000;
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const STATE_PATH = path.join(DATA_DIR, "btc-perp-shadow-state.json");
const KRAKEN_OHLC = "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1";

let history = [];
let lastHistoryMs = 0;
let busy = false;
let currentTicker = null;
let lastSuccessMs = null;
let lastError = null;
let latestPrice = null;

function emptyState() {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    seenSignals: [],
    signals: [],
    virtualTrades: [],
  };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!raw || raw.version !== 1) return emptyState();
    raw.seenSignals ??= [];
    raw.signals ??= [];
    raw.virtualTrades ??= [];
    return raw;
  } catch {
    return emptyState();
  }
}

let state = loadState();
const seen = new Set(state.seenSignals);

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.seenSignals = [...seen].slice(-5000);
  if (state.signals.length > 2000) state.signals = state.signals.slice(-2000);
  if (state.virtualTrades.length > 100000) state.virtualTrades = state.virtualTrades.slice(-100000);
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_PATH);
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error("http_" + r.status + ":" + new URL(url).hostname);
  return r.json();
}

function parseOneMinuteCandles(body) {
  if (Array.isArray(body.error) && body.error.length) throw new Error("kraken_ohlc_error");
  const rows = Object.entries(body.result ?? {}).filter(([k]) => k !== "last");
  if (rows.length !== 1 || !Array.isArray(rows[0][1])) throw new Error("invalid_kraken_ohlc");
  return rows[0][1].map((r) => ({
    openTimeMs: Number(r[0]) * 1000,
    closeTimeMs: Number(r[0]) * 1000 + 60_000,
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
  })).filter((c) => Number.isFinite(c.close) && c.close > 0).sort((a,b) => a.openTimeMs - b.openTimeMs);
}

function direction(side) {
  return side === "yes" ? "long" : side === "no" ? "short" : null;
}

function targetPrice(entry, dir, tp) {
  return dir === "long" ? entry * (1 + tp) : entry * (1 - tp);
}
function stopPrice(entry, dir, sl) {
  return dir === "long" ? entry * (1 - sl) : entry * (1 + sl);
}

function markToMarketReturn(entry, exit, dir) {
  return dir === "long" ? (exit - entry) / entry : (entry - exit) / entry;
}

function createVirtualTrades(signal) {
  for (const tp of TPS) for (const sl of SLS) for (const holdMin of HOLDS_MIN) {
    state.virtualTrades.push({
      id: signal.id + ":" + Math.round(tp*10000) + ":" + Math.round(sl*10000) + ":" + holdMin,
      signalId: signal.id,
      service: signal.service,
      direction: signal.direction,
      entryMs: signal.entryMs,
      entryPrice: signal.entryPrice,
      tp,
      sl,
      holdMin,
      status: "open",
      exitMs: null,
      exitPrice: null,
      exitReason: null,
      grossReturn: null,
      netReturn: null,
      pnlUsd: null,
    });
  }
}

function hitForCandle(v, c) {
  const tpPx = targetPrice(v.entryPrice, v.direction, v.tp);
  const slPx = stopPrice(v.entryPrice, v.direction, v.sl);
  const hitTp = v.direction === "long" ? c.high >= tpPx : c.low <= tpPx;
  const hitSl = v.direction === "long" ? c.low <= slPx : c.high >= slPx;
  if (hitTp && hitSl) return { reason: "sl_same_bar_conservative", price: slPx };
  if (hitSl) return { reason: "sl", price: slPx };
  if (hitTp) return { reason: "tp", price: tpPx };
  return null;
}

function settleVirtualTrades(candles, nowMs) {
  let changed = false;
  for (const v of state.virtualTrades) {
    if (v.status !== "open") continue;
    const deadline = v.entryMs + v.holdMin * 60_000;
    const relevant = candles.filter((c) => c.openTimeMs >= Math.floor(v.entryMs / 60_000) * 60_000 && c.openTimeMs < deadline);
    let exit = null;
    for (const c of relevant) {
      const hit = hitForCandle(v, c);
      if (hit) { exit = { ...hit, ms: c.closeTimeMs }; break; }
    }
    if (!exit && nowMs >= deadline) {
      const eligible = candles.filter((c) => c.closeTimeMs <= deadline);
      const last = eligible[eligible.length - 1];
      if (last) exit = { reason: "time", price: last.close, ms: deadline };
    }
    if (!exit) continue;
    const gross = markToMarketReturn(v.entryPrice, exit.price, v.direction);
    const net = gross - 2 * FEE_RATE;
    Object.assign(v, {
      status: "closed",
      exitMs: exit.ms,
      exitPrice: exit.price,
      exitReason: exit.reason,
      grossReturn: gross,
      netReturn: net,
      pnlUsd: NOTIONAL_USD * net,
    });
    changed = true;
    console.log(JSON.stringify({ event: "btc_perp_shadow_exit", service: v.service, direction: v.direction,
      tp: v.tp, sl: v.sl, holdMin: v.holdMin, exitReason: v.exitReason,
      grossReturn: v.grossReturn, netReturn: v.netReturn, pnlUsd: v.pnlUsd }));
  }
  if (changed) saveState();
}

function liveOpenSimulations(nowMs = Date.now()) {
  if (!Number.isFinite(latestPrice)) return [];
  return state.virtualTrades.filter((v) => v.status === "open").map((v) => {
    const tpPx = targetPrice(v.entryPrice, v.direction, v.tp);
    const slPx = stopPrice(v.entryPrice, v.direction, v.sl);
    const gross = markToMarketReturn(v.entryPrice, latestPrice, v.direction);
    const net = gross - 2 * FEE_RATE;
    const tpDistance = v.direction === "long" ? (tpPx - latestPrice) / latestPrice : (latestPrice - tpPx) / latestPrice;
    const slDistance = v.direction === "long" ? (latestPrice - slPx) / latestPrice : (slPx - latestPrice) / latestPrice;
    const remainingMs = Math.max(0, v.entryMs + v.holdMin * 60_000 - nowMs);
    return {
      id: v.id, service: v.service, direction: v.direction,
      entryMs: v.entryMs, entryPrice: v.entryPrice, currentPrice: latestPrice,
      tp: v.tp, tpPrice: tpPx, tpDistance,
      sl: v.sl, slPrice: slPx, slDistance,
      holdMin: v.holdMin, remainingSeconds: Math.ceil(remainingMs / 1000),
      grossReturn: gross, netReturn: net, pnlUsd: NOTIONAL_USD * net,
    };
  }).sort((a,b) => a.holdMin - b.holdMin || a.tp - b.tp || a.sl - b.sl);
}

function aggregate() {
  const map = new Map();
  for (const v of state.virtualTrades) {
    if (v.status !== "closed") continue;
    const key = [v.service, v.tp, v.sl, v.holdMin].join("|");
    let x = map.get(key);
    if (!x) x = { service:v.service,tp:v.tp,sl:v.sl,holdMin:v.holdMin,n:0,wins:0,netReturnSum:0,pnlUsd:0,tpExits:0,slExits:0,timeExits:0 };
    x.n++;
    if (v.netReturn > 0) x.wins++;
    x.netReturnSum += v.netReturn;
    x.pnlUsd += v.pnlUsd;
    if (v.exitReason === "tp") x.tpExits++;
    else if (v.exitReason?.startsWith("sl")) x.slExits++;
    else if (v.exitReason === "time") x.timeExits++;
    map.set(key,x);
  }
  return [...map.values()].map((x) => ({
    ...x,
    winRate: x.n ? x.wins/x.n : null,
    avgNetReturn: x.n ? x.netReturnSum/x.n : null,
  })).sort((a,b) => b.avgNetReturn - a.avgNetReturn);
}

function esc(s) {
  return String(s ?? "—").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function status() {
  const open = state.virtualTrades.filter((v) => v.status === "open").length;
  const closed = state.virtualTrades.length - open;
  return {
    experiment: "BTC Perp B/G/H/I Shadow",
    mode: "shadow_only",
    ordersEnabled: false,
    source: "BTC KXBTC15M signals + Kraken XBTUSD 1m spot proxy",
    currentTicker, latestPrice, lastSuccessMs, lastError,
    notionalUsd: NOTIONAL_USD, leverage: LEVERAGE, takerFeeBpsPerSide: FEE_BPS_PER_SIDE,
    signalCount: state.signals.length, openVirtualTrades: open, closedVirtualTrades: closed,
    grid: { takeProfit:[...TPS], stopLoss:[...SLS], maxHoldMinutes:[...HOLDS_MIN] },
    recentSignals: state.signals.slice(-20).reverse(),
    openSimulations: liveOpenSimulations(),
    leaderboard: aggregate().slice(0,40),
  };
}

const server = http.createServer((req,res) => {
  if (req.method !== "GET") { res.writeHead(405); res.end("read only"); return; }
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const s = status();
  if (pathname === "/health") {
    const healthy = lastSuccessMs != null && Date.now() - lastSuccessMs < 60_000;
    res.writeHead(healthy ? 200 : 503, {"content-type":"application/json","cache-control":"no-store"});
    res.end(JSON.stringify({healthy,...s})); return;
  }
  if (pathname === "/status") {
    res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
    res.end(JSON.stringify(s)); return;
  }
  if (pathname !== "/") { res.writeHead(404); res.end("not found"); return; }
  const liveRows = s.openSimulations.map((x) => {
    const mins = Math.floor(x.remainingSeconds / 60);
    const secs = String(x.remainingSeconds % 60).padStart(2, "0");
    return `<tr><td>${esc(x.service)}</td><td>${esc(x.direction.toUpperCase())}</td><td>${x.entryPrice.toFixed(1)}</td><td>${x.currentPrice.toFixed(1)}</td><td>${(x.tp*100).toFixed(2)}%</td><td>${(x.tpDistance*100).toFixed(3)}%</td><td>${(x.sl*100).toFixed(2)}%</td><td>${(x.slDistance*100).toFixed(3)}%</td><td>${x.holdMin}m</td><td>${mins}:${secs}</td><td>${(x.grossReturn*100).toFixed(3)}%</td><td>${(x.netReturn*100).toFixed(3)}%</td><td>${x.pnlUsd.toFixed(3)}</td></tr>`;
  }).join("");
  const rows = s.leaderboard.slice(0,20).map((x) =>
    `<tr><td>${esc(x.service)}</td><td>${(x.tp*100).toFixed(2)}%</td><td>${(x.sl*100).toFixed(2)}%</td><td>${x.holdMin}m</td><td>${x.n}</td><td>${(x.winRate*100).toFixed(1)}%</td><td>${(x.avgNetReturn*100).toFixed(3)}%</td><td>${x.pnlUsd.toFixed(3)}</td></tr>`
  ).join("");
  res.writeHead(200, {"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>BTC Perp Shadow</title><style>body{background:#101722;color:#e7eef7;font:15px system-ui;max-width:1280px;margin:30px auto;padding:0 16px}h1{font-size:26px}h2{font-size:18px;margin-top:28px}.ok{color:#8adbc1}p{color:#a9b9cd}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px 7px;border-bottom:1px solid #2c3949;text-align:right}th:first-child,td:first-child{text-align:left}.wrap{overflow:auto}</style></head><body><h1>BTC Perpetual Experiment</h1><p class="ok">SHADOW ONLY · no Kalshi perp orders can be placed</p><p>B/G/H/I · 1× · $${NOTIONAL_USD.toFixed(2)} modeled notional · ${FEE_BPS_PER_SIDE.toFixed(1)} bps/side fee assumption · Kraken XBTUSD 1-minute proxy</p><p>Signals: ${s.signalCount} · Open paths: ${s.openVirtualTrades} · Closed paths: ${s.closedVirtualTrades} · BTC proxy: ${latestPrice ?? "—"}</p><h2>Open simulated trades — what would be happening now</h2><div class="wrap"><table><thead><tr><th>Signal</th><th>Bet</th><th>Entry BTC</th><th>BTC Now</th><th>Profit Target</th><th>Distance to Win</th><th>Stop Loss</th><th>Distance to Stop</th><th>Max Hold</th><th>Time Left</th><th>Price Move</th><th>After Fees</th><th>Current Profit</th></tr></thead><tbody>${liveRows || '<tr><td colspan="13">No simulations are open right now.</td></tr>'}</tbody></table></div><h2>Completed simulations — which exit plan has worked best</h2><div class="wrap"><table><thead><tr><th>Signal</th><th>Profit Target</th><th>Stop Loss</th><th>Max Hold</th><th>Samples</th><th>Win Rate</th><th>Avg After Fees</th><th>Total Sim Profit</th></tr></thead><tbody>${rows || '<tr><td colspan="8">Waiting for B/G/H/I signals to complete.</td></tr>'}</tbody></table></div></body></html>`);
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
  console.log(JSON.stringify({event:"btc_perp_shadow_started",ordersEnabled:false,mode:"shadow_only",notionalUsd:NOTIONAL_USD,feeBpsPerSide:FEE_BPS_PER_SIDE}));
});

async function refreshHistory(now) {
  if (!history.length) history = await bootstrapHistory(now);
  if (now - lastHistoryMs <= 30_000) return;
  const settled = await getJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=32`);
  if (!Array.isArray(settled.markets)) throw new Error("invalid_settled_catalog");
  const map = new Map(history.map((f) => [f.ticker,f]));
  for (const row of settled.markets) { const f = parseFact(row); if (f) map.set(f.ticker,f); }
  history = [...map.values()].filter((f) => f.openTimeMs >= now - HISTORY_MS - 2*WINDOW_MS);
  lastHistoryMs = now;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    await refreshHistory(now);
    const [open, ohlc] = await Promise.all([
      getJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M&status=open&limit=20`),
      getJson(KRAKEN_OHLC),
    ]);
    const market = selectCurrent(open.markets ?? [], now);
    if (!market) throw new Error("current_btc_market_unavailable");
    const candles = parseOneMinuteCandles(ohlc);
    if (!candles.length) throw new Error("btc_price_unavailable");
    latestPrice = candles[candles.length - 1].close;
    settleVirtualTrades(candles, now);

    const evals = evaluatePortfolio({market,history,candles:[]}).filter((e) => SERVICES.has(e.service));
    for (const e of evals) {
      if (!e.fires || !direction(e.side)) continue;
      const key = e.service + ":" + e.ticker;
      if (seen.has(key)) continue;
      const signal = {
        id: key,
        at: new Date(now).toISOString(),
        service: e.service,
        ticker: e.ticker,
        side: e.side,
        direction: direction(e.side),
        entryMs: now,
        entryPrice: latestPrice,
        reason: e.reason,
      };
      seen.add(key);
      state.signals.push(signal);
      createVirtualTrades(signal);
      saveState();
      console.log(JSON.stringify({event:"btc_perp_shadow_signal",...signal,pathsCreated:TPS.length*SLS.length*HOLDS_MIN.length,ordersEnabled:false}));
    }

    currentTicker = market.ticker;
    lastSuccessMs = Date.now();
    lastError = null;
    console.log(JSON.stringify({event:"btc_perp_shadow_tick",ticker:currentTicker,price:latestPrice,
      signals:state.signals.length,openVirtualTrades:state.virtualTrades.filter((v)=>v.status==="open").length,ordersEnabled:false}));
  } catch (e) {
    lastError = e instanceof Error ? e.message : "tick_failed";
    console.log(JSON.stringify({event:"btc_perp_shadow_error",error:lastError,ordersEnabled:false}));
  } finally {
    busy = false;
  }
}
tick();
setInterval(tick,POLL_MS);
