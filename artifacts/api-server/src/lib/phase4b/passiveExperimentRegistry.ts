/**
 * Passive experiment enrollment only. This module deliberately accepts frozen
 * Phase 4B evidence and emits research rows; it has no execution dependencies.
 */
import type { Phase4BDecisionSnapshot, Phase4BMarketInterval, Phase4BReferenceObservation } from "./types.js";

export const PASSIVE_EXPERIMENT_SCHEMA_VERSION = "passive-experiment-registry-v2";
export const PROGRAM_E_EXTERNAL_SOURCES = [
  "cmeBtcFutures", "equityFutures", "treasuryYields", "dxy", "macroEvents",
] as const;
export const PROGRAM_E_FROZEN_HORIZONS_SECONDS = [1, 5, 10, 15, 30, 60, 120] as const;
export type ProgramEExternalSource = typeof PROGRAM_E_EXTERNAL_SOURCES[number];
export type ProgramEExternalObservation = {
  source: ProgramEExternalSource;
  capturedAtMs: number | null;
  sourceTimestampMs: number | null;
  availabilityTimestampMs: number | null;
  latencyMs: number | null;
  availability: "available" | "delayed" | "missing";
  revisionState: "original" | "revised" | "unknown";
  value: number | string | null;
};
export type ProgramEExternalEvidence = ProgramEExternalObservation & {
  causal: boolean;
  unavailableReason: string | null;
};

type Definition = { experimentVersion: string; program: string; name: string; config: Record<string, unknown> };
export type PassiveExperimentCapture = {
  captureId: string; experimentVersion: string; snapshotId: string; marketId: string; ticker: string; asset: string;
  capturedAtMs: number; qualification: "eligible" | "unavailable"; payload: Record<string, unknown>; schemaVersion: string;
};

// Versioned descriptors are intentionally additive. Changing a hypothesis means
// adding a new descriptor, never changing an existing definition.
export const PASSIVE_EXPERIMENTS: readonly Definition[] = [
  ["loss-avoidance-microstructure-v1", "A", "loss avoidance / abstention"],
  ["shadow-exits-ladder-v1", "B", "independent hypothetical exit ladder"],
  ["entry-quality-segmentation-v1", "C", "entry quality segmentation"],
  ["predictive-edge-checkpoints-v1", "D", "predictive edge checkpoints"],
  ["cross-market-lead-lag-v1", "E", "cross-market lead lag and macro regime"],
  ["snapshot-order-flow-proxy-v1", "F", "snapshot microstructure proxy"],
  ["volatility-regime-v1", "G", "volatility regime classification"],
  ["cross-exchange-disagreement-v1", "H", "cross-exchange disagreement"],
  ["opportunity-selectivity-v1", "I", "top-n opportunity selectivity"],
  ["loss-clustering-cooldown-v1", "J", "loss clustering and shadow cooldown"],
].map(([experimentVersion, program, name]) => ({
  experimentVersion, program, name,
  config: { frozenAtCapture: true, passiveOnly: true, externalSources: "explicitly_unavailable_when_absent" },
}));

function featureSnapshot(snapshot: Phase4BDecisionSnapshot, reference: Phase4BReferenceObservation) {
  return {
    candidateStatus: snapshot.finalDecisionClassification == null
      ? "not_evaluated"
      : snapshot.finalDecisionClassification === "submitted" || snapshot.finalDecisionClassification === "eligible_for_preflight"
        ? "production_accepted" : "production_rejected",
    finalDecisionClassification: snapshot.finalDecisionClassification,
    guardOutcomes: snapshot.guardOutcomes,
    entryPriceCents: snapshot.displayedEntryPriceCents,
    secondsLeft: snapshot.secondsLeft,
    bboToL2GapCents: snapshot.bboToL2GapCents,
    bboSpreadCents: snapshot.candidateSide === "yes" ? snapshot.yesSpreadCents : snapshot.noSpreadCents,
    // A later asynchronous L2 fetch must never be substituted for state at the
    // decision boundary. Only preflight fields already frozen on the snapshot
    // are suitable here; periodic-book outcomes remain Phase 4B raw evidence.
    preflightExecutableDepthContracts: snapshot.executableL2DepthContracts,
    referenceSource: reference.source,
    referenceSourceTimestampMs: reference.sourceTimestampMs,
    referenceCapturedAtMs: reference.capturedAtMs,
    referenceStale: reference.stale,
    referenceError: reference.error,
    causalEvidenceStatus: reference.causalEvidenceStatus,
    causalReferenceSourceTimestampMs: reference.causalReferenceSourceTimestampMs,
    referenceReturn5s: reference.return5s,
    referenceReturn15s: reference.return15s,
    referenceReturn30s: reference.return30s,
    referenceReturn60s: reference.return60s,
    realizedVolatility60s: reference.realizedVolatility60s,
    realizedVolatility5m: reference.realizedVolatility5m,
    acceleration: reference.acceleration,
  };
}

function externalEvidenceAtCapture(
  source: ProgramEExternalSource,
  observation: ProgramEExternalObservation | undefined,
  decisionCapturedAtMs: number,
): ProgramEExternalEvidence {
  const base: ProgramEExternalObservation = observation ?? {
    source, capturedAtMs: null, sourceTimestampMs: null, availabilityTimestampMs: null, latencyMs: null,
    availability: "missing", revisionState: "unknown", value: null,
  };
  const finite = (value: number | null) => value != null && Number.isFinite(value);
  const timestampMissing = !finite(base.capturedAtMs) || !finite(base.sourceTimestampMs) || !finite(base.availabilityTimestampMs) || !finite(base.latencyMs);
  const derivedLatencyMs = !timestampMissing ? base.availabilityTimestampMs! - base.sourceTimestampMs! : null;
  const unavailableReason =
    base.source !== source ? "source_identity_mismatch" :
    base.availability === "missing" ? "missing_observation" :
    base.availability === "delayed" ? "delayed_observation" :
    base.revisionState !== "original" ? "revised_or_unknown_observation" :
    timestampMissing ? "missing_timestamp_or_latency_provenance" :
    derivedLatencyMs! < 0 ? "source_timestamp_after_availability" :
    base.latencyMs! !== derivedLatencyMs ? "reported_latency_does_not_match_timestamp_provenance" :
    base.sourceTimestampMs! > base.availabilityTimestampMs! ? "source_timestamp_after_availability" :
    base.availabilityTimestampMs! > base.capturedAtMs! ? "availability_after_capture" :
    base.capturedAtMs! > decisionCapturedAtMs ? "captured_after_decision_boundary" :
    base.sourceTimestampMs! > decisionCapturedAtMs ? "source_timestamp_after_decision_boundary" :
    null;
  return { ...base, source, latencyMs: derivedLatencyMs, causal: unavailableReason == null, unavailableReason };
}

export function buildPassiveExperimentCaptures(
  market: Phase4BMarketInterval, snapshot: Phase4BDecisionSnapshot, reference: Phase4BReferenceObservation,
  externalObservations: Partial<Record<ProgramEExternalSource, ProgramEExternalObservation>> = {},
): readonly PassiveExperimentCapture[] {
  const common = featureSnapshot(snapshot, reference);
  return PASSIVE_EXPERIMENTS.map((definition) => {
    const externalUnavailable = definition.program === "E";
    const snapshotProxy = definition.experimentVersion === "snapshot-order-flow-proxy-v1";
    const externalEvidence = externalUnavailable
      ? Object.fromEntries(PROGRAM_E_EXTERNAL_SOURCES.map((source) => [
        source, externalEvidenceAtCapture(source, externalObservations[source], snapshot.capturedAtMs),
      ])) as Record<ProgramEExternalSource, ProgramEExternalEvidence>
      : undefined;
    const unavailableReasons = [
      ...(externalEvidence && Object.values(externalEvidence).some((evidence) => !evidence.causal)
        ? ["external_source_evidence_not_causal_at_capture"] : []),
      ...(snapshotProxy ? ["true_aggressive_flow_cancel_and_replenishment_unavailable_without_event_feed"] : []),
    ];
    return {
      captureId: `${snapshot.snapshotId}:${definition.experimentVersion}`,
      experimentVersion: definition.experimentVersion, snapshotId: snapshot.snapshotId, marketId: market.marketId,
      ticker: market.ticker, asset: market.asset, capturedAtMs: snapshot.capturedAtMs,
      qualification: unavailableReasons.length ? "unavailable" : "eligible",
      payload: { ...common, unavailableReasons, externalObservations: externalEvidence,
        microstructureFidelity: snapshotProxy ? "periodic_l2_snapshot_proxy_only" : undefined },
      schemaVersion: PASSIVE_EXPERIMENT_SCHEMA_VERSION,
    };
  });
}