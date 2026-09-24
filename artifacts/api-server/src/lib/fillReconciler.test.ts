/**
 * fillReconciler unit tests
 *
 * Covers the weighted-average fill-price computation and the analytics
 * reconciliation path. No HTTP mocks needed — the pure computeFillParams()
 * helper is exercised directly; the full reconcileOrder() retry loop is
 * tested via the injectable _setFetchFillsForTesting hook + mock.timers.
 *
 * Test cases
 * ──────────
 *   1. Three partial fills at different prices → correct weighted avg, total
 *      contracts, notional, and fee sum.
 *   2. Empty fills array → null (fill_price_cents stays NULL in SQL).
 *   3. All fill records have count=0 → null (no valid contracts).
 *   4. Price improvement — limit 70¢, fills executed at 10¢ → actual cost
 *      is NOT inflated by the limit price.
 *   5. NO side — no_price field used, not yes_price.
 *   6. recordReconciliation updates the in-memory analytics record with
 *      source="confirmed_from_fills_api" and the computed values.
 *   7. recordReconciliationFailed leaves values as-is and sets reconcile_failed.
 *   8. Weighted average rounds to nearest cent (fractional weighted sum).
 *   9. reconcileOrder retry loop: empty fills on attempts 1 & 2, real fills
 *      on attempt 3 → reconciliation completes with correct weighted avg.
 *  10. reconcileOrder retry loop: all 3 attempts return empty fills →
 *      recordReconciliationFailed is called and reconcile_failed = true.
 *  11. reconcileOrder retry loop: all 3 attempts throw a network error →
 *      recordReconciliationFailed is called and reconcile_failed = true.
 *  12. fee_cost format boundary — "0.10" means $0.10 (dollar-decimal), not 0.10 cents ($0.001).
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  computeFillParams,
  reconcileOrder,
  _setFetchFillsForTesting,
  _setVerifyReconciliationOwnershipForTesting,
  _setKalshiAuthFetchForTesting,
  discoverAndReconcileMissingBotFills,
  isExchangeDiscoverySweepComplete,
  _resetExchangeDiscoverySweepStatusForTesting,
  _setLoadKalshiOrderIdsForDateForTesting,
  _setLoadKnownOrderIdsForEasternDateForTesting,
  _setPersistSweepCompletionForTesting,
  isTrustedSweepDate,
  getSweepStartDate,
  checkExchangeFillCoverage,
  getExchangeCoverageStatus,
  _resetExchangeCoverageStatusForTesting,
} from "./fillReconciler.js";
import {
  _resetStateForTesting,
  recordOrderAttempt,
  recordFill,
  recordReconciliation,
  recordReconciliationFailed,
  getOrderAttempts,
} from "./analytics.js";

// ── Timer-flush helper ────────────────────────────────────────────────────────
// Drains the microtask queue (promise continuations) after mock.timers.tick().
// setImmediate runs after all pending microtasks, so awaiting it is sufficient.
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fill(count: string, yes_price: string, no_price: string, fee_cost: string) {
  return { count, yes_price, no_price, fee_cost, side: "yes" };
}

function attempt(limitPriceCents = 70) {
  return recordOrderAttempt({
    ticker:             "KXBTC15M-TEST-RECONCILER",
    series:             "KXBTC15M",
    windowCloseTime:    "2026-08-02T00:00:00Z",
    side:               "yes",
    source:             "websocket",
    triggerPriceCents:  limitPriceCents - 1,
    limitPriceCents,
    requestedContracts: 655,
    clientOrderId:      `reconciler-cid-${Math.random().toString(36).slice(2)}`,
  });
}

describe("fillReconciler", () => {
  beforeEach(() => {
    _resetStateForTesting();
  });

  afterEach(() => {
    // Some tests in this suite enable mock timers — always reset to avoid
    // leaking into the "reconcileOrder retry loop" describe's beforeEach.
    mock.timers.reset();
  });


  // ── 1. Three partial fills at different prices ──────────────────────────────
  it("1: three fills at different prices → correct weighted avg, notional, fees", () => {
    // Simulate: 400 contracts @ 35¢ + 255 contracts @ 36¢ + 100 contracts @ 37¢
    // Total contracts = 755
    // Weighted sum = 400×35 + 255×36 + 100×37 = 14000 + 9180 + 3700 = 26880
    // Avg = Math.round(26880 / 755) = Math.round(35.603…) = 36
    // Exact notional = 400×35¢ + 255×36¢ + 100×37¢ = $268.80.
    // It must not use 755 × rounded-average(36¢) = $271.80.
    // Fees = 0.10 + 0.06 + 0.03 = $0.19 (dollar-decimal strings, not cents)
    const fills = [
      fill("400", "0.35", "0.65", "0.10"),
      fill("255", "0.36", "0.64", "0.06"),
      fill("100", "0.37", "0.63", "0.03"),
    ];
    const params = computeFillParams(fills, "yes");
    assert.ok(params !== null, "should return params for non-empty fills");
    assert.strictEqual(params.contracts, 755, "total contracts");
    assert.strictEqual(params.fillPriceCents, 36, "weighted avg fill price (36¢)");
    assert.ok(Math.abs(params.notionalDollars - 268.80) < 0.01, "exact chunk-summed notional dollars");
    // fee_cost values are dollar-decimal strings: 0.10 + 0.06 + 0.03 = $0.19
    assert.ok(Math.abs(params.feeDollars - 0.19) < 0.001, `fee dollars ${params.feeDollars}`);
  });

  // ── 2. Empty fills array → null ─────────────────────────────────────────────
  it("2: empty fills array → null (zero-fill; fill_price_cents stays NULL)", () => {
    const params = computeFillParams([], "yes");
    assert.strictEqual(params, null, "empty fills should return null");
  });

  // ── 3. All fills have count=0 → null ────────────────────────────────────────
  it("3: fills with all count=0 → null", () => {
    const fills = [
      fill("0",  "0.70", "0.30", "0.00"),
      fill("-1", "0.70", "0.30", "0.00"),
    ];
    const params = computeFillParams(fills, "yes");
    assert.strictEqual(params, null, "zero-count fills should return null");
  });

  // ── 4. Price improvement: fills at 10¢ when limit was 70¢ ──────────────────
  it("4: price improvement — limit 70¢, fills at 10¢ → cost uses actual price, not limit", () => {
    // 600 contracts @ 10¢ — major price improvement vs 70¢ limit
    const fills = [fill("600", "0.10", "0.90", "0.50")];
    const params = computeFillParams(fills, "yes");
    assert.ok(params !== null, "should compute params");
    assert.strictEqual(params.fillPriceCents, 10, "fill price should be 10¢, not 70¢");
    assert.strictEqual(params.contracts, 600, "contracts");
    // notional = 600 × 10 / 100 = $60, NOT 600 × 70 / 100 = $420
    assert.ok(Math.abs(params.notionalDollars - 60) < 0.01,
      `notional should be $60 (actual), got ${params.notionalDollars}`);
  });

  // ── 5. NO side — uses no_price field, not yes_price ─────────────────────────
  it("5: NO side — no_price is used for fill price, not yes_price", () => {
    // yes_price = 0.20, no_price = 0.80; for a NO buy, cost = no_price
    const fills = [fill("200", "0.20", "0.80", "0.10")];
    const params = computeFillParams(fills, "no");
    assert.ok(params !== null, "should compute params");
    assert.strictEqual(params.fillPriceCents, 80, "NO fill price should be 80¢ (no_price)");
    // If yes_price were mistakenly used, this would be 20¢ — detects wrong field
    assert.notStrictEqual(params.fillPriceCents, 20, "must not use yes_price for NO side");
  });

  it("accepts current Kalshi fixed-point NO fills with dollar price fields", () => {
    const params = computeFillParams([
      {
        count_fp: "96.41",
        yes_price_dollars: "0.0700",
        no_price_dollars: "0.9300",
        fee_cost: "0.4710",
      },
      {
        count_fp: "4.00",
        yes_price_dollars: "0.1000",
        no_price_dollars: "0.9000",
        fee_cost: "0.0200",
      },
    ], "no");

    assert.ok(params !== null, "current fill payload must reconcile");
    assert.equal(params.contracts, 100.41);
    assert.equal(params.fillPriceCents, 93);
    assert.ok(Math.abs(params.notionalDollars - 93.2613) < 0.000001);
    assert.ok(Math.abs(params.feeDollars - 0.491) < 0.000001);
  });

  // ── 6. recordReconciliation updates in-memory record correctly ──────────────
  it("6: recordReconciliation sets confirmed_from_fills_api source and correct values", () => {
    // Record an order attempt with limit-price estimated values
    const id = attempt(70);
    recordFill(id, {
      orderId:         "ord-recon-001",
      fillCount:       655,
      requestedCount:  655,
      contractsFilled: 655,
      fillPriceCents:  70,      // estimated from limit
      notionalDollars: (655 * 70) / 100,
      feeDollars:      0.05,
      pricesKnown:     false,   // estimated
      roundTripMs:     90,
    });

    // Reconcile with actual fill data: 655 contracts at 35¢ avg (price improvement)
    recordReconciliation(id, {
      contracts:       655,
      fillPriceCents:  35,
      notionalDollars: (655 * 35) / 100,
      feeDollars:      0.03,
    });

    const orders = getOrderAttempts();
    const rec = orders.find((o) => o.id === id);
    assert.ok(rec, "record should exist");
    assert.strictEqual(rec.reconciled, true, "reconciled flag");
    assert.strictEqual(rec.fillPriceCents.source, "confirmed_from_fills_api", "source updated");
    assert.strictEqual(rec.fillPriceCents.value, 35, "fill price updated to actual avg");
    assert.strictEqual(rec.contracts.value, 655, "contracts");
    assert.ok(Math.abs((rec.notionalDollars.value) - (655 * 35) / 100) < 0.01, "notional updated");
    assert.ok(Math.abs(rec.feeDollars.value - 0.03) < 0.001, "fees updated");
    // Discrepancy should be recorded since estimated price (70¢) ≠ confirmed (35¢)
    assert.ok(rec.discrepancies?.fillPriceCents, "discrepancy for fill price should be recorded");
    assert.strictEqual(rec.discrepancies?.fillPriceCents?.estimated, 70, "discrepancy.estimated");
    assert.strictEqual(rec.discrepancies?.fillPriceCents?.confirmed, 35, "discrepancy.confirmed");
  });

  // ── 7. recordReconciliationFailed leaves values as estimated, sets flag ──────
  it("7: recordReconciliationFailed preserves estimated values and sets reconcile_failed", () => {
    const id = attempt(70);
    recordFill(id, {
      orderId:         "ord-recon-fail",
      fillCount:       655,
      requestedCount:  655,
      contractsFilled: 655,
      fillPriceCents:  70,
      notionalDollars: (655 * 70) / 100,
      feeDollars:      0.05,
      pricesKnown:     false,
      roundTripMs:     90,
    });

    recordReconciliationFailed(id);

    const orders = getOrderAttempts();
    const rec = orders.find((o) => o.id === id);
    assert.ok(rec, "record should exist");
    assert.strictEqual(rec.reconcile_failed, true, "reconcile_failed flag set");
    assert.strictEqual(rec.reconciled, false, "reconciled flag NOT set");
    // Values stay as the estimated fill values — not clobbered
    assert.strictEqual(rec.fillPriceCents.value, 70, "fill price stays estimated");
  });

  // ── 8. Weighted average rounds correctly ─────────────────────────────────────
  it("8: weighted average rounds to nearest cent when sum is fractional", () => {
    // 1 contract @ 35¢ + 1 contract @ 36¢ → avg = 35.5 → rounds to 36
    const fills = [
      fill("1", "0.35", "0.65", "0.00"),
      fill("1", "0.36", "0.64", "0.00"),
    ];
    const params = computeFillParams(fills, "yes");
    assert.ok(params !== null);
    assert.strictEqual(params.fillPriceCents, 36, "35.5 rounds up to 36");

    // 2 contracts @ 35¢ + 1 contract @ 36¢ → avg = (70+36)/3 = 106/3 = 35.33 → 35
    const fills2 = [
      fill("2", "0.35", "0.65", "0.00"),
      fill("1", "0.36", "0.64", "0.00"),
    ];
    const params2 = computeFillParams(fills2, "yes");
    assert.ok(params2 !== null);
    assert.strictEqual(params2.fillPriceCents, 35, "35.33 rounds down to 35");
  });

  it("preserves a valid 0.01-contract partial fill in totals and notional", () => {
    const params = computeFillParams([
      fill("0.01", "0.80", "0.20", "0.0002"),
    ], "yes");
    assert.ok(params !== null, "fractional fill must not be discarded");
    assert.equal(params.contracts, 0.01);
    assert.equal(params.fillPriceCents, 80);
    assert.ok(Math.abs(params.notionalDollars - 0.008) < 0.0000001);
    assert.ok(Math.abs(params.feeDollars - 0.0002) < 0.0000001);
  });

  // ── 12. fee_cost format boundary: dollar-decimal, NOT cents ──────────────────
  it("12: fee_cost='0.10' → feeDollars=0.10 (dollar-decimal), not 0.001 (wrong cents treatment)", () => {
    // Confirmed format: Kalshi returns fee_cost as a dollar-decimal string,
    // matching yes_price / no_price. "0.10" means $0.10, NOT 0.10 cents.
    // autoTrader.ts (live production path) also sums fee_cost directly as dollars.
    const fills = [fill("100", "0.86", "0.14", "0.10")];
    const params = computeFillParams(fills, "yes");
    assert.ok(params !== null, "should compute params");
    // Dollar-decimal interpretation: feeDollars = $0.10 exactly
    assert.ok(
      Math.abs(params.feeDollars - 0.10) < 0.0001,
      `feeDollars should be 0.10 (dollar-decimal), got ${params.feeDollars}`,
    );
    // Guard: if we were still dividing by 100, feeDollars would be 0.001 — that is wrong
    assert.ok(
      params.feeDollars > 0.05,
      `feeDollars ${params.feeDollars} looks like cents-divided-by-100 (should be ~0.10)`,
    );
  });
});

// ── reconcileOrder retry loop ─────────────────────────────────────────────────
// Uses mock.timers to avoid real 2 s / 5 s / 10 s waits and
// _setFetchFillsForTesting to inject controlled HTTP responses.
// afterEach restores the real fetchFills so other test suites are unaffected.

describe("reconcileOrder retry loop", () => {

  beforeEach(() => {
    _resetStateForTesting();
    mock.timers.enable({ apis: ["setTimeout"] });
    _setVerifyReconciliationOwnershipForTesting(async () => true);
  });

  afterEach(() => {
    _setFetchFillsForTesting(null);
    _setVerifyReconciliationOwnershipForTesting(null);
    mock.timers.reset();
  });

  // Helper: create an order attempt and record an estimated fill so there is
  // something for recordReconciliation / recordReconciliationFailed to update.
  function prepareAttempt(limitCents = 70) {
    const id = recordOrderAttempt({
      ticker:             "KXBTC15M-TEST-RECONCILER-LOOP",
      series:             "KXBTC15M",
      windowCloseTime:    "2026-08-02T00:00:00Z",
      side:               "yes",
      source:             "websocket",
      triggerPriceCents:  limitCents - 1,
      limitPriceCents:    limitCents,
      requestedContracts: 100,
      clientOrderId:      `loop-cid-${Math.random().toString(36).slice(2)}`,
    });
    recordFill(id, {
      orderId:         `ord-loop-${id}`,
      fillCount:       100,
      requestedCount:  100,
      contractsFilled: 100,
      fillPriceCents:  limitCents,
      notionalDollars: (100 * limitCents) / 100,
      feeDollars:      0.02,
      pricesKnown:     false,
      roundTripMs:     80,
    });
    return id;
  }

  it("allows a matching persisted attempt/order/ticker tuple to reach reconciliation", async () => {
    const id = prepareAttempt(70);
    const orderId = `ord-loop-${id}`;
    const ticker = "KXBTC15M-TEST-RECONCILER-LOOP";
    let verified: unknown = null;
    let fetches = 0;
    _setVerifyReconciliationOwnershipForTesting(async (identity) => {
      verified = identity;
      return true;
    });
    _setFetchFillsForTesting(async () => {
      fetches++;
      return { params: { contracts: 100, fillPriceCents: 65, notionalDollars: 65, feeDollars: 0.01 }, fillRows: [] };
    });

    const pending = reconcileOrder(id, orderId, "yes", 70, ticker, id);
    await flushPromises();
    mock.timers.tick(2_000);
    await flushPromises();
    await pending;

    assert.deepEqual(verified, { attemptId: id, orderId, ticker });
    assert.equal(fetches, 1, "a valid persisted tuple may fetch reconciliation evidence");
    assert.equal(getOrderAttempts().find((row) => row.id === id)?.reconciled, true);
  });

  for (const scenario of [
    {
      name: "wrong Kalshi order ID",
      identity: (id: string) => ({ attemptId: id, orderId: "different-kalshi-order", ticker: "KXBTC15M-TEST-RECONCILER-LOOP" }),
    },
    {
      name: "wrong ticker",
      identity: (id: string) => ({ attemptId: id, orderId: `ord-loop-${id}`, ticker: "KXETH15M-WRONG-MARKET" }),
    },
    {
      name: "attempt ID belonging to a different persisted record",
      identity: (id: string) => ({ attemptId: "different-persisted-attempt", orderId: `ord-loop-${id}`, ticker: "KXBTC15M-TEST-RECONCILER-LOOP" }),
    },
    {
      name: "missing persisted ownership",
      identity: (id: string) => ({ attemptId: id, orderId: `ord-loop-${id}`, ticker: "KXBTC15M-TEST-RECONCILER-LOOP" }),
    },
  ]) {
    it(`fails closed before any reconciliation mutation for ${scenario.name}`, async () => {
      const id = prepareAttempt(70);
      const identity = scenario.identity(id);
      let fetched = 0;
      let verified: unknown = null;
      _setVerifyReconciliationOwnershipForTesting(async (candidate) => {
        verified = candidate;
        return false;
      });
      _setFetchFillsForTesting(async () => {
        fetched++;
        return { params: { contracts: 100, fillPriceCents: 65, notionalDollars: 65, feeDollars: 0.01 }, fillRows: [] };
      });

      const pending = reconcileOrder(
        id,
        identity.orderId,
        "yes",
        70,
        identity.ticker,
        identity.attemptId,
      );
      await flushPromises();
      mock.timers.tick(2_000);
      await flushPromises();
      await pending;

      assert.deepEqual(verified, identity);
      assert.equal(fetched, 0, "unbound identities must not reach the exchange fill read");
      const record = getOrderAttempts().find((row) => row.id === id);
      assert.equal(record?.reconciled, false, "unbound identities must not update analytics");
      assert.notEqual(record?.reconcile_failed, true, "unbound identities must not write failure state");
    });
  }

  // ── 9. Empty fills on attempts 1 & 2, real fills on attempt 3 ──────────────
  it("9: empty on attempts 1 & 2, real fills on attempt 3 → reconciliation completes with correct weighted avg", async () => {
    const id = prepareAttempt(70);

    // Mock fetchFills: first two calls return null (empty); third returns fills.
    let callCount = 0;
    _setFetchFillsForTesting(async () => {
      callCount++;
      if (callCount < 3) return null;
      // 100 contracts @ 65¢ — significant price improvement vs 70¢ limit
      return {
        params: {
          contracts:       100,
          fillPriceCents:  65,
          notionalDollars: (100 * 65) / 100,
          feeDollars:      0.01,
        },
        fillRows: [],
      };
    });

    // Start the loop without awaiting — it is blocked on the first sleep(2 000).
    const p = reconcileOrder(id, `ord-loop-${id}`, "yes", 70, "KXBTC15M-TEST-RECONCILER-LOOP");
    await flushPromises();

    // ── Attempt 1 (delay: 2 s) ─────────────────────────────────────────────
    mock.timers.tick(2_000);
    await flushPromises(); // sleep resolves + fetchFills mock runs
    assert.strictEqual(callCount, 1, "fetchFills called once after first sleep");

    // ── Attempt 2 (delay: 5 s) ─────────────────────────────────────────────
    mock.timers.tick(5_000);
    await flushPromises();
    assert.strictEqual(callCount, 2, "fetchFills called twice after second sleep");

    // ── Attempt 3 (delay: 10 s) — real fills returned ──────────────────────
    mock.timers.tick(10_000);
    await flushPromises();
    await p; // reconcileOrder should now have returned

    assert.strictEqual(callCount, 3, "fetchFills called three times total");

    const orders = getOrderAttempts();
    const rec = orders.find((o) => o.id === id);
    assert.ok(rec, "analytics record must exist");
    assert.strictEqual(rec.reconciled, true, "reconciled flag must be set");
    assert.ok(!rec.reconcile_failed, "reconcile_failed must NOT be set");
    assert.strictEqual(rec.fillPriceCents.value, 65, "fill price updated to actual 65¢ avg");
    assert.strictEqual(rec.fillPriceCents.source, "confirmed_from_fills_api", "source set to confirmed");
    assert.strictEqual(rec.contracts.value, 100, "contracts");
    assert.ok(
      Math.abs(rec.notionalDollars.value - (100 * 65) / 100) < 0.01,
      `notional expected $65, got ${rec.notionalDollars.value}`,
    );
  });

  // ── 10. All 3 attempts return empty fills → recordReconciliationFailed ──────
  it("10: all 3 attempts return empty fills → reconcile_failed = true", async () => {
    const id = prepareAttempt(70);

    _setFetchFillsForTesting(async () => null); // always empty

    const p = reconcileOrder(id, `ord-loop-${id}`, "yes", 70, "KXBTC15M-TEST-RECONCILER-LOOP");
    await flushPromises();

    mock.timers.tick(2_000);
    await flushPromises();

    mock.timers.tick(5_000);
    await flushPromises();

    mock.timers.tick(10_000);
    await flushPromises();
    await p;

    const orders = getOrderAttempts();
    const rec = orders.find((o) => o.id === id);
    assert.ok(rec, "analytics record must exist");
    assert.strictEqual(rec.reconcile_failed, true, "reconcile_failed must be set after all empty retries");
    assert.strictEqual(rec.reconciled, false, "reconciled must NOT be set");
    // Estimated fill values must be preserved — not zeroed out
    assert.strictEqual(rec.fillPriceCents.value, 70, "fill price stays at estimated 70¢");
  });

  // ── 11. All 3 attempts throw a network error → recordReconciliationFailed ───
  it("11: all 3 attempts throw a network error → reconcile_failed = true", async () => {
    const id = prepareAttempt(70);

    _setFetchFillsForTesting(async () => {
      throw Object.assign(new Error("network error"), { status: 503 });
    });

    const p = reconcileOrder(id, `ord-loop-${id}`, "yes", 70, "KXBTC15M-TEST-RECONCILER-LOOP");
    await flushPromises();

    mock.timers.tick(2_000);
    await flushPromises();

    mock.timers.tick(5_000);
    await flushPromises();

    mock.timers.tick(10_000);
    await flushPromises();
    await p;

    const orders = getOrderAttempts();
    const rec = orders.find((o) => o.id === id);
    assert.ok(rec, "analytics record must exist");
    assert.strictEqual(rec.reconcile_failed, true, "reconcile_failed must be set after all null-fill retries");
    assert.strictEqual(rec.reconciled, false, "reconciled must NOT be set");
    assert.strictEqual(rec.fillPriceCents.value, 70, "fill price stays at estimated 70¢");
  });

});

// ── Corrected reconciliation endpoint ─────────────────────────────────────────
// Verifies that the fill reconciler calls /portfolio/fills?order_id=…
// (not the old /portfolio/events/orders/{id}/fills path that returns 404).

// ── Exchange-history discovery tests ─────────────────────────────────────────
// These tests exercise discoverAndReconcileMissingBotFills() end-to-end using
// injected mocks for the Kalshi API (via _setKalshiAuthFetchForTesting) and
// the tradeStore DB functions (via _setLoadKalshiOrderIdsForDateForTesting and
// No real DB required.

describe("exchange history discovery", () => {
  beforeEach(() => {
    // Default no-op watermark persist — individual tests override this when they
    // need to assert persist calls or simulate write failures.
    _setPersistSweepCompletionForTesting(async () => { /* no-op */ });
  });
  afterEach(() => {
    _setKalshiAuthFetchForTesting(null);
    _setLoadKalshiOrderIdsForDateForTesting(null);
    _setLoadKnownOrderIdsForEasternDateForTesting(null);
    _setPersistSweepCompletionForTesting(null);
    _resetExchangeDiscoverySweepStatusForTesting();
  });

  // Helper: minimal KalshiAllFillsWire-compatible fill payload.
  function makeFill(orderId: string, ticker: string, side: "yes" | "no"): Record<string, unknown> {
    const yesPriceDollars = side === "yes" ? "0.8000" : "0.2000";
    const noPriceDollars  = side === "yes" ? "0.2000" : "0.8000";
    return {
      order_id:      orderId,
      market_ticker: ticker,
      side:          "yes",           // wire always says "yes" per memory note
      action:        "buy",
      yes_price:     yesPriceDollars,
      no_price:      noPriceDollars,
      count:         10,
      created_time:  "2026-08-13T16:00:00Z",
      trade_id:      `trade-${orderId}`,
    };
  }

  // ── 15. Pagination cursor is forwarded across pages ────────────────────────
  it("15: fetchAllFillsForDate uses limit=100 and follows pagination cursor", async () => {
    const date  = "2026-08-13";
    let   calls = 0;
    const capturedPaths: string[] = [];

    // Page 1 returns a cursor; page 2 exhausts it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (_method: string, path: string): Promise<any> => {
      capturedPaths.push(path);
      calls++;
      if (calls === 1) {
        return { fills: [makeFill("order-p1", "KXBTC15M-26AUG1300-T0.25", "yes")], cursor: "page2cursor" };
      }
      return { fills: [makeFill("order-p2", "KXBTC15M-26AUG1300-T0.25", "yes")], cursor: "" };
    });

    // Both orders are already in the local ledger — no unmatched fills.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["order-p1", "order-p2"]));

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(calls, 2, "must paginate to the second page");
    assert.ok(capturedPaths.every((p) => p.includes("limit=100")),
      `all requests must use limit=100; got: ${JSON.stringify(capturedPaths)}`);
    assert.ok(capturedPaths[1]!.includes("cursor=page2cursor"),
      `second request must include cursor; got: ${capturedPaths[1]}`);
    // All fills matched → sweep complete.
    assert.equal(isExchangeDiscoverySweepComplete(date), true,
      "sweep must be complete after all fills matched");
  });

  // ── 16. Bot-ticker filtering ───────────────────────────────────────────────
  it("16: only KXBTC15M and KXETH15M fills are counted; non-bot tickers are skipped", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [
        makeFill("bot-btc",  "KXBTC15M-26AUG1300-T0.25", "yes"),  // bot ✓
        makeFill("bot-eth",  "KXETH15M-26AUG1300-T1800",  "no"),   // bot ✓
        makeFill("non-bot",  "SPORT-GAME-XYZ",            "yes"),  // non-bot — must be ignored
      ],
    }));

    // Only bot orders are in the local ledger.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["bot-btc", "bot-eth"]));

    await discoverAndReconcileMissingBotFills(date);

    // Non-bot fill does not cause the sweep to stay incomplete.
    assert.equal(isExchangeDiscoverySweepComplete(date), true,
      "non-bot ticker fill must not block sweep completion");
  });

  // ── 17. Already-known orders: no unmatched count ──────────────────────────
  it("17: exchange fill whose order_id is in the local ledger is not counted as unmatched", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("known-order", "KXBTC15M-26AUG1300-T0.25", "yes")],
    }));

    // Order is already in the local ledger.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["known-order"]));

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(isExchangeDiscoverySweepComplete(date), true,
      "all fills matched → sweep must be complete");
  });

  // ── 18. Unmatched bot fill keeps sweep incomplete ─────────────────────────
  it("18: unmatched bot-series fill increments unmatchedBotFillCount; sweep stays incomplete", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("missing-order", "KXBTC15M-26AUG1300-T0.25", "yes")],
    }));

    // The order is NOT in the local ledger.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(isExchangeDiscoverySweepComplete(date), false,
      "unmatched bot fill must keep sweep incomplete");
  });

  // ── 19. Mix: one matched, one unmatched → incomplete ──────────────────────
  it("19: one matched and one unmatched bot fill → sweep stays incomplete", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [
        makeFill("known-order",   "KXBTC15M-26AUG1300-T0.25", "yes"),
        makeFill("missing-order", "KXBTC15M-26AUG1300-T0.25", "yes"),
      ],
    }));

    // Only one order is in the local ledger.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["known-order"]));

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(isExchangeDiscoverySweepComplete(date), false,
      "one unmatched fill must keep sweep incomplete");
  });

  // ── 20. Non-bot ticker fill not in DB → not counted ───────────────────────
  it("20: non-bot ticker fill absent from local DB is not counted as unmatched", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("manual-trade", "SPORT-GAME-XYZ", "yes")],
    }));

    // Nothing in local ledger — but this is non-bot, so it must be skipped.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());

    await discoverAndReconcileMissingBotFills(date);

    // No bot fills at all → sweep complete (no unmatched bot fills).
    assert.equal(isExchangeDiscoverySweepComplete(date), true,
      "non-bot fill absent from DB must not block sweep completion");
  });

  // ── 21. Empty exchange history → sweep complete ────────────────────────────
  it("21: empty exchange fill history → sweep complete with no unmatched", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({ fills: [] }));
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(isExchangeDiscoverySweepComplete(date), true,
      "no exchange fills → sweep must be complete");
  });

  // ── 22. Repeat sweep with persistent unmatched → still incomplete ─────────
  it("22: repeat sweep with persistent unmatched fill → sweep stays incomplete on both runs", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("missing-order", "KXBTC15M-26AUG1300-T0.25", "yes")],
    }));
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());

    await discoverAndReconcileMissingBotFills(date);
    assert.equal(isExchangeDiscoverySweepComplete(date), false, "first run: incomplete");

    // Re-trigger without adding the order to the local ledger.
    _resetExchangeDiscoverySweepStatusForTesting();
    await discoverAndReconcileMissingBotFills(date);
    assert.equal(isExchangeDiscoverySweepComplete(date), false, "second run: still incomplete");
  });

  // ── 23. Unmatched fill then local ledger updated → complete ───────────────
  it("23: after unmatched fill is added to local ledger, next sweep detects match and completes", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("late-order", "KXBTC15M-26AUG1300-T0.25", "yes")],
    }));

    // First sweep: order missing from local ledger.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());
    await discoverAndReconcileMissingBotFills(date);
    assert.equal(isExchangeDiscoverySweepComplete(date), false, "first sweep: incomplete");

    // Simulate the order being added to the local ledger (e.g. manual backfill).
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["late-order"]));
    _resetExchangeDiscoverySweepStatusForTesting();
    await discoverAndReconcileMissingBotFills(date);
    assert.equal(isExchangeDiscoverySweepComplete(date), true, "second sweep: complete after order added");
  });

  // ── 24. Watermark is persisted when sweep completes ───────────────────────
  it("24: watermark is persisted exactly once when sweep completes", async () => {
    const date = "2026-08-13";
    let persistCalls = 0;
    let persistedDate: string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("matched-order", "KXBTC15M-26AUG1300-T0.25", "yes")],
    }));
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["matched-order"]));
    _setPersistSweepCompletionForTesting(async (d: string) => {
      persistCalls++;
      persistedDate = d;
    });

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(persistCalls, 1, "watermark must be persisted exactly once");
    assert.equal(persistedDate, date, "watermark must record the correct date");
    assert.equal(isExchangeDiscoverySweepComplete(date), true);
  });

  // ── 25. Watermark write failure → sweep stays incomplete ──────────────────
  it("25: watermark write failure → sweep remains incomplete in memory", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("matched-order", "KXBTC15M-26AUG1300-T0.25", "yes")],
    }));
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["matched-order"]));
    // Simulate a DB write failure when persisting the watermark.
    _setPersistSweepCompletionForTesting(async () => {
      throw new Error("simulated DB write failure");
    });

    await discoverAndReconcileMissingBotFills(date);

    // Even though Phase 1 matched all fills, the watermark write failed, so
    // the in-memory status must stay incomplete (fail-closed).
    assert.equal(isExchangeDiscoverySweepComplete(date), false,
      "watermark write failure must leave sweep incomplete");
  });

  // ── 26. Truncated pagination → sweep stays incomplete ─────────────────────
  it("26: truncated pagination response → sweep stays incomplete", async () => {
    const date = "2026-08-13";
    let calls = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => {
      calls++;
      if (calls === 1) {
        // Page 1 returns a cursor but the mock throws on page 2 (simulates
        // a mid-pagination API error that truncates the result set).
        return { fills: [makeFill("p1-order", "KXBTC15M-26AUG1300-T0.25", "yes")], cursor: "page2" };
      }
      throw new Error("simulated API error on page 2");
    });
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set(["p1-order"]));

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(isExchangeDiscoverySweepComplete(date), false,
      "truncated pagination must leave sweep incomplete");
  });

  // ── 27. Kalshi API error → sweep stays incomplete (fail-closed) ───────────
  it("27: Kalshi API error on the first page → sweep stays incomplete", async () => {
    const date = "2026-08-13";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => {
      throw new Error("simulated Kalshi API outage");
    });
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(isExchangeDiscoverySweepComplete(date), false,
      "API error must leave sweep incomplete (fail-closed)");
  });

  // ── new. Unmatched bot fill: excluded from verified P&L, watermark withheld ─
  it("new: unmatched bot-series fill excluded from verified P&L — sweep stays incomplete; watermark not persisted", async () => {
    const date = "2026-08-13";
    let persistCalls = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("unmatched-bot-order", "KXBTC15M-26AUG1300-T0.25", "yes")],
    }));
    // Order is absent from the local ledger — this is the "ghost fill" scenario.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());
    _setPersistSweepCompletionForTesting(async () => { persistCalls++; });

    await discoverAndReconcileMissingBotFills(date);

    // Sweep is incomplete: the unmatched fill is excluded, NOT imported.
    assert.equal(isExchangeDiscoverySweepComplete(date), false,
      "unmatched bot fill must keep sweep incomplete");
    // Watermark must NOT be persisted — verified P&L is withheld until the
    // gap is closed by a full local ledger match.
    assert.equal(persistCalls, 0,
      "watermark must NOT be persisted when unmatchedBotFillCount > 0");
  });

  it("recognizes a durable ETH martingale order across restart-style discovery sweeps without a legacy parent", async () => {
    const date = "2026-08-13";
    const ethOrderId = "eth-martingale-durable-order";
    let persisted = 0;

    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill(ethOrderId, "KXETH15M-26AUG1300-T1800", "no")],
    }));
    // This set is the combined durable ownership result: no order_attempts
    // parent exists, but eth_martingale_orders has the exact Kalshi order ID.
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set([ethOrderId]));
    _setPersistSweepCompletionForTesting(async () => { persisted++; });

    await discoverAndReconcileMissingBotFills(date);
    assert.equal(isExchangeDiscoverySweepComplete(date), true,
      "durable ETH martingale ownership must prevent a false unmatched-fill gap");

    // A process restart clears only in-memory sweep status. Re-reading the
    // durable ID must still classify the same exchange fill as owned.
    _resetExchangeDiscoverySweepStatusForTesting();
    await discoverAndReconcileMissingBotFills(date);
    assert.equal(isExchangeDiscoverySweepComplete(date), true,
      "restart-style recheck must retain ETH martingale ownership");
    assert.equal(persisted, 2, "each complete sweep may persist its own watermark");
  });

  it("keeps an unknown ETH-series fill excluded when neither durable ledger owns its order ID", async () => {
    const date = "2026-08-13";
    _setKalshiAuthFetchForTesting(async (): Promise<any> => ({
      fills: [makeFill("manual-eth-order", "KXETH15M-26AUG1300-T1800", "yes")],
    }));
    _setLoadKalshiOrderIdsForDateForTesting(async () => new Set());

    await discoverAndReconcileMissingBotFills(date);

    assert.equal(isExchangeDiscoverySweepComplete(date), false,
      "ticker prefix alone must not turn an unowned ETH fill into verified bot P&L");
  });

});

describe("exchange history sweep date guard", () => {
  it("accepts a real bot-era calendar date", () => {
    assert.equal(isTrustedSweepDate("2026-08-14"), true);
  });

  it("rejects malformed and pre-inception dates", () => {
    assert.equal(isTrustedSweepDate("2026-02-30"), false, "invalid calendar date");
    assert.equal(isTrustedSweepDate("1970-01-01"), false, "pre-bot history must never be swept");
    assert.equal(isTrustedSweepDate("not-a-date"), false);
  });

  it("ignores an invalid configured sweep date", () => {
    const previous = process.env.EXCHANGE_SWEEP_START_DATE;
    process.env.EXCHANGE_SWEEP_START_DATE = "1970-01-01";
    try {
      assert.equal(getSweepStartDate(), "2026-07-01");
    } finally {
      if (previous === undefined) delete process.env.EXCHANGE_SWEEP_START_DATE;
      else process.env.EXCHANGE_SWEEP_START_DATE = previous;
    }
  });
});

describe("bounded exchange coverage", () => {
  beforeEach(() => {
    _resetExchangeCoverageStatusForTesting();
  });

  afterEach(() => {
    _setKalshiAuthFetchForTesting(null);
    _setLoadKnownOrderIdsForEasternDateForTesting(null);
    _resetExchangeCoverageStatusForTesting();
  });

  it("counts an exact ETH martingale order ID as covered without a legacy parent", async () => {
    const now = new Date().toISOString();
    _setLoadKnownOrderIdsForEasternDateForTesting(async () =>
      new Set(["eth-martingale-covered-order"]),
    );
    _setKalshiAuthFetchForTesting((async () => ({
      fills: [{ order_id: "eth-martingale-covered-order", created_time: now }],
    })) as never);

    await checkExchangeFillCoverage();

    const status = getExchangeCoverageStatus();
    assert.equal(status.complete, true);
    assert.equal(status.unmatchedOrderCount, 0,
      "an exact durable ETH martingale ID must not be reported as a coverage gap");
  });

  it("does not claim complete coverage when the request cap leaves a cursor", async () => {
    const now = new Date().toISOString();
    _setKalshiAuthFetchForTesting((async () => ({
      fills: Array.from({ length: 100 }, (_, i) => ({
        order_id: `bounded-coverage-${i}`,
        created_time: now,
      })),
      cursor: "more-results",
    })) as never);

    await checkExchangeFillCoverage(100);

    const status = getExchangeCoverageStatus();
    assert.equal(status.truncated, true);
    assert.equal(status.complete, false);
    assert.equal(status.unmatchedOrderCount, null);
    assert.match(status.lastError ?? "", /limited/i);
  });

  it("treats a short page with a cursor as incomplete when it reaches the cap", async () => {
    const now = new Date().toISOString();
    _setKalshiAuthFetchForTesting((async () => ({
      fills: Array.from({ length: 50 }, (_, i) => ({
        order_id: `short-bounded-coverage-${i}`,
        created_time: now,
      })),
      cursor: "more-results",
    })) as never);

    await checkExchangeFillCoverage(50);

    const status = getExchangeCoverageStatus();
    assert.equal(status.truncated, true);
    assert.equal(status.complete, false);
    assert.equal(status.unmatchedOrderCount, null);
  });

  it("follows every cursor page when no defensive ceiling is supplied", async () => {
    const now = new Date().toISOString();
    const paths: string[] = [];
    _setKalshiAuthFetchForTesting((async (_method: string, path: string) => {
      paths.push(path);
      if (!path.includes("cursor=")) {
        return {
          fills: Array.from({ length: 100 }, (_, i) => ({ order_id: `page-one-${i}`, created_time: now })),
          cursor: "page-two",
        };
      }
      return {
        fills: Array.from({ length: 25 }, (_, i) => ({ order_id: `page-two-${i}`, created_time: now })),
      };
    }) as never);

    await checkExchangeFillCoverage();

    const status = getExchangeCoverageStatus();
    assert.equal(paths.length, 2, "all cursor pages must be read");
    assert.match(paths[1]!, /cursor=page-two/);
    assert.equal(status.truncated, false);
    assert.equal(status.complete, true);
    assert.equal(status.unmatchedOrderCount, 125);
  });
});


describe("fillReconciler endpoint URL", () => {

  beforeEach(() => {
    _setVerifyReconciliationOwnershipForTesting(async () => true);
  });

  afterEach(() => {
    _setKalshiAuthFetchForTesting(null);
    _setFetchFillsForTesting(null);
    _setVerifyReconciliationOwnershipForTesting(null);
    mock.timers.reset();
  });

  // ── 13. Correct fills endpoint path is used ──────────────────────────────
  it("13: fetchFills calls /portfolio/fills?order_id=… not the old /portfolio/events/orders/{id}/fills path", async () => {
    _resetStateForTesting();
    mock.timers.enable({ apis: ["setTimeout"] });

    const orderId = `ord-sweep-pk-${Math.random().toString(36).slice(2)}`;
    let capturedPath: string | undefined;

    // Inject at the kalshiAuthFetch level so the real fetchFills runs and we
    // can observe what URL it constructs.  Return empty fills so we avoid
    // attempting SQL persistence (no DB in unit tests) — all 3 retries will
    // see empty fills and reconcileOrder will mark reconcile_failed.
    // Do NOT override with _setFetchFillsForTesting — that would bypass fetchFills
    // entirely and prevent capturedPath from being populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setKalshiAuthFetchForTesting(async (_method: string, path: string): Promise<any> => {
      capturedPath = path;
      return { fills: [] }; // empty — triggers retry without DB persistence
    });

    const id = recordOrderAttempt({
      ticker:             "KXBTC15M-TEST-URL",
      series:             "KXBTC15M",
      windowCloseTime:    "2026-08-12T00:00:00Z",
      side:               "yes",
      source:             "websocket",
      triggerPriceCents:  79,
      limitPriceCents:    80,
      requestedContracts: 10,
      clientOrderId:      `url-cid-${Math.random().toString(36).slice(2)}`,
    });
    recordFill(id, {
      orderId,
      fillCount: 10, requestedCount: 10, contractsFilled: 10,
      fillPriceCents: 80, notionalDollars: 8, feeDollars: 0.005,
      pricesKnown: false, roundTripMs: 50,
    });

    // Do NOT set _setFetchFillsForTesting — the real fetchFills must run so
    // kalshiAuthFetch is called and capturedPath is populated.
    const p = reconcileOrder(id, orderId, "yes", 80, "KXBTC15M-TEST-URL");
    await flushPromises();
    mock.timers.tick(2_000); await flushPromises();
    mock.timers.tick(5_000); await flushPromises();
    mock.timers.tick(10_000); await flushPromises();
    await p;

    assert.ok(capturedPath !== undefined, "kalshiAuthFetch must have been called");
    assert.ok(
      capturedPath!.startsWith("/portfolio/fills?order_id="),
      `expected /portfolio/fills?order_id=… path, got: ${capturedPath}`,
    );
    assert.ok(
      !capturedPath!.includes("/portfolio/events/orders/"),
      `must NOT use the old /portfolio/events/orders/{id}/fills path; got: ${capturedPath}`,
    );
    // Verify the order ID is correctly encoded in the query string.
    assert.ok(
      capturedPath!.includes(encodeURIComponent(orderId)),
      `order ID ${orderId} should be URI-encoded in path; got: ${capturedPath}`,
    );
  });

  // ── 14. reconcile_failed recovery: empty-fills permanent failure then a
  //        new eligible order should NOT be blocked by the old failed fill ────
  it("14: after permanent reconcile_failed, analytics reconcile_failed=true is set and reconciled stays false", async () => {
    _resetStateForTesting();
    mock.timers.enable({ apis: ["setTimeout"] });

    const id = recordOrderAttempt({
      ticker:             "KXBTC15M-TEST-RECOVERY",
      series:             "KXBTC15M",
      windowCloseTime:    "2026-08-12T00:00:00Z",
      side:               "yes",
      source:             "websocket",
      triggerPriceCents:  79,
      limitPriceCents:    80,
      requestedContracts: 10,
      clientOrderId:      `recovery-cid-${Math.random().toString(36).slice(2)}`,
    });
    recordFill(id, {
      orderId: `ord-recovery-${id}`,
      fillCount: 10, requestedCount: 10, contractsFilled: 10,
      fillPriceCents: 80, notionalDollars: 8, feeDollars: 0.005,
      pricesKnown: false, roundTripMs: 50,
    });

    // All attempts return 404 (empty fills) — simulates the production bug
    _setFetchFillsForTesting(async () => null);

    const p = reconcileOrder(id, `ord-recovery-${id}`, "yes", 80, "KXBTC15M-TEST-RECOVERY");
    await flushPromises();
    mock.timers.tick(2_000); await flushPromises();
    mock.timers.tick(5_000); await flushPromises();
    mock.timers.tick(10_000); await flushPromises();
    await p;

    const orders = getOrderAttempts();
    const rec = orders.find((o) => o.id === id);
    assert.ok(rec, "analytics record must exist");
    // reconcile_failed=true means the SQL row has been flagged — getDailyRealizedPnl
    // excludes these from the "unreconciled" count so other entries are not blocked.
    assert.strictEqual(rec.reconcile_failed, true, "reconcile_failed must be set");
    assert.strictEqual(rec.reconciled, false, "reconciled must stay false (uses estimated values)");
    // Estimated fill values preserved — P&L can still be computed from these
    assert.strictEqual(rec.fillPriceCents.value, 80, "estimated fill price preserved");
    assert.ok(Math.abs(rec.feeDollars.value - 0.005) < 0.0001, "estimated fee preserved");
  });

  // ── 15. sqlAttemptId FK contract: autoTrader passes raw UUID as 6th arg ──────
  it("15: autoTrader path — rawSqlUuid passed as sqlAttemptId is forwarded to fetchFills so the FK is correct", async () => {
    _resetStateForTesting();
    mock.timers.enable({ apis: ["setTimeout"] });

    // Build the fixture: recordOrderAttempt returns the compound analytics ID
    // (${clientOrderId}-1), while autoTrader passes the raw clientOrderId (the SQL PK)
    // as the 6th argument to reconcileOrder.
    const clientOrderId     = `fk-cid-${Math.random().toString(36).slice(2)}`;
    const rawSqlUuid        = clientOrderId;                // SQL PK = raw UUID (no "-N")
    const analyticsId       = recordOrderAttempt({
      ticker:             "KXBTC15M-FK-AUTOTRADER",
      series:             "KXBTC15M",
      windowCloseTime:    "2026-08-12T00:00:00Z",
      side:               "yes",
      source:             "websocket",
      triggerPriceCents:  69,
      limitPriceCents:    70,
      requestedContracts: 10,
      clientOrderId,
    });
    // analyticsId = "${clientOrderId}-1" (compound format)
    const compoundAnalyticsId = analyticsId;
    recordFill(analyticsId, {
      orderId:        `ord-fk-${clientOrderId}`,
      fillCount: 10, requestedCount: 10, contractsFilled: 10,
      fillPriceCents: 70, notionalDollars: 7, feeDollars: 0.005,
      pricesKnown: false, roundTripMs: 50,
    });

    let capturedAttemptId:    string | undefined;
    let capturedSqlAttemptId: string | undefined;
    _setFetchFillsForTesting(async (_orderId, attemptId, _side, _ticker, sqlAttemptId) => {
      capturedAttemptId    = attemptId;
      capturedSqlAttemptId = sqlAttemptId;
      return {
        params: { contracts: 10, fillPriceCents: 70, notionalDollars: 7, feeDollars: 0.005 },
        fillRows: [],
      };
    });

    // autoTrader passes rawSqlUuid as the 6th argument (sqlAttemptId).
    const p = reconcileOrder(
      analyticsId,
      `ord-fk-${clientOrderId}`,
      "yes",
      70,
      "KXBTC15M-FK-AUTOTRADER",
      rawSqlUuid,
    );
    await flushPromises();
    mock.timers.tick(2_000); await flushPromises();
    await p;

    assert.ok(capturedAttemptId !== undefined, "fetchFills must have been called");

    // Verify the fixture: analyticsId must be the compound format (${clientOrderId}-1).
    assert.strictEqual(analyticsId, compoundAnalyticsId, "fixture: analyticsId must be compound");
    assert.ok(
      /\-\d+$/.test(analyticsId),
      "fixture: analyticsId must carry a '-N' suffix (compound format)",
    );

    // The raw SQL UUID (6th arg) must be forwarded to fetchFills as sqlAttemptId.
    assert.strictEqual(
      capturedSqlAttemptId,
      rawSqlUuid,
      "fetchFills must receive the raw SQL UUID as sqlAttemptId — not the compound analytics ID",
    );

    // sqlAttemptId must NOT carry a '-N' suffix.
    assert.ok(
      !/\-\d+$/.test(capturedSqlAttemptId!),
      "sqlAttemptId forwarded to fetchFills must not carry a '-N' suffix",
    );
  });

  // ── 16. recovery sweep path: no sqlAttemptId — attemptId IS the SQL PK ────
  it("16: recovery sweep path — omitting sqlAttemptId forwards a raw UUID (no -N suffix) to fetchFills so the FK is correct", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    // loadUnreconciledFilledOrders returns `orderAttempts.id` (SQL primary key) as
    // the `attemptId` field.  That column is a plain UUID — never the compound
    // "${clientOrderId}-${attemptNumber}" format that recordOrderAttempt() produces.
    //
    // The recovery sweep then calls:
    //   reconcileOrder(order.attemptId, order.orderId, side, 0, ticker)
    // with NO sixth argument.  Inside fetchFills the FK is written as:
    //   attemptId: sqlAttemptId ?? attemptId
    // so when sqlAttemptId is omitted the SQL PK flows through unchanged.
    //
    // This test simulates that call path by constructing a UUID-shaped string
    // directly (not via recordOrderAttempt, which always appends "-N").  It then
    // asserts:
    //   a) The UUID has no "-N" suffix — confirming the fixture matches the real
    //      loadUnreconciledFilledOrders shape.
    //   b) fetchFills receives it unchanged in the attemptId position.
    //   c) sqlAttemptId is undefined — so the "?? attemptId" fallback in the
    //      real fetchFills will write this plain UUID into order_fills.attempt_id.

    // Construct a UUID-shaped SQL primary key.  A real order_attempts.id looks
    // like "550e8400-e29b-41d4-a716-446655440000".  We build one from random
    // hex that has no "-N" analytics suffix.
    const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    // Keep the SQL-PK fixture deterministic at the suffix boundary: a UUID can
    // legitimately end in decimal digits, which would make /-\\d+$/ mistake
    // the UUID tail for the analytics "-N" suffix this test is excluding.
    const rawSqlPk = "550e8400-e29b-41d4-a716-44665544abcd";

    // Confirm the fixture itself is suffix-free.
    assert.ok(
      !/\-\d+$/.test(rawSqlPk),
      `test fixture must not have a '-N' suffix (got: ${rawSqlPk})`,
    );

    const orderId = `ord-sweep-pk-${hex()}`;

    let capturedAttemptId:    string | undefined;
    let capturedSqlAttemptId: string | undefined;

    _setFetchFillsForTesting(async (_orderId, attemptId, _side, _ticker, sqlAttemptId) => {
      capturedAttemptId    = attemptId;
      capturedSqlAttemptId = sqlAttemptId;
      return {
        params: { contracts: 50, fillPriceCents: 78, notionalDollars: 39, feeDollars: 0.01 },
        fillRows: [],
      };
    });

    const p = reconcileOrder(rawSqlPk, orderId, "yes", 0, "KXBTC15M-FK-SWEEP");
    await flushPromises();
    mock.timers.tick(2_000); await flushPromises();
    await p;

    assert.ok(capturedAttemptId !== undefined, "fetchFills must have been called");

    // The raw SQL PK must flow through to fetchFills as the attemptId.
    assert.strictEqual(
      capturedAttemptId,
      rawSqlPk,
      "fetchFills must receive the raw SQL UUID as attemptId when no sqlAttemptId is passed",
    );

    // The reconciler now explicitly forwards the canonical persisted attempt
    // identity so fetchFills and the eventual write share one tuple.
    assert.strictEqual(
      capturedSqlAttemptId,
      rawSqlPk,
      "recovery must forward the persisted SQL attempt ID to fetchFills",
    );

    // capturedAttemptId must NOT have a '-N' suffix.
    assert.ok(
      !/\-\d+$/.test(capturedAttemptId!),
      "attemptId forwarded to fetchFills must not carry a '-N' suffix",
    );
  });

});
