import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  initTradeStore,
  listEth420CounterfactualEntries,
  getEth420CandidateState,
  migrateEth420LegacyStateToDailyState,
  recordEth420CounterfactualEntry,
  saveEth420CandidateState,
  settleEth420CounterfactualEntry,
} from "./tradeStore.js";

const ticker = "KXETH15M-70JAN010000-00-ETH420-COUNTERFACTUAL-TEST";
const date = "1970-01-01";
const firstId = `${ticker}:first`;
const secondId = `${ticker}:second`;
const highId = `${ticker}:high-step`;
const legacyKey = "eth420_counterfactual_migration_test";
const legacyDate = "1970-01-02";
const entry = (id: string) => ({
  id, ticker, easternDate: date, observedAtMs: id === firstId ? 1 : 2,
  side: "no" as const, step: 0, effectiveWagerCents: 1500,
  decisionPayloadJson: '{"counterfactual":true}',
  stateBeforeJson: JSON.stringify({ easternDate: date, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null }),
});

async function clean() {
  await db.execute(sql`DELETE FROM eth420_counterfactual_settlement_events WHERE id LIKE ${`counterfactual:${ticker}%`}`);
  await db.execute(sql`DELETE FROM eth420_candidate_entries WHERE ticker=${ticker}`);
  await db.execute(sql`DELETE FROM eth420_counterfactual_daily_state WHERE eastern_date=${date}`);
  await db.execute(sql`DELETE FROM eth420_candidate_daily_state WHERE eastern_date=${legacyDate}`);
  await db.execute(sql`DELETE FROM eth420_candidate_state WHERE strategy_key=${legacyKey}`);
}

before(async () => { await initTradeStore(); await clean(); });
after(async () => {
  await clean();
  await pool.end().catch(() => {});
});

test("counterfactual recorder serializes entries and settles verified zero fills without P&L", async () => {
  const parallel = await Promise.all([recordEth420CounterfactualEntry(entry(firstId)), recordEth420CounterfactualEntry(entry(secondId))]);
  assert.equal(parallel.filter(Boolean).length, 1, "parallel observers may create exactly one pending sequence step");
  const winningId = parallel[0] ? firstId : secondId;
  const waitingId = parallel[0] ? secondId : firstId;
  assert.equal(await settleEth420CounterfactualEntry(winningId, "no"), true);
  assert.equal(await settleEth420CounterfactualEntry(winningId, "no"), true, "repeat reconciliation is idempotent");
  let rows = await listEth420CounterfactualEntries(10);
  const first = rows.find((row) => row.id === winningId)!;
  assert.equal(first.settlementResult, "no");
  assert.equal(first.filledContracts, 0);
  assert.equal(first.realizedPnlDeltaCents, 0);
  assert.match(first.stateAfterJson ?? "", /"side":"yes"/);
  assert.match(first.stateAfterJson ?? "", /"realizedPnlCents":0/);

  const settledSnapshot = { easternDate: date, side: "yes" as const, step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null };
  assert.equal(await recordEth420CounterfactualEntry({
    ...entry(waitingId), side: "yes", stateBeforeJson: JSON.stringify(settledSnapshot),
  }), true, "the next entry must use the settled state snapshot");
  assert.equal(await settleEth420CounterfactualEntry(waitingId, "yes"), true);
  rows = await listEth420CounterfactualEntries(10);
  assert.equal(rows.filter((row) => row.ticker === ticker).length, 2);
});

test("pending entry settlement uses its immutable high-step snapshot after a blocked reset", async () => {
  await db.execute(sql`
    UPDATE eth420_counterfactual_daily_state
    SET side='no', martingale_step=4, realized_pnl_cents=0, last_block_reset_at_ms=NULL, updated_at_ms=1
    WHERE eastern_date=${date}`);
  const highStepEntry = {
    ...entry(highId), observedAtMs: 3, step: 4,
    stateBeforeJson: JSON.stringify({ easternDate: date, side: "no", step: 4, realizedPnlCents: 0, lastBlockResetAtMs: null }),
  };
  assert.equal(await recordEth420CounterfactualEntry(highStepEntry), true);
  // This mirrors a later prospective-loss block. It may reset the daily
  // candidate view but cannot rewrite the already-captured high-step entry.
  await db.execute(sql`
    UPDATE eth420_counterfactual_daily_state
    SET side='no', martingale_step=0, realized_pnl_cents=-120000, last_block_reset_at_ms=4
    WHERE eastern_date=${date}`);
  assert.equal(await settleEth420CounterfactualEntry(highId, "yes"), true);
  const high = (await listEth420CounterfactualEntries(10)).find((row) => row.id === highId)!;
  assert.match(high.stateAfterJson ?? "", /"step":5/);
  assert.match(high.stateAfterJson ?? "", /"side":"no"/);
});

test("a stale observation snapshot is rejected after an intervening settlement", async () => {
  await clean();
  const settledId = `${ticker}:intervening`;
  const staleId = `${ticker}:stale`;
  const staleState = { easternDate: date, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null };
  assert.equal(await recordEth420CounterfactualEntry({ ...entry(settledId), stateBeforeJson: JSON.stringify(staleState) }), true);
  assert.equal(await settleEth420CounterfactualEntry(settledId, "no"), true);
  assert.equal(await recordEth420CounterfactualEntry({ ...entry(staleId), stateBeforeJson: JSON.stringify(staleState) }), false);
  const refreshed = { ...staleState, side: "yes" as const };
  assert.equal(await recordEth420CounterfactualEntry({ ...entry(staleId), side: "yes", stateBeforeJson: JSON.stringify(refreshed) }), true);
  assert.equal(await settleEth420CounterfactualEntry(staleId, "yes"), true);
});

test("legacy singleton state migrates once into date-keyed live candidate state", async () => {
  await db.execute(sql`
    INSERT INTO eth420_candidate_state
      (strategy_key, eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
    VALUES (${legacyKey}, ${legacyDate}, 'yes', 4, -119900, 123, 456)`);
  assert.equal(await migrateEth420LegacyStateToDailyState(legacyKey), true);
  const migrated = await getEth420CandidateState(legacyDate);
  assert.deepEqual(migrated, {
    easternDate: legacyDate, side: "yes", step: 4, realizedPnlCents: -119900, lastBlockResetAtMs: 123,
  });
  await db.execute(sql`
    UPDATE eth420_candidate_state SET side='no', martingale_step=0, realized_pnl_cents=0
    WHERE strategy_key=${legacyKey}`);
  assert.equal(await migrateEth420LegacyStateToDailyState(legacyKey), true);
  assert.deepEqual(await getEth420CandidateState(legacyDate), migrated, "date-keyed live state wins on repeat migration");
});
