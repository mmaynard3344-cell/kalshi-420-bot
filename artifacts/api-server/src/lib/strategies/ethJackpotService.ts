import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { kalshiAuthFetch } from "../kalshiAuth.js";
import { kalshiFetch } from "../kalshi.js";
import { captureOrderbook, parseOrderbookResponse, computeSnapshotFields, type OrderbookSnapshot } from "../orderbookCapture.js";
import { parseKalshiOrderResponse } from "../orderResponseParser.js";
import { logger } from "../logger.js";

export const JACKPOT_WAGER_CENTS = 100; // Reduced live test cap: $1.
export const JACKPOT_MAX_PRICE_CENTS = 90; // HARD live ceiling during validation.
export const JACKPOT_POLL_MS = 100;
export const JACKPOT_TELEMETRY_OFFSETS_MS = [0, 250, 500, 1_000, 2_000] as const;
export const JACKPOT_CEILINGS = [50, 70, 75, 80, 85, 90, 95, 99] as const;
const SERVICE_STARTED_AT_MS = Date.now();

export type JackpotSide = "yes" | "no";
export interface JackpotAOrder {
  id: string;
  ticker: string;
  side: JackpotSide;
  clientOrderId: string;
  kalshiOrderId: string;
  requestedContracts: number;
  createdAtMs: number;
}

export interface JackpotTriggerInput {
  exchangeFillCount: number;
  fillCountProvided: boolean;
  orderStatus: string | null;
  bestAskCents: number | null;
  depthAt50Contracts: number;
}

export function shouldTriggerJackpot(input: JackpotTriggerInput): boolean {
  if (!input.fillCountProvided || input.exchangeFillCount !== 0) return false;
  if (input.orderStatus !== "resting" && input.orderStatus !== "open") return false;
  if (!Number.isInteger(input.bestAskCents) || input.bestAskCents == null) return false;
  return input.depthAt50Contracts === 0
    && input.bestAskCents > 50
    && input.bestAskCents <= JACKPOT_MAX_PRICE_CENTS;
}

/** At a 90c IOC limit, this count can never spend more than the $10 validation cap. */
export function jackpotContracts(): number {
  return Math.floor(JACKPOT_WAGER_CENTS / JACKPOT_MAX_PRICE_CENTS);
}

export function jackpotWireOrder(input: {
  ticker: string; side: JackpotSide; clientOrderId: string; exchangeIndex: number;
}) {
  const outcomeLimit = JACKPOT_MAX_PRICE_CENTS;
  const wirePriceCents = input.side === "yes" ? outcomeLimit : 100 - outcomeLimit;
  return {
    ticker: input.ticker,
    client_order_id: input.clientOrderId,
    side: input.side === "yes" ? "bid" : "ask",
    count: `${jackpotContracts()}.00`,
    price: (wirePriceCents / 100).toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    cancel_order_on_pause: true,
    exchange_index: input.exchangeIndex,
  };
}

function rawBook(snapshot: OrderbookSnapshot) {
  return { orderbook_fp: { yes_dollars: snapshot.rawYesDollars, no_dollars: snapshot.rawNoDollars } };
}

export function jackpotBookMetrics(snapshot: OrderbookSnapshot) {
  const levels = parseOrderbookResponse(rawBook(snapshot), snapshot.side);
  const ceilings: Record<string, unknown> = {};
  for (const ceiling of JACKPOT_CEILINGS) {
    const fields = computeSnapshotFields(levels, ceiling);
    ceilings[String(ceiling)] = {
      depthDollars: fields.depthAtOrBetterDollars,
      depthContracts: fields.depthAtOrBetterContracts,
    };
  }
  return {
    bestAskCents: snapshot.lowestLevelCents,
    ceilings,
    hypothetical500: sweepQuote(levels.map((x) => ({ priceCents: x.priceCents, contracts: x.contractsApprox })), 50_000, 90),
    live10: sweepQuote(levels.map((x) => ({ priceCents: x.priceCents, contracts: x.contractsApprox })), JACKPOT_WAGER_CENTS, JACKPOT_MAX_PRICE_CENTS),
  };
}

/** Descriptive VWAP from a captured book. Never used to enlarge the live order. */
export function sweepQuote(
  levels: Array<{ priceCents: number; contracts: number }>,
  budgetCents: number,
  ceilingCents: number,
) {
  let remaining = budgetCents;
  let contracts = 0;
  let costCents = 0;
  for (const level of [...levels].sort((a, b) => a.priceCents - b.priceCents)) {
    if (level.priceCents > ceilingCents || remaining < level.priceCents) break;
    const available = Math.max(0, Math.floor(level.contracts));
    const take = Math.min(available, Math.floor(remaining / level.priceCents));
    if (take <= 0) continue;
    contracts += take;
    const cost = take * level.priceCents;
    costCents += cost;
    remaining -= cost;
  }
  return {
    contracts,
    costCents,
    vwapCents: contracts > 0 ? costCents / contracts : null,
    unusedBudgetCents: remaining,
  };
}

async function initJackpotTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS jackpot_attempts (
      a_order_id TEXT PRIMARY KEY,
      ticker TEXT NOT NULL,
      intended_side TEXT NOT NULL,
      a_client_order_id TEXT NOT NULL,
      a_kalshi_order_id TEXT NOT NULL,
      a_created_at_ms BIGINT NOT NULL,
      detected_at_ms BIGINT NOT NULL,
      trigger_status TEXT NOT NULL,
      trigger_reason TEXT,
      best_ask_cents INTEGER,
      depth_50_contracts INTEGER,
      j_client_order_id TEXT,
      j_kalshi_order_id TEXT,
      j_order_status TEXT,
      j_fill_count NUMERIC,
      j_remaining_count NUMERIC,
      j_fee_cents INTEGER,
      official_result TEXT,
      j_raw_json JSONB,
      updated_at_ms BIGINT NOT NULL
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS jackpot_telemetry (
      id TEXT PRIMARY KEY,
      a_order_id TEXT NOT NULL REFERENCES jackpot_attempts(a_order_id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      anchor TEXT NOT NULL,
      captured_at_ms BIGINT NOT NULL,
      book_json JSONB NOT NULL,
      metrics_json JSONB NOT NULL,
      a_exchange_json JSONB,
      market_json JSONB,
      UNIQUE(a_order_id, anchor)
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS jackpot_attempts_ticker_idx ON jackpot_attempts(ticker)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS jackpot_telemetry_order_idx ON jackpot_telemetry(a_order_id, captured_at_ms)`);
}

async function listNewAOrders(): Promise<JackpotAOrder[]> {
  const result = await db.execute(sql`
    SELECT id, ticker, side, client_order_id, kalshi_order_id,
           requested_contracts, created_at_ms
    FROM eth_martingale_orders
    WHERE created_at_ms >= ${SERVICE_STARTED_AT_MS}
      AND no_price_cents = 50
      AND kalshi_order_id IS NOT NULL
      AND COALESCE(filled_contracts, 0) = 0
    ORDER BY created_at_ms ASC
    LIMIT 20`);
  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
  return rows.flatMap((row) => {
    const side = row["side"] === "yes" ? "yes" : row["side"] === "no" ? "no" : null;
    if (!side || typeof row["id"] !== "string" || typeof row["ticker"] !== "string"
      || typeof row["client_order_id"] !== "string" || typeof row["kalshi_order_id"] !== "string") return [];
    const requestedContracts = Number(row["requested_contracts"]);
    const createdAtMs = Number(row["created_at_ms"]);
    if (!Number.isFinite(requestedContracts) || !Number.isFinite(createdAtMs)) return [];
    return [{
      id: row["id"], ticker: row["ticker"], side,
      clientOrderId: row["client_order_id"], kalshiOrderId: row["kalshi_order_id"],
      requestedContracts, createdAtMs,
    }];
  });
}

async function reserveCandidate(order: JackpotAOrder): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO jackpot_attempts (
      a_order_id, ticker, intended_side, a_client_order_id, a_kalshi_order_id,
      a_created_at_ms, detected_at_ms, trigger_status, updated_at_ms
    ) VALUES (
      ${order.id}, ${order.ticker}, ${order.side}, ${order.clientOrderId}, ${order.kalshiOrderId},
      ${order.createdAtMs}, ${Date.now()}, 'observing', ${Date.now()}
    ) ON CONFLICT (a_order_id) DO NOTHING
    RETURNING a_order_id`);
  return (result as unknown as { rows: unknown[] }).rows.length === 1;
}

async function patchAttempt(orderId: string, fields: {
  status: string; reason?: string | null; bestAsk?: number | null; depth50?: number | null;
  jClientId?: string | null; jOrderId?: string | null; jStatus?: string | null;
  fillCount?: number | null; remainingCount?: number | null; feeCents?: number | null;
  raw?: Record<string, unknown> | null;
}): Promise<void> {
  await db.execute(sql`
    UPDATE jackpot_attempts SET
      trigger_status=${fields.status}, trigger_reason=${fields.reason ?? null},
      best_ask_cents=${fields.bestAsk ?? null}, depth_50_contracts=${fields.depth50 ?? null},
      j_client_order_id=COALESCE(${fields.jClientId ?? null}, j_client_order_id),
      j_kalshi_order_id=COALESCE(${fields.jOrderId ?? null}, j_kalshi_order_id),
      j_order_status=COALESCE(${fields.jStatus ?? null}, j_order_status),
      j_fill_count=COALESCE(${fields.fillCount ?? null}, j_fill_count),
      j_remaining_count=COALESCE(${fields.remainingCount ?? null}, j_remaining_count),
      j_fee_cents=COALESCE(${fields.feeCents ?? null}, j_fee_cents),
      j_raw_json=COALESCE(${fields.raw ? JSON.stringify(fields.raw) : null}::jsonb, j_raw_json),
      updated_at_ms=${Date.now()}
    WHERE a_order_id=${orderId}`);
}

async function recordSnapshot(order: JackpotAOrder, anchor: string, aExchange?: Record<string, unknown>): Promise<OrderbookSnapshot> {
  const [book, market] = await Promise.all([
    captureOrderbook(order.ticker, order.side, 99),
    kalshiFetch<Record<string, unknown>>(`/markets/${encodeURIComponent(order.ticker)}`).catch(() => ({})),
  ]);
  const metrics = jackpotBookMetrics(book);
  await db.execute(sql`
    INSERT INTO jackpot_telemetry (
      id, a_order_id, ticker, anchor, captured_at_ms, book_json, metrics_json, a_exchange_json, market_json
    ) VALUES (
      ${`${order.id}:${anchor}`}, ${order.id}, ${order.ticker}, ${anchor}, ${book.capturedAtMs},
      ${JSON.stringify(book)}::jsonb, ${JSON.stringify(metrics)}::jsonb,
      ${aExchange ? JSON.stringify(aExchange) : null}::jsonb, ${JSON.stringify(market)}::jsonb
    ) ON CONFLICT (a_order_id, anchor) DO NOTHING`);
  return book;
}

async function getAExchangeOrder(order: JackpotAOrder): Promise<Record<string, unknown>> {
  return kalshiAuthFetch<Record<string, unknown>>(
    "GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,
  );
}

function terminalZeroFill(raw: Record<string, unknown>, requested: number): boolean {
  const p = parseKalshiOrderResponse(raw, requested);
  return p.fillCountProvided && p.fillCount === 0
    && (p.orderStatus === "canceled" || p.orderStatus === "cancelled" || p.orderStatus === "expired");
}

async function cancelAAndProveZero(order: JackpotAOrder): Promise<Record<string, unknown> | null> {
  try {
    await kalshiAuthFetch<Record<string, unknown>>(
      "DELETE", `/portfolio/events/orders/${encodeURIComponent(order.kalshiOrderId)}`,
    );
  } catch (err) {
    logger.warn({ err, ticker: order.ticker, aOrderId: order.id }, "Jackpot A cancel request failed");
    return null;
  }
  for (const delay of [0, 75, 200, 500]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const raw = await getAExchangeOrder(order);
      const parsed = parseKalshiOrderResponse(raw, order.requestedContracts);
      if (parsed.fillCountProvided && parsed.fillCount > 0) return null;
      if (terminalZeroFill(raw, order.requestedContracts)) return raw;
    } catch {
      // Fail closed and retry the exact authenticated read only.
    }
  }
  return null;
}

async function exchangeIndexFor(ticker: string): Promise<number | null> {
  try {
    const raw = await kalshiFetch<Record<string, unknown>>(`/markets/${encodeURIComponent(ticker)}`);
    const market = (raw["market"] as Record<string, unknown> | undefined) ?? raw;
    const value = Number(market["exchange_index"]);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function submitJackpot(order: JackpotAOrder): Promise<void> {
  const exchangeIndex = await exchangeIndexFor(order.ticker);
  if (exchangeIndex == null) {
    await patchAttempt(order.id, { status: "blocked", reason: "missing_exchange_index" });
    return;
  }
  const clientId = `${randomUUID()}:jackpot-j`;
  const payload = jackpotWireOrder({ ticker: order.ticker, side: order.side, clientOrderId: clientId, exchangeIndex });
  let raw: Record<string, unknown>;
  try {
    raw = await kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", payload);
  } catch (err) {
    await patchAttempt(order.id, { status: "submission_unknown", reason: "ioc_post_failed", jClientId: clientId });
    logger.warn({ err, ticker: order.ticker }, "Jackpot IOC submission failed/unknown");
    return;
  }
  const parsed = parseKalshiOrderResponse(raw, jackpotContracts());
  const orderData = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
  const rawFee = orderData["fee_cost"] ?? orderData["fee"];
  const feeDollars = Number(rawFee);
  await patchAttempt(order.id, {
    status: parsed.fillCount > 0 ? "traded" : "ioc_zero_fill",
    reason: parsed.fillCount > 0 ? "jackpot_ioc_filled" : "jackpot_ioc_no_fill",
    jClientId: clientId, jOrderId: parsed.kalshiOrderId, jStatus: parsed.orderStatus,
    fillCount: parsed.fillCount, remainingCount: parsed.remainingCount,
    feeCents: Number.isFinite(feeDollars) ? Math.round(feeDollars * 100) : parsed.reportedFeeCents,
    raw,
  });
  logger.info({
    service: "J", strategy: "Jackpot", ticker: order.ticker, side: order.side,
    contracts: jackpotContracts(), maxPriceCents: JACKPOT_MAX_PRICE_CENTS,
    fillCount: parsed.fillCount, orderStatus: parsed.orderStatus,
  }, "Jackpot IOC attempt completed");
}

async function processCandidate(order: JackpotAOrder): Promise<void> {
  if (!(await reserveCandidate(order))) return;
  let aRaw: Record<string, unknown>;
  try {
    aRaw = await getAExchangeOrder(order);
  } catch (err) {
    await patchAttempt(order.id, { status: "blocked", reason: "a_order_read_unavailable" });
    return;
  }
  const aParsed = parseKalshiOrderResponse(aRaw, order.requestedContracts);
  const initialBook = await recordSnapshot(order, "a_ack", aRaw);
  for (const offset of JACKPOT_TELEMETRY_OFFSETS_MS.slice(1)) {
    setTimeout(() => { void recordSnapshot(order, `a_ack_plus_${offset}ms`).catch((err) =>
      logger.warn({ err, ticker: order.ticker, offset }, "Jackpot telemetry capture failed")); }, offset).unref();
  }
  const levels50 = computeSnapshotFields(parseOrderbookResponse(rawBook(initialBook), order.side), 50);
  const bestAsk = initialBook.lowestLevelCents;
  if (!shouldTriggerJackpot({
    exchangeFillCount: aParsed.fillCount,
    fillCountProvided: aParsed.fillCountProvided,
    orderStatus: aParsed.orderStatus,
    bestAskCents: bestAsk,
    depthAt50Contracts: levels50.depthAtOrBetterContracts,
  })) {
    await patchAttempt(order.id, {
      status: "no_trigger",
      reason: aParsed.fillCount > 0 ? "a_filled" : bestAsk == null ? "book_unavailable" :
        levels50.depthAtOrBetterContracts > 0 ? "depth_at_50" : bestAsk <= 50 ? "ask_not_runaway" : "ask_above_90",
      bestAsk, depth50: levels50.depthAtOrBetterContracts,
    });
    return;
  }
  await patchAttempt(order.id, { status: "triggered", reason: "a_zero_fill_runaway_book", bestAsk, depth50: levels50.depthAtOrBetterContracts });

  // Critical race fence: cancel A, then authenticate the exact order again. If
  // even one A contract filled, J must not add exposure.
  const canceled = await cancelAAndProveZero(order);
  if (!canceled) {
    await patchAttempt(order.id, { status: "blocked", reason: "a_cancel_not_proven_zero_fill" });
    return;
  }
  if (process.env["JACKPOT_LIVE_ENABLED"] !== "true") {
    await patchAttempt(order.id, { status: "shadow_trigger", reason: "live_disabled" });
    return;
  }
  await submitJackpot(order);
}

async function settlementSweep(): Promise<void> {
  const result = await db.execute(sql`
    SELECT a_order_id, ticker FROM jackpot_attempts
    WHERE official_result IS NULL AND trigger_status IN ('traded','ioc_zero_fill','shadow_trigger','triggered','blocked')
    ORDER BY detected_at_ms ASC LIMIT 100`);
  for (const row of (result as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    if (typeof row["ticker"] !== "string" || typeof row["a_order_id"] !== "string") continue;
    try {
      const raw = await kalshiFetch<Record<string, unknown>>(`/markets/${encodeURIComponent(row["ticker"])}`);
      const market = (raw["market"] as Record<string, unknown> | undefined) ?? raw;
      const resultSide = market["result"] === "yes" ? "yes" : market["result"] === "no" ? "no" : null;
      if (!resultSide) continue;
      await db.execute(sql`UPDATE jackpot_attempts SET official_result=${resultSide}, updated_at_ms=${Date.now()} WHERE a_order_id=${row["a_order_id"]}`);
    } catch {
      // Retry on next low-cadence sweep.
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;
export async function startJackpotService(): Promise<void> {
  await initJackpotTables();
  logger.info({ service: "J", strategy: "Jackpot", live: process.env["JACKPOT_LIVE_ENABLED"] === "true",
    wagerCapCents: JACKPOT_WAGER_CENTS, maxPriceCents: JACKPOT_MAX_PRICE_CENTS, startedAtMs: SERVICE_STARTED_AT_MS },
  "Jackpot service initialized");
  const poll = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      for (const order of await listNewAOrders()) await processCandidate(order);
    } catch (err) {
      logger.warn({ err }, "Jackpot poll failed");
    } finally { sweepInFlight = false; }
  };
  await poll();
  timer = setInterval(() => { void poll(); }, JACKPOT_POLL_MS);
  timer.unref();
  const settleTimer = setInterval(() => { void settlementSweep(); }, 60_000);
  settleTimer.unref();
}

export function stopJackpotServiceForTesting(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
