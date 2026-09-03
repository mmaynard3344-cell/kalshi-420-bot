import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  acknowledgeEth420CandidateLiveOrder, createEth420CandidateLiveOrder, getEth420CandidateLiveOrder,
  claimEth420CandidateSecondaryEntryAttempt, recordEth420CandidateSecondaryEntryEvent,
  markEth420CandidateSecondarySubmissionPending,
  getEth420CandidateState, initTradeStore, listPendingEth420CandidateLiveOrders,
  listEth420CandidateDailyPnl,
  recordEth420CandidateExecutionSnapshot, pruneEth420CandidateExecutionSnapshots,
  readPersistedEth420CandidateState, reserveEth420CandidateLiveOrderIfStateMatches,
   resetEth420CandidateStepToZero, settleEth420CandidateLiveOrder,
    reserveEth420CandidateEmergencyReduction, hasUnresolvedEth420CandidateEmergencyReduction,
    _setEth420CandidateEmergencyFenceForTesting,
} from "./tradeStore.js";
import {
  _setEth420CandidateAuthFetchForTesting,
  _setEth420CandidateBalanceReadForTesting,
  confirmedEth420InsufficientBalanceRejectionReason,
  eth420EmergencyReductionInstruction,
  evaluateEth420Candidate,
  evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled,
  observeEth420Candidate,
  prepareEth420CandidateDecision,
  reconcileEth420CandidateLiveSettlements,
  recoverAndSettleEth420CandidateLiveOrder,
} from "./strategies/eth420SixStepCandidate.js";

const date = "1970-01-03";
const settlementDate = "1970-01-02";
const ticker = "KXETH15M-70JAN030000-00-ETH420-LIVE-ISOLATION";
const id = `${ticker}:eth420-live-v1`;
const legacyKey = "eth420-live-isolation-legacy";
const bootstrapDate = "1970-01-04";
const recoveryDate = "1970-01-05";
const fenceDates = ["1970-01-06", "1970-01-07", "1970-01-08", "1970-01-09", "1970-01-10", "1970-01-11"];
const canonicalFenceState = (easternDate: string) => ({
  easternDate, side: "no" as const, step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null,
});
test("NO emergency reduction maps to a YES-book bid and never an ask", () => {
  assert.deepEqual(eth420EmergencyReductionInstruction("yes", 63), { side: "ask", limitPriceCents: 63 });
  assert.deepEqual(eth420EmergencyReductionInstruction("no", 63, 67), { side: "bid", limitPriceCents: 67 });
});

test("daily P&L retains every prior Eastern-day candidate order after the recent-history cap", async () => {
  const priorEasternDate = "1972-02-14";
  const latestEasternDate = "1972-02-15";
  const prefix = "KXETH15M-72FEB-DAILY-PNL-";
  const rows = [
    ...Array.from({ length: 50 }, (_, index) => ({ easternDate: priorEasternDate, pnl: 125, notional: "15.00", fee: "0.10", status: "settled", suffix: `WIN-${index}` })),
    ...Array.from({ length: 35 }, (_, index) => ({ easternDate: priorEasternDate, pnl: -80, notional: "12.50", fee: "0.05", status: "settled", suffix: `LOSS-${index}` })),
    ...Array.from({ length: 20 }, (_, index) => ({ easternDate: priorEasternDate, pnl: 0, notional: "7.25", fee: "0.03", status: "settled", suffix: `EVEN-${index}` })),
    ...Array.from({ length: 15 }, (_, index) => ({ easternDate: priorEasternDate, pnl: null, notional: null, fee: null, status: "reserved", suffix: `PENDING-${index}` })),
    ...Array.from({ length: 3 }, (_, index) => ({ easternDate: latestEasternDate, pnl: index === 0 ? 300 : -100, notional: "15.00", fee: "0.10", status: "settled", suffix: `LATEST-${index}` })),
  ];

  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date IN (${priorEasternDate}, ${latestEasternDate})`);
  try {
    for (const [index, row] of rows.entries()) {
      const ticker = `${prefix}${row.suffix}`;
      await db.execute(sql`
        INSERT INTO eth420_candidate_live_orders
          (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
           effective_wager_cents, state_before_json, status, realized_pnl_delta_cents,
           actual_notional_dollars, actual_fee_dollars, created_at_ms, updated_at_ms)
        VALUES (${`${ticker}:eth420-live-v1`}, ${ticker}, ${row.easternDate}, 'no', 0, 30, 50, 1500,
          '{}', ${row.status}, ${row.pnl}, ${row.notional}, ${row.fee}, ${10_000 + index}, ${10_000 + index})`);
    }

    const response = await listEth420CandidateDailyPnl();
    const priorDay = response.rows.find((row) => row.easternDate === priorEasternDate);

    assert.equal(response.available, true);
    assert.deepEqual(priorDay, {
      easternDate: priorEasternDate,
      totalOrderCount: 120,
      settledOrderCount: 105,
      winningOrderCount: 50,
      losingOrderCount: 35,
      zeroPnlOrderCount: 20,
      totalBetsCents: 133_250,
      totalFeesCents: 735,
      grossWinningsCents: 6_250,
      grossLossesCents: -2_800,
      netRealizedPnlCents: 3_450,
    }, "the full persisted prior-day ledger, not a 100-row recent-history subset, must determine daily P&L");
  } finally {
    await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date IN (${priorEasternDate}, ${latestEasternDate})`);
  }
});

const fenceOrder = (easternDate: string, suffix: string, expectedState = canonicalFenceState(easternDate)) => ({
  id: `KXETH15M-70JAN${suffix}:eth420-live-v1`, ticker: `KXETH15M-70JAN${suffix}`,
  easternDate, side: "no" as const, step: 0, requestedContracts: 30, limitPriceCents: 50,
  effectiveWagerCents: 1500, stateBeforeJson: JSON.stringify(expectedState), expectedState,
});
async function clearFenceDate(easternDate: string): Promise<void> {
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${easternDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${easternDate}`);
}

before(async () => {
  delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  await initTradeStore();
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${id}`);
  await db.execute(sql`DELETE FROM eth420_candidate_execution_snapshots WHERE candidate_order_id=${id}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${settlementDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${date}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${bootstrapDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${bootstrapDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${recoveryDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${recoveryDate}`);
  for (const fenceDate of fenceDates) await clearFenceDate(fenceDate);
  await db.execute(sql`DELETE FROM eth_martingale_state WHERE strategy_key=${legacyKey}`);
  _setEth420CandidateEmergencyFenceForTesting(false);
});
after(async () => {
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${id}`);
  await db.execute(sql`DELETE FROM eth420_candidate_execution_snapshots WHERE candidate_order_id=${id}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${settlementDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${date}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${bootstrapDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${bootstrapDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${recoveryDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${recoveryDate}`);
  for (const fenceDate of fenceDates) await clearFenceDate(fenceDate);
  await db.execute(sql`DELETE FROM eth_martingale_state WHERE strategy_key=${legacyKey}`);
  _setEth420CandidateEmergencyFenceForTesting(false);
  await pool.end().catch(() => {});
});

test("candidate settlement changes only candidate state, never legacy martingale bytes", async () => {
  await db.execute(sql`INSERT INTO eth_martingale_state
    (strategy_key, eastern_date, side, martingale_step, spent_cents, realized_pnl_cents, updated_at_ms)
    VALUES (${legacyKey}, ${settlementDate}, 'yes', 4, 777, -12345, 555)`);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${settlementDate}, 'no', 0, 0, NULL, 1)`);
  const before = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal(await createEth420CandidateLiveOrder({
    id, ticker, easternDate: settlementDate, side: "no", step: 0, requestedContracts: 30,
    limitPriceCents: 50, effectiveWagerCents: 1500,
    stateBeforeJson: JSON.stringify({ easternDate: settlementDate, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null }),
  }), true);
  assert.equal(await settleEth420CandidateLiveOrder({
    id, result: "no", filledContracts: 30, realizedPnlDeltaCents: 1500,
    nextState: { easternDate: settlementDate, side: "yes", step: 0, realizedPnlCents: 1500, lastBlockResetAtMs: null },
    actualNotionalDollars: "15", actualFeeDollars: "0", fillPriceCents: 50,
  }), true);
  const after = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal((before as any).rows[0].bytes, (after as any).rows[0].bytes);
  assert.deepEqual(await getEth420CandidateState(settlementDate), {
    easternDate: settlementDate, side: "yes", step: 0, realizedPnlCents: 1500, lastBlockResetAtMs: null,
  });
});

async function assertBackFlipSettlementParksCandidateState(
  suffix: string, result: "yes" | "no", realizedPnlDeltaCents: number,
): Promise<void> {
  const easternDate = "1970-01-14";
  const backFlipId = `KXETH15M-70JAN14${suffix}:eth420-live-v1`;
  const parked = {
    easternDate, side: "no" as const, step: 4, realizedPnlCents: -4800, lastBlockResetAtMs: null,
  };
  await db.execute(sql`DELETE FROM eth420_candidate_back_flip_overrides WHERE candidate_order_id=${backFlipId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${backFlipId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${easternDate}`);
  try {
    await db.execute(sql`INSERT INTO eth420_candidate_daily_state
      (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
      VALUES (${easternDate}, ${parked.side}, ${parked.step}, ${parked.realizedPnlCents}, NULL, 1)`);
    assert.equal(await createEth420CandidateLiveOrder({
      id: backFlipId, ticker: `KXETH15M-70JAN14${suffix}`, easternDate, side: "yes", step: parked.step,
      requestedContracts: 840, limitPriceCents: 50, effectiveWagerCents: 42000,
      stateBeforeJson: JSON.stringify(parked),
    }), true);
    await db.execute(sql`INSERT INTO eth420_candidate_back_flip_overrides
      (source_candidate_order_id, source_ticker, source_open_time_ms, missed_side, target_open_time_ms,
       target_ticker, status, armed_at_ms, candidate_order_id)
      VALUES (${`source-${suffix}`}, 'KXETH15M-SOURCE', ${1_123_200_000}, 'no', ${1_124_100_000},
       ${`KXETH15M-70JAN14${suffix}`}, 'reserved', 1, ${backFlipId})`);
    assert.equal(await settleEth420CandidateLiveOrder({
      id: backFlipId, result, filledContracts: 840, realizedPnlDeltaCents,
      // Deliberately represents the transition a normal candidate trade would
      // have taken; Back Flip settlement must ignore it.
      nextState: { easternDate, side: "yes", step: 0, realizedPnlCents: 999999, lastBlockResetAtMs: null },
      expectedState: parked, actualNotionalDollars: "420", actualFeeDollars: "0", fillPriceCents: 50,
    }), true);
    assert.deepEqual(await getEth420CandidateState(easternDate), parked);
    const settled = await db.execute(sql`SELECT realized_pnl_delta_cents, state_after_json
      FROM eth420_candidate_live_orders WHERE id=${backFlipId}`);
    assert.equal(Number((settled as any).rows[0].realized_pnl_delta_cents), realizedPnlDeltaCents);
    assert.deepEqual(JSON.parse((settled as any).rows[0].state_after_json), parked);
    const overrides = await db.execute(sql`SELECT status, count(*)::int AS count
      FROM eth420_candidate_back_flip_overrides
      WHERE source_candidate_order_id=${`source-${suffix}`}
      GROUP BY status`);
    assert.deepEqual((overrides as any).rows, [{ status: "settled", count: 1 }],
      "a Back Flip B settlement resolves its own overlay and never arms a recursive C override");
  } finally {
    await db.execute(sql`DELETE FROM eth420_candidate_back_flip_overrides WHERE candidate_order_id=${backFlipId}`);
    await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${backFlipId}`);
    await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${easternDate}`);
  }
}

test("a winning Back Flip leaves the parked martingale side and step unchanged for C", async () => {
  await assertBackFlipSettlementParksCandidateState("-WIN", "yes", 42000);
});

test("a losing Back Flip leaves the parked martingale side and step unchanged for C", async () => {
  await assertBackFlipSettlementParksCandidateState("-LOSS", "no", -42000);
});

test("an armed Back Flip exclusively owns B at the durable candidate reservation fence", async () => {
  const easternDate = "1970-01-15";
  const targetOpenTimeMs = 1_210_500_000;
  const sourceId = "back-flip-exclusive-source";
  const targetTicker = "KXETH15M-70JAN150000-00-BACK-FLIP";
  const targetId = `${targetTicker}:eth420-live-v1`;
  const parked = canonicalFenceState(easternDate);
  await db.execute(sql`DELETE FROM eth420_candidate_back_flip_overrides WHERE source_candidate_order_id=${sourceId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${targetId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${easternDate}`);
  try {
    await db.execute(sql`INSERT INTO eth420_candidate_daily_state
      (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
      VALUES (${easternDate}, 'no', 0, 0, NULL, 1)`);
    await db.execute(sql`INSERT INTO eth420_candidate_back_flip_overrides
      (source_candidate_order_id, source_ticker, source_open_time_ms, missed_side, target_open_time_ms, status, armed_at_ms)
      VALUES (${sourceId}, 'KXETH15M-A', ${targetOpenTimeMs - 900000}, 'no', ${targetOpenTimeMs}, 'armed', 1)`);
    const normal = {
      id: targetId, ticker: targetTicker, easternDate, side: "no" as const, step: 0,
      requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500,
      stateBeforeJson: JSON.stringify(parked), expectedState: parked, marketOpenTimeMs: targetOpenTimeMs,
    };
    assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches({ ...normal, backFlip: null }), false);
    assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches({
      ...normal, side: "yes", requestedContracts: 50, effectiveWagerCents: 2500,
      backFlip: {
        sourceCandidateOrderId: sourceId, targetTicker, targetOpenTimeMs, observedAtMs: 2,
        missedSideBidCents: 49, selectedSide: "yes", intendedWagerCents: 2500, requestedContracts: 50,
        executionMode: "resting_gtc", limitPriceCents: 50,
      },
    }), true);
    const claimed = await db.execute(sql`SELECT status, candidate_order_id, execution_mode, execution_limit_price_cents
      FROM eth420_candidate_back_flip_overrides WHERE source_candidate_order_id=${sourceId}`);
    assert.deepEqual((claimed as any).rows, [{
      status: "reserved", candidate_order_id: targetId, execution_mode: "resting_gtc", execution_limit_price_cents: 50,
    }]);
  } finally {
    await db.execute(sql`DELETE FROM eth420_candidate_back_flip_overrides WHERE source_candidate_order_id=${sourceId}`);
    await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${targetId}`);
    await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${easternDate}`);
  }
});

test("emergency reduction is candidate-only, durable before POST, idempotent, and rejects oversize", async () => {
  const reductionId = `${ticker}-EMERGENCY:eth420-live-v1`;
  const reductionKey = "eth420-emergency-reduction-test-key-0001";
  await db.execute(sql`DELETE FROM eth420_candidate_emergency_reductions WHERE idempotency_key=${reductionKey}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${reductionId}`);
  const before = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal(await createEth420CandidateLiveOrder({
    id: reductionId, ticker: `${ticker}-EMERGENCY`, easternDate: date, side: "yes", step: 0,
    requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500,
    stateBeforeJson: JSON.stringify(canonicalFenceState(date)),
  }), true);
  assert.equal(await acknowledgeEth420CandidateLiveOrder(reductionId, "candidate-emergency-order", "submitted"), true);
  await db.execute(sql`UPDATE eth420_candidate_live_orders SET filled_contracts=10 WHERE id=${reductionId}`);
  assert.equal((await reserveEth420CandidateEmergencyReduction({
    idempotencyKey: "eth420-emergency-reduction-test-key-oversize", candidateOrderId: reductionId,
    ticker: `${ticker}-EMERGENCY`, candidateKalshiOrderId: "candidate-emergency-order", heldSide: "yes", requestedContracts: 11,
    clientOrderId: "eth420-reduce:eth420-emergency-reduction-test-key-oversize", operatorReason: "oversize fixture reason", confirmation: "REDUCE_ETH420_CANDIDATE_POSITION",
    expectedExitSide: "ask",
    submittedLimitPriceCents: 50, exchangeIndex: 0,
  })).kind, "blocked");
  const rejectedCommandDate = "1970-01-20";
  await clearFenceDate(rejectedCommandDate);
  const rejectedCommandState = canonicalFenceState(rejectedCommandDate);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches({
    ...fenceOrder(rejectedCommandDate, "200000-00-REJECTED-EMERGENCY", rejectedCommandState),
  }), true, "a rejected emergency reservation does not delay or deny ordinary entry");
  await clearFenceDate(rejectedCommandDate);
  const reserved = await reserveEth420CandidateEmergencyReduction({
    idempotencyKey: reductionKey, candidateOrderId: reductionId, ticker: `${ticker}-EMERGENCY`,
    candidateKalshiOrderId: "candidate-emergency-order", heldSide: "yes", requestedContracts: 10,
    clientOrderId: `eth420-reduce:${reductionKey}`, operatorReason: "durable lost acknowledgement fixture", confirmation: "REDUCE_ETH420_CANDIDATE_POSITION",
    expectedExitSide: "ask",
    submittedLimitPriceCents: 50, exchangeIndex: 0,
  });
  assert.equal(reserved.kind, "reserved");
  assert.equal(await hasUnresolvedEth420CandidateEmergencyReduction(reductionId), true);
  const nextDate = "1970-01-21";
  const nextState = canonicalFenceState(nextDate);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches({
    id: `${ticker}-NEXT-DAY-BLOCK:eth420-live-v1`, ticker: `${ticker}-NEXT-DAY-BLOCK`, easternDate: nextDate,
    side: "no", step: 0, requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500,
    stateBeforeJson: JSON.stringify(nextState), expectedState: nextState,
  }), false, "an emergency reduction blocks entries across Eastern-day boundaries");
  const duplicate = await reserveEth420CandidateEmergencyReduction({
    idempotencyKey: reductionKey, candidateOrderId: "wrong", ticker: "wrong", candidateKalshiOrderId: "wrong",
    heldSide: "no", requestedContracts: 1, clientOrderId: `eth420-reduce:${reductionKey}`,
    operatorReason: "durable lost acknowledgement fixture", confirmation: "REDUCE_ETH420_CANDIDATE_POSITION",
    expectedExitSide: "bid",
    submittedLimitPriceCents: 50, exchangeIndex: 0,
  });
  assert.equal(duplicate.kind, "existing");
  const distinctKey = "eth420-emergency-reduction-test-key-0002";
  await db.execute(sql`DELETE FROM eth420_candidate_emergency_reductions WHERE idempotency_key=${distinctKey}`);
  const competing = await reserveEth420CandidateEmergencyReduction({
    idempotencyKey: distinctKey, candidateOrderId: reductionId, ticker: `${ticker}-EMERGENCY`,
    candidateKalshiOrderId: "candidate-emergency-order", heldSide: "yes", requestedContracts: 10,
    clientOrderId: `eth420-reduce:${distinctKey}`, operatorReason: "competing idempotency fixture", confirmation: "REDUCE_ETH420_CANDIDATE_POSITION",
    expectedExitSide: "ask", submittedLimitPriceCents: 50, exchangeIndex: 0,
  });
  assert.equal(competing.kind, "blocked", "a second idempotency key cannot create another exit lifecycle");
  const after = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal((before as any).rows[0]?.bytes, (after as any).rows[0]?.bytes);
  await db.execute(sql`DELETE FROM eth420_candidate_emergency_reductions WHERE idempotency_key IN (${reductionKey}, ${distinctKey}, ${"eth420-emergency-reduction-test-key-oversize"})`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${reductionId}`);
  _setEth420CandidateEmergencyFenceForTesting(false);
});

test("a dormant emergency subsystem adds no candidate-entry storage dependency", async () => {
  const dormantDate = "1970-01-22";
  await clearFenceDate(dormantDate);
  _setEth420CandidateEmergencyFenceForTesting(false);
  const state = canonicalFenceState(dormantDate);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches({
    ...fenceOrder(dormantDate, "220000-00-DORMANT-ENTRY", state),
  }), true, "normal entry remains available after an unavailable/rejected emergency command");
  await clearFenceDate(dormantDate);
});

test("execution telemetry is scalar-only, idempotent, and retention never touches candidate orders", async () => {
  const oldSnapshotId = `${id}:execution:0`;
  const freshSnapshotId = `${id}:execution:1000`;
  const before = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  for (const snapshot of [
    { snapshotId: oldSnapshotId, offset: 0, observedAtMs: 1 },
    { snapshotId: freshSnapshotId, offset: 1_000, observedAtMs: Date.now() },
  ]) {
    assert.equal(await recordEth420CandidateExecutionSnapshot({
      snapshotId: snapshot.snapshotId, candidateOrderId: id, ticker, scheduledOffsetMs: snapshot.offset,
      scheduledAtMs: snapshot.observedAtMs, observedAtMs: snapshot.observedAtMs, selectedSide: "no",
      requestedContracts: 30, kalshiOrderId: null, orderStatus: "unavailable", filledContracts: null,
      selectedBestBidCents: null, selectedBestAskCents: 50, depthAt50Contracts: 30,
      fullSizeExecutablePriceCents: 50, quoteAgeMs: null, quoteFreshness: "unavailable", observationState: "captured",
    }), true);
  }
  assert.equal(await recordEth420CandidateExecutionSnapshot({
    snapshotId: oldSnapshotId, candidateOrderId: id, ticker, scheduledOffsetMs: 0, scheduledAtMs: 1, observedAtMs: 1,
    selectedSide: "no", requestedContracts: 30, kalshiOrderId: null, orderStatus: "unavailable", filledContracts: null,
    selectedBestBidCents: null, selectedBestAskCents: null, depthAt50Contracts: null, fullSizeExecutablePriceCents: null,
    quoteAgeMs: null, quoteFreshness: "unavailable", observationState: "captured",
  }), false);
  assert.equal(await pruneEth420CandidateExecutionSnapshots(Date.now() - 1_000), 1);
  const rows = await db.execute(sql`SELECT snapshot_id FROM eth420_candidate_execution_snapshots WHERE candidate_order_id=${id}`);
  assert.deepEqual((rows as any).rows, [{ snapshot_id: freshSnapshotId }]);
  const after = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal((before as any).rows[0].bytes, (after as any).rows[0].bytes);
  await db.execute(sql`DELETE FROM eth420_candidate_execution_snapshots WHERE candidate_order_id=${id}`);
});

test("secondary-entry telemetry has a durable one-attempt fence and never mutates candidate state", async () => {
  const secondaryId = `${ticker}-SECONDARY-ATTEMPT:eth420-live-v1`;
  const secondaryTicker = `${ticker}-SECONDARY-ATTEMPT`;
  const secondaryDate = "1970-01-17";
  await db.execute(sql`DELETE FROM eth420_candidate_telemetry WHERE id LIKE ${secondaryId + ":secondary-entry:%"}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${secondaryId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${secondaryDate}`);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${secondaryDate}, 'no', 4, -12345, NULL, 1)`);
  assert.equal(await createEth420CandidateLiveOrder({
    id: secondaryId, ticker: secondaryTicker, easternDate: secondaryDate, side: "no", step: 4,
    requestedContracts: 840, limitPriceCents: 50, effectiveWagerCents: 42000,
    stateBeforeJson: JSON.stringify({ easternDate: secondaryDate, side: "no", step: 4, realizedPnlCents: -12345, lastBlockResetAtMs: null }),
  }), true);
  assert.equal(await acknowledgeEth420CandidateLiveOrder(secondaryId, "primary-secondary-audit", "submitted"), true);
  assert.equal(await claimEth420CandidateSecondaryEntryAttempt({
    candidateOrderId: secondaryId, attemptedAtMs: 100, reservationAskCents: 55,
  }), true);
  assert.equal(await claimEth420CandidateSecondaryEntryAttempt({
    candidateOrderId: secondaryId, attemptedAtMs: 101, reservationAskCents: 55,
  }), false);
  assert.equal(await recordEth420CandidateSecondaryEntryEvent({
    candidateOrderId: secondaryId, atMs: 100, event: "cancel_confirmed", reason: null,
    reservationAskCents: 55, currentAskCents: 54,
    primaryOrderId: "primary-secondary-audit", secondaryClientOrderId: `${secondaryId}:secondary-v1`,
  }), true);
  assert.equal(await markEth420CandidateSecondarySubmissionPending(
    secondaryId, "primary-secondary-audit", `${secondaryId}:secondary-v1`,
  ), true);
  assert.deepEqual(await getEth420CandidateState(secondaryDate), {
    easternDate: secondaryDate, side: "no", step: 4, realizedPnlCents: -12345, lastBlockResetAtMs: null,
  });
  const telemetry = await db.execute(sql`SELECT id, payload_json FROM eth420_candidate_telemetry
    WHERE id LIKE ${secondaryId + ":secondary-entry:%"} ORDER BY id`);
  assert.equal((telemetry as any).rows.length, 2);
  assert.match((telemetry as any).rows[1].payload_json, /cancel_confirmed/);
  assert.match((telemetry as any).rows[1].payload_json, /primary-secondary-audit/);
  const pending = await getEth420CandidateLiveOrder(secondaryId);
  assert.equal(pending?.status, "secondary_submission_pending");
  assert.equal(pending?.secondaryClientOrderId, `${secondaryId}:secondary-v1`);
  assert.ok(pending?.primaryCancelConfirmedAtMs != null);
  assert.ok(pending?.secondarySubmissionStartedAtMs != null);
  await db.execute(sql`DELETE FROM eth420_candidate_telemetry WHERE id LIKE ${secondaryId + ":secondary-entry:%"}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${secondaryId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${secondaryDate}`);
});

test("restart recovery binds a lost secondary acknowledgement by its deterministic client ID", async () => {
  const recoveryId = `${ticker}-SECONDARY-RECOVERY:eth420-live-v1`;
  const recoveryTicker = `${ticker}-SECONDARY-RECOVERY`;
  const recoveryDay = "1970-01-18";
  const primaryOrderId = "secondary-recovery-primary";
  const secondaryOrderId = "secondary-recovery-exchange";
  const secondaryClientOrderId = `${recoveryId}:secondary-v1`;
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${recoveryId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${recoveryDay}`);
  assert.equal(await createEth420CandidateLiveOrder({
    id: recoveryId, ticker: recoveryTicker, easternDate: recoveryDay, side: "yes", step: 0,
    requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500,
    stateBeforeJson: JSON.stringify({
      easternDate: recoveryDay, side: "yes", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null,
    }),
  }), true);
  assert.equal(await acknowledgeEth420CandidateLiveOrder(recoveryId, primaryOrderId, "submitted"), true);
  assert.equal(await markEth420CandidateSecondarySubmissionPending(recoveryId, primaryOrderId, secondaryClientOrderId), true);
  const afterRestart = await getEth420CandidateLiveOrder(recoveryId);
  assert.equal(afterRestart?.status, "secondary_submission_pending");
  assert.equal(afterRestart?.secondaryClientOrderId, secondaryClientOrderId);
  let scannedSecondary = false;
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path.includes("status=resting")) return { orders: [] } as T;
    if (path.includes("status=canceled")) {
      scannedSecondary = true;
      return { orders: [
        { order_id: "primary-decoy", client_order_id: recoveryId, ticker: recoveryTicker, status: "executed", fill_count_fp: "30.00" },
        { order_id: secondaryOrderId, client_order_id: secondaryClientOrderId, ticker: recoveryTicker, status: "executed", fill_count_fp: "30.00" },
      ] } as T;
    }
    if (path.includes(`/portfolio/fills?order_id=${secondaryOrderId}`)) {
      return { fills: [{ fill_id: "secondary-recovery-fill", order_id: secondaryOrderId, ticker: recoveryTicker,
        count_fp: "30.00", yes_price_dollars: "0.5500", fee_cost_dollars: "0.1500" }] } as T;
    }
    throw new Error(`unexpected secondary recovery path: ${path}`);
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      ...afterRestart!, side: "yes",
    }, "yes"), true);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  assert.equal(scannedSecondary, true);
  const recovered = await getEth420CandidateLiveOrder(recoveryId);
  assert.equal(recovered?.status, "settled");
  assert.equal(recovered?.kalshiOrderId, secondaryOrderId);
  assert.equal(recovered?.originalPrimaryKalshiOrderId, primaryOrderId);
  assert.ok(recovered?.secondaryBoundAtMs != null);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${recoveryId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${recoveryDay}`);
});

test("candidate operator reset preserves side and P&L, audits once, and refuses unresolved lifecycle", async () => {
  const resetDate = "1970-01-14";
  const resetOrderId = `${ticker}-RESET-BLOCK:eth420-live-v1`;
  await db.execute(sql`DELETE FROM eth420_candidate_step_reset_audits WHERE eastern_date=${resetDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${resetDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${resetDate}`);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${resetDate}, 'no', 5, -28798, 1234, 1)`);
  await db.execute(sql`INSERT INTO eth420_candidate_live_orders
    (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
     effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
    VALUES (${resetOrderId}, ${`${ticker}-RESET-BLOCK`}, ${resetDate}, 'no', 5, 640, 50, 32000,
      '{}', 'reserved', 1, 1)`);
  assert.deepEqual(await resetEth420CandidateStepToZero(resetDate), { kind: "unresolved_lifecycle" });
  await db.execute(sql`UPDATE eth420_candidate_live_orders SET status='rejected_insufficient_balance'
    WHERE id=${resetOrderId}`);
  const legacyBefore = await db.execute(sql`
    SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  const reset = await resetEth420CandidateStepToZero(resetDate);
  assert.equal(reset.kind, "applied");
  if (reset.kind !== "applied") throw new Error("expected applied candidate reset");
  assert.deepEqual(reset.before, {
    easternDate: resetDate, side: "no", step: 5, realizedPnlCents: -28798, lastBlockResetAtMs: 1234,
  });
  assert.deepEqual(reset.after, {
    easternDate: resetDate, side: "no", step: 0, realizedPnlCents: -28798, lastBlockResetAtMs: 1234,
  });
  assert.deepEqual(await getEth420CandidateState(resetDate), reset.after);
  assert.equal((await db.execute(sql`SELECT COUNT(*)::int AS count FROM eth420_candidate_step_reset_audits
    WHERE eastern_date=${resetDate}`) as any).rows[0].count, 1);
  const audit = await db.execute(sql`
    SELECT prior_side, prior_step, prior_realized_pnl_cents, prior_last_block_reset_at_ms,
      next_side, next_step, next_realized_pnl_cents, next_last_block_reset_at_ms
    FROM eth420_candidate_step_reset_audits WHERE reset_id=${reset.resetId}`);
  assert.deepEqual((audit as any).rows[0], {
    prior_side: "no", prior_step: 5, prior_realized_pnl_cents: -28798, prior_last_block_reset_at_ms: "1234",
    next_side: "no", next_step: 0, next_realized_pnl_cents: -28798, next_last_block_reset_at_ms: "1234",
  });
  const legacyAfter = await db.execute(sql`
    SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal((legacyBefore as any).rows[0]?.bytes, (legacyAfter as any).rows[0]?.bytes);
  const repeated = await resetEth420CandidateStepToZero(resetDate);
  assert.deepEqual(repeated, { kind: "already_at_step_zero", before: reset.after, after: reset.after });
  assert.equal((await db.execute(sql`SELECT COUNT(*)::int AS count FROM eth420_candidate_step_reset_audits
    WHERE eastern_date=${resetDate}`) as any).rows[0].count, 1);
  await db.execute(sql`DELETE FROM eth420_candidate_step_reset_audits WHERE eastern_date=${resetDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${resetDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${resetDate}`);
});

test("authoritative candidate insufficient-balance rejections preserve the same NO step without a settlement blocker", async () => {
  const rejectionDate = "1970-01-15";
  const state = {
    easternDate: rejectionDate, side: "no" as const, step: 5, realizedPnlCents: -28798, lastBlockResetAtMs: null,
  };
  const acknowledgements: Array<{ id: string; status: string; reason?: string }> = [];
  const reservations: Array<{ id: string; expectedState: unknown }> = [];
  const store = {
    getEth420CandidateState: async () => state,
    listEth420CandidateTelemetry: async () => [],
    getEth420CandidateLiveOrder: async () => null,
    listRecentUnsettledEth420CandidateLiveOrders: async () => [],
    recordEth420CandidateExecutionSnapshot: async () => true,
    reserveEth420CandidateLiveOrderIfStateMatches: async (params: { id: string; expectedState: unknown }) => {
      reservations.push(params); return true;
    },
    acknowledgeEth420CandidateLiveOrder: async (id: string, _orderId: string | null, status: string, reason?: string) => {
      acknowledgements.push({ id, status, reason }); return true;
    },
  } as any;
  const market = {
    ticker: "KXETH15M-70JAN150000-00-BALANCE-REJECTION", exchangeIndex: 2,
    openTime: null, closeTime: null, status: "open", yesBid: null, noBid: null,
  };
  const candidateMarket = {
    ticker: market.ticker, easternDate: rejectionDate, observedAtMs: 1_000,
    floorStrike: 1000, openTimeMs: 0,
  };
  const priorLive = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
  _setEth420CandidateBalanceReadForTesting((async () => ({ value: { balance: 48_000 }, stale: false })) as any);
  _setEth420CandidateAuthFetchForTesting((async () => {
    throw Object.assign(new Error("Kalshi rejected"), {
      status: 400, body: { error: { code: "insufficient_balance" } },
    });
  }) as any);
  try {
    assert.equal(await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(store, market, candidateMarket), false);
    assert.equal(await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(store, {
      ...market, ticker: "KXETH15M-70JAN150015-15-BALANCE-REJECTION",
    }, { ...candidateMarket, ticker: "KXETH15M-70JAN150015-15-BALANCE-REJECTION" }), false);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
    _setEth420CandidateBalanceReadForTesting(null);
    if (priorLive == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
    else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = priorLive;
  }
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every(({ expectedState }) => expectedState === state), "each rejection carries the same sequence forward");
  assert.deepEqual(acknowledgements.map(({ status, reason }) => ({ status, reason })), [
    { status: "rejected_insufficient_balance", reason: "insufficient_balance" },
    { status: "rejected_insufficient_balance", reason: "insufficient_balance" },
  ]);
  assert.equal(acknowledgements.some(({ status }) => status === "submission_unknown_recovery_required"), false);
  assert.deepEqual(state, {
    easternDate: rejectionDate, side: "no", step: 5, realizedPnlCents: -28798, lastBlockResetAtMs: null,
  });
});

test("only a structured insufficient-balance rejection can bypass candidate reconciliation", () => {
  assert.equal(confirmedEth420InsufficientBalanceRejectionReason({
    status: 400, body: { error: { code: "insufficient_balance" } },
  }), "insufficient_balance");
  assert.equal(confirmedEth420InsufficientBalanceRejectionReason({
    status: 400, body: { error: { code: "insufficient_balance", filled_contracts: 1 } },
  }), null);
  assert.equal(confirmedEth420InsufficientBalanceRejectionReason({
    status: 500, body: { error: { code: "insufficient_balance" } },
  }), null);
  assert.equal(confirmedEth420InsufficientBalanceRejectionReason({
    status: 400, body: { error: { code: "order_rejected" } },
  }), null);
  assert.equal(confirmedEth420InsufficientBalanceRejectionReason({
    status: 400, body: "proxy response",
  }), null);
});

test("durable zero-exposure balance rejection preserves candidate state and leaves no settlement blocker", async () => {
  const rejectionDate = "1970-01-16";
  const rejectionId = `${ticker}-DURABLE-BALANCE-REJECTION:eth420-live-v1`;
  const state = {
    easternDate: rejectionDate, side: "no" as const, step: 5, realizedPnlCents: -28798, lastBlockResetAtMs: null,
  };
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${rejectionId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${rejectionDate}`);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${rejectionDate}, 'no', 5, -28798, NULL, 1)`);
  assert.equal(await createEth420CandidateLiveOrder({
    id: rejectionId, ticker: `${ticker}-DURABLE-BALANCE-REJECTION`, easternDate: rejectionDate,
    side: "no", step: 5, requestedContracts: 640, limitPriceCents: 50, effectiveWagerCents: 32000,
    stateBeforeJson: JSON.stringify(state),
  }), true);
  assert.equal(await acknowledgeEth420CandidateLiveOrder(
    rejectionId, null, "rejected_insufficient_balance", "insufficient_balance",
  ), true);
  const rejected = await getEth420CandidateLiveOrder(rejectionId);
  assert.equal(rejected?.status, "rejected_insufficient_balance");
  assert.equal(rejected?.filledContracts, 0);
  assert.equal(rejected?.rejectionReason, "insufficient_balance");
  assert.ok(rejected?.rejectionConfirmedAtMs != null);
  assert.deepEqual(await getEth420CandidateState(rejectionDate), state);
  assert.equal((await listPendingEth420CandidateLiveOrders()).some((order) => order.id === rejectionId), false);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${rejectionId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${rejectionDate}`);
});

test("candidate recovery queue includes unknown submissions without touching legacy state", async () => {
  const unknownId = `${ticker}-UNKNOWN:eth420-live-v1`;
  const terminalId = `${ticker}-TERMINAL:eth420-live-v1`;
  const restingId = `${ticker}-RESTING-SELECTOR:eth420-live-v1`;
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id IN (${unknownId}, ${terminalId}, ${restingId})`);
  const before = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  await db.execute(sql`INSERT INTO eth420_candidate_live_orders
    (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
     effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
    VALUES (${unknownId}, ${`${ticker}-UNKNOWN`}, ${date}, 'yes', 0, 30, 50, 1500, '{}',
      'submission_unknown_recovery_required', 2, 2)`);
  for (const [candidateId, candidateTicker, status, orderId] of [
    [terminalId, `${ticker}-TERMINAL`, "terminal_recovered", "terminal-order"],
    [restingId, `${ticker}-RESTING-SELECTOR`, "resting_recovered", "resting-order"],
  ]) {
    await db.execute(sql`INSERT INTO eth420_candidate_live_orders
      (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
       effective_wager_cents, state_before_json, kalshi_order_id, status, created_at_ms, updated_at_ms)
      VALUES (${candidateId}, ${candidateTicker}, ${date}, 'yes', 0, 30, 50, 1500, '{}',
        ${orderId}, ${status}, 2, 2)`);
  }
  const { listPendingEth420CandidateLiveOrders } = await import("./tradeStore.js");
  const pending = await listPendingEth420CandidateLiveOrders();
  assert.ok(pending.some((row) => row.id === unknownId && row.kalshiOrderId === null));
  assert.ok(pending.some((row) => row.id === terminalId && row.status === "terminal_recovered"));
  assert.ok(pending.some((row) => row.id === restingId && row.status === "resting_recovered"));
  const after = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal((before as any).rows[0].bytes, (after as any).rows[0].bytes);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id IN (${unknownId}, ${terminalId}, ${restingId})`);
});

test("candidate history recovery keeps its exact resting GTC eligible for a later terminal sweep", async () => {
  const restingId = `${ticker}-RESTING:eth420-live-v1`;
  const restingTicker = `${ticker}-RESTING`;
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${restingId}`);
  const before = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  await db.execute(sql`INSERT INTO eth420_candidate_live_orders
    (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
     effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
    VALUES (${restingId}, ${restingTicker}, ${date}, 'yes', 0, 30, 50, 1500, '{}',
      'submission_unknown_recovery_required', 3, 3)`);
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path.includes("status=resting")) {
      return { orders: [{ order_id: "kalshi-resting-420", client_order_id: restingId, ticker: restingTicker, status: "resting" }] } as T;
    }
    throw new Error(`unexpected candidate recovery path: ${path}`);
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      id: restingId, ticker: restingTicker, easternDate: date, kalshiOrderId: null,
      requestedContracts: 30, limitPriceCents: 50, side: "yes",
    }, "yes"), false);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  const row = await db.execute(sql`SELECT kalshi_order_id, status FROM eth420_candidate_live_orders WHERE id=${restingId}`);
  assert.deepEqual((row as any).rows[0], { kalshi_order_id: "kalshi-resting-420", status: "resting_recovered" });
  const after = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal((before as any).rows[0].bytes, (after as any).rows[0].bytes);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${date}, 'no', 0, 0, NULL, 1)
    ON CONFLICT (eastern_date) DO UPDATE SET side='no', martingale_step=0, realized_pnl_cents=0`);
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path === `/portfolio/orders/${encodeURIComponent("kalshi-resting-420")}`) {
      return { order: { order_id: "kalshi-resting-420", client_order_id: restingId, ticker: restingTicker,
        status: "executed", fill_count_fp: "0.00" } } as T;
    }
    if (path.startsWith("/markets/")) {
      return { market: { ticker: restingTicker, status: "closed", result: "yes", close_time: "1970-01-03T00:00:00.000Z" } } as T;
    }
    if (path.startsWith("/portfolio/fills?")) return { fills: [] } as T;
    if (path.startsWith("/portfolio/positions?")) return { market_positions: [] } as T;
    throw new Error(`unexpected candidate terminal recovery path: ${path}`);
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      id: restingId, ticker: restingTicker, easternDate: date, kalshiOrderId: "kalshi-resting-420",
      requestedContracts: 30, limitPriceCents: 50, side: "yes",
    }, "yes"), true);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  const settledRow = await db.execute(sql`SELECT status FROM eth420_candidate_live_orders WHERE id=${restingId}`);
  assert.deepEqual((settledRow as any).rows[0], { status: "settled" });
  const recovery = await db.execute(sql`SELECT recovery_attempt_count, last_recovery_outcome, last_recovery_error_class
    FROM eth420_candidate_live_orders WHERE id=${restingId}`);
  assert.deepEqual((recovery as any).rows[0], {
    recovery_attempt_count: 2, last_recovery_outcome: "settled", last_recovery_error_class: null,
  });
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${restingId}`);
});

test("terminal-recovered candidate retries incomplete economics instead of being stranded", async () => {
  const retryId = `${ticker}-TERMINAL-RETRY:eth420-live-v1`;
  const retryTicker = `${ticker}-TERMINAL-RETRY`;
  const retryOrderId = "terminal-retry-order";
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${recoveryDate}, 'no', 0, 0, NULL, 1)`);
  await db.execute(sql`INSERT INTO eth420_candidate_live_orders
    (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
     effective_wager_cents, state_before_json, kalshi_order_id, status, created_at_ms, updated_at_ms)
    VALUES (${retryId}, ${retryTicker}, ${recoveryDate}, 'no', 0, 30, 50, 1500,
      ${JSON.stringify({ easternDate: recoveryDate, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null })},
      ${retryOrderId}, 'terminal_recovered', 1, 1)`);
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path.includes(`/portfolio/orders/${retryOrderId}`)) {
      return { order: { order_id: retryOrderId, client_order_id: retryId, ticker: retryTicker, status: "executed", fill_count_fp: "30.00" } } as T;
    }
    if (path.startsWith("/portfolio/fills?")) return { fills: [] } as T;
    throw new Error(`unexpected terminal retry path: ${path}`);
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      id: retryId, ticker: retryTicker, easternDate: recoveryDate, kalshiOrderId: retryOrderId,
      requestedContracts: 30, limitPriceCents: 50, side: "no", step: 0,
      stateBeforeJson: JSON.stringify({ easternDate: recoveryDate, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null }),
    }, "no"), false);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  let retry = await db.execute(sql`SELECT status, recovery_attempt_count, last_recovery_outcome
    FROM eth420_candidate_live_orders WHERE id=${retryId}`);
  assert.deepEqual((retry as any).rows[0], {
    status: "terminal_recovered", recovery_attempt_count: 1, last_recovery_outcome: "economics_incomplete",
  });
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path.includes(`/portfolio/orders/${retryOrderId}`)) {
      return { order: { order_id: retryOrderId, client_order_id: retryId, ticker: retryTicker, status: "executed", fill_count_fp: "30.00" } } as T;
    }
    if (path.includes(`/portfolio/fills?order_id=${retryOrderId}`)) {
      return { fills: [{ fill_id: "terminal-retry-fill", order_id: retryOrderId, ticker: retryTicker,
        count_fp: "30.00", no_price_dollars: "0.5000", fee_cost_dollars: "0.2500" }] } as T;
    }
    throw new Error(`unexpected completed terminal retry path: ${path}`);
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      id: retryId, ticker: retryTicker, easternDate: recoveryDate, kalshiOrderId: retryOrderId,
      requestedContracts: 30, limitPriceCents: 50, side: "no", step: 0,
      stateBeforeJson: JSON.stringify({ easternDate: recoveryDate, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null }),
    }, "no"), true);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  retry = await db.execute(sql`SELECT status, recovery_attempt_count, last_recovery_outcome
    FROM eth420_candidate_live_orders WHERE id=${retryId}`);
  assert.deepEqual((retry as any).rows[0], {
    status: "settled", recovery_attempt_count: 2, last_recovery_outcome: "settled",
  });
});

test("bound candidate recovery uses authenticated order detail and keeps every identity/read failure fail-closed", async () => {
  const detailId = "candidate-detail-route:eth420-live-v1";
  const detailTicker = "KXETH15M-70JAN050045-45-DETAIL";
  const detailOrderId = "detail-order-420";
  const baseOrder = {
    id: detailId, ticker: detailTicker, easternDate: recoveryDate, kalshiOrderId: detailOrderId,
    requestedContracts: 30, limitPriceCents: 50, side: "no" as const, step: 0,
    stateBeforeJson: JSON.stringify({ easternDate: recoveryDate, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null }),
  };
  for (const scenario of [
    { name: "exact", mutate: {} as Record<string, unknown>, expected: true, outcome: "settled" },
    { name: "order-id mismatch", mutate: { order_id: "wrong-order" }, expected: false, outcome: "exchange_evidence_ambiguous" },
    { name: "client-id mismatch", mutate: { client_order_id: "wrong-client" }, expected: false, outcome: "exchange_evidence_ambiguous" },
    { name: "ticker mismatch", mutate: { ticker: "wrong-ticker" }, expected: false, outcome: "exchange_evidence_ambiguous" },
    { name: "404", mutate: null, expected: false, outcome: "exchange_evidence_ambiguous" },
  ]) {
    const paths: string[] = [], outcomes: string[] = [];
    const store = {
      readPersistedEth420CandidateState: async () => ({ available: true, state: {
        easternDate: recoveryDate, side: "no" as const, step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null,
      } }),
      settleEth420CandidateLiveOrder: async () => true,
      recordEth420CandidateRecoveryOutcome: async ({ outcome }: { outcome: string }) => { outcomes.push(outcome); return true; },
    } as any;
    _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
      paths.push(path);
      if (path.startsWith("/portfolio/events/orders/")) throw new Error("deprecated event-order read must never be used");
      if (path === `/portfolio/orders/${detailOrderId}`) {
        if (scenario.mutate == null) throw Object.assign(new Error("not found"), { name: "KalshiHttp404" });
        return { order: { order_id: detailOrderId, client_order_id: detailId, ticker: detailTicker,
          status: "executed", fill_count_fp: "30.00", ...scenario.mutate } } as T;
      }
      if (path.startsWith(`/portfolio/fills?order_id=${detailOrderId}`)) {
        return { fills: [{ fill_id: "detail-fill", order_id: detailOrderId, ticker: detailTicker,
          count_fp: "30.00", no_price_dollars: "0.5000", fee_cost_dollars: "0.2500" }] } as T;
      }
      throw new Error(`unexpected detail lookup path: ${path}`);
    }) as any);
    try {
      assert.equal(await recoverAndSettleEth420CandidateLiveOrder(store, baseOrder, "no"), scenario.expected, scenario.name);
    } finally {
      _setEth420CandidateAuthFetchForTesting(null);
    }
    assert.ok(paths.includes(`/portfolio/orders/${detailOrderId}`), `${scenario.name}: current detail endpoint used`);
    assert.ok(!paths.some((path) => path.startsWith("/portfolio/events/orders/")), `${scenario.name}: deprecated path unused`);
    assert.deepEqual(outcomes, [scenario.outcome], scenario.name);
  }
});

test("bound candidate recovery falls back to exact terminal history after an archived detail 404", async () => {
  const detailId = "candidate-detail-404-history:eth420-live-v1";
  const detailTicker = "KXETH15M-70JAN050100-00-DETAIL";
  const detailOrderId = "detail-history-order-420";
  const paths: string[] = [];
  const settlements: unknown[] = [];
  const store = {
    readPersistedEth420CandidateState: async () => ({ available: true, state: canonicalFenceState(recoveryDate) }),
    settleEth420CandidateLiveOrder: async (params: unknown) => { settlements.push(params); return true; },
    recordEth420CandidateRecoveryOutcome: async () => true,
  } as any;
  _setEth420CandidateAuthFetchForTesting((async <T>(method: string, path: string): Promise<T> => {
    paths.push(`${method} ${path}`);
    if (path === `/portfolio/orders/${detailOrderId}`) {
      throw Object.assign(new Error("archived"), { status: 404, name: "KalshiHttp404" });
    }
    if (path.startsWith("/portfolio/orders?")) {
      const status = new URL(`https://test.invalid${path}`).searchParams.get("status");
      return {
        orders: status === "executed"
          ? [{ order_id: detailOrderId, client_order_id: detailId, ticker: detailTicker, status: "executed", fill_count_fp: "30.00" }]
          : [],
      } as T;
    }
    if (path.startsWith(`/portfolio/fills?order_id=${detailOrderId}`)) {
      return { fills: [{ fill_id: "history-detail-fill", order_id: detailOrderId, ticker: detailTicker,
        count_fp: "30.00", no_price_dollars: "0.5000", fee_cost_dollars: "0.2500" }] } as T;
    }
    throw new Error(`unexpected history fallback path: ${path}`);
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(store, {
      id: detailId, ticker: detailTicker, easternDate: recoveryDate, kalshiOrderId: detailOrderId,
      requestedContracts: 30, limitPriceCents: 50, side: "no", step: 0,
      stateBeforeJson: JSON.stringify(canonicalFenceState(recoveryDate)),
    }, "no"), true);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  assert.equal(settlements.length, 1);
  assert.ok(paths.includes(`GET /portfolio/orders/${detailOrderId}`));
  assert.ok(paths.some((path) => path.includes("GET /portfolio/orders?") && path.includes("status=executed")));
  assert.ok(paths.includes(`GET /portfolio/fills?order_id=${detailOrderId}&limit=100`));
  assert.ok(paths.every((path) => path.startsWith("GET ")), "fallback never mutates the exchange");
});

test("complete history absence releases unknown candidate reservation; incomplete lookup does not", async () => {
  const absentId = `${ticker}-ABSENT:eth420-live-v1`;
  const reservedId = `${ticker}-INCOMPLETE:eth420-live-v1`;
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id IN (${absentId}, ${reservedId})`);
  for (const [candidateId, candidateTicker, status] of [
    [absentId, `${ticker}-ABSENT`, "submission_unknown_recovery_required"],
    [reservedId, `${ticker}-INCOMPLETE`, "submission_unknown_recovery_required"],
  ]) {
    await db.execute(sql`INSERT INTO eth420_candidate_live_orders
      (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
       effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
      VALUES (${candidateId}, ${candidateTicker}, ${date}, 'yes', 0, 30, 50, 1500, '{}',
        ${status}, 4, 4)`);
  }
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    return (path.startsWith("/portfolio/orders?") ? { orders: [] } : { fills: [] }) as T;
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      id: absentId, ticker: `${ticker}-ABSENT`, easternDate: date, kalshiOrderId: null,
      requestedContracts: 30, limitPriceCents: 50, side: "yes",
    }, "yes"), false);
    _setEth420CandidateAuthFetchForTesting((async (): Promise<never> => {
      throw new Error("history transport error");
    }) as any);
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      id: reservedId, ticker: `${ticker}-INCOMPLETE`, easternDate: date, kalshiOrderId: null,
      requestedContracts: 30, limitPriceCents: 50, side: "yes",
    }, "yes"), false);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  const rows = await db.execute(sql`SELECT id FROM eth420_candidate_live_orders WHERE id IN (${absentId}, ${reservedId})`);
  assert.deepEqual((rows as any).rows, [{ id: reservedId }]);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${reservedId}`);
});

test("candidate ledger rejects nonzero settlement without authenticated fee economics", async () => {
  const economicsId = `${ticker}-NO-FEE:eth420-live-v1`;
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${economicsId}`);
  assert.equal(await createEth420CandidateLiveOrder({
    id: economicsId, ticker: `${ticker}-NO-FEE`, easternDate: date, side: "yes", step: 0,
    requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500, stateBeforeJson: "{}",
  }), true);
  assert.equal(await settleEth420CandidateLiveOrder({
    id: economicsId, result: "yes", filledContracts: 30, realizedPnlDeltaCents: 1500,
    nextState: { easternDate: date, side: "no", step: 1, realizedPnlCents: 1500, lastBlockResetAtMs: null },
    actualNotionalDollars: "15", actualFeeDollars: null, fillPriceCents: 50,
  }), false);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${economicsId}`);
});

test("candidate reconciliation atomically persists an authenticated decimal partial fill", async () => {
  const partialDate = "1970-01-19";
  const partialTicker = `${ticker}-DECIMAL-PARTIAL`;
  const partialId = `${partialTicker}:eth420-live-v1`;
  const partialOrderId = "decimal-partial-order-420";
  const initialState = {
    easternDate: partialDate, side: "no" as const, step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null,
  };
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${partialId}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${partialDate}`);
  try {
    assert.equal(await createEth420CandidateLiveOrder({
      id: partialId, ticker: partialTicker, easternDate: partialDate, side: "no", step: 0,
      requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500,
      stateBeforeJson: JSON.stringify(initialState),
    }), true);
    assert.equal(await acknowledgeEth420CandidateLiveOrder(partialId, partialOrderId, "submitted"), true);
    const pending = await getEth420CandidateLiveOrder(partialId);
    _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
      if (path === `/portfolio/orders/${partialOrderId}`) {
        return { order: {
          order_id: partialOrderId, client_order_id: partialId, ticker: partialTicker,
          status: "canceled", initial_count_fp: "30.00", fill_count_fp: "19.32", remaining_count_fp: "0.00",
        } } as T;
      }
      if (path.startsWith(`/portfolio/fills?order_id=${partialOrderId}`)) {
        return { fills: [{
          fill_id: "decimal-partial-fill-420", order_id: partialOrderId, ticker: partialTicker,
          count_fp: "19.32", no_price_dollars: "0.5000", fee_cost_dollars: "0.1000",
        }] } as T;
      }
      throw new Error(`unexpected decimal partial recovery path: ${path}`);
    }) as any);
    assert.ok(pending);
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, pending!, "yes"), true);
    const settled = await getEth420CandidateLiveOrder(partialId);
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.filledContracts, 19.32);
    const raw = await db.execute(sql`SELECT requested_contracts::text, filled_contracts::text
      FROM eth420_candidate_live_orders WHERE id=${partialId}`);
    assert.deepEqual((raw as any).rows, [{ requested_contracts: "30", filled_contracts: "19.32" }]);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
    await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE id=${partialId}`);
    await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${partialDate}`);
  }
});

test("candidate lifecycle sweep settles submitted rows and recovers unknown rows without evaluating entries", async () => {
  const submittedId = `${ticker}-SWEEP-SUBMITTED:eth420-live-v1`;
  const unknownId = `${ticker}-SWEEP-UNKNOWN:eth420-live-v1`;
  const reservedId = `${ticker}-SWEEP-RESERVED:eth420-live-v1`;
  const submittedTicker = `${ticker}-SWEEP-SUBMITTED`;
  const unknownTicker = `${ticker}-SWEEP-UNKNOWN`;
  const marketRequests: string[] = [];
  const settled: string[] = [];
  const released: string[] = [];
  const store: any = {
    listPendingEth420CandidateLiveOrders: async () => [
      { id: submittedId, ticker: submittedTicker, easternDate: date, kalshiOrderId: "sweep-order-420",
        requestedContracts: 30, limitPriceCents: 50, side: "no", status: "submitted" },
      { id: unknownId, ticker: unknownTicker, easternDate: date, kalshiOrderId: null,
        requestedContracts: 30, limitPriceCents: 50, side: "yes", status: "submission_unknown_recovery_required" },
      { id: reservedId, ticker: `${ticker}-SWEEP-RESERVED`, easternDate: date, kalshiOrderId: null,
        requestedContracts: 30, limitPriceCents: 50, side: "yes", status: "reserved" },
    ],
    getEth420CandidateState: async () => ({
      easternDate: date, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null,
    }),
    readPersistedEth420CandidateState: async () => ({
      available: true, state: { easternDate: date, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null },
    }),
    acknowledgeEth420CandidateLiveOrder: async () => true,
    releaseEth420CandidateProvenAbsentSubmission: async (id: string) => { released.push(id); return true; },
    settleEth420CandidateLiveOrder: async ({ id }: { id: string }) => { settled.push(id); return true; },
  };
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/markets/")) {
      marketRequests.push(path);
      return {
        market: {
          ticker: decodeURIComponent(path.slice("/markets/".length)),
          result: "no", status: "closed", close_time: "1970-01-03T00:00:00.000Z",
        },
      } as T;
    }
    if (path === "/portfolio/orders/sweep-order-420") {
      return { order: { order_id: "sweep-order-420", client_order_id: submittedId,
        ticker: submittedTicker, status: "executed", fill_count_fp: "0.00" } } as T;
    }
    if (path.startsWith("/portfolio/orders?")) return { orders: [] } as T;
    if (path.startsWith("/portfolio/fills?")) return { fills: [] } as T;
    if (path.startsWith("/portfolio/positions?")) return { market_positions: [] } as T;
    throw new Error(`unexpected candidate sweep path: ${path}`);
  }) as any);
  try {
    assert.equal(await reconcileEth420CandidateLiveSettlements(store), 1);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  assert.deepEqual(settled, [submittedId]);
  assert.deepEqual(released, [unknownId]);
  assert.equal(marketRequests.some((path) => path.endsWith(encodeURIComponent(submittedTicker))), true);
  assert.equal(marketRequests.some((path) => path.endsWith(encodeURIComponent(unknownTicker))), true);
  assert.equal(marketRequests.some((path) => path.includes("SWEEP-RESERVED")), false);
});

test("candidate lifecycle sweep rejects nonterminal or mismatched market evidence", async () => {
  const openId = `${ticker}-SWEEP-OPEN:eth420-live-v1`;
  const mismatchedId = `${ticker}-SWEEP-MISMATCHED:eth420-live-v1`;
  const settled: string[] = [];
  const store: any = {
    listPendingEth420CandidateLiveOrders: async () => [
      { id: openId, ticker: `${ticker}-SWEEP-OPEN`, easternDate: date, kalshiOrderId: "open-420",
        requestedContracts: 30, limitPriceCents: 50, side: "no", status: "submitted" },
      { id: mismatchedId, ticker: `${ticker}-SWEEP-MISMATCHED`, easternDate: date, kalshiOrderId: "mismatched-420",
        requestedContracts: 30, limitPriceCents: 50, side: "no", status: "submitted" },
    ],
    settleEth420CandidateLiveOrder: async ({ id }: { id: string }) => { settled.push(id); return true; },
  };
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path.endsWith("SWEEP-OPEN")) {
      return { market: { ticker: `${ticker}-SWEEP-OPEN`, result: "no", status: "open" } } as T;
    }
    if (path.endsWith("SWEEP-MISMATCHED")) {
      return { market: { ticker: "KXETH15M-WRONG", result: "no", status: "settled" } } as T;
    }
    throw new Error(`recovery must not run without valid official market evidence: ${path}`);
  }) as any);
  try {
    assert.equal(await reconcileEth420CandidateLiveSettlements(store), 0);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  assert.deepEqual(settled, []);
});

test("scheduled recovery uses bounded exact-ticker archived evidence and continues after archive failure", async () => {
  const archivedTicker = "KXETH15M-70JAN050000-00-ARCHIVED";
  const missingTicker = "KXETH15M-70JAN050015-15-ARCHIVE-MISSING";
  const directTicker = "KXETH15M-70JAN050030-30-DIRECT";
  const state = { easternDate: "1970-01-05", side: "no" as const, step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null };
  const orders = [archivedTicker, missingTicker, directTicker].map((ticker, i) => ({
    id: `${ticker}:eth420-live-v1`, ticker, easternDate: "1970-01-05", kalshiOrderId: `archive-order-${i}`,
    requestedContracts: 30, limitPriceCents: 50, side: "no" as const, step: 0,
    stateBeforeJson: JSON.stringify(state), status: "submitted",
  }));
  const outcomes: string[] = [];
  let missingArchivePages = 0;
  const store = {
    listPendingEth420CandidateLiveOrders: async () => orders,
    readPersistedEth420CandidateState: async () => ({ available: true, state }),
    settleEth420CandidateLiveOrder: async () => true,
    acknowledgeEth420CandidateLiveOrder: async () => true,
    releaseEth420CandidateProvenAbsentSubmission: async () => true,
    recordEth420CandidateRecoveryOutcome: async ({ id, outcome }: any) => { outcomes.push(`${id}:${outcome}`); return true; },
  } as any;
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/markets/")) {
      const ticker = decodeURIComponent(path.slice("/markets/".length));
      if (ticker === archivedTicker || ticker === missingTicker) throw Object.assign(new Error("aged out"), { name: "KalshiHttp404" });
      return { market: { ticker, status: "finalized", result: "no" } } as T;
    }
    if (path.startsWith("/historical/markets?")) {
      if (missingArchivePages++ >= 2) {
        return { markets: [{ ticker: "KXETH15M-WRONG", status: "finalized", result: "no" }], cursor: "cycle" } as T;
      }
      return { markets: [{ ticker: archivedTicker, status: "finalized", result: "no" }] } as T;
    }
    if (path.startsWith("/portfolio/orders/")) {
      const orderId = decodeURIComponent(path.slice("/portfolio/orders/".length));
      const order = orders.find((entry) => entry.kalshiOrderId === orderId)!;
      return { order: { order_id: orderId, client_order_id: order.id, ticker: order.ticker, status: "executed", fill_count_fp: "0.00" } } as T;
    }
    if (path.startsWith("/portfolio/fills?")) return { fills: [] } as T;
    if (path.startsWith("/portfolio/positions?")) return { market_positions: [] } as T;
    throw new Error(`unexpected archive scheduler path: ${path}`);
  }) as any);
  try {
    assert.equal(await reconcileEth420CandidateLiveSettlements(store), 2);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  assert.ok(outcomes.includes(`${orders[0].id}:settled`), "exact archived terminal result settles");
  assert.ok(outcomes.includes(`${orders[1].id}:official_result_missing`), "wrong/cyclic archive pages fail closed");
  assert.ok(outcomes.includes(`${orders[2].id}:settled`), "later row continues after archive failure");
});

test("missing candidate state recovers only the real historical orders and their exact fill economics", async () => {
  const rows = [
    { ticker: "KXETH15M-70JAN040045-45", result: "no" as const, orderId: "bootstrap-order-1", createdAt: 10 },
    { ticker: "KXETH15M-70JAN040100-00", result: "no" as const, orderId: "bootstrap-order-2", createdAt: 20 },
    { ticker: "KXETH15M-70JAN040115-15", result: "no" as const, orderId: "bootstrap-order-3", createdAt: 30 },
    { ticker: "KXETH15M-70JAN040130-30", result: "no" as const, orderId: "bootstrap-order-4", createdAt: 40 },
    { ticker: "KXETH15M-70JAN040145-45", result: "yes" as const, orderId: "bootstrap-order-5", createdAt: 50 },
  ].map((row) => ({
    ...row, id: `${row.ticker}:eth420-live-v1`,
    stateBeforeJson: JSON.stringify({
      easternDate: bootstrapDate, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null,
    }),
  }));
  const legacyBefore = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  for (const row of rows) {
    await db.execute(sql`INSERT INTO eth420_candidate_live_orders
      (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
       effective_wager_cents, state_before_json, kalshi_order_id, status, created_at_ms, updated_at_ms)
      VALUES (${row.id}, ${row.ticker}, ${bootstrapDate}, 'no', 0, 30, 50, 1500, ${row.stateBeforeJson},
        ${row.orderId}, 'submitted', ${row.createdAt}, ${row.createdAt})`);
  }
  _setEth420CandidateAuthFetchForTesting((async <T>(_method: string, path: string): Promise<T> => {
    const current = rows.find((row) => path === `/portfolio/orders/${row.orderId}`);
    if (current) {
      return { order: { order_id: current.orderId, client_order_id: current.id, ticker: current.ticker,
        status: "executed", fill_count_fp: "30.00" } } as T;
    }
    const fillRow = rows.find((row) => path.includes(`order_id=${row.orderId}`));
    if (fillRow) {
      return { fills: [{ fill_id: `fill-${fillRow.orderId}`, order_id: fillRow.orderId, ticker: fillRow.ticker,
        count_fp: "30.00", no_price_dollars: "0.5000", fee_cost_dollars: "0.2500" }] } as T;
    }
    throw new Error(`unexpected bootstrap recovery path: ${path}`);
  }) as any);
  try {
    assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
      id: rows[4]!.id, ticker: rows[4]!.ticker, easternDate: bootstrapDate, kalshiOrderId: rows[4]!.orderId,
      requestedContracts: 30, limitPriceCents: 50, side: "no", step: 0, stateBeforeJson: rows[4]!.stateBeforeJson,
    }, rows[4]!.result), false, "later row cannot bootstrap over unresolved earlier candidate rows");
    assert.deepEqual(await readPersistedEth420CandidateState(bootstrapDate), { available: true, state: null });
    for (const row of rows) {
      assert.equal(await recoverAndSettleEth420CandidateLiveOrder(await import("./tradeStore.js") as any, {
        id: row.id, ticker: row.ticker, easternDate: bootstrapDate, kalshiOrderId: row.orderId,
        requestedContracts: 30, limitPriceCents: 50, side: "no", step: 0, stateBeforeJson: row.stateBeforeJson,
      }, row.result), true);
    }
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
  }
  const settled = await db.execute(sql`SELECT status, filled_contracts::double precision AS filled_contracts, realized_pnl_delta_cents,
    actual_notional_dollars, actual_fee_dollars, fill_price_cents, state_after_json
    FROM eth420_candidate_live_orders WHERE eastern_date=${bootstrapDate} ORDER BY created_at_ms`);
  const settledRows = (settled as any).rows;
  assert.deepEqual(settledRows.map(({ state_after_json, ...row }: any) => row), [
    { status: "settled", filled_contracts: 30, realized_pnl_delta_cents: 1475, actual_notional_dollars: "15", actual_fee_dollars: "0.25", fill_price_cents: 50 },
    { status: "settled", filled_contracts: 30, realized_pnl_delta_cents: 1475, actual_notional_dollars: "15", actual_fee_dollars: "0.25", fill_price_cents: 50 },
    { status: "settled", filled_contracts: 30, realized_pnl_delta_cents: 1475, actual_notional_dollars: "15", actual_fee_dollars: "0.25", fill_price_cents: 50 },
    { status: "settled", filled_contracts: 30, realized_pnl_delta_cents: 1475, actual_notional_dollars: "15", actual_fee_dollars: "0.25", fill_price_cents: 50 },
    { status: "settled", filled_contracts: 30, realized_pnl_delta_cents: -1525, actual_notional_dollars: "15", actual_fee_dollars: "0.25", fill_price_cents: 50 },
  ]);
  assert.deepEqual(settledRows.map((row: any) => JSON.parse(row.state_after_json)), [
    { easternDate: bootstrapDate, side: "yes", step: 0, realizedPnlCents: 1475, lastBlockResetAtMs: null },
    { easternDate: bootstrapDate, side: "yes", step: 0, realizedPnlCents: 2950, lastBlockResetAtMs: null },
    { easternDate: bootstrapDate, side: "yes", step: 0, realizedPnlCents: 4425, lastBlockResetAtMs: null },
    { easternDate: bootstrapDate, side: "yes", step: 0, realizedPnlCents: 5900, lastBlockResetAtMs: null },
    { easternDate: bootstrapDate, side: "no", step: 1, realizedPnlCents: 4375, lastBlockResetAtMs: null },
  ], "each recovery transition uses the real persisted order side/step while P&L remains chronological");
  assert.deepEqual(await getEth420CandidateState(bootstrapDate), {
    easternDate: bootstrapDate, side: "no", step: 1, realizedPnlCents: 4375, lastBlockResetAtMs: null,
  });
  const legacyAfter = await db.execute(sql`SELECT row_to_json(t)::text AS bytes FROM eth_martingale_state t WHERE strategy_key=${legacyKey}`);
  assert.equal((legacyBefore as any).rows[0].bytes, (legacyAfter as any).rows[0].bytes);
});

test("atomic candidate entry fence bootstraps NO step 0 once on a fresh day, including concurrent claims", async () => {
  const fenceDate = fenceDates[0]!;
  const first = fenceOrder(fenceDate, "060000-00-FENCE-FIRST");
  const second = fenceOrder(fenceDate, "060015-15-FENCE-SECOND");
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches({
    ...first, id: `KXETH15M-70JAN060030-30-FENCE-FORGED:eth420-live-v1`, ticker: "KXETH15M-70JAN060030-30-FENCE-FORGED",
    side: "yes", step: 1,
  }), false, "a matching state snapshot cannot reserve a different prepared side or step");
  const results = await Promise.all([
    reserveEth420CandidateLiveOrderIfStateMatches(first),
    reserveEth420CandidateLiveOrderIfStateMatches(second),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await readPersistedEth420CandidateState(fenceDate), {
    available: true, state: canonicalFenceState(fenceDate),
  });
  const rows = await db.execute(sql`SELECT id, status FROM eth420_candidate_live_orders WHERE eastern_date=${fenceDate}`);
  assert.equal((rows as any).rows.length, 1);
  assert.equal((rows as any).rows[0].status, "reserved");
});

test("atomic candidate entry fence blocks missing-state history and unresolved lifecycle before any exchange work", async () => {
  const missingStateDate = fenceDates[1]!, unresolvedDate = fenceDates[2]!;
  const priorMissing = fenceOrder(missingStateDate, "070000-00-FENCE-PRIOR");
  await db.execute(sql`INSERT INTO eth420_candidate_live_orders
    (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
     effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
    VALUES (${priorMissing.id}, ${priorMissing.ticker}, ${missingStateDate}, 'no', 0, 30, 50, 1500,
      ${priorMissing.stateBeforeJson}, 'submitted', 1, 1)`);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches(fenceOrder(missingStateDate, "070015-15-FENCE-BLOCKED")), false);
  assert.deepEqual(await readPersistedEth420CandidateState(missingStateDate), { available: true, state: null });
  await db.execute(sql`UPDATE eth420_candidate_live_orders SET status='settled' WHERE id=${priorMissing.id}`);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches(fenceOrder(missingStateDate, "070030-30-FENCE-SETTLED-HISTORY-BLOCKED")), false);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${unresolvedDate}, 'no', 0, 0, NULL, 1)`);
  const priorUnresolved = fenceOrder(unresolvedDate, "080000-00-FENCE-PRIOR");
  await db.execute(sql`INSERT INTO eth420_candidate_live_orders
    (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
     effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
    VALUES (${priorUnresolved.id}, ${priorUnresolved.ticker}, ${unresolvedDate}, 'no', 0, 30, 50, 1500,
      ${priorUnresolved.stateBeforeJson}, 'submission_unknown_recovery_required', 1, 1)`);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches(fenceOrder(unresolvedDate, "080015-15-FENCE-BLOCKED")), false);
  const newRows = await db.execute(sql`SELECT id FROM eth420_candidate_live_orders
    WHERE id IN (${`KXETH15M-70JAN070015-15-FENCE-BLOCKED:eth420-live-v1`},
      ${`KXETH15M-70JAN070030-30-FENCE-SETTLED-HISTORY-BLOCKED:eth420-live-v1`},
      ${`KXETH15M-70JAN080015-15-FENCE-BLOCKED:eth420-live-v1`})`);
  assert.deepEqual((newRows as any).rows, []);
});

test("atomic candidate entry fence permits settled history but refuses a stale prepared state snapshot", async () => {
  const settledDate = fenceDates[3]!, staleDate = fenceDates[4]!;
  const settledState = canonicalFenceState(settledDate);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${settledDate}, 'no', 0, 0, NULL, 1)`);
  const settled = fenceOrder(settledDate, "090000-00-FENCE-SETTLED", settledState);
  await db.execute(sql`INSERT INTO eth420_candidate_live_orders
    (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
     effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
    VALUES (${settled.id}, ${settled.ticker}, ${settledDate}, 'no', 0, 30, 50, 1500,
      ${settled.stateBeforeJson}, 'settled', 1, 1)`);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches(fenceOrder(settledDate, "090015-15-FENCE-NEXT", settledState)), true);
  const stateA = canonicalFenceState(staleDate);
  await db.execute(sql`INSERT INTO eth420_candidate_daily_state
    (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${staleDate}, 'no', 0, 0, NULL, 1)`);
  await db.execute(sql`UPDATE eth420_candidate_daily_state
    SET side='yes', martingale_step=1, realized_pnl_cents=1500 WHERE eastern_date=${staleDate}`);
  assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches(fenceOrder(staleDate, "100000-00-FENCE-STALE", stateA)), false);
  const staleRows = await db.execute(sql`SELECT id FROM eth420_candidate_live_orders WHERE eastern_date=${staleDate}`);
  assert.deepEqual((staleRows as any).rows, []);
});

test("atomic candidate entry fence fails closed when its database transaction cannot run", async () => {
  const fenceDate = fenceDates[5]!;
  let exchangeCalls = 0;
  _setEth420CandidateAuthFetchForTesting((async (): Promise<never> => {
    exchangeCalls++;
    throw new Error("exchange must not be called by reservation");
  }) as any);
  const originalTransaction = (db as any).transaction;
  (db as any).transaction = async () => { throw new Error("database unavailable"); };
  try {
    assert.equal(await reserveEth420CandidateLiveOrderIfStateMatches(fenceOrder(fenceDate, "110000-00-FENCE-DB-FAIL")), false);
  } finally {
    (db as any).transaction = originalTransaction;
    _setEth420CandidateAuthFetchForTesting(null);
  }
  assert.equal(exchangeCalls, 0);
  const rows = await db.execute(sql`SELECT id FROM eth420_candidate_live_orders WHERE eastern_date=${fenceDate}`);
  assert.deepEqual((rows as any).rows, []);
});

test("candidate executor stops at a denied atomic reservation before balance or exchange submission", async () => {
  const fenceDate = "1970-01-12";
  const previousEnabled = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  let reservations = 0, exchangeCalls = 0;
  const history = Array.from({ length: 50 }, (_, index) => ({
    ticker: `KXETH15M-HISTORY-${index}`, easternDate: fenceDate, observedAtMs: index,
    floorStrike: 100, payloadJson: JSON.stringify({ openTimeMs: index * 900_000, currentMove: 0.01 }),
  }));
  const store: any = {
    getEth420CandidateState: async () => canonicalFenceState(fenceDate),
    listEth420CandidateTelemetry: async () => history,
    reserveEth420CandidateLiveOrderIfStateMatches: async () => { reservations++; return false; },
  };
  process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
  _setEth420CandidateAuthFetchForTesting((async () => {
    exchangeCalls++;
    throw new Error("candidate exchange call must not occur after a denied reservation");
  }) as any);
  try {
    assert.equal(await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(store, {
      ticker: "KXETH15M-70JAN120000-00-FENCE", exchangeIndex: 1, status: "open", openTime: null, closeTime: null,
      yesBid: null, noBid: null,
    }, {
      ticker: "KXETH15M-70JAN120000-00-FENCE", easternDate: fenceDate, observedAtMs: 50_000_000,
      floorStrike: 105, openTimeMs: 50 * 900_000,
    }), false);
  } finally {
    _setEth420CandidateAuthFetchForTesting(null);
    if (previousEnabled == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
    else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = previousEnabled;
  }
  assert.equal(reservations, 1);
  assert.equal(exchangeCalls, 0);
});

test("live ETH 420 telemetry is append-only, adjacent-validated, and requires 50 valid moves for a jump", async () => {
  const telemetryDate = "1970-01-13";
  const telemetryPrefix = "KXETH15M-70JAN13";
  const store = await import("./tradeStore.js");
  const previousLive = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  const previousShadow = process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
  await db.execute(sql`DELETE FROM eth420_candidate_telemetry WHERE id LIKE ${telemetryPrefix + "%"}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${telemetryDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${telemetryDate}`);
  process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
  delete process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
  try {
    await observeEth420Candidate(store as any, {
      ticker: `${telemetryPrefix}0000-00`, easternDate: telemetryDate, observedAtMs: 0, floorStrike: null, openTimeMs: 0,
    });
    assert.deepEqual((await db.execute(sql`SELECT id FROM eth420_candidate_telemetry WHERE id LIKE ${telemetryPrefix + "%"}`) as any).rows, [],
      "a pre-snapshot websocket delta cannot consume the immutable ticker identity");
    await observeEth420Candidate(store as any, {
      ticker: `${telemetryPrefix}0000-00`, easternDate: telemetryDate, observedAtMs: 1, floorStrike: 100, openTimeMs: 0,
    });
    await observeEth420Candidate(store as any, {
      ticker: `${telemetryPrefix}0015-15`, easternDate: telemetryDate, observedAtMs: 2, floorStrike: 101, openTimeMs: 900_000,
    });
    await observeEth420Candidate(store as any, {
      ticker: `${telemetryPrefix}0045-45`, easternDate: telemetryDate, observedAtMs: 3, floorStrike: 102, openTimeMs: 2_700_000,
    });
    await observeEth420Candidate(store as any, {
      ticker: `${telemetryPrefix}0100-00`, easternDate: telemetryDate, observedAtMs: 4, floorStrike: 103, openTimeMs: 3_612_345,
    });
    await observeEth420Candidate(store as any, {
      ticker: `${telemetryPrefix}0115-15`, easternDate: telemetryDate, observedAtMs: 5, floorStrike: 104, openTimeMs: 4_512_345,
    });
    const observed = await db.execute(sql`SELECT id, payload_json FROM eth420_candidate_telemetry
      WHERE id LIKE ${telemetryPrefix + "%"} ORDER BY observed_at_ms`);
    const payloads = (observed as any).rows.map((row: any) => JSON.parse(row.payload_json));
    assert.equal(payloads.length, 3);
    assert.deepEqual(payloads.map((payload: any) => payload.validAdjacentMove), [false, true, false]);
    assert.ok(!(observed as any).rows.some((row: any) => row.id.includes("0100-00") || row.id.includes("0115-15")),
      "unaligned open timestamps cannot claim a telemetry ticker identity");
    assert.equal(payloads[1].priorFloorStrike, 100);
    assert.equal(payloads[1].currentMove, .01);
    assert.deepEqual((await db.execute(sql`SELECT id FROM eth420_candidate_live_orders WHERE eastern_date=${telemetryDate}`) as any).rows, []);
    assert.deepEqual((await db.execute(sql`SELECT eastern_date FROM eth420_candidate_daily_state WHERE eastern_date=${telemetryDate}`) as any).rows, []);

    await db.execute(sql`DELETE FROM eth420_candidate_telemetry WHERE id LIKE ${telemetryPrefix + "%"}`);
    const validMoves = Array.from({ length: 50 }, (_, index) => index === 49 ? .05 : index / 1000);
    for (let index = 0; index < 49; index++) {
      const openTimeMs = index * 900_000;
      await db.execute(sql`INSERT INTO eth420_candidate_telemetry
        (id, ticker, eastern_date, observed_at_ms, floor_strike, payload_json)
        VALUES (${`${telemetryPrefix}-VALID-${index}`}, ${`${telemetryPrefix}-VALID-${index}`}, ${telemetryDate}, ${100 + index},
          ${100 * (1 + validMoves[index]!)},
          ${JSON.stringify({ schemaVersion: 2, openTimeMs, priorFloorStrike: 100, priorOpenTimeMs: openTimeMs - 900_000,
            currentMove: validMoves[index], validAdjacentMove: true })})`);
    }
    await db.execute(sql`INSERT INTO eth420_candidate_daily_state
      (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
      VALUES (${telemetryDate}, 'no', 5, 0, NULL, 1)`);
    const market = { ticker: `${telemetryPrefix}-CURRENT`, easternDate: telemetryDate, observedAtMs: 1_000,
      floorStrike: 100 * (1 + validMoves[48]!) * 1.049, openTimeMs: 49 * 900_000 };
    const at49 = await prepareEth420CandidateDecision(store as any, market);
    // VALID-0 has no -15-minute predecessor fact, so only VALID-1..48 form
    // genuine adjacent moves before inserting VALID-49 below.
    assert.equal(at49?.decision.validObservationCount, 48);
    assert.equal(at49?.decision.p95, null);
    await db.execute(sql`INSERT INTO eth420_candidate_telemetry
      (id, ticker, eastern_date, observed_at_ms, floor_strike, payload_json)
      VALUES (${`${telemetryPrefix}-VALID-49`}, ${`${telemetryPrefix}-VALID-49`}, ${telemetryDate}, 149,
        ${100 * (1 + validMoves[49]!)},
        ${JSON.stringify({ schemaVersion: 2, openTimeMs: 49 * 900_000, priorFloorStrike: 100, priorOpenTimeMs: 48 * 900_000,
          currentMove: validMoves[49], validAdjacentMove: true })})`);
    const at50 = await prepareEth420CandidateDecision(store as any, {
      ...market, observedAtMs: 1_001, floorStrike: 100 * (1 + validMoves[49]!) * 1.049, openTimeMs: 50 * 900_000,
    });
    // The additional contiguous fact creates the 49th move, not the 50th:
    // the fixture begins at open time zero without its -15-minute predecessor.
    assert.equal(at50?.decision.validObservationCount, 49);
    assert.equal(at50?.decision.p95, null);
    assert.equal(at50?.decision.p99, null);
    assert.equal(at50?.decision.sweetSpotTell, false);
    assert.equal(at50?.decision.underlyingStep, 5);
    assert.equal(at50?.decision.effectiveWagerCents, 32_000);
    const boundaryInput = {
      ticker: `${telemetryPrefix}-BOUNDARY`, easternDate: telemetryDate, observedAtMs: 1_001,
      floorStrike: 100, openTimeMs: 50 * 900_000, priorMarket: { ticker: `${telemetryPrefix}-VALID-49`, easternDate: telemetryDate,
        observedAtMs: 149, floorStrike: 100, openTimeMs: 49 * 900_000 },
      trailingMoves: validMoves, state: { easternDate: telemetryDate, side: "no" as const, step: 5,
        realizedPnlCents: 0, lastBlockResetAtMs: null }, estimatedFeeCents: 0,
    };
    const threshold = evaluateEth420Candidate(boundaryInput);
    assert.notEqual(threshold.p95, null);
    assert.notEqual(threshold.p99, null);
    const atP95 = evaluateEth420Candidate({ ...boundaryInput, floorStrike: 100 * (1 + threshold.p95!) });
    const atP99 = evaluateEth420Candidate({ ...boundaryInput, floorStrike: 100 * (1 + threshold.p99!) });
    assert.equal(atP95.sweetSpotTell, true, "p95 is inclusive");
    assert.equal(atP95.effectiveWagerCents, 42_000, "p95 jump override remains $420");
    assert.equal(atP99.sweetSpotTell, false, "p99 is exclusive");

    let dangerousStateCalls = 0;
    await observeEth420Candidate({
      listEth420CandidateTelemetry: async () => [],
      recordEth420CandidateTelemetry: async () => { throw new Error("telemetry storage unavailable"); },
      getEth420CandidateState: async () => { dangerousStateCalls++; return null; },
    } as any, { ticker: `${telemetryPrefix}-WRITE-FAIL`, easternDate: telemetryDate, observedAtMs: 2_000,
      floorStrike: 100, openTimeMs: 51 * 900_000 });
    assert.equal(dangerousStateCalls, 0, "a telemetry failure must not reach candidate state or an order path");
  } finally {
    if (previousLive == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
    else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = previousLive;
    if (previousShadow == null) delete process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
    else process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"] = previousShadow;
    await db.execute(sql`DELETE FROM eth420_candidate_telemetry WHERE id LIKE ${telemetryPrefix + "%"}`);
    await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${telemetryDate}`);
    await db.execute(sql`DELETE FROM eth420_candidate_live_orders WHERE eastern_date=${telemetryDate}`);
  }
});
