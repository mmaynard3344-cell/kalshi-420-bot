/**
 * Pure data-derivation helper for the EntryGapCoveragePanel component.
 *
 * Extracted into its own module so that unit tests can import the real
 * production logic rather than duplicating it.  No React, no DOM, no side
 * effects — safe to import in a Node test runner.
 *
 * Older API server versions (pre-backfill) may return a response that omits
 * `rows` and/or `backfillRows` entirely.  The types here reflect that optional
 * reality and the derivation function applies safe `?? []` / `?? 0` fallbacks.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntryGapRow {
  snapshotId: string;
  ticker: string;
  side: 'yes' | 'no';
  entryPriceCents: number | null;
  secondsLeft: number;
  capturedAtMs: number;
  thresholdStrike: number | null;
  comparisonOperator: string | null;
  causalReferencePrice: number | null;
  causalReferenceSourceTimestampMs: number | null;
  causalReferenceAgeMs: number | null;
  causalEvidenceStatus: string;
  signedGapDollars: number | null;
  absoluteGapDollars: number | null;
  referenceVsTarget: 'above_target' | 'below_target' | 'at_target' | null;
  qualification: string;
  unavailableReasons: string[];
}

export interface EntryGapBackfillRow extends EntryGapRow {
  backfillSource: 'phase4b_reference_observations';
}

export interface EntryGapSummary {
  inBandTotal: number;
  measurable: number;
  unavailable: number;
  /** Present in modern responses only. Absent in pre-backfill server versions. */
  liveCount?: number;
  /** Present in modern responses only. Absent in pre-backfill server versions. */
  backfillCount?: number;
  evidenceStatusCounts: Record<string, number>;
}

/**
 * The response shape returned by /api/trade/phase4b-capture/entry-gap-report.
 *
 * `rows` and `backfillRows` are typed as optional to reflect that pre-backfill
 * server versions may omit them entirely (only `summary` is guaranteed).
 */
export interface EntryGapApiResponse {
  hypothesisVersion: string;
  summary: EntryGapSummary;
  /** Live-capture rows. Absent from older server responses — treat as []. */
  rows?: EntryGapRow[];
  /** Historical backfill rows. Absent from older server responses — treat as []. */
  backfillRows?: EntryGapBackfillRow[];
}

// ── Derived state ─────────────────────────────────────────────────────────────

export interface EntryGapPanelState {
  liveCount: number;
  backfillCount: number;
  allMeasurable: boolean;
  hasUnavailable: boolean;
  noData: boolean;
  statusEntries: [string, number][];
  liveRows: EntryGapRow[];
  backfillRows: EntryGapBackfillRow[];
}

/**
 * Derive display-ready state from a (potentially legacy) API response.
 *
 * This is the single authoritative source for the fallback rules:
 *   - `liveCount`    → `summary.liveCount` ?? `rows.length` ?? 0
 *   - `backfillCount`→ `summary.backfillCount` ?? `backfillRows.length` ?? 0
 *   - `liveRows`     → `rows` ?? []
 *   - `backfillRows` → `backfillRows` ?? []
 */
export function deriveEntryGapPanelState(data: EntryGapApiResponse): EntryGapPanelState {
  const s = data.summary;
  const liveRows: EntryGapRow[]             = data.rows         ?? [];
  const backfillRows: EntryGapBackfillRow[] = data.backfillRows ?? [];
  const liveCount     = s.liveCount     ?? liveRows.length;
  const backfillCount = s.backfillCount ?? backfillRows.length;
  const allMeasurable = s.unavailable === 0 && s.inBandTotal > 0;
  const hasUnavailable = s.unavailable > 0;
  const noData = s.inBandTotal === 0;
  const statusEntries = Object.entries(s.evidenceStatusCounts).sort(
    ([, a], [, b]) => b - a,
  ) as [string, number][];

  return { liveCount, backfillCount, allMeasurable, hasUnavailable, noData, statusEntries, liveRows, backfillRows };
}
