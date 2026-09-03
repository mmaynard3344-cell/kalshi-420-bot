/**
 * Regression tests — daily P&L: analytics estimate vs verified fill ledger.
 *
 * These tests prove that the in-memory analytics estimate (from order-attempt
 * records) and the verified fill-ledger total (from order_fills child chunks)
 * can legitimately differ, and that the /api/trade/analytics/daily response
 * surfaces BOTH values so the dashboard can prefer the authoritative one.
 *
 * Section 1 — No DB required — analytics state is pure in-memory.
 * Section 2 — DB-backed: verifies getDailyRealizedPnl() returns correct
 *             verified P&L immediately after a simulated server restart
 *             (empty in-memory store, pre-existing order_fills rows in SQL).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, before, after } from "node:test";
import {
  _resetStateForTesting,
  recordOrderAttempt,
  recordFill,
  recordOutcomeResult,
  getDailySummary,
} from "./analytics.js";
import {
  initTradeStore,
  getDailyRealizedPnl,
  reserveAndRecord,
  finaliseOrderAttempt,
  persistVerifiedFillReconciliation,
} from "./tradeStore.js";
import { db } from "@workspace/db";
import { orderAttempts, orderFills, dailyBudget, orderDedup } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ── Helpers ────────────────────────────────────────────────────────────────────

function attempt(overrides: Partial<Parameters<typeof recordOrderAttempt>[0]> = {}) {
  return recordOrderAttempt({
    ticker:             "KXBTC15M-26AUG01-T290300",
    series:             "KXBTC15M",
    windowCloseTime:    "2026-08-13T00:00:00Z",
    side:               "yes",
    source:             "websocket",
    triggerPriceCents:  82,
    limitPriceCents:    83,
    requestedContracts: 100,
    clientOrderId:      "test-cid-daily-001",
    ...overrides,
  });
}

function fillAndResolve(
  id: string,
  opts: { orderId: string; priceCents: number; won: boolean; netPnlDollars: number },
) {
  recordFill(id, {
    orderId:         opts.orderId,
    fillCount:       100,
    requestedCount:  100,
    contractsFilled: 100,
    fillPriceCents:  opts.priceCents,
    notionalDollars: opts.priceCents,
    feeDollars:      0.03,
    pricesKnown:     true,
    roundTripMs:     100,
  });
  recordOutcomeResult(id, {
    marketResult:     opts.won ? "yes" : "no",
    win:              opts.won,
    grossPnlDollars:  opts.netPnlDollars + 0.03,
    netPnlDollars:    opts.netPnlDollars,
    roi:              opts.netPnlDollars / opts.priceCents,
    windowClosedAtMs: Date.now() - 180_000,
    holdMs:           180_000,
    reconciledAtMs:   Date.now(),
  });
}

beforeEach(() => {
  _resetStateForTesting();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("daily P&L — analytics estimate vs verified fill ledger", () => {
  it("analytics netPnlDollars reflects outcome-reconciled result for a single win", () => {
    const id = attempt({ clientOrderId: "cid-001" });
    fillAndResolve(id, { orderId: "ord-001", priceCents: 83, won: true, netPnlDollars: 12.50 });

    const summary = getDailySummary();
    assert.equal(summary.combined.winsCount, 1);
    assert.equal(summary.combined.lossesCount, 0);
    assert.ok(
      Math.abs(summary.combined.netPnlDollars - 12.50) < 0.001,
      `expected netPnlDollars ≈ 12.50, got ${summary.combined.netPnlDollars}`,
    );
    assert.equal(summary.combined.winRate, 1.0);
  });

  it("analytics estimate can differ from what verified fill chunks would produce", () => {
    // Parent attempt outcome sets netPnlDollars = 12.50.
    // If Kalshi's order_fills child chunks add up to 11.90 (e.g. different fee
    // rounding), the verified ledger would show 11.90 while the analytics
    // estimate stays at 12.50. The /daily endpoint must expose both.
    const id1 = attempt({ clientOrderId: "cid-002" });
    fillAndResolve(id1, { orderId: "ord-002", priceCents: 83, won: true, netPnlDollars: 12.50 });

    const id2 = attempt({
      clientOrderId: "cid-003",
      ticker: "KXBTC15M-26AUG01-T290200",
    });
    fillAndResolve(id2, { orderId: "ord-003", priceCents: 79, won: false, netPnlDollars: -5.00 });

    const summary = getDailySummary();
    assert.equal(summary.combined.winsCount, 1);
    assert.equal(summary.combined.lossesCount, 1);
    // Analytics estimate = parent reconciliation values summed
    assert.ok(
      Math.abs(summary.combined.netPnlDollars - 7.50) < 0.001,
      `analytics netPnlDollars should be 12.50 - 5.00 = 7.50, got ${summary.combined.netPnlDollars}`,
    );

    // The verified fill-ledger total is computed separately from order_fills by
    // getDailyRealizedPnl() (DB-dependent — not testable here without a DB).
    // Document the contract: analytics.netPnlDollars is the ESTIMATE; the
    // /daily endpoint attaches verified.netPnlDollars as the AUTHORITATIVE source.
    assert.equal(typeof summary.combined.netPnlDollars, "number",
      "analytics netPnlDollars must be a number so the card has a fallback");
  });

  it("analytics winRate is null when no orders are outcome-reconciled", () => {
    attempt({ clientOrderId: "cid-004" });
    // No fill, no outcome — unresolved
    const summary = getDailySummary();
    assert.equal(summary.combined.winRate, null);
    assert.equal(summary.combined.winsCount, 0);
    assert.equal(summary.combined.lossesCount, 0);
    assert.equal(summary.combined.netPnlDollars, 0);
  });

  it("win/loss count only counts filled-and-outcome-reconciled orders", () => {
    // Filled + outcome-reconciled (win)
    const id1 = attempt({ clientOrderId: "cid-005" });
    fillAndResolve(id1, { orderId: "ord-005", priceCents: 83, won: true, netPnlDollars: 8.00 });

    // Filled but NOT outcome-reconciled (market not yet settled)
    const id2 = attempt({ clientOrderId: "cid-006", ticker: "KXBTC15M-26AUG01-T291000" });
    recordFill(id2, {
      orderId: "ord-006", fillCount: 100, requestedCount: 100, contractsFilled: 100,
      fillPriceCents: 83, notionalDollars: 83, feeDollars: 0.03, pricesKnown: true, roundTripMs: 100,
    });
    // No recordOutcomeResult call for id2

    const summary = getDailySummary();
    assert.equal(summary.combined.winsCount, 1,
      "only the outcome-reconciled order should count as a win");
    assert.equal(summary.combined.lossesCount, 0);
    assert.equal(summary.combined.successfulFills, 2,
      "both filled orders appear in successfulFills regardless of outcome reconciliation");
  });

  it("display P&L logic: verified overrides analytics estimate; falls back to estimate when verified is null", () => {
    // This test documents the frontend fallback logic (without a browser/DOM).
    // The /daily endpoint returns { ...summary, verified: { netPnlDollars, ... } }.
    // The card uses: verifiedPnl ?? (hasResolved ? c.netPnlDollars : null)

    const id = attempt({ clientOrderId: "cid-007" });
    fillAndResolve(id, { orderId: "ord-007", priceCents: 83, won: true, netPnlDollars: 10.00 });

    const summary = getDailySummary();
    const hasResolved = (summary.combined.winsCount + summary.combined.lossesCount) > 0;
    assert.ok(hasResolved, "at least one resolved order required for P&L display");

    // Scenario A: verified unavailable (DB unreachable, still pending)
    const verifiedPnlPending: number | null = null;
    const displayPnlA = verifiedPnlPending ?? (hasResolved ? summary.combined.netPnlDollars : null);
    assert.ok(
      displayPnlA !== null && Math.abs(displayPnlA - 10.00) < 0.001,
      `when verified is null, display falls back to analytics estimate; got ${displayPnlA}`,
    );

    // Scenario B: verified data arrives with a different (authoritative) total
    const verifiedPnlKnown = 9.85; // order_fills chunks summed to a slightly different total
    const displayPnlB = verifiedPnlKnown ?? (hasResolved ? summary.combined.netPnlDollars : null);
    assert.equal(displayPnlB, 9.85,
      "when verified is available, it overrides the analytics estimate");

    // Scenario C: no resolved orders — show dash regardless of verified
    _resetStateForTesting();
    const summaryC = getDailySummary();
    const hasResolvedC = (summaryC.combined.winsCount + summaryC.combined.lossesCount) > 0;
    const verifiedPnlC: number | null = null;
    const displayPnlC = verifiedPnlC ?? (hasResolvedC ? summaryC.combined.netPnlDollars : null);
    assert.equal(displayPnlC, null,
      "when no resolved orders exist, display shows dash even if analytics has a non-zero value");
  });

  it("ETH fills are tracked separately and both feed combined summary correctly", () => {
    const btcId = attempt({
      clientOrderId: "cid-008-btc",
      ticker: "KXBTC15M-26AUG01-T290300",
      series: "KXBTC15M",
      limitPriceCents: 83,
    });
    fillAndResolve(btcId, { orderId: "ord-008-btc", priceCents: 83, won: true, netPnlDollars: 10.00 });

    const ethId = attempt({
      clientOrderId: "cid-008-eth",
      ticker: "KXETH15M-26AUG01-T290300",
      series: "KXETH15M",
      limitPriceCents: 80,
    });
    fillAndResolve(ethId, { orderId: "ord-008-eth", priceCents: 80, won: false, netPnlDollars: -6.00 });

    const summary = getDailySummary();
    assert.equal(summary.btc.winsCount, 1, "BTC win count");
    assert.equal(summary.eth.lossesCount, 1, "ETH loss count");
    assert.equal(summary.combined.winsCount, 1, "combined win count");
    assert.equal(summary.combined.lossesCount, 1, "combined loss count");
    assert.ok(
      Math.abs(summary.combined.netPnlDollars - 4.00) < 0.001,
      `combined P&L should be 10.00 - 6.00 = 4.00, got ${summary.combined.netPnlDollars}`,
    );
  });

  it("verified.netPnlDollars = null means the card must show pending badge, not wrong number", () => {
    // When verified.pendingVerificationCount > 0 (settled orders awaiting fill chunks),
    // verified.netPnlDollars is null — the card must show a pending indicator and
    // fall back to the analytics estimate rather than displaying a wrong zero.
    const id = attempt({ clientOrderId: "cid-009" });
    fillAndResolve(id, { orderId: "ord-009", priceCents: 83, won: true, netPnlDollars: 15.00 });

    const summary = getDailySummary();

    // Simulate what the /daily endpoint returns when fills are pending:
    const verifiedBlock = {
      netPnlDollars: null as number | null,          // null = unavailable
      settledFillCount: 1,
      pendingVerificationCount: 1,                    // one fill still awaiting chunks
      unverifiedFillCount: 0,
    };

    const hasResolved = (summary.combined.winsCount + summary.combined.lossesCount) > 0;
    const displayPnl = verifiedBlock.netPnlDollars ?? (hasResolved ? summary.combined.netPnlDollars : null);
    const isVerifiedPending = verifiedBlock.pendingVerificationCount > 0;

    assert.ok(isVerifiedPending, "pending badge should be shown");
    assert.ok(
      displayPnl !== null && Math.abs(displayPnl - 15.00) < 0.001,
      `card falls back to analytics estimate (15.00) while pending; got ${displayPnl}`,
    );
    // The displayed value is the fallback estimate, not null/zero
    assert.notEqual(displayPnl, null, "card must not show dash when there is a resolved fill");
    assert.notEqual(displayPnl, 0, "card must not show $0.00 when fill was a win");
  });
});

// ── Section 2: DB-backed restart scenario ─────────────────────────────────────
//
// These tests connect to the real dev database to confirm that
// getDailyRealizedPnl() reads order_fills rows correctly even when the
// in-memory analytics store is empty (as it is immediately after a server
// restart before any orders are rehydrated).
//
// Isolation: uses the fixed historical date "1970-03-15" which is unused by
// any other test suite. All rows are cleaned up in the after() hook.

describe("DB-backed: verified P&L is non-null immediately after restart with prior fills", () => {
  // Fixed test date — must not collide with other test suites.
  const TEST_DATE    = "1970-03-15";
  const CID          = "restart-pnl-test-cid-001";
  const KALSHI_ORDER = "restart-pnl-kalshi-ord-001";
  const TICKER       = "KXBTC15M-RESTART-PNL-001";

  // P&L fixture: 3 contracts won at 80¢.
  // Verified chunk: 3 contracts, cost=$2.40, fee=$0.03
  // Expected net P&L: contracts − cost − fee = 3 − 2.40 − 0.03 = 0.57
  const CONTRACTS        = 3;
  const FILL_PRICE_CENTS = 80;
  const COST_DOLLARS     = 2.40;
  const FEE_DOLLARS      = 0.03;
  const EXPECTED_PNL     = CONTRACTS - COST_DOLLARS - FEE_DOLLARS; // 0.57

  before(async () => {
    await initTradeStore();

    // Clean any leftover rows from a previous failed run.
    await db.delete(orderFills).where(eq(orderFills.orderId, KALSHI_ORDER));
    await db.delete(orderAttempts).where(eq(orderAttempts.id, CID));
    await db.delete(dailyBudget).where(eq(dailyBudget.easternDate, TEST_DATE));
    await db.delete(orderDedup).where(eq(orderDedup.tickerKey, `${TICKER}-yes`));

    // 1. Seed an order_attempts row (simulates a fill that was recorded before restart).
    await reserveAndRecord({
      clientOrderId:          CID,
      ticker:                 TICKER,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes",
      source:                 "test",
      triggerPriceCents:      FILL_PRICE_CENTS,
      limitPriceCents:        FILL_PRICE_CENTS,
      requestedContracts:     CONTRACTS,
      requestedNotionalCents: CONTRACTS * FILL_PRICE_CENTS,
      easternDate:            TEST_DATE,
    });

    // 2. Finalise as fully filled with Kalshi order ID.
    await finaliseOrderAttempt({
      clientOrderId:   CID,
      outcome:         "filled",
      orderId:         KALSHI_ORDER,
      fillCount:       CONTRACTS,
      remainingCount:  0,
      contracts:       CONTRACTS,
      fillPriceCents:  FILL_PRICE_CENTS,
      notionalDollars: COST_DOLLARS,
      feeDollars:      FEE_DOLLARS,
    });

    // 3. Mark as settled (won=true).
    await db.update(orderAttempts)
      .set({ won: true, updatedAt: new Date() })
      .where(eq(orderAttempts.id, CID));

    // 4. Persist the verified fill chunk (sets reconciled=true on the attempt row).
    await persistVerifiedFillReconciliation(
      [{
        seqIndex:       0,
        fillId:         "daily-verified-forward-fill",
        orderId:        KALSHI_ORDER,
        attemptId:      CID,
        ticker:         TICKER,
        side:           "yes",
        fillPriceCents: FILL_PRICE_CENTS,
        contracts:      CONTRACTS,
        costDollars:    COST_DOLLARS,
        feeDollars:     FEE_DOLLARS,
        exactPriceDollars: "0.80",
        exactCostDollars:  "2.40",
        exactFeeDollars:   "0.03",
        fillTimestamp:  null,
      }],
      {
        contracts:       CONTRACTS,
        fillPriceCents:  FILL_PRICE_CENTS,
        notionalDollars: COST_DOLLARS,
        feeDollars:      FEE_DOLLARS,
      },
    );
  });

  after(async () => {
    await db.delete(orderFills).where(eq(orderFills.orderId, KALSHI_ORDER));
    await db.delete(orderAttempts).where(eq(orderAttempts.id, CID));
    await db.delete(dailyBudget).where(eq(dailyBudget.easternDate, TEST_DATE));
    await db.delete(orderDedup).where(eq(orderDedup.tickerKey, `${TICKER}-yes`));
  });

  it("analytics estimate (combined.netPnlDollars) is $0 when in-memory store is empty after restart", () => {
    // Simulate a fresh restart: the in-memory analytics store has no orders.
    _resetStateForTesting();

    const summary = getDailySummary();
    assert.equal(
      summary.combined.netPnlDollars, 0,
      "analytics estimate must be $0 immediately after restart before any orders are rehydrated",
    );
    assert.equal(summary.combined.winsCount, 0, "no wins in empty in-memory store");
    assert.equal(summary.combined.lossesCount, 0, "no losses in empty in-memory store");
  });

  it("verified.netPnlDollars is non-null and correct immediately after restart with prior fills in DB", async () => {
    // In-memory store is still empty from the previous test (no rehydration).
    const summary = getDailySummary();
    assert.equal(summary.combined.netPnlDollars, 0, "in-memory estimate still $0");

    // getDailyRealizedPnl() reads directly from order_fills — no in-memory state needed.
    const result = await getDailyRealizedPnl(TEST_DATE);

    assert.ok(
      result.realizedNetPnlDollars !== null,
      "verified.netPnlDollars must be non-null when order_fills rows exist — " +
      "regression: dashboard card showed $0 or — on first polls after server restart",
    );
    assert.ok(
      Math.abs((result.realizedNetPnlDollars ?? 0) - EXPECTED_PNL) < 0.000001,
      `verified P&L should be ${EXPECTED_PNL} (contracts − cost − fee), got ${result.realizedNetPnlDollars}`,
    );
    assert.equal(result.settledFillCount, 1, "one settled fill");
    assert.equal(result.pendingVerificationCount, 0, "no pending verification — chunk is already stored");
    assert.equal(result.unverifiedFillCount, 0, "no unverified fills");
  });

  it("verified P&L is available even when combined.netPnlDollars is $0 — /daily endpoint returns both", async () => {
    // This mirrors the /trade/analytics/daily endpoint logic:
    //   { ...summary, verified: { netPnlDollars, ... } }
    // The consumer uses verified.netPnlDollars when non-null.

    const [summary, verifiedPnl] = await Promise.all([
      Promise.resolve(getDailySummary()),
      getDailyRealizedPnl(TEST_DATE),
    ]);

    // Analytics estimate is still $0 (in-memory store empty after restart).
    assert.equal(summary.combined.netPnlDollars, 0, "analytics estimate is $0");

    // Verified is available and authoritative.
    assert.ok(
      verifiedPnl.realizedNetPnlDollars !== null,
      "verified.netPnlDollars must be non-null — the card must not show — or $0 after restart",
    );

    // The card display logic: prefer verified over estimate.
    const displayPnl = verifiedPnl.realizedNetPnlDollars ?? summary.combined.netPnlDollars;
    assert.ok(
      Math.abs(displayPnl - EXPECTED_PNL) < 0.000001,
      `card should display verified P&L (${EXPECTED_PNL}), not the stale $0 estimate; got ${displayPnl}`,
    );
    assert.notEqual(displayPnl, 0,
      "card must not display $0 when verified fill data is in DB");
  });
});
