import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPassiveProgramReadiness } from "./passiveProgramReadiness.js";

describe("passive program readiness", () => {
  it("never auto-promotes and explains missing Program E sources", () => {
    const report = buildPassiveProgramReadiness([{
      experimentVersion: "loss-avoidance-microstructure-v1", capturedCount: 40, eligibleCount: 40, unavailableCount: 0,
      settledCount: 35, firstCapturedAtMs: 1, lastCapturedAtMs: 2, staleReferenceCount: 0, referenceErrorCount: 0,
    }], { programA: { unavailableReason: null } }, {}, 3);
    assert.equal(report.researchOnly, true);
    assert.equal(report.programs.every((program) => program.promotionEligible === false), true);
    const external = report.programs.find((program) => program.program === "E")!;
    assert.match(external.blockers.join(" "), /CME/);
    assert.equal(report.externalSourceHealth.frozenHorizons.every((horizon) => !horizon.eligible), true);
  });
  it("keeps uncaptured programs at a non-promotional stage", () => {
    const report = buildPassiveProgramReadiness([], {}, {}, 3);
    assert.equal(report.programs.find((program) => program.program === "B")?.promotionStage, "retrospective_screen");
  });
  it("reflects causal Program E source and horizon eligibility without promotion", () => {
    const report = buildPassiveProgramReadiness([{
      experimentVersion: "cross-market-lead-lag-v1", capturedCount: 1, eligibleCount: 1, unavailableCount: 0,
      settledCount: 0, firstCapturedAtMs: 1, lastCapturedAtMs: 1, staleReferenceCount: 0, referenceErrorCount: 0,
    }], { programE: {
      frozenHorizons: [{ seconds: 1, eligible: true, reason: null }],
      externalSourceHealth: [{ source: "cmeBtcFutures", state: "causal", availabilityTimestampMs: 1, sourceTimestampMs: 0, latencyMs: 1, revisionState: "original", insufficiencyReason: null }],
    } }, {}, 3);
    assert.equal(report.programs.find((program) => program.program === "E")?.promotionStage, "frozen_prospective_shadow");
    assert.equal(report.externalSourceHealth.frozenHorizons.find((horizon) => horizon.seconds === 1)?.eligible, true);
    const sources = report.externalSourceHealth.sources as unknown as Array<{ source: string; state: string }>;
    assert.equal(sources.find((source) => source.source === "cmeBtcFutures")?.state, "causal");
  });
});