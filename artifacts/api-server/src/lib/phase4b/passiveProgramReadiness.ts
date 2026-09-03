/** Pure presentation model for passive research. It has no execution imports. */
import { PASSIVE_EXPERIMENTS, PROGRAM_E_EXTERNAL_SOURCES, PROGRAM_E_FROZEN_HORIZONS_SECONDS } from "./passiveExperimentRegistry.js";

export type PassiveProgramStatusRow = {
  experimentVersion: string; capturedCount: number; eligibleCount: number; unavailableCount: number;
  settledCount: number; firstCapturedAtMs: number | null; lastCapturedAtMs: number | null;
  staleReferenceCount: number; referenceErrorCount: number;
};

const MIN_ADEQUATE_SETTLED = 30;
const nameFor = new Map(PASSIVE_EXPERIMENTS.map((item) => [item.experimentVersion, item]));
const counterfactualFor = (version: string, report: Record<string, unknown>) =>
  version === "loss-avoidance-microstructure-v1" ? report["programA"] :
  version === "shadow-exits-ladder-v1" ? report["programB"] :
  version === "entry-quality-segmentation-v1" ? report["programC"] :
  version === "cross-market-lead-lag-v1" ? report["programE"] : null;

export function buildPassiveProgramReadiness(
  rows: readonly PassiveProgramStatusRow[],
  counterfactual: Record<string, unknown>,
  collectorHealth: Record<string, unknown> = {},
  generatedAtMs = Date.now(),
) {
  const byVersion = new Map(rows.map((row) => [row.experimentVersion, row]));
  const programs = PASSIVE_EXPERIMENTS.map((definition) => {
    const row = byVersion.get(definition.experimentVersion) ?? {
      experimentVersion: definition.experimentVersion, capturedCount: 0, eligibleCount: 0, unavailableCount: 0,
      settledCount: 0, firstCapturedAtMs: null, lastCapturedAtMs: null, staleReferenceCount: 0, referenceErrorCount: 0,
    };
    const counterfactualResult = counterfactualFor(definition.experimentVersion, counterfactual) as Record<string, unknown> | null;
    const programE = definition.program === "E" ? counterfactualResult : null;
    const programEHorizons = Array.isArray(programE?.["frozenHorizons"]) ? programE["frozenHorizons"] as Record<string, unknown>[] : [];
    const programEHasEligibleHorizon = programEHorizons.some((horizon) => horizon["eligible"] === true);
    const explicitUnavailable = (definition.program === "E" && !programEHasEligibleHorizon) || row.eligibleCount === 0;
    const stage = explicitUnavailable ? "retrospective_screen"
      : row.settledCount < MIN_ADEQUATE_SETTLED ? "frozen_prospective_shadow"
      : counterfactualResult && counterfactualResult["unavailableReason"] == null ? "counterfactual_pnl_drawdown"
      : "adequate_sample";
    const blockers = [
      ...(row.capturedCount === 0 ? ["no prospective captures yet"] : []),
      ...(row.eligibleCount === 0 ? ["no eligible timestamp-safe source evidence"] : []),
      ...(row.settledCount < MIN_ADEQUATE_SETTLED ? [`${MIN_ADEQUATE_SETTLED - row.settledCount} more settled eligible observations needed`] : []),
      ...(definition.program === "B" ? ["post-entry executable exit path and recovery evidence not retained"] : []),
       ...(definition.program === "E" && !programEHasEligibleHorizon
         ? ["no frozen horizon has causal CME, equity futures, Treasury, DXY, and macro-release inputs"] : []),
      ...(definition.experimentVersion === "snapshot-order-flow-proxy-v1" ? ["event-level cancel/aggression/replenishment feed unavailable"] : []),
    ];
    return {
      program: definition.program, name: definition.name, experimentVersion: definition.experimentVersion, immutableConfig: definition.config,
      firstCapturedAtMs: row.firstCapturedAtMs, lastCapturedAtMs: row.lastCapturedAtMs,
      sample: { captured: row.capturedCount, eligible: row.eligibleCount, settled: row.settledCount },
      sourceHealth: { unavailable: row.unavailableCount, staleReference: row.staleReferenceCount, referenceErrors: row.referenceErrorCount },
      promotionStage: stage, promotionLadder: ["retrospective_screen", "frozen_prospective_shadow", "adequate_sample", "counterfactual_pnl_drawdown", "independent_replication", "production_consideration"],
      promotionEligible: false, blockers,
      observedFacts: counterfactualResult, inference: "No causal or production conclusion is made by this report.",
      speculation: "None. No automatic promotion, ranking, cooldown, guard, or order action is enabled.",
    };
  });
  const ranked = programs.flatMap((program) => {
    const evidence = program.observedFacts as Record<string, unknown> | null;
    const cohort = evidence?.["cohorts"] && Array.isArray(evidence["cohorts"])
      ? (evidence["cohorts"] as Record<string, unknown>[]).find((item) => item["label"] === "production_rejected") : null;
    const pnl = cohort?.["counterfactualNetPnlChangeCents"];
    const drawdown = cohort?.["drawdownChangeCents"];
    return typeof pnl === "number" && typeof drawdown === "number"
      ? [{ program: program.program, experimentVersion: program.experimentVersion, counterfactualNetPnlChangeCents: pnl,
        drawdownChangeCents: drawdown, evidence: "one-contract settlement-only; no fill or fee inference" }] : [];
  }).sort((a, b) => b.counterfactualNetPnlChangeCents - a.counterfactualNetPnlChangeCents);
  const reportProgramE = counterfactual["programE"] as Record<string, unknown> | undefined;
  const sourceByName = new Map((Array.isArray(reportProgramE?.["externalSourceHealth"]) ? reportProgramE["externalSourceHealth"] : [])
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item) => [item["source"], item]));
  const horizonBySeconds = new Map((Array.isArray(reportProgramE?.["frozenHorizons"]) ? reportProgramE["frozenHorizons"] : [])
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item) => [item["seconds"], item]));
  const externalSources = PROGRAM_E_EXTERNAL_SOURCES.map((source) => ({
    ...(sourceByName.get(source) ?? {
      source, state: "unavailable", availabilityTimestampMs: null, sourceTimestampMs: null,
      latencyMs: null, revisionState: "unknown", insufficiencyReason: "no timestamped source observation is retained",
    }),
    assessedAtMs: generatedAtMs,
  }));
  const frozenHorizons = PROGRAM_E_FROZEN_HORIZONS_SECONDS.map((seconds) => horizonBySeconds.get(seconds) ?? ({
    seconds, eligible: false, reason: "required external sources are unavailable or lack timestamp/latency/revision provenance",
  }));
  const inventory: Array<{
    category: string; identifier: string; purpose: string; status: string; versionOrFrozenStart: string;
    observations: number | null; settledOutcomes: number | null; preliminaryResult: string; limitations: string[];
    actionable: boolean; nextMilestone: string;
  }> = [
    ...programs.map((program) => ({
      category: "active_prospective", identifier: program.experimentVersion, purpose: program.name,
      status: program.promotionStage, versionOrFrozenStart: program.experimentVersion,
      observations: program.sample.captured, settledOutcomes: program.sample.settled,
      preliminaryResult: "Observed evidence only; no production conclusion.", limitations: program.blockers,
      actionable: false, nextMilestone: program.blockers[0] ?? "Independent replication required.",
    })),
    {
      category: "telemetry_only", identifier: "compact-normalized-distance-prospective-v2",
      purpose: "Frozen normalized-distance, lag, breakout, and range telemetry.", status: "active_collection",
      versionOrFrozenStart: "frozen prospective v2", observations: null, settledOutcomes: null,
      preliminaryResult: "Collection retained separately from strategy decisions.", limitations: ["status is collector-level; not an outcome claim"],
      actionable: false, nextMilestone: "Complete predeclared out-of-sample cohort.",
    },
    {
      category: "telemetry_only", identifier: "mandelbrot-instability / fold-the-ace",
      purpose: "Outcome-blind instability and abstention hypothesis collection.", status: "active_research_only",
      versionOrFrozenStart: "frozen definitions", observations: null, settledOutcomes: null,
      preliminaryResult: "No live threshold or abstention change is authorized.", limitations: ["outcome-blind/frozen protocol"],
      actionable: false, nextMilestone: "Meet pre-registered stage gates.",
    },
    {
      category: "archived_or_retrospective", identifier: "archived Phase 4B replay and loss-forensics reports",
      purpose: "Historical BBO/L2 disagreement, ACE, regime, and loss-forensics studies.", status: "archived_descriptive",
      versionOrFrozenStart: "report-specific frozen exports", observations: null, settledOutcomes: null,
      preliminaryResult: "Descriptive reports retained; not live inputs.", limitations: ["retrospective evidence is not prospective validation"],
      actionable: false, nextMilestone: "Replicate prospectively with frozen cohorts.",
    },
  ];
  const paired = collectorHealth["pairedSideLeadLag"] as Record<string, unknown> | undefined;
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  if (paired) inventory.unshift({
    category: "active_prospective", identifier: String(paired["id"] ?? "paired-side-lead-lag"),
    purpose: String(paired["purpose"] ?? "Paired side timing"), status: String(paired["status"] ?? "unknown"),
    versionOrFrozenStart: String(paired["id"] ?? "paired-side-lead-lag"), observations: count(paired["observations"]),
    settledOutcomes: count(paired["settledOutcomes"]), preliminaryResult: String(paired["preliminaryResult"] ?? ""),
    limitations: Array.isArray(paired["dataQualityLimitations"]) ? paired["dataQualityLimitations"] as string[] : [],
    actionable: false, nextMilestone: String(paired["nextMilestone"] ?? ""),
  });
  return {
    reportVersion: "passive-program-readiness-v1", generatedAtMs, researchOnly: true, executionBoundary: "This endpoint is not read by live trading and cannot promote, rank, veto, size, submit, or exit an order.",
    minimumAdequateSettledSample: MIN_ADEQUATE_SETTLED, programs, rankings: ranked,
    rankingStatus: ranked.length ? "evidence_based_settlement_only" : "unavailable_no_qualifying_counterfactual_cohort",
    externalSourceHealth: {
       sources: externalSources, frozenHorizons,
       reason: frozenHorizons.some((horizon) => horizon["eligible"] === true)
         ? "Eligibility is based only on frozen causal source evidence."
         : "No timestamped source with revision and latency provenance is retained.",
    },
    collectorHealth,
    researchInventory: inventory,
    supportingResearch: [
      "Phase 4B passive capture remains available independently.", "Mandelbrot instability remains research-only.",
      "Fold-the-Ace remains outcome-blind research.", "Compact normalized-distance prospective v2 remains frozen and independent.",
    ],
  };
}