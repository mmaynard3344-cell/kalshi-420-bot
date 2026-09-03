import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  SOL30_ENTRY_CAP_CENTS,
  SOL30_PRINCIPAL_CAP_CENTS,
  contractsForSol30Capacity,
  isSol30OpeningWindow,
  isSol30Ticker,
  mayEnterSol30,
} from "./sol30_50Rules.js";
import {
  buildSol30Report,
  checkStaleSol30Claims,
  computeSol30OwnedQuantity,
  computeSol30RestingExitQuantity,
  evaluateSol30,
  ensureSol30TargetExit,
  reconcileSol30OwnedOrders,
  reconcileSol30Settlements,
  recoverSol30Targets,
  warmSol30SettledTickersCache,
  startSol30PeriodicReconciliation,
  _runSol30PeriodicReconcileSweepForTesting,
  _setSol30KalshiFetchForTesting,
  _setSol30OrderbookCaptureForTesting,
  _setSol30EntryGuardsForTesting,
  _setSol30NowForTesting,
  _setSol30StoreForTesting,
  _settledTickersForTesting,
  type Sol30Store,
  type Sol30StrategyOrder,
} from "./sol30_50.js";
import type { Sol30DecisionEventParams, Sol30PositionEventParams, Sol30TickerClaim } from "./sol30_50.js";
import type { OrderbookSnapshot } from "../orderbookCapture.js";
import { easternDay } from "../dailyBudget.js";
import { _resetDailyProfitStopForTesting, _setDailyProfitStopFetchForTesting } from "../dailyProfitStop.js";

// ── Pure rule tests ────────────────────────────────────────────────────────────

test("SOL_30_50 admits only exact KXSOL15M series tokens", () => {
  assert.equal(isSol30Ticker("KXSOL15M-26AUG161200-15"), true);
  assert.equal(isSol30Ticker("KXSOL15MTEST-26AUG161200-15"), false);
  assert.equal(isSol30Ticker("KXBTC15M-26AUG161200-15"), false);
  assert.equal(isSol30Ticker("KXETH15M-26AUG161200-15"), false);
});

test("SOL_30_50 opening window is [open, open + five minutes)", () => {
  const open = "2026-08-16T12:00:00.000Z";
  assert.equal(isSol30OpeningWindow(open, Date.parse(open)), true);
  assert.equal(isSol30OpeningWindow(open, Date.parse(open) + 299_999), true);
  assert.equal(isSol30OpeningWindow(open, Date.parse(open) + 300_000), false);
  assert.equal(isSol30OpeningWindow(null, Date.parse(open)), false);
});

test("SOL_30_50 entry capacity is limited to the inclusive 20–30¢ band and $1 principal cap", () => {
  assert.equal(SOL30_ENTRY_CAP_CENTS, 30);
  assert.equal(SOL30_PRINCIPAL_CAP_CENTS, 100);
  assert.equal(contractsForSol30Capacity(100_000, 19, 100), 0);
  assert.equal(contractsForSol30Capacity(100_000, 20, 100), 5);
  assert.equal(contractsForSol30Capacity(100_000, 25, 100), 4);
  assert.equal(contractsForSol30Capacity(100_000, 30, 100), 3);
  assert.equal(contractsForSol30Capacity(SOL30_PRINCIPAL_CAP_CENTS, 25, 3), 3);
  assert.equal(contractsForSol30Capacity(SOL30_PRINCIPAL_CAP_CENTS, 31, 100), 0);
  assert.equal(contractsForSol30Capacity(SOL30_PRINCIPAL_CAP_CENTS, 12, 100), 0);
  for (let price = 20; price <= SOL30_ENTRY_CAP_CENTS; price += 1) {
    const contracts = contractsForSol30Capacity(Number.MAX_SAFE_INTEGER, price, Number.MAX_SAFE_INTEGER);
    assert.ok(contracts * price <= 100, `${price}¢ entry cannot exceed $1 principal`);
  }
});

test("SOL_30_50 cannot bypass the global halt or profit-stop gate", () => {
  assert.equal(mayEnterSol30(true, false, true), true);
  assert.equal(mayEnterSol30(true, true, true), false);
  assert.equal(mayEnterSol30(true, false, false), false);
  assert.equal(mayEnterSol30(false, false, true), false);
});

// ── Midnight-boundary yesterday formula ───────────────────────────────────────

test("SOL_30_50 yesterday formula lands on the correct prior Eastern date in EST (UTC−5)", () => {
  const date = "2026-01-15";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-01-14");
});

test("SOL_30_50 yesterday formula lands on the correct prior Eastern date in EDT (UTC−4)", () => {
  const date = "2026-07-15";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-07-14");
});

test("SOL_30_50 yesterday formula crosses the EST→EDT spring-forward boundary correctly", () => {
  const date = "2026-03-08";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-03-07");
});

test("SOL_30_50 yesterday formula crosses the EDT→EST fall-back boundary correctly", () => {
  const date = "2026-11-01";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-10-31");
});

// ── Integration harness ───────────────────────────────────────────────────────

const TICKER = "KXSOL15M-26AUG161200-15";
const DATE = "2026-08-16";

interface MemStore extends Sol30Store {
  orders: Map<string, Sol30StrategyOrder>;
  events: Map<string, Sol30PositionEventParams>;
  claims: Map<string, Sol30TickerClaim>;
  decisions: Map<string, Sol30DecisionEventParams>;
}

function memStore(): MemStore {
  const orders = new Map<string, Sol30StrategyOrder>();
  const events = new Map<string, Sol30PositionEventParams>();
  const claims = new Map<string, Sol30TickerClaim>();
  const decisions = new Map<string, Sol30DecisionEventParams>();
  return {
    orders, events, claims, decisions,
    async reserveSol30PairedEntry(params) {
      if (claims.has(params.ticker) || params.orders.some((order) => orders.has(order.id))) return false;
      claims.set(params.ticker, { ticker: params.ticker, easternDate: params.easternDate, claimedAtMs: Date.now(), entryClientOrderId: params.entryClientOrderId });
      for (const order of params.orders) orders.set(order.id, { ...order, kalshiOrderId: null, outcome: "pending", filledContracts: null, averageFillPriceCents: null, updatedAtMs: Date.now() });
      return true;
    },
    async claimSol30Ticker(ticker, easternDate, entryClientOrderId) {
      if (claims.has(ticker)) return false;
      claims.set(ticker, { ticker, easternDate, claimedAtMs: Date.now(), entryClientOrderId });
      return true;
    },
    async deleteSol30PositionEvents(ids) {
      for (const id of ids) events.delete(id);
      return true;
    },
    async appendSol30DecisionEvent(params) { decisions.set(params.id, { ...params }); return true; },
    async listSol30DecisionEvents(ticker) {
      return [...decisions.values()].filter((d) => d.ticker === ticker).sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    },
    async listRecentSol30DecisionEvents(limit) {
      const all = [...decisions.values()].sort((a, b) => b.occurredAtMs - a.occurredAtMs);
      return limit != null ? all.slice(0, limit) : all;
    },
    async listAllSol30TickerClaims() { return [...claims.values()]; },
    async listSol30TickerClaimsForDate(easternDate) {
      return [...claims.values()].filter((c) => c.easternDate === easternDate);
    },
    async listSol30TickerClaimsForDates(dates) {
      const set = new Set(dates);
      return [...claims.values()].filter((c) => set.has(c.easternDate));
    },
    async recordSol30StrategyOrder(params) {
      if (orders.has(params.id)) return false;
      orders.set(params.id, { ...params, kalshiOrderId: null, outcome: "pending", filledContracts: null, averageFillPriceCents: null, updatedAtMs: Date.now() });
      return true;
    },
    async updateSol30StrategyOrder(update) {
      const row = orders.get(update.id);
      if (!row) return false;
      if (update.kalshiOrderId !== undefined) row.kalshiOrderId = update.kalshiOrderId;
      if (update.outcome !== undefined) row.outcome = update.outcome;
      if (update.filledContracts !== undefined) row.filledContracts = update.filledContracts;
      if (update.averageFillPriceCents !== undefined) row.averageFillPriceCents = update.averageFillPriceCents;
      row.updatedAtMs = Date.now();
      return true;
    },
    async listSol30StrategyOrders(ticker) {
      return [...orders.values()].filter((o) => o.ticker === ticker).map((o) => ({ ...o }));
    },
    async appendSol30PositionEvent(params) {
      if (events.has(params.id)) {
        // Mirror the ON CONFLICT DO UPDATE SET fee_cents = EXCLUDED.fee_cents
        // WHERE fee_cents IS NULL semantics from the real tradeStore.
        const existing = events.get(params.id)!;
        if (existing.feeCents === null && params.feeCents !== null) {
          existing.feeCents = params.feeCents;
        }
      } else {
        events.set(params.id, { ...params });
      }
      return true;
    },
    async listSol30PositionEvents(ticker) {
      return [...events.values()].filter((e) => e.ticker === ticker).sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    },
    async listSettledSol30Tickers() {
      const settled = new Set<string>();
      for (const ev of events.values()) {
        if (ev.eventType === "settlement") settled.add(ev.ticker);
      }
      return [...settled];
    },
  };
}

interface ExchangeOrder {
  status: string;
  fillCount: number;
  fills: Array<{ fill_id: string; count_fp: string; yes_price_dollars: string; no_price_dollars: string; fee_cost_dollars: string; created_time: string }>;
  rejectReason?: string;
}

interface FakeExchange {
  orders: Map<string, ExchangeOrder>;
  markets: Map<string, { result: string | null }>;
  posted: Array<Record<string, unknown>>;
  cancelled: string[];
  requestedPaths: string[];
  nextOrderId: () => string;
  fetch: <T>(method: string, path: string, body?: unknown) => Promise<T>;
}

function fakeExchange(): FakeExchange {
  let seq = 0;
  const ex: FakeExchange = {
    orders: new Map(),
    markets: new Map(),
    posted: [],
    cancelled: [],
    requestedPaths: [],
    nextOrderId: () => `ko-${++seq}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch: (async (method: string, path: string, body?: any) => {
      ex.requestedPaths.push(`${method} ${path}`);
      if (method === "POST" && path === "/portfolio/events/orders") {
        ex.posted.push(body);
        const orderId = ex.nextOrderId();
        ex.orders.set(orderId, { status: "resting", fillCount: 0, fills: [] });
        return { order: { order_id: orderId, status: "resting", fill_count_fp: "0.00" } };
      }
      const orderMatch = /^\/portfolio\/(?:events\/)?orders\/([^/?]+)$/.exec(path);
      if (orderMatch) {
        const id = orderMatch[1]!;
        const order = ex.orders.get(id);
        if (!order) throw new Error(`unknown order ${id}`);
        if (method === "DELETE") {
          ex.cancelled.push(id);
          order.status = "canceled";
          return { order: { order_id: id, status: "canceled", fill_count_fp: order.fillCount.toFixed(2) } };
        }
        return {
          order: {
            order_id: id, status: order.status, fill_count_fp: order.fillCount.toFixed(2),
            ...(order.rejectReason ? { reject_reason: order.rejectReason } : {}),
          },
        };
      }
      const fillsMatch = /^\/portfolio\/fills\?order_id=([^&]+)$/.exec(path);
      if (fillsMatch) {
        const order = ex.orders.get(decodeURIComponent(fillsMatch[1]!));
        return { fills: order?.fills ?? [] };
      }
      const marketMatch = /^\/markets\/([^/?]+)$/.exec(path);
      if (marketMatch) {
        const ticker = decodeURIComponent(marketMatch[1]!);
        const market = ex.markets.get(ticker);
        return { market: { result: market?.result ?? null, status: market?.result ? "finalized" : "open" } };
      }
      throw new Error(`unexpected exchange call: ${method} ${path}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
  return ex;
}

function chunk(fillId: string, count: number, yesCents: number, at: string) {
  return {
    fill_id: fillId, count_fp: `${count}.00`,
    yes_price_dollars: (yesCents / 100).toFixed(4),
    no_price_dollars: ((100 - yesCents) / 100).toFixed(4),
    fee_cost_dollars: "0", created_time: at,
  };
}

async function withHarness(fn: (store: MemStore, ex: FakeExchange) => Promise<void>): Promise<void> {
  const store = memStore();
  const ex = fakeExchange();
  const prevEnabled = process.env["SOL_30_50_ENABLED"];
  process.env["SOL_30_50_ENABLED"] = "true";
  _setSol30StoreForTesting(store);
  _setSol30KalshiFetchForTesting(ex.fetch as never);
  _setSol30EntryGuardsForTesting(
    () => false,
    async () => ({ allowed: true, status: {} as never }),
  );
  _setDailyProfitStopFetchForTesting(async <T>(method: string, path: string): Promise<T> => {
    if (method === "GET" && path.startsWith("/portfolio/fills?")) return { fills: [] } as T;
    throw new Error(`unexpected daily-profit test path: ${method} ${path}`);
  });
  try {
    await fn(store, ex);
  } finally {
    _setSol30StoreForTesting(null);
    _setSol30KalshiFetchForTesting(null);
    _setSol30OrderbookCaptureForTesting(null);
    _setSol30EntryGuardsForTesting(null, null);
    _resetDailyProfitStopForTesting();
    if (prevEnabled === undefined) delete process.env["SOL_30_50_ENABLED"];
    else process.env["SOL_30_50_ENABLED"] = prevEnabled;
  }
}

test("SOL_30_50 evaluator claims its first executable side once and never re-enters after an IOC zero fill", async () => {
  await withHarness(async (store, ex) => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    ex.fetch = (async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/portfolio/events/orders") {
        return { order: { order_id: "entry-zero", fill_count: "0.00", status: "canceled" } };
      }
      throw new Error(`unexpected exchange call: ${method} ${path}`);
    }) as typeof ex.fetch;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    _setSol30OrderbookCaptureForTesting(async () => ({
      error: null, lowestLevelCents: 30, depthAtOrBetterContracts: 50,
    } as unknown as OrderbookSnapshot));

    const ticker = "KXSOL15M-26AUG161200-15";
    const state = { ticker, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() };
    await evaluateSol30(state);
    await evaluateSol30(state);

    assert.equal(calls.length, 1, "a permanent claim prevents a second opening order");
    assert.equal(calls[0]?.body?.["ticker"], ticker);
    assert.equal(calls[0]?.body?.["side"], "bid");
    assert.equal(calls[0]?.body?.["price"], "0.3000");
    assert.equal(calls[0]?.body?.["count"], "3.00");
    assert.equal(store.claims.size, 1);
    assert.equal(store.orders.get(`entry:${ticker}`)?.outcome, "zero_fill");
  });
});

test("SOL_30_50 reserves complementary 20–30¢ / 70–80¢ child entries before POST and keeps both sides independent", async () => {
  await withHarness(async (store, ex) => {
    const baseFetch = ex.fetch;
    ex.fetch = (async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "POST" && path === "/portfolio/events/orders" && body?.["time_in_force"] === "immediate_or_cancel") {
        const side = body["side"] === "bid" ? "yes" : "no";
        return { order: { order_id: `pair-${side}`, status: "filled", fill_count_fp: body["count"] } };
      }
      return baseFetch(method, path, body);
    }) as typeof ex.fetch;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    _setSol30OrderbookCaptureForTesting(async (_ticker, side) => ({
      error: null, lowestLevelCents: side === "yes" ? 25 : 75, depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));
    await evaluateSol30({ ticker: TICKER, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() });
    await evaluateSol30({ ticker: TICKER, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() });
    const entries = [...store.orders.values()].filter((order) => order.role === "entry");
    assert.equal(entries.length, 2, "one durable child per outcome; duplicate tick cannot re-enter");
    assert.deepEqual(new Set(entries.map((order) => order.side)), new Set(["yes", "no"]));
    assert.ok(entries.every((order) => order.requestedContracts * order.limitPriceCents <= 100));
    assert.ok(entries.reduce((sum, order) => sum + order.requestedContracts * order.limitPriceCents, 0) <= 200);
    const exits = [...store.orders.values()].filter((order) => order.role === "exit");
    assert.equal(exits.length, 1, "only the low paired leg receives a 50¢ target");
    assert.equal(exits[0]?.side, "yes");
    assert.equal(exits[0]?.limitPriceCents, 50);
  });
});

test("SOL_30_50 restart recovery keeps a paired 70–80¢ leg through settlement while restoring the low-leg target", async () => {
  await withHarness(async (store, ex) => {
    await store.reserveSol30PairedEntry!({
      ticker: TICKER, easternDate: DATE, entryClientOrderId: "pair-yes",
      orders: [
        { id: `entry:${TICKER}:yes`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0, clientOrderId: "pair-yes", side: "yes", limitPriceCents: 25, requestedContracts: 4 },
        { id: `entry:${TICKER}:no`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0, clientOrderId: "pair-no", side: "no", limitPriceCents: 75, requestedContracts: 1 },
      ],
    });
    await store.updateSol30StrategyOrder({ id: `entry:${TICKER}:yes`, filledContracts: 4, averageFillPriceCents: 25, outcome: "full_fill" });
    await store.updateSol30StrategyOrder({ id: `entry:${TICKER}:no`, filledContracts: 1, averageFillPriceCents: 75, outcome: "full_fill" });
    await store.recordSol30StrategyOrder({
      id: `exit:${TICKER}:legacy-high`, ticker: TICKER, easternDate: DATE, role: "exit", sequenceNumber: 1,
      clientOrderId: "legacy-high-target", side: "no", limitPriceCents: 50, requestedContracts: 1,
    });
    await store.updateSol30StrategyOrder({
      id: `exit:${TICKER}:legacy-high`, kalshiOrderId: "legacy-high-target", filledContracts: 0,
      averageFillPriceCents: null, outcome: "pending",
    });
    ex.orders.set("legacy-high-target", { status: "resting", fillCount: 0, fills: [] });

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const activeExits = [...store.orders.values()].filter((order) => order.role === "exit" && ["pending", "partial_fill"].includes(order.outcome));
    assert.equal(store.orders.get(`exit:${TICKER}:legacy-high`)?.outcome, "cancelled", "recovery cancels a pre-deploy high-leg target");
    assert.equal(activeExits.length, 1, "recovery must not leave or create a high-leg exit");
    assert.equal(activeExits[0]?.side, "yes");
    assert.equal(activeExits[0]?.limitPriceCents, 50);
  });
});

test("SOL_30_50 only creates entries for executable 20–30¢ YES or NO opportunities", async () => {
  const cases: Array<{ price: number; side: "yes" | "no"; enters: boolean }> = [
    { price: 12, side: "yes", enters: false },
    { price: 19, side: "yes", enters: false },
    { price: 20, side: "no", enters: true },
    { price: 25, side: "no", enters: true },
    { price: 30, side: "yes", enters: true },
    { price: 31, side: "no", enters: false },
  ];
  for (const { price, side, enters } of cases) {
    await withHarness(async (store, ex) => {
      _setSol30OrderbookCaptureForTesting(async (_ticker, candidateSide) => ({
        error: null,
        lowestLevelCents: candidateSide === side ? price : null,
        depthAtOrBetterContracts: candidateSide === side ? 100 : 0,
      } as unknown as OrderbookSnapshot));
      await evaluateSol30({
        ticker: TICKER, openTime: new Date().toISOString(), closeTime: null,
        status: "open", bidUpdatedMs: Date.now(),
      });
      assert.equal(ex.posted.length, enters ? 1 : 0, `${price}¢ ${side} entry submission`);
      assert.equal(store.claims.size, enters ? 1 : 0, `${price}¢ ${side} ticker claim`);
      if (enters) {
        const expectedPrice = ((side === "yes" ? price : 100 - price) / 100).toFixed(4);
        assert.equal(ex.posted[0]?.["price"], expectedPrice);
        assert.equal(ex.posted[0]?.["side"], side === "yes" ? "bid" : "ask");
      }
    });
  }
});

/** Seed a claimed ticker with a partially filled entry order linked to `ko-entry`. */
async function seedEntry(
  store: MemStore, ex: FakeExchange, ackFilled: number, requested: number, side: "yes" | "no" = "yes",
): Promise<void> {
  await store.claimSol30Ticker(TICKER, DATE, "coid-entry");
  await store.recordSol30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0,
    clientOrderId: "coid-entry", side, limitPriceCents: 28, requestedContracts: requested,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: ackFilled,
    averageFillPriceCents: ackFilled > 0 ? 28 : null,
    outcome: ackFilled === 0 ? "zero_fill" : ackFilled === requested ? "full_fill" : "partial_fill",
  });
  if (ackFilled > 0) {
    await store.appendSol30PositionEvent({
      id: `${TICKER}:entry_fill:coid-entry`, ticker: TICKER, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: ackFilled, contractsAfter: ackFilled, strategyOrderId: `entry:${TICKER}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
  }
  ex.orders.set("ko-entry", { status: ackFilled === requested ? "filled" : "resting", fillCount: ackFilled, fills: [] });
}

function pendingExits(store: MemStore): Sol30StrategyOrder[] {
  return [...store.orders.values()].filter((o) => o.role === "exit" && ["pending", "partial_fill"].includes(o.outcome));
}

// ── Integration tests: restart, partial fill, no-oversell ────────────────────

test("SOL_30_50 restart recovery reconciles a grown partial entry fill via owned fill chunks and posts one target", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 10);
    // While the server was down the entry grew to 7 contracts across 3 chunks.
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 7;
    entry.fills = [
      chunk("f1", 3, 28, "2026-08-16T12:00:01Z"),
      chunk("f2", 2, 28, "2026-08-16T12:00:02Z"),
      chunk("f3", 2, 29, "2026-08-16T12:00:03Z"),
    ];

    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.filledContracts, 7);
    assert.equal(entryRow.outcome, "partial_fill");
    // Incremental chunk persistence: ack already covered 3, so only the 4 new
    // contracts enter the ledger.
    const entryEvents = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "entry_fill");
    const ledgerDelta = entryEvents.reduce((s, e) => s + e.contractsDelta, 0);
    assert.equal(ledgerDelta, 7);
    assert.ok(entryEvents.some((e) => e.id.includes("f3")));
    // Exactly one resting 50¢ target for the full owned quantity.
    const exits = pendingExits(store);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.requestedContracts, 7);
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted.length, 1);
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");
  });
});

test("SOL_30_50 50¢ targets use the closing Kalshi direction for both held outcomes", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 3, "yes");
    await recoverSol30Targets(DATE);
    assert.equal(ex.posted[0]?.["side"], "ask", "a held YES closes by asking YES");
    assert.equal(ex.posted[0]?.["price"], "0.5000");
    assert.equal(ex.posted[0]?.["time_in_force"], "good_till_canceled");
  });
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 3, "no");
    await recoverSol30Targets(DATE);
    assert.equal(ex.posted[0]?.["side"], "bid", "a held NO closes by bidding YES");
    assert.equal(ex.posted[0]?.["price"], "0.5000");
    assert.equal(ex.posted[0]?.["time_in_force"], "good_till_canceled");
  });
});

test("SOL_30_50 a second restart with an unchanged exchange causes no cancel/repost churn", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE); // posts the target
    assert.equal(ex.posted.length, 1);
    const postedBefore = ex.posted.length;

    await recoverSol30Targets(DATE); // simulated second restart
    await recoverSol30Targets(DATE); // and a third

    assert.equal(ex.posted.length, postedBefore, "no duplicate target orders");
    assert.equal(ex.cancelled.length, 0, "no cancel churn");
    assert.equal(pendingExits(store).length, 1);
  });
});

test("SOL_30_50 restart after day boundary recovers a position claimed the prior Eastern date", async () => {
  const DATE_PREV = "2026-08-15";
  await withHarness(async (store, ex) => {
    // Seed the entry on the previous Eastern date.
    await store.claimSol30Ticker(TICKER, DATE_PREV, "coid-entry-prev");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE_PREV, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-entry-prev", side: "yes", limitPriceCents: 25, requestedContracts: 4,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry-prev", filledContracts: 4,
      averageFillPriceCents: 25, outcome: "full_fill",
    });
    await store.appendSol30PositionEvent({
      id: `${TICKER}:entry_fill:coid-entry-prev`, ticker: TICKER, easternDate: DATE_PREV,
      eventType: "entry_fill", contractsDelta: 4, contractsAfter: 4,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 25, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-entry-prev", { status: "filled", fillCount: 4, fills: [] });

    // Recovery is called with today's date — the prior-date lookup must find the claim.
    await recoverSol30Targets(DATE);

    // A resting 50¢ GTC exit should have been posted for the full 4 contracts.
    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "one target exit posted for the prior-date position");
    assert.equal(exits[0]!.requestedContracts, 4);
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted.length, 1);
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");

    // A second recovery call with the same today's date must not double-post.
    await recoverSol30Targets(DATE);
    assert.equal(ex.posted.length, 1, "no churn on second restart");
  });
});

test("SOL_30_50 settled prior-day claim is skipped entirely during recovery — no reconcile or exit work", async () => {
  const DATE_PREV = "2026-08-15";
  await withHarness(async (store, ex) => {
    await store.claimSol30Ticker(TICKER, DATE_PREV, "coid-entry-prev");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE_PREV, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-entry-prev", side: "yes", limitPriceCents: 25, requestedContracts: 4,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry-prev", filledContracts: 4,
      averageFillPriceCents: 25, outcome: "full_fill",
    });
    ex.orders.set("ko-entry-prev", { status: "filled", fillCount: 4, fills: [] });
    await store.appendSol30PositionEvent({
      id: `${TICKER}:entry_fill:coid-entry-prev`, ticker: TICKER, easternDate: DATE_PREV,
      eventType: "entry_fill", contractsDelta: 4, contractsAfter: 4,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 25, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now() - 10_000,
    });
    // The market settled YES while the server was down.
    await store.appendSol30PositionEvent({
      id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE_PREV,
      eventType: "settlement", contractsDelta: -4, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes",
      note: "market settled yes; 4 owned contracts closed at settlement",
      occurredAtMs: Date.now() - 5_000,
    });

    await recoverSol30Targets(DATE);

    assert.equal(ex.posted.length, 0, "no exit target posted for a settled position");
    assert.equal(pendingExits(store).length, 0, "no pending exit order in the store");
    assert.ok(
      !ex.requestedPaths.some((p) => p.includes("ko-entry-prev")),
      "no exchange query for a settled position",
    );
  });
});

test("SOL_30_50 recoverSol30Targets finds a prior-day claim at the EDT midnight after spring-forward (2026-03-09 00:01 EDT)", async () => {
  const PRIOR_DATE_SF = "2026-03-08";
  await withHarness(async (store, ex) => {
    await store.claimSol30Ticker(TICKER, PRIOR_DATE_SF, "coid-sf");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: PRIOR_DATE_SF, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-sf", side: "yes", limitPriceCents: 27, requestedContracts: 5,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-sf", filledContracts: 5,
      averageFillPriceCents: 27, outcome: "full_fill",
    });
    await store.appendSol30PositionEvent({
      id: `${TICKER}:entry_fill:coid-sf`, ticker: TICKER, easternDate: PRIOR_DATE_SF,
      eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 27, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-sf", { status: "filled", fillCount: 5, fills: [] });

    // Fix the recovery clock at 00:01 AM EDT on March 9, 2026 = 04:01 UTC.
    _setSol30NowForTesting(() => new Date("2026-03-09T04:01:00Z"));
    try {
      await recoverSol30Targets(); // date = easternDay(sweepNow()) = "2026-03-09"
    } finally {
      _setSol30NowForTesting(null);
    }

    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "prior-day position recovered at spring-forward midnight boundary");
    assert.equal(exits[0]!.requestedContracts, 5);
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");
    assert.equal(ex.posted[0]!["self_trade_prevention_type"], "taker_at_cross");
  });
});

test("SOL_30_50 recoverSol30Targets finds a prior-day claim at the EDT midnight on fall-back day (2026-11-01 00:01 EDT)", async () => {
  const PRIOR_DATE_FB = "2026-10-31";
  await withHarness(async (store, ex) => {
    await store.claimSol30Ticker(TICKER, PRIOR_DATE_FB, "coid-fb");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: PRIOR_DATE_FB, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-fb", side: "yes", limitPriceCents: 26, requestedContracts: 3,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-fb", filledContracts: 3,
      averageFillPriceCents: 26, outcome: "full_fill",
    });
    await store.appendSol30PositionEvent({
      id: `${TICKER}:entry_fill:coid-fb`, ticker: TICKER, easternDate: PRIOR_DATE_FB,
      eventType: "entry_fill", contractsDelta: 3, contractsAfter: 3,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 26, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-fb", { status: "filled", fillCount: 3, fills: [] });

    // Fix the recovery clock at 00:01 AM EDT on November 1, 2026 = 04:01 UTC.
    _setSol30NowForTesting(() => new Date("2026-11-01T04:01:00Z"));
    try {
      await recoverSol30Targets(); // date = easternDay(sweepNow()) = "2026-11-01"
    } finally {
      _setSol30NowForTesting(null);
    }

    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "prior-day position recovered at fall-back midnight boundary");
    assert.equal(exits[0]!.requestedContracts, 3);
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");
  });
});

test("SOL_30_50 partial target fill keeps the same resting order when its remainder matches owned quantity", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 6, 6);
    await recoverSol30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    // The resting target partially fills 2 of 6 while the server is down.
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 2;
    exchangeExit.fills = [chunk("x1", 2, 50, "2026-08-16T12:05:00Z")];

    await recoverSol30Targets(DATE);

    const orders = await store.listSol30StrategyOrders(TICKER);
    assert.equal(computeSol30OwnedQuantity(orders), 4);
    assert.equal(computeSol30RestingExitQuantity(orders), 4); // 6 requested − 2 filled
    assert.equal(ex.cancelled.length, 0, "matching remainder is left alone");
    assert.equal(pendingExits(store).length, 1);
    const exitEvents = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill");
    assert.equal(exitEvents.reduce((s, e) => s + e.contractsDelta, 0), -2);
    assert.ok(exitEvents.some((e) => e.id.includes("x1")));
  });
});

test("SOL_30_50 fractional entry and target fills preserve the exact protected remainder", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 26.96, 26.96);
    await recoverSol30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    assert.equal(exitRow.requestedContracts, 26.96);
    assert.equal(ex.posted[0]!["count"], "26.96");

    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 2.01;
    exchangeExit.fills = [chunk("fractional-exit", 2.01, 50, "2026-08-16T12:05:00Z")];
    await recoverSol30Targets(DATE);

    const orders = await store.listSol30StrategyOrders(TICKER);
    assert.ok(Math.abs(computeSol30OwnedQuantity(orders) - 24.95) < 1e-6);
    assert.ok(Math.abs(computeSol30RestingExitQuantity(orders) - 24.95) < 1e-6);
    assert.equal(ex.cancelled.length, 0, "matching decimal remainder must not churn");
    assert.ok(ex.requestedPaths.some((path) => path === `GET /portfolio/orders/${exitRow.kalshiOrderId}`));
  });
});

test("SOL_30_50 stale target is cancelled and reposted once when the entry grows after the target was placed", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 4, 10);
    await recoverSol30Targets(DATE); // target for 4
    const firstExit = pendingExits(store)[0]!;
    // Entry later grows to 10; the 4-lot target is now stale.
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 10;
    entry.status = "filled";
    entry.fills = [chunk("f1", 4, 28, "2026-08-16T12:00:01Z"), chunk("f2", 6, 28, "2026-08-16T12:00:05Z")];

    await recoverSol30Targets(DATE);

    assert.deepEqual(ex.cancelled, [firstExit.kalshiOrderId], "exactly the stale target was cancelled");
    const exits = pendingExits(store);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.requestedContracts, 10);
    const orders = await store.listSol30StrategyOrders(TICKER);
    assert.equal(computeSol30RestingExitQuantity(orders), 10);
    assert.ok(computeSol30RestingExitQuantity(orders) <= computeSol30OwnedQuantity(orders), "never oversell");
  });
});

test("SOL_30_50 target sizing is clamped to owned quantity — a stale caller cannot oversell", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    // Caller asks to rest 50 contracts; only 5 are owned.
    await ensureSol30TargetExit(TICKER, "yes", 50, DATE);
    const exits = pendingExits(store);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.requestedContracts, 5);
    assert.equal(ex.posted[0]!["count"], "5.00");
  });
});

test("SOL_30_50 fully sold position posts no new target after restart", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 5;
    exchangeExit.status = "filled";
    exchangeExit.fills = [chunk("x1", 5, 50, "2026-08-16T12:06:00Z")];
    const postedBefore = ex.posted.length;

    await recoverSol30Targets(DATE);

    assert.equal(pendingExits(store).length, 0);
    assert.equal(ex.posted.length, postedBefore, "no target posted for a fully sold position");
    const orders = await store.listSol30StrategyOrders(TICKER);
    assert.equal(computeSol30OwnedQuantity(orders), 0);
  });
});

test("SOL_30_50 failed cancel of a stale target fails closed: no replacement is posted", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 4, 10);
    await recoverSol30Targets(DATE);
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 10;
    entry.fills = [chunk("f1", 4, 28, "2026-08-16T12:00:01Z"), chunk("f2", 6, 28, "2026-08-16T12:00:05Z")];
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "DELETE") throw new Error("exchange unavailable");
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverSol30Targets(DATE);

    assert.equal(ex.posted.length, postedBefore, "no replacement beside an unconfirmed resting order");
    assert.equal(pendingExits(store).length, 1, "the original target row stays pending");
  });
});

test("SOL_30_50 canceled exit with fills endpoint lagging: status fill count is a floor, replacement never oversells", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE); // target for 5
    const exitRow = pendingExits(store)[0]!;
    // Exchange reports the exit canceled with 2 contracts filled, but the
    // fills endpoint is still propagating and returns an empty (valid) page.
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.status = "canceled";
    exchangeExit.fillCount = 2;
    exchangeExit.fills = [];

    await recoverSol30Targets(DATE);

    const cancelledRow = store.orders.get(exitRow.id)!;
    assert.equal(cancelledRow.outcome, "cancelled");
    assert.equal(cancelledRow.filledContracts, 2, "status fill count persisted despite empty fills page");
    const orders = await store.listSol30StrategyOrders(TICKER);
    assert.equal(computeSol30OwnedQuantity(orders), 3);
    const exits = pendingExits(store);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.requestedContracts, 3, "replacement sized to actual remaining holding");
    assert.ok(computeSol30RestingExitQuantity(orders) <= computeSol30OwnedQuantity(orders), "never oversell");
    const exitEvents = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill");
    assert.equal(exitEvents.reduce((s, e) => s + e.contractsDelta, 0), -2);
  });
});

test("SOL_30_50 malformed explicit fill counts (negative / non-numeric) fail closed in DELETE and GET paths", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const realFetch = ex.fetch;
    const postedBefore = ex.posted.length;

    // GET path: canceled with a negative count and empty fills — quantity ambiguous.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.includes(`/portfolio/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "canceled", fill_count_fp: "-1" } };
      }
      if (method === "GET" && path.includes("order_id=") && path.includes(exitRow.kalshiOrderId!)) {
        return { fills: [] };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);

    await recoverSol30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "negative count not trusted as zero");
    assert.equal(ex.posted.length, postedBefore, "no replacement on malformed GET count");

    // DELETE path: force a cancel attempt (stale size) that returns a
    // non-numeric count on a terminal canceled status.
    store.orders.get(exitRow.id)!.requestedContracts = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "DELETE") {
        return { order: { order_id: path.split("/").pop(), status: "canceled", fill_count_fp: "garbage" } };
      }
      if (method === "GET" && path.includes(`/portfolio/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "resting", fill_count_fp: "0.00" } };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);

    await recoverSol30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "non-numeric DELETE count fails closed");
    assert.equal(ex.posted.length, postedBefore, "no replacement on malformed DELETE count");
  });
});

test("SOL_30_50 GET status canceled with omitted fill count and empty fills stays pending: no replacement posted", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.includes(`/portfolio/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "canceled" } };
      }
      if (method === "GET" && path.includes("order_id=") && path.includes(exitRow.kalshiOrderId!)) {
        return { fills: [] };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "row not terminalized on unknown quantity");
    assert.equal(ex.posted.length, postedBefore, "no replacement while the canceled quantity is unknown");
  });
});

test("SOL_30_50 GET status canceled with omitted fill count and PARTIAL fills stays pending: chunks are not completeness proof", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.includes(`/portfolio/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "canceled" } };
      }
      if (method === "GET" && path.includes("order_id=") && path.includes(exitRow.kalshiOrderId!)) {
        return { fills: [{ fill_id: "lag1", count_fp: "2.00", yes_price_dollars: "0.5000", created_time: "2026-08-16T12:05:00Z" }] };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "partial chunk page must not terminalize a canceled row");
    assert.equal(ex.posted.length, postedBefore, "no replacement while the canceled quantity is unproven");
  });
});

test("SOL_30_50 terminal cancel response without an explicit fill count fails closed; executed status infers full quantity", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 5;
    const realFetch = ex.fetch;

    // Case 1: DELETE says "canceled" but omits fill_count_fp entirely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "DELETE") {
        return { order: { order_id: path.split("/").pop(), status: "canceled" } };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    store.orders.get(exitRow.id)!.requestedContracts = 3;
    const postedBefore = ex.posted.length;

    await recoverSol30Targets(DATE);

    assert.equal(ex.posted.length, postedBefore, "no replacement on count-less canceled response");
    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "row stays pending (fail closed)");

    // Case 2: DELETE reports terminal "executed" without a count.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "DELETE") {
        return { order: { order_id: path.split("/").pop(), status: "executed" } };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);

    await recoverSol30Targets(DATE);

    const cancelledRow = store.orders.get(exitRow.id)!;
    assert.equal(cancelledRow.outcome, "cancelled");
    assert.equal(cancelledRow.filledContracts, 3, "executed without a count infers full requested quantity");
    const orders = await store.listSol30StrategyOrders(TICKER);
    assert.ok(computeSol30RestingExitQuantity(orders) <= computeSol30OwnedQuantity(orders), "never oversell");
  });
});

test("SOL_30_50 HTTP-success cancel with a non-terminal status is not trusted: no replacement is posted", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 4, 10);
    await recoverSol30Targets(DATE);
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 10;
    entry.fills = [chunk("f1", 4, 28, "2026-08-16T12:00:01Z"), chunk("f2", 6, 28, "2026-08-16T12:00:05Z")];
    const realFetch = ex.fetch;
    // DELETE succeeds at HTTP level but the exchange reports the order still resting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "DELETE") {
        const id = path.split("/").pop()!;
        return { order: { order_id: id, status: "resting", fill_count_fp: "0.00" } };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverSol30Targets(DATE);

    assert.equal(ex.posted.length, postedBefore, "no replacement while the original may still be resting");
    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "original target row stays pending, not marked cancelled");
    assert.equal(exits[0]!.requestedContracts, 4);
  });
});

test("SOL_30_50 lost target POST response marks the row unresolved and blocks any replacement", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "POST") throw new Error("socket hang up");
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);

    await recoverSol30Targets(DATE);

    const exitRows = [...store.orders.values()].filter((o) => o.role === "exit");
    assert.equal(exitRows.length, 1);
    assert.equal(exitRows[0]!.outcome, "unresolved", "ambiguous submit is not marked as terminal error");

    // Restore the healthy transport: recovery must still refuse to post a
    // replacement beside the unverifiable, possibly resting order.
    _setSol30KalshiFetchForTesting(realFetch as never);
    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    assert.equal(ex.posted.length, 0, "no replacement while an unresolved submission exists");
    assert.equal([...store.orders.values()].filter((o) => o.role === "exit").length, 1);
  });
});

test("SOL_30_50 successful target response without an order id is unresolved: no durable link, no replacement", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "POST") { ex.posted.push(body as Record<string, unknown>); return { order: { status: "resting" } }; }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);

    await recoverSol30Targets(DATE);
    const postedAfterFirst = ex.posted.length;
    assert.equal(postedAfterFirst, 1);
    const exitRows = [...store.orders.values()].filter((o) => o.role === "exit");
    assert.equal(exitRows.length, 1);
    assert.equal(exitRows[0]!.outcome, "unresolved");

    _setSol30KalshiFetchForTesting(realFetch as never);
    await recoverSol30Targets(DATE);

    assert.equal(ex.posted.length, postedAfterFirst, "no replacement beside an id-less unverified target");
  });
});

test("SOL_30_50 reconciliation touches only durably linked owned orders, never ticker/side queries", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 10);
    // An owned row that never got a kalshi_order_id must not trigger any lookup.
    await store.recordSol30StrategyOrder({
      id: `exit:${TICKER}:99`, ticker: TICKER, easternDate: DATE, role: "exit", sequenceNumber: 99,
      clientOrderId: "coid-unlinked", side: "yes", limitPriceCents: 50, requestedContracts: 3,
    });

    await reconcileSol30OwnedOrders(TICKER);

    for (const path of ex.requestedPaths) {
      assert.ok(!path.includes(TICKER), `no ticker-scoped exchange query: ${path}`);
      assert.ok(path.includes("ko-entry"), `only the durable order link is queried: ${path}`);
    }
    assert.ok(ex.requestedPaths.length > 0);
  });
});

test("SOL_30_50 corrupt fill chunks (missing fill_id) fail closed to order-status quantities", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 10);
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 7;
    // One chunk lacks fill_id — the whole chunk response must be discarded.
    entry.fills = [
      chunk("f1", 4, 28, "2026-08-16T12:00:01Z"),
      { ...chunk("f2", 3, 28, "2026-08-16T12:00:02Z"), fill_id: "" },
    ];

    await reconcileSol30OwnedOrders(TICKER);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.filledContracts, 7, "order-status count still applied");
    const events = await store.listSol30PositionEvents(TICKER);
    assert.ok(!events.some((e) => e.id.includes(":fid:")), "no partial chunk subset persisted");
    assert.equal(events.filter((e) => e.eventType === "entry_fill").reduce((s, e) => s + e.contractsDelta, 0), 7);
  });
});

test("SOL_30_50 re-running reconciliation is idempotent for chunk events and quantities", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 2, 10);
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 6;
    entry.fills = [chunk("f1", 2, 28, "2026-08-16T12:00:01Z"), chunk("f2", 4, 28, "2026-08-16T12:00:02Z")];

    await reconcileSol30OwnedOrders(TICKER);
    await reconcileSol30OwnedOrders(TICKER);
    await reconcileSol30OwnedOrders(TICKER);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.filledContracts, 6);
    const events = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "entry_fill");
    // ack event (2) + one incremental chunk event (4) — never re-appended.
    assert.equal(events.length, 2);
    assert.equal(events.reduce((s, e) => s + e.contractsDelta, 0), 6);
  });
});

// ── Settlement reconciliation tests ──────────────────────────────────────────

/**
 * Seed an entry with chunk evidence already on the exchange so
 * sol30SettlementReadiness passes without needing a separate reconcile call.
 */
async function seedEntryWithChunks(
  store: MemStore, ex: FakeExchange,
  filled: number, requested: number,
): Promise<void> {
  await seedEntry(store, ex, filled, requested);
  const entry = ex.orders.get("ko-entry")!;
  entry.status = filled === requested ? "filled" : "resting";
  entry.fills = [chunk("f1", filled, 28, "2026-08-16T12:00:01Z")];
}

test("SOL_30_50 settlement appends one idempotent event that zeros the position when the target never hit", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 5, 5);
    await recoverSol30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    assert.ok(exitRow, "a resting target must be pending");

    ex.markets.set(TICKER, { result: "yes" });

    await reconcileSol30Settlements();

    const allEvents = await store.listSol30PositionEvents(TICKER);
    const settlements = allEvents.filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.settlementResult, "yes");
    assert.equal(settlements[0]!.contractsAfter, 0);
    assert.equal(settlements[0]!.contractsDelta, -5);

    const exitAfter = store.orders.get(exitRow.id)!;
    assert.equal(exitAfter.outcome, "cancelled", "settled target must be marked terminal");

    await reconcileSol30Settlements();
    const settlementsAfter = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlementsAfter.length, 1, "settlement event is idempotent");
  });
});

test("SOL_30_50 settlement with result=no also appends a valid event and closes the position", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 3, 3);
    ex.markets.set(TICKER, { result: "no" });

    await reconcileSol30Settlements();

    const settlements = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.settlementResult, "no");
    assert.equal(settlements[0]!.contractsAfter, 0);
    assert.equal(settlements[0]!.contractsDelta, -3);
  });
});

test("SOL_30_50 settlement is skipped for an unsettled market (result not yes/no)", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 4, 4);
    ex.markets.set(TICKER, { result: null });

    await reconcileSol30Settlements();

    const settlements = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 0, "no settlement event while market is open");
  });
});

test("SOL_30_50 settlement delta reflects only unsold contracts when some were already sold", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 6, 6);
    await recoverSol30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 2;
    exchangeExit.fills = [chunk("x1", 2, 50, "2026-08-16T12:05:00Z")];
    ex.markets.set(TICKER, { result: "yes" });

    await reconcileSol30Settlements();

    const allEvents = await store.listSol30PositionEvents(TICKER);
    const settlement = allEvents.find((e) => e.eventType === "settlement")!;
    assert.ok(settlement, "settlement event must exist");
    assert.equal(settlement.contractsDelta, -4, "only the 4 unsold contracts close at settlement");
    assert.equal(settlement.contractsAfter, 0);

    const exitAfter = store.orders.get(exitRow.id)!;
    assert.equal(exitAfter.outcome, "cancelled");
  });
});

test("SOL_30_50 settlement is deferred when fill chunk evidence is incomplete", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    ex.markets.set(TICKER, { result: "yes" });

    await reconcileSol30Settlements();

    const settlements = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 0, "settlement must be deferred until chunk evidence is complete");
  });
});

test("SOL_30_50 settlement is skipped when there are no entry fills", async () => {
  await withHarness(async (store, ex) => {
    await store.claimSol30Ticker(TICKER, DATE, "coid-zero");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-zero", side: "yes", limitPriceCents: 28, requestedContracts: 5,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 0,
      averageFillPriceCents: null, outcome: "zero_fill",
    });
    ex.orders.set("ko-entry", { status: "filled", fillCount: 0, fills: [] });
    ex.markets.set(TICKER, { result: "yes" });

    await reconcileSol30Settlements();

    const settlements = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 0, "no settlement event when nothing was ever bought");
  });
});

test("SOL_30_50 settlement sweep continues to the next ticker when the market-status fetch throws for the first ticker", async () => {
  await withHarness(async (store, ex) => {
    const TICKER_A = "KXSOL15M-26AUG161200-15";
    const TICKER_B = "KXSOL15M-26AUG161200-30";

    await store.claimSol30Ticker(TICKER_A, DATE, "coid-a");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER_A}`, ticker: TICKER_A, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-a", side: "yes", limitPriceCents: 28, requestedContracts: 4,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER_A}`, kalshiOrderId: "ko-entry-a", filledContracts: 4,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    await store.appendSol30PositionEvent({
      id: `${TICKER_A}:entry_fill:coid-a`, ticker: TICKER_A, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: 4, contractsAfter: 4, strategyOrderId: `entry:${TICKER_A}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-entry-a", { status: "filled", fillCount: 4, fills: [chunk("fa1", 4, 28, "2026-08-16T12:00:01Z")] });

    await store.claimSol30Ticker(TICKER_B, DATE, "coid-b");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER_B}`, ticker: TICKER_B, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-b", side: "yes", limitPriceCents: 28, requestedContracts: 3,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER_B}`, kalshiOrderId: "ko-entry-b", filledContracts: 3,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    await store.appendSol30PositionEvent({
      id: `${TICKER_B}:entry_fill:coid-b`, ticker: TICKER_B, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: 3, contractsAfter: 3, strategyOrderId: `entry:${TICKER_B}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-entry-b", { status: "filled", fillCount: 3, fills: [chunk("fb1", 3, 28, "2026-08-16T12:00:02Z")] });
    ex.markets.set(TICKER_B, { result: "yes" });

    const baseExFetch = ex.fetch;
    _setSol30KalshiFetchForTesting((async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === `/markets/${encodeURIComponent(TICKER_A)}`) {
        throw new Error("simulated market-status API failure for TICKER_A");
      }
      return baseExFetch(method, path, body);
    }) as never);

    await reconcileSol30Settlements();

    const aEvents = (await store.listSol30PositionEvents(TICKER_A)).filter((e) => e.eventType === "settlement");
    assert.equal(aEvents.length, 0, "no settlement event for the ticker whose market-status fetch threw");

    const bEvents = (await store.listSol30PositionEvents(TICKER_B)).filter((e) => e.eventType === "settlement");
    assert.equal(bEvents.length, 1, "settlement event written for the second ticker after the first threw");
    assert.equal(bEvents[0]!.settlementResult, "yes");
    assert.equal(bEvents[0]!.contractsAfter, 0);
    assert.equal(bEvents[0]!.contractsDelta, -3);
  });
});

test("SOL_30_50 reconcileSol30Settlements backfills fee_cents for already-settled tickers with null fees", async () => {
  await withHarness(async (store, ex) => {
    const CHUNK_NOTE = "exchange_fill_chunk";

    await store.claimSol30Ticker(TICKER, DATE, "coid-entry");
    await store.recordSol30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
      sequenceNumber: 0, clientOrderId: "coid-entry", side: "yes", limitPriceCents: 28,
      requestedContracts: 5,
    });
    await store.updateSol30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 5,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    // Pre-existing canonical chunk event — feeCents is null (pre-column row).
    await store.appendSol30PositionEvent({
      id: `${TICKER}:entry_fill:f1`, ticker: TICKER, easternDate: DATE,
      eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 28, feeCents: null,
      settlementResult: null, note: CHUNK_NOTE, occurredAtMs: 100,
    });
    await store.appendSol30PositionEvent({
      id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE,
      eventType: "settlement", contractsDelta: -5, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes", note: null, occurredAtMs: 200,
    });

    ex.orders.set("ko-entry", {
      status: "filled", fillCount: 5,
      fills: [{ ...chunk("f1", 5, 28, "2026-08-16T12:00:01Z"), fee_cost_dollars: "0.0200" }],
    });

    await reconcileSol30Settlements();

    const events = await store.listSol30PositionEvents(TICKER);
    const fillChunk = events.find((e) => e.id === `${TICKER}:entry_fill:f1`);
    assert.ok(fillChunk, "canonical fill-chunk event still present");
    assert.equal(fillChunk!.feeCents, 2, "fee_cents backfilled: 2¢ from 0.0200 dollars");

    const settlement = events.find((e) => e.eventType === "settlement");
    assert.ok(settlement, "settlement event preserved");
    assert.equal(settlement!.settlementResult, "yes");
    assert.equal(events.filter((e) => e.eventType === "settlement").length, 1);
  });
});

// ── Periodic reconciliation sweep tests ──────────────────────────────────────

test("SOL_30_50 mid-session target fill is reflected in ownership and P&L after one periodic sweep tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverSol30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    assert.ok(exitRow, "a resting 50¢ target must be pending before the sweep");

    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 5;
    exchangeExit.status = "filled";
    exchangeExit.fills = [chunk("x1", 5, 50, "2026-08-16T12:10:00Z")];

    assert.equal(
      (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill").length,
      0,
      "no exit_fill event in the ledger before the sweep",
    );

    const stop = startSol30PeriodicReconciliation();
    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();

    const exitRowAfter = store.orders.get(exitRow.id)!;
    assert.equal(exitRowAfter.filledContracts, 5, "exit filledContracts updated by the periodic sweep");
    assert.equal(exitRowAfter.outcome, "full_fill", "exit row terminalized after a complete mid-session fill");

    const allEvents = await store.listSol30PositionEvents(TICKER);
    const exitFills = allEvents.filter((e) => e.eventType === "exit_fill");
    assert.ok(exitFills.length > 0, "exit_fill event must be appended by the periodic sweep");
    assert.equal(
      exitFills.reduce((s, e) => s + e.contractsDelta, 0),
      -5,
      "total exit_fill delta must account for all 5 sold contracts",
    );

    const orders = await store.listSol30StrategyOrders(TICKER);
    assert.equal(computeSol30OwnedQuantity(orders), 0, "no contracts remain after a complete exit fill");

    const report = await buildSol30Report();
    const tickerReport = report.tickers.find((t) => t.ticker === TICKER);
    assert.ok(tickerReport, "the filled ticker must appear in the SOL 30–50 report");
    assert.equal(tickerReport!.status, "closed");
    assert.equal(tickerReport!.realizedPnlCents, 110);
    assert.equal(report.summary.realizedPnlCents, 110);
  });
});

// ── Cross-day boundary helpers ────────────────────────────────────────────────

async function seedPriorDayEntry(
  store: ReturnType<typeof memStore>,
  ex: FakeExchange,
  claimDate: string,
  entryFillTime: string,
): Promise<void> {
  await store.claimSol30Ticker(TICKER, claimDate, "coid-entry-yd");
  await store.recordSol30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: claimDate, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry-yd", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  ex.orders.set("ko-entry", {
    status: "filled", fillCount: 5,
    fills: [chunk("f1", 5, 28, entryFillTime)],
  });
  await store.appendSol30PositionEvent({
    id: `${TICKER}:entry_fill:f1`, ticker: TICKER, easternDate: claimDate,
    eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
    strategyOrderId: `entry:${TICKER}`, fillPriceCents: 28, feeCents: null,
    settlementResult: null, note: "exchange_fill_chunk", occurredAtMs: 100,
  });
  await store.recordSol30StrategyOrder({
    id: `exit:${TICKER}:0`, ticker: TICKER, easternDate: claimDate, role: "exit",
    sequenceNumber: 0, clientOrderId: "coid-exit-yd", side: "yes", limitPriceCents: 50,
    requestedContracts: 5,
  });
  await store.updateSol30StrategyOrder({
    id: `exit:${TICKER}:0`, kalshiOrderId: "ko-exit", filledContracts: null,
    outcome: "pending",
  });
  ex.orders.set("ko-exit", { status: "resting", fillCount: 0, fills: [] });
}

async function assertCrossDaySweepReconciles(
  store: ReturnType<typeof memStore>,
  ex: FakeExchange,
  t: TestContext,
  exitFillTime: string,
): Promise<void> {
  const exchangeExit = ex.orders.get("ko-exit")!;
  exchangeExit.status = "filled";
  exchangeExit.fillCount = 5;
  exchangeExit.fills = [chunk("x1", 5, 50, exitFillTime)];

  assert.equal(
    (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill").length,
    0,
    "no exit_fill event before the sweep fires",
  );

  const stop = startSol30PeriodicReconciliation();
  t.mock.timers.tick(5 * 60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  stop();

  const exitRow = store.orders.get(`exit:${TICKER}:0`)!;
  assert.equal(exitRow.filledContracts, 5, "exit filledContracts updated by the cross-day sweep");
  assert.equal(exitRow.outcome, "full_fill", "exit row terminalized by the cross-day sweep");

  const exitFills = (await store.listSol30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill");
  assert.ok(exitFills.length > 0, "exit_fill event must be appended for a cross-day GTC fill");
  assert.equal(
    exitFills.reduce((s, e) => s + e.contractsDelta, 0),
    -5,
    "total exit_fill delta accounts for all 5 sold contracts",
  );

  const orders = await store.listSol30StrategyOrders(TICKER);
  assert.equal(computeSol30OwnedQuantity(orders), 0, "no contracts remain after a cross-day exit fill");
}

test("SOL_30_50 periodic sweep reconciles a position claimed on the previous Eastern date after midnight", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  _setSol30NowForTesting(() => new Date("2026-08-16T04:10:00Z"));
  try {
    const CLAIM_DATE = "2026-08-15";
    const TODAY_IN_TEST = "2026-08-16";
    assert.notEqual(CLAIM_DATE, TODAY_IN_TEST);

    await withHarness(async (store, ex) => {
      await seedPriorDayEntry(store, ex, CLAIM_DATE, "2026-08-15T23:55:00Z");
      await assertCrossDaySweepReconciles(store, ex, t, "2026-08-16T00:10:00Z");
    });
  } finally {
    _setSol30NowForTesting(null);
  }
});

test("SOL_30_50 periodic sweep reconciles a prior-day position at the spring-forward DST boundary", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  _setSol30NowForTesting(() => new Date("2025-03-10T04:30:00Z"));
  try {
    const CLAIM_DATE = "2025-03-09";
    await withHarness(async (store, ex) => {
      await seedPriorDayEntry(store, ex, CLAIM_DATE, "2025-03-09T23:55:00Z");
      await assertCrossDaySweepReconciles(store, ex, t, "2025-03-10T04:15:00Z");
    });
  } finally {
    _setSol30NowForTesting(null);
  }
});

test("SOL_30_50 periodic reconcile sweep recovers and runs again after a transient DB error", async () => {
  let claimListCalls = 0;

  const store = memStore();
  const ex = fakeExchange();

  const originalListForDates = store.listSol30TickerClaimsForDates.bind(store);
  store.listSol30TickerClaimsForDates = async (dates: string[]) => {
    claimListCalls++;
    if (claimListCalls === 1) throw new Error("simulated DB outage");
    return originalListForDates(dates);
  };

  await store.claimSol30Ticker(TICKER, DATE, "coid-entry");
  await store.recordSol30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  ex.orders.set("ko-entry", {
    status: "filled", fillCount: 5,
    fills: [chunk("f1", 5, 28, "2026-08-16T12:00:01Z")],
  });

  const prevEnabled = process.env["SOL_30_50_ENABLED"];
  process.env["SOL_30_50_ENABLED"] = "true";
  _setSol30NowForTesting(() => new Date("2026-08-16T14:00:00Z"));
  _setSol30StoreForTesting(store);
  _setSol30KalshiFetchForTesting(ex.fetch as never);
  try {
    await _runSol30PeriodicReconcileSweepForTesting();
    assert.equal(claimListCalls, 1, "first sweep must have attempted listSol30TickerClaimsForDates");

    await _runSol30PeriodicReconcileSweepForTesting();
    assert.equal(claimListCalls, 2, "second sweep must proceed past the in-flight guard");

    const events = await store.listSol30PositionEvents(TICKER);
    const fillEvents = events.filter((e) => e.eventType === "entry_fill");
    assert.equal(fillEvents.length, 1, "entry_fill event must be written by the second sweep after recovery");
  } finally {
    _setSol30NowForTesting(null);
    _setSol30StoreForTesting(null);
    _setSol30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["SOL_30_50_ENABLED"];
    else process.env["SOL_30_50_ENABLED"] = prevEnabled;
  }
});

test("SOL_30_50 periodic reconcile sweep skips settled tickers — no exchange queries for a settled position", async () => {
  const store = memStore();
  const ex = fakeExchange();

  await store.claimSol30Ticker(TICKER, DATE, "coid-settled");
  await store.recordSol30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-settled", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry-settled", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  await store.recordSol30StrategyOrder({
    id: `exit:${TICKER}:1`, ticker: TICKER, easternDate: DATE, role: "exit",
    sequenceNumber: 1, clientOrderId: "coid-exit-settled", side: "yes", limitPriceCents: 50,
    requestedContracts: 5,
  });
  await store.updateSol30StrategyOrder({
    id: `exit:${TICKER}:1`, kalshiOrderId: "ko-exit-settled", filledContracts: 5,
    averageFillPriceCents: 50, outcome: "full_fill",
  });
  await store.appendSol30PositionEvent({
    id: `${TICKER}:entry_fill:f1`, ticker: TICKER, easternDate: DATE,
    eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
    strategyOrderId: `entry:${TICKER}`, fillPriceCents: 28, feeCents: null,
    settlementResult: null, note: "exchange_fill_chunk", occurredAtMs: 100,
  });
  await store.appendSol30PositionEvent({
    id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE,
    eventType: "settlement", contractsDelta: -5, contractsAfter: 0,
    strategyOrderId: null, fillPriceCents: null, feeCents: null,
    settlementResult: "yes",
    note: "market settled yes; 5 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  ex.orders.set("ko-entry-settled", { status: "filled", fillCount: 5, fills: [] });
  ex.orders.set("ko-exit-settled", { status: "filled", fillCount: 5, fills: [] });

  const prevEnabled = process.env["SOL_30_50_ENABLED"];
  process.env["SOL_30_50_ENABLED"] = "true";
  _setSol30NowForTesting(() => new Date("2026-08-16T14:00:00Z"));
  _setSol30StoreForTesting(store);
  _setSol30KalshiFetchForTesting(ex.fetch as never);
  try {
    await _runSol30PeriodicReconcileSweepForTesting();

    assert.equal(
      ex.requestedPaths.filter((p) => p.includes("ko-entry-settled") || p.includes("ko-exit-settled")).length,
      0,
      "no exchange queries for a settled ticker during a periodic sweep tick",
    );
  } finally {
    _setSol30NowForTesting(null);
    _setSol30StoreForTesting(null);
    _setSol30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["SOL_30_50_ENABLED"];
    else process.env["SOL_30_50_ENABLED"] = prevEnabled;
  }
});

// ── Settled-ticker cache warmup ────────────────────────────────────────────────

test("SOL_30_50 warmSol30SettledTickersCache pre-populates the cache so the first sweep issues zero listSol30PositionEvents calls for settled tickers", async () => {
  const SETTLED_TICKER = "KXSOL15M-26AUG161200-15";
  const UNSETTLED_TICKER = "KXSOL15M-26AUG161200-20";
  const SWEEP_DATE = "2026-08-16";

  const store = memStore();
  const ex = fakeExchange();

  await store.claimSol30Ticker(SETTLED_TICKER, SWEEP_DATE, "coid-settled");
  await store.recordSol30StrategyOrder({
    id: `entry:${SETTLED_TICKER}`, ticker: SETTLED_TICKER, easternDate: SWEEP_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-settled",
    side: "yes", limitPriceCents: 28, requestedContracts: 4,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${SETTLED_TICKER}`, kalshiOrderId: "ko-settled", filledContracts: 4,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  await store.appendSol30PositionEvent({
    id: `${SETTLED_TICKER}:entry_fill:ko-settled:f1`, ticker: SETTLED_TICKER,
    easternDate: SWEEP_DATE, eventType: "entry_fill",
    contractsDelta: 4, contractsAfter: 4,
    strategyOrderId: `entry:${SETTLED_TICKER}`, fillPriceCents: 28,
    feeCents: 0, settlementResult: null, note: null, occurredAtMs: 100,
  });
  await store.appendSol30PositionEvent({
    id: `${SETTLED_TICKER}:settlement`, ticker: SETTLED_TICKER,
    easternDate: SWEEP_DATE, eventType: "settlement",
    contractsDelta: -4, contractsAfter: 0, strategyOrderId: null,
    fillPriceCents: null, feeCents: null, settlementResult: "yes",
    note: "market settled yes; 4 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  ex.orders.set("ko-settled", { status: "filled", fillCount: 4, fills: [] });

  await store.claimSol30Ticker(UNSETTLED_TICKER, SWEEP_DATE, "coid-open");
  await store.recordSol30StrategyOrder({
    id: `entry:${UNSETTLED_TICKER}`, ticker: UNSETTLED_TICKER, easternDate: SWEEP_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-open",
    side: "yes", limitPriceCents: 28, requestedContracts: 3,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${UNSETTLED_TICKER}`, kalshiOrderId: "ko-open", filledContracts: 3,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  await store.appendSol30PositionEvent({
    id: `${UNSETTLED_TICKER}:entry_fill:ko-open:f1`, ticker: UNSETTLED_TICKER,
    easternDate: SWEEP_DATE, eventType: "entry_fill",
    contractsDelta: 3, contractsAfter: 3,
    strategyOrderId: `entry:${UNSETTLED_TICKER}`, fillPriceCents: 28,
    feeCents: 0, settlementResult: null, note: null, occurredAtMs: 150,
  });
  ex.orders.set("ko-open", { status: "filled", fillCount: 3, fills: [
    chunk("f-open-1", 3, 28, "2026-08-16T12:00:02Z"),
  ]});
  ex.markets.set(UNSETTLED_TICKER, { result: null });

  const prevEnabled = process.env["SOL_30_50_ENABLED"];
  process.env["SOL_30_50_ENABLED"] = "true";
  _setSol30NowForTesting(() => new Date("2026-08-16T14:00:00Z"));
  _setSol30StoreForTesting(store);
  _setSol30KalshiFetchForTesting(ex.fetch as never);

  try {
    await warmSol30SettledTickersCache();

    const positionEventCalls: string[] = [];
    const baseListEvents = store.listSol30PositionEvents.bind(store);
    store.listSol30PositionEvents = async (ticker: string) => {
      positionEventCalls.push(ticker);
      return baseListEvents(ticker);
    };

    await _runSol30PeriodicReconcileSweepForTesting();

    assert.equal(
      positionEventCalls.filter((t) => t === SETTLED_TICKER).length, 0,
      "first post-restart sweep must not call listSol30PositionEvents for a settled ticker whose cache was warmed at startup",
    );
    assert.ok(
      positionEventCalls.includes(UNSETTLED_TICKER),
      "sweep must still call listSol30PositionEvents for unsettled tickers",
    );

    const secondSweepCalls: string[] = [];
    store.listSol30PositionEvents = async (ticker: string) => {
      secondSweepCalls.push(ticker);
      return baseListEvents(ticker);
    };
    await _runSol30PeriodicReconcileSweepForTesting();
    assert.equal(
      secondSweepCalls.filter((t) => t === SETTLED_TICKER).length, 0,
      "second sweep must also skip listSol30PositionEvents for the settled ticker",
    );
  } finally {
    _setSol30NowForTesting(null);
    _setSol30StoreForTesting(null);
    _setSol30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["SOL_30_50_ENABLED"];
    else process.env["SOL_30_50_ENABLED"] = prevEnabled;
  }
});

test("SOL_30_50 checkStaleSol30Claims skips a settled ticker without calling listSol30PositionEvents", async () => {
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;
  await withHarness(async (store) => {
    const nowMs = Date.now();
    const claimedAtMs = nowMs - STALE_THRESHOLD_MS - 60_000;

    store.claims.set(TICKER, { ticker: TICKER, easternDate: DATE, claimedAtMs, entryClientOrderId: "coid-settled" });

    await store.appendSol30PositionEvent({
      id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE,
      eventType: "settlement", contractsDelta: -5, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes",
      note: "market settled yes; 5 owned contracts closed at settlement",
      occurredAtMs: claimedAtMs + 1_000,
    });

    await warmSol30SettledTickersCache();
    assert.ok(_settledTickersForTesting().has(TICKER), "TICKER must be in the settled cache after warmup");

    let positionEventCallCount = 0;
    const baseListEvents = store.listSol30PositionEvents.bind(store);
    store.listSol30PositionEvents = async (ticker: string) => {
      if (ticker === TICKER) positionEventCallCount++;
      return baseListEvents(ticker);
    };

    const stale = await checkStaleSol30Claims(nowMs);

    assert.equal(stale.includes(TICKER), false, "settled ticker must not be reported as stale");
    assert.equal(positionEventCallCount, 0,
      "listSol30PositionEvents must not be called for a settled ticker when the cache is warm");
  });
});

test("SOL_30_50 checkStaleSol30Claims still flags an unsettled stale ticker when a settled one is skipped", async () => {
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;
  const SETTLED = "KXSOL15M-26AUG161200-15";
  const STALE   = "KXSOL15M-26AUG161200-20";
  await withHarness(async (store) => {
    const nowMs = Date.now();
    const claimedAtMs = nowMs - STALE_THRESHOLD_MS - 60_000;

    store.claims.set(SETTLED, { ticker: SETTLED, easternDate: DATE, claimedAtMs, entryClientOrderId: "coid-settled" });
    await store.appendSol30PositionEvent({
      id: `${SETTLED}:settlement`, ticker: SETTLED, easternDate: DATE,
      eventType: "settlement", contractsDelta: -3, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes", note: "market settled yes", occurredAtMs: claimedAtMs + 1_000,
    });

    store.claims.set(STALE, { ticker: STALE, easternDate: DATE, claimedAtMs, entryClientOrderId: "coid-stale" });

    await warmSol30SettledTickersCache();
    assert.ok(_settledTickersForTesting().has(SETTLED));
    assert.equal(_settledTickersForTesting().has(STALE), false);

    const stale = await checkStaleSol30Claims(nowMs);

    assert.equal(stale.includes(SETTLED), false, "settled ticker must not be reported as stale");
    assert.ok(stale.includes(STALE), "zero-fill unsettled ticker must be reported as stale");
  });
});

test("SOL_30_50 startSol30PeriodicReconciliation warms the settled-ticker cache even when SOL_30_50_ENABLED is off", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const SETTLED = "KXSOL15M-26AUG161200-15";
  const SETTLED_DATE = "2026-08-16";

  const store = memStore();
  const ex = fakeExchange();

  await store.claimSol30Ticker(SETTLED, SETTLED_DATE, "coid-warm-off");
  await store.recordSol30StrategyOrder({
    id: `entry:${SETTLED}`, ticker: SETTLED, easternDate: SETTLED_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-warm-off",
    side: "yes", limitPriceCents: 28, requestedContracts: 4,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${SETTLED}`, kalshiOrderId: "ko-warm-off", filledContracts: 4,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  await store.appendSol30PositionEvent({
    id: `${SETTLED}:entry_fill:ko-warm-off:f1`, ticker: SETTLED, easternDate: SETTLED_DATE,
    eventType: "entry_fill", contractsDelta: 4, contractsAfter: 4,
    strategyOrderId: `entry:${SETTLED}`, fillPriceCents: 28,
    feeCents: 0, settlementResult: null, note: null, occurredAtMs: 100,
  });
  await store.appendSol30PositionEvent({
    id: `${SETTLED}:settlement`, ticker: SETTLED, easternDate: SETTLED_DATE,
    eventType: "settlement", contractsDelta: -4, contractsAfter: 0,
    strategyOrderId: null, fillPriceCents: null, feeCents: null, settlementResult: "yes",
    note: "market settled yes; 4 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  ex.orders.set("ko-warm-off", { status: "filled", fillCount: 4, fills: [] });
  ex.markets.set(SETTLED, { result: "yes" });

  const prevEnabled = process.env["SOL_30_50_ENABLED"];
  process.env["SOL_30_50_ENABLED"] = "false";

  _setSol30NowForTesting(() => new Date("2026-08-16T14:00:00Z"));
  _setSol30StoreForTesting(store);
  _setSol30KalshiFetchForTesting(ex.fetch as never);

  try {
    let listSettledCallCount = 0;
    const baseListSettled = store.listSettledSol30Tickers.bind(store);
    store.listSettledSol30Tickers = async () => {
      listSettledCallCount++;
      return baseListSettled();
    };

    const stop = startSol30PeriodicReconciliation();

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      listSettledCallCount, 1,
      "startSol30PeriodicReconciliation must call listSettledSol30Tickers once during initialisation even when SOL_30_50_ENABLED is not 'true'",
    );

    const positionEventCalls: string[] = [];
    const baseListEvents = store.listSol30PositionEvents.bind(store);
    store.listSol30PositionEvents = async (ticker: string) => {
      positionEventCalls.push(ticker);
      return baseListEvents(ticker);
    };

    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();

    assert.equal(
      positionEventCalls.filter((ticker) => ticker === SETTLED).length, 0,
      "the first sweep must not call listSol30PositionEvents for a ticker that was already settled",
    );
  } finally {
    _setSol30NowForTesting(null);
    _setSol30StoreForTesting(null);
    _setSol30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["SOL_30_50_ENABLED"];
    else process.env["SOL_30_50_ENABLED"] = prevEnabled;
  }
});

test("SOL_30_50 warmup-failure: when listSettledSol30Tickers throws, warmSol30SettledTickersCache never throws and the sweep falls back to per-ticker SQL reads", async () => {
  const SETTLED_TICKER2 = "KXSOL15M-26AUG161200-15";
  const WARMUP_DATE = "2026-08-16";

  const store = memStore();
  const ex = fakeExchange();

  await store.claimSol30Ticker(SETTLED_TICKER2, WARMUP_DATE, "coid-ws");
  await store.recordSol30StrategyOrder({
    id: `entry:${SETTLED_TICKER2}`, ticker: SETTLED_TICKER2, easternDate: WARMUP_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-ws",
    side: "yes", limitPriceCents: 28, requestedContracts: 4,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${SETTLED_TICKER2}`, kalshiOrderId: "ko-ws", filledContracts: 4,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  await store.appendSol30PositionEvent({
    id: `${SETTLED_TICKER2}:settlement`, ticker: SETTLED_TICKER2, easternDate: WARMUP_DATE,
    eventType: "settlement", contractsDelta: -4, contractsAfter: 0, strategyOrderId: null,
    fillPriceCents: null, feeCents: null, settlementResult: "yes",
    note: "market settled yes; 4 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  ex.orders.set("ko-ws", { status: "filled", fillCount: 4, fills: [] });
  ex.markets.set(SETTLED_TICKER2, { result: "yes" });

  const prevEnabled = process.env["SOL_30_50_ENABLED"];
  process.env["SOL_30_50_ENABLED"] = "true";
  _setSol30NowForTesting(() => new Date("2026-08-16T14:00:00Z"));
  _setSol30StoreForTesting(store);
  _setSol30KalshiFetchForTesting(ex.fetch as never);

  try {
    const baseListSettled = store.listSettledSol30Tickers.bind(store);
    store.listSettledSol30Tickers = async () => {
      throw new Error("simulated DB error during warmup query");
    };

    await assert.doesNotReject(
      () => warmSol30SettledTickersCache(),
      "warmSol30SettledTickersCache must never throw even when the underlying query fails",
    );

    store.listSettledSol30Tickers = baseListSettled;

    let positionEventCallCount = 0;
    const baseListEvents = store.listSol30PositionEvents.bind(store);
    store.listSol30PositionEvents = async (ticker: string) => {
      if (ticker === SETTLED_TICKER2) positionEventCallCount++;
      return baseListEvents(ticker);
    };

    await _runSol30PeriodicReconcileSweepForTesting();

    assert.ok(
      positionEventCallCount >= 1,
      "with a cold cache, the sweep must still call listSol30PositionEvents as a fallback for the settled ticker",
    );

    const events = await baseListEvents(SETTLED_TICKER2);
    const settlements = events.filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1, "settled ticker must have exactly one settlement event after the sweep");
  } finally {
    _setSol30NowForTesting(null);
    _setSol30StoreForTesting(null);
    _setSol30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["SOL_30_50_ENABLED"];
    else process.env["SOL_30_50_ENABLED"] = prevEnabled;
  }
});

// ── Unresolved entry (IOC POST transport failure / id-less response) ─────────

test("SOL_30_50 entry IOC transport failure marks entry unresolved (not error) — permanent claim without a position", async () => {
  await withHarness(async (store, ex) => {
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/portfolio/events/orders") {
        throw new Error("socket hang up");
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    _setSol30OrderbookCaptureForTesting(async () => ({
      error: null, lowestLevelCents: 28, depthAtOrBetterContracts: 10,
    } as unknown as import("../orderbookCapture.js").OrderbookSnapshot));

    const ticker = "KXSOL15M-26AUG161200-15";
    const state = { ticker, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() };
    await evaluateSol30(state);

    // A claim must exist — the ticker is permanently claimed
    assert.equal(store.claims.size, 1, "claim written before the transport failure");
    const entryRow = store.orders.get(`entry:${ticker}`);
    assert.ok(entryRow, "entry order row must be written");
    assert.equal(entryRow!.outcome, "unresolved", "transport failure must produce unresolved, not error");
    assert.equal(entryRow!.kalshiOrderId, null, "no exchange order id on a transport failure");
    assert.equal(entryRow!.filledContracts, null, "fill count unknown after transport failure");

    // A second evaluateSol30 call must not re-enter (the claim blocks it)
    await evaluateSol30(state);
    assert.equal(store.orders.size, 1, "no second entry order — the claim prevents re-entry");
  });
});

test("SOL_30_50 entry IOC id-less success response marks entry unresolved — no position assumed", async () => {
  await withHarness(async (store, ex) => {
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/portfolio/events/orders") {
        ex.posted.push(body as Record<string, unknown>);
        // Accepted-looking response with no order_id
        return { order: { status: "resting", fill_count_fp: "0.00" } };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);
    _setSol30OrderbookCaptureForTesting(async () => ({
      error: null, lowestLevelCents: 28, depthAtOrBetterContracts: 10,
    } as unknown as import("../orderbookCapture.js").OrderbookSnapshot));

    const ticker = "KXSOL15M-26AUG161200-15";
    const state = { ticker, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() };
    await evaluateSol30(state);

    assert.equal(store.claims.size, 1, "claim written");
    const entryRow = store.orders.get(`entry:${ticker}`);
    assert.ok(entryRow, "entry order row must be written");
    assert.equal(entryRow!.outcome, "unresolved", "id-less response must produce unresolved, not zero_fill");
    assert.equal(entryRow!.kalshiOrderId, null, "no exchange order id in id-less response");

    // A second evaluateSol30 call must not re-enter
    await evaluateSol30(state);
    assert.equal(store.orders.size, 1, "no second entry order — the claim prevents re-entry");
  });
});

// ── Helpers for unresolved-entry V2 lookup tests ─────────────────────────────

/** Seed a ticker with an unresolved entry (no kalshiOrderId, no fills). */
async function seedUnresolvedEntry(
  store: MemStore,
  clientOrderId: string,
  requested = 10,
  side: "yes" | "no" = "yes",
): Promise<void> {
  await store.claimSol30Ticker(TICKER, DATE, clientOrderId);
  await store.recordSol30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0,
    clientOrderId, side, limitPriceCents: 28, requestedContracts: requested,
  });
  await store.updateSol30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: null, filledContracts: null,
    averageFillPriceCents: null, outcome: "unresolved",
  });
}

/**
 * Wire the fake exchange to answer Step 1 (GET /portfolio/fills?ticker=...) and
 * Step 2 (GET /portfolio/orders/{id}) for the V2 unresolved-entry lookup.
 *
 * @param ex          - fake exchange whose fetch will be replaced
 * @param fillsPage   - fills to return for the ticker filter (empty array = no fills found)
 * @param orderDetail - optional: overrides the GET /portfolio/orders/{id} response
 *                      (defaults to the fake exchange's in-memory orders map)
 */
function wireV2Lookup(
  ex: FakeExchange,
  fillsPage: Array<Record<string, unknown>>,
  orderDetail?: Record<string, unknown>,
): void {
  const realFetch = ex.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ex.fetch = (async (method: string, path: string, body?: unknown) => {
    // Step 1: fills filtered by ticker
    if (method === "GET" && path.startsWith("/portfolio/fills?") && path.includes("ticker=")) {
      return { fills: fillsPage };
    }
    // Step 2: single-order detail (if caller supplied an override)
    if (orderDetail && method === "GET" && /^\/portfolio\/orders\/[^/?]+$/.test(path)) {
      return { order: orderDetail };
    }
    return realFetch(method, path, body);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  _setSol30KalshiFetchForTesting(ex.fetch as never);
}

// ── Unresolved-entry V2 lookup: happy-path and fail-closed tests ──────────────

test("SOL_30_50 unresolved entry: restart recovery lookup finds the order filled — reconciles chunks and places 50c target", async () => {
  await withHarness(async (store, ex) => {
    // Simulate an unresolved entry row: transport failure occurred, the IOC was
    // actually accepted and filled 5 contracts, but we have no kalshi_order_id.
    const clientOrderId = "coid-unresolved-entry";
    await seedUnresolvedEntry(store, clientOrderId);

    // The exchange has the order under "ko-recovered"; it filled 5 contracts.
    ex.orders.set("ko-recovered", {
      status: "filled", fillCount: 5,
      fills: [chunk("fr1", 3, 28, "2026-08-16T12:00:01Z"), chunk("fr2", 2, 28, "2026-08-16T12:00:02Z")],
    });

    // Step 1: fills endpoint returns one buy fill with our order_id for the exact ticker.
    // Step 2: order detail includes client_order_id matching our durable value.
    wireV2Lookup(
      ex,
      [{ order_id: "ko-recovered", market_ticker: TICKER, action: "buy" }],
      { order_id: "ko-recovered", client_order_id: clientOrderId, ticker: TICKER,
        status: "filled", fill_count_fp: "5.00" },
    );

    await recoverSol30Targets(DATE);

    // Entry row must now be linked and filled.
    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.kalshiOrderId, "ko-recovered", "order id linked after recovery lookup");
    assert.equal(entryRow.filledContracts, 5, "fill count resolved from exchange");
    assert.notEqual(entryRow.outcome, "unresolved", "entry is no longer unresolved");

    // A 50c target must be placed for the filled quantity.
    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "one resting 50c target placed after recovery");
    assert.equal(exits[0]!.requestedContracts, 5, "target sized to recovered fill count");
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted.length, 1, "exactly one GTC exit posted");
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");
  });
});

test("SOL_30_50 unresolved entry: no buy fills found for ticker — keeps entry unresolved, no target, no duplicate entry", async () => {
  // An IOC that executed zero fills will leave no fill records. The fills-based
  // V2 lookup correctly keeps the entry unresolved (fail closed) because we
  // cannot distinguish zero-fill from fills-not-yet-propagated.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-unresolved-zero";
    await seedUnresolvedEntry(store, clientOrderId);

    // Step 1 returns an empty fills array (no buy fills for this ticker).
    wireV2Lookup(ex, []);

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved",
      "no fills found → cannot confirm zero-fill vs propagation lag → must keep unresolved");
    assert.equal(entryRow.filledContracts, null, "fill count must remain null");
    assert.equal(ex.posted.length, 0, "no target placed when entry outcome is unknown");
    assert.equal(store.orders.size, 1, "no duplicate entry order written");
    assert.equal(store.claims.size, 1, "permanent claim retained");
  });
});

test("SOL_30_50 unresolved entry: restart recovery lookup transport failure keeps entry unresolved — no replacement entry, no target", async () => {
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-unresolved-fail";
    await seedUnresolvedEntry(store, clientOrderId);

    // The fills endpoint (Step 1) throws a network error.
    const realFetch = ex.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.startsWith("/portfolio/fills?") && path.includes("ticker=")) {
        throw new Error("network timeout during fills lookup");
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setSol30KalshiFetchForTesting(ex.fetch as never);

    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved", "failed lookup leaves entry unresolved (fail closed)");
    assert.equal(ex.posted.length, 0, "no target while entry outcome is unknown");
    assert.equal(store.orders.size, 1, "no additional entry order created");

    // Multiple restarts must not create duplicate entry rows.
    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);
    assert.equal(store.orders.size, 1, "no duplicate entry rows across multiple restarts");
  });
});

test("SOL_30_50 unresolved entry becomes full_fill after recovery — subsequent restarts do not create duplicate entries", async () => {
  // Confirms idempotency: once an unresolved entry is resolved to a terminal
  // outcome, repeated recoverSol30Targets calls must not add more order rows.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-idempotent-fill";
    await seedUnresolvedEntry(store, clientOrderId);

    ex.orders.set("ko-idempotent", {
      status: "filled", fillCount: 10,
      fills: [chunk("fi1", 10, 28, "2026-08-16T12:00:01Z")],
    });

    wireV2Lookup(
      ex,
      [{ order_id: "ko-idempotent", market_ticker: TICKER, action: "buy" }],
      { order_id: "ko-idempotent", client_order_id: clientOrderId, ticker: TICKER,
        status: "filled", fill_count_fp: "10.00" },
    );

    // First recovery resolves to full_fill and posts a target.
    await recoverSol30Targets(DATE);
    assert.equal(store.orders.get(`entry:${TICKER}`)!.outcome, "full_fill");
    // At this point there should be an entry row + one exit row.
    assert.equal(store.orders.size, 2, "entry + one exit row placed after first recovery");

    // Subsequent restarts must not create additional rows.
    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);
    assert.equal(store.orders.size, 2, "entry + one exit row — no duplicates after repeated restarts");
    assert.equal(store.orders.get(`entry:${TICKER}`)!.outcome, "full_fill", "entry stays full_fill");
  });
});

// ── Unresolved entry lookup: identity and filter validation ───────────────────

test("SOL_30_50 unresolved entry lookup: filter ignored — fill with wrong ticker keeps entry unresolved, no target, no link", async () => {
  // If the server ignores the ticker filter and returns fills for other tickers,
  // a fill whose market_ticker != order.ticker must be treated as a filter-
  // ignored response. The whole lookup fails closed: no id linked, no target.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-filter-ignored";
    await seedUnresolvedEntry(store, clientOrderId);

    wireV2Lookup(ex, [
      // market_ticker is a different ticker — filter was ignored.
      { order_id: "ko-wrong-ticker", market_ticker: "KXSOL15M-26AUG161200-OTHER", action: "buy" },
    ]);

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved", "filter-ignored response with wrong ticker must keep entry unresolved");
    assert.equal(entryRow.kalshiOrderId, null, "no order id must be linked from a wrong-ticker fill");
    assert.equal(ex.posted.length, 0, "no target placed");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
    assert.equal(store.claims.size, 1, "permanent claim retained");
  });
});

test("SOL_30_50 unresolved entry lookup: client_order_id mismatch on order detail — keeps entry unresolved, no link", async () => {
  // Fills match the ticker, but the exchange order detail's client_order_id does
  // not match our durable value — this is a different order. Never link it.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-our-order";
    await seedUnresolvedEntry(store, clientOrderId);

    wireV2Lookup(
      ex,
      [{ order_id: "ko-foreign", market_ticker: TICKER, action: "buy" }],
      // client_order_id belongs to a different order — mismatch.
      { order_id: "ko-foreign", client_order_id: "coid-someone-elses-order",
        ticker: TICKER, status: "filled", fill_count_fp: "7.00" },
    );

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved",
      "client_order_id mismatch must keep entry unresolved — must not link a foreign order");
    assert.equal(entryRow.kalshiOrderId, null, "foreign order_id must not be persisted");
    assert.equal(ex.posted.length, 0, "no target for a foreign order");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
    assert.equal(store.claims.size, 1, "permanent claim retained");
  });
});

test("SOL_30_50 unresolved entry lookup: ticker mismatch on order detail — keeps entry unresolved, no link", async () => {
  // Fills match the ticker, the fills order_id is unique, but the order detail's
  // ticker field disagrees with the durable ticker. Catastrophic cross-ticker
  // confusion — fail closed.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-ticker-mismatch";
    await seedUnresolvedEntry(store, clientOrderId);

    wireV2Lookup(
      ex,
      [{ order_id: "ko-ticker-mismatch", market_ticker: TICKER, action: "buy" }],
      { order_id: "ko-ticker-mismatch", client_order_id: clientOrderId,
        ticker: "KXSOL15M-26AUG161200-WRONG", status: "filled", fill_count_fp: "5.00" },
    );

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved",
      "ticker mismatch on order detail must keep entry unresolved");
    assert.equal(entryRow.kalshiOrderId, null, "must not link order with mismatched ticker");
    assert.equal(ex.posted.length, 0, "no target placed");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
  });
});

test("SOL_30_50 unresolved entry lookup: ambiguous multiple buy order_ids for ticker — keeps entry unresolved, no link", async () => {
  // Two distinct buy fills exist for the ticker — we cannot safely attribute
  // either to our unresolved entry without a client_order_id cross-reference
  // at the fills level. Fail closed.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-ambiguous";
    await seedUnresolvedEntry(store, clientOrderId);

    wireV2Lookup(ex, [
      { order_id: "ko-ambiguous-1", market_ticker: TICKER, action: "buy" },
      { order_id: "ko-ambiguous-2", market_ticker: TICKER, action: "buy" },
    ]);

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved",
      "multiple buy order_ids must keep entry unresolved — ambiguous which is ours");
    assert.equal(entryRow.kalshiOrderId, null, "no order_id linked when ambiguous");
    assert.equal(ex.posted.length, 0, "no target placed when ambiguous");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
    assert.equal(store.claims.size, 1, "permanent claim retained");
  });
});

// ── Unresolved entry lookup: fill count validation (fail closed) ──────────────

test("SOL_30_50 unresolved entry lookup: fill found but fill_count missing — keeps entry unresolved, no target, no link", async () => {
  // A fill record was found and order detail verified, but fill_count is absent.
  // The parser would default to 0; we must not trust that.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-missing-count";
    await seedUnresolvedEntry(store, clientOrderId);

    wireV2Lookup(
      ex,
      [{ order_id: "ko-missing-count", market_ticker: TICKER, action: "buy" }],
      // fill_count fields absent entirely; status is "resting" (not unambiguously executed)
      { order_id: "ko-missing-count", client_order_id: clientOrderId,
        ticker: TICKER, status: "resting" },
    );

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved", "missing fill_count must keep entry unresolved");
    assert.equal(entryRow.kalshiOrderId, null, "no order id must be durably linked without a valid count");
    assert.equal(ex.posted.length, 0, "no target while fill count is unknown");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
    assert.equal(store.claims.size, 1, "permanent claim retained");
  });
});

test("SOL_30_50 unresolved entry lookup: fill found but non-numeric fill_count — keeps entry unresolved, no target", async () => {
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-nonnumeric-count";
    await seedUnresolvedEntry(store, clientOrderId);

    wireV2Lookup(
      ex,
      [{ order_id: "ko-nonnumeric", market_ticker: TICKER, action: "buy" }],
      { order_id: "ko-nonnumeric", client_order_id: clientOrderId,
        ticker: TICKER, status: "canceled", fill_count_fp: "garbage" },
    );

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved", "non-numeric fill_count must keep entry unresolved");
    assert.equal(ex.posted.length, 0, "no target on non-numeric count");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
  });
});

test("SOL_30_50 unresolved entry lookup: fill found but negative fill_count — keeps entry unresolved, no target", async () => {
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-negative-count";
    await seedUnresolvedEntry(store, clientOrderId);

    wireV2Lookup(
      ex,
      [{ order_id: "ko-negative", market_ticker: TICKER, action: "buy" }],
      { order_id: "ko-negative", client_order_id: clientOrderId,
        ticker: TICKER, status: "canceled", fill_count_fp: "-3" },
    );

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved", "negative fill_count must keep entry unresolved");
    assert.equal(ex.posted.length, 0, "no target on negative count");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
  });
});

test("SOL_30_50 unresolved entry lookup: partially filled IOC with temporarily absent fill_count keeps entry unresolved — no target, no position assumed", async () => {
  // An IOC that partially filled some contracts, but the lookup response hasn't
  // propagated fill_count yet (or it's absent). Resolving to zero_fill here
  // would leave purchased contracts untracked and never exited. Fail closed.
  await withHarness(async (store, ex) => {
    const clientOrderId = "coid-partial-absent-count";
    await seedUnresolvedEntry(store, clientOrderId, 10);

    // A fill record exists (partial fill occurred), order detail verified, but
    // fill_count is absent on a non-"executed"/"filled" status.
    wireV2Lookup(
      ex,
      [{ order_id: "ko-partial-absent", market_ticker: TICKER, action: "buy" }],
      { order_id: "ko-partial-absent", client_order_id: clientOrderId,
        ticker: TICKER, status: "canceled" /* no fill_count_fp */ },
    );

    await recoverSol30Targets(DATE);
    await recoverSol30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.outcome, "unresolved",
      "canceled status with no fill_count must keep entry unresolved — parser default of 0 must never be trusted");
    assert.equal(entryRow.filledContracts, null, "fill count must remain unknown, not defaulted to 0");
    assert.equal(ex.posted.length, 0, "no 50c target while entry fill count is ambiguous");
    assert.equal(store.orders.size, 1, "no duplicate entry row");
    assert.equal(store.claims.size, 1, "permanent claim retained");
  });
});

// ── Decision ledger: no_executable_candidate ──────────────────────────────────

test("SOL_30_50 evaluator writes a no_executable_candidate ledger row when the window is eligible but both sides have no viable L2 level", async () => {
  await withHarness(async (store, ex) => {
    // Orderbook returns no executable level on either side (lowestLevelCents null).
    _setSol30OrderbookCaptureForTesting(async () => ({
      error: null, lowestLevelCents: null, depthAtOrBetterContracts: 0,
    } as unknown as OrderbookSnapshot));

    const state = {
      ticker: TICKER,
      openTime: new Date().toISOString(),
      closeTime: null,
      status: "open",
      bidUpdatedMs: Date.now(),
    };

    await evaluateSol30(state);
    // Second tick: the stable id must deduplicate — no second row must appear.
    await evaluateSol30(state);

    // The decision ledger must have exactly one no_executable_candidate row for
    // this ticker — the stable id ensures at most one row even across repeated ticks.
    const decisions = await store.listSol30DecisionEvents(TICKER);
    const noCandidate = decisions.filter((d) => d.decision === "no_executable_candidate");
    assert.equal(noCandidate.length, 1, "stable id deduplicates repeated ticks — exactly one row");
    assert.equal(noCandidate[0]!.ticker, TICKER);
    assert.equal(noCandidate[0]!.id, `${TICKER}:no_executable_candidate`,
      "stable id so repeated ticks do not inflate the ledger");

    // No order must have been posted to the exchange.
    assert.equal(ex.posted.length, 0, "no order posted when no executable candidate exists");
    // No ticker claim must have been created.
    assert.equal(store.claims.size, 0, "no claim written without an executable candidate");
  });
});
