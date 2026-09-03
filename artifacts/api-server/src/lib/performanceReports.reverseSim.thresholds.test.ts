/**
 * performanceReports.reverseSim.thresholds.test.ts
 *
 * Confirms that the 3-threshold comparison (5¢, 7¢, 10¢) inside
 * getEntryGapReport produces correct, internally-consistent counts
 * across periods — including at day-rollover boundaries.
 *
 * Properties verified:
 *   A. 7¢ parity    — reverseSimAll['7'].count === reverseSim.count when
 *                      the main sim also uses 7¢ (the default threshold).
 *   B. Monotonicity — count at 5¢ ≥ 7¢ ≥ 10¢ (wider gap captures more fills).
 *   C. Day-rollover — empty orders array (fresh day, no fills yet) gives
 *                      count=0 across all three thresholds.
 *   D. Period scope — all three thresholds see the same filtered order set;
 *                      there is no leakage of state between threshold calls.
 *
 * Runner: esbuild --bundle | node --test  (same pattern as other perf tests)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getEntryGapReport,
  FALLING_KNIFE_GAP_CENTS,
} from "./performanceReports.js";
import type { OrderAttemptRecord } from "./analytics.js";

// ── Minimal record builder ────────────────────────────────────────────────────

type TV<T> = { value: T };
function tv<T>(val: T): TV<T> { return { value: val }; }

let _idSeq = 0;
function makeRecord(overrides: {
  side?:               "yes" | "no";
  fillPriceCents?:     number;
  triggerPriceCents?:  number;   // if omitted, defaults to fill + gap
  gapCents?:           number;   // convenience: sets trigger = fill + gapCents
  contracts?:          number;
  win?:                boolean | null;
  netPnlDollars?:      number | null;
  outcomeReconciledAt?: number | null;
  outcome?:            "full_fill" | "partial_fill" | "zero_fill";
  timestampMs?:        number;
}): OrderAttemptRecord {
  const id = `order-${++_idSeq}`;
  const {
    side               = "yes",
    fillPriceCents     = 80,
    gapCents           = FALLING_KNIFE_GAP_CENTS, // default = 7¢ (falls knife by default)
    contracts          = 1,
    win                = false,
    netPnlDollars      = null,
    outcomeReconciledAt = Date.now(),
    outcome            = "full_fill",
    timestampMs        = Date.now(),
  } = overrides;

  const triggerPriceCents =
    overrides.triggerPriceCents ?? fillPriceCents + gapCents;

  return {
    id,
    timestampMs,
    ticker:                 "KXBTC15M-2026-01-01T12:00:00",
    series:                 "KXBTC15M",
    windowCloseTime:        null,
    side,
    attemptNumber:          1,
    source:                 "websocket",
    triggerPriceCents,
    limitPriceCents:        fillPriceCents + 1,
    requestedContracts:     contracts,
    requestedNotionalCents: fillPriceCents * contracts,
    clientOrderId:          `client-${id}`,
    orderId:                `server-${id}`,
    fillCount:              contracts,
    remainingCount:         0,
    contracts:              tv(contracts),
    fillPriceCents:         tv(fillPriceCents),
    notionalDollars:        tv((fillPriceCents * contracts) / 100),
    feeDollars:             tv(0),
    outcome,
    roundTripMs:            100,
    reconciled:             outcomeReconciledAt !== null,
    win,
    netPnlDollars,
    outcomeReconciledAt,
  } as unknown as OrderAttemptRecord;
}

// ── Helper: run report with default 7¢ main sim ───────────────────────────────

function runReport(orders: OrderAttemptRecord[]) {
  return getEntryGapReport(
    orders,
    "test",
    "2026-01-01",
    "2026-01-31",
    100,
    FALLING_KNIFE_GAP_CENTS, // 7¢ main threshold
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// A. 7¢ parity
// ══════════════════════════════════════════════════════════════════════════════

describe("reverseSimAll — 7¢ parity with main reverseSim", () => {
  it("reverseSimAll['7'].count equals reverseSim.count for a single fill", () => {
    const order = makeRecord({ gapCents: 7, win: false });
    const report = runReport([order]);

    assert.equal(
      report.reverseSimAll["7"].count,
      report.reverseSim.count,
      "reverseSimAll['7'].count must equal main reverseSim.count",
    );
    assert.equal(report.reverseSim.count, 1, "one qualifying fill");
  });

  it("reverseSimAll['7'].count equals reverseSim.count across a mixed batch", () => {
    // Mix of gaps: 5, 7, 8, 10, 12 — all ≥ 7 qualify for main and ['7']
    const orders = [
      makeRecord({ gapCents: 5,  win: true  }),
      makeRecord({ gapCents: 7,  win: false }),
      makeRecord({ gapCents: 8,  win: true  }),
      makeRecord({ gapCents: 10, win: false }),
      makeRecord({ gapCents: 12, win: true  }),
    ];
    const report = runReport(orders);

    assert.equal(
      report.reverseSimAll["7"].count,
      report.reverseSim.count,
      "reverseSimAll['7'].count must match main reverseSim.count",
    );
    // Gaps ≥ 7: 7, 8, 10, 12 → 4 qualifying
    assert.equal(report.reverseSim.count, 4, "four fills with gap ≥ 7");
  });

  it("reverseSimAll['7'] simWinRate matches reverseSim.simWinRate", () => {
    const orders = [
      makeRecord({ gapCents: 7, win: false }), // NO wins
      makeRecord({ gapCents: 9, win: true  }), // NO loses
    ];
    const report = runReport(orders);
    assert.equal(
      report.reverseSimAll["7"].simWinRate,
      report.reverseSim.simWinRate,
      "simWinRate must be identical across main sim and ['7'] slot",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. Monotonicity: count(5¢) ≥ count(7¢) ≥ count(10¢)
// ══════════════════════════════════════════════════════════════════════════════

describe("reverseSimAll — monotonicity across 5¢ / 7¢ / 10¢ thresholds", () => {
  it("5¢ ≥ 7¢ ≥ 10¢ with fills spanning all three threshold bands", () => {
    // gap=5 → qualifies for 5¢ only
    // gap=7 → qualifies for 5¢ and 7¢
    // gap=10 → qualifies for 5¢, 7¢, and 10¢
    // gap=12 → qualifies for all three
    const orders = [
      makeRecord({ gapCents: 5,  win: false }),
      makeRecord({ gapCents: 7,  win: true  }),
      makeRecord({ gapCents: 10, win: false }),
      makeRecord({ gapCents: 12, win: true  }),
    ];
    const report = runReport(orders);

    const c5  = report.reverseSimAll["5"].count;
    const c7  = report.reverseSimAll["7"].count;
    const c10 = report.reverseSimAll["10"].count;

    assert.ok(c5 >= c7,  `count(5¢)=${c5} must be ≥ count(7¢)=${c7}`);
    assert.ok(c7 >= c10, `count(7¢)=${c7} must be ≥ count(10¢)=${c10}`);

    assert.equal(c5,  4, "all four fills qualify at 5¢ threshold");
    assert.equal(c7,  3, "three fills (gaps 7, 10, 12) qualify at 7¢");
    assert.equal(c10, 2, "two fills (gaps 10, 12) qualify at 10¢");
  });

  it("5¢ ≥ 7¢ ≥ 10¢ when all fills have gap < 5 (all thresholds = 0)", () => {
    const orders = [
      makeRecord({ gapCents: 1, win: false }),
      makeRecord({ gapCents: 3, win: true  }),
      makeRecord({ gapCents: 4, win: false }),
    ];
    const report = runReport(orders);

    const c5  = report.reverseSimAll["5"].count;
    const c7  = report.reverseSimAll["7"].count;
    const c10 = report.reverseSimAll["10"].count;

    // monotonicity still holds (all are 0)
    assert.ok(c5 >= c7,  `count(5¢)=${c5} ≥ count(7¢)=${c7}`);
    assert.ok(c7 >= c10, `count(7¢)=${c7} ≥ count(10¢)=${c10}`);
    assert.equal(c5,  0, "no fills qualify at 5¢");
    assert.equal(c7,  0, "no fills qualify at 7¢");
    assert.equal(c10, 0, "no fills qualify at 10¢");
  });

  it("monotonicity holds for NO-side fills (all excluded from every threshold)", () => {
    // NO-side fills must never enter the reverse sim regardless of threshold
    const orders = [
      makeRecord({ side: "no", gapCents: 5,  win: false }),
      makeRecord({ side: "no", gapCents: 8,  win: true  }),
      makeRecord({ side: "no", gapCents: 12, win: false }),
    ];
    const report = runReport(orders);

    assert.equal(report.reverseSimAll["5"].count,  0, "NO-side excluded at 5¢");
    assert.equal(report.reverseSimAll["7"].count,  0, "NO-side excluded at 7¢");
    assert.equal(report.reverseSimAll["10"].count, 0, "NO-side excluded at 10¢");
  });

  it("monotonicity holds when only gap=7 fills exist", () => {
    const orders = [
      makeRecord({ gapCents: 7, win: false }),
      makeRecord({ gapCents: 7, win: true  }),
    ];
    const report = runReport(orders);

    const c5  = report.reverseSimAll["5"].count;
    const c7  = report.reverseSimAll["7"].count;
    const c10 = report.reverseSimAll["10"].count;

    assert.ok(c5 >= c7,  `c5=${c5} ≥ c7=${c7}`);
    assert.ok(c7 >= c10, `c7=${c7} ≥ c10=${c10}`);
    assert.equal(c5,  2, "both qualify at 5¢");
    assert.equal(c7,  2, "both qualify at 7¢ (inclusive)");
    assert.equal(c10, 0, "neither qualifies at 10¢");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C. Day-rollover — empty orders array at midnight
// ══════════════════════════════════════════════════════════════════════════════

describe("reverseSimAll — day-rollover: empty orders = zero across all thresholds", () => {
  it("all thresholds return count=0 when no orders have been recorded yet (new day)", () => {
    // After a day rollover, the date filter returns 0 orders for "today" until
    // the first fill arrives. All three threshold slots must read 0.
    const report = runReport([]);

    assert.equal(report.reverseSimAll["5"].count,  0, "count(5¢) = 0 on fresh day");
    assert.equal(report.reverseSimAll["7"].count,  0, "count(7¢) = 0 on fresh day");
    assert.equal(report.reverseSimAll["10"].count, 0, "count(10¢) = 0 on fresh day");
  });

  it("simWinRate is null for all thresholds when no orders present", () => {
    const report = runReport([]);
    assert.equal(report.reverseSimAll["5"].simWinRate,  null, "simWinRate null at 5¢");
    assert.equal(report.reverseSimAll["7"].simWinRate,  null, "simWinRate null at 7¢");
    assert.equal(report.reverseSimAll["10"].simWinRate, null, "simWinRate null at 10¢");
  });

  it("main reverseSim.count is also 0 when no orders present", () => {
    const report = runReport([]);
    assert.equal(report.reverseSim.count, 0, "main reverseSim.count = 0");
    assert.equal(report.buckets.every((b) => b.fills === 0), true, "all buckets empty");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D. Period scope — no state leakage between threshold calls
// ══════════════════════════════════════════════════════════════════════════════

describe("reverseSimAll — same order set used consistently across all thresholds", () => {
  it("adding a 5¢-only fill increases count(5¢) but not count(7¢) or count(10¢)", () => {
    const before = runReport([makeRecord({ gapCents: 9, win: false })]);

    const withExtra = runReport([
      makeRecord({ gapCents: 9, win: false }),
      makeRecord({ gapCents: 5, win: true  }), // only qualifies at 5¢
    ]);

    assert.equal(
      withExtra.reverseSimAll["5"].count,
      before.reverseSimAll["5"].count + 1,
      "count(5¢) increases by 1",
    );
    assert.equal(
      withExtra.reverseSimAll["7"].count,
      before.reverseSimAll["7"].count,
      "count(7¢) unchanged",
    );
    assert.equal(
      withExtra.reverseSimAll["10"].count,
      before.reverseSimAll["10"].count,
      "count(10¢) unchanged",
    );
  });

  it("adding a 10¢ fill increases all three counts equally", () => {
    const before = runReport([]);

    const with10 = runReport([makeRecord({ gapCents: 10, win: false })]);

    assert.equal(with10.reverseSimAll["5"].count,  1, "count(5¢) = 1");
    assert.equal(with10.reverseSimAll["7"].count,  1, "count(7¢) = 1");
    assert.equal(with10.reverseSimAll["10"].count, 1, "count(10¢) = 1");
    // All three see it — the same order set drives all thresholds
    assert.ok(
      with10.reverseSimAll["5"].count >=
      with10.reverseSimAll["7"].count &&
      with10.reverseSimAll["7"].count >=
      with10.reverseSimAll["10"].count,
      "monotonicity preserved after adding a qualifying fill",
    );
    // Suppress unused variable warning
    void before;
  });

  it("unreconciled fills contribute to none of the three thresholds", () => {
    const orders = [
      makeRecord({ gapCents: 5,  win: null, outcomeReconciledAt: null }),
      makeRecord({ gapCents: 7,  win: null, outcomeReconciledAt: null }),
      makeRecord({ gapCents: 12, win: null, outcomeReconciledAt: null }),
    ];
    const report = runReport(orders);

    assert.equal(report.reverseSimAll["5"].count,  0, "unreconciled excluded at 5¢");
    assert.equal(report.reverseSimAll["7"].count,  0, "unreconciled excluded at 7¢");
    assert.equal(report.reverseSimAll["10"].count, 0, "unreconciled excluded at 10¢");
  });
});
