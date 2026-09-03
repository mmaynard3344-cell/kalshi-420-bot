import assert from "node:assert/strict";
import test from "node:test";
import {
  _captureEth420CandidateExecutionSnapshotForTesting,
  _setEth420ExecutionTelemetryReadersForTesting,
  ETH420_EXECUTION_SNAPSHOT_OFFSETS_MS,
  resumeEth420CandidateExecutionTelemetry,
} from "./eth420ExecutionTelemetry.js";
import type { Eth420CandidateLiveOrder, Eth420CandidateExecutionSnapshot } from "./tradeStore.js";

const order: Eth420CandidateLiveOrder = {
  id: "KXETH15M-test:eth420-live-v1", ticker: "KXETH15M-test", easternDate: "2026-08-30",
  side: "no", step: 1, requestedContracts: 30, limitPriceCents: 50, effectiveWagerCents: 1500,
  stateBeforeJson: "{}", kalshiOrderId: "order-420", status: "submitted", filledContracts: null,
  realizedPnlDeltaCents: null, actualNotionalDollars: null, actualFeeDollars: null, fillPriceCents: null,
  settlementResult: null, stateAfterJson: null, createdAtMs: 1_000, updatedAtMs: 1_000,
};

function store(rows: Eth420CandidateExecutionSnapshot[]) {
  return {
    getEth420CandidateLiveOrder: async () => order,
    listRecentUnsettledEth420CandidateLiveOrders: async () => [],
    recordEth420CandidateExecutionSnapshot: async (row: Eth420CandidateExecutionSnapshot) => {
      if (!rows.some((prior) => prior.snapshotId === row.snapshotId)) rows.push(row);
      return true;
    },
  };
}

test("execution evidence records exactly the seven bounded offsets and derives selected-side fields", async () => {
  const rows: Eth420CandidateExecutionSnapshot[] = [];
  _setEth420ExecutionTelemetryReadersForTesting({
    authFetch: (async () => ({ order: {
      order_id: "order-420", client_order_id: order.id, ticker: order.ticker, status: "resting", fill_count_fp: "4.00",
    } })) as any,
    orderbookCapture: (async () => ({
      ticker: order.ticker, capturedAtMs: Date.now(), side: "no", limitCents: 50, rawEntryCount: 2, totalLevels: 2,
      lowestLevelCents: 40, lowestLevelDollars: 8, lowestLevelContractsApprox: 20, highestLevelCents: 50,
      highestLevelDollars: 5, highestLevelContractsApprox: 10, nearLimitLevels: [], depthAtOrBetterDollars: 13,
      depthAtOrBetterContracts: 30, fetchLatencyMs: 1, error: null,
      rawYesDollars: [["0.6000", "20.00"], ["0.5000", "10.00"]], rawNoDollars: [["0.6000", "8.00"]],
    })) as any,
  });
  try {
    for (const offset of ETH420_EXECUTION_SNAPSHOT_OFFSETS_MS) {
      await _captureEth420CandidateExecutionSnapshotForTesting(store(rows), order, offset);
    }
  } finally {
    _setEth420ExecutionTelemetryReadersForTesting(null);
  }
  assert.deepEqual(rows.map((row) => row.scheduledOffsetMs), [...ETH420_EXECUTION_SNAPSHOT_OFFSETS_MS]);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((row) => row.selectedSide === "no" && row.orderStatus === "resting" && row.filledContracts === 4));
  assert.ok(rows.every((row) => row.selectedBestAskCents === 40 && row.selectedBestBidCents === 60));
  assert.ok(rows.every((row) => row.depthAt50Contracts === 30 && row.fullSizeExecutablePriceCents === 50));
  assert.ok(rows.every((row) => row.quoteAgeMs === null && row.quoteFreshness === "unavailable"));
});

test("unavailable readers save no inferred book, status, fill, or price", async () => {
  const rows: Eth420CandidateExecutionSnapshot[] = [];
  _setEth420ExecutionTelemetryReadersForTesting({
    authFetch: (async () => { throw new Error("unavailable"); }) as any,
    orderbookCapture: (async () => ({
      ticker: order.ticker, capturedAtMs: Date.now(), side: "no", limitCents: 50, rawEntryCount: 0, totalLevels: 0,
      lowestLevelCents: null, lowestLevelDollars: null, lowestLevelContractsApprox: null, highestLevelCents: null,
      highestLevelDollars: null, highestLevelContractsApprox: null, nearLimitLevels: [], depthAtOrBetterDollars: 0,
      depthAtOrBetterContracts: 0, fetchLatencyMs: 1, error: "network", rawYesDollars: [], rawNoDollars: [],
    })) as any,
  });
  try {
    await _captureEth420CandidateExecutionSnapshotForTesting(store(rows), order, 0);
  } finally {
    _setEth420ExecutionTelemetryReadersForTesting(null);
  }
  assert.equal(rows[0].orderStatus, "unavailable");
  assert.equal(rows[0].filledContracts, null);
  assert.equal(rows[0].selectedBestBidCents, null);
  assert.equal(rows[0].selectedBestAskCents, null);
  assert.equal(rows[0].depthAt50Contracts, null);
  assert.equal(rows[0].fullSizeExecutablePriceCents, null);
  assert.equal(rows[0].quoteFreshness, "unavailable");
});

test("restart marks elapsed offsets unavailable and schedules only the still-due offsets", async () => {
  const rows: Eth420CandidateExecutionSnapshot[] = [];
  const recovering = { ...order, createdAtMs: Date.now() - 12_000 };
  const recoveringStore = {
    ...store(rows),
    getEth420CandidateLiveOrder: async () => recovering,
    listRecentUnsettledEth420CandidateLiveOrders: async () => [recovering],
  };
  await resumeEth420CandidateExecutionTelemetry(recoveringStore);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(rows.map((row) => row.scheduledOffsetMs), [0, 1_000, 2_000, 5_000, 10_000]);
  assert.ok(rows.every((row) => row.observationState === "missed_on_restart"
    && row.orderStatus === "unavailable" && row.quoteFreshness === "unavailable"));
});