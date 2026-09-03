import assert from "node:assert/strict";
import test from "node:test";
import {
  planSol30CanonicalFillLedger, sol30SettlementReadiness, buildSol30AuthoritativeFillChunks,
  SOL30_CHUNK_EVIDENCE_NOTE,
  type Sol30AuthoritativeFillChunk, type Sol30OwnedOrderRef, type Sol30PositionEventParams,
} from "./sol30FillSync.js";
import { computeSol30Report } from "./sol30Report.js";
import type { Sol30TickerClaim, Sol30StrategyOrder } from "./sol30Report.js";
import type { KalshiFillWire } from "../kalshiFillNormalizer.js";

const TICKER = "KXSOL15M-26AUG161200-15";
const entryRef: Sol30OwnedOrderRef = {
  id: `entry:${TICKER}`, ticker: TICKER, easternDate: "2026-08-16", role: "entry", filledContracts: 8,
};
const exitRef: Sol30OwnedOrderRef = {
  id: `exit:${TICKER}:1`, ticker: TICKER, easternDate: "2026-08-16", role: "exit", filledContracts: 6,
};
function chunk(fillId: string, contracts: number, priceCents: number, at: number, feeCents: number | null = null): Sol30AuthoritativeFillChunk {
  return { fillId, contracts, fillPriceCents: priceCents, feeCents, occurredAtMs: at };
}
function legacyEvent(id: string, orderId: string, delta: number, after: number, price: number): Sol30PositionEventParams {
  return {
    id, ticker: TICKER, easternDate: "2026-08-16",
    eventType: delta >= 0 ? "entry_fill" : "exit_fill", contractsDelta: delta, contractsAfter: after,
    strategyOrderId: orderId, fillPriceCents: price, feeCents: null, settlementResult: null,
    note: "entry_ioc_ack", occurredAtMs: 50,
  };
}

// Shared fixtures for fee-backfill tests.
const existingFeeNull: Sol30PositionEventParams = {
  id: `${TICKER}:entry_fill:f1`,
  ticker: TICKER, easternDate: "2026-08-16", eventType: "entry_fill",
  contractsDelta: 5, contractsAfter: 5, strategyOrderId: entryRef.id,
  fillPriceCents: 28, feeCents: null, // ← pre-column value
  settlementResult: null, note: SOL30_CHUNK_EVIDENCE_NOTE, occurredAtMs: 100,
};
const chunkWithFee = { ...chunk("f1", 5, 28, 100), feeCents: 3 };

// Minimal valid wire record shared by the fee path tests below.
const BASE_FILL: KalshiFillWire = {
  fill_id: "f-fee-test",
  count_fp: "1",
  yes_price_dollars: "0.80",
};

test("SOL_30_50 multi-level IOC entry records each chunk at its actual execution price", () => {
  // One IOC swept two L2 levels: 5 @ 28¢ and 3 @ 30¢. The scanned book-lowest
  // was 28¢ — recording all 8 contracts at 28¢ would understate cost by 6¢.
  const chunks = new Map([[entryRef.id, [chunk("f1", 5, 28, 100), chunk("f2", 3, 30, 101)]]]);
  const plan = planSol30CanonicalFillLedger([entryRef], [], chunks);
  assert.deepEqual(plan.deferredOrderIds, []);
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.appends.map((e) => [e.contractsDelta, e.fillPriceCents, e.contractsAfter]),
    [[5, 28, 5], [3, 30, 8]]);
  assert.equal(plan.appends[0].id, `${TICKER}:entry_fill:f1`);
  assert.equal(plan.appends[0].note, SOL30_CHUNK_EVIDENCE_NOTE);
  // Replay with the canonical events already present is a no-op.
  const replay = planSol30CanonicalFillLedger([entryRef], plan.appends, chunks);
  assert.deepEqual([replay.deleteIds, replay.appends], [[], []]);
});

test("SOL_30_50 legacy approximate event at the wrong price is replaced wholesale, never blended", () => {
  // Legacy ack-time event recorded all 6 contracts at the book-lowest 28¢;
  // authoritative chunks show 5 @ 28¢ + 3 @ 30¢. The legacy event must be
  // deleted and both chunks appended — total stays exactly 8 contracts.
  const legacy = legacyEvent(`${TICKER}:entry_fill:legacy-coid`, entryRef.id, 6, 6, 28);
  const chunks = new Map([[entryRef.id, [chunk("f1", 5, 28, 100), chunk("f2", 3, 30, 101)]]]);
  const plan = planSol30CanonicalFillLedger([entryRef], [legacy], chunks);
  assert.deepEqual(plan.deleteIds, [legacy.id]);
  assert.equal(plan.appends.reduce((s, e) => s + e.contractsDelta, 0), 8);
  assert.deepEqual(plan.appends.map((e) => e.fillPriceCents), [28, 30]);
});

test("SOL_30_50 legacy total falling inside a chunk boundary cannot overcount", () => {
  // Legacy event recorded 6 of the 8 contracts — a total that ends INSIDE the
  // second authoritative chunk (5 + 3). Wholesale replacement sidesteps
  // overlap arithmetic: ledger ends at exactly 8 contracts, never 5+3+6.
  const legacy = legacyEvent(`${TICKER}:entry_fill:legacy-coid`, entryRef.id, 6, 6, 28);
  const chunks = new Map([[entryRef.id, [chunk("f1", 5, 28, 100), chunk("f2", 3, 30, 101)]]]);
  const plan = planSol30CanonicalFillLedger([entryRef], [legacy], chunks);
  assert.deepEqual(plan.deleteIds, [legacy.id]);
  assert.deepEqual(plan.appends.map((e) => e.contractsDelta), [5, 3]);
  assert.equal(plan.appends.at(-1)!.contractsAfter, 8);
});

test("SOL_30_50 incomplete chunk coverage defers the whole ticker — nothing is written", () => {
  // Exit order reports 6 filled but the fills endpoint only evidenced 4.
  const plan = planSol30CanonicalFillLedger(
    [entryRef, exitRef],
    [],
    new Map([
      [entryRef.id, [chunk("f1", 5, 28, 100), chunk("f2", 3, 30, 101)]],
      [exitRef.id,  [chunk("x1", 2, 50, 200), chunk("x2", 2, 50, 201)]], // only 4 of 6
    ]),
  );
  assert.deepEqual(plan.deferredOrderIds, [exitRef.id]);
  assert.deepEqual([plan.deleteIds, plan.appends], [[], []]);
  // Fetch failure (null) defers the same way.
  const failed = planSol30CanonicalFillLedger([entryRef], [], new Map([[entryRef.id, null]]));
  assert.deepEqual(failed.deferredOrderIds, [entryRef.id]);
});

test("SOL_30_50 settlement is gated on chunk evidence only — legacy events never satisfy readiness", () => {
  const chunks = new Map([[entryRef.id, [chunk("f1", 5, 28, 100), chunk("f2", 3, 30, 101)]]]);
  const entryEvents = planSol30CanonicalFillLedger([entryRef], [], chunks).appends;
  const orders = [
    { id: entryRef.id, filledContracts: 8 },
    { id: exitRef.id, filledContracts: 6 },
  ];
  // Mid-session target fill known to the order row but not yet evidenced.
  const before = sol30SettlementReadiness(orders, entryEvents);
  assert.equal(before.ready, false);
  assert.deepEqual(before.missingOrderIds, [exitRef.id]);
  assert.equal(before.openContracts, 8);

  // A legacy approximate event covering the exit does NOT make it ready.
  const legacyExit = legacyEvent(`${TICKER}:exit_fill:legacy`, exitRef.id, -6, 2, 50);
  const withLegacy = sol30SettlementReadiness(orders, [...entryEvents, legacyExit]);
  assert.equal(withLegacy.ready, false);
  assert.equal(withLegacy.hasLegacyEvents, true);
  assert.deepEqual(withLegacy.missingOrderIds, [exitRef.id]);

  // Only canonical exit chunks unlock settlement, on the true remainder.
  const allChunks = new Map([
    [entryRef.id, [chunk("f1", 5, 28, 100), chunk("f2", 3, 30, 101)]],
    [exitRef.id, [chunk("x1", 2, 50, 200), chunk("x2", 4, 50, 201)]],
  ]);
  const fullLedger = planSol30CanonicalFillLedger([entryRef, exitRef], [], allChunks).appends;
  const after = sol30SettlementReadiness(orders, fullLedger);
  assert.equal(after.ready, true);
  assert.equal(after.openContracts, 2); // 8 entry - 6 exit = 2 remain
  assert.equal(after.hasLegacyEvents, false);
});

test("SOL_30_50 end to end: canonical chunks + gated settlement produce exact strategy-only P&L", () => {
  // Entry 5@28¢ + 3@30¢, exit 2@50¢ + 4@50¢, 2 remaining settle YES.
  // entryCostCents = 5×28 + 3×30 = 230, exitProceeds = 300, settlementPayout = 200.
  const allChunks = new Map([
    [entryRef.id, [chunk("f1", 5, 28, 100), chunk("f2", 3, 30, 101)]],
    [exitRef.id, [chunk("x1", 2, 50, 200), chunk("x2", 4, 50, 201)]],
  ]);
  const ledger = planSol30CanonicalFillLedger([entryRef, exitRef], [], allChunks).appends;
  const settlement: Sol30PositionEventParams = {
    id: `${TICKER}:settlement`, ticker: TICKER, easternDate: "2026-08-16",
    eventType: "settlement", contractsDelta: -2, contractsAfter: 0, strategyOrderId: null,
    fillPriceCents: null, feeCents: null, settlementResult: "yes", note: null, occurredAtMs: 300,
  };
  const claim: Sol30TickerClaim = { ticker: TICKER, easternDate: "2026-08-16", claimedAtMs: 1, entryClientOrderId: "c" };
  const entryOrder: Sol30StrategyOrder = {
    id: entryRef.id, ticker: TICKER, easternDate: "2026-08-16", role: "entry", sequenceNumber: 0,
    clientOrderId: "c", kalshiOrderId: "k1", side: "yes", limitPriceCents: 28,
    requestedContracts: 8, outcome: "full_fill", filledContracts: 8, averageFillPriceCents: 28, updatedAtMs: 2,
  };
  const report = computeSol30Report({
    claims: [claim],
    ordersByTicker: new Map([[TICKER, [entryOrder]]]),
    eventsByTicker: new Map([[TICKER, [...ledger, settlement]]]),
    decisionsByTicker: new Map(),
    nowMs: 1_000,
  });
  const row = report.tickers[0];
  assert.equal(row.entryCostCents, 5 * 28 + 3 * 30); // 230 — exact chunk sum
  assert.equal(row.exitProceedsCents, 300);
  assert.equal(row.settlementPayoutCents, 200);
  assert.equal(row.realizedPnlCents, 300 + 200 - 230); // 270
  assert.equal(row.status, "settled");
});

test("SOL_30_50 fee backfill: chunk with fee updates existing null-fee event, settlement is not touched", () => {
  // existingFeeNull is a canonical chunk already in the DB with feeCents=null.
  // chunkWithFee is the authoritative version with feeCents=3.
  // The plan must include the event in appends (for DO UPDATE) but not delete it.
  // The settlement event must be excluded from deleteIds (it is not a fill event).
  const settlementEvent: Sol30PositionEventParams = {
    id: `${TICKER}:settlement`, ticker: TICKER, easternDate: "2026-08-16",
    eventType: "settlement", contractsDelta: -5, contractsAfter: 0,
    strategyOrderId: null, fillPriceCents: null, feeCents: null,
    settlementResult: "yes", note: null, occurredAtMs: 500,
  };
  const plan = planSol30CanonicalFillLedger(
    [{ ...entryRef, filledContracts: 5 }],
    [existingFeeNull, settlementEvent],
    new Map([[entryRef.id, [chunkWithFee]]]),
  );
  assert.deepEqual(plan.deferredOrderIds, []);
  // The null-fee chunk is in appends for fee backfill, not deleted.
  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.appends.length, 1);
  assert.equal(plan.appends[0].id, existingFeeNull.id);
  assert.equal(plan.appends[0].feeCents, 3);
  // Replaying when the fee is already set is a no-op.
  const existingWithFee: Sol30PositionEventParams = { ...existingFeeNull, feeCents: 3 };
  const replay = planSol30CanonicalFillLedger(
    [{ ...entryRef, filledContracts: 5 }],
    [existingWithFee, settlementEvent],
    new Map([[entryRef.id, [chunkWithFee]]]),
  );
  assert.deepEqual([replay.deleteIds, replay.appends], [[], []]);
});

// ── Fee path tests (production buildSol30AuthoritativeFillChunks) ─────────────

test("SOL_30_50 fee dollar-to-cents conversion produces exact cents with no off-by-100 in the production path", () => {
  // 0.0175 dollars = 1.75¢ → rounds to 2¢.
  const wireWithFee: KalshiFillWire = { ...BASE_FILL, fee_cost_dollars: "0.0175" };
  const chunks = buildSol30AuthoritativeFillChunks([wireWithFee], "yes");
  assert.equal(chunks.length, 1, "fill should produce one chunk");
  assert.equal(chunks[0].feeCents, 2, "0.0175 dollars must convert to 2 cents");
});

test("SOL_30_50 fee_cost_dollars='0' is accepted by the production path and contributes feeCents=0", () => {
  // A zero-fee fill is valid. Rejecting it would cause the chunk count to fall
  // short of the order fill total, permanently deferring settlement.
  const wireZeroFee: KalshiFillWire = { ...BASE_FILL, fee_cost_dollars: "0" };
  const chunks = buildSol30AuthoritativeFillChunks([wireZeroFee], "yes");
  assert.equal(chunks.length, 1, "zero-fee fill should produce one chunk");
  assert.equal(chunks[0].feeCents, 0, "zero fee must yield feeCents=0");
});

test("SOL_30_50 fill missing fee_cost_dollars is dropped by the production path so reconciliation defers", () => {
  // An incomplete API response without fee data must not be silently accepted
  // with an assumed zero fee — the production path drops the record.
  const wireWithoutFee: KalshiFillWire = {
    fill_id: "f-no-fee",
    count_fp: "1",
    yes_price_dollars: "0.80",
    // fee_cost_dollars intentionally absent
  };
  const chunks = buildSol30AuthoritativeFillChunks([wireWithoutFee], "yes");
  assert.equal(chunks.length, 0, "fill missing fee_cost_dollars must be dropped (not silently zeroed)");
});
