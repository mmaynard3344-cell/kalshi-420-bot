/**
 * Read-only reconstruction of entry-time target distance for 90–95¢ BTC cases.
 * Operates purely on persisted entry-gap records: no external price history,
 * no settlement values, no live fetches. Rows that lack a causal pair are kept
 * visible with their explicit evidence status instead of being dropped.
 */
import type { Phase4BEntryGapRecord, Phase4BCausalEvidenceStatus, Phase4BThresholdRuleSnapshot } from "./types.js";
import { PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION, PHASE4B_ENTRY_GAP_BAND_CENTS } from "./types.js";

export interface Phase4BEntryGapReportRow {
  snapshotId: string;
  ticker: string;
  side: Phase4BEntryGapRecord["side"];
  entryPriceCents: number | null;
  secondsLeft: number;
  capturedAtMs: number;
  thresholdStrike: number | null;
  comparisonOperator: string | null;
  causalReferencePrice: number | null;
  causalReferenceSourceTimestampMs: number | null;
  causalReferenceAgeMs: number | null;
  causalEvidenceStatus: Phase4BEntryGapRecord["causalEvidenceStatus"];
  signedGapDollars: number | null;
  absoluteGapDollars: number | null;
  referenceVsTarget: Phase4BEntryGapRecord["referenceVsTarget"];
  qualification: Phase4BEntryGapRecord["qualification"];
  unavailableReasons: readonly string[];
}

export interface Phase4BEntryGapReport {
  hypothesisVersion: typeof PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION;
  /** Live-capture rows (hypothesisVersion = entry-gap-90-95-v1). No backfillSource field. */
  rows: Phase4BEntryGapReportRow[];
  /** Historical backfill rows reconstructed from persisted causal evidence. Each carries backfillSource = "phase4b_reference_observations". */
  backfillRows: Phase4BEntryGapBackfillRow[];
  summary: {
    /** Combined in-band total (live + backfill). */
    inBandTotal: number;
    /** Combined measurable count (live + backfill). */
    measurable: number;
    /** Combined unavailable count (live + backfill). */
    unavailable: number;
    /** Live-capture row count only. */
    liveCount: number;
    /** Backfill row count only. */
    backfillCount: number;
    evidenceStatusCounts: Record<string, number>;
  };
}

// ── Backfill types ────────────────────────────────────────────────────────────

/**
 * A single backfill row. Mirrors Phase4BEntryGapReportRow but carries an
 * explicit backfillSource so consumers can distinguish reconstructed rows from
 * live captures. All gap values are derived solely from fields that were
 * computed and persisted at the original capture time.
 */
export interface Phase4BEntryGapBackfillRow extends Phase4BEntryGapReportRow {
  backfillSource: "phase4b_reference_observations";
}

/**
 * One-time read-only backfill report for historical 90–95¢ BTC snapshots that
 * predate the entry-gap-90-95-v1 capture path. No external price history, no
 * settlement values, no live fetches are ever used: every field comes from
 * payloads already persisted at original capture time.
 */
export interface Phase4BEntryGapBackfillReport {
  hypothesisVersion: typeof PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION;
  backfillSource: "phase4b_reference_observations";
  /**
   * Human-readable label confirming this is a historical reconstruction, not
   * a live capture pass.
   */
  backfillLabel: "historical_reconstruction_from_persisted_causal_evidence";
  generatedAtMs: number;
  rows: Phase4BEntryGapBackfillRow[];
  summary: {
    /** All BTC snapshots found without an entry-gap-90-95-v1 prospective record. */
    btcSnapshotsWithoutGapRecord: number;
    /** Subset whose entry price is in the 90–95¢ band. */
    inBandTotal: number;
    measurable: number;
    unavailable: number;
    evidenceStatusCounts: Record<string, number>;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isEntryGapRecord(payload: Record<string, unknown>): payload is Record<string, unknown> & Phase4BEntryGapRecord {
  return payload["hypothesisVersion"] === PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION
    && typeof payload["snapshotId"] === "string";
}

function isCausalEvidenceStatus(value: unknown): value is Phase4BCausalEvidenceStatus {
  return value === "live" || value === "fresh_prior" || value === "aged_prior" || value === "unavailable";
}

function isThresholdRule(value: unknown): value is Phase4BThresholdRuleSnapshot {
  return typeof value === "object" && value !== null
    && (typeof (value as Record<string, unknown>)["floorStrike"] === "number"
      || (value as Record<string, unknown>)["floorStrike"] === null);
}

/**
 * Reconstruct entry-gap rows for historical BTC snapshots that predate the
 * live capture path. Each pair carries a phase4b_decision_snapshots payload
 * (entry price, side, threshold) and a phase4b_reference_observations payload
 * (causal evidence fields already computed at the original capture time).
 *
 * Rules:
 *   - Only the fields already persisted at capture time are used.
 *   - No external fetches, no settlement values, no later price history.
 *   - Rows outside the 90–95¢ BTC band are counted but excluded from inBand totals.
 *   - Rows with no causal pair are retained with qualification "in_band_unavailable".
 */
export function buildPhase4BEntryGapBackfillReport(
  pairs: readonly { referencePayload: Record<string, unknown>; snapshotPayload: Record<string, unknown> }[],
  generatedAtMs: number = Date.now(),
): Phase4BEntryGapBackfillReport {
  const [bandFloor, bandCeiling] = PHASE4B_ENTRY_GAP_BAND_CENTS;
  const rows: Phase4BEntryGapBackfillRow[] = [];

  for (const { referencePayload: ref, snapshotPayload: snap } of pairs) {
    const refId = ref["snapshotId"] != null ? String(ref["snapshotId"]) : "";
    const snapId = snap["snapshotId"] != null ? String(snap["snapshotId"]) : "";
    // If both payloads carry non-empty but conflicting IDs the pair is causally
    // invalid (upstream assembly bug); skip rather than mix data from two records.
    if (refId && snapId && refId !== snapId) continue;
    const snapshotId = refId || snapId;
    if (!snapshotId) continue;

    const ticker = String(snap["marketId"] ?? ref["marketId"] ?? "");
    const candidateSide = snap["candidateSide"] === "no" ? "no" as const : "yes" as const;
    const capturedAtMs = Number(ref["capturedAtMs"] ?? snap["capturedAtMs"] ?? 0);
    const secondsLeft = Number(snap["secondsLeft"] ?? 0);
    const entryPriceCents = snap["displayedEntryPriceCents"] != null
      ? Number(snap["displayedEntryPriceCents"]) : null;

    const thresholdRule = isThresholdRule(snap["thresholdRule"])
      ? snap["thresholdRule"] as Phase4BThresholdRuleSnapshot : null;
    const floorStrike = thresholdRule?.floorStrike ?? null;
    const comparisonOperator = thresholdRule?.comparisonOperator ?? null;

    // Causal evidence — read directly from the persisted reference observation.
    const rawStatus = ref["causalEvidenceStatus"];
    const causalEvidenceStatus: Phase4BCausalEvidenceStatus = isCausalEvidenceStatus(rawStatus)
      ? rawStatus : "unavailable";
    const causalReferencePrice = ref["causalReferencePrice"] != null
      ? Number(ref["causalReferencePrice"]) : null;
    const causalReferenceSourceTimestampMs = ref["causalReferenceSourceTimestampMs"] != null
      ? Number(ref["causalReferenceSourceTimestampMs"]) : null;
    const causalReferenceAgeMs = ref["causalReferenceAgeMs"] != null
      ? Number(ref["causalReferenceAgeMs"]) : null;

    const inBand = entryPriceCents != null
      && entryPriceCents >= bandFloor && entryPriceCents <= bandCeiling;

    // Collect unavailability reasons using the same logic as the live capture path.
    const unavailableReasons: string[] = [];
    if (floorStrike == null || comparisonOperator == null || thresholdRule?.source === "unavailable") {
      unavailableReasons.push(
        thresholdRule?.unavailableReason ?? "authoritative_threshold_or_rule_unavailable",
      );
    }
    if (causalReferencePrice == null || causalEvidenceStatus === "unavailable") {
      unavailableReasons.push("causal_reference_unavailable_at_or_before_capture");
    }

    const qualification: Phase4BEntryGapReportRow["qualification"] = !inBand
      ? "out_of_band"
      : unavailableReasons.length > 0 ? "in_band_unavailable" : "in_band_measurable";

    // Signed gap: only computable when the row is measurable.
    const signedRaw = qualification === "in_band_measurable" && causalReferencePrice != null && floorStrike != null
      ? (candidateSide === "yes"
        ? causalReferencePrice - floorStrike
        : floorStrike - causalReferencePrice)
      : null;
    const signedGapDollars = signedRaw == null ? null : Number(signedRaw.toFixed(6));
    const absoluteGapDollars = signedGapDollars == null ? null : Math.abs(signedGapDollars);

    const referenceVsTarget: Phase4BEntryGapReportRow["referenceVsTarget"] =
      causalReferencePrice == null || floorStrike == null || unavailableReasons.length > 0 ? null
        : causalReferencePrice > floorStrike ? "above_target"
          : causalReferencePrice < floorStrike ? "below_target" : "at_target";

    rows.push({
      snapshotId,
      ticker,
      side: candidateSide,
      entryPriceCents,
      secondsLeft,
      capturedAtMs,
      thresholdStrike: floorStrike,
      comparisonOperator,
      causalReferencePrice,
      causalReferenceSourceTimestampMs,
      causalReferenceAgeMs,
      causalEvidenceStatus,
      signedGapDollars,
      absoluteGapDollars,
      referenceVsTarget,
      qualification,
      unavailableReasons,
      backfillSource: "phase4b_reference_observations",
    });
  }

  // Sort in-band rows by capture time; out-of-band rows are excluded from summary counts.
  const inBandRows = rows.filter((r) => r.qualification !== "out_of_band");
  inBandRows.sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.snapshotId.localeCompare(b.snapshotId));

  const evidenceStatusCounts: Record<string, number> = {};
  for (const row of inBandRows) {
    evidenceStatusCounts[row.causalEvidenceStatus] =
      (evidenceStatusCounts[row.causalEvidenceStatus] ?? 0) + 1;
  }

  return {
    hypothesisVersion: PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION,
    backfillSource: "phase4b_reference_observations",
    backfillLabel: "historical_reconstruction_from_persisted_causal_evidence",
    generatedAtMs,
    rows: inBandRows,
    summary: {
      btcSnapshotsWithoutGapRecord: pairs.length,
      inBandTotal: inBandRows.length,
      measurable: inBandRows.filter((r) => r.qualification === "in_band_measurable").length,
      unavailable: inBandRows.filter((r) => r.qualification === "in_band_unavailable").length,
      evidenceStatusCounts,
    },
  };
}

export function buildPhase4BEntryGapReport(
  payloads: readonly Record<string, unknown>[],
  backfillPairs?: readonly { referencePayload: Record<string, unknown>; snapshotPayload: Record<string, unknown> }[],
): Phase4BEntryGapReport {
  const inBand = payloads
    .filter(isEntryGapRecord)
    .filter((record) => record.qualification === "in_band_measurable" || record.qualification === "in_band_unavailable")
    .sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.snapshotId.localeCompare(b.snapshotId));
  const rows = inBand.map((record): Phase4BEntryGapReportRow => {
    const signed = record.signedGapDollars;
    return {
      snapshotId: record.snapshotId,
      ticker: record.ticker,
      side: record.side,
      entryPriceCents: record.entryPriceCents,
      secondsLeft: record.secondsLeft,
      capturedAtMs: record.capturedAtMs,
      thresholdStrike: record.thresholdRule?.floorStrike ?? null,
      comparisonOperator: record.thresholdRule?.comparisonOperator ?? null,
      causalReferencePrice: record.causalReferencePrice,
      causalReferenceSourceTimestampMs: record.causalReferenceSourceTimestampMs,
      causalReferenceAgeMs: record.causalReferenceAgeMs,
      causalEvidenceStatus: record.causalEvidenceStatus,
      signedGapDollars: signed,
      absoluteGapDollars: signed == null ? null : Math.abs(signed),
      referenceVsTarget: record.referenceVsTarget,
      qualification: record.qualification,
      unavailableReasons: record.unavailableReasons ?? [],
    };
  });

  // Build backfill rows when pairs are provided.
  const backfillRows: Phase4BEntryGapBackfillRow[] = backfillPairs && backfillPairs.length > 0
    ? buildPhase4BEntryGapBackfillReport(backfillPairs, Date.now()).rows
    : [];

  // Combined evidence status counts across live + backfill rows.
  const evidenceStatusCounts: Record<string, number> = {};
  for (const row of [...rows, ...backfillRows]) {
    evidenceStatusCounts[row.causalEvidenceStatus] = (evidenceStatusCounts[row.causalEvidenceStatus] ?? 0) + 1;
  }

  const allRows = [...rows, ...backfillRows];
  return {
    hypothesisVersion: PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION,
    rows,
    backfillRows,
    summary: {
      inBandTotal: allRows.length,
      measurable: allRows.filter((row) => row.qualification === "in_band_measurable").length,
      unavailable: allRows.filter((row) => row.qualification === "in_band_unavailable").length,
      liveCount: rows.length,
      backfillCount: backfillRows.length,
      evidenceStatusCounts,
    },
  };
}
