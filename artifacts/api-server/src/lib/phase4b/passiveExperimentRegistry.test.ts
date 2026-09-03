import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPassiveExperimentCaptures, PASSIVE_EXPERIMENTS, PROGRAM_E_EXTERNAL_SOURCES, type ProgramEExternalObservation } from "./passiveExperimentRegistry.js";
import type { Phase4BDecisionSnapshot, Phase4BMarketInterval, Phase4BReferenceObservation } from "./types.js";

const market: Phase4BMarketInterval = {
  marketId: "KXBTC15M-test", ticker: "KXBTC15M-test", series: "KXBTC15M", asset: "BTC",
  intervalStartMs: 1, intervalEndMs: 2, windowCloseMs: 2, metadataCapturedAtMs: 1, schemaVersion: "2", metadataVersion: "test",
};
const snapshot: Phase4BDecisionSnapshot = {
  snapshotId: "snapshot", marketId: market.marketId, capturedAtMs: 1, secondsLeft: 120, candidateSide: "yes",
  selectedSideReason: "test", source: "websocket", wsConnected: true, wsStale: false, lastWsMessageAgeMs: 1, bboAgeMs: 1,
  restFallbackActive: false, restFallbackReason: null, yesBid: 74, yesAsk: 75, noBid: 24, noAsk: 25, yesDerivedAsk: 76, noDerivedAsk: 26,
  yesSpreadCents: 1, noSpreadCents: 1, displayedEntryPriceCents: 75, configuredLimitCents: 75, bboDerivedLimitCents: 75,
  strategyVersion: "test", betDollars: 1, priceFloorCents: 70, priceCapCents: 95, limitBufferCents: 1, staleGapThresholdCents: 2,
  decisionClassification: "accepted", skipReason: null, quotedBboAskCents: 75, executableL2AskCents: 75, bboToL2GapCents: 0,
  preflightLatencyMs: 1, finalDecisionClassification: "submitted", finalOrderPathOutcome: "submitted", guardOutcomes: null,
  allOtherGuardsPassed: true, executableL2DepthContracts: 5, intendedContractCount: 1, intendedNotionalCents: 75,
  availableExposureDollars: 10, estimatedFeesDollars: 0, clientOrderId: null, kalshiOrderId: null, schemaVersion: "2",
};
const reference: Phase4BReferenceObservation = {
  snapshotId: snapshot.snapshotId, asset: "BTC", source: "test", referencePrice: 1, sourceTimestampMs: 1, capturedAtMs: 1,
  sourceAgeMs: 0, cacheAgeMs: 0, stale: false, error: null, return5s: 0, return15s: 0, return30s: 0, causal30sAnchorPrice: null,
  causal30sAnchorSourceTimestampMs: null, causal30sAnchorStatus: "missing", causalReferencePrice: 1, causalReferenceSourceTimestampMs: 1,
  causalReferenceAgeMs: 0, causalEvidenceStatus: "live", return60s: 0, return5m: 0, intervalToDateReturn: 0, direction: "flat",
  realizedVolatility60s: 0, realizedVolatility5m: 0, acceleration: 0, schemaVersion: "2",
};

describe("passive experiment registry", () => {
  it("enrolls every frozen program and labels unavailable source fidelity explicitly", () => {
    const captures = buildPassiveExperimentCaptures(market, snapshot, reference);
    assert.equal(captures.length, PASSIVE_EXPERIMENTS.length);
    assert.equal(captures.find((row) => row.experimentVersion === "cross-market-lead-lag-v1")?.qualification, "unavailable");
    assert.match(String(captures.find((row) => row.experimentVersion === "snapshot-order-flow-proxy-v1")?.payload.unavailableReasons), /event_feed/);
    assert.equal(captures.find((row) => row.experimentVersion === "loss-avoidance-microstructure-v1")?.payload.candidateStatus, "production_accepted");
    assert.equal("snapshotBookFetchedAtMs" in (captures[0]?.payload ?? {}), false);
    assert.equal(captures[0]?.payload.causalEvidenceStatus, "live");
  });

  it("keeps passive baseline observations out of accepted and rejected cohorts", () => {
    const baseline = buildPassiveExperimentCaptures(market, { ...snapshot, finalDecisionClassification: null }, reference);
    assert.equal(baseline[0]?.payload.candidateStatus, "not_evaluated");
  });
  it("enrolls Program E only with original source evidence available at the decision boundary", () => {
    const sources = Object.fromEntries(PROGRAM_E_EXTERNAL_SOURCES.map((source) => [source, {
      source, capturedAtMs: 1, sourceTimestampMs: 0, availabilityTimestampMs: 1, latencyMs: 1,
      availability: "available", revisionState: "original", value: 1,
    }])) as Record<string, ProgramEExternalObservation>;
    const eligible = buildPassiveExperimentCaptures(market, snapshot, reference, sources);
    assert.equal(eligible.find((row) => row.experimentVersion === "cross-market-lead-lag-v1")?.qualification, "eligible");
    const delayed = buildPassiveExperimentCaptures(market, snapshot, reference, {
      ...sources, dxy: { ...sources.dxy!, availability: "delayed" },
    });
    const programE = delayed.find((row) => row.experimentVersion === "cross-market-lead-lag-v1")!;
    assert.equal(programE.qualification, "unavailable");
    assert.equal((programE.payload.externalObservations as Record<string, { unavailableReason: string }>).dxy.unavailableReason, "delayed_observation");
  });
  it("rejects an understated reported latency instead of qualifying a shorter horizon", () => {
    const sources = Object.fromEntries(PROGRAM_E_EXTERNAL_SOURCES.map((source) => [source, {
      source, capturedAtMs: 1, sourceTimestampMs: 0, availabilityTimestampMs: 1, latencyMs: 1,
      availability: "available", revisionState: "original", value: 1,
    }])) as Record<string, ProgramEExternalObservation>;
    const captures = buildPassiveExperimentCaptures(market, snapshot, reference, {
      ...sources, cmeBtcFutures: { ...sources.cmeBtcFutures!, availabilityTimestampMs: 5_000, capturedAtMs: 5_000, latencyMs: 1 },
    });
    const externalObservations = captures.find((row) => row.experimentVersion === "cross-market-lead-lag-v1")!.payload.externalObservations;
    const evidence = (externalObservations as Record<string, {
      causal: boolean; latencyMs: number; unavailableReason: string;
    }>).cmeBtcFutures;
    assert.equal(evidence.causal, false);
    assert.equal(evidence.latencyMs, 5_000);
    assert.equal(evidence.unavailableReason, "reported_latency_does_not_match_timestamp_provenance");
  });
});