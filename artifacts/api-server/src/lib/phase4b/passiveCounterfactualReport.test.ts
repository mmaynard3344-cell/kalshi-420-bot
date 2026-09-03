import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPassiveCounterfactualReport, ENTRY_QUALITY_INTERACTION_MIN_SAMPLE } from "./passiveCounterfactualReport.js";
import { PROGRAM_E_EXTERNAL_SOURCES } from "./passiveExperimentRegistry.js";

const row = (overrides: Record<string, unknown> = {}) => ({
  experimentVersion: "loss-avoidance-microstructure-v1", captureId: "a", marketId: "m", ticker: "t", asset: "BTC",
  capturedAtMs: 1, qualification: "eligible", result: "yes" as const, settlementStatus: "settled",
  payload: { candidateSide: "yes", entryPriceCents: 80, secondsLeft: 60, finalDecisionClassification: "submitted" },
  ...overrides,
});

describe("passive counterfactual report", () => {
  it("uses only settled rows with frozen direction and price", () => {
    const report = buildPassiveCounterfactualReport([
      row(), row({ captureId: "missing-side", payload: { entryPriceCents: 80 } }),
      row({ captureId: "unsettled", result: null }),
    ]);
    assert.equal(report.programA.baseline.settledOpportunities, 1);
    assert.equal(report.programA.baseline.netPnlCents, 20);
  });
  it("does not invent exit paths or external source evidence", () => {
    const report = buildPassiveCounterfactualReport([row()]);
    assert.match(report.programB.unavailableReason, /post-entry bid path/);
    assert.match(report.programE.unavailableReason ?? "", /no capture has all required/);
  });
  it("keeps interactions unavailable before the predeclared threshold", () => {
    const report = buildPassiveCounterfactualReport([row({ experimentVersion: "entry-quality-segmentation-v1" })]);
    assert.equal(report.programC.interactions.minimumSamplePerInteraction, ENTRY_QUALITY_INTERACTION_MIN_SAMPLE);
    assert.equal(report.programC.interactions.status, "unavailable");
  });
  it("reports a Program E horizon only when all source observations are causal within its latency budget", () => {
    const externalObservations = Object.fromEntries(PROGRAM_E_EXTERNAL_SOURCES.map((source) => [source, {
      source, causal: true, capturedAtMs: 1, sourceTimestampMs: 0, availabilityTimestampMs: 1, latencyMs: 5_000,
      availability: "available", revisionState: "original", value: 1, unavailableReason: null,
    }]));
    const report = buildPassiveCounterfactualReport([row({
      experimentVersion: "cross-market-lead-lag-v1", payload: { candidateSide: "yes", entryPriceCents: 80, externalObservations },
    })]);
    assert.equal(report.programE.frozenHorizons.find((horizon) => horizon.seconds === 1)?.eligible, false);
    assert.equal(report.programE.frozenHorizons.find((horizon) => horizon.seconds === 5)?.eligible, true);
    assert.equal(report.programE.unavailableReason, null);
  });
});