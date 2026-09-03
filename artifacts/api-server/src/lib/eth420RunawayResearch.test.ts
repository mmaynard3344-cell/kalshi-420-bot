import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  classifyEth420Runaway,
  refreshEth420RunawayResearch,
  type Eth420RunawayResearchInput,
} from "./eth420RunawayResearch.js";

const order = {
  id: "candidate-research-1", ticker: "KXETH15M-test", easternDate: "2026-09-01", side: "yes" as const,
  step: 0, requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500, stateBeforeJson: "{}",
  kalshiOrderId: "order-1", status: "settled", filledContracts: 0, realizedPnlDeltaCents: 0,
  actualNotionalDollars: "0", actualFeeDollars: "0", fillPriceCents: null, settlementResult: "yes" as const,
  stateAfterJson: "{}", createdAtMs: 1, updatedAtMs: 2, recoveryAttemptCount: 0, lastRecoveryOutcome: null,
  lastRecoveryErrorClass: null, originalPrimaryKalshiOrderId: null, secondaryClientOrderId: null,
  primaryCancelConfirmedAtMs: null, secondarySubmissionStartedAtMs: null, secondaryBoundAtMs: null,
  rejectionReason: null, rejectionConfirmedAtMs: null, secondaryActivationSequence: 0,
};

function snapshot(offset: number, bid: number, ask: number, executable: number, status = "resting", filled = 0) {
  return {
    snapshotId: `${order.id}:${offset}`, candidateOrderId: order.id, ticker: order.ticker, scheduledOffsetMs: offset,
    scheduledAtMs: offset, observedAtMs: offset, selectedSide: "yes" as const, requestedContracts: order.requestedContracts,
    kalshiOrderId: order.kalshiOrderId, orderStatus: status, filledContracts: filled, selectedBestBidCents: bid,
    selectedBestAskCents: ask, depthAt50Contracts: 0, fullSizeExecutablePriceCents: executable,
    quoteAgeMs: null, quoteFreshness: "unavailable" as const, observationState: "captured" as const,
  };
}

test("classifies each regime from retained snapshots and persists no trading instruction", () => {
  const accelerating: Eth420RunawayResearchInput = {
    order, snapshots: [snapshot(0, 50, 52, 52), snapshot(1_000, 51, 60, 60), snapshot(10_000, 55, 64, 70)],
  };
  const result = classifyEth420Runaway(accelerating);
  assert.deepEqual(result.firedRegimes, ["accelerating_runaway"]);
  assert.equal(result.hypotheticalFullSizeEntryPriceCents, 70);
  assert.equal(result.hypotheticalEntryCostCents, 2_100);
  assert.equal(result.hypotheticalFeeCents, 45);
  assert.equal(result.hypotheticalNetPnlCents, 855);
  assert.match(result.sourceSnapshotsJson, /plus10s/);

  const quiet = classifyEth420Runaway({
    order, snapshots: [
      snapshot(1_000, 51, 55, 55), snapshot(2_000, 52, 56, 56),
      snapshot(5_000, 53, 54, 57), snapshot(10_000, 54, 56, 58),
    ],
  });
  assert.deepEqual(quiet.firedRegimes, ["quiet_runaway"]);

  const gone = classifyEth420Runaway({
    order, snapshots: [snapshot(1_000, 88, 90, 92), snapshot(2_000, 89, 91, 93)],
  });
  assert.deepEqual(gone.firedRegimes, ["already_gone"]);
  assert.equal(gone.decisionPointOffsetMs, 1_000);
});

test("refresh has only passive read-and-record capabilities and cannot affect candidate state", async () => {
  const stateBefore = JSON.stringify({ side: "no", step: 4, realizedPnlCents: -12345 });
  let writes = 0;
  const record = await refreshEth420RunawayResearch({
    listEth420CandidateRunawayResearchInputs: async () => [{
      order: { ...order, stateBeforeJson: stateBefore },
      snapshots: [snapshot(1_000, 88, 90, 92)],
    }],
    recordEth420CandidateRunawayResearch: async (row) => {
      writes += 1;
      assert.equal(row.candidateOrderId, order.id);
      return true;
    },
  });
  assert.equal(record, 1);
  assert.equal(writes, 1);
  assert.equal(JSON.stringify({ side: "no", step: 4, realizedPnlCents: -12345 }), stateBefore);
});

test("classifier has no execution, exchange, or candidate-state imports", async () => {
  const source = await readFile(path.resolve(process.cwd(), "src/lib/eth420RunawayResearch.ts"), "utf8");
  for (const forbidden of ["autoTrader", "kalshiAuth", "kalshiFetch", "eth420SixStepCandidate", "settleEth420", "reserveEth420", "saveEth420"]) {
    assert.equal(source.includes(forbidden), false, `research classifier must not depend on ${forbidden}`);
  }
});