/**
 * Integration tests for tradeStore.ts
 *
 * These tests use the real dev database. Each test uses a unique date key
 * ("1970-01-01" through "1970-01-07") so runs are fully isolated and
 * idempotent across repeated test runs.
 *
 * Run:
 *   pnpm --filter @workspace/api-server test  (included in the test command)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  initTradeStore,
  isStorageHealthy,
  restoreState,
  reserveAndRecord,
  finaliseOrderAttempt,
  releaseBudgetInSql,
  releaseDedupSlotInSql,
  getStorageStatus,
  markAttemptPostStarted,
  markAttemptPostUnknown,
  markAttemptInterruptedShutdown,
  releaseRejectedAttempt,
  getPendingFinalisationCount,
  _drainPendingFinalisationsForTesting,
  upsertWindowLogEntryInSql,
  persistGuardCountsToSql,
  getPendingDurableWriteCount,
  _drainPendingDurableWritesForTesting,
  getDailyRealizedPnl,
  persistReconcileFailedToDb,
  persistVerifiedFillReconciliation,
  loadUnreconciledFilledOrders,
  recoverForwardSettlementsFromSql,
  insertDiscoveredOrderAttempt,
  loadKalshiOrderIdsForDate,
  markWonForSettledTicker,
  persistSweepCompletion,
  loadSweptDates,
  loadIncompleteFilledAttempts,
  countIncompleteFillsForDate,
  getOpenConfirmedPositionTickers,
  getOpenConfirmedPositions,
  recordEvaluationEventToSql,
  loadRecentEvaluationEventsFromSql,
  getVerifiedPnlBySeries,
  getVerifiedPnlByTier,
} from "./tradeStore.js";
import { db } from "@workspace/db";
import {
  orderAttempts,
  orderFills,
  dailyBudget,
  orderDedup,
  preflightDecisions,
  marketResults,
  exchangeSweepLog,
  evaluationEvents,
} from "@workspace/db";
import { recordPreflightDecision } from "./preflightStore.js";
import { PRICE_TIERS } from "./autoTraderGuards.js";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";

// ── Shared test dates (isolated per test, never collide with production data) ──
const D = {
  restart:        "1970-01-01",
  empty_fs:       "1970-01-02",
  duplicate:      "1970-01-03",
  rollover:       "1970-01-04",
  outage:         "1970-01-05",
  notional:       "1970-01-06",
  dedup:          "1970-01-07",
  order_id:       "1970-01-08",
  diagnostic:     "1970-01-09",
  idempotent:     "1970-01-10",
  pending_row:    "1970-01-11",
  retry_cid:      "1970-01-12",
  // State-transition test dates (20–29)
  st_interrupted: "1970-01-20",
  st_post_start:  "1970-01-21",
  st_post_unk:    "1970-01-22",
  st_unk_budget:  "1970-01-23",
  st_same_cid:    "1970-01-24",
  st_diff_cid:    "1970-01-25",
  st_rejection:   "1970-01-26",
  st_fill:        "1970-01-27",
  st_not_found:   "1970-01-28",
  st_stale:       "1970-01-29",
  // Pending-finalisation queue tests (30–31)
  pf_finalise:    "1970-01-30",
  pf_rejected:    "1970-01-31",
  // Fill reconciliation round-trip tests (Feb 1–3)
  fill_recon:     "1970-02-01",
  fill_zero:      "1970-02-02",
  fill_improve:   "1970-02-03",
  // getDailyRealizedPnl reconcile_failed gate tests (Feb 10–11)
  recon_failed:   "1970-02-10",
  recon_inflight: "1970-02-11",
  // Regression: reconcile_failed row must be excluded from net P&L sum (Feb 12)
  recon_unverified: "1970-02-12",
  verified_ledger:  "1970-02-13",
  // Exchange-history discovery tests (Apr 1–3)
  discovered_idem:     "1971-04-01",
  discovered_pnl:      "1971-04-02",
  discovered_combined: "1971-04-03",
  // Sweep log persistence tests (May 1–2)
  sweep_log:           "1971-05-01",
  sweep_log_multi:     "1971-05-02",
  // Incomplete-fill detection tests (Jun 1–2)
  incomplete_fills:    "1971-06-01",
  count_incomplete:    "1971-06-02",
  // Open-position query tests (Jul 1)
  open_positions:      "1971-07-01",
  // Eval-event durable-write buffer tests (Aug 1)
  eval_buffer:         "1971-08-01",
  // A Kalshi market result must remain authoritative when a cached local
  // outcome flag was not written during a restart/backfill.
  kalshi_result_truth: "1971-08-02",
  // getVerifiedPnlBySeries must count orders settled only via the won column
  // (no market_results row), as produced by recoverForwardSettlementsFromSql.
  series_won_fallback: "1971-09-01",
  // getVerifiedPnlByTier must count orders settled only via the won column
  // (no market_results row), as produced by recoverForwardSettlementsFromSql.
  tier_won_fallback:   "1971-09-02",
  // getVerifiedPnlByTier tier-boundary regression: orders at exact tier min/max
  // must land in the named tier; orders outside all tiers must land in "other".
  tier_boundary:       "1971-09-03",
};

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanDate(date: string): Promise<void> {
  await db.delete(dailyBudget).where(eq(dailyBudget.easternDate, date));
  // Delete any test dedup slots with "TEST-" prefix
  await db.delete(orderDedup).where(eq(orderDedup.tickerKey, `TEST-${date}-yes`));
  await db.delete(orderDedup).where(eq(orderDedup.tickerKey, `TEST-${date}-no`));
  // Clean order_fills via the order_attempts for this date (cascade by orderId)
  const attemptsOnDate = await db
    .select({ orderId: orderAttempts.orderId })
    .from(orderAttempts)
    .where(eq(orderAttempts.easternDate, date));
  const orderIdsOnDate = attemptsOnDate.flatMap((r) => r.orderId ? [r.orderId] : []);
  if (orderIdsOnDate.length > 0) {
    await db.delete(orderFills).where(inArray(orderFills.orderId, orderIdsOnDate));
  }
  // Delete order_attempts for this date (all fixture rows)
  await db.delete(orderAttempts).where(eq(orderAttempts.easternDate, date));
}

async function cleanAttempts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(orderAttempts).where(inArray(orderAttempts.id, ids));
}

async function cleanOrderFills(orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await db.delete(orderFills).where(inArray(orderFills.orderId, orderIds));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("tradeStore", async () => {

  before(async () => {
    // Init with the real dev DB
    await initTradeStore();
    assert.equal(isStorageHealthy(), true, "DB should be healthy after initTradeStore");

    // Broad synthetic sweep: remove ALL fixture rows on 1970-1971 dates left by
    // any previous failed run, including the cycling dates used by tests 30/31
    // (1971-02-* and 1971-03-*) that are not in the D object and would otherwise
    // be missed by the per-date loop below.  loadUnreconciledFilledOrders has no
    // date filter, so stale rows from a different cycling date would contaminate
    // the ordering assertion in test 31.
    await db.execute(drizzleSql`
      DELETE FROM order_fills
      WHERE order_id IN (
        SELECT order_id FROM order_attempts
        WHERE eastern_date LIKE '197%'
          AND (is_synthetic = true OR fixture_namespace = 'trade-store-test')
          AND order_id IS NOT NULL
      )
    `);
    await db.execute(drizzleSql`
      DELETE FROM order_attempts
      WHERE eastern_date LIKE '197%'
        AND (is_synthetic = true OR fixture_namespace = 'trade-store-test')
    `);

    // Fine-grained cleanup for any remaining non-synthetic test data (budget rows etc.)
    for (const d of Object.values(D)) await cleanDate(d);
  });

  // ── 1. Restart: restored spentCents from SQL ──────────────────────────────
  it("1: restart — SQL budget survives a simulated restart", async () => {
    const date  = D.restart;
    const cid   = `restart-test-${Date.now()}`;

    // Seed a budget row directly
    await db.insert(dailyBudget).values({ easternDate: date, spentCents: 5000 })
      .onConflictDoUpdate({ target: dailyBudget.easternDate, set: { spentCents: 5000 } });

    // restoreState should return 5000 cents
    const restored = await restoreState(date);
    assert.equal(restored.spentCents, 5000, "restored spentCents should be 5000");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 2. Empty filesystem — SQL is the only source ──────────────────────────
  it("2: empty-fs — restoreState returns SQL value when no file exists", async () => {
    const date = D.empty_fs;

    // Seed SQL without any file
    await db.insert(dailyBudget).values({ easternDate: date, spentCents: 7500 })
      .onConflictDoUpdate({ target: dailyBudget.easternDate, set: { spentCents: 7500 } });

    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, 7500, "should restore 7500 from SQL without file");

    await cleanDate(date);
  });

  // ── 3. Duplicate: second reserveAndRecord for same ticker+side → dedup_conflict ─
  it("3: duplicate — second reserveAndRecord returns dedup_conflict", async () => {
    const date   = D.duplicate;
    const cid1   = `dup-1-${Date.now()}`;
    const cid2   = `dup-2-${Date.now()}`;
    const ticker = `TEST-${date}`;

    const params = {
      clientOrderId:          cid1,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes" as const,
      source:                 "test",
      triggerPriceCents:      80,
      limitPriceCents:        80,
      requestedContracts:     1,
      requestedNotionalCents: 8000,
      easternDate:            date,
    };

    const first = await reserveAndRecord(params);
    assert.equal(first.claimed, true, "first claim should succeed");

    const second = await reserveAndRecord({ ...params, clientOrderId: cid2 });
    assert.equal(second.claimed, false, "second claim should be blocked");
    assert.equal(second.reason, "dedup_conflict", "reason should be dedup_conflict");

    await cleanAttempts([cid1, cid2]);
    await cleanDate(date);
  });

  // ── 4. Rollover: budget row for a new day starts at 0 ────────────────────
  it("4: rollover — restoreState returns 0 for a date with no SQL row", async () => {
    const { spentCents } = await restoreState(D.rollover);
    assert.equal(spentCents, 0, "new date should return 0 spent cents");
  });

  // ── 6. Notional restore: reserveAndRecord increments budget correctly ─────
  it("6: notional — reserveAndRecord increments SQL budget atomically", async () => {
    const date   = D.notional;
    const cid    = `notional-${Date.now()}`;
    const ticker = `TEST-${date}`;

    const r = await reserveAndRecord({
      clientOrderId:          cid,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes" as const,
      source:                 "test",
      triggerPriceCents:      75,
      limitPriceCents:        75,
      requestedContracts:     2,
      requestedNotionalCents: 15000,
      easternDate:            date,
    });
    assert.equal(r.claimed, true, "claim should succeed");

    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, 15000, "SQL budget should be 15000 cents after reservation");

    // Release and verify decrement
    await releaseBudgetInSql(date, 5000);
    const { spentCents: after } = await restoreState(date);
    assert.equal(after, 10000, "SQL budget should be 10000 after releasing 5000");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 7. Dedup restore: releaseDedupSlotInSql allows re-claim ──────────────
  it("7: dedup-restore — released slot allows a fresh claim", async () => {
    const date   = D.dedup;
    const ticker = `TEST-${date}`;
    const cid1   = `dedup-r-1-${Date.now()}`;
    const cid2   = `dedup-r-2-${Date.now()}`;

    const first = await reserveAndRecord({
      clientOrderId:          cid1,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes" as const,
      source:                 "test",
      triggerPriceCents:      80,
      limitPriceCents:        80,
      requestedContracts:     1,
      requestedNotionalCents: 8000,
      easternDate:            date,
    });
    assert.equal(first.claimed, true, "first claim should succeed");

    // Release and verify slot can be re-claimed (simulates partial fill / retry)
    await releaseDedupSlotInSql(ticker, "yes");

    const second = await reserveAndRecord({
      clientOrderId:          cid2,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes" as const,
      source:                 "test",
      triggerPriceCents:      80,
      limitPriceCents:        80,
      requestedContracts:     1,
      requestedNotionalCents: 8000,
      easternDate:            date,
    });
    assert.equal(second.claimed, true, "second claim should succeed after slot release");

    // Finalise both
    await finaliseOrderAttempt({ clientOrderId: cid1, outcome: "zero_fill" });
    await finaliseOrderAttempt({ clientOrderId: cid2, outcome: "full_fill", fillCount: 1 });

    await cleanAttempts([cid1, cid2]);
    await cleanDate(date);
  });

  // ── 8. getStorageStatus returns healthy status ────────────────────────────
  it("8: getStorageStatus returns healthy with real DB", async () => {
    const status = await getStorageStatus();
    assert.equal(status.status, "healthy");
    assert.equal(status.databaseConnected, true);
    assert.equal(status.storageBackend, "postgresql");
    assert.ok(typeof status.orderAttemptCount === "number");
  });

  // ── 9. finaliseOrderAttempt persists orderId to order_attempts.order_id ────
  it("9: finaliseOrderAttempt — orderId persists to order_attempts.order_id", async () => {
    const date = D.order_id;
    const cid  = `order-id-test-${Date.now()}`;
    const kalshiUuid = "test-kalshi-uuid-1234-5678-abcd";

    await reserveAndRecord({
      clientOrderId:          cid,
      ticker:                 `TEST-${date}`,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "no" as const,
      source:                 "test",
      triggerPriceCents:      90,
      limitPriceCents:        90,
      requestedContracts:     1,
      requestedNotionalCents: 9000,
      easternDate:            date,
    });

    await finaliseOrderAttempt({
      clientOrderId:      cid,
      outcome:            "zero_fill",
      orderId:            kalshiUuid,
      fillCount:          0,
      remainingCount:     0,
      roundTripMs:        1500,
    });

    const rows = await db
      .select({ orderId: orderAttempts.orderId })
      .from(orderAttempts)
      .where(eq(orderAttempts.id, cid));

    assert.equal(rows.length, 1, "should have one order_attempt row");
    assert.equal(rows[0].orderId, kalshiUuid, "order_id should match the Kalshi UUID");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 10. finaliseOrderAttempt persists zeroFillDiagnostic ─────────────────
  it("10: finaliseOrderAttempt — zeroFillDiagnostic persists to zero_fill_diagnostic", async () => {
    const date = D.diagnostic;
    const cid  = `diag-test-${Date.now()}`;
    const diagnostic = "l2_hint:wrong_side_l2_interpretation;bbo_age_ms:5700";

    await reserveAndRecord({
      clientOrderId:          cid,
      ticker:                 `TEST-${date}`,
      series:                 "KXETH15M",
      windowCloseTime:        null,
      side:                   "no" as const,
      source:                 "test",
      triggerPriceCents:      85,
      limitPriceCents:        85,
      requestedContracts:     1,
      requestedNotionalCents: 8500,
      easternDate:            date,
    });

    await finaliseOrderAttempt({
      clientOrderId:      cid,
      outcome:            "zero_fill",
      orderId:            "diag-kalshi-uuid-0000",
      fillCount:          0,
      remainingCount:     0,
      roundTripMs:        2200,
      zeroFillDiagnostic: diagnostic,
    });

    const rows = await db
      .select({ zeroFillDiagnostic: orderAttempts.zeroFillDiagnostic })
      .from(orderAttempts)
      .where(eq(orderAttempts.id, cid));

    assert.equal(rows.length, 1, "should have one order_attempt row");
    assert.equal(rows[0].zeroFillDiagnostic, diagnostic, "zero_fill_diagnostic should match");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 11. Idempotency: finaliseOrderAttempt called twice → second is a no-op ─
  it("11: idempotency — finaliseOrderAttempt called twice with same clientOrderId", async () => {
    const date = D.idempotent;
    const cid  = `idem-test-${Date.now()}`;

    await reserveAndRecord({
      clientOrderId:          cid,
      ticker:                 `TEST-${date}`,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "no" as const,
      source:                 "test",
      triggerPriceCents:      80,
      limitPriceCents:        80,
      requestedContracts:     1,
      requestedNotionalCents: 8000,
      easternDate:            date,
    });

    // First finalise — sets outcome to full_fill
    await finaliseOrderAttempt({ clientOrderId: cid, outcome: "full_fill", fillCount: 1 });

    // Second finalise with same clientOrderId — must be a silent no-op (idempotent)
    // The underlying SQL uses ON CONFLICT DO UPDATE, so it must not throw or duplicate.
    await assert.doesNotReject(
      () => finaliseOrderAttempt({ clientOrderId: cid, outcome: "zero_fill", fillCount: 0 }),
      "second finaliseOrderAttempt with same clientOrderId must not throw",
    );

    // Verify exactly one row exists — no phantom duplicate was created
    const rows = await db
      .select({ id: orderAttempts.id })
      .from(orderAttempts)
      .where(eq(orderAttempts.id, cid));
    assert.equal(rows.length, 1, "must have exactly one row, not two");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 12. Pending row after uncertain POST — dedup still blocks new reservation
  it("12: pending-row — dedup slot blocks second reservation while first is pending", async () => {
    const date   = D.retry_cid;
    const cid1   = `retry-1-${Date.now()}`;
    const cid2   = `retry-2-${Date.now()}`;
    const ticker = `TEST-${date}`;

    // First reservation succeeds — simulates successful SQL pre-commit before POST
    const r1 = await reserveAndRecord({
      clientOrderId:          cid1,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes" as const,
      source:                 "test",
      triggerPriceCents:      80,
      limitPriceCents:        80,
      requestedContracts:     1,
      requestedNotionalCents: 8000,
      easternDate:            date,
    });
    assert.equal(r1.claimed, true, "first claim must succeed");

    // Simulate POST timeout: no finaliseOrderAttempt called.
    // Original pending row should still exist with outcome='pending'.

    // Second reservation with different clientOrderId for the same ticker+side+date
    // (simulates a retry after an uncertain POST timeout).
    // The dedup slot must block this to prevent double-submission.
    const r2 = await reserveAndRecord({
      clientOrderId:          cid2,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes" as const,
      source:                 "test",
      triggerPriceCents:      80,
      limitPriceCents:        80,
      requestedContracts:     1,
      requestedNotionalCents: 8000,
      easternDate:            date,
    });
    assert.equal(r2.claimed, false, "second claim must be blocked by dedup slot");
    assert.equal(r2.reason, "dedup_conflict",
      "reason must be dedup_conflict — not a budget or other guard");

    // The original pending row must still be queryable for reconciliation
    const rows = await db
      .select({ id: orderAttempts.id })
      .from(orderAttempts)
      .where(eq(orderAttempts.id, cid1));
    assert.equal(rows.length, 1, "original pending row must exist for post-incident reconciliation");

    await cleanAttempts([cid1, cid2]);
    await cleanDate(date);
  });

  // ── 13. Pending row — budget is reserved (conservative against double-spend) ─
  it("13: pending-row budget — spentCents includes pending reservation in restoreState", async () => {
    const date = D.pending_row;
    const cid  = `pending-row-test-${Date.now()}`;

    // Reserve without finalising (simulates uncertain POST outcome)
    const r = await reserveAndRecord({
      clientOrderId:          cid,
      ticker:                 `TEST-${date}`,
      series:                 "KXBTC15M",
      windowCloseTime:        null,
      side:                   "yes" as const,
      source:                 "test",
      triggerPriceCents:      75,
      limitPriceCents:        75,
      requestedContracts:     1,
      requestedNotionalCents: 7500,
      easternDate:            date,
    });
    assert.equal(r.claimed, true);

    // restoreState must include the pending reservation in spentCents.
    // This is the conservative policy: we don't know if the order filled,
    // so we count it as spent to prevent double-spending the same budget.
    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, 7500,
      "pending reservation must be counted in budget (conservative: unknown state = reserved)");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── State-machine transition tests (14–23) ──────────────────────────────────
  //
  // These prove the state-machine transitions introduced with the uncertain-
  // submission model. Each test uses an isolated date key from D.st_*.
  //

  // 14. reserved → interrupted_shutdown (SIGTERM before POST fires)
  it("14: reserved → interrupted_shutdown via markAttemptInterruptedShutdown", async () => {
    const date   = D.st_interrupted;
    const cid    = `st-intr-${Date.now()}`;
    const ticker = `TEST-${date}`;

    const r = await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r.claimed, true);

    await markAttemptInterruptedShutdown(cid);

    const rows = await db.select({ outcome: orderAttempts.outcome })
      .from(orderAttempts).where(eq(orderAttempts.id, cid));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "interrupted_shutdown", "outcome must be interrupted_shutdown");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // 15. reserved → post_started (just before Kalshi POST)
  it("15: reserved → post_started via markAttemptPostStarted", async () => {
    const date = D.st_post_start;
    const cid  = `st-ps-${Date.now()}`;

    await reserveAndRecord({
      clientOrderId: cid, ticker: `TEST-${date}`, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });

    await markAttemptPostStarted(cid);

    const rows = await db.select({ outcome: orderAttempts.outcome })
      .from(orderAttempts).where(eq(orderAttempts.id, cid));
    assert.equal(rows[0].outcome, "post_started");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // 16. post_started → post_unknown (POST timed out)
  it("16: post_started → post_unknown via markAttemptPostUnknown", async () => {
    const date = D.st_post_unk;
    const cid  = `st-pu-${Date.now()}`;

    await reserveAndRecord({
      clientOrderId: cid, ticker: `TEST-${date}`, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    await markAttemptPostStarted(cid);
    await markAttemptPostUnknown(cid);

    const rows = await db.select({ outcome: orderAttempts.outcome })
      .from(orderAttempts).where(eq(orderAttempts.id, cid));
    assert.equal(rows[0].outcome, "post_unknown");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // 17. post_unknown — budget reservation is retained (conservative)
  it("17: post_unknown retains budget reservation in restoreState", async () => {
    const date = D.st_unk_budget;
    const cid  = `st-ub-${Date.now()}`;

    await reserveAndRecord({
      clientOrderId: cid, ticker: `TEST-${date}`, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    await markAttemptPostUnknown(cid);

    // Budget must still be reserved — we don't know if the order filled
    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, 8000, "post_unknown row must retain budget reservation");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // 18. Same clientOrderId — dedup by ticker+side blocks second reservation
  it("18: same ticker+side — dedup blocks second reservation (same cid path)", async () => {
    const date   = D.st_same_cid;
    const cid    = `st-sc-${Date.now()}`;
    const ticker = `TEST-${date}`;

    const r1 = await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r1.claimed, true);

    // Same cid, same ticker+side → dedup blocks (onConflictDoNothing on order_attempts,
    // but DedupConflictError fires first from the dedup insert)
    const r2 = await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r2.claimed, false);
    assert.equal(r2.reason, "dedup_conflict");

    // Verify exactly one row for this cid (onConflictDoNothing prevents duplicate)
    const rows = await db.select({ id: orderAttempts.id })
      .from(orderAttempts).where(eq(orderAttempts.id, cid));
    assert.equal(rows.length, 1, "must have exactly one order_attempt row — no phantom duplicate");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // 19. Different clientOrderId blocked while first attempt is post_unknown
  it("19: different cid blocked while first attempt is post_unknown (dedup slot held)", async () => {
    const date   = D.st_diff_cid;
    const cid1   = `st-dc-1-${Date.now()}`;
    const cid2   = `st-dc-2-${Date.now()}`;
    const ticker = `TEST-${date}`;

    const r1 = await reserveAndRecord({
      clientOrderId: cid1, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r1.claimed, true);
    await markAttemptPostUnknown(cid1);

    // Different cid, same ticker+side — dedup slot from cid1 must still block
    const r2 = await reserveAndRecord({
      clientOrderId: cid2, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r2.claimed, false);
    assert.equal(r2.reason, "dedup_conflict",
      "different cid must be blocked while dedup slot is held by post_unknown attempt");

    await cleanAttempts([cid1, cid2]);
    await cleanDate(date);
  });

  // 20. Definitive rejection releases budget and dedup slot → re-attempt succeeds
  it("20: releaseRejectedAttempt releases budget and dedup, allowing re-attempt", async () => {
    const date   = D.st_rejection;
    const cid1   = `st-rej-1-${Date.now()}`;
    const cid2   = `st-rej-2-${Date.now()}`;
    const ticker = `TEST-${date}`;

    const r1 = await reserveAndRecord({
      clientOrderId: cid1, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r1.claimed, true);

    // Simulate definitive rejection by Kalshi
    await releaseRejectedAttempt({
      clientOrderId: cid1, ticker, side: "yes",
      easternDate: date, notionalCents: 8000,
    });

    // Verify outcome updated to post_rejected
    const rows = await db.select({ outcome: orderAttempts.outcome })
      .from(orderAttempts).where(eq(orderAttempts.id, cid1));
    assert.equal(rows[0].outcome, "post_rejected");

    // Verify budget fully released
    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, 0, "budget must be 0 after definitive rejection");

    // Verify dedup slot deleted — new reservation must succeed
    const r2 = await reserveAndRecord({
      clientOrderId: cid2, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r2.claimed, true, "re-attempt must succeed after dedup slot released");

    await cleanAttempts([cid1, cid2]);
    await cleanDate(date);
  });

  // 21. Confirmed fill: finalise then release surplus budget
  it("21: confirmed fill — finalise outcome then release surplus notional", async () => {
    const date = D.st_fill;
    const cid  = `st-fill-${Date.now()}`;

    // Reserve estimated notional (80 contracts × 80¢ = 6400 cents)
    await reserveAndRecord({
      clientOrderId: cid, ticker: `TEST-${date}`, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 80, requestedNotionalCents: 6400, easternDate: date,
    });

    // Only 60 contracts actually filled at 80¢ → actual = 4800¢
    const actualNotional = 4800;
    const surplus        = 6400 - actualNotional; // 1600

    await finaliseOrderAttempt({
      clientOrderId: cid, outcome: "full_fill",
      fillCount: 60, remainingCount: 20, contracts: 60,
      fillPriceCents: 80, notionalDollars: actualNotional / 100,
    });

    // Release surplus so budget reflects actual cost
    await releaseBudgetInSql(date, surplus);

    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, actualNotional,
      "budget must reflect actual fill cost after surplus release");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // 22. reconciled_not_found — outcome persisted correctly
  it("22: reconciled_not_found — outcome persisted to order_attempts", async () => {
    const date = D.st_not_found;
    const cid  = `st-nf-${Date.now()}`;

    await reserveAndRecord({
      clientOrderId: cid, ticker: `TEST-${date}`, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    await markAttemptPostUnknown(cid);

    // Kalshi confirmed this order was never received / cannot be found
    await finaliseOrderAttempt({ clientOrderId: cid, outcome: "reconciled_not_found" });

    const rows = await db.select({ outcome: orderAttempts.outcome })
      .from(orderAttempts).where(eq(orderAttempts.id, cid));
    assert.equal(rows[0].outcome, "reconciled_not_found");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // 23. Stale unresolved rows remain reserved after restart
  it("23: stale unresolved rows remain reserved in budget after restart", async () => {
    const date = D.st_stale;
    const cid  = `st-stale-${Date.now()}`;

    // Reserve without finalise — simulates a crash before the order outcome resolved
    const r = await reserveAndRecord({
      clientOrderId: cid, ticker: `TEST-${date}`, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r.claimed, true);

    // Simulate restart — restoreState must count the unresolved row as spent (conservative)
    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, 8000,
      "unresolved row must still consume budget after restart — never under-count");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 24. Pending-finalisation queue: finalise queued when unhealthy → drained ─
  // Simulates the DB going offline AFTER reserveAndRecord but BEFORE
  // finaliseOrderAttempt.  Verifies the row transitions from UNRESOLVED to a
  // visible outcome once the DB recovers and the drain runs.
  it("24: finalise queued when unhealthy → row visible after drain on recovery", async () => {
    const date   = D.pf_finalise;
    const cid    = `pf-fin-${Date.now()}`;
    const ticker = `TEST-${date}`;

    // Step 1: reserve with healthy real DB
    await initTradeStore(db);
    const r = await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r.claimed, true);

    // Step 2: simulate DB going offline (test-override broken proxy — no retry scheduled)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brokenDb2 = new Proxy({} as any, {
      get(_t, prop) {
        if (prop === "execute" || prop === "update" || prop === "transaction" ||
            prop === "select" || prop === "insert" || prop === "delete") {
          return () => { throw new Error("DB offline"); };
        }
        return undefined;
      },
    });
    await initTradeStore(brokenDb2);
    assert.equal(isStorageHealthy(), false, "must be unhealthy");

    // Step 3: finalise while unhealthy → should queue, not throw
    const countBefore = getPendingFinalisationCount();
    await finaliseOrderAttempt({ clientOrderId: cid, outcome: "full_fill", fillCount: 1, contracts: 1, fillPriceCents: 80 });
    assert.ok(
      getPendingFinalisationCount() > countBefore,
      "finaliseOrderAttempt must enqueue when DB is unhealthy",
    );

    // Step 4: DB recovers
    await initTradeStore(db);
    assert.equal(isStorageHealthy(), true, "must be healthy after re-init with real DB");

    // Step 5: drain pending finalisations
    await _drainPendingFinalisationsForTesting();
    assert.equal(getPendingFinalisationCount(), 0, "queue must be empty after drain");

    // Step 6: row must now be visible (outcome = full_fill, not reserved)
    const rows = await db.select({ outcome: orderAttempts.outcome })
      .from(orderAttempts).where(eq(orderAttempts.id, cid));
    assert.equal(rows[0]?.outcome, "full_fill",
      "row must have resolved outcome after drain — not stuck in UNRESOLVED_OUTCOMES");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 25. Pending-finalisation queue: releaseRejected runs full tx on drain ──
  // Verifies that a releaseRejectedAttempt queued while the DB was offline runs
  // the complete transaction on drain: outcome update, budget decrement, AND
  // dedup-slot deletion — not just the outcome update.
  it("25: releaseRejected queued when unhealthy → full tx (outcome+budget+dedup) on drain", async () => {
    const date   = D.pf_rejected;
    const cid    = `pf-rej-${Date.now()}`;
    const ticker = `TEST-${date}`;

    // Step 1: reserve with healthy real DB
    await initTradeStore(db);
    const r = await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r.claimed, true);

    // Step 2: simulate DB going offline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brokenDb3 = new Proxy({} as any, {
      get(_t, prop) {
        if (prop === "execute" || prop === "update" || prop === "transaction" ||
            prop === "select" || prop === "insert" || prop === "delete") {
          return () => { throw new Error("DB offline"); };
        }
        return undefined;
      },
    });
    await initTradeStore(brokenDb3);
    assert.equal(isStorageHealthy(), false);

    // Step 3: releaseRejectedAttempt while unhealthy → should queue
    const countBefore = getPendingFinalisationCount();
    await releaseRejectedAttempt({
      clientOrderId: cid, ticker, side: "yes",
      easternDate: date, notionalCents: 8000,
    });
    assert.ok(
      getPendingFinalisationCount() > countBefore,
      "releaseRejectedAttempt must enqueue when DB is unhealthy",
    );

    // Step 4: DB recovers
    await initTradeStore(db);
    assert.equal(isStorageHealthy(), true);

    // Step 5: drain — must execute full tx
    await _drainPendingFinalisationsForTesting();
    assert.equal(getPendingFinalisationCount(), 0, "queue must be empty after drain");

    // Step 6a: outcome = post_rejected
    const rows = await db.select({ outcome: orderAttempts.outcome })
      .from(orderAttempts).where(eq(orderAttempts.id, cid));
    assert.equal(rows[0]?.outcome, "post_rejected", "outcome must be post_rejected after drain");

    // Step 6b: budget decremented to 0 (not still 8000)
    const { spentCents } = await restoreState(date);
    assert.equal(spentCents, 0, "budget must be released to 0 after drain — not overstated");

    // Step 6c: dedup slot deleted — a new reservation must succeed
    const cid2 = `pf-rej2-${Date.now()}`;
    const r2 = await reserveAndRecord({
      clientOrderId: cid2, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });
    assert.equal(r2.claimed, true, "dedup slot must be freed so re-attempt succeeds");

    await cleanAttempts([cid, cid2]);
    await cleanDate(date);
  });

  // ── 26. Durable-write buffer: window_log + guard counts survive an outage ──
  // Simulates the 2026-08-01 incident: DB pool drops mid-burst, fire-and-forget
  // writes (window_log upsert, guard-count flush) previously vanished. Verifies
  // they are buffered while unhealthy and replayed to SQL after recovery.
  it("26: fire-and-forget writes buffered while unhealthy → replayed on drain", async () => {
    const ticker = `TEST-DWBUF-${Date.now()}`;
    const gcDate = "1970-02-01";

    // Step 1: simulate DB offline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brokenDb = new Proxy({} as any, {
      get(_t, prop) {
        if (prop === "execute" || prop === "update" || prop === "transaction" ||
            prop === "select" || prop === "insert" || prop === "delete") {
          return () => { throw new Error("DB offline"); };
        }
        return undefined;
      },
    });
    await initTradeStore(brokenDb);
    assert.equal(isStorageHealthy(), false);

    // Step 2: fire writes while unhealthy → must buffer, not drop
    const before = getPendingDurableWriteCount();
    upsertWindowLogEntryInSql({
      ticker, series: "KXBTC15M", closeTime: null, firstSeenMs: Date.now(),
      entered: true, inZone: true, yesDerivedAsk: 85, noDerivedAsk: null,
      outcome: "traded", side: "yes", priceCents: 85, contractsFilled: 1,
      spentDollars: 0.85, skipReason: null, settlementResult: null,
    } as Parameters<typeof upsertWindowLogEntryInSql>[0]);
    persistGuardCountsToSql(gcDate, new Map([["KXBTC15M", { spread_guard: 3 }]]));
    assert.equal(
      getPendingDurableWriteCount(), before + 2,
      "window_log + guard-count writes must be buffered while DB is unhealthy",
    );

    // Step 3: DB recovers → drain
    await initTradeStore(db);
    assert.equal(isStorageHealthy(), true);
    await _drainPendingDurableWritesForTesting();
    assert.equal(getPendingDurableWriteCount(), 0, "buffer must be empty after drain");

    // Step 4: both rows must now exist in SQL
    const wlRows = await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("drizzle-orm")).sql`SELECT entered, in_zone FROM window_log WHERE ticker = ${ticker}` as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wl = (wlRows as any).rows?.[0];
    assert.ok(wl, "window_log row must exist after replay");
    assert.equal(wl.entered, true, "entered=true must be persisted — the exact field lost in the incident");

    const gcRows = await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("drizzle-orm")).sql`SELECT count FROM daily_guard_counts WHERE eastern_date = ${gcDate}` as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((gcRows as any).rows?.[0]?.count, 3, "guard count must be persisted after replay");

    // Cleanup
    await db.execute((await import("drizzle-orm")).sql`DELETE FROM window_log WHERE ticker = ${ticker}`);
    await db.execute((await import("drizzle-orm")).sql`DELETE FROM daily_guard_counts WHERE eastern_date = ${gcDate}`);
  });

  // ── Preflight L2 SQL persistence — recordPreflightDecision → preflight_decisions ─
  it("preflight — recordPreflightDecision persists a row via the SQL sink", async () => {
    const ts     = Date.now();
    const ticker = "TEST-PREFLIGHT-19700101";
    const id     = `${ticker}@${ts}:yes`;
    await db.delete(preflightDecisions).where(eq(preflightDecisions.id, id));

    recordPreflightDecision({
      ticker, series: "TEST", side: "yes", timestampMs: ts, secondsLeft: 42,
      quotedBboAsk: 90, bboAgeMs: 120, bboDerivedLimitCents: 91,
      executableBestAskCents: 92, bboToL2GapCents: 2, verifiedLimitCents: 93,
      depthAtLimitDollars: 12.5, depthAtLimitContracts: 13,
      intendedContracts: 20, intendedNotionalCents: 1860, adjustedContracts: 13,
      fillFractionEstimate: 0.65, nearLimitLevels: [], l2FetchLatencyMs: 55,
      decision: "submit", marketResult: null,
    });

    // Insert is fire-and-forget — poll briefly for the row.
    let row: { decision: string; executableBestAskCents: number | null } | undefined;
    for (let i = 0; i < 20 && !row; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const rows = await db.select({
        decision: preflightDecisions.decision,
        executableBestAskCents: preflightDecisions.executableBestAskCents,
      }).from(preflightDecisions).where(eq(preflightDecisions.id, id));
      row = rows[0];
    }
    assert.ok(row, "preflight decision row must be inserted into preflight_decisions");
    assert.equal(row.decision, "submit");
    assert.equal(row.executableBestAskCents, 92, "L2 executable ask must round-trip");

    await db.delete(preflightDecisions).where(eq(preflightDecisions.id, id));
  });

  // ── Fill reconciliation round-trip: reserveAndRecord → finaliseOrderAttempt ──
  //
  // These three tests verify that when fillReconciler computes a weighted-avg
  // fill price and calls finaliseOrderAttempt, the correct fill_price_cents
  // value is persisted in the order_attempts row — not the limit price.
  //
  // They mirror the real production flow:
  //   1. reserveAndRecord() → pending SQL row
  //   2. finaliseOrderAttempt() with computed fill values → row updated
  //   3. SELECT order_attempts → verify fill_price_cents, notional_dollars

  it("fill-recon-1: multi-chunk weighted avg is persisted correctly in order_attempts", async () => {
    const date   = D.fill_recon;
    const cid    = `fill-recon-1-${Date.now()}`;
    // Ticker must match the TEST-${date}-${side} cleanup pattern so cleanDate()
    // removes the dedup row and reruns stay idempotent.
    const ticker = `TEST-${date}`;

    const reserve = await reserveAndRecord({
      clientOrderId:          cid,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        "2026-08-02T00:00:00Z",
      side:                   "yes",
      source:                 "websocket",
      triggerPriceCents:      69,
      limitPriceCents:        70,
      requestedContracts:     655,
      requestedNotionalCents: 655 * 70,
      easternDate:            date,
    });
    assert.equal(reserve.claimed, true, "should claim dedup slot");

    // Simulate fillReconciler.computeFillParams output:
    //   400 @ 35¢ + 255 @ 36¢ → weighted avg = Math.round((400×35+255×36)/655)
    //   = Math.round(26380/655) = Math.round(40.27) = 40¢
    const weightedAvg = Math.round((400 * 35 + 255 * 36) / 655); // = 40
    const notional    = (655 * weightedAvg) / 100;

    await finaliseOrderAttempt({
      clientOrderId:   cid,
      outcome:         "filled",
      orderId:         "ord-fillrecon-1",
      fillCount:       655,
      remainingCount:  0,
      contracts:       655,
      fillPriceCents:  weightedAvg,
      notionalDollars: notional,
      feeDollars:      0.02,
      roundTripMs:     95,
    });

    const rows = await db.select({
      outcome:         orderAttempts.outcome,
      fillPriceCents:  orderAttempts.fillPriceCents,
      contracts:       orderAttempts.contracts,
      notionalDollars: orderAttempts.notionalDollars,
    }).from(orderAttempts).where(eq(orderAttempts.id, cid));

    assert.equal(rows.length, 1, "row must exist");
    assert.equal(rows[0]!.outcome, "filled", "outcome");
    assert.equal(rows[0]!.fillPriceCents, weightedAvg,
      `fill_price_cents should be weighted avg ${weightedAvg}¢, not limit 70¢`);
    assert.equal(rows[0]!.contracts, 655, "contracts");
    // notional_dollars should reflect actual avg price, not limit price
    assert.ok(
      Math.abs((rows[0]!.notionalDollars ?? 0) - notional) < 0.01,
      `notional_dollars should be ${notional} (actual cost), got ${rows[0]!.notionalDollars}`,
    );

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  it("fill-recon-2: zero-fill → fill_price_cents stays NULL in order_attempts", async () => {
    const date   = D.fill_zero;
    const cid    = `fill-zero-${Date.now()}`;
    const ticker = `TEST-${date}`;   // TEST-${date}-yes dedup key cleaned by cleanDate()

    const reserve = await reserveAndRecord({
      clientOrderId:          cid,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        "2026-08-02T00:00:00Z",
      side:                   "yes",
      source:                 "websocket",
      triggerPriceCents:      69,
      limitPriceCents:        70,
      requestedContracts:     655,
      requestedNotionalCents: 655 * 70,
      easternDate:            date,
    });
    assert.equal(reserve.claimed, true, "should claim dedup slot");

    // When Kalshi returns zero fills, fillReconciler calls recordReconciliationFailed;
    // the DB row is finalised with outcome=zero_fill and no fill_price_cents.
    await finaliseOrderAttempt({
      clientOrderId:   cid,
      outcome:         "zero_fill",
      orderId:         null,
      fillCount:       0,
      remainingCount:  655,
      contracts:       0,
      fillPriceCents:  null,   // ← no fill price when fills API returns nothing
      notionalDollars: 0,
      feeDollars:      0,
      roundTripMs:     80,
    });

    const rows = await db.select({
      outcome:        orderAttempts.outcome,
      fillPriceCents: orderAttempts.fillPriceCents,
    }).from(orderAttempts).where(eq(orderAttempts.id, cid));

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "zero_fill", "outcome should be zero_fill");
    assert.strictEqual(rows[0]!.fillPriceCents, null,
      "fill_price_cents must be NULL for a zero-fill — not the limit price");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  it("fill-recon-3: price improvement — actual cost uses fill price, not limit price", async () => {
    const date            = D.fill_improve;
    const cid             = `fill-improve-${Date.now()}`;
    const ticker          = `TEST-${date}`;   // TEST-${date}-yes dedup key cleaned by cleanDate()
    const limitCents      = 70;
    const actualFillCents = 10;   // dramatic price improvement
    const contracts       = 600;

    const reserve = await reserveAndRecord({
      clientOrderId:          cid,
      ticker,
      series:                 "KXBTC15M",
      windowCloseTime:        "2026-08-02T00:00:00Z",
      side:                   "yes",
      source:                 "websocket",
      triggerPriceCents:      69,
      limitPriceCents:        limitCents,
      requestedContracts:     contracts,
      requestedNotionalCents: contracts * limitCents,
      easternDate:            date,
    });
    assert.equal(reserve.claimed, true, "should claim dedup slot");

    // fillReconciler computes actual cost at 10¢, not 70¢ limit
    const actualNotional = (contracts * actualFillCents) / 100;  // $60, NOT $420
    await finaliseOrderAttempt({
      clientOrderId:   cid,
      outcome:         "filled",
      orderId:         "ord-improve-1",
      fillCount:       contracts,
      remainingCount:  0,
      contracts,
      fillPriceCents:  actualFillCents,
      notionalDollars: actualNotional,
      feeDollars:      0.01,
      roundTripMs:     88,
    });

    const rows = await db.select({
      fillPriceCents:  orderAttempts.fillPriceCents,
      notionalDollars: orderAttempts.notionalDollars,
    }).from(orderAttempts).where(eq(orderAttempts.id, cid));

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.fillPriceCents, actualFillCents,
      `fill_price_cents should be ${actualFillCents}¢ (actual), not ${limitCents}¢ (limit)`);
    // Notional should be $60 (actual), not $420 (limit price × contracts)
    assert.ok(
      Math.abs((rows[0]!.notionalDollars ?? 0) - actualNotional) < 0.01,
      `notional_dollars should be $${actualNotional} (actual cost), not $${(contracts * limitCents) / 100} (limit cost)`,
    );

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 27. Failed retry remains visible and recoverable ──────────────────────
  it("27: reconcile_failed=true blocks P&L and remains in the recovery backlog", async () => {
    const date   = D.recon_failed;
    const cid    = `recon-failed-${Date.now()}`;
    const kalshiId = `kalshi-recon-failed-${Date.now()}`;
    const ticker = `TEST-${date}`;

    // Create the order attempt
    await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, easternDate: date,
    });

    // Finalise as a filled order (with a Kalshi orderId so persistReconcileFailedToDb can find it)
    await finaliseOrderAttempt({
      clientOrderId: cid, outcome: "filled",
      orderId: kalshiId, fillCount: 1, remainingCount: 0,
      contracts: 1, fillPriceCents: 80, notionalDollars: 0.80, feeDollars: 0.001,
    });

    // Mark as settled (won=true) — simulates settlement reconciliation writing the result
    await db.update(orderAttempts)
      .set({ won: true, updatedAt: new Date() })
      .where(eq(orderAttempts.id, cid));

    // Mark reconciliation as permanently failed (reconcile_failed=true, reconciled stays false)
    await persistReconcileFailedToDb(kalshiId);

    // A failed short retry has no verified ledger. Daily net P&L must fail
    // closed, and the row must remain eligible for the periodic recovery sweep.
    const result = await getDailyRealizedPnl(date);
    assert.equal(result.realizedNetPnlDollars, null);
    assert.equal(result.settledFillCount, 1, "settled fill count must be 1");
    assert.equal(result.pendingVerificationCount, 1);
    assert.equal(result.unverifiedFillCount, 1);
    const backlog = await loadUnreconciledFilledOrders();
    assert.ok(backlog.some((order) => order.orderId === kalshiId), "failed historical filled row must be retried");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 28. getDailyRealizedPnl: in-flight unreconciled fill → correctly blocked ─
  // A settled fill that is still in-flight (reconciled=false, reconcile_failed IS NULL)
  // must cause getDailyRealizedPnl to return null so the caller fails closed.
  it("28: unreconciled in-flight fill (reconcile_failed=null) blocks getDailyRealizedPnl", async () => {
    const date   = D.recon_inflight;
    const cid    = `recon-inflight-${Date.now()}`;
    const ticker = `TEST-${date}`;

    // Create and finalise a filled order (no Kalshi orderId needed — reconciliation not done)
    await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "yes" as const, source: "test",
      triggerPriceCents: 75, limitPriceCents: 75,
      requestedContracts: 1, requestedNotionalCents: 7500, easternDate: date,
    });

    await finaliseOrderAttempt({
      clientOrderId: cid, outcome: "filled",
      orderId: `kalshi-inflight-${Date.now()}`, fillCount: 1, remainingCount: 0,
      contracts: 1, fillPriceCents: 75, notionalDollars: 0.75, feeDollars: 0.001,
    });

    // Mark as settled but leave reconciled=false and reconcile_failed=null (still in-flight)
    await db.update(orderAttempts)
      .set({ won: true, updatedAt: new Date() })
      .where(eq(orderAttempts.id, cid));

    // getDailyRealizedPnl must return null — one in-flight fill blocks the gate
    const result = await getDailyRealizedPnl(date);
    assert.strictEqual(
      result.realizedNetPnlDollars, null,
      "in-flight unreconciled fill (reconcile_failed=null) must block getDailyRealizedPnl",
    );
    assert.equal(result.settledFillCount, 1, "settled fill count must be 1");

    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 29. Unverified historical fill makes the total unavailable ────────────
  it("29: winning fill with reconcile_failed=true keeps net P&L unavailable", async () => {
    const date     = D.recon_unverified;
    const cid      = `recon-unverified-${Date.now()}`;
    const kalshiId = `kalshi-unverified-${Date.now()}`;
    const ticker   = `TEST-${date}`;

    // A BTC NO partial fill: 96.41 contracts at ~6¢ (like the production audit).
    // Pre-fee gross profit = contracts - notional = 96.41 - 90.6254 ≈ 5.7846.
    // With fee_dollars=0 (unverified), the old code silently included $5.78.
    const contracts     = 96.41;
    const notionalDollars = 90.6254;

    await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M",
      windowCloseTime: null, side: "no" as const, source: "test",
      triggerPriceCents: 6, limitPriceCents: 6,
      // requestedContracts is an integer column — use the rounded quantity;
      // the actual fractional fill quantity is recorded in finaliseOrderAttempt.
      requestedContracts: Math.round(contracts), requestedNotionalCents: Math.round(notionalDollars * 100), easternDate: date,
    });

    // Finalise as filled with fee_dollars=0 (simulating the audit scenario where fees were never fetched)
    await finaliseOrderAttempt({
      clientOrderId: cid, outcome: "filled",
      orderId: kalshiId, fillCount: 1, remainingCount: 0,
      contracts, fillPriceCents: 6, notionalDollars, feeDollars: 0,
    });

    // Mark as settled (won=true — market settled YES, NO holders lose; but flip:
    // for testing simplicity set won=true so the P&L formula fires)
    await db.update(orderAttempts)
      .set({ won: true, updatedAt: new Date() })
      .where(eq(orderAttempts.id, cid));

    // Mark reconciliation as permanently failed (simulates fills endpoint returning empty)
    await persistReconcileFailedToDb(kalshiId);

    const result = await getDailyRealizedPnl(date);

    assert.equal(result.realizedNetPnlDollars, null, "unverified fill ledger must make net P&L unavailable");
    assert.equal(result.pendingVerificationCount, 1);
    assert.equal(result.unverifiedFillCount, 1, "unverifiedFillCount must be 1 for the reconcile_failed row");

    // Historical backfill can persist authoritative chunks after the short
    // retry failure flag was written. The ledger is authoritative in that
    // state and must be included rather than silently omitted.
    await persistVerifiedFillReconciliation([{
      seqIndex: 0, orderId: kalshiId, attemptId: cid, ticker, side: "no",
      fillPriceCents: 6, contracts, costDollars: notionalDollars,
      feeDollars: 0.01, exactPriceDollars: "0.06", exactCostDollars: String(notionalDollars),
      exactFeeDollars: "0.01", fillId: `fill-unverified-${Date.now()}`, fillTimestamp: null,
    }], {
      contracts, fillPriceCents: 6, notionalDollars, feeDollars: 0.01,
    });
    // Simulate a delayed fire-and-forget failure marker arriving after the
    // backfill. It must not make a verified ledger disappear from daily P&L.
    await persistReconcileFailedToDb(kalshiId);
    const backfilled = await getDailyRealizedPnl(date);
    assert.ok(
      Math.abs((backfilled.realizedNetPnlDollars ?? 0) - (contracts - notionalDollars - 0.01)) < 0.000001,
      "verified chunks must remain authoritative when reconcile_failed is stale",
    );
    assert.equal(backfilled.pendingVerificationCount, 0);
    assert.equal(backfilled.unverifiedFillCount, 0);

    await cleanOrderFills([kalshiId]);
    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 30. Verified child ledger is the only P&L source ──────────────────────
  it("30: sums split verified chunks once when duplicate local attempts share a Kalshi order", async () => {
    const date = `1971-02-${String(Date.now() % 28 + 1).padStart(2, "0")}`;
    // Pre-flush any rows left by previous failed runs on this cycling date.
    await cleanDate(date);
    const suffix = Date.now();
    const winningAttempt = `ledger-win-${suffix}`;
    const duplicateAttempt = `ledger-duplicate-${suffix}`;
    const losingAttempt = `ledger-loss-${suffix}`;
    const winningOrderId = `kalshi-ledger-win-${suffix}`;
    const losingOrderId = `kalshi-ledger-loss-${suffix}`;

    for (const [id, ticker, side] of [
      [winningAttempt, `TEST-LEDGER-WIN-${suffix}`, "yes"],
      [losingAttempt, `TEST-LEDGER-LOSS-${suffix}`, "no"],
    ] as const) {
      await reserveAndRecord({
        clientOrderId: id, ticker, series: "KXBTC15M", windowCloseTime: null,
        side, source: "test", triggerPriceCents: 80, limitPriceCents: 80,
        requestedContracts: 3, requestedNotionalCents: 240, easternDate: date,
        syntheticFixture: true, fixtureNamespace: "trade-store-test",
      });
    }

    await finaliseOrderAttempt({
      clientOrderId: winningAttempt, outcome: "filled", orderId: winningOrderId,
      fillCount: 3, remainingCount: 0, contracts: 3, fillPriceCents: 80,
      notionalDollars: 2.4, feeDollars: 0,
    });
    await finaliseOrderAttempt({
      clientOrderId: losingAttempt, outcome: "filled", orderId: losingOrderId,
      fillCount: 1, remainingCount: 0, contracts: 1, fillPriceCents: 50,
      notionalDollars: 0.5, feeDollars: 0,
    });
    await db.insert(orderAttempts).values({
      id: duplicateAttempt, timestampMs: Date.now(), easternDate: date,
      ticker: `TEST-LEDGER-DUP-${suffix}`, series: "KXBTC15M", side: "yes",
      orderId: winningOrderId, outcome: "filled", won: true,
    });
    await db.update(orderAttempts).set({ won: true }).where(eq(orderAttempts.id, winningAttempt));
    await db.update(orderAttempts).set({ won: false }).where(eq(orderAttempts.id, losingAttempt));

    await persistVerifiedFillReconciliation([
      {
        seqIndex: 0, orderId: winningOrderId, attemptId: winningAttempt,
        ticker: `TEST-LEDGER-WIN-${suffix}`, side: "yes", fillPriceCents: 80,
        contracts: 2, costDollars: 1.6, feeDollars: 0.02,
        exactPriceDollars: "0.8", exactCostDollars: "1.6", exactFeeDollars: "0.02",
        fillId: `fill-ledger-win-a-${suffix}`, fillTimestamp: null,
      },
      {
        seqIndex: 1, orderId: winningOrderId, attemptId: winningAttempt,
        ticker: `TEST-LEDGER-WIN-${suffix}`, side: "yes", fillPriceCents: 75,
        contracts: 1, costDollars: 0.75, feeDollars: 0.01,
        exactPriceDollars: "0.75", exactCostDollars: "0.75", exactFeeDollars: "0.01",
        fillId: `fill-ledger-win-b-${suffix}`, fillTimestamp: null,
      },
    ], { contracts: 3, fillPriceCents: 78, notionalDollars: 2.35, feeDollars: 0.03 });
    await persistVerifiedFillReconciliation([
      {
        seqIndex: 0, orderId: losingOrderId, attemptId: losingAttempt,
        ticker: `TEST-LEDGER-LOSS-${suffix}`, side: "no", fillPriceCents: 50,
        contracts: 1, costDollars: 0.5, feeDollars: 0.01,
        exactPriceDollars: "0.5", exactCostDollars: "0.5", exactFeeDollars: "0.01",
        fillId: `fill-ledger-loss-${suffix}`, fillTimestamp: null,
      },
    ], { contracts: 1, fillPriceCents: 50, notionalDollars: 0.5, feeDollars: 0.01 });

    const result = await getDailyRealizedPnl(date);
    // (3 - 1.60 - .02 - .75 - .01) + (-.50 - .01) = +.11
    assert.ok(
      Math.abs((result.realizedNetPnlDollars ?? 0) - 0.11) < 0.000001,
      `expected +$0.11 from verified chunks, got ${result.realizedNetPnlDollars}`,
    );
    assert.equal(result.settledFillCount, 2, "duplicate local row must not double count the order");
    assert.equal(result.pendingVerificationCount, 0);
    assert.equal(result.unverifiedFillCount, 0);

    await cleanOrderFills([winningOrderId, losingOrderId]);
    await cleanAttempts([winningAttempt, duplicateAttempt, losingAttempt]);
    await cleanDate(date);
  });

  it("forward exact ledger is fill-id idempotent and restart recovery settles it once", async () => {
    // Pre-flush any synthetic rows left by previous failed test runs that have
    // reconciled=true / won=null — they would make recoverForwardSettlementsFromSql()
    // return > 1 and break the assertion below.  The function is idempotent so
    // calling it here is safe even when no stale rows exist.
    await recoverForwardSettlementsFromSql();

    const suffix = Date.now().toString();
    const date = `1971-04-${String(Number(suffix.slice(-2)) % 28 + 1).padStart(2, "0")}`;
    const cid = `forward-exact-${suffix}`;
    const ticker = `TEST-FORWARD-EXACT-${suffix}`;
    const orderId = `kalshi-forward-exact-${suffix}`;
    const fill = {
      seqIndex: 0, fillId: `fill-forward-exact-${suffix}`, orderId, attemptId: cid, ticker, side: "yes" as const,
      fillPriceCents: 93, contracts: 34, costDollars: 31.518, feeDollars: 0.0001,
      exactPriceDollars: "0.9270", exactCostDollars: "31.5180", exactFeeDollars: "0.000100", fillTimestamp: null,
    };
    await reserveAndRecord({
      clientOrderId: cid, ticker, series: "KXBTC15M", windowCloseTime: null, side: "yes",
      source: "test", triggerPriceCents: 93, limitPriceCents: 93,
      requestedContracts: 34, requestedNotionalCents: 3162, easternDate: date,
    });
    await finaliseOrderAttempt({
      clientOrderId: cid, outcome: "filled", orderId, fillCount: 34, remainingCount: 0,
      contracts: 34, fillPriceCents: 93, notionalDollars: 31.518, feeDollars: 0.0001,
    });
    const params = { contracts: 34, fillPriceCents: 93, notionalDollars: 31.518, feeDollars: 0.0001 };
    await persistVerifiedFillReconciliation([fill], params);
    await persistVerifiedFillReconciliation([{ ...fill, seqIndex: 99 }], params);
    const stored = await db.select().from(orderFills).where(eq(orderFills.fillId, fill.fillId));
    assert.equal(stored.length, 1, "same Kalshi fill_id must not duplicate under replay/reorder");
    assert.equal(stored[0]!.exactCostDollars, "31.5180");
    assert.equal(stored[0]!.exactFeeDollars, "0.000100");

    await db.insert(marketResults).values({ ticker, result: "yes", resolvedAtMs: Date.now() });
    assert.equal(await recoverForwardSettlementsFromSql(), 1, "restart recovery must settle the canonical parent");
    assert.equal(await recoverForwardSettlementsFromSql(), 0, "second recovery is idempotent");
    const result = await getDailyRealizedPnl(date);
    assert.ok(Math.abs((result.realizedNetPnlDollars ?? 0) - 2.4819) < 0.000001);
    assert.equal(result.settledFillCount, 1, "proven settled parent must be counted once");

    await db.delete(marketResults).where(eq(marketResults.ticker, ticker));
    await cleanOrderFills([orderId]);
    await cleanAttempts([cid]);
    await cleanDate(date);
  });

  // ── 31. Recovery backlog batches unique orders oldest-first ───────────────
  it("31: recovery selection deduplicates before limiting and does not starve older orders", async () => {
    const date = `1971-03-${String(Date.now() % 28 + 1).padStart(2, "0")}`;
    // Pre-flush any rows left by previous failed runs on this cycling date.
    await cleanDate(date);
    const suffix = Date.now().toString();
    const olderAttempt = `recovery-old-${suffix}`;
    const firstDuplicateAttempt = `recovery-duplicate-1-${suffix}`;
    const secondDuplicateAttempt = `recovery-duplicate-2-${suffix}`;
    const olderOrderId = `kalshi-recovery-old-${suffix}`;
    const duplicateOrderId = `kalshi-recovery-duplicate-${suffix}`;
    const baseTimestamp = Date.now() - 10_000;

    for (const [clientOrderId, ticker] of [
      [olderAttempt, `TEST-RECOVERY-OLD-${suffix}`],
      [firstDuplicateAttempt, `TEST-RECOVERY-DUP-1-${suffix}`],
      [secondDuplicateAttempt, `TEST-RECOVERY-DUP-2-${suffix}`],
    ] as const) {
      await reserveAndRecord({
        clientOrderId, ticker, series: "KXBTC15M", windowCloseTime: null,
        side: "yes", source: "test", triggerPriceCents: 80, limitPriceCents: 80,
        requestedContracts: 1, requestedNotionalCents: 80, easternDate: date,
      });
    }
    for (const [clientOrderId, orderId] of [
      [olderAttempt, olderOrderId],
      [firstDuplicateAttempt, duplicateOrderId],
      [secondDuplicateAttempt, duplicateOrderId],
    ] as const) {
      await finaliseOrderAttempt({
        clientOrderId, outcome: "filled", orderId, fillCount: 1, remainingCount: 0,
        contracts: 1, fillPriceCents: 80, notionalDollars: 0.8, feeDollars: 0,
      });
    }
    await db.update(orderAttempts).set({ timestampMs: baseTimestamp })
      .where(eq(orderAttempts.id, olderAttempt));
    await db.update(orderAttempts).set({ timestampMs: baseTimestamp + 1_000 })
      .where(eq(orderAttempts.id, firstDuplicateAttempt));
    await db.update(orderAttempts).set({ timestampMs: baseTimestamp + 2_000 })
      .where(eq(orderAttempts.id, secondDuplicateAttempt));

    const backlog = await loadUnreconciledFilledOrders(2);
    assert.deepEqual(
      backlog.map((order) => order.orderId),
      [olderOrderId, duplicateOrderId],
      "the cap must apply after duplicate Kalshi order IDs are collapsed, oldest first",
    );

    await cleanAttempts([olderAttempt, firstDuplicateAttempt, secondDuplicateAttempt]);
    await cleanDate(date);
  });

  // ── 32. Exchange-history discovery: idempotent by Kalshi order_id ───────────
  it("32: insertDiscoveredOrderAttempt — same Kalshi order_id never creates duplicate rows", async () => {
    const date    = D.discovered_idem;
    const suffix  = Date.now().toString();
    const orderId = `kalshi-disc-32-${suffix}`;
    const ticker  = `KXBTC15M-TEST-32-${suffix}`;
    const synthId = `disc-${orderId}`;

    // First call — must create the row
    const first = await insertDiscoveredOrderAttempt({
      kalshiOrderId: orderId, ticker, series: "KXBTC15M",
      side: "yes", easternDate: date, fillTimestampMs: Date.now(),
    });
    assert.ok(first, "first call should succeed");
    assert.equal(first!.alreadyExisted, false, "first call should insert a new row");
    assert.equal(first!.attemptId, synthId, "attemptId must be disc-<orderId>");

    // Second call with the same orderId — must return alreadyExisted=true
    const second = await insertDiscoveredOrderAttempt({
      kalshiOrderId: orderId, ticker, series: "KXBTC15M",
      side: "yes", easternDate: date, fillTimestampMs: Date.now() + 1,
    });
    assert.ok(second, "second call should not throw");
    assert.equal(second!.alreadyExisted, true, "second call must detect existing row");

    // Only one row must exist in the DB
    const rows = await db.select({ id: orderAttempts.id, source: orderAttempts.source })
      .from(orderAttempts).where(eq(orderAttempts.orderId, orderId));
    assert.equal(rows.length, 1, "exactly one order_attempts row for the Kalshi order_id");
    assert.equal(rows[0]!.source, "exchange_discovery");

    // loadKalshiOrderIdsForDate must include the discovered order
    const knownIds = await loadKalshiOrderIdsForDate(date);
    assert.ok(knownIds.has(orderId), "loadKalshiOrderIdsForDate must include the discovered order_id");

    await cleanAttempts([synthId]);
    await cleanDate(date);
  });

  // ── 33. Discovered order reaches getDailyRealizedPnl after fill reconciliation ─
  it("33: discovered order included in verified P&L after fill reconciliation and settlement", async () => {
    const date    = D.discovered_pnl;
    const suffix  = Date.now().toString();
    const orderId = `kalshi-disc-33-${suffix}`;
    const ticker  = `KXBTC15M-TEST-33-${suffix}`;
    const synthId = `disc-${orderId}`;

    // Seed market result (YES wins)
    await db.insert(marketResults)
      .values({ ticker, result: "yes", resolvedAtMs: Date.now(), createdAt: new Date() })
      .onConflictDoUpdate({ target: marketResults.ticker, set: { result: "yes" } });

    // Insert discovered order — won must be set immediately from market_results
    const inserted = await insertDiscoveredOrderAttempt({
      kalshiOrderId: orderId, ticker, series: "KXBTC15M",
      side: "yes", easternDate: date, fillTimestampMs: Date.now(),
    });
    assert.ok(inserted && !inserted.alreadyExisted, "should insert new row");

    const [row] = await db.select({ won: orderAttempts.won, source: orderAttempts.source })
      .from(orderAttempts).where(eq(orderAttempts.id, synthId));
    assert.equal(row!.won, true, "won must be set from market_results at insert time");
    assert.equal(row!.source, "exchange_discovery");

    // Before fill chunks: P&L is unavailable (reconciled=false → pending verification)
    const before = await getDailyRealizedPnl(date);
    assert.equal(before.pendingVerificationCount, 1, "one pending verification before fill chunks");
    assert.equal(before.realizedNetPnlDollars, null, "P&L unavailable without fill chunks");

    // Persist verified fill chunks: 100 contracts at 80¢, fee $0.10
    // P&L (won=true): contracts − cost_dollars − fee_dollars = 100 − 80.00 − 0.10 = $19.90
    await persistVerifiedFillReconciliation(
      [{
        seqIndex: 0, orderId, attemptId: synthId, ticker, side: "yes",
        fillPriceCents: 80, contracts: 100, costDollars: 80.00, feeDollars: 0.10,
        fillId: `fill-disc-33-${suffix}`,
        exactPriceDollars: "0.8000", exactCostDollars: "80.0000", exactFeeDollars: "0.1000",
        fillTimestamp: null,
      }],
      { contracts: 100, fillPriceCents: 80, notionalDollars: 80.00, feeDollars: 0.10 },
    );

    const after = await getDailyRealizedPnl(date);
    assert.equal(after.pendingVerificationCount, 0, "no pending after fill reconciliation");
    assert.equal(after.settledFillCount, 1);
    assert.ok(
      Math.abs((after.realizedNetPnlDollars ?? 0) - 19.90) < 0.0001,
      `expected net P&L $19.90, got ${after.realizedNetPnlDollars}`,
    );

    await cleanOrderFills([orderId]);
    await cleanAttempts([synthId]);
    await db.delete(marketResults).where(eq(marketResults.ticker, ticker));
    await cleanDate(date);
  });

  // ── 34. Combined multi-trade settlement: August 13 scenario ──────────────────
  // Two winning discovered fills and one losing fill on the same Eastern date.
  // Also verifies markWonForSettledTicker for a row inserted before settlement.
  it("34: combined multi-discovered-order settlement reconciles to correct net P&L", async () => {
    const date    = D.discovered_combined;
    const suffix  = Date.now().toString();

    // Order A: YES buy, 100 contracts @ 80¢, fee $0.10, market settles YES → won
    //   net = 100 − 80.00 − 0.10 = $19.90
    const orderIdA = `kalshi-disc-34a-${suffix}`;
    const tickerA  = `KXBTC15M-TEST-34A-${suffix}`;
    const synthA   = `disc-${orderIdA}`;

    // Order B: NO buy, 50 contracts @ 85¢, fee $0.05, market settles NO → won
    //   net = 50 − 42.50 − 0.05 = $7.45
    const orderIdB = `kalshi-disc-34b-${suffix}`;
    const tickerB  = `KXETH15M-TEST-34B-${suffix}`;
    const synthB   = `disc-${orderIdB}`;

    // Order C: YES buy, 6 contracts @ 75¢, fee $0.006, market settles NO → lost
    //   net = −4.50 − 0.006 = −$4.506  (uses markWonForSettledTicker to set won)
    const orderIdC = `kalshi-disc-34c-${suffix}`;
    const tickerC  = `KXBTC15M-TEST-34C-${suffix}`;
    const synthC   = `disc-${orderIdC}`;

    // Seed market results for A and B; leave C unsettled for now
    for (const [t, r] of [[tickerA, "yes"], [tickerB, "no"]] as const) {
      await db.insert(marketResults)
        .values({ ticker: t, result: r, resolvedAtMs: Date.now(), createdAt: new Date() })
        .onConflictDoUpdate({ target: marketResults.ticker, set: { result: r } });
    }

    // Create discovered rows — A and B get won set immediately from market_results
    const insA = await insertDiscoveredOrderAttempt({
      kalshiOrderId: orderIdA, ticker: tickerA, series: "KXBTC15M",
      side: "yes", easternDate: date, fillTimestampMs: Date.now(),
    });
    const insB = await insertDiscoveredOrderAttempt({
      kalshiOrderId: orderIdB, ticker: tickerB, series: "KXETH15M",
      side: "no", easternDate: date, fillTimestampMs: Date.now(),
    });
    // C has no market result yet at insert time → won=null
    const insC = await insertDiscoveredOrderAttempt({
      kalshiOrderId: orderIdC, ticker: tickerC, series: "KXBTC15M",
      side: "yes", easternDate: date, fillTimestampMs: Date.now(),
    });

    assert.ok(insA && !insA.alreadyExisted);
    assert.ok(insB && !insB.alreadyExisted);
    assert.ok(insC && !insC.alreadyExisted);

    // C should still have won=null (no market result at insert time)
    const [rowC0] = await db.select({ won: orderAttempts.won }).from(orderAttempts)
      .where(eq(orderAttempts.id, synthC));
    assert.equal(rowC0!.won, null, "Order C must have won=null before settlement");

    // Now settle ticker C (settles NO) — C's YES side loses
    await db.insert(marketResults)
      .values({ ticker: tickerC, result: "no", resolvedAtMs: Date.now(), createdAt: new Date() })
      .onConflictDoUpdate({ target: marketResults.ticker, set: { result: "no" } });
    await markWonForSettledTicker(tickerC, "no");

    // Verify all won values
    const [rowA] = await db.select({ won: orderAttempts.won }).from(orderAttempts)
      .where(eq(orderAttempts.id, synthA));
    const [rowB] = await db.select({ won: orderAttempts.won }).from(orderAttempts)
      .where(eq(orderAttempts.id, synthB));
    const [rowC] = await db.select({ won: orderAttempts.won }).from(orderAttempts)
      .where(eq(orderAttempts.id, synthC));
    assert.equal(rowA!.won, true,  "A (YES, settles YES) must be won");
    assert.equal(rowB!.won, true,  "B (NO,  settles NO)  must be won");
    assert.equal(rowC!.won, false, "C (YES, settles NO)  must be lost via markWonForSettledTicker");

    // Persist fill chunks for all three orders
    await persistVerifiedFillReconciliation(
      [{ seqIndex: 0, orderId: orderIdA, attemptId: synthA, ticker: tickerA, side: "yes",
         fillPriceCents: 80, contracts: 100, costDollars: 80.00, feeDollars: 0.10,
         fillId: `kalshi-fill-34a-${suffix}`, exactPriceDollars: "0.8",
         exactCostDollars: "80", exactFeeDollars: "0.1", fillTimestamp: null }],
      { contracts: 100, fillPriceCents: 80, notionalDollars: 80.00, feeDollars: 0.10 },
    );
    await persistVerifiedFillReconciliation(
      [{ seqIndex: 0, orderId: orderIdB, attemptId: synthB, ticker: tickerB, side: "no",
         fillPriceCents: 85, contracts: 50, costDollars: 42.50, feeDollars: 0.05,
         fillId: `kalshi-fill-34b-${suffix}`, exactPriceDollars: "0.85",
         exactCostDollars: "42.5", exactFeeDollars: "0.05", fillTimestamp: null }],
      { contracts: 50, fillPriceCents: 85, notionalDollars: 42.50, feeDollars: 0.05 },
    );
    await persistVerifiedFillReconciliation(
      [{ seqIndex: 0, orderId: orderIdC, attemptId: synthC, ticker: tickerC, side: "yes",
         fillPriceCents: 75, contracts: 6, costDollars: 4.50, feeDollars: 0.006,
         fillId: `kalshi-fill-34c-${suffix}`, exactPriceDollars: "0.75",
         exactCostDollars: "4.5", exactFeeDollars: "0.006", fillTimestamp: null }],
      { contracts: 6, fillPriceCents: 75, notionalDollars: 4.50, feeDollars: 0.006 },
    );

    // Combined P&L:
    //   A (won): 100 − 80.00 − 0.10 = +$19.90
    //   B (won):  50 − 42.50 − 0.05 = +$7.45
    //   C (lost): −4.50 − 0.006     = −$4.506
    //   Total = $22.844
    const expectedTotal = 19.90 + 7.45 - 4.506;
    const result = await getDailyRealizedPnl(date);
    assert.equal(result.settledFillCount, 3, "all three discovered orders must be counted");
    assert.equal(result.pendingVerificationCount, 0);
    assert.ok(
      Math.abs((result.realizedNetPnlDollars ?? 0) - expectedTotal) < 0.001,
      `expected combined net P&L ~$${expectedTotal.toFixed(3)}, got ${result.realizedNetPnlDollars}`,
    );

    await cleanOrderFills([orderIdA, orderIdB, orderIdC]);
    await cleanAttempts([synthA, synthB, synthC]);
    for (const t of [tickerA, tickerB, tickerC]) {
      await db.delete(marketResults).where(eq(marketResults.ticker, t));
    }
    await cleanDate(date);
  });

  it("34b: Kalshi market result is authoritative when the local won cache is stale", async () => {
    const date = D.kalshi_result_truth;
    const suffix = Date.now().toString();
    const orderId = `kalshi-result-truth-${suffix}`;
    const attemptId = `result-truth-${suffix}`;
    const ticker = `KXBTC15M-RESULT-TRUTH-${suffix}`;

    // This mimics a startup backfill that successfully stores Kalshi's market
    // result but fails before it updates order_attempts.won.
    await db.insert(orderAttempts).values({
      id: attemptId,
      timestampMs: Date.now(),
      isSynthetic: true,
      fixtureNamespace: "trade-store-test",
      easternDate: date,
      ticker,
      series: "KXBTC15M",
      side: "yes",
      outcome: "full_fill",
      orderId,
      reconciled: true,
      won: null,
    });
    await db.insert(marketResults).values({
      ticker, result: "yes", resolvedAtMs: Date.now(), createdAt: new Date(),
    });
    await persistVerifiedFillReconciliation(
      [{
        seqIndex: 0, orderId, attemptId, ticker, side: "yes",
        fillPriceCents: 90, contracts: 10, costDollars: 9, feeDollars: 0.05,
        fillId: `kalshi-fill-result-truth-${suffix}`,
        exactPriceDollars: "0.9",
        exactCostDollars: "9",
        exactFeeDollars: "0.05",
        fillTimestamp: null,
      }],
      { contracts: 10, fillPriceCents: 90, notionalDollars: 9, feeDollars: 0.05 },
    );

    const result = await getDailyRealizedPnl(date);
    assert.equal(result.settledFillCount, 1);
    assert.equal(result.pendingVerificationCount, 0);
    assert.ok(
      Math.abs((result.realizedNetPnlDollars ?? 0) - 0.95) < 0.0001,
      `Kalshi result must produce +$0.95 despite stale won=null; got ${result.realizedNetPnlDollars}`,
    );

    await cleanOrderFills([orderId]);
    await cleanAttempts([attemptId]);
    await db.delete(marketResults).where(eq(marketResults.ticker, ticker));
    await cleanDate(date);
  });

  // ── 35. Exchange sweep log: persistSweepCompletion + loadSweptDates ──────────
  // Proves the durable watermark mechanism that lets restarts skip already-swept
  // dates. Also proves recovery when a date has NO surviving order_attempts rows
  // (all storage-degraded): loadSweptDates() still finds the row because it is
  // written to exchange_sweep_log independently of order_attempts.
  it("35: persistSweepCompletion writes a watermark that loadSweptDates can read back", async () => {
    const dateA = D.sweep_log;
    const dateB = D.sweep_log_multi;

    // Both dates must start absent from the sweep log
    const before = await loadSweptDates();
    assert.ok(!before.has(dateA), `dateA ${dateA} must NOT be in swept set before the test`);
    assert.ok(!before.has(dateB), `dateB ${dateB} must NOT be in swept set before the test`);

    // Persist two distinct watermarks (typical: one per Eastern day)
    await persistSweepCompletion(dateA, 3);
    await persistSweepCompletion(dateB, 0);

    // Both must be readable back
    const after = await loadSweptDates();
    assert.ok(after.has(dateA), `dateA ${dateA} must be in swept set after persist`);
    assert.ok(after.has(dateB), `dateB ${dateB} must be in swept set after persist`);

    // Second call for the same date must be idempotent (onConflictDoNothing)
    await persistSweepCompletion(dateA, 99); // different count — must not overwrite
    const afterDouble = await loadSweptDates();
    assert.ok(afterDouble.has(dateA), "idempotent second call must not remove the row");

    // Verify the original discoveredCount was NOT overwritten (idempotent)
    const [row] = await db.select({ discoveredCount: exchangeSweepLog.discoveredCount })
      .from(exchangeSweepLog).where(eq(exchangeSweepLog.easternDate, dateA));
    assert.equal(row!.discoveredCount, 3, "idempotent second call must not change discoveredCount");

    // Clean up
    await db.delete(exchangeSweepLog).where(eq(exchangeSweepLog.easternDate, dateA));
    await db.delete(exchangeSweepLog).where(eq(exchangeSweepLog.easternDate, dateB));
    await cleanDate(dateA);
    await cleanDate(dateB);
  });

  // ── 36. loadIncompleteFilledAttempts: returns rows with reconcile_failed=true ─
  // Integration test using real DB. Proves the production reconciliation-failure
  // detection semantics: a row with reconcile_failed=true is detected as incomplete
  // and available for Phase-2 retry in the discovery sweep.
  it("36: loadIncompleteFilledAttempts — returns filled bot rows missing fill chunks or with reconcile_failed", async () => {
    const date = D.incomplete_fills;
    const kalshiOrderId = "int-test-order-36";
    const attemptId = `disc-${kalshiOrderId}`;

    // Insert a synthetic filled attempt row (simulates a discovered order)
    await db.insert(orderAttempts).values({
      id:            attemptId,
      timestampMs:   Date.now(),
      isSynthetic:   true,
      fixtureNamespace: "trade-store-test",
      easternDate:   date,
      ticker:        "KXBTC15M-36TEST-T0.25",
      series:        "KXBTC15M",
      side:          "yes",
      outcome:       "filled",
      orderId:       kalshiOrderId,
      source:        "exchange_discovery",
      reconcileFailed: true,   // simulates a failed fill-chunk write
    }).onConflictDoNothing();

    try {
      // Must appear in loadIncompleteFilledAttempts (reconcile_failed=true)
      const incomplete = await loadIncompleteFilledAttempts(date);
      const found = incomplete.find((r) => r.orderId === kalshiOrderId);
      assert.ok(found, "loadIncompleteFilledAttempts must find the reconcile_failed row");
      assert.equal(found!.attemptId, attemptId, "returned attemptId must match");
      assert.equal(found!.ticker, "KXBTC15M-36TEST-T0.25", "returned ticker must match");

      // After inserting a fill chunk, clearing reconcile_failed, AND setting won —
      // all three incomplete indicators must be resolved before the row disappears.
      const fillId = `fill-36-${Date.now()}`;
      await db.insert(orderFills).values({
        id:            fillId,
        orderId:       kalshiOrderId,
        attemptId:     attemptId,
        ticker:        "KXBTC15M-36TEST-T0.25",
        side:          "yes",
        fillPriceCents: 80,
        contracts:     10,
        costDollars:   8.0,
        feeDollars:    0.04,
      }).onConflictDoNothing();

      // Clear reconcile_failed AND set won (loadIncompleteFilledAttempts also
      // returns rows with won=null, so both must be resolved for the row to
      // disappear from the incomplete set).
      await db.update(orderAttempts)
        .set({ reconcileFailed: false, won: true })
        .where(eq(orderAttempts.id, attemptId));

      const afterFix = await loadIncompleteFilledAttempts(date);
      const stillMissing = afterFix.find((r) => r.orderId === kalshiOrderId);
      assert.ok(!stillMissing, "row must NOT appear in incomplete list after fill chunk written, reconcile_failed cleared, and won set");
    } finally {
      await db.delete(orderFills).where(eq(orderFills.orderId, kalshiOrderId));
      await db.delete(orderAttempts).where(eq(orderAttempts.id, attemptId));
      await cleanDate(date);
    }
  });

  // ── 37. countIncompleteFillsForDate: returns 0 when all fills are durable ──
  // Integration test using real DB. Proves the Phase-3 pre-watermark validation:
  // a date with all fills having durable chunks AND won set returns count=0.
  it("37: countIncompleteFillsForDate — returns correct count based on fill chunks and settlement", async () => {
    const date = D.count_incomplete;
    const orderId = "int-test-order-37";
    const attemptId = `disc-${orderId}`;

    // Insert a filled bot attempt with no fill chunks and won=null
    await db.insert(orderAttempts).values({
      id:          attemptId,
      timestampMs: Date.now(),
      isSynthetic: true,
      fixtureNamespace: "trade-store-test",
      easternDate: date,
      ticker:      "KXBTC15M-37TEST-T0.25",
      series:      "KXBTC15M",
      side:        "yes",
      outcome:     "filled",
      orderId,
      source:      "exchange_discovery",
      won:         null,
    }).onConflictDoNothing();

    try {
      // count > 0: no fill chunks, won=null
      const countBefore = await countIncompleteFillsForDate(date);
      assert.ok(countBefore > 0, `countIncompleteFillsForDate must be >0 before fill chunks exist; got ${countBefore}`);

      // Insert fill chunk
      const fillId = `fill-37-${Date.now()}`;
      await db.insert(orderFills).values({
        id:            fillId,
        orderId,
        attemptId,
        ticker:        "KXBTC15M-37TEST-T0.25",
        side:          "yes",
        fillPriceCents: 80,
        contracts:     10,
        costDollars:   8.0,
        feeDollars:    0.04,
      }).onConflictDoNothing();

      // count still > 0: fill chunk exists but won=null
      const countAfterFills = await countIncompleteFillsForDate(date);
      assert.ok(countAfterFills > 0, "count must still be >0 when fill chunks exist but won=null");

      // Set won=true
      await db.update(orderAttempts).set({ won: true }).where(eq(orderAttempts.id, attemptId));

      // count = 0: fill chunks present AND won set
      const countAfterWon = await countIncompleteFillsForDate(date);
      assert.equal(countAfterWon, 0, "countIncompleteFillsForDate must be 0 when fill chunks exist and won is set");
    } finally {
      await db.delete(orderFills).where(eq(orderFills.orderId, orderId));
      await db.delete(orderAttempts).where(eq(orderAttempts.id, attemptId));
      await cleanDate(date);
    }
  });

  // ── getOpenConfirmedPositionTickers: startup restore query ───────────────
  it("getOpenConfirmedPositionTickers — returns filled+unsettled tickers, excludes settled and unfilled", async () => {
    const date   = D.open_positions;
    const filled = `open-pos-filled-${Date.now()}`;
    const settled = `open-pos-settled-${Date.now()}`;
    const reserved = `open-pos-reserved-${Date.now()}`;
    const ticker  = `KXBTC15M-${date}`;
    const tickerB = `KXETH15M-${date}`;

    const now = Date.now();
    const base = {
      series: "KXBTC15M", windowCloseTime: null, side: "yes" as const,
      source: "test", triggerPriceCents: 80, limitPriceCents: 80,
      requestedContracts: 1, requestedNotionalCents: 8000, timestampMs: now,
    };

    try {
      // Insert a filled+unsettled row (won=null) — should appear.
      await db.insert(orderAttempts).values({
        id: filled, ticker, easternDate: date, outcome: "filled",
        isSynthetic: true, fixtureNamespace: "trade-store-test",
        ...base,
      }).onConflictDoNothing();

      // Insert a filled+settled row (won=true) — must NOT appear.
      await db.insert(orderAttempts).values({
        id: settled, ticker: tickerB, easternDate: date, outcome: "filled", won: true,
        isSynthetic: true, fixtureNamespace: "trade-store-test",
        ...base,
      }).onConflictDoNothing();

      // Insert a reserved (unfilled) row — must NOT appear.
      await db.insert(orderAttempts).values({
        id: reserved, ticker, easternDate: date, outcome: "reserved",
        isSynthetic: true, fixtureNamespace: "trade-store-test",
        ...base,
      }).onConflictDoNothing();

      const tickers = await getOpenConfirmedPositionTickers();
      assert.notEqual(tickers, null, "query must succeed with a healthy DB");
      assert.ok(tickers!.includes(ticker),  `filled+unsettled ticker ${ticker} must be returned`);
      assert.ok(!tickers!.includes(tickerB), `settled ticker ${tickerB} must NOT be returned`);

      // Signed startup-restore variant: same filter plus side + quantity detail.
      const positions = await getOpenConfirmedPositions();
      assert.notEqual(positions, null, "signed query must succeed with a healthy DB");
      const pos = positions!.find((p) => p.ticker === ticker);
      assert.ok(pos, `filled+unsettled ticker ${ticker} must be returned with detail`);
      assert.equal(pos!.side, "yes");
      assert.ok(!positions!.some((p) => p.ticker === tickerB), "settled ticker must NOT be returned");
    } finally {
      await db.delete(orderAttempts).where(
        inArray(orderAttempts.id, [filled, settled, reserved]),
      );
      await cleanDate(date);
    }
  });

  // ── Eval events: two same-millisecond events each get their own SQL row ──────
  it("eval-event: two events with identical ticker/timestampMs/side/outcome both persist to SQL", async () => {
    const nowMs = Date.now();
    const ticker = `TEST-EVAL-${nowMs}`;

    const base = {
      ticker,
      series:            "KXBTC15M",
      timestampMs:       nowMs,
      secondsLeft:       30,
      source:            "websocket" as const,
      yesBid:            85,
      yesAsk:            87,
      noBid:             12,
      noAsk:             14,
      yesDerivedAsk:     88,
      noDerivedAsk:      null,
      side:              "yes" as const,
      limitCents:        91,
      outcome:           "forwarded" as const,
      preflightDecision: null,
    };

    try {
      // Fire two events with identical shape at the same millisecond
      recordEvaluationEventToSql(base);
      recordEvaluationEventToSql(base);
      await _drainPendingDurableWritesForTesting();

      // Each event's SQL PK is ev:<sha256(JSON.stringify(event))>.  Two calls
      // with identical content produce the same hash → same PK → onConflictDoNothing
      // deduplicates them to a single row.  This is intentional: the same
      // hash-based scheme lets the NDJSON startup backfill be idempotent.
      const rows = await loadRecentEvaluationEventsFromSql(60_000);
      const found = rows.filter((e) => e.ticker === ticker && e.timestampMs === nowMs);
      assert.equal(
        found.length,
        1,
        `expected 1 SQL row for two identical events (sha256 dedup); got ${found.length}`,
      );
    } finally {
      await db.delete(evaluationEvents).where(eq(evaluationEvents.ticker, ticker));
    }
  });

  // ── Eval-event durable-write buffer: end-to-end DB-outage replay ────────────
  // IMPORTANT: temporarily injects a broken DB (resets to real DB at the end).
  // Placed near the end alongside test 5 which also disrupts the pool.
  it("eval-event buffer: events written during DB outage are replayed after recovery", async () => {
    const ticker = `TEST-EVAL-BUF-${Date.now()}`;
    const nowMs  = Date.now();

    const makeEvalEvent = (offsetMs: number, outcomeLabel: "forwarded" | "out_of_zone") => ({
      ticker,
      series:            "KXBTC15M",
      timestampMs:       nowMs + offsetMs,
      secondsLeft:       60,
      source:            "websocket" as const,
      yesBid:            85,
      yesAsk:            87,
      noBid:             12,
      noAsk:             14,
      yesDerivedAsk:     88,
      noDerivedAsk:      null,
      side:              "yes" as const,
      limitCents:        91,
      outcome:           outcomeLabel,
      preflightDecision: null,
    });

    try {
      // ── Step 1: healthy DB — record an event and confirm it persists ─────────
      // recordEvaluationEventToSql is fire-and-forget (no buffer when healthy),
      // so we poll SQL for up to 1 s rather than relying on the drain helper.
      assert.equal(isStorageHealthy(), true, "DB must be healthy before step 1");

      recordEvaluationEventToSql(makeEvalEvent(0, "forwarded"));

      let step1Rows: ReturnType<typeof Array.prototype.filter> = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const rows = await loadRecentEvaluationEventsFromSql(60_000);
        step1Rows = rows.filter((e) => e.ticker === ticker && e.outcome === "forwarded");
        if (step1Rows.length >= 1) break;
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      assert.equal(step1Rows.length, 1, "step 1: forwarded event must exist in SQL after healthy write");

      // ── Step 2: inject broken DB — record another event → must be buffered ───
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const brokenDb = new Proxy({} as any, {
        get(_target, prop) {
          if (["execute", "transaction", "select", "insert", "update", "delete"].includes(String(prop))) {
            return () => { throw new Error("DB connection refused (test-injected outage)"); };
          }
          return undefined;
        },
      });

      await initTradeStore(brokenDb);
      assert.equal(isStorageHealthy(), false, "step 2: DB must be unhealthy after injecting broken DB");

      const countBefore = getPendingDurableWriteCount();
      recordEvaluationEventToSql(makeEvalEvent(1, "out_of_zone"));

      // The write must have been buffered (not silently dropped) because the DB is unhealthy.
      assert.equal(
        getPendingDurableWriteCount(),
        countBefore + 1,
        "step 2: event written during outage must be buffered in the durable-write queue",
      );

      // ── Step 3: restore real DB, drain, confirm the buffered event is in SQL ─
      await initTradeStore();
      assert.equal(isStorageHealthy(), true, "step 3: DB must be healthy after re-init");

      await _drainPendingDurableWritesForTesting();

      // Allow any remaining fire-and-forget promises to settle
      await new Promise((r) => setImmediate(r));

      const afterStep3 = await loadRecentEvaluationEventsFromSql(60_000);
      const step3Rows  = afterStep3.filter((e) => e.ticker === ticker && e.outcome === "out_of_zone");
      assert.equal(
        step3Rows.length,
        1,
        "step 3: buffered out_of_zone event must appear in SQL after DB recovery and drain",
      );
    } finally {
      // Clean up test rows regardless of pass/fail
      await db.delete(evaluationEvents).where(eq(evaluationEvents.ticker, ticker));
      // Restore healthy DB if a step left it broken
      if (!isStorageHealthy()) await initTradeStore();
    }
  });

  // ── 42. getVerifiedPnlBySeries: won-column fallback (no market_results row) ──
  // Proves that an order settled via recoverForwardSettlementsFromSql() — which
  // writes won=true/false directly on order_attempts without inserting a
  // market_results row — is included in the per-series P&L breakdown.
  it("42: getVerifiedPnlBySeries — counts orders settled only via the won column", async () => {
    const date   = D.series_won_fallback;
    const suffix = Date.now().toString();
    const orderId   = `pnl-series-won-${suffix}`;
    const attemptId = `series-won-${suffix}`;
    const ticker    = `KXBTC15M-SERIES-WON-${suffix}`;

    // Seed a reconciled filled attempt with won=true but NO market_results row.
    // This mirrors what recoverForwardSettlementsFromSql() produces when
    // market_results was not populated for a given ticker.
    await db.insert(orderAttempts).values({
      id:               attemptId,
      timestampMs:      Date.now(),
      isSynthetic:      true,
      fixtureNamespace: "trade-store-test",
      easternDate:      date,
      ticker,
      series:           "KXBTC15M",
      side:             "yes",
      outcome:          "full_fill",
      orderId,
      reconciled:       true,
      won:              true,          // set by recoverForwardSettlementsFromSql
    }).onConflictDoNothing();

    // Seed canonical fill chunks (10 contracts @ 80¢, fee $0.10)
    // Expected P&L: 10 − 8.00 − 0.10 = +$1.90
    await persistVerifiedFillReconciliation(
      [{
        seqIndex:          0,
        orderId,
        attemptId,
        ticker,
        side:              "yes",
        fillPriceCents:    80,
        contracts:         10,
        costDollars:       8.00,
        feeDollars:        0.10,
        fillId:            `fill-series-won-${suffix}`,
        exactPriceDollars: "0.8",
        exactCostDollars:  "8",
        exactFeeDollars:   "0.1",
        fillTimestamp:     null,
      }],
      { contracts: 10, fillPriceCents: 80, notionalDollars: 8.00, feeDollars: 0.10 },
    );

    try {
      const { bySeries, combined } = await getVerifiedPnlBySeries(date, date);

      const btcRow = bySeries.find((r) => r.series === "KXBTC15M");
      assert.ok(btcRow, "KXBTC15M must appear in getVerifiedPnlBySeries result");
      assert.ok(
        btcRow.settledFillCount >= 1,
        `settled_fill_count must be ≥ 1; got ${btcRow.settledFillCount} — won-only order not counted`,
      );
      assert.equal(btcRow.pendingVerificationCount, 0, "won-only order must not be pending");

      // P&L must reflect the won-fallback path (10 contracts − $8 cost − $0.10 fee = +$1.90)
      const expectedPnl = 10 - 8.00 - 0.10; // +1.90
      assert.ok(
        Math.abs((btcRow.realizedNetPnlDollars ?? 0) - expectedPnl) < 0.001,
        `expected KXBTC15M P&L ~$${expectedPnl.toFixed(2)} via won fallback; ` +
        `got ${btcRow.realizedNetPnlDollars}`,
      );

      // Combined view must also see the order
      assert.ok(
        combined.settledFillCount >= 1,
        "combined settled_fill_count must be ≥ 1 for the won-only order",
      );
    } finally {
      await cleanOrderFills([orderId]);
      await cleanAttempts([attemptId]);
      await cleanDate(date);
    }
  });

  // ── 43. getVerifiedPnlByTier: won-column fallback (no market_results row) ──
  // Proves that an order settled via recoverForwardSettlementsFromSql() — which
  // writes won=true/false directly on order_attempts without inserting a
  // market_results row — is included in the per-tier P&L breakdown.
  it("43: getVerifiedPnlByTier — counts orders settled only via the won column", async () => {
    const date      = D.tier_won_fallback;
    const suffix    = Date.now().toString();
    const orderId   = `pnl-tier-won-${suffix}`;
    const attemptId = `tier-won-${suffix}`;
    // Use trigger_price_cents=92 which falls in the '90–95¢' tier.
    const ticker    = `KXBTC15M-TIER-WON-${suffix}`;

    // Seed a reconciled filled attempt with won=true but NO market_results row.
    // trigger_price_cents=92 puts this order in the '90–95¢' tier bucket.
    await db.insert(orderAttempts).values({
      id:               attemptId,
      timestampMs:      Date.now(),
      isSynthetic:      true,
      fixtureNamespace: "trade-store-test",
      easternDate:      date,
      ticker,
      series:           "KXBTC15M",
      side:             "yes",
      outcome:          "full_fill",
      orderId,
      reconciled:       true,
      won:              true,          // set by recoverForwardSettlementsFromSql
      triggerPriceCents: 92,           // inside '90–95¢' tier
      limitPriceCents:   92,
    }).onConflictDoNothing();

    // Seed canonical fill chunks (10 contracts @ 92¢, fee $0.10)
    // Expected P&L: 10 − 9.20 − 0.10 = +$0.70
    await persistVerifiedFillReconciliation(
      [{
        seqIndex:          0,
        orderId,
        attemptId,
        ticker,
        side:              "yes",
        fillPriceCents:    92,
        contracts:         10,
        costDollars:       9.20,
        feeDollars:        0.10,
        fillId:            `fill-tier-won-${suffix}`,
        exactPriceDollars: "0.92",
        exactCostDollars:  "9.2",
        exactFeeDollars:   "0.1",
        fillTimestamp:     null,
      }],
      { contracts: 10, fillPriceCents: 92, notionalDollars: 9.20, feeDollars: 0.10 },
    );

    try {
      const { byTier, combined } = await getVerifiedPnlByTier(date, date);

      const tierRow = byTier.find((r) => r.tierLabel === "90–95¢");
      assert.ok(tierRow, "'90–95¢' tier must appear in getVerifiedPnlByTier result");
      assert.ok(
        tierRow.settledFillCount >= 1,
        `settled_fill_count must be ≥ 1; got ${tierRow.settledFillCount} — won-only order not counted`,
      );
      assert.equal(tierRow.pendingVerificationCount, 0, "won-only order must not be pending");

      // P&L must reflect the won-fallback path (10 contracts − $9.20 cost − $0.10 fee = +$0.70)
      const expectedPnl = 10 - 9.20 - 0.10; // +0.70
      assert.ok(
        Math.abs((tierRow.realizedNetPnlDollars ?? 0) - expectedPnl) < 0.001,
        `expected '90–95¢' tier P&L ~$${expectedPnl.toFixed(2)} via won fallback; ` +
        `got ${tierRow.realizedNetPnlDollars}`,
      );

      // Combined view must also see the order
      assert.ok(
        combined.settledFillCount >= 1,
        "combined settled_fill_count must be ≥ 1 for the won-only order",
      );
    } finally {
      await cleanOrderFills([orderId]);
      await cleanAttempts([attemptId]);
      await cleanDate(date);
    }
  });

  // ── 44. getVerifiedPnlByTier: tier boundaries track PRICE_TIERS automatically ─
  // Verifies that the SQL CASE expression built from PRICE_TIERS correctly places
  // orders at exact tier boundaries into the named tier, and that orders priced
  // outside all tiers land in "other".  If PRICE_TIERS changes, this test catches
  // any mismatch between the guard constants and the SQL tier report automatically.
  it("44: getVerifiedPnlByTier — tier boundaries match PRICE_TIERS exactly", async () => {
    const date   = D.tier_boundary;
    const suffix = Date.now().toString();

    // Helper: seed a fully reconciled, settled order at a given trigger price
    // and return its ids for cleanup.
    async function seedTierOrder(
      priceCents: number,
      label: string,
    ): Promise<{ orderId: string; attemptId: string }> {
      const orderId   = `tier-bound-ord-${priceCents}-${label}-${suffix}`;
      const attemptId = `tier-bound-${priceCents}-${label}-${suffix}`;
      const ticker    = `KXBTC15M-TIERBOUND-${priceCents}-${label}-${suffix}`;

      await db.insert(orderAttempts).values({
        id:               attemptId,
        timestampMs:      Date.now(),
        isSynthetic:      true,
        fixtureNamespace: "trade-store-test",
        easternDate:      date,
        ticker,
        series:           "KXBTC15M",
        side:             "yes",
        outcome:          "full_fill",
        orderId,
        reconciled:       true,
        won:              true,
        triggerPriceCents: priceCents,
        limitPriceCents:   priceCents,
      }).onConflictDoNothing();

      // 1 contract @ priceCents¢, fee $0.01
      const priceDollars = priceCents / 100;
      await persistVerifiedFillReconciliation(
        [{
          seqIndex:          0,
          orderId,
          attemptId,
          ticker,
          side:              "yes",
          fillPriceCents:    priceCents,
          contracts:         1,
          costDollars:       priceDollars,
          feeDollars:        0.01,
          fillId:            `fill-tb-${priceCents}-${label}-${suffix}`,
          exactPriceDollars: (priceDollars).toFixed(2),
          exactCostDollars:  priceDollars.toFixed(2),
          exactFeeDollars:   "0.01",
          fillTimestamp:     null,
        }],
        { contracts: 1, fillPriceCents: priceCents, notionalDollars: priceDollars, feeDollars: 0.01 },
      );

      return { orderId, attemptId };
    }

    // Collect all seeded ids for cleanup
    const seeded: Array<{ orderId: string; attemptId: string }> = [];

    try {
      // Seed one order at the min boundary and one at the max boundary of each
      // named tier, plus one order clearly outside all tiers (PRICE_FLOOR − 5¢).
      for (const tier of PRICE_TIERS) {
        seeded.push(await seedTierOrder(tier.min, "min"));
        seeded.push(await seedTierOrder(tier.max, "max"));
      }
      // Choose a price that is definitively outside every tier by scanning 1–99
      // for any integer not covered by a PRICE_TIERS range.  This is robust to
      // future tier additions or range changes without relying on a specific offset.
      function isCoveredByTier(p: number): boolean {
        return PRICE_TIERS.some((t) => p >= t.min && p <= t.max);
      }
      const outOfBandPrice = (() => {
        for (let p = 1; p <= 99; p++) {
          if (!isCoveredByTier(p)) return p;
        }
        return null;
      })();
      assert.ok(
        outOfBandPrice !== null,
        "PRICE_TIERS covers all prices 1–99; no out-of-band price is available for this test",
      );
      seeded.push(await seedTierOrder(outOfBandPrice!, "other"));

      const { byTier } = await getVerifiedPnlByTier(date, date);

      // Every named tier must appear with exactly 2 settled orders (min + max
      // boundary) — no more, no less.  An exact count proves the boundary order
      // was not swallowed by "other" AND that no out-of-band order leaked in.
      for (const tier of PRICE_TIERS) {
        const row = byTier.find((r) => r.tierLabel === tier.label);
        assert.ok(
          row,
          `tier '${tier.label}' must appear in getVerifiedPnlByTier result; ` +
          `byTier labels: ${byTier.map((r) => r.tierLabel).join(", ")}`,
        );
        assert.equal(
          row.settledFillCount,
          2,
          `tier '${tier.label}' must have exactly 2 settled orders (min + max boundary); ` +
          `got ${row.settledFillCount} — a boundary order may have leaked into 'other'`,
        );
        assert.equal(
          row.pendingVerificationCount,
          0,
          `tier '${tier.label}' must have 0 pending-verification orders at boundary prices`,
        );
      }

      // The out-of-band order must appear in "other" with exactly 1 settled order.
      // Any leakage into a named tier would reduce the "other" count or prevent
      // the row from appearing, and exact named-tier counts above would also catch it.
      const otherRow = byTier.find((r) => r.tierLabel === "other");
      assert.ok(
        otherRow,
        `order at ${outOfBandPrice}¢ (outside all tiers) must create an 'other' row; ` +
        `byTier labels: ${byTier.map((r) => r.tierLabel).join(", ")}`,
      );
      assert.equal(
        otherRow.settledFillCount,
        1,
        `'other' bucket must have exactly 1 settled order (the out-of-band ${outOfBandPrice}¢ order); ` +
        `got ${otherRow.settledFillCount} — it may have been misclassified into a named tier`,
      );
    } finally {
      await cleanOrderFills(seeded.map((s) => s.orderId));
      await cleanAttempts(seeded.map((s) => s.attemptId));
      await cleanDate(date);
    }
  });

  // ── 5. Outage: initTradeStore with broken DB → isHealthy=false ────────────
  // IMPORTANT: placed LAST because it disrupts the DB pool. Tests 1–25 all run
  // with a healthy pool before this test degrades it.
  it("5: outage — broken DB causes isStorageHealthy to return false (runs last)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brokenDb = new Proxy({} as any, {
      get(_target, prop) {
        if (prop === "execute" || prop === "transaction" || prop === "select" || prop === "insert") {
          return () => { throw new Error("DB connection refused"); };
        }
        return undefined;
      },
    });

    // initTradeStore now probes the override — brokenDb.execute() throws → _healthy=false
    await initTradeStore(brokenDb);
    assert.equal(isStorageHealthy(), false, "should be unhealthy with broken DB");

    // Restore with real DB
    await initTradeStore();
    assert.equal(isStorageHealthy(), true, "should be healthy again after re-init");
  });

});
