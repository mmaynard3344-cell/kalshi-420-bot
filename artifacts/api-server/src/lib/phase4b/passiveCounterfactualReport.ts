/**
 * Read-only, settlement-only passive counterfactual analysis.
 * It never imports live strategies, order submission, or quote fetchers.
 */
import { PROGRAM_E_EXTERNAL_SOURCES, PROGRAM_E_FROZEN_HORIZONS_SECONDS, type ProgramEExternalEvidence, type ProgramEExternalSource } from "./passiveExperimentRegistry.js";

export const PASSIVE_COUNTERFACTUAL_REPORT_VERSION = "passive-counterfactual-report-v2";
export const ENTRY_QUALITY_INTERACTION_MIN_SAMPLE = 30;

export type PassiveSettledCapture = {
  experimentVersion: string; captureId: string; marketId: string; ticker: string; asset: string;
  capturedAtMs: number; qualification: string; payload: Record<string, unknown>;
  result: "yes" | "no" | null; settlementStatus: string | null;
};
type OutcomeRow = PassiveSettledCapture & { side: "yes" | "no"; entryPriceCents: number; pnlCents: number; won: boolean };

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asSide = (value: unknown): "yes" | "no" | null => value === "yes" || value === "no" ? value : null;
const asEvidence = (value: unknown): ProgramEExternalEvidence | null => {
  if (value == null || typeof value !== "object") return null;
  const evidence = value as Partial<ProgramEExternalEvidence>;
  return typeof evidence.causal === "boolean"
    && typeof evidence.availability === "string"
    && typeof evidence.revisionState === "string"
    ? evidence as ProgramEExternalEvidence : null;
};
const programEEvidence = (row: PassiveSettledCapture, source: ProgramEExternalSource) =>
  asEvidence((row.payload["externalObservations"] as Record<string, unknown> | undefined)?.[source]);
const causalForHorizon = (row: PassiveSettledCapture, seconds: number) =>
  PROGRAM_E_EXTERNAL_SOURCES.every((source) => {
    const evidence = programEEvidence(row, source);
    return evidence?.causal === true && typeof evidence.latencyMs === "number" && evidence.latencyMs <= seconds * 1_000;
  });

function usable(rows: readonly PassiveSettledCapture[]): OutcomeRow[] {
  return rows.flatMap((row) => {
    const side = asSide(row.payload["candidateSide"] ?? row.payload["side"]);
    // Registry payload stores side in the outer Phase 4B snapshot only in older
    // data. Candidate-side is also encoded in the snapshot id's source record;
    // without it we refuse to infer a direction.
    const snapshotSide = asSide(row.payload["candidateSide"]);
    const entry = asNumber(row.payload["entryPriceCents"]);
    if (row.qualification !== "eligible" || row.result == null || snapshotSide == null || entry == null || entry <= 0 || entry >= 100) return [];
    const won = row.result === snapshotSide;
    return [{ ...row, side: snapshotSide, entryPriceCents: entry, won, pnlCents: won ? 100 - entry : -entry }];
  });
}

function wilson(successes: number, n: number): { low: number | null; high: number | null } {
  if (!n) return { low: null, high: null };
  const z = 1.959963984540054, p = successes / n, d = 1 + z ** 2 / n;
  const c = (p + z ** 2 / (2 * n)) / d;
  const m = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n) / d;
  return { low: c - m, high: c + m };
}
function drawdown(rows: readonly OutcomeRow[]): number {
  let equity = 0, peak = 0, max = 0;
  for (const row of [...rows].sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.captureId.localeCompare(b.captureId))) {
    equity += row.pnlCents; peak = Math.max(peak, equity); max = Math.max(max, peak - equity);
  }
  return max;
}
function summary(rows: readonly OutcomeRow[]) {
  const wins = rows.filter((row) => row.won).length;
  const losses = rows.length - wins;
  return {
    settledOpportunities: rows.length, wins, losses, winRate: rows.length ? wins / rows.length : null,
    winWilson95: wilson(wins, rows.length), netPnlCents: rows.reduce((sum, row) => sum + row.pnlCents, 0),
    maxDrawdownCents: drawdown(rows),
  };
}
function dayCount(rows: readonly OutcomeRow[]) {
  return new Set(rows.map((row) => new Date(row.capturedAtMs).toISOString().slice(0, 10))).size;
}
function filterReport(label: string, all: readonly OutcomeRow[], filtered: (row: OutcomeRow) => boolean) {
  const removed = all.filter(filtered), retained = all.filter((row) => !filtered(row));
  const base = summary(all), keep = summary(retained);
  const avoided = removed.filter((row) => !row.won);
  const sacrificed = removed.filter((row) => row.won);
  return {
    label, observedOnly: true, fullFillAssumption: "one_contract_settlement_only; no fill or fee inference",
    filtered: summary(removed), retained: keep, baseline: base,
    rejectedWinners: sacrificed.length, rejectedLosers: avoided.length,
    lossesAvoidedCents: avoided.reduce((sum, row) => sum + Math.abs(row.pnlCents), 0),
    winningProfitSacrificedCents: sacrificed.reduce((sum, row) => sum + row.pnlCents, 0),
    counterfactualNetPnlChangeCents: keep.netPnlCents - base.netPnlCents,
    drawdownChangeCents: keep.maxDrawdownCents - base.maxDrawdownCents,
    retainedTradeRate: all.length ? retained.length / all.length : null,
    retainedOpportunitiesPerDay: dayCount(retained) ? retained.length / dayCount(retained) : null,
    protectionEfficiency: removed.length ? avoided.length / removed.length : null,
    byAsset: ["BTC", "ETH"].map((asset) => ({ asset, ...summary(retained.filter((row) => row.asset === asset)) })),
    bySide: (["yes", "no"] as const).map((side) => ({ side, ...summary(retained.filter((row) => row.side === side)) })),
  };
}
function band(price: number): string | null {
  if (price >= 80 && price <= 84) return "80-84";
  if (price >= 85 && price <= 89) return "85-89";
  if (price >= 90 && price <= 92) return "90-92";
  return null;
}

export function buildPassiveCounterfactualReport(captures: readonly PassiveSettledCapture[]) {
  const byExperiment = (version: string) => captures.filter((row) => row.experimentVersion === version);
  const a = usable(byExperiment("loss-avoidance-microstructure-v1"));
  const c = usable(byExperiment("entry-quality-segmentation-v1"));
  const outcomes = (rows: OutcomeRow[]) => ({
    unavailableReason: rows.length ? null : "no_settled_eligible_candidates_with_direction_and_entry_price",
    baseline: summary(rows),
    cohorts: [
      filterReport("production_rejected", rows, (row) => row.payload["candidateStatus"] === "production_rejected"),
      filterReport("rejected_stale_bbo_gap", rows, (row) => row.payload["finalDecisionClassification"] === "rejected_stale_bbo_gap"),
      filterReport("rejected_wide_spread", rows, (row) => row.payload["finalDecisionClassification"] === "rejected_wide_spread"),
      filterReport("rejected_zero_depth", rows, (row) => row.payload["finalDecisionClassification"] === "rejected_zero_depth"),
      filterReport("rejected_l2_unavailable", rows, (row) => row.payload["finalDecisionClassification"] === "rejected_l2_unavailable"),
    ],
  });
  const entryRows = c.filter((row) => band(row.entryPriceCents) !== null);
  const group = (predicate: (row: OutcomeRow) => boolean) => summary(entryRows.filter(predicate));
  const e = byExperiment("cross-market-lead-lag-v1");
  const programESourceHealth = PROGRAM_E_EXTERNAL_SOURCES.map((source) => {
    const observations = e.map((row) => programEEvidence(row, source)).filter((value): value is ProgramEExternalEvidence => value != null);
    const latest = [...observations].sort((a, b) => (b.capturedAtMs ?? -1) - (a.capturedAtMs ?? -1))[0] ?? null;
    return {
      source, state: latest?.causal ? "causal" : "unavailable",
      availabilityTimestampMs: latest?.availabilityTimestampMs ?? null, sourceTimestampMs: latest?.sourceTimestampMs ?? null,
      latencyMs: latest?.latencyMs ?? null, revisionState: latest?.revisionState ?? "unknown",
      insufficiencyReason: latest?.unavailableReason ?? "no timestamped source observation is retained",
    };
  });
  const programEHorizons = PROGRAM_E_FROZEN_HORIZONS_SECONDS.map((seconds) => {
    const eligible = e.filter((row) => causalForHorizon(row, seconds));
    const settled = eligible.filter((row) => row.result != null);
    return {
      seconds, eligible: eligible.length > 0, eligibleCaptures: eligible.length, settledEligibleCaptures: settled.length,
      reason: eligible.length ? null : "all required external sources must be original, available by capture, and within this horizon's latency budget",
    };
  });
  return {
    reportVersion: PASSIVE_COUNTERFACTUAL_REPORT_VERSION, researchOnly: true,
    methodology: {
      outcomeSource: "authoritative Phase4B settlement labels only",
      noLookAhead: "uses capture payloads frozen before settlement; no later quote substitution",
      caveat: "P&L is one-contract settlement-only counterfactual. It does not claim fill, fees, or realized trading performance.",
    },
    programA: outcomes(a),
    programB: {
      unavailableReason: "registry retains no timestamp-safe post-entry bid path, exit fill evidence, or recovery observations; hypothetical exits cannot be honestly calculated",
      requestedThresholdsCents: [70, 65, 60, 55, 50], requestedCheckpointsSeconds: [50, 45],
    },
    programC: {
      unavailableReason: entryRows.length ? null : "no_settled_eligible_entry_quality_candidates",
      exactPrice: Array.from(new Set(entryRows.map((row) => row.entryPriceCents))).sort((x, y) => x - y)
        .map((price) => ({ entryPriceCents: price, ...summary(entryRows.filter((row) => row.entryPriceCents === price)) })),
      priceBands: ["80-84", "85-89", "90-92"].map((value) => ({ band: value, ...group((row) => band(row.entryPriceCents) === value) })),
      byAsset: ["BTC", "ETH"].map((asset) => ({ asset, ...group((row) => row.asset === asset) })),
      bySide: (["yes", "no"] as const).map((side) => ({ side, ...group((row) => row.side === side) })),
      byTimeRemaining: [[1, 30], [31, 60], [61, 120], [121, 180]].map(([min, max]) => ({
        secondsRemaining: `${min}-${max}`, ...group((row) => row.payload["secondsLeft"] !== null
          && asNumber(row.payload["secondsLeft"])! >= min && asNumber(row.payload["secondsLeft"])! <= max),
      })),
      interactions: { status: "unavailable", minimumSamplePerInteraction: ENTRY_QUALITY_INTERACTION_MIN_SAMPLE, reason: "predeclared sample threshold not evaluated from a sufficiently populated independent cohort" },
    },
    programE: {
      unavailableReason: programEHorizons.some((horizon) => horizon.eligible)
        ? null : "no capture has all required timestamped external inputs with original revision state and causal availability",
      enrolledCaptures: e.length,
      externalSourceHealth: programESourceHealth,
      frozenHorizons: programEHorizons,
      methodology: "A horizon is reported only for captures where every required source was original, available at or before the decision boundary, and had latency no greater than that horizon. Delayed, revised, missing, future, and provenance-inconsistent observations remain unavailable.",
    },
    dynamicMicrostructure: { unavailableReason: "registry stores snapshot proxies only; no order-event aggression, cancellation, or replenishment evidence is retained" },
    volatilityAndCooldown: { unavailableReason: "registry lacks frozen 15/30/60-minute persistence and independent-window loss-cluster observations" },
    selectivity: { unavailableReason: "registry lacks per-window top-1/top-2/top-3 rank sets; opportunity frequency cannot be inferred from independent captures" },
    futureModelExport: { status: "data_only", fields: ["captureId", "marketId", "capturedAtMs", "frozen payload", "qualification", "authoritative settlement label"], training: "not performed" },
  };
}