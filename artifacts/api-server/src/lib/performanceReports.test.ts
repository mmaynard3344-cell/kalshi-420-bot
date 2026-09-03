/**
 * Performance Analysis Framework — Test Suite (Step 3)
 *
 * Covers: fill performance, retry analysis, guard analysis, time grouping,
 * price band grouping, CSV validity, replay comparison read-only safety.
 * All tests are pure in-memory; no disk I/O.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  _resetStateForTesting,
  _setDayForTesting,
  recordOrderAttempt,
  recordFill,
  recordZeroFill,
  recordGuardOutcome,
  getOrderAttempts,
} from "./analytics.js";

import {
  getFillPerformanceReport,
  getRetryAnalysisReport,
  getGuardAnalysisReport,
  getTimeAnalysisReport,
  getPriceAnalysisReport,
  getReplayComparisonReport,
  getEntryGapReport,
  getPnlReport,
  easternHour,
  easternDayOfWeek,
  DAY_NAMES,
  TIME_OF_DAY_BUCKETS,
} from "./performanceReports.js";

import { recordOutcomeResult } from "./analytics.js";

import {
  recordsToCsv,
  ordersToCSV,
  windowsToCSV,
  dailySummaryToCSV,
} from "./csvExport.js";

// ── Shared test helpers ───────────────────────────────────────────────────────

const BTC_TICKER = "KXBTC15M-TEST-T";
const ETH_TICKER = "KXETH15M-TEST-T";
const CLOSE = new Date(Date.now() + 60_000).toISOString();

let _seq = 0;
function cid() {
  return `cid-${++_seq}`;
}

function makeAttempt(params: {
  ticker: string;
  series: string;
  side?: "yes" | "no";
  triggerPriceCents?: number;
  limitPriceCents?: number;
  requestedContracts?: number;
  timestampMs?: number;
}): string {
  return recordOrderAttempt({
    ticker: params.ticker,
    series: params.series,
    windowCloseTime: CLOSE,
    side: params.side ?? "yes",
    source: "websocket",
    triggerPriceCents: params.triggerPriceCents ?? 82,
    limitPriceCents: params.limitPriceCents ?? 83,
    requestedContracts: params.requestedContracts ?? 10,
    clientOrderId: cid(),
    timestampMs: params.timestampMs,
  });
}

function makeFill(
  id: string,
  contracts: number,
  priceCents: number,
  roundTripMs = 150,
  orderId: string | null = null,
) {
  recordFill(id, {
    orderId,
    fillCount: contracts,
    requestedCount: contracts,
    contractsFilled: contracts,
    fillPriceCents: priceCents,
    notionalDollars: (contracts * priceCents) / 100,
    feeDollars: contracts * 0.001,
    pricesKnown: true,
    roundTripMs,
  });
}

function makeZeroFill(id: string) {
  recordZeroFill(id, {
    requestedContracts: 10,
    limitPriceCents: 83,
    triggerPriceCents: 82,
    yesBid: 83,
    noBid: 17,
    yesAsk: null,
    noAsk: null,
    yesDerivedAsk: 83,
    noDerivedAsk: 17,
    snapshotAgeMs: 50,
    snapshotSource: "websocket",
    roundTripMs: 120,
  });
}

beforeEach(() => {
  _resetStateForTesting();
});

// ── 1. Fill Performance ───────────────────────────────────────────────────────

describe("getFillPerformanceReport", () => {
  it("aggregates BTC and ETH fill stats independently", () => {
    _setDayForTesting("2026-07-29");
    // BTC: 2 attempts, 1 fill → 50% attempt fill rate
    makeFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }), 5, 83);
    makeZeroFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }));
    // ETH: 1 attempt, 1 fill → 100%
    makeFill(makeAttempt({ ticker: ETH_TICKER, series: "KXETH15M" }), 8, 80);

    const r = getFillPerformanceReport();

    assert.equal(r.btc.series, "KXBTC15M");
    assert.ok(r.btc.fillRateByAttempt !== null);
    assert.ok(
      Math.abs(r.btc.fillRateByAttempt! - 0.5) < 0.001,
      `BTC fillRateByAttempt expected ~0.5, got ${r.btc.fillRateByAttempt}`,
    );

    assert.equal(r.eth.series, "KXETH15M");
    assert.ok(r.eth.fillRateByAttempt !== null);
    assert.ok(
      Math.abs(r.eth.fillRateByAttempt! - 1.0) < 0.001,
      `ETH fillRateByAttempt expected ~1.0, got ${r.eth.fillRateByAttempt}`,
    );

    // ETH avg fill price = 80 cents
    assert.ok(r.eth.avgFillPriceCents !== null);
    assert.ok(Math.abs(r.eth.avgFillPriceCents! - 80) < 0.01);
  });

  it("price improvement = requested price - fill price", () => {
    makeFill(
      makeAttempt({
        ticker: BTC_TICKER,
        series: "KXBTC15M",
        limitPriceCents: 85,
      }),
      10,
      82, // filled 3 cents below limit
      200,
    );
    const r = getFillPerformanceReport();
    assert.ok(r.btc.avgPriceImprovementCents !== null);
    assert.ok(
      Math.abs(r.btc.avgPriceImprovementCents! - 3) < 0.01,
      `Expected price improvement of 3, got ${r.btc.avgPriceImprovementCents}`,
    );
  });

  it("returns null fill rate when no orders submitted", () => {
    const r = getFillPerformanceReport();
    assert.equal(r.btc.fillRateByAttempt, null);
    assert.equal(r.eth.fillRateByAttempt, null);
  });
});

// ── 2. Retry Analysis ─────────────────────────────────────────────────────────

describe("getRetryAnalysisReport", () => {
  it("counts fills at the correct attempt number", () => {
    // attempt-1 → zero-fill; attempt-2 → fill
    makeZeroFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }));
    makeFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }), 10, 83);

    const r = getRetryAnalysisReport();
    const at1 = r.fillsByAttempt.find((e) => e.attemptNumber === 1);
    const at2 = r.fillsByAttempt.find((e) => e.attemptNumber === 2);
    assert.ok(at1, "attempt-1 entry missing");
    assert.ok(at2, "attempt-2 entry missing");
    assert.equal(at1!.fills, 0, "attempt-1 should have 0 fills");
    assert.equal(at2!.fills, 1, "attempt-2 should have 1 fill");
    assert.ok(
      Math.abs(at2!.fillPct - 100) < 0.01,
      `attempt-2 fillPct expected 100, got ${at2!.fillPct}`,
    );
  });

  it("pctWindowsNeverFilled is 100 when no windows ever filled", () => {
    makeZeroFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }));
    const r = getRetryAnalysisReport();
    assert.ok(r.pctWindowsNeverFilled !== null);
    assert.ok(
      Math.abs(r.pctWindowsNeverFilled! - 100) < 0.01,
      `Expected 100%, got ${r.pctWindowsNeverFilled}`,
    );
  });

  it("pctWindowsNeverFilled is 0 when every traded window filled", () => {
    makeFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }), 5, 83);
    const r = getRetryAnalysisReport();
    assert.ok(r.pctWindowsNeverFilled !== null);
    assert.ok(
      Math.abs(r.pctWindowsNeverFilled! - 0) < 0.01,
      `Expected 0%, got ${r.pctWindowsNeverFilled}`,
    );
  });
});

// ── 3. Guard Analysis ─────────────────────────────────────────────────────────

describe("getGuardAnalysisReport", () => {
  it("BTC guard percentages sum to ~100", () => {
    _setDayForTesting("2026-07-29");
    recordGuardOutcome("KXBTC15M", "cooldown");
    recordGuardOutcome("KXBTC15M", "cooldown");
    recordGuardOutcome("KXBTC15M", "outside_zone");
    recordGuardOutcome("KXBTC15M", "daily_cap");

    const r = getGuardAnalysisReport();
    const total = r.btc.reduce((s, e) => s + e.pct, 0);
    assert.ok(
      Math.abs(total - 100) < 0.01,
      `Guard pcts should sum to 100, got ${total}`,
    );
    // cooldown is highest (2/4 = 50%)
    assert.equal(r.btc[0]!.guard, "cooldown");
    assert.equal(r.btc[0]!.count, 2);
    assert.ok(Math.abs(r.btc[0]!.pct - 50) < 0.01);
  });

  it("returns empty arrays when no guard outcomes recorded", () => {
    const r = getGuardAnalysisReport();
    assert.equal(r.btc.length, 0);
    assert.equal(r.eth.length, 0);
    assert.equal(r.combined.length, 0);
  });
});

// ── 4. Time Analysis ──────────────────────────────────────────────────────────

describe("getTimeAnalysisReport", () => {
  it("places an order in the correct Eastern hour bucket", () => {
    // 2026-07-29 18:00 UTC = 14:00 EDT (UTC-4, July is summer/EDT)
    const tsMs = Date.UTC(2026, 6, 29, 18, 0, 0);
    const expectedHour = easternHour(tsMs);
    assert.equal(expectedHour, 14, "easternHour(18:00 UTC July) should be 14");

    makeFill(
      makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M", timestampMs: tsMs }),
      5,
      83,
    );

    const r = getTimeAnalysisReport();
    const label = String(expectedHour).padStart(2, "0") + ":00";
    const bucket = r.byHour.find((b) => b.label === label);
    assert.ok(bucket, `Bucket "${label}" missing`);
    assert.equal(bucket!.submissions, 1);
    assert.equal(bucket!.fills, 1);
  });

  it("places an order in the correct Eastern day-of-week bucket", () => {
    // 2026-07-29 12:00 UTC — July 29 2026 is a Wednesday
    const tsMs = Date.UTC(2026, 6, 29, 12, 0, 0);
    const dow = easternDayOfWeek(tsMs);
    const label = DAY_NAMES[dow]!;
    assert.equal(label, "Wednesday", `Expected Wednesday, got ${label}`);

    makeFill(
      makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M", timestampMs: tsMs }),
      5,
      83,
    );

    const r = getTimeAnalysisReport();
    const bucket = r.byDayOfWeek.find((b) => b.label === label);
    assert.ok(bucket, `Bucket "${label}" missing`);
    assert.equal(bucket!.submissions, 1);
    assert.equal(bucket!.fills, 1);
  });

  it("byHour always has exactly 24 buckets", () => {
    const r = getTimeAnalysisReport();
    assert.equal(r.byHour.length, 24);
  });

  it("byDayOfWeek always has exactly 7 buckets", () => {
    const r = getTimeAnalysisReport();
    assert.equal(r.byDayOfWeek.length, 7);
  });
});

// ── 5. Price Band Analysis ────────────────────────────────────────────────────

describe("getPriceAnalysisReport", () => {
  it("places each trigger price in the correct band", () => {
    const cases: Array<[number, string]> = [
      [72, "70-74"],
      [77, "75-79"],
      [83, "80-84"],
      [87, "85-89"],
      [91, "90-95"],
    ];
    for (const [trig] of cases) {
      makeFill(
        makeAttempt({
          ticker: BTC_TICKER,
          series: "KXBTC15M",
          triggerPriceCents: trig,
          limitPriceCents: trig + 1,
        }),
        5,
        trig,
      );
    }

    const r = getPriceAnalysisReport();
    for (const [, band] of cases) {
      const entry = r.bands.find((b) => b.band === band);
      assert.ok(entry, `Band "${band}" missing`);
      assert.equal(entry!.submissions, 1, `Band "${band}" should have 1 submission`);
      assert.equal(entry!.fills, 1, `Band "${band}" should have 1 fill`);
    }
  });

  it("submissionRates sum to 1.0 when all orders fall within bands", () => {
    for (const trig of [72, 77, 83]) {
      makeFill(
        makeAttempt({
          ticker: BTC_TICKER,
          series: "KXBTC15M",
          triggerPriceCents: trig,
          limitPriceCents: trig + 1,
        }),
        5,
        trig,
      );
    }
    const r = getPriceAnalysisReport();
    const total = r.bands.reduce((s, b) => s + (b.submissionRate ?? 0), 0);
    assert.ok(
      Math.abs(total - 1.0) < 0.001,
      `submissionRates should sum to 1.0, got ${total}`,
    );
  });

  it("always returns all 5 bands even with no data", () => {
    const r = getPriceAnalysisReport();
    assert.equal(r.bands.length, 5);
    for (const b of r.bands) {
      assert.equal(b.submissions, 0);
      assert.equal(b.fills, 0);
    }
  });
});

// ── 6. CSV Exports ────────────────────────────────────────────────────────────

describe("CSV exports", () => {
  it("recordsToCsv escapes commas inside values", () => {
    const csv = recordsToCsv(["name", "value"], [["hello, world", "42"]]);
    assert.ok(
      csv.includes('"hello, world"'),
      "comma-containing value should be quoted",
    );
    assert.ok(csv.includes("42"));
  });

  it("recordsToCsv escapes internal double-quotes by doubling", () => {
    const csv = recordsToCsv(["col"], [[`say "hello"`]]);
    assert.ok(
      csv.includes(`"say ""hello"""`),
      `Expected escaped double-quotes, got: ${csv}`,
    );
  });

  it("ordersToCSV: header row + one data row per order", () => {
    makeFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }), 5, 83);
    const csv = ordersToCSV();
    const lines = csv.split("\r\n").filter(Boolean);
    assert.ok(lines.length >= 2, "Need at least header + 1 data row");
    assert.ok(
      lines[0]!.startsWith("id,"),
      `Header should start with 'id', got: ${lines[0]}`,
    );
    assert.ok(lines[0]!.includes("ticker"), "header missing 'ticker'");
    assert.ok(lines[0]!.includes("outcome"), "header missing 'outcome'");
    const orderCount = getOrderAttempts(undefined, 1_000).length;
    assert.equal(lines.length - 1, orderCount, "Row count should match order count");
  });

  it("windowsToCSV: header + one row per window", () => {
    makeFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }), 5, 83);
    const csv = windowsToCSV();
    const lines = csv.split("\r\n").filter(Boolean);
    assert.ok(lines.length >= 2);
    assert.ok(lines[0]!.includes("ticker"));
    assert.ok(lines[0]!.includes("result"));
  });

  it("dailySummaryToCSV: header + 3 series rows (btc, eth, combined)", () => {
    _setDayForTesting("2026-07-29");
    const csv = dailySummaryToCSV();
    const lines = csv.split("\r\n").filter(Boolean);
    assert.equal(lines.length, 4, "Expected header + 3 series rows");
    assert.ok(lines[1]!.includes("KXBTC15M"), "row 1 should be BTC");
    assert.ok(lines[2]!.includes("KXETH15M"), "row 2 should be ETH");
    assert.ok(lines[3]!.includes("combined"), "row 3 should be combined");
  });
});

// ── 7. Replay Comparison — read-only safety ───────────────────────────────────

describe("getReplayComparisonReport", () => {
  it("does not mutate analytics state and returns correct diff", () => {
    _setDayForTesting("2026-07-29");
    makeFill(makeAttempt({ ticker: BTC_TICKER, series: "KXBTC15M" }), 5, 83);
    const countBefore = getOrderAttempts(undefined, 1_000).length;

    const fakeReplay = {
      replayId: "test-replay-id",
      runAt: "2026-07-29T12:00:00.000Z",
      config: {
        alertMin: 72,
        alertMax: 90,
        timeAlertSeconds: 120,
        limitPriceBufferCents: 1,
        betDollarsByTicker: { KXBTC15M: 100, KXETH15M: 100 },
        orderCooldownMs: 3_000,
        dedupWindowMs: 1_200_000,
        maxDailyNotionalCents: 800_000,
        fillAssumption: "full" as const,
        strategyVersion: "1.0.0",
      },
      summary: {
        ticksEvaluated: 50,
        windowsEntered: 5,
        tradeCount: 3,
        zeroFillCount: 2,
        skippedByGuard: 10,
        skippedOutOfZone: 100,
        totalSpentDollars: 240,
      },
      records: [],
    };

    const report = getReplayComparisonReport(fakeReplay);

    // State must be unchanged
    assert.equal(
      getOrderAttempts(undefined, 1_000).length,
      countBefore,
      "order count must not change after comparison",
    );

    // Report shape
    assert.equal(report.replayId, "test-replay-id");
    assert.ok(Array.isArray(report.metrics));
    assert.ok(report.metrics.length > 0);

    // fills: replay=3, production=1 → delta = 1 - 3 = -2 (negative = worse)
    const fillsMetric = report.metrics.find((m) => m.metric === "fills");
    assert.ok(fillsMetric, "fills metric missing");
    assert.equal(fillsMetric!.replay, 3);
    assert.equal(fillsMetric!.production, 1);
    assert.equal(fillsMetric!.delta, -2);
    assert.equal(fillsMetric!.deltaSign, "negative");
  });
});

// ── Entry Gap (Falling Knife) Report ─────────────────────────────────────────

describe("getEntryGapReport", () => {
  type Rec = import("./analytics.js").OrderAttemptRecord;

  let seq = 0;
  function gapRec(p: {
    trigger: number;
    fill: number | null;
    win?: boolean | null;
    reconciled?: boolean;
    netPnl?: number | null;
    outcome?: string;
    timestampMs?: number;
  }): Rec {
    seq += 1;
    return {
      id: `gap-${seq}`,
      timestampMs: p.timestampMs ?? 1_700_000_000_000 + seq * 1000,
      ticker: BTC_TICKER,
      series: "KXBTC15M",
      side: "yes",
      triggerPriceCents: p.trigger,
      fillPriceCents: { value: p.fill, source: "estimated" },
      outcome: p.outcome ?? "full_fill",
      outcomeReconciledAt: (p.reconciled ?? true) ? "2026-08-02T00:00:00Z" : null,
      win: p.win ?? null,
      netPnlDollars: p.netPnl ?? null,
    } as unknown as Rec;
  }

  it("buckets gaps at the 0–2 / 3–6 / 7+ boundaries, including negative gaps", () => {
    const orders = [
      gapRec({ trigger: 76, fill: 77, win: true  }), // gap -1 → 0–2¢
      gapRec({ trigger: 80, fill: 80, win: true  }), // gap 0  → 0–2¢
      gapRec({ trigger: 82, fill: 80, win: true  }), // gap 2  → 0–2¢ (upper bound)
      gapRec({ trigger: 83, fill: 80, win: false }), // gap 3  → 3–6¢ (lower bound)
      gapRec({ trigger: 86, fill: 80, win: true  }), // gap 6  → 3–6¢ (upper bound)
      gapRec({ trigger: 82, fill: 75, win: false }), // gap 7  → 7¢+ (lower bound)
      gapRec({ trigger: 82, fill: 70, win: false }), // gap 12 → 7¢+
    ];
    const r = getEntryGapReport(orders, "all-time", "all", "2026-08-02");

    const [b02, b36, b7] = r.buckets;
    assert.equal(b02!.label, "0–2¢");
    assert.equal(b02!.fills, 3);
    assert.equal(b02!.wins, 3);
    assert.equal(b02!.losses, 0);
    assert.equal(b02!.winRate, 1);

    assert.equal(b36!.fills, 2);
    assert.equal(b36!.wins, 1);
    assert.equal(b36!.losses, 1);
    assert.equal(b36!.winRate, 0.5);

    assert.equal(b7!.fills, 2);
    assert.equal(b7!.wins, 0);
    assert.equal(b7!.winRate, 0);

    // Falling-knife flags on per-trade rows: gap >= 7 only
    const knives = r.trades.filter((t) => t.fallingKnife);
    assert.equal(knives.length, 2);
    assert.ok(knives.every((t) => t.gapCents >= 7));
    assert.equal(r.fallingKnifeGapCents, 7);
  });

  it("excludes fills with a missing fill price and non-filled outcomes", () => {
    const orders = [
      gapRec({ trigger: 82, fill: null }),                          // no fill price
      gapRec({ trigger: 82, fill: 80, outcome: "zero_fill" }),      // not a fill
      gapRec({ trigger: 82, fill: 80, win: true }),                 // counted
    ];
    const r = getEntryGapReport(orders, "all-time", "all", "2026-08-02");
    assert.equal(r.excludedMissingPrice, 1);
    assert.equal(r.trades.length, 1);
    assert.equal(r.buckets.reduce((s, b) => s + b.fills, 0), 1);
  });

  it("unreconciled fills count toward fills but not win/loss; trades sorted newest first", () => {
    const orders = [
      gapRec({ trigger: 82, fill: 80, reconciled: false, timestampMs: 1_000 }),
      gapRec({ trigger: 82, fill: 70, win: false, timestampMs: 2_000 }),
    ];
    const r = getEntryGapReport(orders, "all-time", "all", "2026-08-02");
    const b02 = r.buckets[0]!;
    assert.equal(b02.fills, 1);
    assert.equal(b02.reconciled, 0);
    assert.equal(b02.winRate, null);
    assert.equal(r.pending.fillsPending, 1);
    assert.equal(r.trades[0]!.gapCents, 12);
    assert.equal(r.trades[0]!.win, false);
    assert.equal(r.trades[1]!.win, null);
  });
});

// ── 7. Time-of-day P&L buckets (Task: overnight bucket verification) ──────────

function settle(
  id: string,
  params: { win: boolean; gross: number; net: number; tsMs: number },
) {
  recordOutcomeResult(id, {
    marketResult: params.win ? "yes" : "no",
    win: params.win,
    grossPnlDollars: params.gross,
    netPnlDollars: params.net,
    roi: 0.1,
    windowClosedAtMs: params.tsMs + 60_000,
    holdMs: 60_000,
    reconciledAtMs: params.tsMs + 240_000,
  });
}

function settledFillAt(tsMs: number, opts?: {
  win?: boolean; series?: string; gross?: number; net?: number; orderId?: string | null;
}): string {
  const series = opts?.series ?? "KXBTC15M";
  const ticker = series.startsWith("KXBTC") ? BTC_TICKER : ETH_TICKER;
  const id = makeAttempt({ ticker, series, timestampMs: tsMs });
  makeFill(id, 5, 83, 150, opts?.orderId ?? null);
  settle(id, {
    win: opts?.win ?? true,
    gross: opts?.gross ?? (opts?.win === false ? -4.15 : 0.85),
    net: opts?.net ?? (opts?.win === false ? -4.155 : 0.845),
    tsMs,
  });
  return id;
}

function pnl() {
  return getPnlReport(getOrderAttempts(undefined, 1_000), "all-time", "2026-01-01", "2026-12-31");
}

describe("easternHour DST correctness", () => {
  it("uses EST before the 2nd Sunday of March (2026 DST starts Mar 8)", () => {
    // 2026-03-06 10:30 UTC = 05:30 EST (overnight). A month-based EDT
    // approximation would give 06:30 and misplace this in Morning.
    assert.equal(easternHour(Date.UTC(2026, 2, 6, 10, 30)), 5);
  });

  it("uses EDT after the 2nd Sunday of March", () => {
    // 2026-03-09 10:30 UTC = 06:30 EDT
    assert.equal(easternHour(Date.UTC(2026, 2, 9, 10, 30)), 6);
  });

  it("handles the November fall-back day exactly (2026 DST ends Nov 1)", () => {
    // Before 06:00 UTC on Nov 1 it is still EDT
    assert.equal(easternHour(Date.UTC(2026, 10, 1, 5, 30)), 1);  // 01:30 EDT
    assert.equal(easternHour(Date.UTC(2026, 10, 1, 7, 30)), 2);  // 02:30 EST
  });

  it("maps ET midnight to hour 0 in both winter and summer", () => {
    assert.equal(easternHour(Date.UTC(2026, 0, 15, 5, 0)), 0);  // EST midnight
    assert.equal(easternHour(Date.UTC(2026, 6, 15, 4, 0)), 0);  // EDT midnight
  });
});

describe("getPnlReport byTimeOfDay", () => {
  it("counts one settled result when duplicate retry attempts share an exchange order ID", () => {
    const orderId = "kalshi-order-shared-by-retry";
    settledFillAt(Date.UTC(2026, 6, 30, 6, 30), {
      gross: 0.36, net: 0.36, orderId,
    });
    settledFillAt(Date.UTC(2026, 6, 30, 6, 31), {
      gross: 0.36, net: 0.36, orderId,
    });

    const report = pnl();
    assert.equal(report.summary.fills, 1, "one exchange execution must count once");
    assert.equal(report.summary.wins, 1);
    assert.ok(Math.abs(report.summary.netPnlDollars! - 0.36) < 1e-9);
    assert.equal(report.pending.fillsTotal, 1);
    assert.equal(report.pending.fillsReconciled, 1);
  });

  it("buckets partition all 24 Eastern hours exactly once", () => {
    for (let h = 0; h < 24; h++) {
      const matches = TIME_OF_DAY_BUCKETS.filter((b) => h >= b.minHour && h < b.maxHour);
      assert.equal(matches.length, 1, `hour ${h} must match exactly one bucket`);
    }
  });

  it("a settled 12–6 AM ET fill lands in the Overnight bucket with correct win/loss and P&L", () => {
    // 2026-07-30 06:30 UTC = 02:30 EDT → Overnight
    settledFillAt(Date.UTC(2026, 6, 30, 6, 30), { win: true, gross: 0.85, net: 0.845 });
    settledFillAt(Date.UTC(2026, 6, 30, 7, 15), { win: false, gross: -4.15, net: -4.155 });

    const r = pnl();
    const overnight = r.byTimeOfDay.find((b) => b.minHour === 0)!;
    assert.ok(overnight.label.includes("Overnight"));
    assert.equal(overnight.combined.fills, 2);
    assert.equal(overnight.combined.wins, 1);
    assert.equal(overnight.combined.losses, 1);
    assert.equal(overnight.combined.winRate, 0.5);
    assert.ok(Math.abs(overnight.combined.grossPnlDollars! - (0.85 - 4.15)) < 1e-9);
    assert.ok(Math.abs(overnight.combined.netPnlDollars! - (0.845 - 4.155)) < 1e-9);
    // BTC breakdown carries the same fills; ETH is empty
    assert.equal(overnight.btc.fills, 2);
    assert.equal(overnight.eth.fills, 0);
    // No leakage into other buckets
    for (const b of r.byTimeOfDay.filter((x) => x.minHour !== 0)) {
      assert.equal(b.combined.fills, 0, `${b.label} should be empty`);
    }
  });

  it("handles the midnight boundary: 11:59 PM ET → Evening, 12:00 AM ET → Overnight", () => {
    settledFillAt(Date.UTC(2026, 6, 30, 3, 59));  // 23:59 EDT Jul 29
    settledFillAt(Date.UTC(2026, 6, 30, 4, 0));   // 00:00 EDT Jul 30

    const r = pnl();
    const evening = r.byTimeOfDay.find((b) => b.minHour === 18)!;
    const overnight = r.byTimeOfDay.find((b) => b.minHour === 0)!;
    assert.equal(evening.combined.fills, 1);
    assert.equal(overnight.combined.fills, 1);
  });

  it("handles the 6 AM boundary: 5:59 AM ET → Overnight, 6:00 AM ET → Morning", () => {
    settledFillAt(Date.UTC(2026, 6, 30, 9, 59));  // 05:59 EDT
    settledFillAt(Date.UTC(2026, 6, 30, 10, 0));  // 06:00 EDT
    const r = pnl();
    assert.equal(r.byTimeOfDay.find((b) => b.minHour === 0)!.combined.fills, 1);
    assert.equal(r.byTimeOfDay.find((b) => b.minHour === 6)!.combined.fills, 1);
  });

  it("buckets an early-March overnight fill correctly under EST (pre-DST)", () => {
    // 2026-03-06 10:30 UTC = 05:30 EST → Overnight (EDT approximation would say Morning)
    settledFillAt(Date.UTC(2026, 2, 6, 10, 30));
    const r = pnl();
    assert.equal(r.byTimeOfDay.find((b) => b.minHour === 0)!.combined.fills, 1);
    assert.equal(r.byTimeOfDay.find((b) => b.minHour === 6)!.combined.fills, 0);
  });

  it("an unreconciled overnight fill stays pending and out of the buckets", () => {
    const id = makeAttempt({
      ticker: BTC_TICKER,
      series: "KXBTC15M",
      timestampMs: Date.UTC(2026, 6, 30, 6, 30), // 02:30 EDT
    });
    makeFill(id, 5, 83);
    const r = pnl();
    assert.equal(r.byTimeOfDay.find((b) => b.minHour === 0)!.combined.fills, 0);
    assert.equal(r.pending.fillsPending, 1);
  });
});
