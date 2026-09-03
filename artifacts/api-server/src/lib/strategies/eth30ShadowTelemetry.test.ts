import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  observeEth30ShadowTelemetry, refreshEth30ShadowOutcomes, _resetEth30ShadowTelemetryForTesting, type Eth30ShadowStore,
} from "./eth30ShadowTelemetry.js";
import type { Eth30PositionEventParams, Eth30ShadowEventParams, Eth30ShadowObservationParams, Eth30StrategyOrder } from "../tradeStore.js";
import type { KalshiOrderbookRaw } from "../orderbookParsing.js";

const TICKER = "KXETH15M-26AUG161200-15";
const ENTRY_MS = Date.parse("2026-08-26T12:00:00Z");
const CLOSE = "2026-08-26T12:15:00Z";
const orders: Eth30StrategyOrder[] = [{
  id: `entry:${TICKER}`, ticker: TICKER, easternDate: "2026-08-26", role: "entry", sequenceNumber: 1,
  clientOrderId: "entry", kalshiOrderId: "entry-k", side: "yes", limitPriceCents: 25,
  requestedContracts: 4, outcome: "full_fill", filledContracts: 4, averageFillPriceCents: 25, updatedAtMs: ENTRY_MS,
}];
function positionEvents(): Eth30PositionEventParams[] {
  return [{ id: `${TICKER}:entry`, ticker: TICKER, easternDate: "2026-08-26", eventType: "entry_fill",
    contractsDelta: 4, contractsAfter: 4, strategyOrderId: `entry:${TICKER}`, fillPriceCents: 25,
    feeCents: 0, settlementResult: null, note: null, occurredAtMs: ENTRY_MS }];
}
function createStore(): { store: Eth30ShadowStore; observations: Eth30ShadowObservationParams[]; events: Eth30ShadowEventParams[] } {
  const observations: Eth30ShadowObservationParams[] = [];
  const events: Eth30ShadowEventParams[] = [];
  const store: Eth30ShadowStore = {
    listEth30StrategyOrders: async () => orders,
    listEth30PositionEvents: async () => positionEvents(),
    listEth30ShadowObservations: async (_ticker, afterMs = 0) => observations.filter((row) => row.observedAtMs >= afterMs),
    listEth30ShadowEvents: async () => events,
    insertEth30ShadowObservation: async (row) => {
      if (observations.some((old) => old.id === row.id)) return false;
      observations.push(row); return true;
    },
    upsertEth30ShadowEvent: async (row) => {
      const index = events.findIndex((old) => old.id === row.id);
      if (index >= 0) events[index] = row; else events.push(row);
    },
  };
  return { store, observations, events };
}
const raw: KalshiOrderbookRaw = { orderbook_fp: { yes_dollars: [["0.1400", "10"]], no_dollars: [] } };

test("shadow telemetry is passive, checkpoint-deduplicated, and carries causal BBO/L2 evidence", async () => {
  _resetEth30ShadowTelemetryForTesting();
  const { store, observations, events } = createStore();
  let submits = 0;
  const deps = {
    store,
    getEthReference: async (at: number) => ({ price: at < ENTRY_MS + 780_000 ? 3_000 : 2_970, sourceTimestampMs: at }),
    fetchOrderbookRaw: async () => { submits += 1; return raw; },
  };
  // Seed causal 60s/30s references, then hit the T−120 checkpoint.
  await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 715_000, yesBid: 14, noBid: 86 });
  await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 750_000, yesBid: 14, noBid: 86 });
  await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 780_000, yesBid: 14, noBid: 86 });
  await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 780_000, yesBid: 14, noBid: 86 });
  assert.equal(events.filter((row) => row.signal === "t_minus_120_adverse_momentum").length, 1);
  assert.equal(submits, 3, "the repeated same-bucket evaluation makes no additional L2 read");
  assert.equal(orders[0]!.requestedContracts, 4, "passive observer cannot change owned/order quantity");
  const payload = JSON.parse(events[0]!.payloadJson) as Record<string, unknown>;
  assert.equal(payload.label, "SHADOW_ONLY_NOT_EXECUTED");
  assert.equal(payload.executableSellBestCents, 14);
  assert.equal(payload.entryFillPriceCents, 25);
  assert.equal(payload.heldSideBboCents, 14);
  assert.equal(payload.target50OrderStatus, "not_posted");
  assert.equal(payload.signedEthMove30s, -30);
  assert.equal(payload.signedEthMove60s, -30);
  assert.equal(payload.hypotheticalGrossExitValueCents, 56);
  assert.equal(payload.hypotheticalGrossExitPnlCents, -44);
  assert.ok(observations.length >= 2);
});

test("shadow telemetry stops before market reads after the owned position is fully exited", async () => {
  _resetEth30ShadowTelemetryForTesting();
  const { store, events } = createStore();
  store.listEth30PositionEvents = async () => [
    ...positionEvents(),
    { id: `${TICKER}:exit`, ticker: TICKER, easternDate: "2026-08-26", eventType: "exit_fill",
      contractsDelta: -4, contractsAfter: 0, strategyOrderId: "exit", fillPriceCents: 50,
      feeCents: 0, settlementResult: null, note: null, occurredAtMs: ENTRY_MS + 700_000 },
  ];
  let referenceReads = 0;
  let bookReads = 0;
  await observeEth30ShadowTelemetry({
    store,
    getEthReference: async (at) => { referenceReads += 1; return { price: 3_000, sourceTimestampMs: at }; },
    fetchOrderbookRaw: async () => { bookReads += 1; return raw; },
  }, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 780_000 });
  assert.equal(referenceReads, 0);
  assert.equal(bookReads, 0);
  assert.equal(events.length, 0);
});

test("NO momentum is signed to the held outcome and durable replay does not duplicate an event", async () => {
  _resetEth30ShadowTelemetryForTesting();
  const { store, events } = createStore();
  const originalSide = orders[0]!.side;
  orders[0]!.side = "no";
  try {
    const deps = {
      store, getEthReference: async (at: number) => ({ price: at < ENTRY_MS + 780_000 ? 3_000 : 3_030, sourceTimestampMs: at }),
      fetchOrderbookRaw: async () => raw,
    };
    await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 750_000, noBid: 14 });
    await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 780_000, noBid: 14 });
    assert.equal(events.length, 1);
    assert.equal((JSON.parse(events[0]!.payloadJson) as Record<string, unknown>).signedEthMove30s, -30);
    _resetEth30ShadowTelemetryForTesting(); // emulate process restart with durable rows retained
    await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 785_000, noBid: 14 });
    assert.equal(events.length, 1, "stable durable event ID prevents a replay duplicate");
  } finally {
    orders[0]!.side = originalSide;
  }
});

test("shadow telemetry coalesces high-frequency calls and preserves first trigger evidence", async () => {
  _resetEth30ShadowTelemetryForTesting();
  const { store, events } = createStore();
  let reads = 0;
  const deps = {
    store, getEthReference: async (at: number) => ({ price: at < ENTRY_MS + 780_000 ? 3_000 : 2_970, sourceTimestampMs: at }),
    fetchOrderbookRaw: async () => { reads += 1; return raw; },
  };
  // Seed a causal reference more than 30 seconds before the checkpoint.
  await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 750_000 });
  await Promise.all(Array.from({ length: 20 }, () =>
    observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 780_000 })));
  assert.equal(reads, 2, "a burst adds one capture instead of issuing one book read per quote");
  assert.equal(events.length, 1);
  const firstAt = events[0]!.triggeredAtMs;
  await observeEth30ShadowTelemetry(deps, { ticker: TICKER, closeTime: CLOSE, observedAtMs: ENTRY_MS + 781_000 });
  assert.equal(reads, 2, "same five-second bucket remains throttled before all I/O");
  assert.equal(events[0]!.triggeredAtMs, firstAt, "first causal trigger timestamp is immutable");
});

test("shadow telemetry cannot cross-attribute SOL and refreshes later actual outcome fields", async () => {
  _resetEth30ShadowTelemetryForTesting();
  const { store, events } = createStore();
  await observeEth30ShadowTelemetry({
    store, getEthReference: async (at) => ({ price: at < ENTRY_MS + 780_000 ? 3_000 : 2_970, sourceTimestampMs: at }),
    fetchOrderbookRaw: async () => raw,
  }, { ticker: "KXSOL15M-26AUG161200-15", closeTime: CLOSE, observedAtMs: ENTRY_MS + 780_000 });
  assert.equal(events.length, 0);
  events.push({ id: `${TICKER}:shadow:t_minus_120_adverse_momentum`, ticker: TICKER,
    signal: "t_minus_120_adverse_momentum", triggeredAtMs: ENTRY_MS + 780_000, payloadJson: "{}" });
  await refreshEth30ShadowOutcomes(store, TICKER);
  const payload = JSON.parse(events[0]!.payloadJson) as Record<string, unknown>;
  assert.equal(payload.actualTarget50FilledContracts, 0);
  assert.equal(payload.settlementResult, null);
  const settled = positionEvents();
  settled.push({ id: `${TICKER}:settlement`, ticker: TICKER, easternDate: "2026-08-26", eventType: "settlement",
    contractsDelta: -4, contractsAfter: 0, strategyOrderId: null, fillPriceCents: null, feeCents: null,
    settlementResult: "yes", note: null, occurredAtMs: ENTRY_MS + 900_000 });
  store.listEth30PositionEvents = async () => settled;
  await store.insertEth30ShadowObservation({ id: `${TICKER}:shadow:last`, ticker: TICKER, observedAtMs: ENTRY_MS + 895_000, payloadJson: JSON.stringify({ rawExitBidLevels: [{ priceCents: 14 }] }) });
  await refreshEth30ShadowOutcomes(store, TICKER);
  const settlementRows = await store.listEth30ShadowObservations(TICKER);
  const settlementPayload = JSON.parse(settlementRows.at(-1)!.payloadJson) as Record<string, unknown>;
  assert.equal(settlementPayload.observationKind, "settlement_outcome");
  assert.equal(settlementPayload.settlementResult, "yes");
});

test("shadow module has no order-path imports", () => {
  const source = readFileSync("src/lib/strategies/eth30ShadowTelemetry.ts", "utf8");
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];?$/gm)].map((match) => match[1] ?? "");
  for (const forbidden of ["kalshiAuth", "kalshi", "eth30_50", "targetLiquidity", "trade.ts"]) {
    assert.equal(imports.some((path) => path.includes(forbidden)), false, `passive module must not import ${forbidden}`);
  }
});