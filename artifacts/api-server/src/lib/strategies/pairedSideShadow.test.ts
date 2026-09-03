import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPairedSidePayload, refreshPairedSideSettlementOutcomes, summarizePairedSideStudy, PAIRED_SIDE_STUDY_VERSION,
  type PairedSideSettlementStore,
} from "./pairedSideShadow.js";
import type { Eth30PositionEventParams, Eth30ShadowObservationParams } from "../tradeStore.js";

test("paired-side capture preserves complementary boundary legs and only earlier evidence", () => {
  const first = buildPairedSidePayload({
    ticker: "KXETH15M-TEST", observedAtMs: 1_000, sourceTimestampMs: 999,
    yes: { priceCents: 20, depthContracts: 4 }, no: { priceCents: 80, depthContracts: 2 },
  }, null);
  assert.equal(first.candidateStatus, "candidate_with_executable_depth");
  assert.equal(first.firstObservedReprice, "no_change");
  const second = buildPairedSidePayload({
    ticker: "KXETH15M-TEST", observedAtMs: 6_000, sourceTimestampMs: 5_999,
    yes: { priceCents: 21, depthContracts: 4 }, no: { priceCents: 80, depthContracts: 2 },
  }, first);
  assert.equal(second.firstObservedReprice, "cheap_side");
  assert.equal(second.leadLagDurationMs, 5_000);
  assert.equal(second.settlementLabel, null);
});

test("paired-side summary retains freshness failures as evidence and never becomes actionable", () => {
  const row = { id: "x", ticker: "KXETH15M-TEST", observedAtMs: 1_000, payloadJson: JSON.stringify({
    studyVersion: PAIRED_SIDE_STUDY_VERSION, ticker: "KXETH15M-TEST", observedAtMs: 1_000,
    candidateStatus: "candidate_with_executable_depth", firstObservedReprice: "expensive_side",
  }) };
  const report = summarizePairedSideStudy([row], [{ ticker: row.ticker, decision: "paired_freshness_failed", occurredAtMs: 2_000 }]);
  assert.equal(report.executionLabels.freshnessFailure, 1);
  assert.equal(report.repricingLeadCounts.expensiveSide, 1);
  assert.equal(report.actionable, false);
});

test("one durable decision labels only the nearest eligible capture", () => {
  const observation = (id: string, at: number, candidate: boolean) => ({ id, ticker: "KXETH15M-TEST", observedAtMs: at, payloadJson: JSON.stringify({
    studyVersion: PAIRED_SIDE_STUDY_VERSION, ticker: "KXETH15M-TEST", observedAtMs: at,
    candidateStatus: candidate ? "candidate_with_executable_depth" : "not_candidate_or_depth_unavailable", firstObservedReprice: "no_change",
  }) });
  const report = summarizePairedSideStudy([
    observation("candidate-old", 1_000, true), observation("non-candidate-near", 9_000, false), observation("candidate-near", 10_000, true),
  ], [{ ticker: "KXETH15M-TEST", decision: "paired_freshness_failed", occurredAtMs: 11_000 }]);
  assert.equal(report.executionLabels.freshnessFailure, 1);
  assert.equal(report.executionLabels.unlabeled, 1);
});

test("authoritative settlement appends labels for every immutable paired quote and summary counts only candidates", async () => {
  const ticker = "KXETH15M-TEST";
  const observations: Eth30ShadowObservationParams[] = ["candidate", "non-candidate"].map((id, index) => ({
    id, ticker, observedAtMs: 1_000 + index * 1_000, payloadJson: JSON.stringify({
      studyVersion: PAIRED_SIDE_STUDY_VERSION, observationKind: "paired_side_quote", ticker,
      observedAtMs: 1_000 + index * 1_000,
      candidateStatus: index === 0 ? "candidate_with_executable_depth" : "not_candidate_or_depth_unavailable",
      firstObservedReprice: "no_change", settlementLabel: null,
    }),
  }));
  const events: Eth30PositionEventParams[] = [{
    id: `${ticker}:settlement`, ticker, easternDate: "2026-08-26", eventType: "settlement",
    contractsDelta: -1, contractsAfter: 0, strategyOrderId: null, fillPriceCents: null, feeCents: null,
    settlementResult: "no", note: "authoritative settlement", occurredAtMs: 5_000,
  }];
  const store: PairedSideSettlementStore = {
    listEth30ShadowObservations: async () => observations,
    listEth30PositionEvents: async () => events,
    insertEth30ShadowObservation: async (row) => {
      if (observations.some((existing) => existing.id === row.id)) return false;
      observations.push(row);
      return true;
    },
  };

  await refreshPairedSideSettlementOutcomes(store, ticker);
  await refreshPairedSideSettlementOutcomes(store, ticker);

  assert.equal(observations.length, 4, "one idempotent outcome row is appended per original quote");
  assert.equal(JSON.parse(observations[2]!.payloadJson).settlementLabel, "no");
  assert.equal(JSON.parse(observations[3]!.payloadJson).copiedFromObservationId, "non-candidate");
  const report = summarizePairedSideStudy(observations, []);
  assert.equal(report.observations, 2, "outcome projections do not inflate collection volume");
  assert.equal(report.settledOutcomes, 1, "only a labeled executable candidate counts as settled");
});

test("paired settlement projection ignores missing or non-authoritative settlement labels", async () => {
  const ticker = "KXETH15M-TEST";
  const observations: Eth30ShadowObservationParams[] = [{
    id: "candidate", ticker, observedAtMs: 1_000, payloadJson: JSON.stringify({
      studyVersion: PAIRED_SIDE_STUDY_VERSION, observationKind: "paired_side_quote", ticker, observedAtMs: 1_000,
      candidateStatus: "candidate_with_executable_depth", firstObservedReprice: "no_change",
    }),
  }];
  const store: PairedSideSettlementStore = {
    listEth30ShadowObservations: async () => observations,
    listEth30PositionEvents: async () => [],
    insertEth30ShadowObservation: async (row) => { observations.push(row); return true; },
  };
  await refreshPairedSideSettlementOutcomes(store, ticker);
  assert.equal(observations.length, 1);
  assert.equal(summarizePairedSideStudy(observations, []).settledOutcomes, 0);
});

test("paired settlement projection includes legacy quotes but never labels a post-settlement capture", async () => {
  const ticker = "KXETH15M-TEST";
  const observations: Eth30ShadowObservationParams[] = [
    { id: "legacy", ticker, observedAtMs: 1_000, payloadJson: JSON.stringify({
      studyVersion: PAIRED_SIDE_STUDY_VERSION, ticker, observedAtMs: 1_000,
      candidateStatus: "candidate_with_executable_depth", firstObservedReprice: "no_change",
    }) },
    { id: "late", ticker, observedAtMs: 3_000, payloadJson: JSON.stringify({
      studyVersion: PAIRED_SIDE_STUDY_VERSION, observationKind: "paired_side_quote", ticker, observedAtMs: 3_000,
      candidateStatus: "candidate_with_executable_depth", firstObservedReprice: "no_change",
    }) },
  ];
  const store: PairedSideSettlementStore = {
    listEth30ShadowObservations: async () => observations,
    listEth30PositionEvents: async () => [{
      id: `${ticker}:settlement`, ticker, easternDate: "2026-08-26", eventType: "settlement",
      contractsDelta: -1, contractsAfter: 0, strategyOrderId: null, fillPriceCents: null, feeCents: null,
      settlementResult: "yes", note: "authoritative settlement", occurredAtMs: 2_000,
    }],
    insertEth30ShadowObservation: async (row) => { observations.push(row); return true; },
  };
  await refreshPairedSideSettlementOutcomes(store, ticker);
  assert.equal(observations.length, 3);
  assert.equal(JSON.parse(observations[2]!.payloadJson).copiedFromObservationId, "legacy");
  assert.equal(summarizePairedSideStudy(observations, []).settledOutcomes, 1);
});