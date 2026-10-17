import http from "node:http";
import { sql } from "drizzle-orm";
import { kalshiFetch, kalshiSeriesFetch, normalizeMarket } from "./lib/kalshi.js";
import { kalshiAuthFetch } from "./lib/kalshiAuth.js";
import { parseKalshiOrderResponse } from "./lib/orderResponseParser.js";
import { fetchFreshKalshiBalanceForExchangeRead, kalshiBalanceCents } from "./lib/kalshiBalance.js";
import { logger } from "./lib/logger.js";
import { currentEthServiceRole } from "./lib/strategies/ethServiceRole.js";
import { submitThroughSharedEthGate } from "./lib/sharedEthOrderGateway.js";
import { sharedEthPgProvider } from "./lib/sharedEthPgProvider.js";
import { ethContractsWithinBudget } from "./lib/sharedEthOrderSizing.js";
import { finalizeEthClaim } from "./lib/sharedEthClaimStore.js";

const SERIES = "KXETH15M";
const LIMIT_PRICE_CENTS = 50;
const PRINCIPALS_CENTS = [200, 200, 200] as const;
const CONTRACTS = [4, 4, 4] as const;
const POLL_MS = 2_000;
const ENTRY_WINDOW_MS = 15 * 60_000;
const CANCEL_AFTER_CLOSE_MS = 1_000;
const TERMINAL = new Set(["filled", "executed", "canceled", "cancelled", "expired", "rejected"]);

type OutcomeSide = "yes" | "no";
type DbLike = {
  execute: (query: unknown) => Promise<unknown>;
  transaction: <T>(fn: (tx: DbLike) => Promise<T>) => Promise<T>;
};

type GState = {
  ladderSide: OutcomeSide | null;
  step: number;
  lastTriggerKey: string | null;
};

type GOrder = {
  id: string;
  ticker: string;
  side: OutcomeSide;
  step: number;
  principalCents: number;
  requestedContracts: number;
  filledContracts: number;
  clientOrderId: string;
  kalshiOrderId: string | null;
  status: string;
  marketCloseMs: number;
  exchangeIndex: number;
  settledAtMs: number | null;
  updatedAtMs: number;
};

let dbPromise: Promise<DbLike> | null = null;
async function db(): Promise<DbLike> {
  dbPromise ??= import("@workspace/db").then((mod) => mod.db as unknown as DbLike);
  return dbPromise;
}
function rows(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
}
function int(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function isTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL.has(status.toLowerCase());
}
function wireSide(side: OutcomeSide): "bid" | "ask" { return side === "yes" ? "bid" : "ask"; }
function feeCents(contracts: number): number {
  return Math.ceil(0.07 * contracts * LIMIT_PRICE_CENTS * (100 - LIMIT_PRICE_CENTS) / 100);
}

function asOrder(row: Record<string, unknown>): GOrder {
  return {
    id: String(row["id"]),
    ticker: String(row["ticker"]),
    side: row["side"] === "no" ? "no" : "yes",
    step: int(row["step"]),
    principalCents: int(row["principal_cents"]),
    requestedContracts: int(row["requested_contracts"]),
    filledContracts: int(row["filled_contracts"]),
    clientOrderId: String(row["client_order_id"]),
    kalshiOrderId: text(row["kalshi_order_id"]),
    status: String(row["status"]),
    marketCloseMs: int(row["market_close_ms"]),
    exchangeIndex: int(row["exchange_index"]),
    settledAtMs: row["settled_at_ms"] == null ? null : int(row["settled_at_ms"]),
    updatedAtMs: int(row["updated_at_ms"]),
  };
}

async function initStore(): Promise<void> {
  const d = await db();
  await d.execute(sql`
    CREATE TABLE IF NOT EXISTS eth_g_streak_reversal_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ladder_side TEXT CHECK (ladder_side IN ('yes','no')),
      step INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 2),
      last_trigger_key TEXT,
      updated_at_ms BIGINT NOT NULL
    )
  `);
  await d.execute(sql`
    INSERT INTO eth_g_streak_reversal_state (id, ladder_side, step, last_trigger_key, updated_at_ms)
    VALUES (1, NULL, 0, NULL, ${Date.now()}) ON CONFLICT (id) DO NOTHING
  `);
  await d.execute(sql`
    CREATE TABLE IF NOT EXISTS eth_g_streak_reversal_orders (
      id TEXT PRIMARY KEY,
      ticker TEXT NOT NULL UNIQUE,
      side TEXT NOT NULL CHECK (side IN ('yes','no')),
      step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 2),
      principal_cents INTEGER NOT NULL,
      requested_contracts INTEGER NOT NULL,
      filled_contracts INTEGER NOT NULL DEFAULT 0,
      client_order_id TEXT NOT NULL UNIQUE,
      kalshi_order_id TEXT,
      status TEXT NOT NULL,
      market_close_ms BIGINT NOT NULL,
      exchange_index INTEGER NOT NULL,
      settlement_result TEXT CHECK (settlement_result IN ('yes','no')),
      won BOOLEAN,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      settled_at_ms BIGINT,
      last_error TEXT
    )
  `);
  await d.execute(sql`
    CREATE INDEX IF NOT EXISTS eth_g_streak_reversal_unsettled_idx
    ON eth_g_streak_reversal_orders (settled_at_ms, updated_at_ms)
  `);
  if(process.env["ETH_G_SHARED_MARTINGALE_ENABLED"]==="true") await d.execute(sql`
    CREATE TABLE IF NOT EXISTS eth_g_shared_claim_links (
      client_order_id TEXT PRIMARY KEY,
      claim_id UUID NOT NULL UNIQUE REFERENCES eth_shared_martingale_claims(claim_id),
      ticker TEXT NOT NULL UNIQUE,
      created_at_ms BIGINT NOT NULL
    )
  `);
  await d.execute(sql`
    CREATE TABLE IF NOT EXISTS eth_g_market_directions (
      ticker TEXT PRIMARY KEY,
      side TEXT CHECK (side IN ('yes','no')),
      decided_at_ms BIGINT NOT NULL,
      reason TEXT NOT NULL
    )
  `);
}

function newEntriesEnabled(): boolean {
  return currentEthServiceRole() === "downfade_g"
    && process.env["ETH_G_STREAK_REVERSAL_LIVE_ENABLED"] === "true"
    && process.env["AUTO_TRADING_ENABLED"] !== "false"
    && process.env["TRADING_ENABLED"] !== "false"
    && process.env["WORKSPACE_TRADING_ENABLED"] !== "false";
}

async function loadState(): Promise<GState> {
  const d = await db();
  const result = await d.execute(sql`
    SELECT ladder_side, step, last_trigger_key FROM eth_g_streak_reversal_state WHERE id=1
  `);
  const row = rows(result)[0] ?? {};
  return {
    ladderSide: row["ladder_side"] === "yes" || row["ladder_side"] === "no" ? row["ladder_side"] : null,
    step: Math.max(0, Math.min(2, int(row["step"]))),
    lastTriggerKey: text(row["last_trigger_key"]),
  };
}

async function setState(side: OutcomeSide | null, step: number, triggerKey?: string | null): Promise<void> {
  const d = await db();
  if (triggerKey === undefined) {
    await d.execute(sql`
      UPDATE eth_g_streak_reversal_state
      SET ladder_side=${side}, step=${step}, updated_at_ms=${Date.now()} WHERE id=1
    `);
  } else {
    await d.execute(sql`
      UPDATE eth_g_streak_reversal_state
      SET ladder_side=${side}, step=${step}, last_trigger_key=${triggerKey}, updated_at_ms=${Date.now()} WHERE id=1
    `);
  }
}

async function listUnsettledOrders(): Promise<GOrder[]> {
  const d = await db();
  const result = await d.execute(sql`
    SELECT * FROM eth_g_streak_reversal_orders
    WHERE settled_at_ms IS NULL ORDER BY created_at_ms ASC LIMIT 10
  `);
  return rows(result).map(asOrder);
}

async function orderForTicker(ticker: string): Promise<GOrder | null> {
  const d = await db();
  const result = await d.execute(sql`SELECT * FROM eth_g_streak_reversal_orders WHERE ticker=${ticker}`);
  const row = rows(result)[0];
  return row ? asOrder(row) : null;
}

async function findExchangeOrder(order: GOrder): Promise<string | null> {
  try {
    const raw = await kalshiAuthFetch<{ orders?: Array<Record<string, unknown>> }>(
      "GET", `/portfolio/orders?client_order_id=${encodeURIComponent(order.clientOrderId)}&limit=10`,
      undefined, { readPriority: "safety" },
    );
    const matches = (raw.orders ?? []).filter((candidate) =>
      candidate["client_order_id"] === order.clientOrderId
      && candidate["ticker"] === order.ticker
      && typeof candidate["order_id"] === "string",
    );
    return matches.length === 1 ? String(matches[0]!["order_id"]) : null;
  } catch {
    return null;
  }
}

async function refreshOrder(order: GOrder): Promise<GOrder> {
  const d = await db();
  let current = order;
  if (!current.kalshiOrderId && (current.status === "submitting" || current.status === "submission_unknown")) {
    const recovered = await findExchangeOrder(current);
    if (recovered) {
      await d.execute(sql`
        UPDATE eth_g_streak_reversal_orders
        SET kalshi_order_id=${recovered}, status='submitted', updated_at_ms=${Date.now()}, last_error=NULL
        WHERE id=${current.id}
      `);
      current = { ...current, kalshiOrderId: recovered, status: "submitted", updatedAtMs: Date.now() };
    }
  }
  if (!current.kalshiOrderId || isTerminal(current.status)) return current;
  try {
    const raw = await kalshiAuthFetch<Record<string, unknown>>(
      "GET", `/portfolio/orders/${encodeURIComponent(current.kalshiOrderId)}`,
      undefined, { readPriority: "safety" },
    );
    const parsed = parseKalshiOrderResponse(raw, Math.max(0, current.requestedContracts - current.filledContracts));
    const status = parsed.orderStatus ?? current.status;
    const filled = parsed.fillCountProvided
      ? Math.max(current.filledContracts, Math.min(current.requestedContracts, Math.trunc(parsed.fillCount)))
      : current.filledContracts;
    await d.execute(sql`
      UPDATE eth_g_streak_reversal_orders
      SET status=${status}, filled_contracts=${filled}, updated_at_ms=${Date.now()}, last_error=NULL
      WHERE id=${current.id}
    `);
    return { ...current, status, filledContracts: filled, updatedAtMs: Date.now() };
  } catch (err) {
    await d.execute(sql`
      UPDATE eth_g_streak_reversal_orders SET last_error=${String(err)}, updated_at_ms=${Date.now()} WHERE id=${current.id}
    `);
    return current;
  }
}

async function cancelIfPastClose(order: GOrder): Promise<GOrder> {
  if (!order.kalshiOrderId || isTerminal(order.status) || Date.now() < order.marketCloseMs + CANCEL_AFTER_CLOSE_MS) return order;
  try {
    await kalshiAuthFetch<Record<string, unknown>>(
      "DELETE", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,
      undefined, { readPriority: "safety" },
    );
  } catch {
    // The authenticated detail read below is authoritative; failed cancellation never releases the fence.
  }
  return refreshOrder(order);
}

async function fetchMarketResult(ticker: string): Promise<OutcomeSide | null> {
  try {
    const raw = await kalshiFetch<{ market?: Record<string, unknown> }>(`/markets/${encodeURIComponent(ticker)}`);
    const result = raw.market?.["result"];
    return result === "yes" || result === "no" ? result : null;
  } catch {
    return null;
  }
}

async function settleOrder(order: GOrder, result: OutcomeSide): Promise<void> {
  const d = await db();
  if(process.env["ETH_G_SHARED_MARTINGALE_ENABLED"]==="true"){
    const linked=rows(await d.execute(sql`
      SELECT claim_id FROM eth_g_shared_claim_links WHERE client_order_id=${order.clientOrderId}
    `))[0];
    if(!linked)throw Error("G shared settlement missing claim link");
    if(!isTerminal(order.status)||!order.kalshiOrderId)return;
    // Never trust the locally persisted fill count as final settlement proof.
    // An authenticated terminal-order detail must match this exact claim.
    const rawDetail=await kalshiAuthFetch<Record<string,unknown>>("GET",
      "/portfolio/orders/"+encodeURIComponent(order.kalshiOrderId),
      undefined,{readPriority:"safety"});
    const wire=(rawDetail["order"]&&typeof rawDetail["order"]==="object"
      ?rawDetail["order"]:rawDetail) as Record<string,unknown>;
    if(wire["order_id"]!==order.kalshiOrderId
      ||wire["client_order_id"]!==order.clientOrderId
      ||wire["ticker"]!==order.ticker)return;
    const verified=parseKalshiOrderResponse(rawDetail,order.requestedContracts);
    if(!verified.orderStatus||!isTerminal(verified.orderStatus)
      ||!verified.fillCountProvided
      ||!Number.isSafeInteger(verified.fillCount)
      ||verified.fillCount<0||verified.fillCount>order.requestedContracts)return;
    const verifiedFills=verified.fillCount;
    const outcome=verifiedFills===0?"ZERO_FILL":order.side===result?"WIN":"LOSS";
    const sharedSettlement = await finalizeEthClaim(sharedEthPgProvider,String(linked["claim_id"]),
      "G:"+order.clientOrderId+":"+result,outcome);
    // Keep G's local six-rung directional latch synchronized with the shared
    // claim's verified outcome. This transaction makes the journal settlement
    // and direction advancement/reset crash-atomic.
    await d.transaction(async (tx) => {
      const settled = await tx.execute(sql`
        UPDATE eth_g_streak_reversal_orders SET settlement_result=${result},
          won=${verifiedFills>0?order.side===result:null},
          filled_contracts=${verifiedFills},settled_at_ms=${Date.now()},
          updated_at_ms=${Date.now()} WHERE id=${order.id} AND settled_at_ms IS NULL
        RETURNING id
      `);
      if (rows(settled).length !== 1 || outcome === "ZERO_FILL") return;
      if (outcome === "WIN" || (outcome === "LOSS" && sharedSettlement.step === 0)) {
        await tx.execute(sql`
          UPDATE eth_g_streak_reversal_state SET ladder_side=NULL, step=0,
            updated_at_ms=${Date.now()} WHERE id=1 AND ladder_side=${order.side}
        `);
        logger.info({ ticker:order.ticker }, "G shared cycle complete: direction cleared");
      } else {
        // Shared ETH owns the six-rung cycle; local step is diagnostic only.
        await tx.execute(sql`
          UPDATE eth_g_streak_reversal_state
          SET step=${sharedSettlement.step}, updated_at_ms=${Date.now()}
          WHERE id=1 AND ladder_side=${order.side}
        `);
        logger.info({ticker:order.ticker, sharedStep:sharedSettlement.step},
          "G shared loss: direction retained until shared cycle resets");
      }
    });
    return;
  }
  const won = order.filledContracts > 0 ? order.side === result : null;
  await d.transaction(async (tx) => {
    const claim = await tx.execute(sql`
      UPDATE eth_g_streak_reversal_orders
      SET settlement_result=${result}, won=${won}, settled_at_ms=${Date.now()}, updated_at_ms=${Date.now()}
      WHERE id=${order.id} AND settled_at_ms IS NULL
      RETURNING id
    `);
    if (rows(claim).length !== 1) return;

    if (order.filledContracts <= 0) return;
    if (won) {
      await tx.execute(sql`
        UPDATE eth_g_streak_reversal_state
        SET ladder_side=NULL, step=0, updated_at_ms=${Date.now()} WHERE id=1
      `);
      return;
    }
    if (order.step < 2) {
      await tx.execute(sql`
        UPDATE eth_g_streak_reversal_state
        SET ladder_side=${order.side}, step=${order.step + 1}, updated_at_ms=${Date.now()} WHERE id=1
      `);
    } else {
      await tx.execute(sql`
        UPDATE eth_g_streak_reversal_state
        SET ladder_side=NULL, step=0, updated_at_ms=${Date.now()} WHERE id=1
      `);
    }
  });
  logger.info({ ticker: order.ticker, side: order.side, step: order.step, filledContracts: order.filledContracts, result, won },
    "G streak reversal settlement applied");
}

async function reconcileOutstanding(): Promise<boolean> {
  const outstanding = await listUnsettledOrders();
  for (let order of outstanding) {
    order = await refreshOrder(order);
    order = await cancelIfPastClose(order);
    const result = await fetchMarketResult(order.ticker);
    if (result == null) continue;
    if (!isTerminal(order.status) && order.kalshiOrderId) {
      order = await cancelIfPastClose(order);
      if (!isTerminal(order.status)) continue;
    }
    // Shared claims require an authenticated exchange order identity before
    // settlement. Never turn an unresolved POST into an assumed zero-fill.
    if(process.env["ETH_G_SHARED_MARTINGALE_ENABLED"]==="true" && !order.kalshiOrderId)continue;
    if (!order.kalshiOrderId && (order.status === "submitting" || order.status === "submission_unknown")) continue;
    await settleOrder(order, result);
  }
  return (await listUnsettledOrders()).length === 0;
}

async function discoverCurrentMarket(): Promise<{
  ticker: string; openMs: number; closeMs: number; exchangeIndex: number;
} | null> {
  const raw = await kalshiSeriesFetch(SERIES, { forceFresh: true });
  if (!raw) return null;
  const market = normalizeMarket(raw);
  const ticker = typeof market["ticker"] === "string" ? market["ticker"] : null;
  const openMs = typeof market["open_time"] === "string" ? Date.parse(market["open_time"]) : NaN;
  const closeMs = typeof market["close_time"] === "string" ? Date.parse(market["close_time"]) : NaN;
  const exchangeIndex = Number(market["exchange_index"]);
  if (!ticker || !/^KXETH15M-/.test(ticker) || !Number.isFinite(openMs) || !Number.isFinite(closeMs)
    || !Number.isInteger(exchangeIndex) || exchangeIndex < 0 || Date.now() >= closeMs) return null;
  return { ticker, openMs, closeMs, exchangeIndex };
}

type MarketDirectionDecision =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "signal"; side: OutcomeSide; key: string; priorResult: OutcomeSide };

async function exactTwoStreakDecision(currentOpenMs: number): Promise<MarketDirectionDecision> {
  try {
    const response = await kalshiFetch<{ markets?: Array<Record<string, unknown>> }>("/markets", {
      series_ticker: SERIES, status: "settled", limit: 20,
    });
    const byOpen = new Map<number, { ticker: string; result: OutcomeSide }>();
    for (const market of response.markets ?? []) {
      const open = typeof market["open_time"] === "string" ? Date.parse(market["open_time"]) : NaN;
      const result = market["result"];
      const ticker = market["ticker"];
      if (!Number.isFinite(open) || typeof ticker !== "string" || (result !== "yes" && result !== "no")) continue;
      byOpen.set(open, { ticker, result });
    }
    const one = byOpen.get(currentOpenMs - 15 * 60_000);
    const two = byOpen.get(currentOpenMs - 30 * 60_000);
    const three = byOpen.get(currentOpenMs - 45 * 60_000);
    // Never declare NO SIGNAL until all three necessary settlements are known.
    if (!one || !two || !three) return { kind: "unknown" };
    if (one.result !== two.result || three.result === one.result) return { kind: "none" };
    return { kind: "signal", side: one.result, priorResult: one.result, key: `${two.ticker}|${one.ticker}` };
  } catch (err) {
    logger.warn({ err }, "G direction settlement history unavailable; decision deferred");
    return { kind: "unknown" };
  }
}

async function publishedDirection(ticker: string): Promise<{exists: boolean; side: OutcomeSide | null}> {
  const d = await db();
  const existing = rows(await d.execute(sql`SELECT side FROM eth_g_market_directions WHERE ticker=${ticker}`))[0];
  return existing ? { exists: true, side: existing["side"] === "yes" || existing["side"] === "no" ? existing["side"] : null } : { exists: false, side: null };
}

async function publishDirection(ticker: string, side: OutcomeSide | null, reason: string): Promise<boolean> {
  const d = await db();
  await d.execute(sql`
    INSERT INTO eth_g_market_directions (ticker, side, decided_at_ms, reason)
    VALUES (${ticker}, ${side}, ${Date.now()}, ${reason})
    ON CONFLICT (ticker) DO NOTHING
  `);
  const current = await publishedDirection(ticker);
  if (!current.exists || current.side !== side) {
    logger.error({ticker, expectedSide:side, storedSide:current.side}, "G direction decision conflict: no new G order");
    return false;
  }
  return true;
}

async function submitOrder(market: { ticker: string; closeMs: number; exchangeIndex: number }, side: OutcomeSide, step: number): Promise<void> {
  const d = await db();
  if (await orderForTicker(market.ticker)) return;
  const principalCents = PRINCIPALS_CENTS[step]!;
  const contracts = CONTRACTS[step]!;
  const requiredCents = principalCents + feeCents(contracts);

  let available: number | null = null;
  try {
    available = kalshiBalanceCents((await fetchFreshKalshiBalanceForExchangeRead(market.exchangeIndex)).value);
  } catch (err) {
    logger.warn({ err, ticker: market.ticker, exchangeIndex: market.exchangeIndex }, "G streak reversal balance preflight failed");
    return;
  }
  if (available == null || available < requiredCents) {
    logger.warn({ ticker: market.ticker, step, requiredCents, available }, "G streak reversal insufficient exchange-scoped capital; rung retained");
    return;
  }

  const id = `g-streak-reversal:${market.ticker}`;
  const clientOrderId = `g-streak-reversal-v1:${market.ticker}`;
  const now = Date.now();
  const inserted = await d.execute(sql`
    INSERT INTO eth_g_streak_reversal_orders
      (id, ticker, side, step, principal_cents, requested_contracts, filled_contracts,
       client_order_id, status, market_close_ms, exchange_index, created_at_ms, updated_at_ms)
    VALUES
      (${id}, ${market.ticker}, ${side}, ${step}, ${principalCents}, ${contracts}, 0,
       ${clientOrderId}, 'submitting', ${market.closeMs}, ${market.exchangeIndex}, ${now}, ${now})
    ON CONFLICT (ticker) DO NOTHING RETURNING id
  `);
  if (rows(inserted).length !== 1) return;

  try {
    const raw = await kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker: market.ticker,
      client_order_id: clientOrderId,
      side: wireSide(side),
      count: `${contracts}.00`,
      price: "0.5000",
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      exchange_index: market.exchangeIndex,
    });
    const parsed = parseKalshiOrderResponse(raw, contracts);
    if (parsed.kalshiOrderId) {
      await d.execute(sql`
        UPDATE eth_g_streak_reversal_orders
        SET kalshi_order_id=${parsed.kalshiOrderId}, status=${parsed.orderStatus ?? "submitted"},
            filled_contracts=${Math.max(0, Math.trunc(parsed.fillCount))}, updated_at_ms=${Date.now()}, last_error=NULL
        WHERE id=${id}
      `);
      logger.info({ ticker: market.ticker, side, step, principalCents, contracts, orderId: parsed.kalshiOrderId },
        "G streak reversal order submitted");
      return;
    }
    await d.execute(sql`
      UPDATE eth_g_streak_reversal_orders
      SET status='submission_unknown', updated_at_ms=${Date.now()}, last_error='POST returned no authoritative order id'
      WHERE id=${id}
    `);
  } catch (err) {
    await d.execute(sql`
      UPDATE eth_g_streak_reversal_orders
      SET status='submission_unknown', updated_at_ms=${Date.now()}, last_error=${String(err)} WHERE id=${id}
    `);
    logger.warn({ err, ticker: market.ticker, side, step }, "G streak reversal submission uncertain; durable fence retained");
  }
}

/**
 * Review-only shared-ladder execution. The gate holds the global ETH claim through
 * settlement; a separate authenticated settlement bridge MUST be installed before
 * ETH_G_SHARED_MARTINGALE_ENABLED can be enabled. Fail closed otherwise.
 */
async function submitGWithSharedReservation(
 market:{ticker:string;closeMs:number;exchangeIndex:number},side:OutcomeSide,expectedVersion:number
):Promise<void>{
 if(process.env["ETH_SHARED_SETTLEMENT_BRIDGE_READY"]!=="true"){
  logger.error({ticker:market.ticker},"Shared ETH G submission blocked: settlement bridge not installed");
  return;
 }
 if(await orderForTicker(market.ticker))return;
 const clientOrderId="g-shared-v1:"+market.ticker;
 const attempt=await submitThroughSharedEthGate(sharedEthPgProvider,{
  service:"G",ticker:market.ticker,side,clientOrderId,expectedVersion
 },async(claim,id)=>{
  const size=ethContractsWithinBudget(claim.budgetCents,LIMIT_PRICE_CENTS,feeCents);
  if(size.contracts===0)throw Error("Shared ETH wager cannot fund a contract including fees");
  const balance=kalshiBalanceCents((await fetchFreshKalshiBalanceForExchangeRead(market.exchangeIndex)).value);
  if(balance==null||balance<size.totalCents)throw Error("insufficient exchange balance; leave claim locked pending reconciliation");
  // The G reconciler uses its durable order journal; link it to the globally
  // locked claim before the exchange request so crash recovery can identify it.
  // The legacy G journal only accepts steps 0..2. The authoritative six-step
  // rung lives exclusively in eth_shared_martingale_claims.
  const journalId="g-streak-reversal:"+market.ticker;
  const now=Date.now();
  const d=await db();
  const inserted=await d.execute(sql`
    INSERT INTO eth_g_streak_reversal_orders
     (id,ticker,side,step,principal_cents,requested_contracts,filled_contracts,
      client_order_id,status,market_close_ms,exchange_index,created_at_ms,updated_at_ms)
    VALUES (${journalId},${market.ticker},${side},0,${size.principalCents},${size.contracts},0,
      ${id},'submitting',${market.closeMs},${market.exchangeIndex},${now},${now})
    ON CONFLICT (ticker) DO NOTHING RETURNING id
  `);
  if(rows(inserted).length!==1)throw Error("G shared claim collision; preserve global reservation");
  await d.execute(sql`
    INSERT INTO eth_g_shared_claim_links(client_order_id,claim_id,ticker,created_at_ms)
    VALUES (${id},${claim.claimId},${market.ticker},${now})
  `);
  return kalshiAuthFetch<Record<string,unknown>>("POST","/portfolio/events/orders",{
   ticker:market.ticker,client_order_id:id,side:wireSide(side),
   count:`${size.contracts}.00`,price:"0.5000",
   time_in_force:"good_till_canceled",
   self_trade_prevention_type:"taker_at_cross",exchange_index:market.exchangeIndex
  });
 });
 if(attempt.status==="SUBMITTED" || attempt.status==="SUBMISSION_UNCERTAIN"){
  const d=await db();
  const parsed=attempt.status==="SUBMITTED"?parseKalshiOrderResponse(attempt.response,0):null;
  await d.execute(sql`
    UPDATE eth_g_streak_reversal_orders
    SET kalshi_order_id=${parsed?.kalshiOrderId??null},
      status=${parsed?.kalshiOrderId?(parsed.orderStatus??"submitted"):"submission_unknown"},
      updated_at_ms=${Date.now()} WHERE client_order_id=${clientOrderId}
  `);
 }
 logger.info({ticker:market.ticker,status:attempt.status,claimId:attempt.status==="SKIPPED_ACTIVE_CLAIM"?null:attempt.claim.claimId},
  "G shared ETH claim gateway decision");
}

let busy = false;
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const clear = await reconcileOutstanding();
    if (!clear) return;
    if (!newEntriesEnabled()) return;

    const market = await discoverCurrentMarket();
    if (!market || Date.now() < market.openMs || Date.now() > market.openMs + ENTRY_WINDOW_MS) return;
    let state = await loadState();
    let expectedSharedVersion: number | null = null;
    if (process.env["ETH_G_SHARED_MARTINGALE_ENABLED"] === "true") {
      const snapshot = await sharedEthPgProvider.transaction(async tx => tx.query<{version:number}>(
        "SELECT version FROM eth_shared_martingale_state WHERE singleton=TRUE"
      ));
      const version = Number(snapshot.rows[0]?.version);
      if (!Number.isSafeInteger(version) || version < 0) return;
      expectedSharedVersion = version;
    }
    if (process.env["ETH_G_SHARED_MARTINGALE_ENABLED"] === "true" && state.ladderSide != null) {
      // Reconcile against the authoritative shared ledger before carrying G's
      // direction into another market. Fail closed if a different service
      // settled the shared cycle after G's last settlement.
      const latest = await sharedEthPgProvider.transaction(async tx =>
        tx.query<{service:string;ticker:string;outcome:string}>(
          "SELECT service,ticker,outcome FROM eth_shared_martingale_claims " +
          "WHERE status IN ('SETTLED','ZERO_FILL') " +
          "ORDER BY resolved_at DESC, claim_id DESC LIMIT 1"
        )
      );
      const lastG = rows(await (await db()).execute(sql`
        SELECT ticker FROM eth_g_streak_reversal_orders
        WHERE settled_at_ms IS NOT NULL ORDER BY settled_at_ms DESC LIMIT 1
      `))[0];
      const claim = latest.rows[0];
      if (!claim || !lastG || claim.service !== "G"
        || claim.ticker !== lastG["ticker"] || claim.outcome === "WIN") {
        await (await db()).execute(sql`
          UPDATE eth_g_streak_reversal_state
          SET ladder_side=NULL, step=0, updated_at_ms=${Date.now()}
          WHERE id=1
        `);
        logger.warn({ticker:market.ticker, latestService:claim?.service},
          "G stale shared direction reset after external or mismatched settlement");
        state = await loadState();
      }
    }

    if (state.ladderSide == null) {
      const stored = await publishedDirection(market.ticker);
      if (stored.exists && stored.side == null) return;
      const decision = await exactTwoStreakDecision(market.openMs);
      if (decision.kind === "unknown") return;
      if (decision.kind === "none" || decision.key === state.lastTriggerKey) {
        await publishDirection(market.ticker, null, "no_eligible_g_streak");
        return;
      }
      await setState(decision.side, 0, decision.key);
      state = { ladderSide: decision.side, step: 0, lastTriggerKey: decision.key };
      logger.info({ ticker: market.ticker, priorResult: decision.priorResult, side: decision.side, triggerKey: decision.key },
        "G streak reversal two-consecutive-side trigger armed");
    }

    if (state.ladderSide == null) return;
    if (!await publishDirection(market.ticker, state.ladderSide, "g_ladder_direction")) return;
    if(process.env["ETH_G_SHARED_MARTINGALE_ENABLED"]==="true"){
      if (expectedSharedVersion === null) return;
       await submitGWithSharedReservation(market,state.ladderSide,expectedSharedVersion);
    }else{
      await submitOrder(market,state.ladderSide,state.step);
    }
  } catch (err) {
    logger.warn({ err }, "G streak reversal tick failed");
  } finally {
    busy = false;
  }
}

async function main(): Promise<void> {
  await initStore();
  logger.info({
    serviceRole: currentEthServiceRole(),
    liveEnabled: process.env["ETH_G_STREAK_REVERSAL_LIVE_ENABLED"] === "true",
    series: SERIES,
    limitPriceCents: LIMIT_PRICE_CENTS,
    principalsCents: PRINCIPALS_CENTS,
    contracts: CONTRACTS,
    entryWindowMs: ENTRY_WINDOW_MS,
    entrySchedule: "all_hours_all_days",
    trigger: "exactly_two_same_side_settlements_then_opposite",
    progression: "500-500-500_flat_same_side_on_losses_reset_on_win_or_step3_loss",
  }, "Service G ETH streak reversal runner started");

  void tick();
  const timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref();

  const port = Number(process.env["PORT"] || 3000);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/health") {
      const state = await loadState().catch(() => ({ ladderSide: null, step: 0, lastTriggerKey: null }));
      const outstanding = await listUnsettledOrders().catch(() => []);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        service: "eth-g-streak-reversal",
        role: currentEthServiceRole(),
        execution_enabled: newEntriesEnabled(),
        series: SERIES,
        limit_price_cents: LIMIT_PRICE_CENTS,
        principals_cents: PRINCIPALS_CENTS,
        contracts: CONTRACTS,
        entry_window_ms: ENTRY_WINDOW_MS,
        entry_schedule: "all_hours_all_days",
        ladder_side: state.ladderSide,
        ladder_step: state.step,
        unresolved_orders: outstanding.length,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  server.listen(port, "0.0.0.0", () => logger.info({ port }, "Service G streak reversal health server listening"));
}

main().catch((err) => {
  logger.error({ err }, "Service G streak reversal fatal startup error");
  process.exit(1);
});
