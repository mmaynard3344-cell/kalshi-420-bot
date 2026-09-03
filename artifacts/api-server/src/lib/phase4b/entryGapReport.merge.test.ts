/**
 * Tests for the merged entry-gap report produced by buildPhase4BEntryGapReport.
 *
 * Confirms that:
 *   1. summary.liveCount matches the count of in-band live payloads.
 *   2. summary.backfillCount matches the count of in-band backfill pairs.
 *   3. summary.inBandTotal = liveCount + backfillCount (no double-counting, no silent drops).
 *   4. Every backfill row carries backfillSource = "phase4b_reference_observations".
 *   5. A DB error in one query branch (empty array) still returns correct partial counts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPhase4BEntryGapReport } from "./entryGapReport.js";
import { PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION } from "./types.js";
import type { Phase4BThresholdRuleSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_CAPTURED_AT = 10_000_000;

const thresholdRule: Phase4BThresholdRuleSnapshot = {
  captureVersion: "distance-to-beat-prospective-v1",
  source: "kalshi_market_api_snapshot",
  observedAtMs: BASE_CAPTURED_AT,
  floorStrike: 65_000,
  comparisonOperator: ">=",
  rulesPrimary: "p",
  rulesSecondary: null,
  rulesHash: "h",
  unavailableReason: null,
};

/**
 * Build a minimal live Phase4BEntryGapRecord payload in the given qualification bucket.
 */
function makeLivePayload(
  snapshotId: string,
  qualification: "in_band_measurable" | "in_band_unavailable" | "out_of_band" = "in_band_measurable",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    hypothesisVersion: PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION,
    id: `id-${snapshotId}`,
    snapshotId,
    qualification,
    reason: "test",
    ticker: "KXBTC15M-26AUG151200-B65000",
    asset: "BTC",
    side: "yes",
    entryPriceCents: 92,
    secondsLeft: 120,
    capturedAtMs: BASE_CAPTURED_AT,
    thresholdRule,
    referenceSource: "kraken",
    causalReferencePrice: 64_920,
    causalReferenceSourceTimestampMs: BASE_CAPTURED_AT - 2_000,
    causalReferenceAgeMs: 2_000,
    causalEvidenceStatus: "live",
    signedGapDollars: -80,
    absoluteGapDollars: 80,
    referenceVsTarget: "below_target",
    unavailableReasons: [],
    schemaVersion: "2",
    ...overrides,
  };
}

/**
 * Build a minimal backfill pair (referencePayload + snapshotPayload) for a
 * 90–95¢ in-band measurable row. Both payloads carry the fields that
 * buildPhase4BEntryGapBackfillReport reads directly from the persisted DB rows.
 */
function makeBackfillPair(
  snapshotId: string,
  overrides: { ref?: Record<string, unknown>; snap?: Record<string, unknown> } = {},
): { referencePayload: Record<string, unknown>; snapshotPayload: Record<string, unknown> } {
  return {
    referencePayload: {
      snapshotId,
      capturedAtMs: BASE_CAPTURED_AT - 60_000, // older than the live rows
      causalEvidenceStatus: "live",
      causalReferencePrice: 64_900,
      causalReferenceSourceTimestampMs: BASE_CAPTURED_AT - 62_000,
      causalReferenceAgeMs: 2_000,
      ...overrides.ref,
    },
    snapshotPayload: {
      snapshotId,
      marketId: "KXBTC15M-26AUG151200-B65000",
      candidateSide: "yes",
      secondsLeft: 120,
      displayedEntryPriceCents: 92, // in the 90–95¢ band
      thresholdRule,
      ...overrides.snap,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPhase4BEntryGapReport — merged row counts", () => {
  it("returns liveCount=0 and backfillCount=0 when both inputs are empty", () => {
    const report = buildPhase4BEntryGapReport([], []);
    assert.equal(report.summary.liveCount, 0);
    assert.equal(report.summary.backfillCount, 0);
    assert.equal(report.summary.inBandTotal, 0);
    assert.deepEqual(report.rows, []);
    assert.deepEqual(report.backfillRows, []);
  });

  it("counts only in-band live rows; out-of-band rows are excluded from liveCount", () => {
    const payloads = [
      makeLivePayload("live-1", "in_band_measurable"),
      makeLivePayload("live-2", "in_band_unavailable"),
      makeLivePayload("live-3", "out_of_band"),
    ];
    const report = buildPhase4BEntryGapReport(payloads, []);
    assert.equal(report.summary.liveCount, 2, "out_of_band row must not be counted");
    assert.equal(report.summary.backfillCount, 0);
    assert.equal(report.summary.inBandTotal, 2);
    assert.equal(report.rows.length, 2);
    assert.deepEqual(report.backfillRows, []);
  });

  it("counts in-band backfill rows and leaves liveCount=0 when no live payloads are given", () => {
    const pairs = [
      makeBackfillPair("bf-1"),
      makeBackfillPair("bf-2"),
    ];
    const report = buildPhase4BEntryGapReport([], pairs);
    assert.equal(report.summary.liveCount, 0);
    assert.equal(report.summary.backfillCount, 2);
    assert.equal(report.summary.inBandTotal, 2);
    assert.equal(report.rows.length, 0);
    assert.equal(report.backfillRows.length, 2);
  });

  it("merges live and backfill rows: liveCount + backfillCount = inBandTotal, no double-counting", () => {
    const livePayloads = [
      makeLivePayload("live-1", "in_band_measurable"),
      makeLivePayload("live-2", "in_band_measurable"),
      makeLivePayload("live-3", "in_band_unavailable"),
    ];
    const backfillPairs = [
      makeBackfillPair("bf-1"),
      makeBackfillPair("bf-2"),
      makeBackfillPair("bf-3"),
      makeBackfillPair("bf-4"),
    ];
    const report = buildPhase4BEntryGapReport(livePayloads, backfillPairs);

    assert.equal(report.summary.liveCount, 3, "liveCount must match in-band live payloads");
    assert.equal(report.summary.backfillCount, 4, "backfillCount must match in-band backfill pairs");
    assert.equal(
      report.summary.inBandTotal,
      report.summary.liveCount + report.summary.backfillCount,
      "inBandTotal must equal liveCount + backfillCount",
    );
    assert.equal(report.rows.length, report.summary.liveCount);
    assert.equal(report.backfillRows.length, report.summary.backfillCount);
  });

  it("every backfill row carries backfillSource = 'phase4b_reference_observations'", () => {
    const pairs = [makeBackfillPair("bf-1"), makeBackfillPair("bf-2"), makeBackfillPair("bf-3")];
    const report = buildPhase4BEntryGapReport([], pairs);

    for (const row of report.backfillRows) {
      assert.equal(
        row.backfillSource,
        "phase4b_reference_observations",
        `backfillSource missing or wrong on row ${row.snapshotId}`,
      );
    }
  });

  it("out-of-band backfill pairs are excluded from backfillCount (entryPriceCents outside 90-95¢)", () => {
    const pairs = [
      makeBackfillPair("bf-in-1"),                              // in-band (92¢)
      makeBackfillPair("bf-out-1", { snap: { displayedEntryPriceCents: 76 } }), // out-of-band
      makeBackfillPair("bf-in-2"),                              // in-band (92¢)
    ];
    const report = buildPhase4BEntryGapReport([], pairs);
    assert.equal(report.summary.backfillCount, 2, "out-of-band backfill pairs must not be counted");
    assert.equal(report.summary.inBandTotal, 2);
  });

  it("payloads with a wrong hypothesisVersion are silently ignored and don't inflate liveCount", () => {
    const payloads = [
      makeLivePayload("live-1"),
      { hypothesisVersion: "other-v1", snapshotId: "other", qualification: "in_band_measurable" },
      { snapshotId: "no-version", qualification: "in_band_measurable" },
    ];
    const report = buildPhase4BEntryGapReport(payloads, []);
    assert.equal(report.summary.liveCount, 1, "only the live entry-gap row must be counted");
    assert.equal(report.summary.inBandTotal, 1);
  });

  it("a DB error on the live query (empty payloads) still returns correct backfill counts — no partial-result silencing", () => {
    // Simulates the live query failing (returns []) while backfill succeeds.
    const pairs = [makeBackfillPair("bf-1"), makeBackfillPair("bf-2")];
    const report = buildPhase4BEntryGapReport([], pairs);

    assert.equal(report.summary.liveCount, 0);
    assert.equal(report.summary.backfillCount, 2);
    assert.equal(report.summary.inBandTotal, 2);
    // The report must still be valid (not throw or return partial undefined fields).
    assert.ok(typeof report.summary.measurable === "number");
    assert.ok(typeof report.summary.unavailable === "number");
    assert.ok(typeof report.summary.evidenceStatusCounts === "object");
  });

  it("a DB error on the backfill query (empty pairs) still returns correct live counts — no partial-result silencing", () => {
    // Simulates the backfill query failing (returns []) while live succeeds.
    const payloads = [makeLivePayload("live-1"), makeLivePayload("live-2")];
    const report = buildPhase4BEntryGapReport(payloads, []);

    assert.equal(report.summary.liveCount, 2);
    assert.equal(report.summary.backfillCount, 0);
    assert.equal(report.summary.inBandTotal, 2);
    assert.ok(typeof report.summary.measurable === "number");
    assert.ok(typeof report.summary.evidenceStatusCounts === "object");
  });

  it("measurable + unavailable counts match across the full merged set", () => {
    const livePayloads = [
      makeLivePayload("live-m1", "in_band_measurable"),
      makeLivePayload("live-u1", "in_band_unavailable", {
        causalReferencePrice: null,
        causalEvidenceStatus: "unavailable",
        signedGapDollars: null,
        absoluteGapDollars: null,
        unavailableReasons: ["causal_reference_unavailable_at_or_before_capture"],
      }),
    ];
    const backfillPairs = [
      // measurable backfill: causalReferencePrice present, thresholdRule present
      makeBackfillPair("bf-m1"),
      // unavailable backfill: no causalReferencePrice
      makeBackfillPair("bf-u1", { ref: { causalEvidenceStatus: "unavailable", causalReferencePrice: null } }),
    ];
    const report = buildPhase4BEntryGapReport(livePayloads, backfillPairs);

    assert.equal(report.summary.inBandTotal, 4);
    assert.equal(report.summary.measurable + report.summary.unavailable, 4,
      "measurable + unavailable must equal inBandTotal when there are no other qualifications");
  });
});
