import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEth420CandidateHistoryResponse,
  buildEth420LiveMarketResponse,
  loadEth420CandidateHistoryData,
  type Eth420CandidateHistoryLoaders,
  type Eth420LiveMarketTelemetry,
} from "./trade.js";
import type { CurrentEthMarketSnapshot } from "../lib/autoTrader.js";
import { ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS } from "../lib/strategies/eth420SixStepCandidate.js";

const nowMs = Date.parse("2026-08-30T12:05:00.000Z");
const snapshot: CurrentEthMarketSnapshot = {
  ticker: "KXETH15M-26AUG301200-00",
  exchangeIndex: 3,
  openTime: "2026-08-30T12:00:00.000Z",
  closeTime: "2026-08-30T12:15:00.000Z",
  status: "active",
  yesBid: 49,
  yesAsk: 51,
  noBid: 49,
  noAsk: 51,
  floorStrike: 3_420.5,
  quoteUpdatedAtMs: nowMs - 1_000,
  rulesObservedAtMs: nowMs - 1_000,
};

const validTelemetry: Eth420LiveMarketTelemetry = {
  ticker: snapshot.ticker,
  observedAtMs: nowMs - 1_000,
  floorStrike: snapshot.floorStrike,
  payloadJson: JSON.stringify({
    schemaVersion: 2,
    validAdjacentMove: true,
    priorFloorStrike: 3_400,
    openTimeMs: Date.parse(snapshot.openTime!),
    priorOpenTimeMs: Date.parse(snapshot.openTime!) - 900_000,
    currentMove: (3_420.5 - 3_400) / 3_400,
  }),
};

describe("ETH 420 live-market evidence response", () => {
  it("reports unavailable full-ledger P&L without dropping bounded recent orders", async () => {
    const recentOrder = {
      id: "bounded-recent-order",
      status: "reserved",
    } as Awaited<ReturnType<Eth420CandidateHistoryLoaders["listOrders"]>>["orders"][number];
    const loaders: Eth420CandidateHistoryLoaders = {
      listEntries: async () => [],
      getState: async () => null,
      listOrders: async (limit) => {
        assert.equal(limit, 100, "recent order history remains bounded");
        return { available: true, orders: [recentOrder] };
      },
      listTelemetry: async () => [],
      listDailyPnl: async () => { throw new Error("database unavailable"); },
    };

    const data = await loadEth420CandidateHistoryData(500, nowMs, loaders);
    const response = buildEth420CandidateHistoryResponse(data);

    assert.deepEqual(response["dailyPnl"], { available: false, rows: [] },
      "an unreadable full ledger must not look like a zero-total day");
    assert.deepEqual(response["orders"], [recentOrder],
      "recent-order history remains available independently of the aggregate");
    assert.deepEqual(response["ordersAvailability"], { available: true });
  });

  it("reports unavailable recent-order storage without hiding readable dashboard sections", async () => {
    const entry = { id: "counterfactual-entry" } as Awaited<ReturnType<Eth420CandidateHistoryLoaders["listEntries"]>>[number];
    const telemetry = [{
      ...validTelemetry,
      id: "telemetry-evidence",
      easternDate: "2026-08-30",
    }];
    const dailyPnl = { available: true, rows: [] };
    const loaders: Eth420CandidateHistoryLoaders = {
      listEntries: async () => [entry],
      getState: async () => null,
      listOrders: async () => { throw new Error("recent order storage unavailable"); },
      listTelemetry: async () => telemetry,
      listDailyPnl: async () => dailyPnl,
    };

    const response = buildEth420CandidateHistoryResponse(
      await loadEth420CandidateHistoryData(100, nowMs, loaders),
    );

    assert.deepEqual(response["orders"], []);
    assert.deepEqual(response["ordersAvailability"], { available: false },
      "unreadable recent orders must not look like an empty history");
    assert.deepEqual(response["entries"], [entry],
      "counterfactual entries remain readable independently");
    assert.deepEqual(response["dailyPnl"], dailyPnl,
      "daily P&L remains readable independently");
    assert.equal((response["operationalStatus"] as { telemetry: { validObservationCount: number } })
      .telemetry.validObservationCount, 1, "telemetry remains readable independently");
  });

  it("alerts only when a finalized unresolved candidate exceeds the reconciliation threshold", () => {
    const finalizedOrder = {
      id: "finalized-unsettled", ticker: "KXETH15M-26AUG301200-00", status: "terminal_recovered",
      settlementResult: null, finalizedAtMs: nowMs - ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS,
      lastRecoveryOutcome: "economics_incomplete",
    } as Awaited<ReturnType<Eth420CandidateHistoryLoaders["listOrders"]>>["orders"][number];
    const response = buildEth420CandidateHistoryResponse({
      entries: [], state: null, recentOrders: { available: true, orders: [finalizedOrder] }, telemetry: [],
      dailyPnl: { available: true, rows: [] },
    }, nowMs);
    assert.deepEqual(response["finalizedReconciliation"], {
      available: true,
      thresholdMs: ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS,
      alerts: [{
        ticker: "KXETH15M-26AUG301200-00",
        latestRecoveryOutcome: "economics_incomplete",
        finalizedAtMs: nowMs - ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS,
        ageMs: ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS,
        nextSafeAction: "await_automatic_reconciliation",
      }],
    });
  });

  it("does not alert before finalization or after settlement", () => {
    const response = buildEth420CandidateHistoryResponse({
      entries: [], state: null, telemetry: [], dailyPnl: { available: true, rows: [] },
      recentOrders: {
        available: true,
        orders: [
          { id: "not-finalized", ticker: "KXETH15M-not-finalized", status: "submitted", settlementResult: null } as any,
          { id: "settled", ticker: "KXETH15M-settled", status: "settled", settlementResult: "yes", finalizedAtMs: 0 } as any,
        ],
      },
    }, nowMs);
    assert.deepEqual((response["finalizedReconciliation"] as { alerts: unknown[] }).alerts, []);
  });

  it("returns fresh matching BBO, spreads, strike, and adjacent move through its read-only loader", async () => {
    let telemetryReads = 0;
    const response = await buildEth420LiveMarketResponse(snapshot, async (afterMs) => {
      telemetryReads++;
      assert.equal(afterMs, Date.parse(snapshot.openTime!));
      return [validTelemetry];
    }, nowMs);

    assert.equal(telemetryReads, 1, "the endpoint only reads durable telemetry");
    assert.deepEqual(response, {
      generatedAtMs: nowMs,
      readOnly: true,
      availability: { status: "fresh", reason: null, quoteAgeMs: 1_000 },
      market: {
        ticker: snapshot.ticker, exchangeIndex: 3, openTime: snapshot.openTime,
        closeTime: snapshot.closeTime, status: "active", quoteUpdatedAtMs: nowMs - 1_000,
      },
      evidence: {
        yesBid: 49, yesAsk: 51, noBid: 49, noAsk: 51,
        yesSpreadCents: 2, noSpreadCents: 2, floorStrike: 3_420.5,
        adjacentMove: (3_420.5 - 3_400) / 3_400,
      },
      adjacentMoveAvailability: { status: "fresh", reason: null },
    });
  });

  it("withholds all evidence once a later quote is stale without reading telemetry", async () => {
    let telemetryReads = 0;
    const response = await buildEth420LiveMarketResponse(
      { ...snapshot, quoteUpdatedAtMs: nowMs - 20_001 },
      async () => { telemetryReads++; return [validTelemetry]; },
      nowMs,
    );

    assert.equal(telemetryReads, 0);
    assert.equal((response.availability as { status: string }).status, "stale");
    assert.equal(response.evidence, null);
    assert.equal(response.readOnly, true);
  });

  it("keeps fresh quote and strike evidence when adjacent telemetry is absent", async () => {
    const response = await buildEth420LiveMarketResponse(snapshot, async () => [], nowMs);

    assert.deepEqual(response.availability, { status: "fresh", reason: null, quoteAgeMs: 1_000 });
    assert.deepEqual(response.adjacentMoveAvailability, {
      status: "unavailable", reason: "validated_adjacent_move_not_current",
    });
    assert.deepEqual(response.evidence, {
      yesBid: 49, yesAsk: 51, noBid: 49, noAsk: 51,
      yesSpreadCents: 2, noSpreadCents: 2, floorStrike: 3_420.5,
      adjacentMove: null,
    });
  });

  it("keeps fresh quote and strike evidence when adjacent telemetry mismatches the market", async () => {
    const response = await buildEth420LiveMarketResponse(
      snapshot,
      async () => [{ ...validTelemetry, floorStrike: 3_419.5 }],
      nowMs,
    );

    assert.deepEqual(response.availability, { status: "fresh", reason: null, quoteAgeMs: 1_000 });
    assert.deepEqual(response.adjacentMoveAvailability, {
      status: "unavailable", reason: "validated_adjacent_move_not_current",
    });
    assert.equal((response.evidence as { adjacentMove: number | null }).adjacentMove, null);
    assert.equal((response.evidence as { floorStrike: number }).floorStrike, 3_420.5);
    assert.equal(response.readOnly, true);
  });

  it("keeps fresh quote and strike evidence when adjacent telemetry storage is unavailable", async () => {
    const response = await buildEth420LiveMarketResponse(
      snapshot,
      async () => { throw new Error("database unavailable"); },
      nowMs,
    );

    assert.deepEqual(response.availability, { status: "fresh", reason: null, quoteAgeMs: 1_000 });
    assert.deepEqual(response.adjacentMoveAvailability, {
      status: "unavailable", reason: "current_adjacent_move_evidence_unavailable",
    });
    assert.equal((response.evidence as { adjacentMove: number | null }).adjacentMove, null);
  });
});