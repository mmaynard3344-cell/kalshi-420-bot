import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildPhase4BEntryGapReport, buildPhase4BEntryGapBackfillReport } from "./entryGapReport.js";
import {
  _resetPhase4BForTesting,
  _setPhase4BReferenceEnricherForTesting,
  _setPhase4BWriterForTesting,
  enqueuePhase4BPassiveCapture,
} from "./passiveCapture.js";
import { buildPhase4BReferenceObservation } from "./referenceFeatures.js";
import {
  appendReferencePoint,
  getReferenceHistory,
  getPhase4BReferenceHistoryCorruptReloadCount,
  _resetPhase4BReferenceHistoryForTesting,
  _setPhase4BReferenceHistoryPathForTesting,
} from "./referenceHistoryStore.js";
import type { Phase4BEntryGapRecord, Phase4BThresholdRuleSnapshot } from "./types.js";
import { PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION } from "./types.js";

const T = 10_000_000;

const thresholdRule: Phase4BThresholdRuleSnapshot = {
  captureVersion: "distance-to-beat-prospective-v1", source: "kalshi_market_api_snapshot", observedAtMs: T,
  floorStrike: 65_000, comparisonOperator: ">=", rulesPrimary: "p", rulesSecondary: null, rulesHash: "h",
  unavailableReason: null,
};

const captureInput = (overrides: Record<string, unknown> = {}) => ({
  timestampMs: T, ticker: "KXBTC15M-26AUG151200-B65000", series: "KXBTC15M",
  closeTime: new Date(T + 120_000).toISOString(), openTime: new Date(T - 780_000).toISOString(),
  secondsLeft: 120, side: "yes" as const, source: "websocket" as const, wsConnected: true, wsStale: false,
  lastWsMessageAgeMs: 10, bboAgeMs: 10, yesBid: 91, yesAsk: 92, noBid: 8, noAsk: 9,
  displayedEntryPriceCents: 92, configuredLimitCents: 92, bboDerivedLimitCents: 92, strategyVersion: "test",
  betDollars: 600, priceFloorCents: 70, priceCapCents: 95, limitBufferCents: 1, staleGapThresholdCents: 2,
  decisionClassification: "eligible", skipReason: null, quotedBboAskCents: 92,
  executableL2AskCents: 92, bboToL2GapCents: 0, preflightLatencyMs: 15, thresholdRule, ...overrides,
});

function findEntryGap(records: readonly Record<string, unknown>[]): Phase4BEntryGapRecord {
  const record = records.find((r) => r["hypothesisVersion"] === PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION);
  assert.ok(record, "entry gap record must be emitted");
  return record as unknown as Phase4BEntryGapRecord;
}

async function captureAndCollect(input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  _setPhase4BWriterForTesting(async (_m, _s, _b, _r, prospective) => {
    collected.push(...(prospective as unknown as Record<string, unknown>[]));
  });
  enqueuePhase4BPassiveCapture(captureInput(input) as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return collected;
}

describe("Phase 4B entry-gap causal capture", () => {
  beforeEach(() => {
    _resetPhase4BForTesting();
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
  });
  afterEach(() => {
    delete process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"];
    _resetPhase4BForTesting();
  });

  it("enforces clock ordering: a future-timestamped reference is never used as causal evidence", () => {
    const future = buildPhase4BReferenceObservation({
      snapshotId: "s", asset: "BTC", source: "test", referencePrice: 65_100,
      sourceTimestampMs: T + 5_000, capturedAtMs: T, history: [], intervalStartMs: null,
    });
    assert.equal(future.error, "future_reference_timestamp");
    assert.equal(future.causalEvidenceStatus, "unavailable");
    assert.equal(future.causalReferencePrice, null);

    const withPrior = buildPhase4BReferenceObservation({
      snapshotId: "s", asset: "BTC", source: "test", referencePrice: 65_100,
      sourceTimestampMs: T + 5_000, capturedAtMs: T,
      history: [{ timestampMs: T - 4_000, price: 64_990 }, { timestampMs: T + 1_000, price: 65_200 }],
      intervalStartMs: null,
    });
    assert.equal(withPrior.causalReferencePrice, 64_990);
    assert.equal(withPrior.causalReferenceSourceTimestampMs, T - 4_000);
    assert.equal(withPrior.causalReferenceAgeMs, 4_000);
    assert.equal(withPrior.causalEvidenceStatus, "fresh_prior");
  });

  it("falls back to an aged causal prior when the live reference is stale, recording true source timestamp and age", async () => {
    _setPhase4BReferenceEnricherForTesting(async (_market, snapshot) =>
      buildPhase4BReferenceObservation({
        snapshotId: snapshot.snapshotId, asset: "BTC", source: "kraken",
        referencePrice: null, sourceTimestampMs: T - 20_000, capturedAtMs: snapshot.capturedAtMs,
        error: "stale_reference_price", stale: true, cacheAgeMs: 20_000,
        history: [{ timestampMs: T - 20_000, price: 64_950 }], intervalStartMs: null,
      }));
    const entryGap = findEntryGap(await captureAndCollect({}));
    assert.equal(entryGap.qualification, "in_band_measurable");
    assert.equal(entryGap.causalEvidenceStatus, "aged_prior");
    assert.equal(entryGap.causalReferencePrice, 64_950);
    assert.equal(entryGap.causalReferenceSourceTimestampMs, T - 20_000);
    assert.equal(entryGap.causalReferenceAgeMs, 20_000);
    assert.equal(entryGap.signedGapDollars, -50);
    assert.equal(entryGap.absoluteGapDollars, 50);
    assert.equal(entryGap.referenceVsTarget, "below_target");
    assert.equal(entryGap.thresholdRule.floorStrike, 65_000);
    assert.equal(entryGap.thresholdRule.source, "kalshi_market_api_snapshot");
  });

  it("reports an explicit unavailable status when no causal pair exists, never substituting later values", async () => {
    _setPhase4BReferenceEnricherForTesting(async (_market, snapshot) =>
      buildPhase4BReferenceObservation({
        snapshotId: snapshot.snapshotId, asset: "BTC", source: "kraken",
        referencePrice: null, sourceTimestampMs: null, capturedAtMs: snapshot.capturedAtMs,
        error: "reference_fetch_error", history: [{ timestampMs: T + 9_000, price: 65_500 }], intervalStartMs: null,
      }));
    const entryGap = findEntryGap(await captureAndCollect({}));
    assert.equal(entryGap.qualification, "in_band_unavailable");
    assert.equal(entryGap.causalEvidenceStatus, "unavailable");
    assert.equal(entryGap.causalReferencePrice, null);
    assert.equal(entryGap.signedGapDollars, null);
    assert.deepEqual([...entryGap.unavailableReasons], ["causal_reference_unavailable_at_or_before_capture"]);
  });

  it("marks quotes outside the BTC 90-95 band while still retaining causal evidence", async () => {
    _setPhase4BReferenceEnricherForTesting(async (_market, snapshot) =>
      buildPhase4BReferenceObservation({
        snapshotId: snapshot.snapshotId, asset: "BTC", source: "kraken",
        referencePrice: 65_050, sourceTimestampMs: snapshot.capturedAtMs, capturedAtMs: snapshot.capturedAtMs,
        history: [], intervalStartMs: null,
      }));
    const entryGap = findEntryGap(await captureAndCollect({ displayedEntryPriceCents: 76, configuredLimitCents: 76 }));
    assert.equal(entryGap.qualification, "out_of_band");
    assert.equal(entryGap.causalEvidenceStatus, "live");
    assert.equal(entryGap.causalReferencePrice, 65_050);
    assert.equal(entryGap.signedGapDollars, 50);
    assert.equal(entryGap.referenceVsTarget, "above_target");
  });

  it("starts empty and warns (without throwing) when the history file contains corrupt JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase4b-corrupt-history-"));
    const path = join(directory, "reference-history.json");
    try {
      // Write corrupt (truncated) JSON — simulates a crash mid-write.
      writeFileSync(path, '{"BTC":[{"timestampMs":10000000,"price":64900}', "utf8");
      _setPhase4BReferenceHistoryPathForTesting(path);
      const beforeCount = getPhase4BReferenceHistoryCorruptReloadCount();
      // Must not throw; must return empty history.
      const result = getReferenceHistory("BTC", T);
      assert.deepEqual(result, []);
      assert.equal(getPhase4BReferenceHistoryCorruptReloadCount(), beforeCount + 1);
      // Corrupt file must be preserved as .corrupt for forensics.
      assert.ok(existsSync(`${path}.corrupt`), "corrupt file must be renamed to .corrupt");
    } finally {
      _resetPhase4BReferenceHistoryForTesting();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a valid but schema-invalid history file (non-object top level) as corrupt: warns, renames, increments counter", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase4b-corrupt-history-"));
    const path = join(directory, "reference-history.json");
    try {
      // Valid JSON but wrong type: a plain array instead of an object map.
      writeFileSync(path, "[1, 2, 3]", "utf8");
      _setPhase4BReferenceHistoryPathForTesting(path);
      const beforeCount = getPhase4BReferenceHistoryCorruptReloadCount();
      // Must not throw; must return empty history.
      const result = getReferenceHistory("BTC", T);
      assert.deepEqual(result, []);
      // Counter must have incremented — same as truncated-JSON path.
      assert.equal(getPhase4BReferenceHistoryCorruptReloadCount(), beforeCount + 1);
      // File must be preserved as .corrupt so forensic content is not lost.
      assert.ok(existsSync(`${path}.corrupt`), "schema-invalid file must be renamed to .corrupt");
    } finally {
      _resetPhase4BReferenceHistoryForTesting();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a non-array asset value as corrupt: warns, renames, increments counter, returns empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase4b-corrupt-history-"));
    const path = join(directory, "reference-history.json");
    try {
      // Valid JSON object but one asset has a non-array value.
      writeFileSync(path, JSON.stringify({ BTC: "invalid" }), "utf8");
      _setPhase4BReferenceHistoryPathForTesting(path);
      const beforeCount = getPhase4BReferenceHistoryCorruptReloadCount();
      assert.deepEqual(getReferenceHistory("BTC", T), []);
      assert.equal(getPhase4BReferenceHistoryCorruptReloadCount(), beforeCount + 1);
      assert.ok(existsSync(`${path}.corrupt`), "non-array asset value must be renamed to .corrupt");
    } finally {
      _resetPhase4BReferenceHistoryForTesting();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an array containing an invalid point (wrong field types) as corrupt: warns, renames, increments counter", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase4b-corrupt-history-"));
    const path = join(directory, "reference-history.json");
    try {
      // Valid JSON object/array but one point has a non-numeric timestampMs.
      writeFileSync(path, JSON.stringify({ BTC: [{ timestampMs: "bad", price: 64900 }] }), "utf8");
      _setPhase4BReferenceHistoryPathForTesting(path);
      const beforeCount = getPhase4BReferenceHistoryCorruptReloadCount();
      assert.deepEqual(getReferenceHistory("BTC", T), []);
      assert.equal(getPhase4BReferenceHistoryCorruptReloadCount(), beforeCount + 1);
      assert.ok(existsSync(`${path}.corrupt`), "invalid point field must be renamed to .corrupt");
    } finally {
      _resetPhase4BReferenceHistoryForTesting();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat expired or future-timestamped points as corrupt — they are silently filtered by clock safety", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase4b-corrupt-history-"));
    const path = join(directory, "reference-history.json");
    try {
      // Structurally valid points that are simply outside the clock/retention window.
      writeFileSync(path, JSON.stringify({
        BTC: [
          { timestampMs: T - 20 * 60_000, price: 64800 }, // expired (> 15 min ago)
          { timestampMs: T + 5_000, price: 64900 },       // future
        ],
      }), "utf8");
      _setPhase4BReferenceHistoryPathForTesting(path);
      const beforeCount = getPhase4BReferenceHistoryCorruptReloadCount();
      // All points filtered by clock safety — empty result, but NOT a corrupt event.
      assert.deepEqual(getReferenceHistory("BTC", T), []);
      assert.equal(getPhase4BReferenceHistoryCorruptReloadCount(), beforeCount, "clock-filtered points must not increment corrupt counter");
      assert.ok(!existsSync(`${path}.corrupt`), "clock-filtered file must not be renamed to .corrupt");
    } finally {
      _resetPhase4BReferenceHistoryForTesting();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists reference history across a restart and drops future or expired points on reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase4b-entry-gap-history-"));
    const path = join(directory, "reference-history.json");
    try {
      _setPhase4BReferenceHistoryPathForTesting(path);
      appendReferencePoint("BTC", { timestampMs: T - 10_000, price: 64_900 }, T);
      appendReferencePoint("BTC", { timestampMs: T - 5_000, price: 64_950 }, T);
      // Simulate a restart: in-memory state cleared, lazily reloaded from disk.
      _setPhase4BReferenceHistoryPathForTesting(path);
      const restored = getReferenceHistory("BTC", T + 1_000);
      assert.deepEqual(restored, [
        { timestampMs: T - 10_000, price: 64_900 },
        { timestampMs: T - 5_000, price: 64_950 },
      ]);
      // Clock safety on reload: pretend the clock moved backwards past the points.
      _setPhase4BReferenceHistoryPathForTesting(path);
      assert.deepEqual(getReferenceHistory("BTC", T - 11_000), []);
      // Retention on reload: points older than the window are dropped.
      _setPhase4BReferenceHistoryPathForTesting(path);
      assert.deepEqual(getReferenceHistory("BTC", T + 16 * 60_000), []);
    } finally {
      _resetPhase4BReferenceHistoryForTesting();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds a read-only report with signed, directional, and absolute gaps plus visible unavailable rows", async () => {
    _setPhase4BReferenceEnricherForTesting(async (_market, snapshot) =>
      buildPhase4BReferenceObservation({
        snapshotId: snapshot.snapshotId, asset: "BTC", source: "kraken",
        referencePrice: 64_920, sourceTimestampMs: snapshot.capturedAtMs - 2_000, capturedAtMs: snapshot.capturedAtMs,
        history: [], intervalStartMs: null,
      }));
    const measurable = findEntryGap(await captureAndCollect({ side: "no", displayedEntryPriceCents: 93 }));
    _setPhase4BReferenceEnricherForTesting(async (_market, snapshot) =>
      buildPhase4BReferenceObservation({
        snapshotId: snapshot.snapshotId, asset: "BTC", source: "kraken",
        referencePrice: null, sourceTimestampMs: null, capturedAtMs: snapshot.capturedAtMs,
        error: "reference_fetch_error", history: [], intervalStartMs: null,
      }));
    const unavailable = findEntryGap(await captureAndCollect({ timestampMs: T + 60_000, closeTime: new Date(T + 180_000).toISOString() }));
    const outOfBand: Record<string, unknown> = { ...(measurable as unknown as Record<string, unknown>), qualification: "out_of_band", snapshotId: "x" };

    const report = buildPhase4BEntryGapReport([
      measurable as unknown as Record<string, unknown>,
      unavailable as unknown as Record<string, unknown>,
      outOfBand,
      { hypothesisVersion: "other-v1", snapshotId: "y" },
    ]);
    assert.equal(report.summary.inBandTotal, 2);
    assert.equal(report.summary.measurable, 1);
    assert.equal(report.summary.unavailable, 1);
    assert.deepEqual(report.summary.evidenceStatusCounts, { live: 1, unavailable: 1 });
    const first = report.rows[0]!;
    assert.equal(first.side, "no");
    assert.equal(first.signedGapDollars, 80);
    assert.equal(first.absoluteGapDollars, 80);
    assert.equal(first.referenceVsTarget, "below_target");
    assert.equal(first.thresholdStrike, 65_000);
    assert.equal(first.causalReferenceAgeMs, 2_000);
    const second = report.rows[1]!;
    assert.equal(second.qualification, "in_band_unavailable");
    assert.equal(second.causalEvidenceStatus, "unavailable");
    assert.deepEqual([...second.unavailableReasons], ["causal_reference_unavailable_at_or_before_capture"]);
  });
});

// ── Backfill report tests ──────────────────────────────────────────────────────

const SNAP_BASE = {
  marketId: "KXBTC15M-26AUG151200-B65000",
  candidateSide: "yes",
  capturedAtMs: T,
  secondsLeft: 120,
  displayedEntryPriceCents: 92,
  thresholdRule: {
    floorStrike: 65_000,
    comparisonOperator: ">=",
    source: "kalshi_market_api_snapshot",
    unavailableReason: null,
  },
};

const REF_MEASURABLE = {
  snapshotId: "snap-001",
  capturedAtMs: T,
  causalEvidenceStatus: "live",
  causalReferencePrice: 65_100,
  causalReferenceSourceTimestampMs: T - 1_000,
  causalReferenceAgeMs: 1_000,
};

const REF_UNAVAILABLE = {
  snapshotId: "snap-002",
  capturedAtMs: T + 60_000,
  causalEvidenceStatus: "unavailable",
  causalReferencePrice: null,
  causalReferenceSourceTimestampMs: null,
  causalReferenceAgeMs: null,
};

describe("buildPhase4BEntryGapBackfillReport", () => {
  it("always stamps backfillSource and backfillLabel on the report", () => {
    const report = buildPhase4BEntryGapBackfillReport([], T);
    assert.equal(report.backfillSource, "phase4b_reference_observations");
    assert.equal(report.backfillLabel, "historical_reconstruction_from_persisted_causal_evidence");
    assert.equal(report.hypothesisVersion, PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION);
    assert.equal(report.generatedAtMs, T);
  });

  it("produces a measurable row with correct gap values when causal reference is present", () => {
    const report = buildPhase4BEntryGapBackfillReport(
      [{ referencePayload: REF_MEASURABLE, snapshotPayload: { ...SNAP_BASE, snapshotId: "snap-001" } }],
      T,
    );
    assert.equal(report.summary.inBandTotal, 1);
    assert.equal(report.summary.measurable, 1);
    assert.equal(report.summary.unavailable, 0);

    const row = report.rows[0]!;
    assert.equal(row.snapshotId, "snap-001");
    assert.equal(row.qualification, "in_band_measurable");
    assert.equal(row.causalEvidenceStatus, "live");
    assert.equal(row.causalReferencePrice, 65_100);
    // YES side: signedGapDollars = causalReferencePrice - floorStrike = 65100 - 65000 = 100
    assert.equal(row.signedGapDollars, 100);
    assert.equal(row.absoluteGapDollars, 100);
    assert.equal(row.referenceVsTarget, "above_target");
    assert.equal(row.thresholdStrike, 65_000);
    assert.equal(row.backfillSource, "phase4b_reference_observations");
  });

  it("produces null signedGapDollars for an unavailable row and never invents a value", () => {
    const snap = { ...SNAP_BASE, snapshotId: "snap-002", displayedEntryPriceCents: 91 };
    const report = buildPhase4BEntryGapBackfillReport(
      [{ referencePayload: REF_UNAVAILABLE, snapshotPayload: snap }],
      T,
    );
    assert.equal(report.summary.inBandTotal, 1);
    assert.equal(report.summary.measurable, 0);
    assert.equal(report.summary.unavailable, 1);

    const row = report.rows[0]!;
    assert.equal(row.qualification, "in_band_unavailable");
    assert.equal(row.causalEvidenceStatus, "unavailable");
    assert.equal(row.signedGapDollars, null);
    assert.equal(row.absoluteGapDollars, null);
    assert.equal(row.referenceVsTarget, null);
    assert.ok(row.unavailableReasons.includes("causal_reference_unavailable_at_or_before_capture"));
    assert.equal(row.backfillSource, "phase4b_reference_observations");
  });

  it("excludes out-of-band rows from the report rows array and inBand summary counts", () => {
    const outOfBandSnap = { ...SNAP_BASE, snapshotId: "snap-003", displayedEntryPriceCents: 76 };
    const report = buildPhase4BEntryGapBackfillReport(
      [{ referencePayload: REF_MEASURABLE, snapshotPayload: outOfBandSnap }],
      T,
    );
    // btcSnapshotsWithoutGapRecord counts ALL pairs; inBandTotal counts only in-band
    assert.equal(report.summary.btcSnapshotsWithoutGapRecord, 1);
    assert.equal(report.summary.inBandTotal, 0);
    assert.equal(report.summary.measurable, 0);
    assert.equal(report.rows.length, 0);
  });

  it("skips pairs with no usable snapshotId from either payload", () => {
    const report = buildPhase4BEntryGapBackfillReport(
      [{ referencePayload: {}, snapshotPayload: {} }],
      T,
    );
    assert.equal(report.rows.length, 0);
    assert.equal(report.summary.inBandTotal, 0);
  });

  it("handles mixed pairs correctly: measurable, unavailable, out-of-band, and no-id are counted right", () => {
    const pairs = [
      // measurable, in-band
      { referencePayload: REF_MEASURABLE, snapshotPayload: { ...SNAP_BASE, snapshotId: "snap-001" } },
      // unavailable, in-band
      { referencePayload: REF_UNAVAILABLE, snapshotPayload: { ...SNAP_BASE, snapshotId: "snap-002", displayedEntryPriceCents: 90 } },
      // out-of-band (76¢)
      { referencePayload: { ...REF_MEASURABLE, snapshotId: "snap-003" }, snapshotPayload: { ...SNAP_BASE, snapshotId: "snap-003", displayedEntryPriceCents: 76 } },
      // no snapshotId in either — skipped entirely
      { referencePayload: {}, snapshotPayload: {} },
    ];
    const report = buildPhase4BEntryGapBackfillReport(pairs, T);

    assert.equal(report.summary.btcSnapshotsWithoutGapRecord, 4);
    assert.equal(report.summary.inBandTotal, 2);
    assert.equal(report.summary.measurable, 1);
    assert.equal(report.summary.unavailable, 1);
    assert.equal(report.rows.length, 2);
    assert.ok(report.rows.every((r) => r.backfillSource === "phase4b_reference_observations"));
    assert.deepEqual(report.summary.evidenceStatusCounts, { live: 1, unavailable: 1 });
  });

  it("falls back to the snapshot snapshotId when the reference payload lacks one", () => {
    const refWithoutId = { ...REF_MEASURABLE };
    delete (refWithoutId as Record<string, unknown>)["snapshotId"];
    const report = buildPhase4BEntryGapBackfillReport(
      [{ referencePayload: refWithoutId, snapshotPayload: { ...SNAP_BASE, snapshotId: "snap-from-snap" } }],
      T,
    );
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0]!.snapshotId, "snap-from-snap");
  });

  it("skips a pair where both payloads carry non-empty but conflicting snapshotIds — never mixes data from two different records", () => {
    // ref says "snap-REF", snap says "snap-SNAP" — these are different records;
    // combining their fields would produce a causally invalid backfill row.
    const report = buildPhase4BEntryGapBackfillReport(
      [
        {
          referencePayload: { ...REF_MEASURABLE, snapshotId: "snap-REF" },
          snapshotPayload: { ...SNAP_BASE, snapshotId: "snap-SNAP" },
        },
      ],
      T,
    );
    assert.equal(report.rows.length, 0, "mismatched-ID pair must be skipped entirely");
    assert.equal(report.summary.inBandTotal, 0);
    // btcSnapshotsWithoutGapRecord still counts the pair (it was supplied)
    assert.equal(report.summary.btcSnapshotsWithoutGapRecord, 1);
  });

  it("computes NO-side gap correctly: floorStrike - causalReferencePrice", () => {
    const snapNo = { ...SNAP_BASE, snapshotId: "snap-no-001", candidateSide: "no", displayedEntryPriceCents: 93 };
    // causalReferencePrice = 64_800, floorStrike = 65_000 → signed = 65000 - 64800 = 200
    const refNo = { ...REF_MEASURABLE, snapshotId: "snap-no-001", causalReferencePrice: 64_800 };
    const report = buildPhase4BEntryGapBackfillReport(
      [{ referencePayload: refNo, snapshotPayload: snapNo }],
      T,
    );
    const row = report.rows[0]!;
    assert.equal(row.side, "no");
    assert.equal(row.signedGapDollars, 200);
    assert.equal(row.absoluteGapDollars, 200);
    assert.equal(row.referenceVsTarget, "below_target");
  });
});
