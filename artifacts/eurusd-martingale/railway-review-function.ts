
// EURUSD $1 PILOT SIGNAL ENGINE
// Includes explicit shard 0 routing and read-only balance diagnostics.
// Existing strategy and execution rules preserved.
// REVIEW NO-side execution semantics before enabling live orders.

import { Database } from "bun:sqlite";
import { createSign, createHash } from "node:crypto";

const BASE = "https://external-api.kalshi.com/trade-api/v2";
const EXCHANGE_INDEX = 0;
let ORDER_CAP_CENTS = 100;
// Pure USD martingale transition rules. No market access, order submission, or production writes.
const USD_STAKES_CENTS = Object.freeze([100,200,400,800,1600,3200]);
function nextUsdStep(step, outcome) {
  if (!Number.isInteger(step) || step < 0 || step >= USD_STAKES_CENTS.length) throw Error("invalid_step");
  if (outcome === "WIN") return 0;
  if (outcome === "LOSS") return (step + 1) % USD_STAKES_CENTS.length;
  if (outcome === "ZERO_FILL") return step;
  throw Error("unverified_outcome");
}
function classifyUsdSettlement({filledContracts, orderStatus, marketResult, side}) {
  if (!Number.isFinite(filledContracts) || filledContracts < 0) return "UNRESOLVED";
  if (filledContracts === 0) return ["canceled","cancelled","expired","rejected"].includes(String(orderStatus).toLowerCase()) ? "ZERO_FILL" : "UNRESOLVED";
  if (!["yes","no"].includes(marketResult) || !["YES","NO"].includes(side)) return "UNRESOLVED";
  return marketResult === side.toLowerCase() ? "WIN" : "LOSS";
}
function stakeForUsdStep(step) {
  if (!Number.isInteger(step) || step < 0 || step >= USD_STAKES_CENTS.length) throw Error("invalid_step");
  return USD_STAKES_CENTS[step];
}


function initializeUsdLadder(db,activatedAt){db.exec(`CREATE TABLE IF NOT EXISTS fx_ladder_state(id INTEGER PRIMARY KEY CHECK(id=1),step INTEGER NOT NULL DEFAULT 0 CHECK(step BETWEEN 0 AND 5),activated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS fx_ladder_events(ticker TEXT PRIMARY KEY,outcome TEXT NOT NULL CHECK(outcome IN ('WIN','LOSS','ZERO_FILL')),filled_contracts REAL NOT NULL,step_before INTEGER NOT NULL,step_after INTEGER NOT NULL,settled_at TEXT NOT NULL);`);db.query('INSERT OR IGNORE INTO fx_ladder_state(id,step,activated_at) VALUES(1,0,?)').run(activatedAt)}
function getUsdLadder(db){const x=db.query('SELECT step,activated_at,version FROM fx_ladder_state WHERE id=1').get();if(!x)throw Error('ladder_not_initialized');return {...x,budgetCents:stakeForUsdStep(x.step)}}
function applyUsdSettlement(db,o){const {ticker,createdAt,filledContracts,orderStatus,marketResult,side,settledAt}=o;if(!ticker||!createdAt||!settledAt)throw Error('missing_identity');const outcome=classifyUsdSettlement({filledContracts,orderStatus,marketResult,side});if(outcome==='UNRESOLVED')return {status:'UNRESOLVED'};db.exec('BEGIN IMMEDIATE');try{const s=getUsdLadder(db);if(createdAt<s.activated_at)throw Error('legacy_order_excluded');const old=db.query('SELECT outcome,step_after FROM fx_ladder_events WHERE ticker=?').get(ticker);if(old){db.exec('COMMIT');return {status:'ALREADY_APPLIED',step:old.step_after}}const next=nextUsdStep(s.step,outcome);db.query('INSERT INTO fx_ladder_events VALUES(?,?,?,?,?,?)').run(ticker,outcome,filledContracts,s.step,next,settledAt);db.query('UPDATE fx_ladder_state SET step=?,version=version+1 WHERE id=1').run(next);db.exec('COMMIT');return {status:'APPLIED',outcome,step:next}}catch(e){db.exec('ROLLBACK');throw e}}
function hasUnresolvedUsdOrders(db){const s=getUsdLadder(db);return Boolean(db.query("SELECT ticker FROM fx_live_order_claims WHERE created_at >= ? AND status NOT IN ('ladder_won','ladder_lost','ladder_zero_fill') LIMIT 1").get(s.activated_at))}


/**
 * Read-only exchange reconciliation adapter. The caller supplies authenticated
 * order lookup and public finalized market lookup. No live order submissions.
 */
async function reconcileUsdLadder(db,{getOrder,getMarket,findOrderByClientId,now=()=>new Date().toISOString()}) {
 const state=getUsdLadder(db);
 const claims=db.query("SELECT ticker,created_at,side,status,exchange_order_id,client_order_id FROM fx_live_order_claims WHERE created_at >= ? AND status NOT IN ('ladder_won','ladder_lost','ladder_zero_fill') ORDER BY created_at ASC").all(state.activated_at);
 for(const c of claims){
   let exchangeOrderId=c.exchange_order_id;
   if(!exchangeOrderId){
    if(typeof findOrderByClientId!=='function')return {ready:false,reason:'ORDER_ID_UNKNOWN',ticker:c.ticker};
    let matched;
    try{matched=await findOrderByClientId(c.client_order_id,c.ticker)}catch{return {ready:false,reason:'ORDER_RECOVERY_FAILED',ticker:c.ticker}}
    if(!matched?.order_id||matched.client_order_id!==c.client_order_id||matched.ticker!==c.ticker)return {ready:false,reason:'ORDER_NOT_RECOVERED',ticker:c.ticker};
    exchangeOrderId=matched.order_id;
    db.query('UPDATE fx_live_order_claims SET exchange_order_id=? WHERE ticker=? AND client_order_id=?').run(exchangeOrderId,c.ticker,c.client_order_id);
   }
   let order;
   try{order=await getOrder(exchangeOrderId)}catch{return {ready:false,reason:'ORDER_LOOKUP_FAILED',ticker:c.ticker}}
   const count=Number(order.fill_count_fp??order.fill_count??NaN);
   if(!Number.isFinite(count))return {ready:false,reason:'FILL_UNKNOWN',ticker:c.ticker};
   let market=null;
   if(count>0){
     try{market=await getMarket(c.ticker)}catch{return {ready:false,reason:'MARKET_LOOKUP_FAILED',ticker:c.ticker}}
   }
   const applied=applyUsdSettlement(db,{ticker:c.ticker,createdAt:c.created_at,filledContracts:count,orderStatus:order.status,marketResult:market?.result??null,side:c.side,settledAt:now()});
   if(applied.status==='UNRESOLVED')return {ready:false,reason:'SETTLEMENT_UNRESOLVED',ticker:c.ticker};
   const terminal=applied.outcome==='ZERO_FILL'?'ladder_zero_fill':applied.outcome==='WIN'?'ladder_won':'ladder_lost';
   db.query('UPDATE fx_live_order_claims SET status=? WHERE ticker=?').run(terminal,c.ticker);
 }
 return {ready:!hasUnresolvedUsdOrders(db),state:getUsdLadder(db)};
}



/**
 * Live USD entry gate, to be called before calculating contract count.
 * Fails closed. No submission and no simulated outcome can alter the ladder.
 */
async function prepareUsdEntry(db,api) {
  const reconciliation=await reconcileUsdLadder(db,api);
  if(!reconciliation.ready || hasUnresolvedUsdOrders(db)) {
    return {allowed:false,reason:reconciliation.reason??'UNRESOLVED_ORDER',budgetCents:null};
  }
  const state=getUsdLadder(db);
  return {allowed:true,step:state.step,budgetCents:state.budgetCents,version:state.version};
}
function validateUsdOrderBudget(prepared,requestedCostCents) {
  return Boolean(prepared?.allowed && Number.isInteger(requestedCostCents) &&
    requestedCostCents>0 && requestedCostCents<=prepared.budgetCents);
}


const db = new Database("/data/eurusd_a_dollar_pilot.sqlite", {
  create: true
});

db.exec(`
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS predictions (
 ticker TEXT PRIMARY KEY,
 observed_at TEXT NOT NULL,
 quote_time_ms INTEGER NOT NULL,
 spot_timestamp_ms INTEGER NOT NULL,
 spot REAL NOT NULL,
 strike REAL NOT NULL,
 minutes_left REAL NOT NULL,
 vol REAL NOT NULL,
 prob_yes REAL NOT NULL,
 yes_ask REAL NOT NULL,
 yes_bid REAL NOT NULL,
 side TEXT NOT NULL,
 entry_price REAL,
 contracts INTEGER NOT NULL,
 fee REAL NOT NULL,
 model_cost REAL NOT NULL,
 settlement TEXT,
 pnl REAL,
 settled_at TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
 observed_at TEXT,
 reason TEXT,
 details TEXT
);

CREATE TABLE IF NOT EXISTS simulated_reservations (
 ticker TEXT PRIMARY KEY,
 eastern_day TEXT NOT NULL,
 side TEXT NOT NULL CHECK(side IN ('YES','NO')),
 contracts INTEGER NOT NULL CHECK(contracts>0),
 max_loss_cents INTEGER NOT NULL
   CHECK(max_loss_cents BETWEEN 1 AND 100),
 status TEXT NOT NULL DEFAULT 'reserved',
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_live_order_claims (
 ticker TEXT PRIMARY KEY,
 eastern_day TEXT NOT NULL,
 client_order_id TEXT NOT NULL,
 side TEXT NOT NULL,
 contracts INTEGER NOT NULL,
 risk_cents INTEGER NOT NULL,
 status TEXT NOT NULL,
 exchange_order_id TEXT,
 created_at TEXT NOT NULL
);
`);

const easternDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);

const takerFeeCents = (
  n: number,
  priceCents: number
) => Math.ceil(
  0.07 * n * priceCents * (100 - priceCents) / 100
);

function simulateReserve(
  ticker: string,
  side: string,
  contracts: number,
  price: number
) {
  if (
    !ticker.startsWith("KXEURUSD15M-") ||
    !["YES", "NO"].includes(side) ||
    !Number.isInteger(contracts) ||
    contracts < 1
  ) return "INVALID_INPUT";

  const cents = Math.round(price * 100);

  if (
    Math.abs(price * 100 - cents) > 0.00001 ||
    cents <= 0 ||
    cents >= 100
  ) return "NON_CENT_PRICE";

  const cost =
    contracts * cents +
    takerFeeCents(contracts, cents);

  if (cost > ORDER_CAP_CENTS) return "ORDER_CAP";

  const date = easternDay();

  try {
    return db.transaction(() => {
      const existing = db.query(
        "SELECT ticker FROM simulated_reservations WHERE ticker=?"
      ).get(ticker);

      if (existing) return "DUPLICATE";

      db.query(`
        INSERT INTO simulated_reservations
        (ticker,eastern_day,side,contracts,max_loss_cents,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(
        ticker,
        date,
        side,
        contracts,
        cost,
        new Date().toISOString()
      );

      return "RESERVED_SIMULATION_ONLY";
    })();
  } catch {
    return "DB_FAILURE";
  }
}

function verifyRiskRules() {
  if (takerFeeCents(1, 50) !== 2)
    throw Error("fee test");

  if (takerFeeCents(2, 50) !== 4)
    throw Error("fee count test");

  if (99 + takerFeeCents(1, 99) > 100)
    throw Error("order cap test");

  const date = easternDay(
    new Date("2026-10-10T00:30:00Z")
  );

  if (
    date !== "10/09/2026" &&
    date !== "2026-10-09"
  ) throw Error("timezone test");

  console.log(JSON.stringify({
    event: "SIMULATED_RISK_RULES_PASS",
    orderCapCents: ORDER_CAP_CENTS,
    dayLossCeilingCents: null,
    simulatedChecksOnly: true
  }));
}

verifyRiskRules();
console.log(JSON.stringify({event:"FX_PILOT_RUN_START",at:new Date().toISOString(),liveFlag:Bun.env.FX_LIVE_ENABLED==="true",tradingFlag:Bun.env.TRADING_ENABLED==="true",executionFlag:Bun.env.ORDER_EXECUTION_ENABLED==="true",shard:EXCHANGE_INDEX,orderCapCents:100}));


const LIVE_FX =
  Bun.env.FX_LIVE_ENABLED === "true" &&
  Bun.env.TRADING_ENABLED === "true" &&
  Bun.env.ORDER_EXECUTION_ENABLED === "true";

function pem(raw: string) {
  let s = raw.replace(/\\n/g, "\n").trim();

  const m = s.match(
    /^(-----BEGIN [^-]+-----)\s+([A-Za-z0-9+/\s=]+?)\s*(-----END [^-]+-----)$/s
  );

  if (m) {
    const b = m[2].replace(/\s+/g, "");

    s = [
      m[1],
      ...(b.match(/.{1,64}/g) ?? []),
      m[3]
    ].join("\n");
  }

  return s;
}

async function auth(
  method: string,
  path: string,
  body?: object
) {
  const id = Bun.env.KALSHI_API_KEY_ID;
  const key = Bun.env.KALSHI_PRIVATE_KEY;

  if (!id || !key)
    throw Error("fx_credentials_missing");

  const ts = Date.now().toString();
  const sig = createSign("SHA256");

  sig.update(
    ts + method + "/trade-api/v2" + path.split("?")[0]
  );

  sig.end();

  const response = await fetch(
    "https://external-api.kalshi.com/trade-api/v2" + path,
    {
      method,
      headers: {
        "content-type": "application/json",
        "KALSHI-ACCESS-KEY": id,
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "KALSHI-ACCESS-SIGNATURE": sig.sign({
          key: pem(key),
          padding: 6,
          saltLength: 32
        }).toString("base64")
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000)
    }
  );

  const str = await response.text();
  let out: any;

  try {
    out = JSON.parse(str);
  } catch {
    out = { message: str };
  }

  if (!response.ok) {
    throw Error(
      "fx_exchange_http_" +
      response.status +
      ":" +
      JSON.stringify(out).slice(0, 200)
    );
  }

  return out;
}

async function executeFx(
  ticker: string,
  side: string,
  qty: number,
  expectedCents: number
) {
  if (!LIVE_FX)
    return "LIVE_EXECUTION_DISABLED";

  if (
    !/^KXEURUSD15M-[A-Z0-9-]+$/.test(ticker) ||
    !["YES", "NO"].includes(side) ||
    !Number.isInteger(qty) ||
    qty < 1 ||
    !Number.isInteger(expectedCents) ||
    expectedCents <= 0 ||
    expectedCents >= 100
  ) return "INVALID_ORDER";

  if (!db.query(
    "SELECT ticker FROM predictions WHERE ticker=?"
  ).get(ticker)) return "MISSING_SIGNAL";

  const confirm = (
    await get("/markets/" + ticker)
  ).market;

  // Fail closed on an exchange-shard mismatch; never route FX into crypto shard 0.
  const marketExchangeIndex = Number(confirm?.exchange_index);
  console.log(JSON.stringify({event:"FX_MARKET_SHARD_DIAGNOSTIC",ticker,marketExchangeIndex:Number.isInteger(marketExchangeIndex)?marketExchangeIndex:null,configuredExchangeIndex:EXCHANGE_INDEX,marketStatus:confirm?.status}));
  if (!Number.isInteger(marketExchangeIndex)) return "MARKET_SHARD_UNKNOWN";
  if (marketExchangeIndex !== EXCHANGE_INDEX) return "MARKET_SHARD_MISMATCH";

  if (
    confirm?.status !== "active" &&
    confirm?.status !== "open"
  ) return "MARKET_NOT_ACTIVE";

  if (
    Date.parse(confirm.close_time) - Date.now() < 60000
  ) return "TOO_CLOSE_TO_CLOSE";

  const ask = Number(
    side === "YES"
      ? (confirm.yes_ask_dollars ?? confirm.yes_ask)
      : (confirm.no_ask_dollars ?? confirm.no_ask)
  );

  const cents = Math.round(
    ask <= 1 ? ask * 100 : ask
  );

  if (cents !== expectedCents)
    return "PRICE_MOVED";

  const risk =
    qty * cents +
    takerFeeCents(qty, cents);

  if (!usdEntry.allowed) return 'USD_LADDER_UNRESOLVED';
  if (risk > ORDER_CAP_CENTS || risk < 1)
    return "ORDER_RISK_CAP";

  const day = easternDay();

  const claimId = createHash("sha256")
    .update("shawshank-fx-v1:" + ticker + ":" + side)
    .digest("hex");

  const clientId = [
    claimId.slice(0, 8),
    claimId.slice(8, 12),
    "4" + claimId.slice(13, 16),
    "a" + claimId.slice(17, 20),
    claimId.slice(20, 32)
  ].join("-");

  const claim = db.transaction(() => {
    if (db.query(
      "SELECT ticker FROM fx_live_order_claims WHERE ticker=?"
    ).get(ticker)) return false;

    // Repeat the unresolved-order check inside the same SQLite write transaction
    // that claims the next market. This protects overlapping scheduler invocations.
    if (hasUnresolvedUsdOrders(db)) return false;
    // The per-order cap is enforced immediately before the claim.
    db.query(`
      INSERT INTO fx_live_order_claims
      (ticker,eastern_day,client_order_id,side,
       contracts,risk_cents,status,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      ticker,
      day,
      clientId,
      side,
      qty,
      risk,
      "claimed",
      new Date().toISOString()
    );

    return true;
  })();

  if (!claim)
    return "DUPLICATE_OR_DAILY_CAP";

  try {
    const check = await auth(
      "GET",
      "/portfolio/orders?" +
      new URLSearchParams({
        ticker,
        limit: "100"
      })
    );

    if (
      (check.orders || []).some(
        (o: any) => o.client_order_id === clientId
      )
    ) return "ALREADY_ON_EXCHANGE";

    // Explicit shard 0 balance check.
    const balance = await auth(
      "GET",
      "/portfolio/balance?exchange_index=" + EXCHANGE_INDEX
    );

    const availableCents = Number(balance.balance);

    // Read-only balance diagnostic.
    console.log(JSON.stringify({
      event: "FX_SHARD0_BALANCE_CHECK",
      ticker,
      exchangeIndex: EXCHANGE_INDEX,
      availableCents,
      requiredCents: risk,
      sufficient:
        Number.isFinite(availableCents) &&
        availableCents >= risk
    }));

    if (
      !Number.isFinite(availableCents) ||
      availableCents < risk
    ) {
      console.log(JSON.stringify({
        event: "FX_SHARD0_INSUFFICIENT_BALANCE",
        ticker,
        exchangeIndex: EXCHANGE_INDEX,
        availableCents,
        requiredCents: risk
      }));

      return "INSUFFICIENT_SHARD0_BALANCE";
    }

    // Explicit shard 0 order routing.
    // Existing bid/ask semantics retained pending NO-side review.
    const order = await auth(
      "POST",
      "/portfolio/events/orders",
      {
        exchange_index: EXCHANGE_INDEX,
        ticker,
        client_order_id: clientId,
        side: side === "YES" ? "bid" : "ask",
        count: qty.toFixed(2),
        price: (
          (side === "YES" ? cents : 100 - cents) / 100
        ).toFixed(4),
        time_in_force: "immediate_or_cancel",
        self_trade_prevention_type: "taker_at_cross"
      }
    );

    const orderId = String(
      order.order?.order_id ??
      order.order_id ??
      ""
    );

    db.query(`
      UPDATE fx_live_order_claims
      SET status='submitted',exchange_order_id=?
      WHERE ticker=?
    `).run(orderId, ticker);

    console.log(JSON.stringify({
      event: "FX_LIVE_ORDER_SUBMITTED",
      ticker,
      side,
      qty,
      exchangeIndex: EXCHANGE_INDEX,
      riskCents: risk,
      exchangeOrderId: orderId
    }));

    return "SUBMITTED";

  } catch (e) {
    // Do not automatically retry uncertain exchange states.
    console.error(JSON.stringify({
      event: "FX_LIVE_EXECUTION_UNCERTAIN",
      ticker,
      exchangeIndex: EXCHANGE_INDEX,
      error: String(e).slice(0, 240)
    }));

    return "ERROR_REQUIRES_RECONCILIATION";
  }
}

const log = (reason: string, details: any) => {
  db.query(
    "INSERT INTO attempts VALUES(?,?,?)"
  ).run(
    new Date().toISOString(),
    reason,
    String(details).slice(0, 600)
  );

  console.log(JSON.stringify({
    event: reason,
    details
  }));
};

async function get(
  path: string,
  q: Record<string, any> = {}
) {
  const u = new URL(BASE + path);

  for (const [k, v] of Object.entries(q)) {
    u.searchParams.set(k, String(v));
  }

  const r = await fetch(u, {
    signal: AbortSignal.timeout(12000)
  });

  if (!r.ok)
    throw Error(path + " HTTP " + r.status);

  return await r.json();
}

// Read-only reconciliation for the future USD six-step ladder.
// Do not infer live wins/losses from local simulated prediction outcomes.
for (const claim of db.query("SELECT ticker,exchange_order_id,side,contracts,risk_cents,status FROM fx_live_order_claims WHERE exchange_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 12").all() as any[]) {
  try {
    const record = await auth("GET", "/portfolio/orders/" + encodeURIComponent(String(claim.exchange_order_id)) + "?exchange_index=" + EXCHANGE_INDEX);
    const o = record.order ?? record;
    console.log(JSON.stringify({event:"FX_MARTINGALE_ORDER_AUDIT",ticker:claim.ticker,exchangeOrderId:claim.exchange_order_id,side:claim.side,orderStatus:o.status??null,fillCount:o.fill_count_fp??o.fill_count??null,remainingCount:o.remaining_count_fp??o.remaining_count??null,exchangeIndex:o.exchange_index??null,settlementStatus:"NOT_YET_RECONCILED",targetBudgetsCents:[100,200,400,800,1600,3200]}));
  } catch (err) {
    console.error(JSON.stringify({event:"FX_MARTINGALE_ORDER_AUDIT_ERROR",ticker:claim.ticker,error:String(err).slice(0,200)}));
  }
}
// Review integration: reconciling before signal generation; no live deployment.
initializeUsdLadder(db,new Date().toISOString());
const usdEntry = await prepareUsdEntry(db,{
  getOrder:async id=>(await auth("GET","/portfolio/orders/"+encodeURIComponent(id)+"?exchange_index="+EXCHANGE_INDEX)).order,
  getMarket:async ticker=>(await get("/markets/"+encodeURIComponent(ticker))).market,
  findOrderByClientId:async (clientId,ticker)=>{
    const found=await auth("GET","/portfolio/orders?"+new URLSearchParams({ticker,limit:"100",exchange_index:String(EXCHANGE_INDEX)}));
    const matches=(found.orders??[]).filter(o=>o.client_order_id===clientId && o.ticker===ticker);
    return matches.length===1?matches[0]:null;
  }
});
ORDER_CAP_CENTS=usdEntry.allowed?usdEntry.budgetCents:100;
console.log(JSON.stringify({event:"FX_LADDER_REVIEW_GATE",allowed:usdEntry.allowed,step:usdEntry.step??null,budgetCents:ORDER_CAP_CENTS}));
const cnt = (
  db.query(
    "SELECT COUNT(*) as n FROM predictions WHERE side!='SKIP'"
  ).get() as any
).n;

// Reconcile simulated predictions.
for (const old of db.query(`
  SELECT ticker,side,contracts,entry_price,fee
  FROM predictions
  WHERE settlement IS NULL
`).all() as any[]) {
  try {
    const m = (
      await get("/markets/" + old.ticker)
    ).market;

    if (
      !m ||
      !["yes", "no"].includes(m.result)
    ) continue;

    const win =
      (old.side === "YES" && m.result === "yes") ||
      (old.side === "NO" && m.result === "no");

    const pnl =
      old.side === "SKIP"
        ? 0
        : (win ? old.contracts : 0) -
          old.contracts * old.entry_price -
          old.fee;

    db.query(`
      UPDATE predictions
      SET settlement=?,pnl=?,settled_at=?
      WHERE ticker=?
    `).run(
      m.result,
      Math.round(pnl * 100) / 100,
      new Date().toISOString(),
      old.ticker
    );

    console.log(JSON.stringify({
      event: "settled",
      ticker: old.ticker,
      result: m.result,
      pnl
    }));

  } catch (e) {
    log("settlement_retry", String(e));
  }
}

// No 100-signal cap on the separate pilot.
const now = Date.now();

try {
  const d = await get("/markets", {
    series_ticker: "KXEURUSD15M",
    status: "open",
    limit: 200
  });

  console.log(JSON.stringify({event:"FX_OPEN_MARKET_ROUTING",at:new Date().toISOString(),markets:(d.markets||[]).slice(0,8).map((m:any)=>({ticker:m.ticker,exchange_index:m.exchange_index??null,status:m.status,close_time:m.close_time}))}));
  const matches = (d.markets || []).filter((m: any) => {
    const remaining =
      (Date.parse(m.close_time) - now) / 60000;

    return (
      remaining > 11.5 &&
      remaining < 14.3 &&
      Number(m.floor_strike) > 0 &&
      m.event_ticker
    );
  });

  if (matches.length !== 1) {
    log("not_single_entry_market", matches.length);
    db.close();
    process.exit(0);
  }

  const m = matches[0];

  if (db.query(
    "SELECT ticker FROM predictions WHERE ticker=?"
  ).get(m.ticker)) {
    log("already_observed", m.ticker);
    db.close();
    process.exit(0);
  }

  const endMs = Date.parse(m.close_time);
  const hh = Math.floor(endMs / 3600000) * 3600000;

  const all = (
    await get("/markets", {
      series_ticker: "KXEURUSD15M",
      min_close_ts: Math.floor(
        (hh - 7200000) / 1000
      ),
      max_close_ts: Math.floor(
        (hh + 3600000) / 1000
      ),
      limit: 30
    })
  ).markets || [];

  const hourly = all
    .filter(
      (x: any) =>
        Date.parse(x.close_time) % 3600000 === 0
    )
    .sort(
      (a: any, b: any) =>
        Date.parse(a.close_time) -
        Date.parse(b.close_time)
    );

  const candidates = hourly
    .filter(
      (x: any) =>
        Date.parse(x.close_time) <=
        Math.ceil(endMs / 3600000) * 3600000
    )
    .slice(-3);

  const prices = new Map<number, any>();

  for (const x of candidates) {
    const r = await get(
      "/live_data/events/" +
      encodeURIComponent(x.event_ticker)
    );

    for (
      const v of (
        r.live_data?.details?.timeseries || []
      )
    ) {
      if (v.t > now - 60000) continue;

      const minute =
        Math.floor(v.t / 60000) * 60000;

      prices.set(minute, {
        price: Number(v.v),
        timestamp: v.t
      });
    }
  }

  const keys = [...prices.keys()].sort(
    (a, b) => a - b
  );

  const last = keys.at(-1);

  if (!last || now - last > 180000)
    throw Error("stale_or_missing_spot");

  const ret: number[] = [];

  for (let j = 0; j < 60; j++) {
    const a = prices.get(
      last - 60000 * j
    )?.price;

    const b = prices.get(
      last - 60000 * (j + 1)
    )?.price;

    if (!(a > 0 && b > 0))
      throw Error(
        "missing_61_consecutive_minute_prices"
      );

    ret.push(Math.log(a / b));
  }

  const mu =
    ret.reduce((a, b) => a + b, 0) / 60;

  const vol = Math.sqrt(
    ret.reduce(
      (a, b) => a + (b - mu) ** 2,
      0
    ) / 60
  );

  if (vol <= 0)
    throw Error("zero_volatility");

  const mm = (
    await get("/markets/" + m.ticker)
  ).market;

  const ask = Number(
    mm.yes_ask_dollars ?? mm.yes_ask
  );

  const bid = Number(
    mm.yes_bid_dollars ?? mm.yes_bid
  );

  const strike = Number(mm.floor_strike);

  if (!(ask > bid && bid >= 0 && ask <= 1))
    throw Error("invalid_bid_ask");

  const mins = (endMs - now) / 60000;
  const spot = prices.get(last).price;

  const z =
    Math.log(spot / strike) /
    (vol * Math.sqrt(mins));

  const p =
    1 / (1 + Math.exp(-1.702 * z / 0.75));

  const side =
    p > ask + 0.05
      ? "YES"
      : (1 - p) > (1 - bid) + 0.05
        ? "NO"
        : "SKIP";

  const entry =
    side === "YES"
      ? ask
      : side === "NO"
        ? 1 - bid
        : null;

  let qty = 0;
  let fee = 0;

  if (
    entry !== null &&
    entry > 0 &&
    entry < 1
  ) {
    for (let n = 1; n <= 1000; n++) {
      const f =
        Math.ceil(
          100 * 0.07 * n * entry * (1 - entry)
        ) / 100;

      if (n * entry + f <= ORDER_CAP_CENTS / 100) {
        qty = n;
        fee = f;
      } else {
        break;
      }
    }
  }

  const cost = qty
    ? qty * entry! + fee
    : 0;

  const dryRunDecision =
    qty > 0 && entry !== null
      ? simulateReserve(
          m.ticker,
          side,
          qty,
          Math.round(entry * 100) / 100
        )
      : "SKIP_OR_NO_AFFORDABLE_CONTRACT";

  const recorded = new Date().toISOString();

  db.query(`
    INSERT INTO predictions(
      ticker,observed_at,quote_time_ms,
      spot_timestamp_ms,spot,strike,
      minutes_left,vol,prob_yes,
      yes_ask,yes_bid,side,
      entry_price,contracts,fee,model_cost
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    m.ticker,
    recorded,
    now,
    last,
    spot,
    strike,
    mins,
    vol,
    p,
    ask,
    bid,
    side,
    entry,
    qty,
    fee,
    cost
  );

  const liveDecision =
    side !== "SKIP" &&
    qty > 0 &&
    entry !== null
      ? await executeFx(
          m.ticker,
          side,
          qty,
          Math.round(entry * 100)
        )
      : "NO_ORDER_SIGNAL";

  log("prediction_recorded", JSON.stringify({
    ticker: m.ticker,
    side,
    qty,
    liveDecision,
    prob_yes: +p.toFixed(5),
    spot,
    remaining: +mins.toFixed(2),
    recorded,
    eligible_count:
      cnt + (qty > 0 ? 1 : 0),
    live_orders_enabled: LIVE_FX,
    dry_run_reservation: dryRunDecision
  }));

} catch (e) {
  log("observation_error", String(e));
}

db.close();
