/**
 * performanceReports.helpers.test.ts
 *
 * Unit tests for the pure exported helpers in performanceReports.ts
 * that are NOT covered by the reverse-sim test file.
 *
 * Covers:
 *   1. sampleSizeWarning — boundary values: null(0), very_small(<30), preliminary(30–99), more_meaningful(100+)
 *   2. easternHour — UTC timestamps map to correct ET hour in EST and EDT
 *   3. easternDayOfWeek — UTC timestamps map to correct ET day-of-week index
 *   4. getPnlReport — asset/band/side breakdowns, pending reconciliation, empty input
 *   5. getEntryTimingReport — seconds-remaining bucket assignment, fillRate, winRate, pending
 *   6. getEntryGapReport — gap-bucket assignment (0–2¢, 3–6¢, 7¢+), excludedMissingPrice counter
 *
 * Runner: esbuild --bundle | node --test  (same pattern as performanceReports.reverseSim.test.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sampleSizeWarning,
  easternHour,
  easternDayOfWeek,
  getPnlReport,
  getEntryTimingReport,
  getEntryGapReport,
  getTradeDecisionEvidenceReport,
  getH002EvidenceReadinessReport,
  getConditionRecommendationsReport,
  getReconciliationView,
  computeFinalReconciliationStatus,
  type LedgerCoverage,
  FALLING_KNIFE_GAP_CENTS,
} from "./performanceReports.js";
import type { OrderAttemptRecord } from "./analytics.js";
import { mergePreflightDecisionRecords, type PreflightDecision } from "./preflightStore.js";

// ── Shared record builder ──────────────────────────────────────────────────────

type TV<T> = { value: T };
function tv<T>(v: T): TV<T> {
  return { value: v };
}

let _seq = 0;

/**
 * Build a minimal OrderAttemptRecord for testing.
 * All fields relevant to the helpers under test are configurable.
 */
function makeRecord(overrides: {
  id?: string;
  ticker?: string;
  series?: string;
  side?: "yes" | "no";
  outcome?: "full_fill" | "partial_fill" | "zero_fill";
  fillPriceCents?: number | null;
  triggerPriceCents?: number;
  contracts?: number;
  win?: boolean | null;
  grossPnlDollars?: number | null;
  netPnlDollars?: number | null;
  outcomeReconciledAt?: number | null;
  timestampMs?: number;
  windowCloseTime?: string | null;
  feeDollars?: number;
  reconcile_failed?: boolean;
  fill_price_source?: "actual" | "limit_fallback" | null;
}): OrderAttemptRecord {
  const id = overrides.id ?? `order-${++_seq}`;
  const {
    ticker,
    series              = "KXBTC15M",
    side                = "yes",
    outcome             = "full_fill",
    fillPriceCents      = 80,
    triggerPriceCents   = 80,
    contracts           = 1,
    win                 = null,
    grossPnlDollars     = null,
    netPnlDollars       = null,
    outcomeReconciledAt = Date.now(),
    timestampMs         = Date.now(),
    windowCloseTime     = null,
    feeDollars          = 0,
    reconcile_failed    = false,
    fill_price_source   = null,
  } = overrides;

  const fp = fillPriceCents ?? 0;

  return {
    id,
    timestampMs,
    ticker:                 ticker ?? `${series}-2026-01-01T12:00:00`,
    series,
    windowCloseTime,
    side,
    attemptNumber:          1,
    source:                 "websocket",
    triggerPriceCents,
    limitPriceCents:        fp + 1,
    requestedContracts:     contracts,
    requestedNotionalCents: fp * contracts,
    clientOrderId:          `client-${id}`,
    orderId:                `server-${id}`,
    fillCount:              contracts,
    remainingCount:         0,
    contracts:              tv(contracts),
    fillPriceCents:         tv(fillPriceCents as number),
    notionalDollars:        tv((fp * contracts) / 100),
    feeDollars:             tv(feeDollars),
    outcome,
    roundTripMs:            50,
    reconciled:             outcomeReconciledAt !== null,
    reconcile_failed,
    fill_price_source,
    win,
    grossPnlDollars,
    netPnlDollars,
    outcomeReconciledAt,
  } as unknown as OrderAttemptRecord;
}

// ── 1. sampleSizeWarning ───────────────────────────────────────────────────────

describe("sampleSizeWarning", () => {
  it("returns null for 0 fills", () => {
    assert.equal(sampleSizeWarning(0), null);
  });

  it("returns very_small for 1 fill", () => {
    assert.equal(sampleSizeWarning(1), "very_small");
  });

  it("returns very_small for 29 fills (boundary below 30)", () => {
    assert.equal(sampleSizeWarning(29), "very_small");
  });

  it("returns preliminary for 30 fills (lower bound)", () => {
    assert.equal(sampleSizeWarning(30), "preliminary");
  });

  it("returns preliminary for 99 fills (boundary below 100)", () => {
    assert.equal(sampleSizeWarning(99), "preliminary");
  });

  it("returns more_meaningful for 100 fills (lower bound)", () => {
    assert.equal(sampleSizeWarning(100), "more_meaningful");
  });

  it("returns more_meaningful for large counts", () => {
    assert.equal(sampleSizeWarning(5000), "more_meaningful");
  });
});

// ── 2. easternHour ────────────────────────────────────────────────────────────

describe("easternHour", () => {
  it("maps 2026-01-15 15:00 UTC to 10 ET (EST = UTC−5)", () => {
    // 2026-01-15 is in January — EST (UTC−5)
    const ms = Date.parse("2026-01-15T15:00:00Z");
    assert.equal(easternHour(ms), 10);
  });

  it("maps 2026-07-15 15:00 UTC to 11 ET (EDT = UTC−4)", () => {
    // 2026-07-15 is in July — EDT (UTC−4)
    const ms = Date.parse("2026-07-15T15:00:00Z");
    assert.equal(easternHour(ms), 11);
  });

  it("maps 2026-01-01 05:00 UTC to 0 ET (midnight)", () => {
    // 05:00 UTC = 00:00 EST
    const ms = Date.parse("2026-01-01T05:00:00Z");
    assert.equal(easternHour(ms), 0);
  });

  it("maps 2026-06-15 04:00 UTC to 0 ET (midnight EDT)", () => {
    // 04:00 UTC = 00:00 EDT
    const ms = Date.parse("2026-06-15T04:00:00Z");
    assert.equal(easternHour(ms), 0);
  });
});

// ── 3. easternDayOfWeek ───────────────────────────────────────────────────────

describe("easternDayOfWeek", () => {
  it("maps 2026-01-12 12:00 UTC to Monday (1) in EST", () => {
    // Jan 1 2026 = Thursday, Jan 12 = Monday
    const ms = Date.parse("2026-01-12T12:00:00Z"); // 07:00 EST
    assert.equal(easternDayOfWeek(ms), 1, "Monday = 1");
  });

  it("maps 2026-07-05 12:00 UTC to Sunday (0) in EDT", () => {
    // July 5, 2026 = Sunday
    const ms = Date.parse("2026-07-05T12:00:00Z"); // 08:00 EDT
    assert.equal(easternDayOfWeek(ms), 0, "Sunday = 0");
  });

  it("maps 2026-07-11 12:00 UTC to Saturday (6) in EDT", () => {
    // July 11, 2026 = Saturday
    const ms = Date.parse("2026-07-11T12:00:00Z");
    assert.equal(easternDayOfWeek(ms), 6, "Saturday = 6");
  });
});

// ── 4. getPnlReport ───────────────────────────────────────────────────────────

describe("getPnlReport — empty input", () => {
  it("returns all-null summary when no orders are provided", () => {
    const r = getPnlReport([], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.summary.fills, 0);
    assert.equal(r.summary.winRate, null);
    assert.equal(r.summary.grossPnlDollars, null);
    assert.equal(r.pending.fillsTotal, 0);
    assert.equal(r.pending.fillsPending, 0);
  });
});

describe("getPnlReport — single BTC win", () => {
  it("rolls up fills, wins, P&L, and roi correctly", () => {
    // 1 BTC fill at 80¢: 1 contract, gross = $0.20, net = $0.19
    const rec = makeRecord({
      series:          "KXBTC15M",
      side:            "yes",
      fillPriceCents:  80,
      contracts:       1,
      win:             true,
      grossPnlDollars: 0.20,
      netPnlDollars:   0.19,
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");

    assert.equal(r.summary.fills,  1);
    assert.equal(r.summary.wins,   1);
    assert.equal(r.summary.losses, 0);
    assert.equal(r.summary.winRate, 1.0);
    assert.ok(Math.abs(r.summary.grossPnlDollars! - 0.20) < 1e-9);
    assert.ok(Math.abs(r.summary.netPnlDollars!   - 0.19) < 1e-9);
    // roi = gross / notional = 0.20 / 0.80
    assert.ok(Math.abs(r.summary.roi! - 0.20 / 0.80) < 1e-9);
    // BTC breakdown
    const btcRow = r.byAsset.find((a) => a.asset === "BTC");
    assert.ok(btcRow, "BTC row present");
    assert.equal(btcRow!.fills, 1);
    // ETH should be empty
    const ethRow = r.byAsset.find((a) => a.asset === "ETH");
    assert.ok(ethRow, "ETH row present");
    assert.equal(ethRow!.fills, 0);
  });
});

describe("getPnlReport — unreconciled fill goes to pending", () => {
  it("counts fill in pending but not in summary", () => {
    const filled = makeRecord({
      win:             true,
      grossPnlDollars: 0.20,
      netPnlDollars:   0.20,
    });
    const unreconciled = makeRecord({
      outcomeReconciledAt: null,
      win:                 null,
      grossPnlDollars:     null,
      netPnlDollars:       null,
    });
    const r = getPnlReport([filled, unreconciled], "test", "2026-01-01", "2026-01-01");

    // Only the reconciled fill should count in summary
    assert.equal(r.summary.fills, 1);
    // Both are fills; one is pending
    assert.equal(r.pending.fillsTotal,      2);
    assert.equal(r.pending.fillsReconciled, 1);
    assert.equal(r.pending.fillsPending,    1);
    assert.equal(r.pending.pendingTickers.length, 1);
  });
});

describe("getPnlReport — P&L band routing", () => {
  it("routes a 78¢ fill to the 76-80 band", () => {
    const rec = makeRecord({
      fillPriceCents:  78,
      win:             true,
      grossPnlDollars: 0.22,
      netPnlDollars:   0.22,
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    const band = r.byBand.find((b) => b.band === "76-80");
    assert.ok(band, "76-80 band present");
    assert.equal(band!.fills, 1);
    assert.equal(band!.wins,  1);
    // Other bands should be empty
    for (const b of r.byBand) {
      if (b.band !== "76-80") assert.equal(b.fills, 0, `band ${b.band} should be empty`);
    }
  });

  it("routes an 85¢ fill to the 86-90 band (fill price, not trigger)", () => {
    // Note: band boundaries — 86-90 has min=86; 85 should land in 81-85
    const rec = makeRecord({
      fillPriceCents:  85,
      win:             false,
      grossPnlDollars: -0.85,
      netPnlDollars:   -0.85,
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    const band81 = r.byBand.find((b) => b.band === "81-85");
    assert.ok(band81, "81-85 band present");
    assert.equal(band81!.fills, 1, "85¢ fill routes to 81-85 band");
  });
});

describe("getPnlReport — won-column fallback band routing", () => {
  // Confirms that an order settled via recoverForwardSettlementsFromSql() (which
  // writes won=true/false directly on order_attempts without setting
  // outcomeReconciledAt via the normal reconciler path) still appears in the
  // correct byBand bucket and is not counted as a pending fill.
  it("counts a won-only fill (outcomeReconciledAt=null, win=true) in the correct band", () => {
    const rec = makeRecord({
      fillPriceCents:      79,
      win:                 true,
      grossPnlDollars:     0.21,
      netPnlDollars:       0.20,
      outcomeReconciledAt: null,  // simulates won-column-only settlement
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    const band = r.byBand.find((b) => b.band === "76-80");
    assert.ok(band, "76-80 band must be present");
    assert.equal(band!.fills, 1, "won-only order must appear in byBand bucket");
    assert.equal(band!.wins,  1, "won-only order must be counted as a win");
    assert.equal(r.pending.fillsPending, 0, "won-only order must NOT appear as pending");
    assert.equal(r.pending.fillsReconciled, 1, "won-only order must count as reconciled");
  });

  it("counts a won-only loss (outcomeReconciledAt=null, win=false) in the correct band", () => {
    const rec = makeRecord({
      fillPriceCents:      82,
      win:                 false,
      grossPnlDollars:     -0.82,
      netPnlDollars:       -0.82,
      outcomeReconciledAt: null,
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    const band = r.byBand.find((b) => b.band === "81-85");
    assert.ok(band, "81-85 band must be present");
    assert.equal(band!.fills,  1, "won-only loss must appear in byBand bucket");
    assert.equal(band!.wins,   0, "loss must not count as a win");
    assert.equal(band!.losses, 1, "loss must be counted in losses");
    assert.equal(r.pending.fillsPending, 0, "won-only loss must NOT appear as pending");
  });

  it("keeps a truly-pending fill (outcomeReconciledAt=null, win=null) as pending", () => {
    const rec = makeRecord({
      fillPriceCents:      80,
      win:                 null,
      grossPnlDollars:     null,
      netPnlDollars:       null,
      outcomeReconciledAt: null,
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    // All bands must be empty — pending fills must not appear in byBand
    for (const b of r.byBand) {
      assert.equal(b.fills, 0, `band ${b.band} must be empty for a pending fill`);
    }
    assert.equal(r.pending.fillsPending, 1, "truly-pending fill must remain in fillsPending");
  });
});

describe("getPnlReport — side breakdown", () => {
  it("separates YES and NO fills into correct bySide rows", () => {
    const yes = makeRecord({ side: "yes", win: true,  grossPnlDollars: 0.20, netPnlDollars: 0.20 });
    const no  = makeRecord({ side: "no",  win: false, grossPnlDollars: -0.20, netPnlDollars: -0.20 });
    const r = getPnlReport([yes, no], "test", "2026-01-01", "2026-01-01");

    const yesRow = r.bySide.find((s) => s.side === "yes");
    const noRow  = r.bySide.find((s) => s.side === "no");
    assert.ok(yesRow && noRow);
    assert.equal(yesRow!.fills, 1);
    assert.equal(yesRow!.wins,  1);
    assert.equal(noRow!.fills, 1);
    assert.equal(noRow!.wins,  0);
  });
});

describe("getPnlReport — estimatedFillCount", () => {
  it("is 0 when no fills used an estimated price", () => {
    const rec = makeRecord({ win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19 });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.estimatedFillCount, 0);
  });

  it("counts fills where fill_price_source='limit_fallback'", () => {
    const estimated = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      fill_price_source: "limit_fallback",
    });
    const confirmed = makeRecord({ win: false, grossPnlDollars: -0.80, netPnlDollars: -0.80 });
    const r = getPnlReport([estimated, confirmed], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.estimatedFillCount, 1, "only the limit_fallback fill counts as estimated");
  });

  it("counts fills where reconcile_failed=true regardless of fill_price_source", () => {
    // reconcile_failed=true but fill_price_source is NOT 'limit_fallback'
    const estimated = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      reconcile_failed: true,
      fill_price_source: null,
    });
    const r = getPnlReport([estimated], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.estimatedFillCount, 1, "reconcile_failed=true is estimated even without limit_fallback source");
  });

  it("does not double-count a fill with both conditions", () => {
    const both = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      reconcile_failed: true,
      fill_price_source: "limit_fallback",
    });
    const r = getPnlReport([both], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.estimatedFillCount, 1, "single fill counts as one even when both flags are set");
  });
});

// ── 5. getEntryTimingReport ───────────────────────────────────────────────────

describe("getEntryTimingReport — empty input", () => {
  it("returns empty buckets with null rates", () => {
    const r = getEntryTimingReport([], "test", "2026-01-01", "2026-01-01");
    for (const b of r.buckets) {
      assert.equal(b.submissions, 0);
      assert.equal(b.fills,       0);
      assert.equal(b.fillRate,    null);
      assert.equal(b.winRate,     null);
    }
  });
});

describe("getEntryTimingReport — bucket routing by seconds remaining", () => {
  it("routes a fill with 30 s remaining to '<1:00 left' bucket", () => {
    // <1:00 left bucket: [0, 60) seconds
    const now = Date.now();
    const rec = makeRecord({
      timestampMs:     now,
      windowCloseTime: new Date(now + 30_000).toISOString(),
      win:             true,
      grossPnlDollars: 0.20,
      netPnlDollars:   0.20,
    });
    const r = getEntryTimingReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "<1:00 left");
    assert.ok(bucket, "<1:00 left bucket present");
    assert.equal(bucket!.fills,       1);
    assert.equal(bucket!.submissions, 1);
    assert.equal(bucket!.winRate,     1);
  });

  it("routes a fill with 90 s remaining to '1:00–2:00 left' bucket", () => {
    // 1:00–2:00 left bucket: [60, 120) seconds
    const now = Date.now();
    const rec = makeRecord({
      timestampMs:     now,
      windowCloseTime: new Date(now + 90_000).toISOString(),
      win:             false,
      grossPnlDollars: -0.80,
      netPnlDollars:   -0.80,
    });
    const r = getEntryTimingReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "1:00–2:00 left");
    assert.ok(bucket, "1:00–2:00 left bucket present");
    assert.equal(bucket!.fills,   1);
    assert.equal(bucket!.winRate, 0);
  });

  it("routes a fill with 150 s remaining to '2:00–3:00 left' bucket", () => {
    // 2:00–3:00 left bucket: [120, 180) seconds
    const now = Date.now();
    const rec = makeRecord({
      timestampMs:     now,
      windowCloseTime: new Date(now + 150_000).toISOString(),
      win:             true,
      grossPnlDollars: 0.20,
      netPnlDollars:   0.20,
    });
    const r = getEntryTimingReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "2:00–3:00 left");
    assert.ok(bucket, "2:00–3:00 left bucket present");
    assert.equal(bucket!.fills, 1);
  });

  it("routes a fill with 400 s remaining to '>3:00 left' bucket", () => {
    const closeMs = Date.now() + 400_000;
    const rec = makeRecord({
      timestampMs:     Date.now(),
      windowCloseTime: new Date(closeMs).toISOString(),
      win:             true,
      grossPnlDollars: 0.20,
      netPnlDollars:   0.20,
    });
    const r = getEntryTimingReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === ">3:00 left");
    assert.ok(bucket, ">3:00 left bucket present");
    assert.equal(bucket!.fills, 1);
  });

  it("excludes fills without a windowCloseTime from all buckets", () => {
    const rec = makeRecord({
      windowCloseTime: null,
      win:             true,
      grossPnlDollars: 0.20,
      netPnlDollars:   0.20,
    });
    const r = getEntryTimingReport([rec], "test", "2026-01-01", "2026-01-01");
    const totalBucketFills = r.buckets.reduce((s, b) => s + b.fills, 0);
    assert.equal(totalBucketFills, 0, "no bucket should count a fill without windowCloseTime");
    // The fill is still counted as pending/fillsTotal
    assert.equal(r.pending.fillsTotal, 1);
  });

  it("fillRate = fills / submissions for a bucket", () => {
    const now = Date.now();
    const closeMs = now + 30_000; // <1:00 bucket: [0, 60) seconds
    const fillRec = makeRecord({
      timestampMs:     now,
      windowCloseTime: new Date(closeMs).toISOString(),
      outcome:         "full_fill",
      win:             true,
      grossPnlDollars: 0.20,
      netPnlDollars:   0.20,
    });
    const zeroFillRec = makeRecord({
      timestampMs:     Date.now(),
      windowCloseTime: new Date(closeMs).toISOString(),
      outcome:         "zero_fill",
      win:             null,
      outcomeReconciledAt: null,
    });
    const r = getEntryTimingReport([fillRec, zeroFillRec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "<1:00 left");
    assert.ok(bucket);
    assert.equal(bucket!.submissions, 2);
    assert.equal(bucket!.fills,       1);
    assert.ok(Math.abs(bucket!.fillRate! - 0.5) < 1e-9, "fillRate should be 0.5");
  });
});

// ── 6. getEntryGapReport — gap bucket routing ─────────────────────────────────

describe("getEntryGapReport — gap bucket routing", () => {
  it("routes a 1¢ gap into the '0–2¢' bucket", () => {
    const rec = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 81,  // gap = 1
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "0–2¢");
    assert.ok(bucket);
    assert.equal(bucket!.fills, 1);
  });

  it("routes a 5¢ gap into the '3–6¢' bucket", () => {
    const rec = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 85,  // gap = 5
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "3–6¢");
    assert.ok(bucket);
    assert.equal(bucket!.fills, 1);
  });

  it("routes a 10¢ gap into the '7¢+' bucket", () => {
    const rec = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 90,  // gap = 10
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "7¢+");
    assert.ok(bucket);
    assert.equal(bucket!.fills, 1);
  });

  it("routes a negative gap (fill above trigger) into the '0–2¢' bucket", () => {
    // Negative gap means fill was above trigger; ENTRY_GAP_BUCKETS has minGap=-Infinity for first bucket
    const rec = makeRecord({
      fillPriceCents:    82,
      triggerPriceCents: 80,  // gap = −2
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "0–2¢");
    assert.ok(bucket);
    assert.equal(bucket!.fills, 1, "negative gap lands in first (catch-all low) bucket");
  });

  it("counts excludedMissingPrice for fills without a fill price", () => {
    const noFillPrice = makeRecord({
      fillPriceCents:    null,
      triggerPriceCents: 80,
    });
    const r = getEntryGapReport([noFillPrice], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.excludedMissingPrice, 1, "fill with null fill price should be excluded");
    const totalBucketFills = r.buckets.reduce((s, b) => s + b.fills, 0);
    assert.equal(totalBucketFills, 0, "no bucket fill for missing-price record");
  });

  it("FALLING_KNIFE_GAP_CENTS threshold matches the per-trade fallingKnife flag", () => {
    const knife = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 80 + FALLING_KNIFE_GAP_CENTS,  // exactly at threshold
    });
    const below = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 80 + FALLING_KNIFE_GAP_CENTS - 1,  // one below
    });
    const r = getEntryGapReport([knife, below], "test", "2026-01-01", "2026-01-01");
    const knifeTrade = r.trades.find((t) => t.id === knife.id);
    const belowTrade = r.trades.find((t) => t.id === below.id);
    assert.ok(knifeTrade, "knife trade present");
    assert.ok(belowTrade, "below trade present");
    assert.equal(knifeTrade!.fallingKnife, true,  "gap ≥ threshold should be flagged");
    assert.equal(belowTrade!.fallingKnife, false, "gap < threshold should not be flagged");
  });

  it("winRate is null when no reconciled fills are in a bucket", () => {
    const rec = makeRecord({
      fillPriceCents:      80,
      triggerPriceCents:   81, // gap=1 → '0–2¢' bucket
      win:                 null,
      outcomeReconciledAt: null,
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const bucket = r.buckets.find((b) => b.label === "0–2¢");
    assert.ok(bucket);
    assert.equal(bucket!.winRate, null, "winRate is null when reconciled=0");
    assert.equal(bucket!.fills,        1);
    assert.equal(bucket!.reconciled,   0);
  });
});

describe("getEntryGapReport — estimatedFillPrice flag on trades", () => {
  it("is false when fill has no estimation flags", () => {
    const rec = makeRecord({ fillPriceCents: 80, triggerPriceCents: 82 });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const trade = r.trades.find((t) => t.id === rec.id);
    assert.ok(trade, "trade present");
    assert.equal(trade!.estimatedFillPrice, false, "no flags → not estimated");
  });

  it("is true when fill_price_source='limit_fallback'", () => {
    const rec = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 82,
      fill_price_source: "limit_fallback",
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const trade = r.trades.find((t) => t.id === rec.id);
    assert.ok(trade, "trade present");
    assert.equal(trade!.estimatedFillPrice, true, "limit_fallback source → estimated");
  });

  it("is true when reconcile_failed=true even with null fill_price_source", () => {
    const rec = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 82,
      reconcile_failed:  true,
      fill_price_source: null,
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const trade = r.trades.find((t) => t.id === rec.id);
    assert.ok(trade, "trade present");
    assert.equal(trade!.estimatedFillPrice, true, "reconcile_failed=true → estimated regardless of source");
  });

  it("is true when reconcile_failed=true even with fill_price_source='actual'", () => {
    const rec = makeRecord({
      fillPriceCents:    80,
      triggerPriceCents: 82,
      reconcile_failed:  true,
      fill_price_source: "actual",
    });
    const r = getEntryGapReport([rec], "test", "2026-01-01", "2026-01-01");
    const trade = r.trades.find((t) => t.id === rec.id);
    assert.ok(trade, "trade present");
    assert.equal(trade!.estimatedFillPrice, true, "reconcile_failed=true with 'actual' source still counts as estimated");
  });
});

describe("getTradeDecisionEvidenceReport", () => {
  const skip = (overrides: Partial<PreflightDecision> = {}): PreflightDecision => ({
    ticker: "KXETH15M-test", series: "KXETH15M", side: "no", timestampMs: 1,
    secondsLeft: 90, quotedBboAsk: 80, bboAgeMs: 1, bboDerivedLimitCents: 80,
    executableBestAskCents: 80, bboToL2GapCents: 0, verifiedLimitCents: 80,
    depthAtLimitDollars: 0, depthAtLimitContracts: 0, intendedContracts: 1,
    intendedNotionalCents: 80, adjustedContracts: 0, fillFractionEstimate: 0,
    nearLimitLevels: [], l2FetchLatencyMs: 1, decision: "skip_zero_depth", marketResult: "yes", ...overrides,
  });
  it("keeps actual P&L limited to submitted settled fills and labels unknowns", () => {
    const submitted = makeRecord({
      fillPriceCents: 80, win: true, grossPnlDollars: .2, netPnlDollars: .18,
      outcomeReconciledAt: 1_754_524_800_000,
    });
    const pending = makeRecord({ outcomeReconciledAt: null, win: null, netPnlDollars: null });
    const report = getTradeDecisionEvidenceReport([submitted, pending], [skip(), skip({ ticker: "unknown", marketResult: null })], "test");
    assert.equal(report.readonly, true);
    assert.equal(report.summary.settled, 1);
    assert.equal(report.summary.pendingOrUnknown, 1);
    assert.equal(report.summary.netPnlDollars, .18, "skip opportunities must not create P&L");
    assert.equal(report.bySkipReason[0]!.skippedSettled, 1);
    assert.equal(report.bySkipReason[0]!.sampleStatus, "observation");
    assert.ok(report.byPriceBand[0]!.winRateCi95, "settled cohort includes uncertainty");
    assert.equal(report.hypotheses[0]!.status, "observation", "small samples never become actionable");
  });
  it("local decision records win while durable records fill restart gaps", () => {
    const local = skip({ ticker: "same", marketResult: "yes" });
    const sqlPatch = skip({ ticker: "same", marketResult: "no" });
    const durableOnly = skip({ ticker: "sql-only" });
    const merged = mergePreflightDecisionRecords([local], [sqlPatch, durableOnly]);
    assert.equal(merged.length, 2);
    assert.equal(merged.find((d) => d.ticker === "same")!.marketResult, "yes");
    assert.ok(merged.some((d) => d.ticker === "sql-only"));
  });

  // ── Restart-safety: no local NDJSON files ────────────────────────────────────
  //
  // These tests confirm the Task 326 guarantee: after a production restart where
  // no NDJSON files are present on disk, the evidence report must fall back
  // entirely to durable SQL rows and produce the same cohort counts as it would
  // if the NDJSON files had been present.

  it("mergePreflightDecisionRecords with empty disk returns all SQL rows unchanged", () => {
    const sqlRows: PreflightDecision[] = [
      skip({ ticker: "KXBTC15M-A", series: "KXBTC15M", marketResult: "yes", timestampMs: 1 }),
      skip({ ticker: "KXBTC15M-B", series: "KXBTC15M", marketResult: "no",  timestampMs: 2 }),
      skip({ ticker: "KXETH15M-C", series: "KXETH15M", marketResult: "yes", timestampMs: 3 }),
    ];

    // Simulate restart with no local NDJSON files — fromDisk is empty
    const merged = mergePreflightDecisionRecords([], sqlRows);

    assert.equal(merged.length, 3, "all SQL rows must be returned when disk is empty");
    assert.ok(merged.some((d) => d.ticker === "KXBTC15M-A"));
    assert.ok(merged.some((d) => d.ticker === "KXBTC15M-B"));
    assert.ok(merged.some((d) => d.ticker === "KXETH15M-C"));
  });

  it("evidence report cohort counts are identical whether decisions came from disk or SQL", () => {
    // The same three decisions are provided via the disk path in scenario A
    // and via the SQL path in scenario B (simulating a restart with no NDJSON).
    const decisions: PreflightDecision[] = [
      skip({ ticker: "KXBTC15M-A", series: "KXBTC15M", decision: "skip_zero_depth",   marketResult: "yes", timestampMs: 1 }),
      skip({ ticker: "KXBTC15M-B", series: "KXBTC15M", decision: "skip_price_band",   marketResult: "no",  timestampMs: 2 }),
      skip({ ticker: "KXETH15M-C", series: "KXETH15M", decision: "skip_stale_bbo_gap", marketResult: "yes", timestampMs: 3 }),
    ];

    // Scenario A: decisions from NDJSON disk files (normal case)
    const fromDisk = mergePreflightDecisionRecords(decisions, []);
    const reportA  = getTradeDecisionEvidenceReport([], fromDisk, "all-time", {
      localDecisionRecords:   decisions.length,
      durableDecisionRecords: 0,
    });

    // Scenario B: no disk files — decisions exclusively from durable SQL (restart case)
    const fromSql = mergePreflightDecisionRecords([], decisions);
    const reportB = getTradeDecisionEvidenceReport([], fromSql, "all-time", {
      localDecisionRecords:   0,
      durableDecisionRecords: decisions.length,
    });

    // Both scenarios must produce identical cohort counts because the merged
    // decision list is the same set of records regardless of the source.
    assert.equal(
      reportA.summary.settled + reportA.summary.pendingOrUnknown,
      reportB.summary.settled + reportB.summary.pendingOrUnknown,
      "total items must match between disk and SQL source paths",
    );
    assert.equal(reportA.summary.settled, reportB.summary.settled,
      "settled count must match");
    assert.equal(reportA.byAsset.length, reportB.byAsset.length,
      "asset breakdown row count must match");
    assert.equal(reportA.bySkipReason.length, reportB.bySkipReason.length,
      "skip-reason row count must match");
  });

  it("dataSources reflects localDecisionRecords=0 and non-zero durableDecisionRecords after restart", () => {
    const sqlRows: PreflightDecision[] = [
      skip({ ticker: "KXBTC15M-D", series: "KXBTC15M", marketResult: "yes", timestampMs: 10 }),
      skip({ ticker: "KXBTC15M-E", series: "KXBTC15M", marketResult: "no",  timestampMs: 11 }),
    ];
    const merged = mergePreflightDecisionRecords([], sqlRows);
    const report = getTradeDecisionEvidenceReport([], merged, "all-time", {
      localDecisionRecords:   0,
      durableDecisionRecords: sqlRows.length,
    });

    assert.equal(report.dataSources.localDecisionRecords, 0,
      "localDecisionRecords must be 0 when no NDJSON files were present");
    assert.equal(report.dataSources.durableDecisionRecords, sqlRows.length,
      "durableDecisionRecords must equal the number of SQL rows loaded");
    assert.equal(report.dataSources.orderRecords, 0);
    // The two decisions share the same series and have settled market results
    assert.ok(merged.length > 0, "merged must be non-empty (non-zero decision count from SQL)");
  });

  it("mergePreflightDecisionRecords with empty SQL returns disk rows unchanged", () => {
    // Inverse of the restart scenario — confirms the no-op case for normal operation
    const diskRows: PreflightDecision[] = [
      skip({ ticker: "KXBTC15M-F", timestampMs: 20 }),
      skip({ ticker: "KXBTC15M-G", timestampMs: 21 }),
    ];
    const merged = mergePreflightDecisionRecords(diskRows, []);
    assert.equal(merged.length, diskRows.length,
      "disk-only result must equal disk rows when SQL is empty");
  });

  it("report is readonly and includes a non-empty caveat", () => {
    const merged = mergePreflightDecisionRecords([], [
      skip({ ticker: "KXBTC15M-H", marketResult: "yes", timestampMs: 30 }),
    ]);
    const report = getTradeDecisionEvidenceReport([], merged, "7d", {
      localDecisionRecords:   0,
      durableDecisionRecords: 1,
    });
    assert.equal(report.readonly, true);
    assert.ok(typeof report.caveat === "string" && report.caveat.length > 0,
      "report must carry a non-empty caveat string");
    assert.equal(report.period, "7d");
  });
});

describe("getH002EvidenceReadinessReport", () => {
  const decision = (overrides: Partial<PreflightDecision> = {}): PreflightDecision => ({
    ticker: "KXBTC15M-h002", series: "KXBTC15M", side: "yes", timestampMs: 10,
    secondsLeft: 90, quotedBboAsk: 80, bboAgeMs: 10, bboDerivedLimitCents: 80,
    executableBestAskCents: 80, bboToL2GapCents: 0, verifiedLimitCents: 80,
    depthAtLimitDollars: 100, depthAtLimitContracts: 125, intendedContracts: 1,
    intendedNotionalCents: 80, adjustedContracts: 1, fillFractionEstimate: 1,
    nearLimitLevels: [], l2FetchLatencyMs: 10, decision: "submit", marketResult: "yes", ...overrides,
  });
  it("reports no_data for an empty research scope", () => {
    const report = getH002EvidenceReadinessReport([], [], "today");
    assert.equal(report.status, "no_data");
    assert.ok(report.blockingGaps.some((gap) => gap.includes("No preflight")));
  });
  it("requires decision-order joins, settlement, and complete telemetry before readiness", () => {
    const settledOrder = makeRecord({ ticker: "KXBTC15M-h002", side: "yes", win: true, netPnlDollars: .2, outcomeReconciledAt: 1 });
    const good = getH002EvidenceReadinessReport([settledOrder], [decision()], "7d", { localDecisionRecords: 0, durableDecisionRecords: 1 });
    assert.equal(good.counts.matchedSubmittedOrders, 1);
    assert.equal(good.counts.reconciledFilledOrders, 1);
    assert.equal(good.status, "observation");
    const gaps = getH002EvidenceReadinessReport([], [decision({ ticker: "missing", marketResult: null, quotedBboAsk: null, executableBestAskCents: null, verifiedLimitCents: null, l2FetchLatencyMs: Number.NaN })], "7d");
    assert.equal(gaps.counts.unmatchedSubmittedDecisions, 1);
    assert.equal(gaps.telemetry.missingQuotedBbo, 1);
    assert.equal(gaps.telemetry.missingExecutableAsk, 1);
    assert.equal(gaps.telemetry.missingVerifiedLimit, 1);
    assert.equal(gaps.telemetry.missingL2Latency, 1);
    assert.ok(gaps.blockingGaps.some((gap) => gap.includes("cannot be joined")));
    assert.ok(gaps.blockingGaps.some((gap) => gap.includes("lack a market settlement")));
  });
  it("only becomes evidence_ready with 100 complete settled observations", () => {
    const decisions = Array.from({ length: 100 }, (_, i) => decision({ ticker: `KXBTC15M-${i}`, timestampMs: i }));
    const orders = decisions.map((row, i) => makeRecord({ id: `h002-${i}`, ticker: row.ticker, side: "yes", win: true, netPnlDollars: .2, outcomeReconciledAt: 1 }));
    const report = getH002EvidenceReadinessReport(orders, decisions, "all-time", { localDecisionRecords: 0, durableDecisionRecords: 100 });
    assert.equal(report.status, "evidence_ready");
    assert.equal(report.readonly, true);
    assert.ok(report.caveat.includes("synthetic P&L"));
  });
});

describe("getConditionRecommendationsReport", () => {
  it("only makes a negative realized-P&L exclusion actionable with comparable evidence and keeps skips non-actionable", () => {
    const losing = Array.from({ length: 100 }, (_, i) => makeRecord({
      id: `loss-${i}`, fillPriceCents: 82, triggerPriceCents: 82, win: false,
      netPnlDollars: -0.2, outcomeReconciledAt: 1,
    }));
    const retained = Array.from({ length: 100 }, (_, i) => makeRecord({
      id: `keep-${i}`, fillPriceCents: 77, triggerPriceCents: 77, win: true,
      netPnlDollars: 0.15, outcomeReconciledAt: 1,
    }));
    const skipped: PreflightDecision = {
      ticker: "KXBTC15M-skip", series: "KXBTC15M", side: "yes", timestampMs: 3,
      secondsLeft: 90, quotedBboAsk: 80, bboAgeMs: 1, bboDerivedLimitCents: 80,
      executableBestAskCents: 84, bboToL2GapCents: 4, verifiedLimitCents: null,
      depthAtLimitDollars: 0, depthAtLimitContracts: 0, intendedContracts: 1,
      intendedNotionalCents: 80, adjustedContracts: 0, fillFractionEstimate: 0,
      nearLimitLevels: [], l2FetchLatencyMs: 1, decision: "skip_stale_bbo_gap", marketResult: "yes",
    };
    const report = getConditionRecommendationsReport([...losing, ...retained], [skipped], "all-time");
    const exclusion = report.recommendations.find((r) => r.proposedCondition.includes("80–84¢"));
    assert.ok(exclusion);
    assert.equal(exclusion!.status, "actionable");
    assert.ok(Math.abs((exclusion!.estimatedNetPnlImpactDollars ?? 0) - 20) < 0.000_001);
    assert.equal(exclusion!.impactBasis, "realized_fill_pnl");
    const gate = report.recommendations.find((r) => r.kind === "preflight_gate_review");
    assert.ok(gate);
    assert.notEqual(gate!.status, "actionable");
    assert.equal(gate!.estimatedNetPnlImpactDollars, null);
    assert.equal(report.readonly, true);
  });
  it("filters recommendations by asset and keeps pending fills out of P&L estimates", () => {
    const btc = makeRecord({ series: "KXBTC15M", fillPriceCents: 82, netPnlDollars: -1, win: false, outcomeReconciledAt: 1 });
    const ethPending = makeRecord({ series: "KXETH15M", fillPriceCents: 82, netPnlDollars: -10, win: null, outcomeReconciledAt: null });
    const report = getConditionRecommendationsReport([btc, ethPending], [], "7d", "BTC");
    assert.equal(report.asset, "BTC");
    assert.equal(report.dataSources.orderRecords, 1);
    assert.ok(report.recommendations.every((r) => r.pendingSamples === 0));
  });
  it("does not count settled outcomes with missing net P&L as realized evidence", () => {
    const missingPnl = makeRecord({
      series: "KXBTC15M", fillPriceCents: 82, netPnlDollars: null, win: false, outcomeReconciledAt: 1,
    });
    const report = getConditionRecommendationsReport([missingPnl], [], "all-time", "BTC");
    assert.equal(report.recommendations.length, 0);
    assert.equal(report.dataSources.orderRecords, 1);
  });
});

// ── 7. computeFinalReconciliationStatus — ledger-gate regression tests ────────
//
// These tests exercise the pure gating function without a database.  They
// correspond directly to the three conditions the route must enforce:
//   (b) ledger unavailable → reconstructed
//   (c) zero ledger rows with non-zero parent verified fills → reconstructed
//   (d) dollar totals diverge > 1¢ → reconstructed

describe("computeFinalReconciliationStatus — final-status gate", () => {
  const fullLedger = (net: number, fills: number): LedgerCoverage => ({
    confirmedNetPnlDollars: net,
    settledFillCount: fills,
  });

  // ── vacuous case ──────────────────────────────────────────────────────────

  it("returns exchange_reconciled vacuously when there are no fills at all", () => {
    const s = computeFinalReconciliationStatus("exchange_reconciled", null, 0, null);
    assert.equal(s, "exchange_reconciled",
      "no fills → nothing to verify → vacuously reconciled");
  });

  it("returns reconstructed when parent status is already reconstructed (no ledger check needed)", () => {
    const s = computeFinalReconciliationStatus("reconstructed", -0.50, 1, fullLedger(-0.50, 1));
    assert.equal(s, "reconstructed");
  });

  // ── ledger unavailability (condition b) ───────────────────────────────────

  it("returns reconstructed when the ledger result is null (unavailable)", () => {
    const s = computeFinalReconciliationStatus("exchange_reconciled", 0.20, 1, null);
    assert.equal(s, "reconstructed", "null ledger must fail closed");
  });

  it("returns reconstructed when confirmedNetPnlDollars is null (pending verification rows)", () => {
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled", 0.20, 1,
      { confirmedNetPnlDollars: null, settledFillCount: 1 },
    );
    assert.equal(s, "reconstructed",
      "null confirmed net (pending verification) must fail closed");
  });

  // ── zero-ledger-rows edge case (condition c) — key regression ─────────────
  //
  // `getVerifiedPnlBySeries` represents an empty SQL result as
  // { realizedNetPnlDollars: 0, settledFillCount: 0 }.
  // When the parent report has exchange-verified fills but the ledger has 0
  // confirmed rows, the dollar-equality gate alone cannot detect the problem
  // (0 == 0 passes).  The count gate must reject it.

  it("returns reconstructed for a $0 parent with 0 ledger fills — empty SQL result must not certify (REGRESSION)", () => {
    // Parent has one exchange-verified fill with net $0 (e.g. costs cancel out).
    // Ledger SQL returned no rows → realizedNetPnlDollars: 0, settledFillCount: 0.
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled",
      0,          // parent net = $0
      1,          // 1 parent exchange-verified fill
      fullLedger(0, 0),   // empty SQL result — 0 confirmed rows
    );
    assert.equal(s, "reconstructed",
      "zero ledger rows must not certify a non-empty parent report even when both totals are $0");
  });

  it("returns reconstructed when ledger row count is less than parent verified count (possible omitted fills)", () => {
    // Parent has 3 verified fills; ledger only confirmed 2.
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled", 0.60, 3, fullLedger(0.60, 2),
    );
    assert.equal(s, "reconstructed",
      "ledger coverage gap must prevent certification");
  });

  // ── offsetting / cancelling fills (condition d) ───────────────────────────
  //
  // Two fills that net to $0 locally but differ from the authoritative
  // exchange total (e.g. one fill's fee differs).  Dollar-equality alone
  // on the $0 total would pass; the count gate catches coverage, and the
  // 1¢ tolerance catches fee divergence.

  it("returns reconstructed when ledger and parent totals diverge by more than 1¢", () => {
    // Parent records show net $0.20; ledger confirms $0.17 (fee rounding difference)
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled", 0.20, 2, fullLedger(0.17, 2),
    );
    assert.equal(s, "reconstructed",
      "3¢ divergence must not be certified");
  });

  it("returns reconstructed when offsetting fills produce matching count but divergent dollar total", () => {
    // Two fills: +$0.20 and -$0.20 locally (net $0).
    // Ledger says net $0.01 (fees differ on one fill).
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled", 0, 2, fullLedger(0.01, 2),
    );
    assert.equal(s, "reconstructed",
      "1¢ divergence on a $0 total must not certify");
  });

  // ── agreement path ────────────────────────────────────────────────────────

  it("returns exchange_reconciled when parent and ledger fully agree", () => {
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled", 0.19, 1, fullLedger(0.19, 1),
    );
    assert.equal(s, "exchange_reconciled");
  });

  it("accepts < 1¢ divergence as within tolerance", () => {
    // 0.005 rounding difference — within the 1¢ threshold
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled", 0.20, 2, fullLedger(0.195, 2),
    );
    assert.equal(s, "exchange_reconciled",
      "sub-cent rounding difference should not prevent certification");
  });

  it("returns exchange_reconciled for a genuinely zero-balance all-confirmed report (ledger has rows)", () => {
    // Two fills that cancel; ledger also returns $0 but with 2 confirmed rows.
    const s = computeFinalReconciliationStatus(
      "exchange_reconciled", 0, 2, fullLedger(0, 2),
    );
    assert.equal(s, "exchange_reconciled",
      "confirmed $0 balance with matching ledger row count is valid");
  });
});

// ── 8. getReconciliationView — exchange reconciliation validation ──────────────
//
// These tests are the acceptance criteria for task 441.  They verify that:
//   (a) reconciliationStatus correctly distinguishes final from preliminary totals
//   (b) getReconciliationView categorises every fill by its reconciliation state
//   (c) the report total does not silently include unverified fills without surfacing them
//   (d) divergence between the exchange-verified subtotal and the reported total
//       is always detectable from the view fields

describe("getPnlReport — reconciliationStatus label", () => {
  it("is 'exchange_reconciled' when there are no fills at all", () => {
    const r = getPnlReport([], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "exchange_reconciled",
      "vacuously reconciled when no fills exist");
  });

  it("is 'exchange_reconciled' when every fill has exact exchange economics and is settled", () => {
    // fill_price_source: 'actual' is the positive evidence required from the fills API
    const rec = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      fill_price_source: "actual",
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "exchange_reconciled");
  });

  it("is 'reconstructed' when any fill has null fill_price_source (in-flight reconciliation)", () => {
    // null fill_price_source means the fills endpoint has not yet confirmed the price
    const rec = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      fill_price_source: null,
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "reconstructed",
      "in-flight fill (null fill_price_source) must make the report reconstructed");
  });

  it("is 'reconstructed' when any fill has reconcile_failed=true", () => {
    const rec = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      reconcile_failed: true,
    });
    const r = getPnlReport([rec], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "reconstructed",
      "reconcile_failed fill must make the report reconstructed");
  });

  it("is 'reconstructed' when reconcile_failed=true even if fill_price_source='actual' (REGRESSION)", () => {
    // reconcile_failed overrides a fill that also carries fill_price_source='actual'.
    // The failure marker wins — the 'actual' tag alone cannot be trusted as a
    // definitive confirmation when a failure was also recorded.
    const contradictory = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      reconcile_failed: true,
      fill_price_source: "actual",
    });
    const r = getPnlReport([contradictory], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "reconstructed",
      "reconcile_failed=true must override fill_price_source='actual'");
  });

  it("is 'reconstructed' when any fill has fill_price_source='limit_fallback'", () => {
    const estimated = makeRecord({
      win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19,
      fill_price_source: "limit_fallback",
    });
    const r = getPnlReport([estimated], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "reconstructed",
      "limit_fallback fill must make the report reconstructed");
  });

  it("is 'reconstructed' when any fill is pending settlement (outcomeReconciledAt=null)", () => {
    const settled = makeRecord({ win: true, grossPnlDollars: 0.20, netPnlDollars: 0.19 });
    const pending  = makeRecord({ win: null, outcomeReconciledAt: null, grossPnlDollars: null, netPnlDollars: null });
    const r = getPnlReport([settled, pending], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "reconstructed",
      "pending settlement must make the whole report reconstructed");
  });

  it("is 'exchange_reconciled' when a mix of settled verified fills is present and none are estimated", () => {
    const btc = makeRecord({ series: "KXBTC15M", win: true,  grossPnlDollars:  0.20, netPnlDollars:  0.19, fill_price_source: "actual" });
    const eth = makeRecord({ series: "KXETH15M", win: false, grossPnlDollars: -0.80, netPnlDollars: -0.81, fill_price_source: "actual" });
    const r = getPnlReport([btc, eth], "test", "2026-01-01", "2026-01-01");
    assert.equal(r.reconciliationStatus, "exchange_reconciled");
  });
});

describe("getReconciliationView — status and category counts", () => {
  it("returns exchange_reconciled with 0 estimated / 0 pending when all fills are verified", () => {
    // fill_price_source: 'actual' is the required positive evidence from the fills API
    const a = makeRecord({ win: true,  netPnlDollars:  0.19, fill_price_source: "actual" });
    const b = makeRecord({ win: false, netPnlDollars: -0.80, fill_price_source: "actual" });
    const v = getReconciliationView([a, b], "test", "2026-01-01", "2026-01-01");
    assert.equal(v.status, "exchange_reconciled");
    assert.equal(v.totalFills,             2);
    assert.equal(v.exchangeVerified,       2);
    assert.equal(v.estimatedPrice,         0);
    assert.equal(v.pendingReconciliation,  0);
    assert.equal(v.pendingSettlement,      0);
  });

  it("classifies reconcile_failed=true+fill_price_source=actual as estimated_price, not exchange_verified (REGRESSION)", () => {
    // The failure marker overrides the 'actual' source tag — both getPnlReport and
    // getReconciliationView must agree: this fill is NOT exchange-confirmed.
    const contradictory = makeRecord({
      win: true, netPnlDollars: 0.20,
      fill_price_source: "actual",
      reconcile_failed: true,
    });
    const v = getReconciliationView([contradictory], "test", "2026-01-01", "2026-01-01");
    assert.equal(v.status, "reconstructed",
      "reconcile_failed overrides fill_price_source='actual' in view status");
    assert.equal(v.exchangeVerified,  0,
      "contradictory fill must NOT count as exchange_verified");
    assert.equal(v.estimatedPrice,    1,
      "reconcile_failed=true must classify as estimated_price regardless of source tag");
    // exchangeVerifiedPnl must be null for this fill
    assert.equal(v.fills[0]!.category, "estimated_price");
    assert.equal(v.fills[0]!.exchangeVerifiedPnl, null,
      "contradictory fill must not carry exchangeVerifiedPnl");
  });

  it("classifies a settled fill with null fill_price_source as pending_reconciliation, not exchange_verified", () => {
    // null fill_price_source = reconciliation in-flight or never attempted;
    // must not be labelled confirmed even though the market has settled.
    const inFlight = makeRecord({ win: true, netPnlDollars: 0.19, fill_price_source: null });
    const v = getReconciliationView([inFlight], "test", "2026-01-01", "2026-01-01");
    assert.equal(v.status, "reconstructed",
      "in-flight fill must make the report reconstructed");
    assert.equal(v.exchangeVerified,      0, "not exchange-verified without fill_price_source=actual");
    assert.equal(v.pendingReconciliation, 1, "counted as pending_reconciliation");
    assert.equal(v.estimatedPrice,        0);
    assert.equal(v.pendingSettlement,     0);
  });

  it("returns reconstructed and separates estimated_price fills", () => {
    const verified  = makeRecord({ win: true,  netPnlDollars:  0.19, fill_price_source: "actual" });
    const estimated = makeRecord({ win: false, netPnlDollars: -0.50, reconcile_failed: true });
    const v = getReconciliationView([verified, estimated], "test", "2026-01-01", "2026-01-01");
    assert.equal(v.status, "reconstructed");
    assert.equal(v.exchangeVerified,      1);
    assert.equal(v.estimatedPrice,        1);
    assert.equal(v.pendingReconciliation, 0);
    assert.equal(v.pendingSettlement,     0);
  });

  it("counts limit_fallback fills in estimatedPrice, not exchangeVerified", () => {
    const fallback = makeRecord({ win: true, netPnlDollars: 0.20, fill_price_source: "limit_fallback" });
    const v = getReconciliationView([fallback], "test", "2026-01-01", "2026-01-01");
    assert.equal(v.estimatedPrice,        1, "limit_fallback is an estimated fill");
    assert.equal(v.exchangeVerified,      0);
    assert.equal(v.pendingReconciliation, 0);
  });

  it("returns reconstructed and separates pending_settlement fills", () => {
    const settled = makeRecord({ win: true, netPnlDollars: 0.19, fill_price_source: "actual" });
    const pending  = makeRecord({ win: null, outcomeReconciledAt: null, netPnlDollars: null });
    const v = getReconciliationView([settled, pending], "test", "2026-01-01", "2026-01-01");
    assert.equal(v.status, "reconstructed");
    assert.equal(v.exchangeVerified,      1);
    assert.equal(v.pendingReconciliation, 0);
    assert.equal(v.pendingSettlement,     1);
  });

  it("returns exchange_reconciled and both net totals are null when there are no fills", () => {
    const v = getReconciliationView([], "test", "2026-01-01", "2026-01-01");
    assert.equal(v.status, "exchange_reconciled");
    assert.equal(v.totalFills, 0);
    assert.equal(v.verifiedNetPnlDollars,  null);
    assert.equal(v.estimatedNetPnlDollars, null);
    assert.equal(v.reportedNetPnlDollars,  null);
  });
});

describe("getReconciliationView — P&L totals and divergence detection", () => {
  it("verifiedNetPnlDollars equals reportedNetPnlDollars when all fills are exchange_verified", () => {
    const a = makeRecord({ win: true,  netPnlDollars:  0.19, fill_price_source: "actual" });
    const b = makeRecord({ win: false, netPnlDollars: -0.80, fill_price_source: "actual" });
    const v = getReconciliationView([a, b], "test", "2026-01-01", "2026-01-01");
    const expected = 0.19 + (-0.80);
    assert.ok(Math.abs(v.verifiedNetPnlDollars!  - expected) < 1e-9,
      "verifiedNet should sum the two fills");
    assert.ok(Math.abs(v.reportedNetPnlDollars!  - expected) < 1e-9,
      "reportedNet matches verifiedNet when there are no estimated fills");
  });

  it("divergence between verifiedNet and reportedNet equals the estimated-fill contribution", () => {
    // Exact fill: $0.20 win (positive exchange confirmation)
    const verified  = makeRecord({ win: true,  netPnlDollars:  0.20, fill_price_source: "actual" });
    // Estimated fill: $-0.50 loss (price is from limit, not exchange)
    const estimated = makeRecord({ win: false, netPnlDollars: -0.50, fill_price_source: "limit_fallback" });
    const v = getReconciliationView([verified, estimated], "test", "2026-01-01", "2026-01-01");

    // Exchange-verified total covers only the first fill
    assert.ok(Math.abs(v.verifiedNetPnlDollars!  -  0.20) < 1e-9, "verified total = 0.20");
    // Reported total covers both fills
    assert.ok(Math.abs(v.reportedNetPnlDollars!  - (0.20 - 0.50)) < 1e-9, "reported total = -0.30");
    // The divergence IS the estimated fill's P&L contribution
    const divergence = v.reportedNetPnlDollars! - v.verifiedNetPnlDollars!;
    assert.ok(Math.abs(divergence - (-0.50)) < 1e-9,
      "divergence between reported and verified equals estimated contribution");
    // estimatedNetPnlDollars surfaces the unconfirmed component explicitly
    assert.ok(Math.abs(v.estimatedNetPnlDollars! - (-0.50)) < 1e-9,
      "estimatedNetPnlDollars isolates the risky portion");
  });

  it("divergence also surfaces when fill_price_source is null (pending_reconciliation)", () => {
    // Confirmed fill
    const confirmed  = makeRecord({ win: true,  netPnlDollars:  0.20, fill_price_source: "actual" });
    // In-flight fill: settled but price not yet confirmed from exchange
    const inFlight   = makeRecord({ win: false, netPnlDollars: -0.40, fill_price_source: null });
    const v = getReconciliationView([confirmed, inFlight], "test", "2026-01-01", "2026-01-01");

    assert.equal(v.status, "reconstructed");
    assert.equal(v.pendingReconciliation, 1, "in-flight fill counted as pending_reconciliation");
    assert.ok(Math.abs(v.verifiedNetPnlDollars!  -  0.20)          < 1e-9, "verified = confirmed fill only");
    assert.ok(Math.abs(v.reportedNetPnlDollars!  - (0.20 - 0.40)) < 1e-9, "reported includes in-flight fill");
    // estimatedNetPnlDollars covers both estimated_price and pending_reconciliation
    assert.ok(Math.abs(v.estimatedNetPnlDollars! - (-0.40))         < 1e-9, "unconfirmed component surfaced");
  });

  it("pending_settlement fills are excluded from both totals", () => {
    const settled = makeRecord({ win: true, netPnlDollars: 0.30, fill_price_source: "actual" });
    const pending  = makeRecord({ win: null, outcomeReconciledAt: null, netPnlDollars: null });
    const v = getReconciliationView([settled, pending], "test", "2026-01-01", "2026-01-01");
    // Reported total must not include the pending fill
    assert.ok(Math.abs(v.reportedNetPnlDollars! - 0.30) < 1e-9,
      "pending fill must not contribute to the reported total");
    assert.equal(v.estimatedNetPnlDollars, null,
      "no estimated or in-flight fills → estimatedNetPnlDollars is null");
  });

  it("exchangeVerifiedPnl is null for non-verified fill items", () => {
    // verified: positive exchange confirmation
    const verified  = makeRecord({ win: true,  netPnlDollars:  0.19, fill_price_source: "actual" });
    // estimated: reconciliation permanently failed
    const estimated = makeRecord({ win: false, netPnlDollars: -0.50, reconcile_failed: true });
    // pending: not yet settled
    const pending   = makeRecord({ win: null,  outcomeReconciledAt: null, netPnlDollars: null });
    const v = getReconciliationView([verified, estimated, pending], "test", "2026-01-01", "2026-01-01");

    const vItem = v.fills.find((f) => f.id === verified.id);
    const eItem = v.fills.find((f) => f.id === estimated.id);
    const pItem = v.fills.find((f) => f.id === pending.id);

    assert.ok(vItem && eItem && pItem, "all three fills present in view");
    assert.equal(vItem!.category, "exchange_verified");
    assert.equal(eItem!.category, "estimated_price");
    assert.equal(pItem!.category, "pending_settlement");

    // Only the exchange_verified fill exposes exchangeVerifiedPnl
    assert.ok(Math.abs(vItem!.exchangeVerifiedPnl! - 0.19) < 1e-9);
    assert.equal(eItem!.exchangeVerifiedPnl, null,
      "estimated fill must NOT carry exchangeVerifiedPnl");
    assert.equal(pItem!.exchangeVerifiedPnl, null,
      "pending fill must NOT carry exchangeVerifiedPnl");

    // localPnl is present for settled fills, absent for pending
    assert.ok(Math.abs(eItem!.localPnl! - (-0.50)) < 1e-9);
    assert.equal(pItem!.localPnl, null, "pending fill has no localPnl");
  });

  it("pending_reconciliation fill does not carry exchangeVerifiedPnl", () => {
    // A fill with settled outcome but null fill_price_source is pending_reconciliation
    const inFlight = makeRecord({ win: true, netPnlDollars: 0.15, fill_price_source: null });
    const v = getReconciliationView([inFlight], "test", "2026-01-01", "2026-01-01");
    const item = v.fills[0];
    assert.equal(item!.category, "pending_reconciliation");
    assert.equal(item!.exchangeVerifiedPnl, null,
      "in-flight fill must not be counted as exchange-confirmed P&L");
    assert.ok(Math.abs(item!.localPnl! - 0.15) < 1e-9,
      "localPnl is still present (the value is known, just not confirmed)");
  });

  it("reportedNetPnlDollars matches the sum getPnlReport would compute over the same reconciled fills", () => {
    // Build three records: two verified, one estimated.
    const r1 = makeRecord({ win: true,  netPnlDollars:  0.15, grossPnlDollars:  0.20 });
    const r2 = makeRecord({ win: false, netPnlDollars: -0.80, grossPnlDollars: -0.80 });
    const r3 = makeRecord({ win: true,  netPnlDollars:  0.10, grossPnlDollars:  0.20,
                             reconcile_failed: true });  // estimated

    const pnlReport = getPnlReport([r1, r2, r3], "test", "2026-01-01", "2026-01-01");
    const reconView = getReconciliationView([r1, r2, r3], "test", "2026-01-01", "2026-01-01");

    // Both reports see the same settled fills; the two net totals must agree.
    assert.ok(
      Math.abs((pnlReport.summary.netPnlDollars ?? 0) - (reconView.reportedNetPnlDollars ?? 0)) < 1e-9,
      `getPnlReport net (${pnlReport.summary.netPnlDollars}) must equal ` +
      `getReconciliationView reported net (${reconView.reportedNetPnlDollars})`,
    );
    // Both must flag the report as reconstructed (estimated fill present).
    assert.equal(pnlReport.reconciliationStatus, "reconstructed");
    assert.equal(reconView.status,               "reconstructed");
  });
});
