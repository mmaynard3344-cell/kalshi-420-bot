/**
 * Database integration tests for L — Sweep/Reclaim durable claim persistence.
 *
 * Requires DATABASE_URL and the review schema to be applied in a non-production
 * database with: pnpm --filter @workspace/db push
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql as drizzleSql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  claimSweepReclaimSignal,
  findSweepReclaimClaimBySignal,
  getSweepReclaimClaim,
  initTradeStore,
  isStorageHealthy,
  updateSweepReclaimClaim,
  type SweepReclaimClaimParams,
} from "./tradeStore.js";
import { SWEEP_RECLAIM_DISPLAY_NAME, SWEEP_RECLAIM_STRATEGY_ID } from "./strategies/sweepReclaimV1.js";

const TEST_OPEN_MS = Date.UTC(1976, 0, 1, 10, 0, 0);

function params(id: string, ticker: string, openMs = TEST_OPEN_MS): SweepReclaimClaimParams {
  return {
    id,
    strategyId: SWEEP_RECLAIM_STRATEGY_ID,
    serviceCode: "L",
    displayLabel: SWEEP_RECLAIM_DISPLAY_NAME,
    sourceVenue: "kraken",
    sourceCandleOpenMs: openMs,
    sourceCandleCloseMs: openMs + 15 * 60_000,
    sourceOpen: 100,
    sourceHigh: 110,
    sourceLow: 90,
    sourceClose: 106,
    prior24hLow: 91,
    candleRange: 20,
    realBody: 6,
    lowerWick: 10,
    midpoint: 100,
    closePositionFraction: 0.8,
    sweptPrevious24hLow: true,
    wickCondition: true,
    upperHalfClose: true,
    qualified: true,
    destinationTicker: ticker,
    side: "yes",
    claimedAtMs: openMs + 15 * 60_000 + 1,
  };
}

async function clean(): Promise<void> {
  await db.execute(drizzleSql.raw(
    "DELETE FROM sweep_reclaim_claims WHERE source_candle_open_ms >= " +
      TEST_OPEN_MS +
      " AND source_candle_open_ms < " +
      (TEST_OPEN_MS + 24 * 60 * 60_000),
  ));
}

describe("tradeStore — Sweep/Reclaim durable claims", async () => {
  before(async () => {
    await initTradeStore();
    assert.equal(isStorageHealthy(), true);
    await clean();
  });

  after(async () => {
    await clean();
  });

  it("first claim succeeds and persists complete source evidence", async () => {
    const ticker = "KXETH15M-TEST-SWEEP-1";
    const p = params("sweep-test-1", ticker);
    assert.equal(await claimSweepReclaimSignal(p), true);
    const row = await getSweepReclaimClaim(p.id);
    assert.ok(row);
    assert.equal(row!.strategyId, SWEEP_RECLAIM_STRATEGY_ID);
    assert.equal(row!.serviceCode, "L");
    assert.equal(row!.destinationTicker, ticker);
    assert.equal(row!.sourceCandleOpenMs, TEST_OPEN_MS);
    assert.equal(row!.lifecycleState, "CLAIMED");
    assert.equal(row!.side, "yes");
  });

  it("database unique identity blocks another worker with a different row id", async () => {
    const ticker = "KXETH15M-TEST-SWEEP-DUP";
    const openMs = TEST_OPEN_MS + 15 * 60_000;
    const first = params("sweep-dup-a", ticker, openMs);
    const second = params("sweep-dup-b", ticker, openMs);
    assert.equal(await claimSweepReclaimSignal(first), true);
    assert.equal(await claimSweepReclaimSignal(second), false);

    const found = await findSweepReclaimClaimBySignal(
      SWEEP_RECLAIM_STRATEGY_ID,
      openMs,
      ticker,
    );
    assert.equal(found?.id, first.id);
  });

  it("same destination ticker may be claimed for a different source candle identity", async () => {
    const ticker = "KXETH15M-TEST-SWEEP-REUSE";
    assert.equal(await claimSweepReclaimSignal(params("sweep-reuse-a", ticker, TEST_OPEN_MS + 30 * 60_000)), true);
    assert.equal(await claimSweepReclaimSignal(params("sweep-reuse-b", ticker, TEST_OPEN_MS + 45 * 60_000)), true);
  });

  it("persists ambiguous submission, reconciliation, and final settlement evidence", async () => {
    const ticker = "KXETH15M-TEST-SWEEP-LIFE";
    const p = params("sweep-life", ticker, TEST_OPEN_MS + 60 * 60_000);
    assert.equal(await claimSweepReclaimSignal(p), true);

    assert.equal(await updateSweepReclaimClaim({
      id: p.id,
      observedYesPriceCents: 42,
      configuredPriceCapCents: 50,
      requestedContracts: 2,
      requestedRiskCents: 84,
      correlatedExposureBeforeCents: 100,
      proposedExposureCents: 84,
      sharedExposureCapCents: 500,
      admissionOutcome: "admitted",
      lifecycleState: "SUBMISSION_UNKNOWN",
      clientOrderId: "client-l-1",
    }), true);

    assert.equal(await updateSweepReclaimClaim({ id: p.id, lifecycleState: "RECONCILING" }), true);

    assert.equal(await updateSweepReclaimClaim({
      id: p.id,
      lifecycleState: "SETTLED",
      kalshiOrderId: "kalshi-l-1",
      filledContracts: 2,
      averageFillPriceCents: 42,
      settlementResult: "yes",
      realizedPnlCents: 116,
    }), true);

    const row = await getSweepReclaimClaim(p.id);
    assert.equal(row?.lifecycleState, "SETTLED");
    assert.equal(row?.clientOrderId, "client-l-1");
    assert.equal(row?.kalshiOrderId, "kalshi-l-1");
    assert.equal(row?.realizedPnlCents, 116);
  });
});
