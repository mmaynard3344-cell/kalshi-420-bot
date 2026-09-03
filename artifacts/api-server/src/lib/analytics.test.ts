/**
 * Analytics service tests — 13 test cases.
 *
 * Tests are pure in-memory. No disk I/O in cases 1–12.
 * Case 11 tests persistence hydration via hydrateOrderAttempt().
 * After each test, _resetStateForTesting() restores a clean slate.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  _resetStateForTesting,
  _setDayForTesting,
  setStoreHook,
  recordGuardOutcome,
  recordOrderAttempt,
  recordZeroFill,
  recordFill,
  recordReconciliation,
  recordQualifyingEvaluation,
  rollWindowAnalytics,
  getWindowAnalytics,
  getDailySummary,
  getOrderAttempts,
  hydrateOrderAttempt,
  type OrderAttemptRecord,
} from "./analytics.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function attempt(overrides: Partial<Parameters<typeof recordOrderAttempt>[0]> = {}) {
  return recordOrderAttempt({
    ticker:             "KXBTC15M-26JUL290300-T",
    series:             "KXBTC15M",
    windowCloseTime:    "2026-07-29T00:00:00Z",
    side:               "yes",
    source:             "websocket",
    triggerPriceCents:  82,
    limitPriceCents:    83,
    requestedContracts: 120,
    clientOrderId:      "test-cid-001",
    ...overrides,
  });
}

function makeFillParams(count: number, limitCents: number) {
  return {
    orderId:         "ord-001",
    fillCount:       count,
    requestedCount:  count,
    contractsFilled: count,
    fillPriceCents:  limitCents,
    notionalDollars: (count * limitCents) / 100,
    feeDollars:      0.03,
    pricesKnown:     true,
    roundTripMs:     120,
  };
}

beforeEach(() => {
  _resetStateForTesting();
});

// ── Case 1: Zero fills do not count as actual spend ───────────────────────────

it("zero fills do not count as submitted notional spend", () => {
  const id = attempt({ limitPriceCents: 83, requestedContracts: 120 });
  recordZeroFill(id, {
    requestedContracts: 120,
    limitPriceCents:    83,
    triggerPriceCents:  82,
    yesBid: 11, noBid: 82, yesAsk: 19, noAsk: 18,
    yesDerivedAsk: 18, noDerivedAsk: 88,
    snapshotAgeMs: 200, snapshotSource: "websocket", roundTripMs: 130,
  });

  const s = getDailySummary();
  // submitted notional includes the reservation (limit × contracts)
  const submittedNotional = (120 * 83) / 100;
  assert.equal(s.btc.submittedNotionalDollars.toFixed(2), submittedNotional.toFixed(2));
  // nothing was actually filled
  assert.equal(s.btc.filledNotionalDollars, 0);
  assert.equal(s.btc.zeroFills, 1);
  assert.equal(s.btc.successfulFills, 0);
});

// ── Case 2: Multiple attempts attributed to the correct ticker ────────────────

it("multiple attempts for the same ticker are counted together", () => {
  const BTC_TICKER = "KXBTC15M-26JUL290300-T";
  const ETH_TICKER = "KXETH15M-26JUL290300-T";

  // 3 BTC attempts
  for (let i = 0; i < 3; i++) {
    const id = attempt({
      ticker: BTC_TICKER, series: "KXBTC15M",
      clientOrderId: `btc-${i}`,
    });
    recordZeroFill(id, {
      requestedContracts: 120, limitPriceCents: 83, triggerPriceCents: 82,
      yesBid: null, noBid: null, yesAsk: null, noAsk: null,
      yesDerivedAsk: null, noDerivedAsk: null,
      snapshotAgeMs: 100, snapshotSource: "websocket", roundTripMs: 90,
    });
  }

  // 1 ETH attempt
  const ethId = attempt({
    ticker: ETH_TICKER, series: "KXETH15M",
    clientOrderId: "eth-0",
  });
  recordZeroFill(ethId, {
    requestedContracts: 120, limitPriceCents: 83, triggerPriceCents: 82,
    yesBid: null, noBid: null, yesAsk: null, noAsk: null,
    yesDerivedAsk: null, noDerivedAsk: null,
    snapshotAgeMs: 100, snapshotSource: "websocket", roundTripMs: 90,
  });

  const btcWin = getWindowAnalytics("KXBTC15M");
  assert.equal(btcWin.length, 1);
  assert.equal(btcWin[0]?.submittedOrders, 3, "BTC window should have 3 attempts");
  assert.equal(btcWin[0]?.zeroFills, 3);

  const ethWin = getWindowAnalytics("KXETH15M");
  assert.equal(ethWin.length, 1);
  assert.equal(ethWin[0]?.submittedOrders, 1, "ETH window should have 1 attempt");
});

// ── Case 3: Fill on attempt 5 is reported as attempt 5 ───────────────────────

it("attemptNumber tracks correctly — fill on attempt 5 reported as attempt 5", () => {
  const TICKER = "KXBTC15M-26JUL290300-T";
  let lastId = "";

  // 4 zero fills
  for (let i = 0; i < 4; i++) {
    const id = attempt({ ticker: TICKER, clientOrderId: `cid-a5-${i}` });
    recordZeroFill(id, {
      requestedContracts: 120, limitPriceCents: 83, triggerPriceCents: 82,
      yesBid: null, noBid: null, yesAsk: null, noAsk: null,
      yesDerivedAsk: null, noDerivedAsk: null,
      snapshotAgeMs: 100, snapshotSource: "websocket", roundTripMs: 90,
    });
  }

  // 5th attempt fills
  lastId = attempt({ ticker: TICKER, clientOrderId: "cid-a5-4" });
  recordFill(lastId, makeFillParams(120, 83));

  const orders = getOrderAttempts(TICKER);
  const filledOrder = orders.find((o) => o.outcome === "full_fill");
  assert.ok(filledOrder, "there should be a full_fill order");
  assert.equal(filledOrder!.attemptNumber, 5, "fill should be on attempt 5");

  const win = getWindowAnalytics("KXBTC15M");
  assert.equal(win[0]?.attemptNumberThatFilled, 5);
});

// ── Case 4: BTC and ETH analytics remain independent ─────────────────────────

it("BTC and ETH analytics are fully independent", () => {
  // BTC: 2 zero fills, 1 fill
  for (let i = 0; i < 2; i++) {
    const id = attempt({ ticker: "KXBTC15M-A", series: "KXBTC15M", clientOrderId: `btc-${i}` });
    recordZeroFill(id, {
      requestedContracts: 120, limitPriceCents: 83, triggerPriceCents: 82,
      yesBid: null, noBid: null, yesAsk: null, noAsk: null,
      yesDerivedAsk: null, noDerivedAsk: null,
      snapshotAgeMs: 50, snapshotSource: "websocket", roundTripMs: 80,
    });
  }
  const btcFillId = attempt({ ticker: "KXBTC15M-A", series: "KXBTC15M", clientOrderId: "btc-2" });
  recordFill(btcFillId, makeFillParams(120, 83));

  // ETH: 1 fill on first attempt
  const ethFillId = attempt({
    ticker: "KXETH15M-A", series: "KXETH15M", clientOrderId: "eth-0",
    limitPriceCents: 78, requestedContracts: 128,
  });
  recordFill(ethFillId, makeFillParams(128, 78));

  const s = getDailySummary();

  assert.equal(s.btc.orderSubmissions, 3);
  assert.equal(s.btc.zeroFills, 2);
  assert.equal(s.btc.successfulFills, 1);

  assert.equal(s.eth.orderSubmissions, 1);
  assert.equal(s.eth.zeroFills, 0);
  assert.equal(s.eth.successfulFills, 1);

  // Sanity: combined = sum
  assert.equal(s.combined.orderSubmissions, 4);
  assert.equal(s.combined.zeroFills, 2);
  assert.equal(s.combined.successfulFills, 2);
});

// ── Case 5: Window rollover resets per-window counters ────────────────────────

it("rollWindowAnalytics seals previous window and new ticker starts fresh", () => {
  const TICKER_A = "KXBTC15M-PREV";
  const TICKER_B = "KXBTC15M-NEXT";

  // One zero-fill on ticker A
  const idA = attempt({ ticker: TICKER_A, series: "KXBTC15M", clientOrderId: "prev-1" });
  recordZeroFill(idA, {
    requestedContracts: 120, limitPriceCents: 83, triggerPriceCents: 82,
    yesBid: null, noBid: null, yesAsk: null, noAsk: null,
    yesDerivedAsk: null, noDerivedAsk: null,
    snapshotAgeMs: 100, snapshotSource: "websocket", roundTripMs: 90,
  });

  // Roll window
  rollWindowAnalytics("KXBTC15M", TICKER_A);

  // Attempt on ticker B
  const idB = attempt({ ticker: TICKER_B, series: "KXBTC15M", clientOrderId: "next-1" });
  recordFill(idB, makeFillParams(120, 83));

  const wins = getWindowAnalytics("KXBTC15M");
  const winA = wins.find((w) => w.ticker === TICKER_A);
  const winB = wins.find((w) => w.ticker === TICKER_B);

  assert.ok(winA, "ticker A window should exist");
  assert.ok(winB, "ticker B window should exist");

  assert.equal(winA!.result, "zero_fill_only", "ticker A sealed as zero_fill_only");
  assert.equal(winA!.submittedOrders, 1);

  assert.equal(winB!.result, "filled", "ticker B filled");
  assert.equal(winB!.submittedOrders, 1);
  assert.equal(winB!.zeroFills, 0, "ticker B should have no zero fills");
});

// ── Case 6: Partial fills recorded correctly ──────────────────────────────────

it("partial fills record contracts, spend, and fees correctly", () => {
  const id = attempt({ requestedContracts: 120, limitPriceCents: 83, clientOrderId: "partial-1" });

  // Only 60 of 120 contracts fill
  recordFill(id, {
    orderId:         "ord-partial",
    fillCount:       60,
    requestedCount:  120,
    contractsFilled: 60,
    fillPriceCents:  82,   // got one cent of improvement
    notionalDollars: (60 * 82) / 100,
    feeDollars:      0.015,
    pricesKnown:     true,
    roundTripMs:     110,
  });

  const orders = getOrderAttempts("KXBTC15M-26JUL290300-T");
  const rec = orders[0]!;
  assert.equal(rec.outcome, "partial_fill");
  assert.equal(rec.contracts.value, 60);
  assert.equal(rec.fillPriceCents.value, 82);
  assert.equal(rec.notionalDollars.value, (60 * 82) / 100);
  assert.ok(Math.abs(rec.feeDollars.value - 0.015) < 0.0001, `feeDollars ${rec.feeDollars.value} not close to 0.015`);
  assert.equal(rec.contracts.source, "confirmed_from_response");

  const win = getWindowAnalytics("KXBTC15M");
  assert.equal(win[0]?.partialFills, 1);
  assert.equal(win[0]?.actualFilledContracts, 60);
  assert.equal(win[0]?.result, "partial_fill");
});

// ── Case 7: Estimated vs confirmed fill values distinguished ──────────────────

it("valueSource tracks estimated → confirmed_from_response → confirmed_from_fills_api", () => {
  // After recordOrderAttempt: values are initialized to estimated zeros
  const id = attempt();

  const orders1 = getOrderAttempts("KXBTC15M-26JUL290300-T");
  assert.equal(orders1[0]!.contracts.source, "estimated");

  // After recordFill with pricesKnown=true: confirmed_from_response
  recordFill(id, {
    orderId: "ord-vsrc", fillCount: 120, requestedCount: 120,
    contractsFilled: 120, fillPriceCents: 83,
    notionalDollars: (120 * 83) / 100, feeDollars: 0.03,
    pricesKnown: true, roundTripMs: 100,
  });

  const orders2 = getOrderAttempts("KXBTC15M-26JUL290300-T");
  assert.equal(orders2[0]!.contracts.source, "confirmed_from_response");
  assert.equal(orders2[0]!.fillPriceCents.source, "confirmed_from_response");

  // After recordReconciliation: confirmed_from_fills_api
  recordReconciliation(id, {
    contracts: 120, fillPriceCents: 82,
    notionalDollars: (120 * 82) / 100, feeDollars: 0.028,
  });

  const orders3 = getOrderAttempts("KXBTC15M-26JUL290300-T");
  assert.equal(orders3[0]!.contracts.source, "confirmed_from_fills_api");
  assert.equal(orders3[0]!.fillPriceCents.source, "confirmed_from_fills_api");
  assert.equal(orders3[0]!.reconciled, true);
});

// ── Case 8: Reconciliation updates analytics without affecting trading state ───

it("reconciliation flags discrepancies and updates fill prices only", () => {
  const id = attempt({ clientOrderId: "recon-test" });

  recordFill(id, {
    orderId: "ord-recon", fillCount: 120, requestedCount: 120,
    contractsFilled: 120, fillPriceCents: 83,
    notionalDollars: (120 * 83) / 100, feeDollars: 0.03,
    pricesKnown: true, roundTripMs: 100,
  });

  // Reconciliation reveals a 1-cent discrepancy in fill price
  recordReconciliation(id, {
    contracts: 120, fillPriceCents: 82,
    notionalDollars: (120 * 82) / 100, feeDollars: 0.028,
  });

  const orders = getOrderAttempts("KXBTC15M-26JUL290300-T");
  const rec = orders[0]!;
  assert.equal(rec.reconciled, true);
  assert.ok(rec.discrepancies?.fillPriceCents, "should flag fillPriceCents discrepancy");
  assert.equal(rec.discrepancies!.fillPriceCents!.estimated, 83);
  assert.equal(rec.discrepancies!.fillPriceCents!.confirmed, 82);
  // outcome and other trading-state fields are unchanged
  assert.equal(rec.outcome, "full_fill");
  assert.equal(rec.contracts.value, 120);
});

// ── Case 9: Persistence survives restart (hydrateOrderAttempt) ────────────────

it("hydrateOrderAttempt restores in-memory state from a serialized record", () => {
  // Simulate a "pre-existing record" from disk
  const record: OrderAttemptRecord = {
    id:                     "prior-cid-1-1",
    timestampMs:            Date.now() - 60_000,
    ticker:                 "KXBTC15M-PREV-A",
    series:                 "KXBTC15M",
    windowCloseTime:        "2026-07-29T00:00:00Z",
    side:                   "yes",
    attemptNumber:          1,
    source:                 "websocket",
    triggerPriceCents:      80,
    limitPriceCents:        81,
    requestedContracts:     123,
    requestedNotionalCents: 123 * 81,
    clientOrderId:          "prior-cid-1",
    orderId:                "ord-prior",
    fillCount:              123,
    remainingCount:         0,
    contracts:              { value: 123, source: "confirmed_from_fills_api" },
    fillPriceCents:         { value: 80,  source: "confirmed_from_fills_api" },
    notionalDollars:        { value: (123 * 80) / 100, source: "confirmed_from_fills_api" },
    feeDollars:             { value: 0.025,             source: "confirmed_from_fills_api" },
    outcome:                "full_fill",
    roundTripMs:            115,
    reconciled:             true,
  };

  hydrateOrderAttempt(record);

  const orders = getOrderAttempts("KXBTC15M-PREV-A");
  assert.equal(orders.length, 1, "one order should be in memory");
  assert.equal(orders[0]!.id, record.id);
  assert.equal(orders[0]!.outcome, "full_fill");
  assert.equal(orders[0]!.contracts.value, 123);

  const s = getDailySummary();
  assert.equal(s.btc.successfulFills, 1);
  assert.equal(s.btc.filledNotionalDollars.toFixed(2), ((123 * 80) / 100).toFixed(2));

  // Hydrating twice is idempotent
  hydrateOrderAttempt(record);
  const orders2 = getOrderAttempts("KXBTC15M-PREV-A");
  assert.equal(orders2.length, 1, "idempotent: still one order after second hydration");
});

// ── Case 10: Daily grouping rolls over at midnight America/New_York ───────────

it("daily guard counts reset when the Eastern day rolls over", () => {
  // Record some guard outcomes into today's bucket first (this triggers the
  // normal maybeRollDay() path and stabilises _dailyDate to today).
  recordGuardOutcome("KXBTC15M", "cooldown");
  recordGuardOutcome("KXBTC15M", "cooldown");

  // Now backdate _dailyDate to yesterday to simulate the server running
  // across midnight.  The next call to maybeRollDay() will see a mismatch
  // (stored = "2026-07-28", actual = today) and clear all guard counts.
  _setDayForTesting("2026-07-28");

  const s = getDailySummary();

  // cooldown counts should be 0 because getDailySummary() triggers a roll
  const counts = s.btc.guardOutcomeCounts;
  assert.equal(counts.cooldown ?? 0, 0, "cooldown count should reset after day roll");
});

// ── Case 11: Write failures do not interrupt execution ────────────────────────

it("analytics write failure (store hook throws) does not propagate to caller", () => {
  // Install a hook that always throws
  setStoreHook(() => { throw new Error("simulated store write failure"); });

  // All of these should complete without throwing
  let attemptId = "";
  assert.doesNotThrow(() => {
    attemptId = recordOrderAttempt({
      ticker: "KXBTC15M-FAIL-T", series: "KXBTC15M",
      windowCloseTime: null, side: "yes", source: "websocket",
      triggerPriceCents: 82, limitPriceCents: 83,
      requestedContracts: 120, clientOrderId: "fail-cid-1",
    });
  }, "recordOrderAttempt must not throw when store hook throws");

  assert.doesNotThrow(() => {
    recordZeroFill(attemptId, {
      requestedContracts: 120, limitPriceCents: 83, triggerPriceCents: 82,
      yesBid: null, noBid: null, yesAsk: null, noAsk: null,
      yesDerivedAsk: null, noDerivedAsk: null,
      snapshotAgeMs: 100, snapshotSource: "websocket", roundTripMs: 90,
    });
  }, "recordZeroFill must not throw when store hook throws");

  assert.doesNotThrow(() => {
    recordGuardOutcome("KXBTC15M", "cooldown");
  }, "recordGuardOutcome must not throw when store hook throws");

  assert.doesNotThrow(() => {
    rollWindowAnalytics("KXBTC15M", "KXBTC15M-FAIL-T");
  }, "rollWindowAnalytics must not throw when store hook throws");

  // Returns a non-empty attempt ID despite the failure
  assert.ok(attemptId.length > 0, "recordOrderAttempt should return a non-empty ID");
});

// ── Case 12: Guard outcome counts attribute correctly by series ───────────────

it("guardOutcomeCounts counts are correctly attributed to BTC vs ETH", () => {
  recordGuardOutcome("KXBTC15M", "cooldown");
  recordGuardOutcome("KXBTC15M", "cooldown");
  recordGuardOutcome("KXBTC15M", "dedup");
  recordGuardOutcome("KXETH15M", "cooldown");
  recordGuardOutcome("KXETH15M", "daily_cap");

  const s = getDailySummary();

  assert.equal(s.btc.guardOutcomeCounts.cooldown, 2);
  assert.equal(s.btc.guardOutcomeCounts.dedup, 1);
  assert.equal(s.btc.guardOutcomeCounts.daily_cap ?? 0, 0);

  assert.equal(s.eth.guardOutcomeCounts.cooldown, 1);
  assert.equal(s.eth.guardOutcomeCounts.daily_cap, 1);
  assert.equal(s.eth.guardOutcomeCounts.dedup ?? 0, 0);

  // combined = BTC + ETH
  assert.equal(s.combined.guardOutcomeCounts.cooldown, 3);
  assert.equal(s.combined.guardOutcomeCounts.dedup, 1);
  assert.equal(s.combined.guardOutcomeCounts.daily_cap, 1);
});

// ── Case 13: fillRateByOrderAttempt and fillRateByQualifyingWindow compute correctly ──

it("fill rate metrics are computed correctly from submissions and windows", () => {
  const TICKER = "KXBTC15M-RATE-T";

  // Record 3 qualifying evaluations (in-zone ticks)
  for (let i = 0; i < 3; i++) {
    recordQualifyingEvaluation({
      ticker: TICKER, series: "KXBTC15M", windowCloseTime: null,
      timestampMs: Date.now() + i * 1000,
      yesDerivedAsk: 82, noDerivedAsk: null,
    });
  }

  // 2 order attempts: 1 zero-fill, 1 full fill
  const zeroId = attempt({ ticker: TICKER, clientOrderId: "rate-cid-1" });
  recordZeroFill(zeroId, {
    requestedContracts: 120, limitPriceCents: 83, triggerPriceCents: 82,
    yesBid: null, noBid: null, yesAsk: null, noAsk: null,
    yesDerivedAsk: null, noDerivedAsk: null,
    snapshotAgeMs: 100, snapshotSource: "websocket", roundTripMs: 90,
  });

  const fillId = attempt({ ticker: TICKER, clientOrderId: "rate-cid-2" });
  recordFill(fillId, makeFillParams(120, 83));

  const s = getDailySummary();

  // 1 of 2 submissions filled → 50%
  assert.ok(s.btc.fillRateByOrderAttempt !== null);
  assert.ok(Math.abs(s.btc.fillRateByOrderAttempt! - 0.5) < 0.001, `fillRate ${s.btc.fillRateByOrderAttempt} not close to 0.5`);

  // fillRateByQualifyingWindow: 1 window entered zone; that window filled
  // → 1/1 = 100%
  assert.ok(s.btc.fillRateByQualifyingWindow !== null);
  assert.ok(Math.abs(s.btc.fillRateByQualifyingWindow! - 1.0) < 0.001, `fillRateByWindow ${s.btc.fillRateByQualifyingWindow} not close to 1.0`);
});
