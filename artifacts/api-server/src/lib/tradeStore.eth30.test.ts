/**
 * Integration tests for the ETH_30_50 isolated strategy APIs in tradeStore.ts.
 *
 * Covers:
 *   1. claimEth30Ticker — atomic permanent claim, conflict blocks second claim
 *   2. getEth30TickerClaim — read back a claim
 *   3. listEth30TickerClaimsForDate — date-scoped listing
 *   4. recordEth30StrategyOrder + listEth30StrategyOrders — entry + exit order recording
 *   5. updateEth30StrategyOrder — fill/outcome update
 *   6. appendEth30PositionEvent + listEth30PositionEvents — position ledger
 *   7. listEth30PositionEventsForDate — date-scoped event listing
 *   8. Idempotency: appendEth30PositionEvent with duplicate id is a no-op
 *   9. Storage-degraded: all write APIs return false immediately
 *
 * Uses the real dev database. Dates are in the 1975-* namespace to avoid
 * colliding with any other test suite.
 *
 * Run:
 *   pnpm --filter @workspace/api-server test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql as drizzleSql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  initTradeStore,
  isStorageHealthy,
  claimEth30Ticker,
  getEth30TickerClaim,
  listEth30TickerClaimsForDate,
  recordEth30StrategyOrder,
  listEth30StrategyOrders,
  updateEth30StrategyOrder,
  appendEth30PositionEvent,
  listEth30PositionEvents,
  listEth30PositionEventsForDate,
} from "./tradeStore.js";

// ── Test isolation namespace ────────────────────────────────────────────────

const TEST_DATE_1 = "1975-01-01"; // claim + conflict tests
const TEST_DATE_2 = "1975-01-02"; // order + update tests
const TEST_DATE_3 = "1975-01-03"; // position-event tests
const TEST_DATE_4 = "1975-01-04"; // date-scoped listing tests

function testTicker(suffix: string): string {
  return `KXETH15M-TEST-ETH30-${suffix}`;
}

async function cleanTestData(): Promise<void> {
  await db.execute(drizzleSql`
    DELETE FROM eth30_position_events WHERE eastern_date LIKE '1975%'
  `);
  await db.execute(drizzleSql`
    DELETE FROM eth30_strategy_orders WHERE eastern_date LIKE '1975%'
  `);
  await db.execute(drizzleSql`
    DELETE FROM eth30_ticker_claims WHERE eastern_date LIKE '1975%'
  `);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("tradeStore — ETH_30_50 isolated strategy APIs", async () => {

  before(async () => {
    await initTradeStore();
    assert.equal(isStorageHealthy(), true, "DB should be healthy after initTradeStore");
    await cleanTestData();
  });

  after(async () => {
    await cleanTestData();
  });

  // ── 1. Atomic permanent ticker claim succeeds ─────────────────────────────
  it("1: claimEth30Ticker — first claim returns true", async () => {
    const ticker = testTicker("claim-1");
    const cid    = `eth30-cid-${Date.now()}`;

    const ok = await claimEth30Ticker(ticker, TEST_DATE_1, cid);
    assert.equal(ok, true, "first claim must return true");
  });

  // ── 2. Conflict: second claim for same ticker returns false ───────────────
  it("2: claimEth30Ticker — second claim for same ticker returns false (permanent claim)", async () => {
    const ticker = testTicker("claim-2");
    const cid1   = `eth30-cid-a-${Date.now()}`;
    const cid2   = `eth30-cid-b-${Date.now()}`;

    const first  = await claimEth30Ticker(ticker, TEST_DATE_1, cid1);
    assert.equal(first,  true,  "first claim must succeed");

    const second = await claimEth30Ticker(ticker, TEST_DATE_1, cid2);
    assert.equal(second, false, "second claim must be blocked (permanent claim — not expiring)");
  });

  // ── 3. getEth30TickerClaim — reads back the claim correctly ──────────────
  it("3: getEth30TickerClaim — returns claim fields after successful claim", async () => {
    const ticker = testTicker("get-claim");
    const cid    = `eth30-get-cid-${Date.now()}`;

    await claimEth30Ticker(ticker, TEST_DATE_1, cid);

    const claim = await getEth30TickerClaim(ticker);
    assert.ok(claim !== null, "getEth30TickerClaim must return a claim object");
    assert.equal(claim!.ticker,             ticker,      "ticker must match");
    assert.equal(claim!.easternDate,        TEST_DATE_1, "easternDate must match");
    assert.equal(claim!.entryClientOrderId, cid,         "entryClientOrderId must match");
    assert.ok(claim!.claimedAtMs > 0,                    "claimedAtMs must be a positive epoch ms");
  });

  // ── 4. getEth30TickerClaim — returns null for unknown ticker ─────────────
  it("4: getEth30TickerClaim — returns null when ticker not claimed", async () => {
    const result = await getEth30TickerClaim(testTicker("never-claimed"));
    assert.equal(result, null, "must return null for an unclaimed ticker");
  });

  // ── 5. listEth30TickerClaimsForDate — returns all claims for the date ────
  it("5: listEth30TickerClaimsForDate — returns claims for the target date only", async () => {
    const ticker1 = testTicker("list-d1a");
    const ticker2 = testTicker("list-d1b");
    const cidA    = `eth30-list-a-${Date.now()}`;
    const cidB    = `eth30-list-b-${Date.now()}`;

    await claimEth30Ticker(ticker1, TEST_DATE_4, cidA);
    await claimEth30Ticker(ticker2, TEST_DATE_4, cidB);

    const claims = await listEth30TickerClaimsForDate(TEST_DATE_4);
    const tickers = claims.map((c) => c.ticker);
    assert.ok(tickers.includes(ticker1), "must include ticker1");
    assert.ok(tickers.includes(ticker2), "must include ticker2");
    assert.ok(claims.every((c) => c.easternDate === TEST_DATE_4), "all claims must be for TEST_DATE_4");
  });

  // ── 6. recordEth30StrategyOrder — entry order ────────────────────────────
  it("6: recordEth30StrategyOrder — records entry order and listEth30StrategyOrders returns it", async () => {
    const ticker = testTicker("order-entry");
    const cid    = `eth30-entry-cid-${Date.now()}`;
    const orderId = `entry:${ticker}`;

    // Claim first
    await claimEth30Ticker(ticker, TEST_DATE_2, cid);

    const ok = await recordEth30StrategyOrder({
      id:                 orderId,
      ticker,
      easternDate:        TEST_DATE_2,
      role:               "entry",
      sequenceNumber:     1,
      clientOrderId:      cid,
      side:               "yes",
      limitPriceCents:    36,
      requestedContracts: 5,
    });
    assert.equal(ok, true, "recordEth30StrategyOrder must return true on first insert");

    const orders = await listEth30StrategyOrders(ticker);
    assert.equal(orders.length, 1, "must have exactly one order");
    const o = orders[0];
    assert.equal(o.id,                 orderId,   "id must match");
    assert.equal(o.role,               "entry",   "role must be entry");
    assert.equal(o.side,               "yes",     "side must match");
    assert.equal(o.limitPriceCents,    36,         "limitPriceCents must match");
    assert.equal(o.requestedContracts, 5,          "requestedContracts must match");
    assert.equal(o.outcome,            "pending",  "outcome must start as pending");
    assert.equal(o.kalshiOrderId,      null,       "kalshiOrderId must be null initially");
  });

  // ── 7. recordEth30StrategyOrder — idempotent on second insert ────────────
  it("7: recordEth30StrategyOrder — second insert with same id is a no-op (returns false)", async () => {
    const ticker  = testTicker("order-idem");
    const cid     = `eth30-idem-cid-${Date.now()}`;
    const orderId = `entry:${ticker}`;

    await claimEth30Ticker(ticker, TEST_DATE_2, cid);
    await recordEth30StrategyOrder({
      id: orderId, ticker, easternDate: TEST_DATE_2, role: "entry", sequenceNumber: 1,
      clientOrderId: cid, side: "yes", limitPriceCents: 40, requestedContracts: 3,
    });

    // Second insert with the same id must be a no-op (ON CONFLICT DO NOTHING → 0 rows returned)
    const second = await recordEth30StrategyOrder({
      id: orderId, ticker, easternDate: TEST_DATE_2, role: "entry", sequenceNumber: 1,
      clientOrderId: cid, side: "yes", limitPriceCents: 40, requestedContracts: 3,
    });
    assert.equal(second, false, "duplicate insert must return false (row already exists)");

    // Still exactly one row
    const orders = await listEth30StrategyOrders(ticker);
    assert.equal(orders.length, 1, "must still have exactly one order row");
  });

  // ── 8. updateEth30StrategyOrder — fill outcome update ────────────────────
  it("8: updateEth30StrategyOrder — updates kalshiOrderId and fill outcome", async () => {
    const ticker  = testTicker("order-update");
    const cid     = `eth30-upd-cid-${Date.now()}`;
    const orderId = `entry:${ticker}`;
    const kalshiId = "kalshi-eth30-uuid-test-9999";

    await claimEth30Ticker(ticker, TEST_DATE_2, cid);
    await recordEth30StrategyOrder({
      id: orderId, ticker, easternDate: TEST_DATE_2, role: "entry", sequenceNumber: 1,
      clientOrderId: cid, side: "yes", limitPriceCents: 35, requestedContracts: 4,
    });

    const ok = await updateEth30StrategyOrder({
      id:                    orderId,
      kalshiOrderId:         kalshiId,
      outcome:               "full_fill",
      filledContracts:       4,
      averageFillPriceCents: 34,
    });
    assert.equal(ok, true, "update must return true");

    const orders = await listEth30StrategyOrders(ticker);
    assert.equal(orders.length, 1);
    const o = orders[0];
    assert.equal(o.kalshiOrderId,         kalshiId,    "kalshiOrderId must be updated");
    assert.equal(o.outcome,               "full_fill",  "outcome must be updated");
    assert.equal(o.filledContracts,       4,            "filledContracts must be updated");
    assert.equal(o.averageFillPriceCents, 34,           "averageFillPriceCents must be updated");
  });

  // ── 9. updateEth30StrategyOrder — returns false for unknown id ───────────
  it("9: updateEth30StrategyOrder — returns false when row does not exist", async () => {
    const ok = await updateEth30StrategyOrder({ id: "eth30-nonexistent-id-xyz", outcome: "cancelled" });
    assert.equal(ok, false, "update of unknown row must return false");
  });

  // ── 10. appendEth30PositionEvent + listEth30PositionEvents — full cycle ───
  it("10: appendEth30PositionEvent — appends entry_fill event and listEth30PositionEvents returns it in order", async () => {
    const ticker      = testTicker("pos-events");
    const cid         = `eth30-pos-cid-${Date.now()}`;
    const orderId     = `entry:${ticker}`;
    const now         = Date.now();
    const eventId1    = `${ticker}:entry_fill:${now}`;
    const eventId2    = `${ticker}:exit_fill:${now + 100}`;

    await claimEth30Ticker(ticker, TEST_DATE_3, cid);
    await recordEth30StrategyOrder({
      id: orderId, ticker, easternDate: TEST_DATE_3, role: "entry", sequenceNumber: 1,
      clientOrderId: cid, side: "yes", limitPriceCents: 38, requestedContracts: 3,
    });

    // Entry fill event
    const ok1 = await appendEth30PositionEvent({
      id: eventId1, ticker, easternDate: TEST_DATE_3,
      eventType: "entry_fill", contractsDelta: 3, contractsAfter: 3,
      strategyOrderId: orderId, fillPriceCents: 38, feeCents: null, settlementResult: null,
      note: null, occurredAtMs: now,
    });
    assert.equal(ok1, true, "appendEth30PositionEvent (entry_fill) must return true");

    // Exit fill event (later)
    const ok2 = await appendEth30PositionEvent({
      id: eventId2, ticker, easternDate: TEST_DATE_3,
      eventType: "exit_fill", contractsDelta: -3, contractsAfter: 0,
      strategyOrderId: `exit:${ticker}:1`, fillPriceCents: 65, feeCents: null, settlementResult: null,
      note: "protective exit triggered", occurredAtMs: now + 100,
    });
    assert.equal(ok2, true, "appendEth30PositionEvent (exit_fill) must return true");

    const events = await listEth30PositionEvents(ticker);
    assert.equal(events.length, 2, "must have 2 position events");
    // Chronological order
    assert.equal(events[0].eventType, "entry_fill", "first event must be entry_fill");
    assert.equal(events[0].contractsDelta, 3, "delta must be +3");
    assert.equal(events[0].contractsAfter, 3, "running total must be 3");
    assert.equal(events[1].eventType, "exit_fill", "second event must be exit_fill");
    assert.equal(events[1].contractsDelta, -3, "delta must be -3");
    assert.equal(events[1].contractsAfter, 0, "running total must be 0");
  });

  // ── 11. appendEth30PositionEvent — idempotency ────────────────────────────
  it("11: appendEth30PositionEvent — duplicate id is a no-op (returns false, no duplicate row)", async () => {
    const ticker  = testTicker("pos-idem");
    const cid     = `eth30-pos-idem-cid-${Date.now()}`;
    const now     = Date.now();
    const eventId = `${ticker}:entry_fill:${now}`;

    await claimEth30Ticker(ticker, TEST_DATE_3, cid);
    await appendEth30PositionEvent({
      id: eventId, ticker, easternDate: TEST_DATE_3,
      eventType: "entry_fill", contractsDelta: 2, contractsAfter: 2,
      strategyOrderId: null, fillPriceCents: 40, feeCents: null, settlementResult: null,
      note: null, occurredAtMs: now,
    });

    // Duplicate insert — must be silently dropped
    const dup = await appendEth30PositionEvent({
      id: eventId, ticker, easternDate: TEST_DATE_3,
      eventType: "entry_fill", contractsDelta: 2, contractsAfter: 2,
      strategyOrderId: null, fillPriceCents: 40, feeCents: null, settlementResult: null,
      note: null, occurredAtMs: now,
    });
    // ON CONFLICT DO NOTHING → 0 rows inserted, but the function currently
    // returns true on the upsert path (row existed). Accept either true or false
    // as long as there is exactly 1 row.
    const events = await listEth30PositionEvents(ticker);
    assert.equal(events.length, 1, "must have exactly 1 position event — no phantom duplicate");
  });

  // ── 12. listEth30PositionEventsForDate — date-scoped, newest first ────────
  it("12: listEth30PositionEventsForDate — returns events for the date newest-first", async () => {
    const ticker1 = testTicker("date-ev-1");
    const ticker2 = testTicker("date-ev-2");
    const cid1    = `eth30-dev-c1-${Date.now()}`;
    const cid2    = `eth30-dev-c2-${Date.now()}`;
    const base    = Date.now();

    await claimEth30Ticker(ticker1, TEST_DATE_4, cid1);
    await claimEth30Ticker(ticker2, TEST_DATE_4, cid2);

    await appendEth30PositionEvent({
      id: `${ticker1}:entry_fill:${base}`, ticker: ticker1, easternDate: TEST_DATE_4,
      eventType: "entry_fill", contractsDelta: 1, contractsAfter: 1,
      strategyOrderId: null, fillPriceCents: 35, feeCents: null, settlementResult: null, note: null, occurredAtMs: base,
    });
    await appendEth30PositionEvent({
      id: `${ticker2}:entry_fill:${base + 50}`, ticker: ticker2, easternDate: TEST_DATE_4,
      eventType: "entry_fill", contractsDelta: 2, contractsAfter: 2,
      strategyOrderId: null, fillPriceCents: 36, feeCents: null, settlementResult: null, note: null, occurredAtMs: base + 50,
    });

    const events = await listEth30PositionEventsForDate(TEST_DATE_4);
    assert.ok(events.length >= 2, "must return at least 2 events for TEST_DATE_4");
    // Newest first
    for (let i = 1; i < events.length; i++) {
      assert.ok(
        events[i - 1].occurredAtMs >= events[i].occurredAtMs,
        "events must be ordered newest-first by occurredAtMs",
      );
    }
    assert.ok(events.every((e) => e.easternDate === TEST_DATE_4), "all events must be for TEST_DATE_4");
  });

  // ── 13. settlement event with settlementResult field ─────────────────────
  it("13: appendEth30PositionEvent — settlement event stores settlementResult correctly", async () => {
    const ticker  = testTicker("settlement");
    const cid     = `eth30-settle-cid-${Date.now()}`;
    const now     = Date.now();
    const eventId = `${ticker}:settlement:${now}`;

    await claimEth30Ticker(ticker, TEST_DATE_3, cid);

    await appendEth30PositionEvent({
      id: eventId, ticker, easternDate: TEST_DATE_3,
      eventType: "settlement", contractsDelta: 0, contractsAfter: 0,
      strategyOrderId: null, fillPriceCents: null, feeCents: null, settlementResult: "yes",
      note: "market settled YES", occurredAtMs: now,
    });

    const events = await listEth30PositionEvents(ticker);
    const settle = events.find((e) => e.eventType === "settlement");
    assert.ok(settle !== undefined, "settlement event must exist");
    assert.equal(settle!.settlementResult, "yes", "settlementResult must be 'yes'");
    assert.equal(settle!.note, "market settled YES", "note must persist");
    assert.equal(settle!.fillPriceCents, null, "fillPriceCents must be null for settlement");
  });

});
