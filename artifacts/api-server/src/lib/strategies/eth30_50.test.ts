import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  ETH30_ENTRY_CAP_CENTS,
  ETH30_ENTRY_MIN_CENTS,
  ETH30_HIGH_TIER_PRINCIPAL_CAP_CENTS,
  ETH30_LOW_TIER_MAX_CENTS,
  ETH30_PRINCIPAL_CAP_CENTS,
  contractsForEth30Capacity,
  eth30EntryPriceBucket,
  eth30PrincipalCapForEntryPrice,
  isEth30OpeningWindow,
  isEth30Ticker,
  mayEnterEth30,
} from "./eth30_50Rules.js";
import {
  buildEth30Report,
  checkStaleEth30Claims,
  computeEth30OwnedQuantity,
  computeEth30RestingExitQuantity,
  evaluateEth30,
  ensureEth30TargetExit,
  isEth30PairedHighLegSettlementHold,
  reconcileEth30OwnedOrders,
  reconcileEth30Settlements,
  recoverEth30Targets,
  warmEth30SettledTickersCache,
  startEth30PeriodicReconciliation,
  _runEth30PeriodicReconcileSweepForTesting,
  _setEth30KalshiFetchForTesting,
  _setEth30OrderbookCaptureForTesting,
  _setEth30EntryGuardsForTesting,
  _setEth30NowForTesting,
  _setEth30StoreForTesting,
  _resetEth30HighOnlyStateForTesting,
  _settledTickersForTesting,
  type Eth30Store,
} from "./eth30_50.js";
import type { Eth30DecisionEventParams, Eth30StrategyOrder, Eth30PositionEventParams, Eth30TickerClaim } from "../tradeStore.js";
import type { OrderbookSnapshot } from "../orderbookCapture.js";
import { easternDay } from "../dailyBudget.js";
import { _resetDailyProfitStopForTesting, _setDailyProfitStopFetchForTesting } from "../dailyProfitStop.js";

// ── Pure rule tests (unchanged) ───────────────────────────────────────────────

test("ETH_30_50 admits only exact KXETH15M series tokens", () => {
  assert.equal(isEth30Ticker("KXETH15M-26AUG161200-15"), true);
  assert.equal(isEth30Ticker("KXETH15MTEST-26AUG161200-15"), false);
  assert.equal(isEth30Ticker("KXBTC15M-26AUG161200-15"), false);
});

test("ETH_30_50 opening window is [open, open + five minutes)", () => {
  const open = "2026-08-16T12:00:00.000Z";
  assert.equal(isEth30OpeningWindow(open, Date.parse(open)), true);
  assert.equal(isEth30OpeningWindow(open, Date.parse(open) + 299_999), true);
  assert.equal(isEth30OpeningWindow(open, Date.parse(open) + 300_000), false);
  assert.equal(isEth30OpeningWindow(null, Date.parse(open)), false);
});

test("ETH_30_50 entry capacity is limited to the approved 23–28¢ tiers and $1 principal cap", () => {
  assert.equal(ETH30_ENTRY_MIN_CENTS, 23);
  assert.equal(ETH30_ENTRY_CAP_CENTS, 28);
  assert.equal(ETH30_LOW_TIER_MAX_CENTS, 25);
  assert.equal(ETH30_PRINCIPAL_CAP_CENTS, 100);
  assert.equal(ETH30_HIGH_TIER_PRINCIPAL_CAP_CENTS, 100);
  assert.equal(contractsForEth30Capacity(100_000, 22, 100), 0);
  assert.equal(contractsForEth30Capacity(100_000, 23, 100), 4);
  assert.equal(contractsForEth30Capacity(100_000, 24, 100), 4);
  assert.equal(contractsForEth30Capacity(100_000, 25, 100), 4);
  assert.equal(contractsForEth30Capacity(100_000, 26, 100), 3);
  assert.equal(contractsForEth30Capacity(100_000, 27, 100), 3);
  assert.equal(contractsForEth30Capacity(100_000, 28, 100), 3);
  assert.equal(contractsForEth30Capacity(ETH30_PRINCIPAL_CAP_CENTS, 25, 3), 3);
  assert.equal(contractsForEth30Capacity(ETH30_PRINCIPAL_CAP_CENTS, 29, 100), 0);
  assert.equal(contractsForEth30Capacity(ETH30_PRINCIPAL_CAP_CENTS, 30, 100), 0);
  assert.equal(contractsForEth30Capacity(ETH30_PRINCIPAL_CAP_CENTS, 5, 100), 0);
  assert.equal(eth30PrincipalCapForEntryPrice(23), 100);
  assert.equal(eth30PrincipalCapForEntryPrice(25), 100);
  assert.equal(eth30PrincipalCapForEntryPrice(26), 100);
  assert.equal(eth30PrincipalCapForEntryPrice(28), 100);
  for (const price of [23, 24, 25, 26, 27, 28]) {
    const contracts = contractsForEth30Capacity(Number.MAX_SAFE_INTEGER, price, Number.MAX_SAFE_INTEGER);
    assert.ok(contracts * price <= 100, `${price}¢ entry cannot exceed $1 principal`);
  }
  assert.equal(eth30PrincipalCapForEntryPrice(22), null);
  assert.equal(eth30PrincipalCapForEntryPrice(29), null);
  assert.equal(eth30EntryPriceBucket(22), "LE_22");
  assert.equal(eth30EntryPriceBucket(23), "23_25");
  assert.equal(eth30EntryPriceBucket(26), "26_28");
  assert.equal(eth30EntryPriceBucket(29), "29_30");
  assert.equal(eth30EntryPriceBucket(31), "GT_30");
});

test("ETH_30_50 cannot bypass the global halt or profit-stop gate", () => {
  assert.equal(mayEnterEth30(true, false, true), true);
  assert.equal(mayEnterEth30(true, true, true), false);
  assert.equal(mayEnterEth30(true, false, false), false);
  assert.equal(mayEnterEth30(false, false, true), false);
});

// ── Midnight-boundary yesterday formula ───────────────────────────────────────
//
// recoverEth30Targets computes yesterday as:
//   easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000))
//
// The noon-UTC anchor ensures the subtraction always lands inside the prior
// calendar day in Eastern time, regardless of whether the offset is UTC−5 (EST)
// or UTC−4 (EDT) and regardless of whether a DST transition occurred that day.

test("yesterday formula lands on the correct prior Eastern date in EST (UTC−5)", () => {
  // January 15 — deep winter, UTC−5 all day.
  // Noon UTC Jan 15 = 07:00 EST. Minus 24 h = noon UTC Jan 14 = 07:00 EST.
  const date = "2026-01-15";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-01-14");
});

test("yesterday formula lands on the correct prior Eastern date in EDT (UTC−4)", () => {
  // July 15 — summer, UTC−4 all day.
  // Noon UTC Jul 15 = 08:00 EDT. Minus 24 h = noon UTC Jul 14 = 08:00 EDT.
  const date = "2026-07-15";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-07-14");
});

test("yesterday formula crosses the EST→EDT spring-forward boundary correctly", () => {
  // DST spring-forward 2026: clocks advance from 2:00 AM EST to 3:00 AM EDT on
  // March 8.  If the server restarts at 00:01 ET on March 8 (still EST at that
  // point), date = "2026-03-08".  Noon UTC Mar 8 minus 24 h = noon UTC Mar 7,
  // which is firmly within March 7 ET under either UTC−5 or UTC−4.
  const date = "2026-03-08";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-03-07");
});

test("yesterday formula crosses the EDT→EST fall-back boundary correctly", () => {
  // DST fall-back 2026: clocks set back from 2:00 AM EDT to 1:00 AM EST on
  // November 1.  If the server restarts at 00:01 ET on November 1 (EDT still in
  // effect at that moment), date = "2026-11-01".  Noon UTC Nov 1 minus 24 h =
  // noon UTC Oct 31, always within October 31 ET.
  const date = "2026-11-01";
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  assert.equal(yesterday, "2026-10-31");
});

// ── Integration harness ───────────────────────────────────────────────────────

const TICKER = "KXETH15M-26AUG161200-15";
const DATE = "2026-08-16";

interface MemStore extends Eth30Store {
  orders: Map<string, Eth30StrategyOrder>;
  events: Map<string, Eth30PositionEventParams>;
  claims: Map<string, Eth30TickerClaim>;
  decisions: Eth30DecisionEventParams[];
}

function memStore(): MemStore {
  const orders = new Map<string, Eth30StrategyOrder>();
  const events = new Map<string, Eth30PositionEventParams>();
  const claims = new Map<string, Eth30TickerClaim>();
  const decisions: Eth30DecisionEventParams[] = [];
  return {
    orders, events, claims, decisions,
    async reserveEth30PairedEntry(params) {
      if (claims.has(params.ticker) || params.orders.some((order) => orders.has(order.id))) return false;
      claims.set(params.ticker, { ticker: params.ticker, easternDate: params.easternDate, claimedAtMs: Date.now(), entryClientOrderId: params.entryClientOrderId });
      for (const order of params.orders) orders.set(order.id, { ...order, kalshiOrderId: null, outcome: "pending", filledContracts: null, averageFillPriceCents: null, updatedAtMs: Date.now() });
      return true;
    },
    async claimEth30Ticker(ticker, easternDate, entryClientOrderId) {
      if (claims.has(ticker)) return false;
      claims.set(ticker, { ticker, easternDate, claimedAtMs: Date.now(), entryClientOrderId });
      return true;
    },
    async deleteEth30PositionEvents(ids) {
      for (const id of ids) events.delete(id);
      return true;
    },
    async appendEth30DecisionEvent(params) { decisions.push({ ...params }); return true; },
    async listEth30DecisionEvents(ticker) { return decisions.filter((decision) => decision.ticker === ticker); },
    async listRecentEth30DecisionEvents() { return [...decisions]; },
    async listAllEth30TickerClaims() { return [...claims.values()]; },
    async listEth30TickerClaimsForDate(easternDate) {
      return [...claims.values()].filter((c) => c.easternDate === easternDate);
    },
    async listEth30TickerClaimsForDates(dates) {
      const set = new Set(dates);
      return [...claims.values()].filter((c) => set.has(c.easternDate));
    },
    async recordEth30StrategyOrder(params) {
      if (orders.has(params.id)) return false;
      orders.set(params.id, { ...params, kalshiOrderId: null, outcome: "pending", filledContracts: null, averageFillPriceCents: null, updatedAtMs: Date.now() });
      return true;
    },
    async updateEth30StrategyOrder(update) {
      const row = orders.get(update.id);
      if (!row) return false;
      if (update.kalshiOrderId !== undefined) row.kalshiOrderId = update.kalshiOrderId;
      if (update.filledContracts !== undefined) {
        row.filledContracts = Math.min(
          row.requestedContracts,
          Math.max(row.filledContracts ?? 0, update.filledContracts ?? 0),
        );
      }
      // Mirror the storage guard: a stale cancellation cannot downgrade a
      // confirmed full fill or erase the exchanged contract quantity.
      if ((row.filledContracts ?? 0) >= row.requestedContracts) row.outcome = "full_fill";
      else if (update.outcome !== undefined) row.outcome = update.outcome;
      if (update.averageFillPriceCents != null) row.averageFillPriceCents = update.averageFillPriceCents;
      row.updatedAtMs = Date.now();
      return true;
    },
    async listEth30StrategyOrders(ticker) {
      return [...orders.values()].filter((o) => o.ticker === ticker).map((o) => ({ ...o }));
    },
    async appendEth30PositionEvent(params) {
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
    async listEth30PositionEvents(ticker) {
      return [...events.values()].filter((e) => e.ticker === ticker).sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    },
    async listSettledEth30Tickers() {
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
      const orderMatch = /^\/portfolio\/events\/orders\/([^/?]+)$/.exec(path);
      if (orderMatch) {
        const id = orderMatch[1]!;
        const order = ex.orders.get(id);
        if (!order) throw new Error(`unknown order ${id}`);
        if (method === "DELETE") {
          ex.cancelled.push(id);
          order.status = "canceled";
          return { order: { order_id: id, status: "canceled", fill_count_fp: `${order.fillCount}.00` } };
        }
        return {
          order: {
            order_id: id, status: order.status, fill_count_fp: `${order.fillCount}.00`,
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
  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  const prevHighOnlyTest = process.env["ETH30_HIGH_LEG_ONLY_TEST_ENABLED"];
  const prevAllowLegacyLowLegs = process.env["ETH30_ALLOW_LEGACY_LOW_LEGS"];
  process.env["ETH_30_50_ENABLED"] = "true";
  // Most historical tests intentionally cover the legacy low-leg behavior.
  // Make that choice explicit so the harness does not accidentally depend on
  // the production-safe default.
  process.env["ETH30_ALLOW_LEGACY_LOW_LEGS"] = "true";
  _resetEth30HighOnlyStateForTesting();
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);
  _setEth30EntryGuardsForTesting(
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
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    _setEth30OrderbookCaptureForTesting(null);
    _setEth30EntryGuardsForTesting(null, null);
    _resetEth30HighOnlyStateForTesting();
    _resetDailyProfitStopForTesting();
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
    if (prevHighOnlyTest === undefined) delete process.env["ETH30_HIGH_LEG_ONLY_TEST_ENABLED"];
    else process.env["ETH30_HIGH_LEG_ONLY_TEST_ENABLED"] = prevHighOnlyTest;
    if (prevAllowLegacyLowLegs === undefined) delete process.env["ETH30_ALLOW_LEGACY_LOW_LEGS"];
    else process.env["ETH30_ALLOW_LEGACY_LOW_LEGS"] = prevAllowLegacyLowLegs;
  }
}

test("ETH_30_50 evaluator claims its first executable side once and never re-enters after an IOC zero fill", async () => {
  await withHarness(async (store, ex) => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    ex.fetch = (async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/portfolio/events/orders") {
        return { order: { order_id: "entry-zero", fill_count: "0.00", status: "canceled" } };
      }
      throw new Error(`unexpected exchange call: ${method} ${path}`);
    }) as typeof ex.fetch;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    _setEth30OrderbookCaptureForTesting(async () => ({
      error: null, lowestLevelCents: 28, lowestLevelContractsApprox: 50, depthAtOrBetterContracts: 50,
    } as unknown as OrderbookSnapshot));

    const ticker = "KXETH15M-26AUG161200-15";
    const state = { ticker, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() };
    await evaluateEth30(state);
    await evaluateEth30(state);

    assert.equal(calls.length, 1, "a permanent claim prevents a second opening order");
    assert.equal(calls[0]?.body?.["ticker"], ticker);
    assert.equal(calls[0]?.body?.["side"], "bid");
    assert.equal(calls[0]?.body?.["price"], "0.2800");
    assert.equal(calls[0]?.body?.["count"], "3.00");
    assert.equal(store.claims.size, 1);
    assert.equal(store.orders.get(`entry:${ticker}`)?.outcome, "zero_fill");
  });
});

test("ETH_30_50 reserves complementary 20–30¢ / 70–80¢ child entries before POST and keeps both sides independent", async () => {
  await withHarness(async (store, ex) => {
    process.env["ETH30_ALLOW_LEGACY_LOW_LEGS"] = "true";
    const baseFetch = ex.fetch;
    ex.fetch = (async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "POST" && path === "/portfolio/events/orders" && body?.["time_in_force"] === "immediate_or_cancel") {
        const side = body["side"] === "bid" ? "yes" : "no";
        return { order: { order_id: `pair-${side}`, status: "filled", fill_count_fp: body["count"] } };
      }
      return baseFetch(method, path, body);
    }) as typeof ex.fetch;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    _setEth30OrderbookCaptureForTesting(async (_ticker, side) => ({
      error: null, lowestLevelCents: side === "yes" ? 25 : 75, lowestLevelContractsApprox: 100, depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));
    await evaluateEth30({ ticker: TICKER, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() });
    await evaluateEth30({ ticker: TICKER, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() });
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

test("ETH_30_50 defaults to high-leg-only when configuration cannot prove a legacy low-leg opt-in", async () => {
  await withHarness(async (store, ex) => {
    delete process.env["ETH30_ALLOW_LEGACY_LOW_LEGS"];
    const baseFetch = ex.fetch;
    const iocPosts: Array<Record<string, unknown> | undefined> = [];
    ex.fetch = (async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "POST" && path === "/portfolio/events/orders" && body?.["time_in_force"] === "immediate_or_cancel") {
        iocPosts.push(body);
        return { order: { order_id: "observed-risk-high", status: "filled", fill_count_fp: body["count"] } };
      }
      return baseFetch(method, path, body);
    }) as typeof ex.fetch;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    _setEth30OrderbookCaptureForTesting(async (_ticker, side) => ({
      error: null, lowestLevelCents: side === "yes" ? 30 : 71, lowestLevelContractsApprox: 100, depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));

    await evaluateEth30({ ticker: TICKER, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() });

    const entries = [...store.orders.values()].filter((order) => order.role === "entry");
    assert.equal(entries.length, 1, "the observed 30¢/71¢ pair must not create a low child by default");
    assert.equal(entries[0]?.side, "no");
    assert.equal(entries[0]?.limitPriceCents, 71);
    assert.equal(iocPosts.length, 1);
    assert.equal(iocPosts[0]?.["side"], "ask");
    assert.equal([...store.orders.values()].filter((order) => order.role === "exit").length, 0,
      "a high-only entry can never create a 50¢ target");
  });
});

test("ETH_30_50 high-leg-only test submits the 70–80¢ child without a low entry or 50¢ target", async () => {
  await withHarness(async (store, ex) => {
    process.env["ETH30_HIGH_LEG_ONLY_TEST_ENABLED"] = "true";
    const baseFetch = ex.fetch;
    let highOnlyIocPosts = 0;
    ex.fetch = (async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "POST" && path === "/portfolio/events/orders" && body?.["time_in_force"] === "immediate_or_cancel") {
        highOnlyIocPosts += 1;
        return { order: { order_id: "high-only-no", status: "filled", fill_count_fp: body["count"] } };
      }
      return baseFetch(method, path, body);
    }) as typeof ex.fetch;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    _setEth30OrderbookCaptureForTesting(async (_ticker, side) => ({
      error: null, lowestLevelCents: side === "yes" ? 25 : 75, lowestLevelContractsApprox: 100, depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));

    await evaluateEth30({ ticker: TICKER, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() });

    const entries = [...store.orders.values()].filter((order) => order.role === "entry");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.side, "no");
    assert.equal(entries[0]?.limitPriceCents, 75);
    assert.equal(entries[0]?.requestedContracts, 1, "the existing per-side $1 cap remains in force");
    assert.equal([...store.orders.values()].filter((order) => order.role === "exit").length, 0);
    assert.equal(highOnlyIocPosts, 1);
  });
});

test("ETH_30_50 high-leg-only test cancels an existing low-leg 50¢ target and leaves it for settlement", async () => {
  await withHarness(async (store, ex) => {
    process.env["ETH30_HIGH_LEG_ONLY_TEST_ENABLED"] = "true";
    await store.claimEth30Ticker(TICKER, DATE, "existing-low");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER}:yes`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "existing-low", side: "yes", limitPriceCents: 25, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({ id: `entry:${TICKER}:yes`, kalshiOrderId: "existing-low-order", filledContracts: 4, averageFillPriceCents: 25, outcome: "full_fill" });
    await store.recordEth30StrategyOrder({
      id: `exit:${TICKER}:yes:1`, ticker: TICKER, easternDate: DATE, role: "exit", sequenceNumber: 1,
      clientOrderId: "existing-low-target", side: "yes", limitPriceCents: 50, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({ id: `exit:${TICKER}:yes:1`, kalshiOrderId: "existing-low-target", filledContracts: 0, averageFillPriceCents: null, outcome: "pending" });
    ex.orders.set("existing-low-target", { status: "resting", fillCount: 0, fills: [] });

    await recoverEth30Targets(DATE);

    assert.equal(store.orders.get(`exit:${TICKER}:yes:1`)?.outcome, "cancelled");
    assert.equal([...store.orders.values()].filter((order) => order.role === "exit" && ["pending", "partial_fill"].includes(order.outcome)).length, 0);
  });
});

test("ETH_30_50 high-leg-only evaluator blocks a new entry when an existing low-leg target cannot be conclusively cancelled", async () => {
  await withHarness(async (store, ex) => {
    process.env["ETH30_HIGH_LEG_ONLY_TEST_ENABLED"] = "true";
    await store.claimEth30Ticker("KXETH15M-26AUG161215-30", DATE, "existing-low");
    await store.recordEth30StrategyOrder({
      id: "entry:KXETH15M-26AUG161215-30:yes", ticker: "KXETH15M-26AUG161215-30", easternDate: DATE,
      role: "entry", sequenceNumber: 0, clientOrderId: "existing-low", side: "yes", limitPriceCents: 25, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({
      id: "entry:KXETH15M-26AUG161215-30:yes", kalshiOrderId: "existing-low-order",
      filledContracts: 4, averageFillPriceCents: 25, outcome: "full_fill",
    });
    await store.recordEth30StrategyOrder({
      id: "exit:KXETH15M-26AUG161215-30:yes:1", ticker: "KXETH15M-26AUG161215-30", easternDate: DATE,
      role: "exit", sequenceNumber: 1, clientOrderId: "existing-low-target", side: "yes", limitPriceCents: 50, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({
      id: "exit:KXETH15M-26AUG161215-30:yes:1", kalshiOrderId: "existing-low-target",
      filledContracts: 0, averageFillPriceCents: null, outcome: "pending",
    });
    const baseFetch = ex.fetch;
    let iocPosts = 0;
    ex.fetch = (async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "DELETE" && path.endsWith("/existing-low-target")) {
        return { order: { order_id: "existing-low-target", status: "resting", fill_count_fp: "0.00" } };
      }
      if (method === "POST" && path === "/portfolio/events/orders" && body?.["time_in_force"] === "immediate_or_cancel") {
        iocPosts += 1;
      }
      return baseFetch(method, path, body);
    }) as typeof ex.fetch;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    _setEth30OrderbookCaptureForTesting(async (_ticker, side) => ({
      error: null, lowestLevelCents: side === "yes" ? 25 : 75, lowestLevelContractsApprox: 100, depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));
    _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z"));
    try {
      await evaluateEth30({ ticker: TICKER, openTime: new Date().toISOString(), closeTime: null, status: "open", bidUpdatedMs: Date.now() });

      assert.equal(iocPosts, 0, "ambiguous target cancellation blocks every new high-only IOC");
      assert.equal(store.orders.get("exit:KXETH15M-26AUG161215-30:yes:1")?.outcome, "pending");
      assert.equal([...store.orders.values()].filter((order) => order.ticker === TICKER).length, 0);
    } finally {
      _setEth30NowForTesting(null);
    }
  });
});

test("ETH_30_50 restart recovery keeps a paired 70–80¢ leg through settlement while restoring the low-leg target", async () => {
  await withHarness(async (store, ex) => {
    await store.reserveEth30PairedEntry!({
      ticker: TICKER, easternDate: DATE, entryClientOrderId: "pair-yes",
      orders: [
        { id: `entry:${TICKER}:yes`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0, clientOrderId: "pair-yes", side: "yes", limitPriceCents: 25, requestedContracts: 4 },
        { id: `entry:${TICKER}:no`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0, clientOrderId: "pair-no", side: "no", limitPriceCents: 75, requestedContracts: 1 },
      ],
    });
    await store.updateEth30StrategyOrder({ id: `entry:${TICKER}:yes`, filledContracts: 4, averageFillPriceCents: 25, outcome: "full_fill" });
    await store.updateEth30StrategyOrder({ id: `entry:${TICKER}:no`, filledContracts: 1, averageFillPriceCents: 75, outcome: "full_fill" });
    await store.recordEth30StrategyOrder({
      id: `exit:${TICKER}:legacy-high`, ticker: TICKER, easternDate: DATE, role: "exit", sequenceNumber: 1,
      clientOrderId: "legacy-high-target", side: "no", limitPriceCents: 50, requestedContracts: 1,
    });
    await store.updateEth30StrategyOrder({
      id: `exit:${TICKER}:legacy-high`, kalshiOrderId: "legacy-high-target", filledContracts: 0,
      averageFillPriceCents: null, outcome: "pending",
    });
    ex.orders.set("legacy-high-target", { status: "resting", fillCount: 0, fills: [] });
    assert.equal(await isEth30PairedHighLegSettlementHold(TICKER, "yes"), false, "the low paired side retains protective-exit eligibility");
    assert.equal(await isEth30PairedHighLegSettlementHold(TICKER, "no"), true, "only the open high paired side is held through settlement");

    await recoverEth30Targets(DATE);
    await recoverEth30Targets(DATE);

    const activeExits = [...store.orders.values()].filter((order) => order.role === "exit" && ["pending", "partial_fill"].includes(order.outcome));
    assert.equal(store.orders.get(`exit:${TICKER}:legacy-high`)?.outcome, "cancelled", "recovery cancels a pre-deploy high-leg target");
    assert.equal(activeExits.length, 1, "recovery must not leave or create a high-leg exit");
    assert.equal(activeExits[0]?.side, "yes");
    assert.equal(activeExits[0]?.limitPriceCents, 50);
  });
});

test("ETH_30_50 only creates entries for executable 23–28¢ YES or NO opportunities", async () => {
  const cases: Array<{ price: number; side: "yes" | "no"; enters: boolean; expectedCount?: number; depth?: number }> = [
    { price: 5, side: "yes", enters: false },
    { price: 22, side: "yes", enters: false },
    { price: 23, side: "no", enters: true, expectedCount: 4 },
    { price: 24, side: "yes", enters: true, expectedCount: 4 },
    { price: 25, side: "no", enters: true, expectedCount: 4 },
    { price: 26, side: "yes", enters: true, expectedCount: 3 },
    { price: 27, side: "no", enters: true, expectedCount: 3 },
    { price: 28, side: "yes", enters: true, expectedCount: 3 },
    { price: 29, side: "no", enters: false },
    { price: 30, side: "yes", enters: false },
    { price: 31, side: "no", enters: false },
  ];
  for (const { price, side, enters, expectedCount, depth = 100 } of cases) {
    await withHarness(async (store, ex) => {
      _setEth30OrderbookCaptureForTesting(async (_ticker, candidateSide) => ({
        error: null,
        lowestLevelCents: candidateSide === side ? price : null,
        lowestLevelContractsApprox: candidateSide === side ? depth : 0,
        depthAtOrBetterContracts: candidateSide === side ? depth : 0,
      } as unknown as OrderbookSnapshot));
      await evaluateEth30({
        ticker: TICKER, openTime: new Date().toISOString(), closeTime: null,
        status: "open", bidUpdatedMs: Date.now(),
      });
      assert.equal(ex.posted.length, enters ? 1 : 0, `${price}¢ ${side} entry submission`);
      assert.equal(store.claims.size, enters ? 1 : 0, `${price}¢ ${side} ticker claim`);
      if (!enters && price >= 22) {
        const decision = store.decisions.find((row) => row.decision === "entry_rejected_price_band");
        assert.equal(decision?.priceCents, price);
        assert.match(decision?.note ?? "", /"priceBucket"/);
        assert.match(decision?.note ?? "", /"outside_23_28_live_band"/);
      }
      if (enters) {
        const expectedPrice = ((side === "yes" ? price : 100 - price) / 100).toFixed(4);
        assert.equal(ex.posted[0]?.["price"], expectedPrice);
        assert.equal(ex.posted[0]?.["side"], side === "yes" ? "bid" : "ask");
        assert.equal(ex.posted[0]?.["count"], `${expectedCount}.00`);
      }
    });
  }
});

test("ETH_30_50 uses immediately executable L2 depth and never skips a rejected first side", async () => {
  await withHarness(async (store, ex) => {
    _setEth30OrderbookCaptureForTesting(async (_ticker, side) => ({
      error: null,
      lowestLevelCents: side === "yes" ? 22 : 24,
      lowestLevelContractsApprox: side === "yes" ? 100 : 100,
      depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));
    await evaluateEth30({
      ticker: TICKER, openTime: new Date().toISOString(), closeTime: null,
      status: "open", bidUpdatedMs: Date.now(),
    });
    assert.equal(ex.posted.length, 0, "the rejected first executable YES side blocks an NO entry");
    const rejection = store.decisions.find((row) => row.decision === "entry_rejected_price_band");
    assert.equal(rejection?.priceCents, 22);
    assert.match(rejection?.note ?? "", /"LE_22"/);
  });
  await withHarness(async (_store, ex) => {
    _setEth30OrderbookCaptureForTesting(async () => ({
      error: null, lowestLevelCents: 23, lowestLevelContractsApprox: 4, depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));
    await evaluateEth30({
      ticker: TICKER, openTime: new Date().toISOString(), closeTime: null,
      status: "open", bidUpdatedMs: Date.now(),
    });
    assert.equal(ex.posted[0]?.["count"], "4.00", "available L2 depth reduces the entry size");
  });
  await withHarness(async (store, ex) => {
    _setEth30OrderbookCaptureForTesting(async (_ticker, side) => ({
      error: null,
      lowestLevelCents: side === "yes" ? 24 : 26,
      lowestLevelContractsApprox: side === "yes" ? 0 : 100,
      depthAtOrBetterContracts: 100,
    } as unknown as OrderbookSnapshot));
    await evaluateEth30({
      ticker: TICKER, openTime: new Date().toISOString(), closeTime: null,
      status: "open", bidUpdatedMs: Date.now(),
    });
    assert.equal(ex.posted[0]?.["side"], "ask", "an in-band zero-depth YES quote allows executable NO evaluation");
    assert.equal(store.decisions.some((row) => row.decision === "entry_no_executable_depth"), true);
  });
});

/** Seed a claimed ticker with a partially filled entry order linked to `ko-entry`. */
async function seedEntry(
  store: MemStore, ex: FakeExchange, ackFilled: number, requested: number, side: "yes" | "no" = "yes",
): Promise<void> {
  await store.claimEth30Ticker(TICKER, DATE, "coid-entry");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0,
    clientOrderId: "coid-entry", side, limitPriceCents: 28, requestedContracts: requested,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: ackFilled,
    averageFillPriceCents: ackFilled > 0 ? 28 : null,
    outcome: ackFilled === 0 ? "zero_fill" : ackFilled === requested ? "full_fill" : "partial_fill",
  });
  if (ackFilled > 0) {
    await store.appendEth30PositionEvent({
      id: `${TICKER}:entry_fill:coid-entry`, ticker: TICKER, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: ackFilled, contractsAfter: ackFilled, strategyOrderId: `entry:${TICKER}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
  }
  ex.orders.set("ko-entry", { status: ackFilled === requested ? "filled" : "resting", fillCount: ackFilled, fills: [] });
}

function pendingExits(store: MemStore): Eth30StrategyOrder[] {
  return [...store.orders.values()].filter((o) => o.role === "exit" && ["pending", "partial_fill"].includes(o.outcome));
}

// ── Integration tests: restart, partial fill, no-oversell ────────────────────

test("restart recovery reconciles a grown partial entry fill via owned fill chunks and posts one target", async () => {
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

    await recoverEth30Targets(DATE);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.filledContracts, 7);
    assert.equal(entryRow.outcome, "partial_fill");
    // Incremental chunk persistence: ack already covered 3, so only the 4 new
    // contracts enter the ledger (attributed to the later chunks by fill_id).
    const entryEvents = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "entry_fill");
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

test("50¢ targets use the closing Kalshi direction for both held outcomes", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 3, "yes");
    await recoverEth30Targets(DATE);
    assert.equal(ex.posted[0]?.["side"], "ask", "a held YES closes by asking YES");
    assert.equal(ex.posted[0]?.["price"], "0.5000");
    assert.equal(ex.posted[0]?.["time_in_force"], "good_till_canceled");
  });
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 3, "no");
    await recoverEth30Targets(DATE);
    assert.equal(ex.posted[0]?.["side"], "bid", "a held NO closes by bidding YES");
    assert.equal(ex.posted[0]?.["price"], "0.5000");
    assert.equal(ex.posted[0]?.["time_in_force"], "good_till_canceled");
  });
});

test("a second restart with an unchanged exchange causes no cancel/repost churn", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE); // posts the target
    assert.equal(ex.posted.length, 1);
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE); // simulated second restart
    await recoverEth30Targets(DATE); // and a third

    assert.equal(ex.posted.length, postedBefore, "no duplicate target orders");
    assert.equal(ex.cancelled.length, 0, "no cancel churn");
    assert.equal(pendingExits(store).length, 1);
  });
});

test("restart after day boundary recovers a position claimed the prior Eastern date", async () => {
  // This covers the case where the server restarts shortly after midnight ET:
  // the claim and entry were written on DATE_PREV, but recoverEth30Targets is
  // called with today's date (DATE). The prior-date check must surface the
  // claim so the GTC exit target is re-armed.
  const DATE_PREV = "2026-08-15";
  await withHarness(async (store, ex) => {
    // Seed the entry on the previous Eastern date.
    await store.claimEth30Ticker(TICKER, DATE_PREV, "coid-entry-prev");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE_PREV, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-entry-prev", side: "yes", limitPriceCents: 25, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry-prev", filledContracts: 4,
      averageFillPriceCents: 25, outcome: "full_fill",
    });
    await store.appendEth30PositionEvent({
      id: `${TICKER}:entry_fill:coid-entry-prev`, ticker: TICKER, easternDate: DATE_PREV,
      eventType: "entry_fill", contractsDelta: 4, contractsAfter: 4,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 25, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-entry-prev", { status: "filled", fillCount: 4, fills: [] });

    // Recovery is called with today's date — the prior-date lookup must find the claim.
    await recoverEth30Targets(DATE);

    // A resting 50¢ GTC exit should have been posted for the full 4 contracts.
    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "one target exit posted for the prior-date position");
    assert.equal(exits[0]!.requestedContracts, 4);
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted.length, 1);
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");

    // A second recovery call with the same today's date must not double-post.
    await recoverEth30Targets(DATE);
    assert.equal(ex.posted.length, 1, "no churn on second restart");
  });
});

test("settled prior-day claim is skipped entirely during recovery — no reconcile or exit work", async () => {
  // If a prior-day position already has a settlement event (market settled
  // while the server was down), recovery must skip it before calling
  // reconcileEth30OwnedOrders — neither exchange queries nor a new exit target
  // should be attempted for a closed position.
  const DATE_PREV = "2026-08-15";
  await withHarness(async (store, ex) => {
    // Seed the prior-day entry as fully filled.
    await store.claimEth30Ticker(TICKER, DATE_PREV, "coid-entry-prev");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE_PREV, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-entry-prev", side: "yes", limitPriceCents: 25, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry-prev", filledContracts: 4,
      averageFillPriceCents: 25, outcome: "full_fill",
    });
    ex.orders.set("ko-entry-prev", { status: "filled", fillCount: 4, fills: [] });
    await store.appendEth30PositionEvent({
      id: `${TICKER}:entry_fill:coid-entry-prev`, ticker: TICKER, easternDate: DATE_PREV,
      eventType: "entry_fill", contractsDelta: 4, contractsAfter: 4,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 25, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now() - 10_000,
    });
    // The market settled YES while the server was down.
    await store.appendEth30PositionEvent({
      id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE_PREV,
      eventType: "settlement", contractsDelta: -4, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes",
      note: "market settled yes; 4 owned contracts closed at settlement",
      occurredAtMs: Date.now() - 5_000,
    });

    await recoverEth30Targets(DATE);

    // No exit target should be posted and no exchange order-status queries
    // should be issued — the ticker is settled and must be skipped early.
    assert.equal(ex.posted.length, 0, "no exit target posted for a settled position");
    assert.equal(pendingExits(store).length, 0, "no pending exit order in the store");
    // reconcileEth30OwnedOrders would have queried ko-entry-prev; its absence
    // in requestedPaths confirms the settlement check fired before reconcile.
    assert.ok(
      !ex.requestedPaths.some((p) => p.includes("ko-entry-prev")),
      "no exchange query for a settled position",
    );
  });
});

test("recoverEth30Targets finds a prior-day claim at the EDT midnight after spring-forward (2026-03-09 00:01 EDT)", async () => {
  // DST spring-forward 2026: clocks advance from 2:00 AM EST to 3:00 AM EDT on
  // March 8.  Server restarts at 00:01 AM EDT on March 9 = 04:01 UTC — the day
  // after the transition, now running under UTC−4.
  //
  // The safe formula anchors at noon UTC and subtracts 24 h:
  //   easternDay("2026-03-09T12:00:00Z" − 24 h) = easternDay("2026-03-08T12:00:00Z")
  //                                              = "2026-03-08" (08:00 EDT)  ✓
  //
  // An unsafe "now − 86 400 000" formula would compute:
  //   easternDay("2026-03-09T04:01:00Z" − 24 h) = easternDay("2026-03-08T04:01:00Z")
  //                                              = "2026-03-07" (23:01 EST)  ✗
  // — missing the claim on "2026-03-08" and leaving the position with no exit.
  // This test would fail under that regression.
  const PRIOR_DATE_SF = "2026-03-08";
  await withHarness(async (store, ex) => {
    await store.claimEth30Ticker(TICKER, PRIOR_DATE_SF, "coid-sf");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: PRIOR_DATE_SF, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-sf", side: "yes", limitPriceCents: 27, requestedContracts: 5,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-sf", filledContracts: 5,
      averageFillPriceCents: 27, outcome: "full_fill",
    });
    await store.appendEth30PositionEvent({
      id: `${TICKER}:entry_fill:coid-sf`, ticker: TICKER, easternDate: PRIOR_DATE_SF,
      eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 27, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-sf", { status: "filled", fillCount: 5, fills: [] });

    // Fix the recovery clock at 00:01 AM EDT on March 9, 2026 = 04:01 UTC.
    _setEth30NowForTesting(() => new Date("2026-03-09T04:01:00Z"));
    try {
      await recoverEth30Targets(); // date = easternDay(sweepNow()) = "2026-03-09"
    } finally {
      _setEth30NowForTesting(null);
    }

    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "prior-day position recovered at spring-forward midnight boundary");
    assert.equal(exits[0]!.requestedContracts, 5);
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");
    assert.equal(ex.posted[0]!["self_trade_prevention_type"], "taker_at_cross");
  });
});

test("recoverEth30Targets finds a prior-day claim at the EDT midnight on fall-back day (2026-11-01 00:01 EDT)", async () => {
  // DST fall-back 2026: clocks set back from 2:00 AM EDT to 1:00 AM EST on
  // November 1.  Server restarts at 00:01 AM EDT on November 1 = 04:01 UTC —
  // the very first minute of the fall-back day, still running under UTC−4.
  //
  // Safe formula:
  //   easternDay("2026-11-01T12:00:00Z" − 24 h) = easternDay("2026-10-31T12:00:00Z")
  //                                              = "2026-10-31" (08:00 EDT)  ✓
  //
  // Verifies that recovery at the fall-back boundary does not drop a
  // position entered on October 31.
  const PRIOR_DATE_FB = "2026-10-31";
  await withHarness(async (store, ex) => {
    await store.claimEth30Ticker(TICKER, PRIOR_DATE_FB, "coid-fb");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: PRIOR_DATE_FB, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-fb", side: "yes", limitPriceCents: 26, requestedContracts: 3,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-fb", filledContracts: 3,
      averageFillPriceCents: 26, outcome: "full_fill",
    });
    await store.appendEth30PositionEvent({
      id: `${TICKER}:entry_fill:coid-fb`, ticker: TICKER, easternDate: PRIOR_DATE_FB,
      eventType: "entry_fill", contractsDelta: 3, contractsAfter: 3,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 26, feeCents: null,
      settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-fb", { status: "filled", fillCount: 3, fills: [] });

    // Fix the recovery clock at 00:01 AM EDT on November 1, 2026 = 04:01 UTC.
    _setEth30NowForTesting(() => new Date("2026-11-01T04:01:00Z"));
    try {
      await recoverEth30Targets(); // date = easternDay(sweepNow()) = "2026-11-01"
    } finally {
      _setEth30NowForTesting(null);
    }

    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "prior-day position recovered at fall-back midnight boundary");
    assert.equal(exits[0]!.requestedContracts, 3);
    assert.equal(exits[0]!.limitPriceCents, 50);
    assert.equal(ex.posted[0]!["time_in_force"], "good_till_canceled");
  });
});
test("partial target fill keeps the same resting order when its remainder matches owned quantity", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 6, 6);
    await recoverEth30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    // The resting target partially fills 2 of 6 while the server is down.
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 2;
    exchangeExit.fills = [chunk("x1", 2, 50, "2026-08-16T12:05:00Z")];

    await recoverEth30Targets(DATE);

    const orders = await store.listEth30StrategyOrders(TICKER);
    assert.equal(computeEth30OwnedQuantity(orders), 4);
    assert.equal(computeEth30RestingExitQuantity(orders), 4); // 6 requested − 2 filled
    assert.equal(ex.cancelled.length, 0, "matching remainder is left alone");
    assert.equal(pendingExits(store).length, 1);
    const exitEvents = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill");
    assert.equal(exitEvents.reduce((s, e) => s + e.contractsDelta, 0), -2);
    assert.ok(exitEvents.some((e) => e.id.includes("x1")));
  });
});

test("stale target is cancelled and reposted once when the entry grows after the target was placed", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 4, 10);
    await recoverEth30Targets(DATE); // target for 4
    const firstExit = pendingExits(store)[0]!;
    // Entry later grows to 10; the 4-lot target is now stale.
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 10;
    entry.status = "filled";
    entry.fills = [chunk("f1", 4, 28, "2026-08-16T12:00:01Z"), chunk("f2", 6, 28, "2026-08-16T12:00:05Z")];

    await recoverEth30Targets(DATE);

    assert.deepEqual(ex.cancelled, [firstExit.kalshiOrderId], "exactly the stale target was cancelled");
    const exits = pendingExits(store);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.requestedContracts, 10);
    const orders = await store.listEth30StrategyOrders(TICKER);
    assert.equal(computeEth30RestingExitQuantity(orders), 10);
    assert.ok(computeEth30RestingExitQuantity(orders) <= computeEth30OwnedQuantity(orders), "never oversell");
  });
});

test("target sizing is clamped to owned quantity — a stale caller cannot oversell", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    // Caller asks to rest 50 contracts; only 5 are owned.
    await ensureEth30TargetExit(TICKER, "yes", 50, DATE);
    const exits = pendingExits(store);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.requestedContracts, 5);
    assert.equal(ex.posted[0]!["count"], "5.00");
  });
});

test("fully sold position posts no new target after restart", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 5;
    exchangeExit.status = "filled";
    exchangeExit.fills = [chunk("x1", 5, 50, "2026-08-16T12:06:00Z")];
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE);

    assert.equal(pendingExits(store).length, 0);
    assert.equal(ex.posted.length, postedBefore, "no target posted for a fully sold position");
    const orders = await store.listEth30StrategyOrders(TICKER);
    assert.equal(computeEth30OwnedQuantity(orders), 0);
  });
});

test("failed cancel of a stale target fails closed: no replacement is posted", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 4, 10);
    await recoverEth30Targets(DATE);
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
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE);

    assert.equal(ex.posted.length, postedBefore, "no replacement beside an unconfirmed resting order");
    assert.equal(pendingExits(store).length, 1, "the original target row stays pending");
  });
});

test("canceled exit with fills endpoint lagging: status fill count is a floor, replacement never oversells", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE); // target for 5
    const exitRow = pendingExits(store)[0]!;
    // Exchange reports the exit canceled with 2 contracts filled, but the
    // fills endpoint is still propagating and returns an empty (valid) page.
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.status = "canceled";
    exchangeExit.fillCount = 2;
    exchangeExit.fills = [];

    await recoverEth30Targets(DATE);

    const cancelledRow = store.orders.get(exitRow.id)!;
    assert.equal(cancelledRow.outcome, "cancelled");
    assert.equal(cancelledRow.filledContracts, 2, "status fill count persisted despite empty fills page");
    // Owned remainder is 3 — the replacement target must match exactly.
    const orders = await store.listEth30StrategyOrders(TICKER);
    assert.equal(computeEth30OwnedQuantity(orders), 3);
    const exits = pendingExits(store);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.requestedContracts, 3, "replacement sized to actual remaining holding");
    assert.ok(computeEth30RestingExitQuantity(orders) <= computeEth30OwnedQuantity(orders), "never oversell");
    // The status-only delta reached the audit ledger.
    const exitEvents = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill");
    assert.equal(exitEvents.reduce((s, e) => s + e.contractsDelta, 0), -2);
  });
});

test("malformed explicit fill counts (negative / non-numeric) fail closed in DELETE and GET paths", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const realFetch = ex.fetch;
    const postedBefore = ex.posted.length;

    // GET path: canceled with a negative count and empty fills — quantity ambiguous.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.includes(`/portfolio/events/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "canceled", fill_count_fp: "-1" } };
      }
      if (method === "GET" && path.includes("order_id=") && path.includes(exitRow.kalshiOrderId!)) {
        return { fills: [] };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);

    await recoverEth30Targets(DATE);

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
      if (method === "GET" && path.includes(`/portfolio/events/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "resting", fill_count_fp: "0.00" } };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);

    await recoverEth30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "non-numeric DELETE count fails closed");
    assert.equal(ex.posted.length, postedBefore, "no replacement on malformed DELETE count");
  });
});

test("GET status canceled with omitted fill count and empty fills stays pending: no replacement posted", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const realFetch = ex.fetch;
    // Exchange reports the exit canceled but omits fill_count entirely, and
    // the fills endpoint returns an empty page — the true quantity is unknown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.includes(`/portfolio/events/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "canceled" } };
      }
      if (method === "GET" && path.includes("order_id=") && path.includes(exitRow.kalshiOrderId!)) {
        return { fills: [] };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE);
    await recoverEth30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "row not terminalized on unknown quantity");
    assert.equal(ex.posted.length, postedBefore, "no replacement while the canceled quantity is unknown");
  });
});

test("GET status canceled with omitted fill count and PARTIAL fills stays pending: chunks are not completeness proof", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const realFetch = ex.fetch;
    // Canceled with no count, and a lagging fills endpoint that shows only 2
    // of the (say) 5 contracts that actually sold. Terminalizing from the
    // chunk subset would understate the sold quantity and oversell on repost.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.includes(`/portfolio/events/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "canceled" } };
      }
      if (method === "GET" && path.includes("order_id=") && path.includes(exitRow.kalshiOrderId!)) {
        return { fills: [{ fill_id: "lag1", count_fp: "2.00", yes_price_dollars: "0.5000", created_time: "2026-08-16T12:05:00Z" }] };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE);
    await recoverEth30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "partial chunk page must not terminalize a canceled row");
    assert.equal(ex.posted.length, postedBefore, "no replacement while the canceled quantity is unproven");
  });
});

test("GET status canceled with malformed fill count and PARTIAL fills stays pending: no replacement posted", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    const realFetch = ex.fetch;
    // Canceled with a fractional (invalid) count plus a non-empty but possibly
    // incomplete fills page — neither signal is a validated total.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.includes(`/portfolio/events/orders/${exitRow.kalshiOrderId}`)) {
        return { order: { order_id: exitRow.kalshiOrderId, status: "canceled", fill_count_fp: "2.50" } };
      }
      if (method === "GET" && path.includes("order_id=") && path.includes(exitRow.kalshiOrderId!)) {
        return { fills: [{ fill_id: "lag2", count_fp: "2.00", yes_price_dollars: "0.5000", created_time: "2026-08-16T12:05:00Z" }] };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE);

    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "malformed count with partial chunks fails closed");
    assert.equal(ex.posted.length, postedBefore, "no replacement on unvalidated canceled quantity");
  });
});

test("terminal cancel response without an explicit fill count fails closed; executed status infers full quantity", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE); // resting target for 5
    const exitRow = pendingExits(store)[0]!;
    // Grow the entry so the ensure pass wants to cancel/repost the stale target.
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
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    // Make the recorded target stale so a cancel/repost is attempted.
    store.orders.get(exitRow.id)!.requestedContracts = 3;
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE);

    assert.equal(ex.posted.length, postedBefore, "no replacement on count-less canceled response");
    assert.equal(store.orders.get(exitRow.id)!.outcome, "pending", "row stays pending (fail closed)");

    // Case 2: DELETE reports terminal "executed" without a count — the full
    // requested quantity is the only safe inference; no oversized replacement.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "DELETE") {
        return { order: { order_id: path.split("/").pop(), status: "executed" } };
      }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);

    await recoverEth30Targets(DATE);

    const filledRow = store.orders.get(exitRow.id)!;
    assert.equal(filledRow.outcome, "full_fill", "a fully inferred execution cannot be downgraded to cancelled");
    assert.equal(filledRow.filledContracts, 3, "executed without a count infers full requested quantity");
    const orders = await store.listEth30StrategyOrders(TICKER);
    assert.ok(computeEth30RestingExitQuantity(orders) <= computeEth30OwnedQuantity(orders), "never oversell");
  });
});

test("HTTP-success cancel with a non-terminal status is not trusted: no replacement is posted", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 4, 10);
    await recoverEth30Targets(DATE);
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
    _setEth30KalshiFetchForTesting(ex.fetch as never);
    const postedBefore = ex.posted.length;

    await recoverEth30Targets(DATE);

    assert.equal(ex.posted.length, postedBefore, "no replacement while the original may still be resting");
    const exits = pendingExits(store);
    assert.equal(exits.length, 1, "original target row stays pending, not marked cancelled");
    assert.equal(exits[0]!.requestedContracts, 4);
  });
});

test("lost target POST response marks the row unresolved and blocks any replacement", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    const realFetch = ex.fetch;
    // The GTC target POST times out — Kalshi may or may not have accepted it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "POST") throw new Error("socket hang up");
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);

    await recoverEth30Targets(DATE);

    const exitRows = [...store.orders.values()].filter((o) => o.role === "exit");
    assert.equal(exitRows.length, 1);
    assert.equal(exitRows[0]!.outcome, "unresolved", "ambiguous submit is not marked as terminal error");

    // Restore the healthy transport: recovery must still refuse to post a
    // replacement beside the unverifiable, possibly resting order.
    _setEth30KalshiFetchForTesting(realFetch as never);
    await recoverEth30Targets(DATE);
    await recoverEth30Targets(DATE);

    assert.equal(ex.posted.length, 0, "no replacement while an unresolved submission exists");
    assert.equal([...store.orders.values()].filter((o) => o.role === "exit").length, 1);
  });
});

test("successful target response without an order id is unresolved: no durable link, no replacement", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 5, 5);
    const realFetch = ex.fetch;
    // HTTP success, but the response carries no order_id to reconcile by.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ex.fetch = (async (method: string, path: string, body?: unknown) => {
      if (method === "POST") { ex.posted.push(body as Record<string, unknown>); return { order: { status: "resting" } }; }
      return realFetch(method, path, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    _setEth30KalshiFetchForTesting(ex.fetch as never);

    await recoverEth30Targets(DATE);
    const postedAfterFirst = ex.posted.length;
    assert.equal(postedAfterFirst, 1);
    const exitRows = [...store.orders.values()].filter((o) => o.role === "exit");
    assert.equal(exitRows.length, 1);
    assert.equal(exitRows[0]!.outcome, "unresolved");

    _setEth30KalshiFetchForTesting(realFetch as never);
    await recoverEth30Targets(DATE);

    assert.equal(ex.posted.length, postedAfterFirst, "no replacement beside an id-less unverified target");
  });
});

test("reconciliation touches only durably linked owned orders, never ticker/side queries", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 10);
    // An owned row that never got a kalshi_order_id must not trigger any lookup.
    await store.recordEth30StrategyOrder({
      id: `exit:${TICKER}:99`, ticker: TICKER, easternDate: DATE, role: "exit", sequenceNumber: 99,
      clientOrderId: "coid-unlinked", side: "yes", limitPriceCents: 50, requestedContracts: 3,
    });

    await reconcileEth30OwnedOrders(TICKER);

    for (const path of ex.requestedPaths) {
      assert.ok(!path.includes(TICKER), `no ticker-scoped exchange query: ${path}`);
      assert.ok(path.includes("ko-entry"), `only the durable order link is queried: ${path}`);
    }
    assert.ok(ex.requestedPaths.length > 0);
  });
});

test("corrupt fill chunks (missing fill_id) fail closed to order-status quantities", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 3, 10);
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 7;
    // One chunk lacks fill_id — the whole chunk response must be discarded.
    entry.fills = [
      chunk("f1", 4, 28, "2026-08-16T12:00:01Z"),
      { ...chunk("f2", 3, 28, "2026-08-16T12:00:02Z"), fill_id: "" },
    ];

    await reconcileEth30OwnedOrders(TICKER);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.filledContracts, 7, "order-status count still applied");
    const events = await store.listEth30PositionEvents(TICKER);
    assert.ok(!events.some((e) => e.id.includes(":fid:")), "no partial chunk subset persisted");
    assert.equal(events.filter((e) => e.eventType === "entry_fill").reduce((s, e) => s + e.contractsDelta, 0), 7);
  });
});

test("re-running reconciliation is idempotent for chunk events and quantities", async () => {
  await withHarness(async (store, ex) => {
    await seedEntry(store, ex, 2, 10);
    const entry = ex.orders.get("ko-entry")!;
    entry.fillCount = 6;
    entry.fills = [chunk("f1", 2, 28, "2026-08-16T12:00:01Z"), chunk("f2", 4, 28, "2026-08-16T12:00:02Z")];

    await reconcileEth30OwnedOrders(TICKER);
    await reconcileEth30OwnedOrders(TICKER);
    await reconcileEth30OwnedOrders(TICKER);

    const entryRow = store.orders.get(`entry:${TICKER}`)!;
    assert.equal(entryRow.filledContracts, 6);
    const events = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "entry_fill");
    // ack event (2) + one incremental chunk event (4) — never re-appended.
    assert.equal(events.length, 2);
    assert.equal(events.reduce((s, e) => s + e.contractsDelta, 0), 6);
  });
});

// ── Settlement reconciliation tests ──────────────────────────────────────────

/**
 * Seed an entry with chunk evidence already on the exchange so
 * settlementReadiness passes without needing a separate reconcile call.
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

test("settlement appends one idempotent event that zeros the position when the target never hit", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 5, 5);
    // Post a resting 50¢ target (unfilled).
    await recoverEth30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    assert.ok(exitRow, "a resting target must be pending");

    // Market settles YES before the target fills.
    ex.markets.set(TICKER, { result: "yes" });

    await reconcileEth30Settlements();

    // Exactly one settlement event.
    const allEvents = await store.listEth30PositionEvents(TICKER);
    const settlements = allEvents.filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.settlementResult, "yes");
    assert.equal(settlements[0]!.contractsAfter, 0);
    assert.equal(settlements[0]!.contractsDelta, -5);

    // The resting target must be marked terminal.
    const exitAfter = store.orders.get(exitRow.id)!;
    assert.equal(exitAfter.outcome, "cancelled", "settled target must be marked terminal");

    // Second call is a no-op.
    await reconcileEth30Settlements();
    const settlementsAfter = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlementsAfter.length, 1, "settlement event is idempotent");
  });
});

test("settlement with result=no also appends a valid event and closes the position", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 3, 3);
    ex.markets.set(TICKER, { result: "no" });

    await reconcileEth30Settlements();

    const settlements = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.settlementResult, "no");
    assert.equal(settlements[0]!.contractsAfter, 0);
    assert.equal(settlements[0]!.contractsDelta, -3);
  });
});

test("settlement is skipped for an unsettled market (result not yes/no)", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 4, 4);
    // Market not yet settled: result is null.
    ex.markets.set(TICKER, { result: null });

    await reconcileEth30Settlements();

    const settlements = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 0, "no settlement event while market is open");
  });
});

test("settlement delta reflects only unsold contracts when some were already sold", async () => {
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 6, 6);
    // Post a target; partially fill 2 contracts while the server was down.
    await recoverEth30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 2;
    exchangeExit.fills = [chunk("x1", 2, 50, "2026-08-16T12:05:00Z")];
    // Market settles with 4 contracts still owned.
    ex.markets.set(TICKER, { result: "yes" });

    await reconcileEth30Settlements();

    const allEvents = await store.listEth30PositionEvents(TICKER);
    const settlement = allEvents.find((e) => e.eventType === "settlement")!;
    assert.ok(settlement, "settlement event must exist");
    assert.equal(settlement.contractsDelta, -4, "only the 4 unsold contracts close at settlement");
    assert.equal(settlement.contractsAfter, 0);

    // The partial-fill exit must also be marked terminal.
    const exitAfter = store.orders.get(exitRow.id)!;
    assert.equal(exitAfter.outcome, "cancelled");
  });
});

test("authenticated 35 YES @28c -> sell 35 @50c repairs stale cancelled exit and settlement without double-paying", async () => {
  await withHarness(async (store, ex) => {
    const ticker = "KXETH15M-26AUG162030-30";
    await store.claimEth30Ticker(ticker, DATE, "coid-entry-35");
    await store.recordEth30StrategyOrder({
      id: `entry:${ticker}`, ticker, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-entry-35", side: "yes", limitPriceCents: 28, requestedContracts: 35,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${ticker}`, kalshiOrderId: "ko-entry-35", outcome: "full_fill",
      filledContracts: 35, averageFillPriceCents: 28,
    });
    ex.orders.set("ko-entry-35", {
      status: "filled", fillCount: 35,
      fills: [chunk("entry-35", 35, 28, "2026-08-17T00:19:08.109Z")],
    });

    // Reproduce the historical bad state: the local target was marked
    // cancelled/zero and settlement closed all 35 contracts before the
    // retained Kalshi maker fill was reconciled.
    await store.recordEth30StrategyOrder({
      id: `exit:${ticker}:1`, ticker, easternDate: DATE, role: "exit", sequenceNumber: 1,
      clientOrderId: "coid-exit-35", side: "yes", limitPriceCents: 50, requestedContracts: 35,
    });
    await store.updateEth30StrategyOrder({
      id: `exit:${ticker}:1`, kalshiOrderId: "ko-exit-35", outcome: "cancelled",
      filledContracts: 0, averageFillPriceCents: null,
    });
    ex.orders.set("ko-exit-35", {
      status: "canceled", fillCount: 35,
      fills: [chunk("exit-35", 35, 50, "2026-08-17T00:20:50.726Z")],
    });
    await store.appendEth30PositionEvent({
      id: `${ticker}:entry_fill:legacy`, ticker, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: 35, contractsAfter: 35, strategyOrderId: `entry:${ticker}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack",
      occurredAtMs: Date.parse("2026-08-17T00:19:08.109Z"),
    });
    await store.appendEth30PositionEvent({
      id: `${ticker}:settlement`, ticker, easternDate: DATE, eventType: "settlement",
      contractsDelta: -35, contractsAfter: 0, strategyOrderId: null, fillPriceCents: null,
      feeCents: null, settlementResult: "yes", note: "stale local settlement",
      occurredAtMs: Date.parse("2026-08-17T00:30:25.194Z"),
    });

    await reconcileEth30Settlements();

    const repairedExit = store.orders.get(`exit:${ticker}:1`)!;
    assert.equal(repairedExit.filledContracts, 35, "Kalshi fill quantity is authoritative");
    assert.equal(repairedExit.outcome, "full_fill", "full exchange fill cannot remain cancelled");
    const repairedEvents = await store.listEth30PositionEvents(ticker);
    const exitEvents = repairedEvents.filter((event) => event.eventType === "exit_fill");
    assert.equal(exitEvents.reduce((sum, event) => sum - event.contractsDelta, 0), 35);
    assert.equal(exitEvents[0]?.fillPriceCents, 50);
    const settlement = repairedEvents.find((event) => event.eventType === "settlement")!;
    assert.equal(Math.abs(settlement.contractsDelta), 0, "settlement closes no contracts already sold on Kalshi");

    const report = await buildEth30Report();
    const row = report.tickers.find((item) => item.ticker === ticker)!;
    assert.equal(row.exitContracts, 35);
    assert.equal(row.exitProceedsCents, 35 * 50);
    assert.equal(row.settlementPayoutCents, 0);
    assert.equal(row.realizedPnlCents, 35 * (50 - 28));

    // A delayed cancellation/settlement write with zero contracts cannot erase
    // the exchange-confirmed full fill.
    await store.updateEth30StrategyOrder({
      id: repairedExit.id, outcome: "cancelled", filledContracts: 0, averageFillPriceCents: null,
    });
    const afterStaleWrite = store.orders.get(repairedExit.id)!;
    assert.equal(afterStaleWrite.filledContracts, 35);
    assert.equal(afterStaleWrite.outcome, "full_fill");
    await reconcileEth30Settlements();
    assert.equal((await store.listEth30PositionEvents(ticker)).filter((event) => event.eventType === "settlement").length, 1);
  });
});

test("settlement is deferred when fill chunk evidence is incomplete", async () => {
  await withHarness(async (store, ex) => {
    // Seed with ack only — no fills on the exchange yet (chunks missing).
    await seedEntry(store, ex, 5, 5);
    ex.markets.set(TICKER, { result: "yes" });

    await reconcileEth30Settlements();

    const settlements = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 0, "settlement must be deferred until chunk evidence is complete");
  });
});

test("settlement is skipped when there are no entry fills", async () => {
  await withHarness(async (store, ex) => {
    // Claim the ticker but the IOC filled zero contracts.
    await store.claimEth30Ticker(TICKER, DATE, "coid-zero");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-zero", side: "yes", limitPriceCents: 28, requestedContracts: 5,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 0,
      averageFillPriceCents: null, outcome: "zero_fill",
    });
    ex.orders.set("ko-entry", { status: "filled", fillCount: 0, fills: [] });
    ex.markets.set(TICKER, { result: "yes" });

    await reconcileEth30Settlements();

    const settlements = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 0, "no settlement event when nothing was ever bought");
  });
});

test("settlement sweep continues to the next ticker when the market-status fetch throws for the first ticker", async () => {
  await withHarness(async (store, ex) => {
    const TICKER_A = "KXETH15M-26AUG161200-15"; // market-status fetch will throw for this one
    const TICKER_B = "KXETH15M-26AUG161200-30"; // will settle normally

    // ── Seed TICKER_A: entry fully filled; chunk evidence on the exchange ────
    await store.claimEth30Ticker(TICKER_A, DATE, "coid-a");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER_A}`, ticker: TICKER_A, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-a", side: "yes", limitPriceCents: 28, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER_A}`, kalshiOrderId: "ko-entry-a", filledContracts: 4,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    await store.appendEth30PositionEvent({
      id: `${TICKER_A}:entry_fill:coid-a`, ticker: TICKER_A, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: 4, contractsAfter: 4, strategyOrderId: `entry:${TICKER_A}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    // Exchange has chunk evidence so syncTickerFillEvidence (called inside
    // reconcileEth30OwnedOrders) can replace the legacy event and make
    // settlementReadiness.ready = true — so the throw happens at the
    // market-status kfetch, not earlier.
    ex.orders.set("ko-entry-a", { status: "filled", fillCount: 4, fills: [chunk("fa1", 4, 28, "2026-08-16T12:00:01Z")] });

    // ── Seed TICKER_B: entry fully filled; market settled YES ────────────────
    await store.claimEth30Ticker(TICKER_B, DATE, "coid-b");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER_B}`, ticker: TICKER_B, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-b", side: "yes", limitPriceCents: 28, requestedContracts: 3,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER_B}`, kalshiOrderId: "ko-entry-b", filledContracts: 3,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    await store.appendEth30PositionEvent({
      id: `${TICKER_B}:entry_fill:coid-b`, ticker: TICKER_B, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: 3, contractsAfter: 3, strategyOrderId: `entry:${TICKER_B}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-entry-b", { status: "filled", fillCount: 3, fills: [chunk("fb1", 3, 28, "2026-08-16T12:00:02Z")] });
    ex.markets.set(TICKER_B, { result: "yes" });

    // ── Override fetch: throw only on TICKER_A's market-status lookup ────────
    // All other paths (order status, fills for both tickers, market for TICKER_B)
    // pass through to the base fake so the per-ticker try/catch is the only guard.
    const baseExFetch = ex.fetch;
    _setEth30KalshiFetchForTesting((async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === `/markets/${encodeURIComponent(TICKER_A)}`) {
        throw new Error("simulated market-status API failure for TICKER_A");
      }
      return baseExFetch(method, path, body);
    }) as never);

    await reconcileEth30Settlements();

    // TICKER_A: per-ticker block threw at the market-status call; no settlement.
    const aEvents = (await store.listEth30PositionEvents(TICKER_A)).filter((e) => e.eventType === "settlement");
    assert.equal(aEvents.length, 0, "no settlement event for the ticker whose market-status fetch threw");

    // TICKER_B: the sweep continued past the failure and settled the second ticker.
    const bEvents = (await store.listEth30PositionEvents(TICKER_B)).filter((e) => e.eventType === "settlement");
    assert.equal(bEvents.length, 1, "settlement event written for the second ticker after the first threw");
    assert.equal(bEvents[0]!.settlementResult, "yes");
    assert.equal(bEvents[0]!.contractsAfter, 0);
    assert.equal(bEvents[0]!.contractsDelta, -3);
  });
});

test("settlement sweep continues to the next ticker when fill-evidence sync throws for the first ticker", async () => {
  await withHarness(async (store, ex) => {
    const TICKER_A = "KXETH15M-26AUG161200-15"; // store write will throw during canonical rebuild
    const TICKER_B = "KXETH15M-26AUG161200-30"; // will settle normally

    // ── Seed TICKER_A: entry fully filled; exchange has fill chunks ──────────
    // syncTickerFillEvidence will:
    //   1. Fetch fills for ko-entry-a → gets chunk fa1 (exchange returns it)
    //   2. planCanonicalFillLedger → produces deleteIds=[legacy event] + appends=[chunk event]
    //   3. deleteEth30PositionEvents → succeeds
    //   4. appendEth30PositionEvent → store throws (injected below)
    // That unhandled rejection propagates through reconcileEth30OwnedOrders
    // and is caught by the per-ticker try/catch in reconcileEth30Settlements.
    await store.claimEth30Ticker(TICKER_A, DATE, "coid-a");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER_A}`, ticker: TICKER_A, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-a", side: "yes", limitPriceCents: 28, requestedContracts: 4,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER_A}`, kalshiOrderId: "ko-entry-a", filledContracts: 4,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    // Legacy approximate event — will be targeted for replacement during canonical rebuild.
    await store.appendEth30PositionEvent({
      id: `${TICKER_A}:entry_fill:coid-a`, ticker: TICKER_A, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: 4, contractsAfter: 4, strategyOrderId: `entry:${TICKER_A}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    // Exchange has complete fill chunks → fetchOwnedFillChunks returns non-null,
    // planCanonicalFillLedger does not defer, rebuild proceeds to the write step.
    ex.orders.set("ko-entry-a", { status: "filled", fillCount: 4, fills: [chunk("fa1", 4, 28, "2026-08-16T12:00:01Z")] });

    // ── Seed TICKER_B: entry fully filled; market settled YES ────────────────
    await store.claimEth30Ticker(TICKER_B, DATE, "coid-b");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER_B}`, ticker: TICKER_B, easternDate: DATE, role: "entry", sequenceNumber: 0,
      clientOrderId: "coid-b", side: "yes", limitPriceCents: 28, requestedContracts: 3,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER_B}`, kalshiOrderId: "ko-entry-b", filledContracts: 3,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    await store.appendEth30PositionEvent({
      id: `${TICKER_B}:entry_fill:coid-b`, ticker: TICKER_B, easternDate: DATE, eventType: "entry_fill",
      contractsDelta: 3, contractsAfter: 3, strategyOrderId: `entry:${TICKER_B}`,
      fillPriceCents: 28, feeCents: null, settlementResult: null, note: "entry_ioc_ack", occurredAtMs: Date.now(),
    });
    ex.orders.set("ko-entry-b", { status: "filled", fillCount: 3, fills: [chunk("fb1", 3, 28, "2026-08-16T12:00:02Z")] });
    ex.markets.set(TICKER_B, { result: "yes" });

    // ── Inject a store fault: appendEth30PositionEvent throws for TICKER_A ──
    // fetchOwnedFillChunks internally catches network errors and returns null,
    // so a fetch-level intercept cannot reach the per-ticker catch — it only
    // causes a defer. A store write failure is the earliest point inside
    // syncTickerFillEvidence that propagates as an unhandled rejection.
    const baseAppend = store.appendEth30PositionEvent.bind(store);
    store.appendEth30PositionEvent = async (params) => {
      if (params.ticker === TICKER_A) throw new Error("simulated store write failure during fill-evidence sync for TICKER_A");
      return baseAppend(params);
    };
    // Re-inject the wrapped store so eth30_50.ts picks up the patched method.
    _setEth30StoreForTesting(store);

    await reconcileEth30Settlements();

    // TICKER_A: per-ticker block threw during fill-evidence sync; no settlement.
    const aEvents = (await store.listEth30PositionEvents(TICKER_A)).filter((e) => e.eventType === "settlement");
    assert.equal(aEvents.length, 0, "no settlement event for the ticker whose fill-evidence sync threw");

    // TICKER_B: the sweep continued past the failure and settled the second ticker.
    const bEvents = (await store.listEth30PositionEvents(TICKER_B)).filter((e) => e.eventType === "settlement");
    assert.equal(bEvents.length, 1, "settlement event written for the second ticker after the first threw");
    assert.equal(bEvents[0]!.settlementResult, "yes");
    assert.equal(bEvents[0]!.contractsAfter, 0);
    assert.equal(bEvents[0]!.contractsDelta, -3);
  });
});

// ── Periodic reconciliation sweep tests ──────────────────────────────────────

test("mid-session target fill is reflected in ownership and P&L after one periodic sweep tick", async (t) => {
  // Enable fake setInterval so we can fire the reconciliation sweep without
  // waiting 5 real minutes.  Only setInterval is mocked; setImmediate remains
  // real so we can drain the async sweep chain after the tick.
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withHarness(async (store, ex) => {
    // 1. Seed: 5 contracts bought at 28¢; recover posts the resting 50¢ GTC target.
    await seedEntry(store, ex, 5, 5);
    await recoverEth30Targets(DATE);
    const exitRow = pendingExits(store)[0]!;
    assert.ok(exitRow, "a resting 50¢ target must be pending before the sweep");

    // 2. Simulate a mid-session fill: the GTC target fills while the server is
    //    live but before the next periodic sweep has run.  The event ledger does
    //    not yet reflect this fill.
    const exchangeExit = ex.orders.get(exitRow.kalshiOrderId!)!;
    exchangeExit.fillCount = 5;
    exchangeExit.status = "filled";
    exchangeExit.fills = [chunk("x1", 5, 50, "2026-08-16T12:10:00Z")];

    // Confirm the ledger has no exit_fill event before the sweep fires.
    assert.equal(
      (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill").length,
      0,
      "no exit_fill event in the ledger before the sweep",
    );

    // 3. Start the periodic timer and fire exactly one sweep interval.
    //    The callback is synchronous (mock tick fires it immediately); all inner
    //    awaits are microtasks that complete before the next macrotask, so a
    //    single setImmediate drains the entire async reconciliation chain.
    const stop = startEth30PeriodicReconciliation();
    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();

    // 4. The durable exit order row must reflect the exchange fill.
    const exitRowAfter = store.orders.get(exitRow.id)!;
    assert.equal(exitRowAfter.filledContracts, 5, "exit filledContracts updated by the periodic sweep");
    assert.equal(exitRowAfter.outcome, "full_fill", "exit row terminalized after a complete mid-session fill");

    // 5. An exit_fill position event must have been appended — this is what drives P&L.
    const allEvents = await store.listEth30PositionEvents(TICKER);
    const exitFills = allEvents.filter((e) => e.eventType === "exit_fill");
    assert.ok(exitFills.length > 0, "exit_fill event must be appended by the periodic sweep");
    assert.equal(
      exitFills.reduce((s, e) => s + e.contractsDelta, 0),
      -5,
      "total exit_fill delta must account for all 5 sold contracts",
    );

    // 6. Owned quantity must be zero: 5 bought, 5 sold.
    const orders = await store.listEth30StrategyOrders(TICKER);
    assert.equal(computeEth30OwnedQuantity(orders), 0, "no contracts remain after a complete exit fill");

    // 7. The ETH 30–50 report must reflect the updated P&L.
    //    Entry: 5 contracts × 28¢ = 140¢ cost.
    //    Exit:  5 contracts × 50¢ = 250¢ proceeds.
    //    Cash flow = 250 − 140 = 110¢. Verified realized/net P&L remain null
    //    because the legacy entry ack event carries feeCents=null
    //    (canonical chunk evidence for the entry is deferred until the exchange
    //    fills endpoint for ko-entry returns non-empty chunks).
    const report = await buildEth30Report();
    const tickerReport = report.tickers.find((t) => t.ticker === TICKER);
    assert.ok(tickerReport, "the filled ticker must appear in the ETH 30–50 report");
    assert.equal(tickerReport!.status, "closed",
      "ticker status must be 'closed' when all owned contracts have been sold via the target");
    assert.equal(tickerReport!.cashFlowPnlCents, 110,
      "cash flow must be 110¢ (5 contracts × (50¢ exit − 28¢ entry))");
    assert.equal(tickerReport!.realizedPnlCents, null,
      "missing entry fee evidence prevents this cash flow from being labeled realized P&L");
    assert.equal(report.summary.realizedPnlCents, null,
      "the strategy total is unavailable while any filled ticker lacks financial reconciliation");
  });
});

// ── Cross-day boundary helpers ────────────────────────────────────────────────

/** Seed a prior-day entry + resting exit order into `store` and `ex`. */
async function seedPriorDayEntry(
  store: ReturnType<typeof memStore>,
  ex: FakeExchange,
  claimDate: string,
  entryFillTime: string,
): Promise<void> {
  await store.claimEth30Ticker(TICKER, claimDate, "coid-entry-yd");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: claimDate, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry-yd", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  ex.orders.set("ko-entry", {
    status: "filled", fillCount: 5,
    fills: [chunk("f1", 5, 28, entryFillTime)],
  });
  await store.appendEth30PositionEvent({
    id: `${TICKER}:entry_fill:f1`, ticker: TICKER, easternDate: claimDate,
    eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
    strategyOrderId: `entry:${TICKER}`, fillPriceCents: 28, feeCents: null,
    settlementResult: null, note: "exchange_fill_chunk", occurredAtMs: 100,
  });
  await store.recordEth30StrategyOrder({
    id: `exit:${TICKER}:0`, ticker: TICKER, easternDate: claimDate, role: "exit",
    sequenceNumber: 0, clientOrderId: "coid-exit-yd", side: "yes", limitPriceCents: 50,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `exit:${TICKER}:0`, kalshiOrderId: "ko-exit", filledContracts: null,
    outcome: "pending",
  });
  ex.orders.set("ko-exit", { status: "resting", fillCount: 0, fills: [] });
}

/** Assert that a cross-day sweep correctly picks up an overnight exit fill. */
async function assertCrossDaySweepReconciles(
  store: ReturnType<typeof memStore>,
  ex: FakeExchange,
  t: TestContext,
  exitFillTime: string,
): Promise<void> {
  // Simulate the GTC exit filling overnight.
  const exchangeExit = ex.orders.get("ko-exit")!;
  exchangeExit.status = "filled";
  exchangeExit.fillCount = 5;
  exchangeExit.fills = [chunk("x1", 5, 50, exitFillTime)];

  assert.equal(
    (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill").length,
    0,
    "no exit_fill event before the sweep fires",
  );

  const stop = startEth30PeriodicReconciliation();
  t.mock.timers.tick(5 * 60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  stop();

  const exitRow = store.orders.get(`exit:${TICKER}:0`)!;
  assert.equal(exitRow.filledContracts, 5, "exit filledContracts updated by the cross-day sweep");
  assert.equal(exitRow.outcome, "full_fill", "exit row terminalized by the cross-day sweep");

  const exitFills = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "exit_fill");
  assert.ok(exitFills.length > 0, "exit_fill event must be appended for a cross-day GTC fill");
  assert.equal(
    exitFills.reduce((s, e) => s + e.contractsDelta, 0),
    -5,
    "total exit_fill delta accounts for all 5 sold contracts",
  );

  const orders = await store.listEth30StrategyOrders(TICKER);
  assert.equal(computeEth30OwnedQuantity(orders), 0, "no contracts remain after a cross-day exit fill");
}

test("periodic sweep reconciles a position claimed on the previous Eastern date after midnight", async (t) => {
  // Positions are keyed to the Eastern date on which they were entered.
  // If the server runs continuously past midnight, the Eastern date rolls
  // forward but the claim still carries the prior day's date.  The sweep must
  // still reconcile those positions so resting GTC exit fills are not missed.
  //
  // The sweep clock is injected so this test is deterministic regardless of
  // the actual wall-clock date.
  t.mock.timers.enable({ apis: ["setInterval"] });

  // Inject: sweep believes it is 2026-08-16 00:10 EDT (= 04:10 UTC).
  // The prior Eastern calendar date is 2026-08-15.
  _setEth30NowForTesting(() => new Date("2026-08-16T04:10:00Z"));
  try {
    const CLAIM_DATE = "2026-08-15";
    const TODAY_IN_TEST = "2026-08-16";
    assert.notEqual(CLAIM_DATE, TODAY_IN_TEST, "claim date must differ from today for the cross-day check to be meaningful");

    await withHarness(async (store, ex) => {
      await seedPriorDayEntry(store, ex, CLAIM_DATE, "2026-08-15T23:55:00Z");
      await assertCrossDaySweepReconciles(store, ex, t, "2026-08-16T00:10:00Z");
    });
  } finally {
    _setEth30NowForTesting(null);
  }
});

test("periodic sweep reconciles a prior-day position at the spring-forward DST boundary", async (t) => {
  // Spring forward 2025-03-09 (EST → EDT): the Eastern day is only 23 hours
  // long.  At 2025-03-10 00:30 EDT (= 04:30 UTC), subtracting 24 h in ms
  // yields 2025-03-09 04:30 UTC, which is still in Eastern *March 8* (EST),
  // not March 9 — so the naïve approach skips the prior-day claims entirely.
  // Calendar-day arithmetic on the Eastern date string handles this correctly.
  t.mock.timers.enable({ apis: ["setInterval"] });

  // Inject: sweep sees 2025-03-10 00:30 EDT (= 04:30 UTC).
  //   easternDay("2025-03-10T04:30:00Z") = "2025-03-10" (EDT)
  //   calendar yesterday                 = "2025-03-09"
  //   easternDay(now - 24h ms)           = easternDay("2025-03-09T04:30:00Z")
  //                                      = "2025-03-08" (EST) ← WRONG
  _setEth30NowForTesting(() => new Date("2025-03-10T04:30:00Z"));
  try {
    const CLAIM_DATE = "2025-03-09"; // the day that would be skipped by the naïve approach
    await withHarness(async (store, ex) => {
      await seedPriorDayEntry(store, ex, CLAIM_DATE, "2025-03-09T23:55:00Z");
      await assertCrossDaySweepReconciles(store, ex, t, "2025-03-10T04:15:00Z");
    });
  } finally {
    _setEth30NowForTesting(null);
  }
});

test("reconcileEth30Settlements backfills fee_cents for already-settled tickers with null fees", async () => {
  // Simulate a pre-existing settled position whose canonical chunk events were
  // written before the fee_cents column was added (feeCents=null).
  // reconcileEth30Settlements must call syncTickerFillEvidence for such tickers
  // so the DO UPDATE path backfills feeCents without reopening the ledger.
  await withHarness(async (store, ex) => {
    const CHUNK_NOTE = "exchange_fill_chunk";

    // Seed: entry order fully filled at 28¢, 5 contracts.
    await store.claimEth30Ticker(TICKER, DATE, "coid-entry");
    await store.recordEth30StrategyOrder({
      id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
      sequenceNumber: 0, clientOrderId: "coid-entry", side: "yes", limitPriceCents: 28,
      requestedContracts: 5,
    });
    await store.updateEth30StrategyOrder({
      id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 5,
      averageFillPriceCents: 28, outcome: "full_fill",
    });
    // Pre-existing canonical chunk event — feeCents is null (pre-column row).
    await store.appendEth30PositionEvent({
      id: `${TICKER}:entry_fill:f1`, ticker: TICKER, easternDate: DATE,
      eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
      strategyOrderId: `entry:${TICKER}`, fillPriceCents: 28, feeCents: null,
      settlementResult: null, note: CHUNK_NOTE, occurredAtMs: 100,
    });
    // Settlement event — ledger is finalised.
    await store.appendEth30PositionEvent({
      id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE,
      eventType: "settlement", contractsDelta: -5, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes", note: null, occurredAtMs: 200,
    });

    // Exchange fills endpoint returns the same fill with a non-zero fee.
    ex.orders.set("ko-entry", {
      status: "filled", fillCount: 5,
      fills: [{ ...chunk("f1", 5, 28, "2026-08-16T12:00:01Z"), fee_cost_dollars: "0.0200" }],
    });

    // Trigger the endpoint-facing reconciliation flow.
    await reconcileEth30Settlements();

    // The canonical chunk event must now have feeCents populated.
    const events = await store.listEth30PositionEvents(TICKER);
    const fillChunk = events.find((e) => e.id === `${TICKER}:entry_fill:f1`);
    assert.ok(fillChunk, "canonical fill-chunk event still present");
    assert.equal(fillChunk!.feeCents, 2, "fee_cents backfilled: 2¢ from 0.0200 dollars");

    // Settlement event must be untouched.
    const settlement = events.find((e) => e.eventType === "settlement");
    assert.ok(settlement, "settlement event preserved");
    assert.equal(settlement!.settlementResult, "yes");
    // No duplicate settlement appended.
    assert.equal(events.filter((e) => e.eventType === "settlement").length, 1);
  });
});

// ── Settlement read-count tests ────────────────────────────────────────────────

test("reconcileEth30Settlements SQL read count does not grow with settled tickers on subsequent sweep calls", async () => {
  // After the first sweep discovers that N tickers are settled, every subsequent
  // sweep (with skipFeeBackfill: true, as used by the periodic sweep) must skip
  // the listEth30PositionEvents call for those tickers entirely. The number of
  // reads per sweep tick must stay proportional to the number of *active*
  // (unsettled) tickers, not to the total number of historical claims.
  await withHarness(async (store, ex) => {
    const SETTLED_TICKERS = [
      "KXETH15M-26AUG161200-15",
      "KXETH15M-26AUG161200-30",
      "KXETH15M-26AUG161200-45",
    ];

    // Seed three fully-settled positions (one per ticker).
    for (const ticker of SETTLED_TICKERS) {
      await store.claimEth30Ticker(ticker, DATE, `coid-${ticker}`);
      await store.recordEth30StrategyOrder({
        id: `entry:${ticker}`, ticker, easternDate: DATE, role: "entry",
        sequenceNumber: 0, clientOrderId: `coid-${ticker}`, side: "yes",
        limitPriceCents: 28, requestedContracts: 4,
      });
      await store.updateEth30StrategyOrder({
        id: `entry:${ticker}`, kalshiOrderId: `ko-${ticker}`, filledContracts: 4,
        averageFillPriceCents: 28, outcome: "full_fill",
      });
      await store.appendEth30PositionEvent({
        id: `${ticker}:entry_fill:f1`, ticker, easternDate: DATE,
        eventType: "entry_fill", contractsDelta: 4, contractsAfter: 4,
        strategyOrderId: `entry:${ticker}`, fillPriceCents: 28, feeCents: 2,
        settlementResult: null, note: "exchange_fill_chunk", occurredAtMs: 100,
      });
      await store.appendEth30PositionEvent({
        id: `${ticker}:settlement`, ticker, easternDate: DATE,
        eventType: "settlement", contractsDelta: -4, contractsAfter: 0,
        strategyOrderId: null, fillPriceCents: null, feeCents: null,
        settlementResult: "yes",
        note: "market settled yes; 4 owned contracts closed at settlement",
        occurredAtMs: 200,
      });
      ex.markets.set(ticker, { result: "yes" });
    }

    // Instrument: count how many times listEth30PositionEvents is called.
    let readCount = 0;
    const baseListEvents = store.listEth30PositionEvents.bind(store);
    store.listEth30PositionEvents = async (ticker: string) => {
      readCount++;
      return baseListEvents(ticker);
    };
    _setEth30StoreForTesting(store);

    // First sweep: discovers all settled tickers, adds them to the cache.
    await reconcileEth30Settlements({ skipFeeBackfill: true });
    // Each settled ticker requires one listEth30PositionEvents call on the
    // first sweep to confirm it is settled.
    assert.equal(readCount, SETTLED_TICKERS.length,
      "first sweep must read each settled ticker once to discover it");

    // Reset the counter before the second sweep.
    readCount = 0;

    // Second sweep: all tickers are now in the settled cache.
    // No listEth30PositionEvents calls should be issued for settled tickers.
    await reconcileEth30Settlements({ skipFeeBackfill: true });
    assert.equal(readCount, 0,
      "subsequent sweeps must skip listEth30PositionEvents for all cached settled tickers");

    // Third sweep: same guarantee must hold — not a one-shot optimisation.
    await reconcileEth30Settlements({ skipFeeBackfill: true });
    assert.equal(readCount, 0,
      "third sweep must also skip all cached settled tickers");
  });
});

test("settlement is retried after storage failure — a false append return does not permanently suppress reconciliation", async () => {
  // If appendEth30PositionEvent returns false (storage degraded) when the
  // settlement event is first written, the ticker must NOT be added to the
  // settled-ticker cache. A subsequent sweep must re-read position events,
  // attempt the append again, and succeed once storage recovers.
  await withHarness(async (store, ex) => {
    await seedEntryWithChunks(store, ex, 4, 4);
    ex.markets.set(TICKER, { result: "yes" });

    // Intercept appendEth30PositionEvent in place — do NOT call
    // _setEth30StoreForTesting again, as that would clear _settledTickers.
    let appendCallCount = 0;
    const baseAppend = store.appendEth30PositionEvent.bind(store);
    store.appendEth30PositionEvent = async (params) => {
      if (params.eventType === "settlement") {
        appendCallCount++;
        if (appendCallCount === 1) {
          // Simulate storage degraded: return false without writing the event.
          return false;
        }
      }
      return baseAppend(params);
    };

    await reconcileEth30Settlements({ skipFeeBackfill: true });

    // No settlement event in the store (append returned false without writing).
    let settlements = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 0, "settlement event must not be present after a storage failure");

    // Second call: storage has recovered; append succeeds.
    await reconcileEth30Settlements({ skipFeeBackfill: true });

    settlements = (await store.listEth30PositionEvents(TICKER)).filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1, "settlement event must be written on the retry sweep");
    assert.equal(settlements[0]!.settlementResult, "yes");
    assert.equal(settlements[0]!.contractsDelta, -4);

    // Third call: ticker is now in the settled cache; instrument
    // listEth30PositionEvents in place (no re-inject, so _settledTickers stays).
    let readCount = 0;
    const baseListEvents = store.listEth30PositionEvents.bind(store);
    store.listEth30PositionEvents = async (ticker: string) => {
      if (ticker === TICKER) readCount++;
      return baseListEvents(ticker);
    };

    await reconcileEth30Settlements({ skipFeeBackfill: true });
    assert.equal(readCount, 0, "settled ticker is cached after a successful append and skipped on future sweeps");
  });
});

// ── In-flight guard test ───────────────────────────────────────────────────────

test("periodic reconcile sweep recovers and runs again after a transient DB error", async () => {
  // Arrange: a store whose listEth30TickerClaimsForDates throws on the first
  // call and succeeds on the second.  The _reconcileSweepInFlight flag must be
  // reset in the finally block so the second sequential tick can proceed.
  let claimListCalls = 0;

  const store = memStore();
  const ex = fakeExchange();

  const originalListForDates = store.listEth30TickerClaimsForDates.bind(store);
  store.listEth30TickerClaimsForDates = async (dates: string[]) => {
    claimListCalls++;
    if (claimListCalls === 1) throw new Error("simulated DB outage");
    return originalListForDates(dates);
  };

  // Seed a claim and a fully-filled entry order so the second sweep has real
  // work to do once the store recovers.
  await store.claimEth30Ticker(TICKER, DATE, "coid-entry");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  ex.orders.set("ko-entry", {
    status: "filled", fillCount: 5,
    fills: [chunk("f1", 5, 28, "2026-08-16T12:00:01Z")],
  });

  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "true";
  // Inject a fixed clock so the sweep queries [DATE, DATE-1] and finds the
  // seeded DATE claim regardless of the real wall-clock date.
  _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z")); // 10:00 EDT = Eastern DATE
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);
  try {
    // Act: first tick throws inside the try block; the finally resets the flag.
    await _runEth30PeriodicReconcileSweepForTesting();

    // Assert: guard was released even though the first tick threw.
    assert.equal(claimListCalls, 1, "first sweep must have attempted listEth30TickerClaimsForDates");

    // Act: second tick must not be blocked by _reconcileSweepInFlight.
    await _runEth30PeriodicReconcileSweepForTesting();

    assert.equal(claimListCalls, 2, "second sweep must proceed past the in-flight guard");

    // Assert: the second sweep wrote the expected entry_fill event.
    const events = await store.listEth30PositionEvents(TICKER);
    const fillEvents = events.filter((e) => e.eventType === "entry_fill");
    assert.equal(fillEvents.length, 1,
      "entry_fill event must be written by the second sweep after recovery");
  } finally {
    _setEth30NowForTesting(null);
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});

test("periodic reconcile sweep continues to the second ticker when the first ticker reconcile throws", async () => {
  const TICKER2 = "KXETH15M-26AUG161200-20";

  const store = memStore();
  const ex = fakeExchange();

  // Seed first claim whose kalshiOrderId is unknown to fakeExchange — GET will throw.
  await store.claimEth30Ticker(TICKER, DATE, "coid-entry-1");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry-1", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-throws", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  // "ko-throws" is absent from ex.orders so fakeExchange.fetch throws on GET.

  // Seed second claim with a fully-filled entry order that should succeed.
  await store.claimEth30Ticker(TICKER2, DATE, "coid-entry-2");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER2}`, ticker: TICKER2, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry-2", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER2}`, kalshiOrderId: "ko-good", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  ex.orders.set("ko-good", {
    status: "filled", fillCount: 5,
    fills: [chunk("f2", 5, 28, "2026-08-16T12:00:01Z")],
  });

  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "true";
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);
  try {
    // Act: single sweep tick — first ticker throws, second must still be processed.
    await _runEth30PeriodicReconcileSweepForTesting();

    // Assert: second ticker's entry_fill event was written despite the first throwing.
    const events = await store.listEth30PositionEvents(TICKER2);
    const fillEvents = events.filter((e) => e.eventType === "entry_fill");
    assert.equal(fillEvents.length, 1,
      "second ticker entry_fill must be written even when the first ticker reconcile throws");
  } finally {
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});

test("periodic reconcile sweep skips settled tickers — no exchange queries for a settled position", async () => {
  // A ticker that has a settlement event must generate zero exchange I/O during
  // a periodic sweep tick. As the pool of settled claims grows over time this
  // check prevents ever-increasing read load with no benefit.
  const store = memStore();
  const ex = fakeExchange();

  // Seed a fully-settled position: entry filled, exit target filled at 50¢,
  // settlement event present.
  await store.claimEth30Ticker(TICKER, DATE, "coid-settled");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-settled", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry-settled", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  // The exit order is already terminal (full_fill) — no pending orders remain.
  await store.recordEth30StrategyOrder({
    id: `exit:${TICKER}:1`, ticker: TICKER, easternDate: DATE, role: "exit",
    sequenceNumber: 1, clientOrderId: "coid-exit-settled", side: "yes", limitPriceCents: 50,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `exit:${TICKER}:1`, kalshiOrderId: "ko-exit-settled", filledContracts: 5,
    averageFillPriceCents: 50, outcome: "full_fill",
  });
  // Position events: entry fill + settlement event (the key guard condition).
  // Use feeCents: null on the chunk event — this is the realistic scenario for
  // historical settled positions recorded before the fee column was added.
  // The periodic sweep must NOT trigger syncTickerFillEvidence (which hits the
  // exchange fills endpoint) for such tickers; reconcileEth30Settlements is
  // called from the sweep with skipFeeBackfill: true for this reason.
  await store.appendEth30PositionEvent({
    id: `${TICKER}:entry_fill:f1`, ticker: TICKER, easternDate: DATE,
    eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5,
    strategyOrderId: `entry:${TICKER}`, fillPriceCents: 28, feeCents: null,
    settlementResult: null, note: "exchange_fill_chunk", occurredAtMs: 100,
  });
  await store.appendEth30PositionEvent({
    id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE,
    eventType: "settlement", contractsDelta: -5, contractsAfter: 0,
    strategyOrderId: null, fillPriceCents: null, feeCents: null,
    settlementResult: "yes",
    note: "market settled yes; 5 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  // Register the orders on the fake exchange (they should never be queried).
  ex.orders.set("ko-entry-settled", { status: "filled", fillCount: 5, fills: [] });
  ex.orders.set("ko-exit-settled", { status: "filled", fillCount: 5, fills: [] });

  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "true";
  // Fix the clock so the sweep queries [DATE, DATE-1] and finds the seeded claim.
  _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z")); // 10:00 EDT = Eastern DATE
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);
  try {
    await _runEth30PeriodicReconcileSweepForTesting();

    // The settlement check must have fired before reconcileEth30OwnedOrders,
    // so no exchange order-status or fills queries should have been issued.
    assert.equal(
      ex.requestedPaths.filter((p) => p.includes("ko-entry-settled") || p.includes("ko-exit-settled")).length,
      0,
      "no exchange queries for a settled ticker during a periodic sweep tick",
    );
  } finally {
    _setEth30NowForTesting(null);
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});

test("periodic reconcile sweep skips a second tick while the first is still running", async () => {
  // Arrange: a store with one today-dated claim and a fully-filled entry order.
  // We gate the first sweep's listEth30TickerClaimsForDates call behind a
  // deferred promise so the second sweep fires before the first one finishes.
  let claimListCalls = 0;
  let resolveGate!: () => void;
  const gate = new Promise<void>((res) => { resolveGate = res; });

  const store = memStore();
  const ex = fakeExchange();

  // Override listEth30TickerClaimsForDates to count calls and pause the first one.
  const originalListForDates = store.listEth30TickerClaimsForDates.bind(store);
  store.listEth30TickerClaimsForDates = async (dates: string[]) => {
    claimListCalls++;
    // The very first call blocks until we release the gate.
    if (claimListCalls === 1) await gate;
    return originalListForDates(dates);
  };

  // Seed a claim and a fully-filled entry order so the sweep has real work.
  await store.claimEth30Ticker(TICKER, DATE, "coid-entry");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER}`, ticker: TICKER, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry", side: "yes", limitPriceCents: 28,
    requestedContracts: 5,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER}`, kalshiOrderId: "ko-entry", filledContracts: 5,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  ex.orders.set("ko-entry", {
    status: "filled", fillCount: 5,
    fills: [chunk("f1", 5, 28, "2026-08-16T12:00:01Z")],
  });

  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "true";
  // Inject a fixed clock so the sweep queries [DATE, DATE-1] and finds the
  // seeded DATE claim regardless of the real wall-clock date.
  _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z")); // 10:00 EDT = Eastern DATE
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);
  try {
    // Act: fire two sweeps without awaiting the first.
    // Because _reconcileSweepInFlight is set synchronously before the first
    // await, the second call sees it as true and must return immediately.
    const sweep1 = _runEth30PeriodicReconcileSweepForTesting();
    const sweep2 = _runEth30PeriodicReconcileSweepForTesting();

    // Release the gate so sweep1 can complete.
    resolveGate();
    await Promise.all([sweep1, sweep2]);

    // Assert: listEth30TickerClaimsForDates was called exactly once —
    // sweep2 returned before reaching that await.
    assert.equal(claimListCalls, 1,
      "only one sweep must proceed past the in-flight guard");

    // Assert: position events were written exactly once — no double-write.
    const events = await store.listEth30PositionEvents(TICKER);
    const fillEvents = events.filter((e) => e.eventType === "entry_fill");
    assert.equal(fillEvents.length, 1,
      "entry_fill event must appear exactly once even when two ticks fire concurrently");
  } finally {
    _setEth30NowForTesting(null);
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});

test("settlement sweep continues past a ticker that throws during settlement reconciliation", async () => {
  // Regression guard: reconcileEth30Settlements wraps each ticker in its own
  // try/catch. If the first ticker's listEth30PositionEvents throws, the sweep
  // must still process and finalise the second ticker's position.
  const TICKER2 = "KXETH15M-26AUG161200-20";

  const store = memStore();
  const ex = fakeExchange();

  // Seed TICKER with only a claim — no orders or fills.
  // Override listEth30PositionEvents so the settlement loop throws on TICKER.
  await store.claimEth30Ticker(TICKER, DATE, "coid-throws");
  const originalListEvents = store.listEth30PositionEvents.bind(store);
  store.listEth30PositionEvents = async (ticker: string) => {
    if (ticker === TICKER) throw new Error("simulated settlement lookup failure for first ticker");
    return originalListEvents(ticker);
  };

  // Seed TICKER2 with a fully-filled entry order so settlement can finalise it.
  // Put fill chunks on the exchange; syncTickerFillEvidence (called inside
  // reconcileEth30OwnedOrders) will persist them as chunk events so that
  // settlementReadiness returns ready.
  await store.claimEth30Ticker(TICKER2, DATE, "coid-entry-2");
  await store.recordEth30StrategyOrder({
    id: `entry:${TICKER2}`, ticker: TICKER2, easternDate: DATE, role: "entry",
    sequenceNumber: 0, clientOrderId: "coid-entry-2", side: "yes", limitPriceCents: 28,
    requestedContracts: 4,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${TICKER2}`, kalshiOrderId: "ko-entry-2", filledContracts: 4,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  // Authoritative chunk evidence on the exchange — syncTickerFillEvidence will
  // read these via /portfolio/fills and write canonical chunk events to the store.
  ex.orders.set("ko-entry-2", {
    status: "filled", fillCount: 4,
    fills: [chunk("f2", 4, 28, "2026-08-16T12:00:01Z")],
  });
  // Market is settled — settlement event should be appended for TICKER2.
  ex.markets.set(TICKER2, { result: "yes" });

  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "true";
  // Fix the clock so the sweep's date-filtered owned-order loop also finds DATE claims.
  _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z")); // 10:00 EDT = Eastern DATE
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);
  try {
    // Act: one sweep tick — TICKER throws in settlement reconciliation, TICKER2 must still settle.
    await _runEth30PeriodicReconcileSweepForTesting();

    // Assert: TICKER2's settlement event was written despite TICKER throwing.
    const events2 = await originalListEvents(TICKER2);
    const settlements = events2.filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1,
      "TICKER2 must have a settlement event even though TICKER threw during settlement lookup");
    assert.equal(settlements[0]!.settlementResult, "yes");
    assert.equal(settlements[0]!.contractsDelta, -4);
    assert.equal(settlements[0]!.contractsAfter, 0);
  } finally {
    _setEth30NowForTesting(null);
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});

// ── Settled-ticker cache warmup ────────────────────────────────────────────────

test("warmEth30SettledTickersCache pre-populates the cache so the first sweep issues zero listEth30PositionEvents calls for settled tickers", async () => {
  // This test verifies the cold-start optimisation: after warmEth30SettledTickersCache
  // runs, the periodic reconcile sweep must not call listEth30PositionEvents for any
  // ticker that was already settled before the server restarted.
  //
  // Setup: two tickers.
  //   SETTLED_TICKER: has a settlement event in the store (settled before restart).
  //   UNSETTLED_TICKER: has entry fills but no settlement event (still open).
  // Only the unsettled ticker should trigger a listEth30PositionEvents call in the sweep.

  const SETTLED_TICKER = "KXETH15M-26AUG161200-15";   // same as TICKER constant above
  const UNSETTLED_TICKER = "KXETH15M-26AUG161200-20";
  const SWEEP_DATE = "2026-08-16"; // matches _setEth30NowForTesting below

  const store = memStore();
  const ex = fakeExchange();

  // ── Seed SETTLED_TICKER with a completed + settled position ──────────────────
  await store.claimEth30Ticker(SETTLED_TICKER, SWEEP_DATE, "coid-settled");
  await store.recordEth30StrategyOrder({
    id: `entry:${SETTLED_TICKER}`, ticker: SETTLED_TICKER, easternDate: SWEEP_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-settled",
    side: "yes", limitPriceCents: 28, requestedContracts: 4,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${SETTLED_TICKER}`, kalshiOrderId: "ko-settled", filledContracts: 4,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  // Settlement event already written — this ticker was settled before the restart.
  await store.appendEth30PositionEvent({
    id: `${SETTLED_TICKER}:entry_fill:ko-settled:f1`, ticker: SETTLED_TICKER,
    easternDate: SWEEP_DATE, eventType: "entry_fill",
    contractsDelta: 4, contractsAfter: 4,
    strategyOrderId: `entry:${SETTLED_TICKER}`, fillPriceCents: 28,
    feeCents: 0, settlementResult: null, note: null, occurredAtMs: 100,
  });
  await store.appendEth30PositionEvent({
    id: `${SETTLED_TICKER}:settlement`, ticker: SETTLED_TICKER,
    easternDate: SWEEP_DATE, eventType: "settlement",
    contractsDelta: -4, contractsAfter: 0, strategyOrderId: null,
    fillPriceCents: null, feeCents: null, settlementResult: "yes",
    note: "market settled yes; 4 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  // Exchange entry order is terminal (settled), no need for a resting exit.
  ex.orders.set("ko-settled", { status: "filled", fillCount: 4, fills: [] });

  // ── Seed UNSETTLED_TICKER with fills but no settlement event ─────────────────
  await store.claimEth30Ticker(UNSETTLED_TICKER, SWEEP_DATE, "coid-open");
  await store.recordEth30StrategyOrder({
    id: `entry:${UNSETTLED_TICKER}`, ticker: UNSETTLED_TICKER, easternDate: SWEEP_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-open",
    side: "yes", limitPriceCents: 28, requestedContracts: 3,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${UNSETTLED_TICKER}`, kalshiOrderId: "ko-open", filledContracts: 3,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  // Entry fill event present, no settlement yet.
  await store.appendEth30PositionEvent({
    id: `${UNSETTLED_TICKER}:entry_fill:ko-open:f1`, ticker: UNSETTLED_TICKER,
    easternDate: SWEEP_DATE, eventType: "entry_fill",
    contractsDelta: 3, contractsAfter: 3,
    strategyOrderId: `entry:${UNSETTLED_TICKER}`, fillPriceCents: 28,
    feeCents: 0, settlementResult: null, note: null, occurredAtMs: 150,
  });
  // Exchange: entry order filled, no resting exit yet.
  ex.orders.set("ko-open", { status: "filled", fillCount: 3, fills: [
    chunk("f-open-1", 3, 28, "2026-08-16T12:00:02Z"),
  ]});
  // Market not settled.
  ex.markets.set(UNSETTLED_TICKER, { result: null });

  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "true";
  // Fix the clock so listEth30TickerClaimsForDates is called with [SWEEP_DATE, SWEEP_DATE-1]
  // and finds both DATE claims.
  _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z")); // 10:00 EDT = SWEEP_DATE
  // Inject the store FIRST (this clears _settledTickers).
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);

  try {
    // ── Act: warm the cache (simulates startup, called from recoverEth30Targets) ──
    await warmEth30SettledTickersCache();

    // Instrument listEth30PositionEvents AFTER the warm-up so we count only
    // sweep calls, not the warm-up itself (which uses listSettledEth30Tickers).
    const positionEventCalls: string[] = [];
    const baseListEvents = store.listEth30PositionEvents.bind(store);
    store.listEth30PositionEvents = async (ticker: string) => {
      positionEventCalls.push(ticker);
      return baseListEvents(ticker);
    };

    // ── Run the first post-restart sweep ─────────────────────────────────────
    await _runEth30PeriodicReconcileSweepForTesting();

    // Assert: the settled ticker must not appear in any listEth30PositionEvents call
    // made by the owned-order reconciliation loop — the cache hit prevents it.
    assert.equal(
      positionEventCalls.filter((t) => t === SETTLED_TICKER).length, 0,
      "first post-restart sweep must not call listEth30PositionEvents for a settled ticker whose cache was warmed at startup",
    );

    // Assert: the unsettled ticker must still produce at least one
    // listEth30PositionEvents call — the sweep cannot short-circuit it via the
    // cache since it has no settlement event.
    assert.ok(
      positionEventCalls.includes(UNSETTLED_TICKER),
      "sweep must still call listEth30PositionEvents for unsettled tickers that are not in the settled cache",
    );

    // Assert: the cache itself is warm — listSettledEth30Tickers was called once
    // by warmEth30SettledTickersCache, and SETTLED_TICKER is now in the cache.
    // We verify this indirectly: a second sweep must also skip listEth30PositionEvents
    // for SETTLED_TICKER with no additional warm-up call.
    const secondSweepCalls: string[] = [];
    store.listEth30PositionEvents = async (ticker: string) => {
      secondSweepCalls.push(ticker);
      return baseListEvents(ticker);
    };
    await _runEth30PeriodicReconcileSweepForTesting();
    assert.equal(
      secondSweepCalls.filter((t) => t === SETTLED_TICKER).length, 0,
      "second sweep must also skip listEth30PositionEvents for the settled ticker (cache persists between sweeps)",
    );
  } finally {
    _setEth30NowForTesting(null);
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});

// ── checkStaleEth30Claims — settled-ticker skip tests ─────────────────────────

test("checkStaleEth30Claims skips a settled ticker without calling listEth30PositionEvents", async () => {
  // Settled tickers always have entry fills and can never be stale.  The
  // watchdog must skip them entirely via the _settledTickers cache — no SQL
  // round-trip is needed (and as the settled pool grows this avoids N reads
  // that provide no signal).
  const STALE_THRESHOLD_MS = 15 * 60 * 1000; // matches STALE_NO_FILL_THRESHOLD_MS
  await withHarness(async (store) => {
    // Seed a settled claim whose age exceeds the stale threshold.  claimedAtMs
    // is far enough in the past that the watchdog would flag it if it read
    // position events and found no entry fills.
    const nowMs = Date.now();
    const claimedAtMs = nowMs - STALE_THRESHOLD_MS - 60_000; // 1 minute past threshold

    store.claims.set(TICKER, { ticker: TICKER, easternDate: DATE, claimedAtMs, entryClientOrderId: "coid-settled" });

    // Add a settlement event so the ticker is in the settled set returned by
    // listSettledEth30Tickers (used by warmEth30SettledTickersCache).
    await store.appendEth30PositionEvent({
      id: `${TICKER}:settlement`, ticker: TICKER, easternDate: DATE,
      eventType: "settlement", contractsDelta: -5, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes",
      note: "market settled yes; 5 owned contracts closed at settlement",
      occurredAtMs: claimedAtMs + 1_000,
    });

    // Warm the cache — this is the path taken at startup.
    await warmEth30SettledTickersCache();

    // Assert the ticker is now in the settled-ticker cache.
    assert.ok(_settledTickersForTesting().has(TICKER), "TICKER must be in the settled cache after warmup");

    // Instrument listEth30PositionEvents AFTER the warm-up so we count only
    // watchdog calls, not the warmup itself.
    let positionEventCallCount = 0;
    const baseListEvents = store.listEth30PositionEvents.bind(store);
    store.listEth30PositionEvents = async (ticker: string) => {
      if (ticker === TICKER) positionEventCallCount++;
      return baseListEvents(ticker);
    };

    // Act: run the watchdog with a nowMs well past the stale threshold.
    const stale = await checkStaleEth30Claims(nowMs);

    // The settled ticker must not appear in stale results and must not have
    // triggered a listEth30PositionEvents call — the cache hit short-circuits
    // the entire check before any SQL is issued.
    assert.equal(stale.includes(TICKER), false, "settled ticker must not be reported as stale");
    assert.equal(positionEventCallCount, 0,
      "listEth30PositionEvents must not be called for a settled ticker when the cache is warm");
  });
});

test("checkStaleEth30Claims still flags an unsettled stale ticker when a settled one is skipped", async () => {
  // Verifies that the cache-hit early-return for settled tickers does not
  // accidentally suppress detection of genuinely stale (zero-fill) claims.
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;
  const SETTLED = "KXETH15M-26AUG161200-15";
  const STALE   = "KXETH15M-26AUG161200-20";
  await withHarness(async (store) => {
    const nowMs = Date.now();
    const claimedAtMs = nowMs - STALE_THRESHOLD_MS - 60_000;

    // Seed the settled claim.
    store.claims.set(SETTLED, { ticker: SETTLED, easternDate: DATE, claimedAtMs, entryClientOrderId: "coid-settled" });
    await store.appendEth30PositionEvent({
      id: `${SETTLED}:settlement`, ticker: SETTLED, easternDate: DATE,
      eventType: "settlement", contractsDelta: -3, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes", note: "market settled yes", occurredAtMs: claimedAtMs + 1_000,
    });

    // Seed the stale (zero-fill) claim — no position events at all.
    store.claims.set(STALE, { ticker: STALE, easternDate: DATE, claimedAtMs, entryClientOrderId: "coid-stale" });

    // Warm the cache so only SETTLED is in _settledTickers.
    await warmEth30SettledTickersCache();
    assert.ok(_settledTickersForTesting().has(SETTLED), "SETTLED must be cached after warmup");
    assert.equal(_settledTickersForTesting().has(STALE), false, "STALE must not be cached");

    // Act.
    const stale = await checkStaleEth30Claims(nowMs);

    // Only the genuinely stale ticker should be flagged.
    assert.equal(stale.includes(SETTLED), false, "settled ticker must not be reported as stale");
    assert.ok(stale.includes(STALE), "zero-fill unsettled ticker must be reported as stale");
  });
});

test("startEth30PeriodicReconciliation warms the settled-ticker cache even when ETH_30_50_ENABLED is off", async (t) => {
  // This test verifies the key invariant established when the cache-warm call
  // was moved from recoverEth30Targets (which returns early when the flag is
  // off) into startEth30PeriodicReconciliation (which always runs):
  //
  //   1. Calling startEth30PeriodicReconciliation with the flag OFF still
  //      invokes warmEth30SettledTickersCache before the first interval tick,
  //      confirmed by observing a call to listSettledEth30Tickers.
  //
  //   2. When the first sweep interval fires, no per-ticker
  //      listEth30PositionEvents call is made for the already-settled ticker —
  //      either because the sweep returns early (flag off) or because the cache
  //      hit prevents the SQL round-trip.  Either way the settled ticker must
  //      generate zero listEth30PositionEvents calls.
  //
  // The flag stays OFF for the entire test, so no live trading paths are
  // exercised; this is a pure initialisation / cache-warm verification.

  t.mock.timers.enable({ apis: ["setInterval"] });

  const SETTLED = "KXETH15M-26AUG161200-15";
  const SETTLED_DATE = "2026-08-16";

  const store = memStore();
  const ex = fakeExchange();

  // Seed a fully settled position so listSettledEth30Tickers returns [SETTLED].
  await store.claimEth30Ticker(SETTLED, SETTLED_DATE, "coid-warm-off");
  await store.recordEth30StrategyOrder({
    id: `entry:${SETTLED}`, ticker: SETTLED, easternDate: SETTLED_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-warm-off",
    side: "yes", limitPriceCents: 28, requestedContracts: 4,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${SETTLED}`, kalshiOrderId: "ko-warm-off", filledContracts: 4,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  await store.appendEth30PositionEvent({
    id: `${SETTLED}:entry_fill:ko-warm-off:f1`, ticker: SETTLED, easternDate: SETTLED_DATE,
    eventType: "entry_fill", contractsDelta: 4, contractsAfter: 4,
    strategyOrderId: `entry:${SETTLED}`, fillPriceCents: 28,
    feeCents: 0, settlementResult: null, note: null, occurredAtMs: 100,
  });
  await store.appendEth30PositionEvent({
    id: `${SETTLED}:settlement`, ticker: SETTLED, easternDate: SETTLED_DATE,
    eventType: "settlement", contractsDelta: -4, contractsAfter: 0,
    strategyOrderId: null, fillPriceCents: null, feeCents: null, settlementResult: "yes",
    note: "market settled yes; 4 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  ex.orders.set("ko-warm-off", { status: "filled", fillCount: 4, fills: [] });
  ex.markets.set(SETTLED, { result: "yes" });

  // Set the flag OFF — this is the scenario under test.
  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "false";

  // Fix the sweep clock so listEth30TickerClaimsForDates finds the claim.
  _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z")); // 10:00 EDT
  // Inject store FIRST — this clears _settledTickers.
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);

  try {
    // Instrument listSettledEth30Tickers to count calls made by the warmup.
    let listSettledCallCount = 0;
    const baseListSettled = store.listSettledEth30Tickers.bind(store);
    store.listSettledEth30Tickers = async () => {
      listSettledCallCount++;
      return baseListSettled();
    };

    // ── Act: start the reconciliation timer with the flag OFF ─────────────────
    const stop = startEth30PeriodicReconciliation();

    // Drain microtasks so the fire-and-forget warmEth30SettledTickersCache
    // promise resolves before the first interval tick is checked.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Assert (1): the warmup ran before the first sweep tick.
    assert.equal(
      listSettledCallCount, 1,
      "startEth30PeriodicReconciliation must call listSettledEth30Tickers once " +
      "during initialisation even when ETH_30_50_ENABLED is not 'true'",
    );

    // Instrument listEth30PositionEvents so we can verify the first sweep
    // does not issue a per-ticker SQL read for the settled ticker.
    const positionEventCalls: string[] = [];
    const baseListEvents = store.listEth30PositionEvents.bind(store);
    store.listEth30PositionEvents = async (ticker: string) => {
      positionEventCalls.push(ticker);
      return baseListEvents(ticker);
    };

    // ── Fire the first interval tick ──────────────────────────────────────────
    t.mock.timers.tick(5 * 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();

    // Assert (2): no listEth30PositionEvents call for the settled ticker.
    assert.equal(
      positionEventCalls.filter((ticker) => ticker === SETTLED).length, 0,
      "the first sweep must not call listEth30PositionEvents for a ticker that " +
      "was already settled — the cache warmed by startEth30PeriodicReconciliation " +
      "prevents the SQL round-trip (or the flag-off early return eliminates it)",
    );
  } finally {
    _setEth30NowForTesting(null);
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});

test("warmup-failure: when listSettledEth30Tickers throws, warmEth30SettledTickersCache never throws and the sweep falls back to per-ticker SQL reads", async () => {
  // If the DB is degraded at startup and listSettledEth30Tickers throws,
  // warmEth30SettledTickersCache must catch the error silently (never propagate
  // it to the caller). The settled-ticker cache remains empty, and the periodic
  // sweep falls back to its original per-ticker listEth30PositionEvents reads
  // so that settled tickers are still correctly skipped — just without the
  // cold-start cost reduction.

  const SETTLED_TICKER2 = "KXETH15M-26AUG161200-15";
  const WARMUP_DATE = "2026-08-16";

  const store = memStore();
  const ex = fakeExchange();

  // Seed a fully settled position so the sweep can verify correct skipping
  // via the per-ticker fallback when the cache is cold.
  await store.claimEth30Ticker(SETTLED_TICKER2, WARMUP_DATE, "coid-ws");
  await store.recordEth30StrategyOrder({
    id: `entry:${SETTLED_TICKER2}`, ticker: SETTLED_TICKER2, easternDate: WARMUP_DATE,
    role: "entry", sequenceNumber: 0, clientOrderId: "coid-ws",
    side: "yes", limitPriceCents: 28, requestedContracts: 4,
  });
  await store.updateEth30StrategyOrder({
    id: `entry:${SETTLED_TICKER2}`, kalshiOrderId: "ko-ws", filledContracts: 4,
    averageFillPriceCents: 28, outcome: "full_fill",
  });
  await store.appendEth30PositionEvent({
    id: `${SETTLED_TICKER2}:settlement`, ticker: SETTLED_TICKER2, easternDate: WARMUP_DATE,
    eventType: "settlement", contractsDelta: -4, contractsAfter: 0, strategyOrderId: null,
    fillPriceCents: null, feeCents: null, settlementResult: "yes",
    note: "market settled yes; 4 owned contracts closed at settlement",
    occurredAtMs: 200,
  });
  ex.orders.set("ko-ws", { status: "filled", fillCount: 4, fills: [] });
  ex.markets.set(SETTLED_TICKER2, { result: "yes" });

  const prevEnabled = process.env["ETH_30_50_ENABLED"];
  process.env["ETH_30_50_ENABLED"] = "true";
  _setEth30NowForTesting(() => new Date("2026-08-16T14:00:00Z"));
  _setEth30StoreForTesting(store);
  _setEth30KalshiFetchForTesting(ex.fetch as never);

  try {
    // ── Simulate storage degradation: listSettledEth30Tickers throws ─────────
    const baseListSettled = store.listSettledEth30Tickers.bind(store);
    store.listSettledEth30Tickers = async () => {
      throw new Error("simulated DB error during warmup query");
    };

    // Act: warmup must not throw despite the storage error.
    await assert.doesNotReject(
      () => warmEth30SettledTickersCache(),
      "warmEth30SettledTickersCache must never throw even when the underlying query fails",
    );

    // Restore the real implementation so the sweep can still read position events.
    store.listSettledEth30Tickers = baseListSettled;

    // Instrument listEth30PositionEvents to verify the fallback path is used.
    let positionEventCallCount = 0;
    const baseListEvents = store.listEth30PositionEvents.bind(store);
    store.listEth30PositionEvents = async (ticker: string) => {
      if (ticker === SETTLED_TICKER2) positionEventCallCount++;
      return baseListEvents(ticker);
    };

    // The sweep must still correctly identify and skip the settled ticker via
    // per-ticker reads (the cache is cold after the failed warmup).
    await _runEth30PeriodicReconcileSweepForTesting();

    // The settled ticker must have been read at least once (fallback path),
    // but reconcileEth30OwnedOrders must NOT have been called for it
    // (settlement branch catches it before proceeding to reconcile).
    assert.ok(
      positionEventCallCount >= 1,
      "with a cold cache, the sweep must still call listEth30PositionEvents as a fallback for the settled ticker",
    );

    // Verify settlement was not re-written (the ticker already has a settlement
    // event; reconcileEth30Settlements correctly short-circuits it).
    const events = await baseListEvents(SETTLED_TICKER2);
    const settlements = events.filter((e) => e.eventType === "settlement");
    assert.equal(settlements.length, 1, "settled ticker must have exactly one settlement event after the sweep");
  } finally {
    _setEth30NowForTesting(null);
    _setEth30StoreForTesting(null);
    _setEth30KalshiFetchForTesting(null);
    if (prevEnabled === undefined) delete process.env["ETH_30_50_ENABLED"];
    else process.env["ETH_30_50_ENABLED"] = prevEnabled;
  }
});
