import http from "node:http";
import { sql } from "drizzle-orm";
import { kalshiSeriesFetch, normalizeMarket } from "./lib/kalshi.js";
import { kalshiAuthFetch } from "./lib/kalshiAuth.js";
import { parseKalshiOrderResponse } from "./lib/orderResponseParser.js";
import { logger } from "./lib/logger.js";
import { currentEthServiceRole } from "./lib/strategies/ethServiceRole.js";

const SERIES = "KXETH15M";
const ENTRY_CENTS = 40;
const TARGET_CENTS = 60;
const CONTRACTS_PER_SIDE = 12; // 12 * 40c = $4.80 principal per side (< $5 cap)
const DISCOVERY_INTERVAL_MS = 2_000;
const LIFECYCLE_INTERVAL_MS = 1_000;
const SUBMISSION_RECOVERY_MIN_AGE_MS = 3_000;
const BOUNDARY_CANCEL_LEAD_MS = 1_000;

const TERMINAL = new Set(["filled", "executed", "canceled", "cancelled", "expired", "rejected"]);

type OutcomeSide = "yes" | "no";
type OrderRole = "entry" | "exit";

type DbLike = {
  execute: (query: unknown) => Promise<unknown>;
  transaction: <T>(fn: (tx: DbLike) => Promise<T>) => Promise<T>;
};

type GOrder = {
  id: string;
  ticker: string;
  side: OutcomeSide;
  role: OrderRole;
  sequence: number;
  clientOrderId: string;
  kalshiOrderId: string | null;
  limitPriceCents: number;
  requestedContracts: number;
  filledContracts: number;
  status: string;
  marketCloseMs: number;
  exchangeIndex: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type GCycle = {
  ticker: string;
  side: OutcomeSide;
  marketCloseMs: number;
  exchangeIndex: number;
  done: boolean;
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
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOrder(row: Record<string, unknown>): GOrder {
  return {
    id: String(row["id"]),
    ticker: String(row["ticker"]),
    side: row["side"] === "no" ? "no" : "yes",
    role: row["role"] === "exit" ? "exit" : "entry",
    sequence: int(row["sequence"]),
    clientOrderId: String(row["client_order_id"]),
    kalshiOrderId: text(row["kalshi_order_id"]),
    limitPriceCents: int(row["limit_price_cents"]),
    requestedContracts: int(row["requested_contracts"]),
    filledContracts: int(row["filled_contracts"]),
    status: String(row["status"]),
    marketCloseMs: int(row["market_close_ms"]),
    exchangeIndex: int(row["exchange_index"]),
    createdAtMs: int(row["created_at_ms"]),
    updatedAtMs: int(row["updated_at_ms"]),
  };
}

async function initStore(): Promise<void> {
  const d = await db();
  await d.execute(sql`
    CREATE TABLE IF NOT EXISTS eth_g_4060_cycles (
      ticker TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('yes','no')),
      market_close_ms BIGINT NOT NULL,
      exchange_index INTEGER NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      done_reason TEXT,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      PRIMARY KEY (ticker, side)
    )
  `);
  await d.execute(sql`
    CREATE TABLE IF NOT EXISTS eth_g_4060_orders (
      id TEXT PRIMARY KEY,
      ticker TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('yes','no')),
      role TEXT NOT NULL CHECK (role IN ('entry','exit')),
      sequence INTEGER NOT NULL,
      client_order_id TEXT NOT NULL UNIQUE,
      kalshi_order_id TEXT,
      limit_price_cents INTEGER NOT NULL,
      requested_contracts INTEGER NOT NULL,
      filled_contracts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      market_close_ms BIGINT NOT NULL,
      exchange_index INTEGER NOT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      last_error TEXT
    )
  `);
  await d.execute(sql`
    CREATE INDEX IF NOT EXISTS eth_g_4060_orders_unresolved_idx
    ON eth_g_4060_orders (status, updated_at_ms)
  `);
}

function executionEnabled(): boolean {
  return currentEthServiceRole() === "downfade_g"
    && process.env["ETH_G_40_60_LIVE_ENABLED"] === "true"
    && process.env["AUTO_TRADING_ENABLED"] !== "false"
    && process.env["TRADING_ENABLED"] !== "false"
    && process.env["WORKSPACE_TRADING_ENABLED"] !== "false";
}

function wireSide(side: OutcomeSide, role: OrderRole): "bid" | "ask" {
  if (role === "entry") return side === "yes" ? "bid" : "ask";
  return side === "yes" ? "ask" : "bid";
}

/** Kalshi's bid/ask wire price is YES-price space. */
function wirePriceCents(side: OutcomeSide, outcomePriceCents: number): number {
  return side === "yes" ? outcomePriceCents : 100 - outcomePriceCents;
}

function isTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL.has(status.toLowerCase());
}

async function ensureCycle(ticker: string, side: OutcomeSide, closeMs: number, exchangeIndex: number): Promise<void> {
  const d = await db();
  const now = Date.now();
  await d.execute(sql`
    INSERT INTO eth_g_4060_cycles
      (ticker, side, market_close_ms, exchange_index, done, created_at_ms, updated_at_ms)
    VALUES (${ticker}, ${side}, ${closeMs}, ${exchangeIndex}, FALSE, ${now}, ${now})
    ON CONFLICT (ticker, side) DO NOTHING
  `);
}

async function loadCycle(ticker: string, side: OutcomeSide): Promise<GCycle | null> {
  const d = await db();
  const result = await d.execute(sql`
    SELECT ticker, side, market_close_ms, exchange_index, done
    FROM eth_g_4060_cycles WHERE ticker=${ticker} AND side=${side}
  `);
  const row = rows(result)[0];
  if (!row) return null;
  return {
    ticker: String(row["ticker"]),
    side: row["side"] === "no" ? "no" : "yes",
    marketCloseMs: int(row["market_close_ms"]),
    exchangeIndex: int(row["exchange_index"]),
    done: row["done"] === true,
  };
}

async function markDone(ticker: string, side: OutcomeSide, reason: string): Promise<void> {
  const d = await db();
  await d.execute(sql`
    UPDATE eth_g_4060_cycles
    SET done=TRUE, done_reason=${reason}, updated_at_ms=${Date.now()}
    WHERE ticker=${ticker} AND side=${side} AND done=FALSE
  `);
  logger.info({ ticker, side, reason }, "G 40-60 cycle done");
}

async function listOrders(ticker: string, side?: OutcomeSide): Promise<GOrder[]> {
  const d = await db();
  const result = side == null
    ? await d.execute(sql`SELECT * FROM eth_g_4060_orders WHERE ticker=${ticker} ORDER BY created_at_ms, sequence`)
    : await d.execute(sql`SELECT * FROM eth_g_4060_orders WHERE ticker=${ticker} AND side=${side} ORDER BY created_at_ms, sequence`);
  return rows(result).map(asOrder);
}

async function listUnresolvedOrders(): Promise<GOrder[]> {
  const d = await db();
  const result = await d.execute(sql`
    SELECT * FROM eth_g_4060_orders
    WHERE status NOT IN ('filled','executed','canceled','cancelled','expired','rejected')
    ORDER BY updated_at_ms ASC
    LIMIT 50
  `);
  return rows(result).map(asOrder);
}

async function reserveOrder(input: {
  ticker: string; side: OutcomeSide; role: OrderRole; sequence: number;
  contracts: number; limitPriceCents: number; closeMs: number; exchangeIndex: number;
}): Promise<GOrder | null> {
  const d = await db();
  const id = `g4060:${input.ticker}:${input.side}:${input.role}:${input.sequence}`;
  const clientOrderId = id;
  const now = Date.now();
  const result = await d.execute(sql`
    INSERT INTO eth_g_4060_orders
      (id, ticker, side, role, sequence, client_order_id, limit_price_cents,
       requested_contracts, filled_contracts, status, market_close_ms, exchange_index,
       created_at_ms, updated_at_ms)
    VALUES
      (${id}, ${input.ticker}, ${input.side}, ${input.role}, ${input.sequence}, ${clientOrderId},
       ${input.limitPriceCents}, ${input.contracts}, 0, 'reserved', ${input.closeMs},
       ${input.exchangeIndex}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  `);
  const inserted = rows(result)[0];
  if (inserted) return asOrder(inserted);
  const existing = await d.execute(sql`SELECT * FROM eth_g_4060_orders WHERE id=${id}`);
  const row = rows(existing)[0];
  return row ? asOrder(row) : null;
}

async function findExchangeOrderByClientId(clientOrderId: string, ticker: string): Promise<string | null> {
  try {
    const raw = await kalshiAuthFetch<{ orders?: Array<Record<string, unknown>> }>(
      "GET", `/portfolio/orders?client_order_id=${encodeURIComponent(clientOrderId)}&limit=10`,
    );
    const matches = (raw.orders ?? []).filter((order) =>
      order["client_order_id"] === clientOrderId && order["ticker"] === ticker && typeof order["order_id"] === "string",
    );
    return matches.length === 1 ? String(matches[0]!["order_id"]) : null;
  } catch {
    return null;
  }
}

async function submitReserved(order: GOrder): Promise<void> {
  const d = await db();
  if (isTerminal(order.status) || order.kalshiOrderId) return;
  const now = Date.now();
  if (order.status === "submission_unknown" || order.status === "submitting") {
    const recovered = await findExchangeOrderByClientId(order.clientOrderId, order.ticker);
    if (recovered) {
      await d.execute(sql`
        UPDATE eth_g_4060_orders SET kalshi_order_id=${recovered}, status='submitted', updated_at_ms=${now}
        WHERE id=${order.id}
      `);
      return;
    }
    if (now - order.updatedAtMs < SUBMISSION_RECOVERY_MIN_AGE_MS) return;
  }

  const claim = await d.execute(sql`
    UPDATE eth_g_4060_orders SET status='submitting', updated_at_ms=${now}
    WHERE id=${order.id}
      AND kalshi_order_id IS NULL
      AND status IN ('reserved','submission_unknown','submitting')
    RETURNING id
  `);
  if (rows(claim).length !== 1) return;

  try {
    const raw = await kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker: order.ticker,
      client_order_id: order.clientOrderId,
      side: wireSide(order.side, order.role),
      count: `${order.requestedContracts}.00`,
      price: (wirePriceCents(order.side, order.limitPriceCents) / 100).toFixed(4),
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      exchange_index: order.exchangeIndex,
    });
    const parsed = parseKalshiOrderResponse(raw, order.requestedContracts);
    if (parsed.kalshiOrderId) {
      await d.execute(sql`
        UPDATE eth_g_4060_orders
        SET kalshi_order_id=${parsed.kalshiOrderId}, status=${parsed.orderStatus ?? "submitted"},
            filled_contracts=${Math.max(0, Math.trunc(parsed.fillCount))}, updated_at_ms=${Date.now()}, last_error=NULL
        WHERE id=${order.id}
      `);
      logger.info({ ticker: order.ticker, side: order.side, role: order.role,
        priceCents: order.limitPriceCents, contracts: order.requestedContracts,
        orderId: parsed.kalshiOrderId }, "G 40-60 order submitted");
      return;
    }
    await d.execute(sql`
      UPDATE eth_g_4060_orders SET status='submission_unknown', updated_at_ms=${Date.now()},
        last_error='POST succeeded without authoritative order id' WHERE id=${order.id}
    `);
  } catch (err) {
    await d.execute(sql`
      UPDATE eth_g_4060_orders SET status='submission_unknown', updated_at_ms=${Date.now()},
        last_error=${String(err)} WHERE id=${order.id}
    `);
  }
}

async function refreshOrder(order: GOrder): Promise<GOrder> {
  if (!order.kalshiOrderId || isTerminal(order.status)) return order;
  const d = await db();
  try {
    const raw = await kalshiAuthFetch<Record<string, unknown>>(
      "GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,
    );
    const parsed = parseKalshiOrderResponse(raw, Math.max(0, order.requestedContracts - order.filledContracts));
    if (!parsed.fillCountProvided) return order;
    const status = parsed.orderStatus ?? order.status;
    const filled = Math.max(order.filledContracts, Math.min(order.requestedContracts, Math.trunc(parsed.fillCount)));
    await d.execute(sql`
      UPDATE eth_g_4060_orders SET status=${status}, filled_contracts=${filled}, updated_at_ms=${Date.now()}, last_error=NULL
      WHERE id=${order.id}
    `);
    return { ...order, status, filledContracts: filled, updatedAtMs: Date.now() };
  } catch (err) {
    await d.execute(sql`UPDATE eth_g_4060_orders SET last_error=${String(err)}, updated_at_ms=${Date.now()} WHERE id=${order.id}`);
    return order;
  }
}

async function cancelOrder(order: GOrder): Promise<GOrder> {
  if (!order.kalshiOrderId || isTerminal(order.status)) return order;
  try {
    await kalshiAuthFetch<Record<string, unknown>>(
      "DELETE", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,
    );
  } catch {
    // Exact authenticated read below remains authoritative; cancellation is fail-closed.
  }
  return refreshOrder(order);
}

function totals(orders: GOrder[]): { bought: number; exitRequested: number; sold: number } {
  let bought = 0;
  let exitRequested = 0;
  let sold = 0;
  for (const order of orders) {
    if (order.role === "entry") bought += order.filledContracts;
    else {
      exitRequested += order.requestedContracts;
      sold += order.filledContracts;
    }
  }
  return { bought, exitRequested, sold };
}

async function ensureEntry(cycle: GCycle): Promise<void> {
  if (cycle.done || Date.now() >= cycle.marketCloseMs - BOUNDARY_CANCEL_LEAD_MS) return;
  const orders = await listOrders(cycle.ticker, cycle.side);
  if (orders.some((o) => o.role === "entry")) return;
  const entry = await reserveOrder({
    ticker: cycle.ticker, side: cycle.side, role: "entry", sequence: 0,
    contracts: CONTRACTS_PER_SIDE, limitPriceCents: ENTRY_CENTS,
    closeMs: cycle.marketCloseMs, exchangeIndex: cycle.exchangeIndex,
  });
  if (entry) await submitReserved(entry);
}

async function ensureExitForOwned(cycle: GCycle): Promise<void> {
  if (cycle.done) return;
  let orders = await listOrders(cycle.ticker, cycle.side);
  const t = totals(orders);
  const uncovered = t.bought - t.exitRequested;
  if (uncovered <= 0) return;
  const seq = 1 + Math.max(0, ...orders.filter((o) => o.role === "exit").map((o) => o.sequence));
  const exit = await reserveOrder({
    ticker: cycle.ticker, side: cycle.side, role: "exit", sequence: seq,
    contracts: uncovered, limitPriceCents: TARGET_CENTS,
    closeMs: cycle.marketCloseMs, exchangeIndex: cycle.exchangeIndex,
  });
  if (exit) await submitReserved(exit);
}

async function reconcileCycle(cycle: GCycle): Promise<void> {
  if (cycle.done) return;
  let orders = await listOrders(cycle.ticker, cycle.side);
  for (const order of orders) {
    if (!order.kalshiOrderId && ["reserved", "submitting", "submission_unknown"].includes(order.status)) {
      await submitReserved(order);
    }
  }
  orders = await listOrders(cycle.ticker, cycle.side);
  for (let i = 0; i < orders.length; i++) orders[i] = await refreshOrder(orders[i]!);

  const before = totals(orders);
  if (before.bought > before.exitRequested) {
    await ensureExitForOwned(cycle);
    orders = await listOrders(cycle.ticker, cycle.side);
  }

  // Once any owned quantity has completed the 40->60 round trip, stop acquiring
  // new contracts. Cancel the remainder of the 40c entry and verify fills before done.
  let current = totals(orders);
  if (current.sold > 0 && current.sold >= current.bought) {
    const entries = orders.filter((o) => o.role === "entry" && !isTerminal(o.status));
    for (const entry of entries) await cancelOrder(entry);
    orders = await listOrders(cycle.ticker, cycle.side);
    for (let i = 0; i < orders.length; i++) orders[i] = await refreshOrder(orders[i]!);
    current = totals(orders);
    if (current.bought > current.exitRequested) {
      await ensureExitForOwned(cycle);
      return;
    }
    const openEntry = orders.some((o) => o.role === "entry" && !isTerminal(o.status));
    const openExit = orders.some((o) => o.role === "exit" && !isTerminal(o.status));
    if (!openEntry && !openExit && current.sold >= current.bought && current.bought > 0) {
      await markDone(cycle.ticker, cycle.side, "40_to_60_completed");
      return;
    }
  }

  // Market boundary: no chasing. Cancel all resting orders. Any bought-but-unsold
  // inventory is deliberately left to settlement; no new exit is placed after close.
  if (Date.now() >= cycle.marketCloseMs - BOUNDARY_CANCEL_LEAD_MS) {
    for (const order of orders.filter((o) => !isTerminal(o.status))) await cancelOrder(order);
    orders = await listOrders(cycle.ticker, cycle.side);
    for (let i = 0; i < orders.length; i++) orders[i] = await refreshOrder(orders[i]!);
    if (!orders.some((o) => !isTerminal(o.status))) {
      await markDone(cycle.ticker, cycle.side, "market_closed_inventory_to_settlement");
    }
  }
}

async function discoverAndArmCurrentMarket(): Promise<void> {
  if (!executionEnabled()) return;
  const raw = await kalshiSeriesFetch(SERIES, { forceFresh: true });
  if (!raw) return;
  const market = normalizeMarket(raw);
  const ticker = typeof market["ticker"] === "string" ? market["ticker"] : null;
  const close = typeof market["close_time"] === "string" ? Date.parse(market["close_time"]) : NaN;
  const exchangeIndex = Number(market["exchange_index"]);
  if (!ticker || !/^KXETH15M-/.test(ticker) || !Number.isFinite(close)
    || !Number.isInteger(exchangeIndex) || exchangeIndex < 0 || Date.now() >= close - BOUNDARY_CANCEL_LEAD_MS) return;

  await Promise.all([
    ensureCycle(ticker, "yes", close, exchangeIndex),
    ensureCycle(ticker, "no", close, exchangeIndex),
  ]);
  const [yes, no] = await Promise.all([loadCycle(ticker, "yes"), loadCycle(ticker, "no")]);
  await Promise.all([yes ? ensureEntry(yes) : Promise.resolve(), no ? ensureEntry(no) : Promise.resolve()]);
}

let lifecycleBusy = false;
async function lifecycleSweep(): Promise<void> {
  if (lifecycleBusy) return;
  lifecycleBusy = true;
  try {
    const unresolved = await listUnresolvedOrders();
    const keys = new Map<string, { ticker: string; side: OutcomeSide }>();
    for (const order of unresolved) keys.set(`${order.ticker}:${order.side}`, { ticker: order.ticker, side: order.side });
    for (const { ticker, side } of keys.values()) {
      const cycle = await loadCycle(ticker, side);
      if (cycle) await reconcileCycle(cycle);
    }
  } catch (err) {
    logger.warn({ err }, "G 40-60 lifecycle sweep failed");
  } finally {
    lifecycleBusy = false;
  }
}

async function main(): Promise<void> {
  await initStore();
  logger.info({
    serviceRole: currentEthServiceRole(),
    liveEnabled: process.env["ETH_G_40_60_LIVE_ENABLED"] === "true",
    entryCents: ENTRY_CENTS,
    targetCents: TARGET_CENTS,
    contractsPerSide: CONTRACTS_PER_SIDE,
    maxPrincipalPerSideCents: CONTRACTS_PER_SIDE * ENTRY_CENTS,
    maxPrincipalBothSidesCents: CONTRACTS_PER_SIDE * ENTRY_CENTS * 2,
  }, "Service G 40-60 scalp runner started");

  void discoverAndArmCurrentMarket().catch((err) => logger.warn({ err }, "G 40-60 initial discovery failed"));
  void lifecycleSweep();
  const discoveryTimer = setInterval(() => {
    void discoverAndArmCurrentMarket().catch((err) => logger.warn({ err }, "G 40-60 market discovery failed"));
  }, DISCOVERY_INTERVAL_MS);
  const lifecycleTimer = setInterval(() => { void lifecycleSweep(); }, LIFECYCLE_INTERVAL_MS);
  discoveryTimer.unref();
  lifecycleTimer.unref();

  const port = Number(process.env["PORT"] || 3000);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        service: "eth-g-40-60-scalp",
        role: currentEthServiceRole(),
        execution_enabled: executionEnabled(),
        entry_cents: ENTRY_CENTS,
        target_cents: TARGET_CENTS,
        contracts_per_side: CONTRACTS_PER_SIDE,
        max_principal_per_side_cents: CONTRACTS_PER_SIDE * ENTRY_CENTS,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  server.listen(port, "0.0.0.0", () => logger.info({ port }, "Service G health server listening"));
}

main().catch((err) => {
  logger.error({ err }, "Service G 40-60 fatal startup error");
  process.exit(1);
});
