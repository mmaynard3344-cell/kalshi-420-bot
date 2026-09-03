/**
 * performanceReports.reverseSim.test.ts
 *
 * Unit tests for the stop-and-reverse-to-NO simulation inside getEntryGapReport.
 *
 * Covers:
 *   1. YES won  → NO loses  (simNoWin = false, simGross < 0)
 *   2. YES lost → NO wins   (simNoWin = true,  simGross > 0)
 *   3. Mixed bag — correct delta sign (simAvgPnl − actualAvgPnl)
 *   4. simNoWin === !win for every YES-side falling-knife entry
 *   5. Complement price formula: noEntryCents === 100 − fillPriceCents
 *   6. Non-falling-knife entries are excluded from reverseSim
 *   7. NO-side orders are excluded from reverseSim even if gap ≥ threshold
 *
 * Runner: esbuild --bundle | node --test  (same pattern as strategyConstants.sync.test.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getEntryGapReport,
  FALLING_KNIFE_GAP_CENTS,
} from "./performanceReports.js";
import type { OrderAttemptRecord } from "./analytics.js";

// ── Minimal record builder ─────────────────────────────────────────────────────

type TV<T> = { value: T };

function tv<T>(val: T): TV<T> {
  return { value: val };
}

let _idSeq = 0;
function makeRecord(overrides: {
  side?: "yes" | "no";
  fillPriceCents?: number;
  triggerPriceCents?: number;
  contracts?: number;
  win?: boolean | null;
  netPnlDollars?: number | null;
  outcomeReconciledAt?: number | null;
  outcome?: "full_fill" | "partial_fill" | "zero_fill";
}): OrderAttemptRecord {
  const id = `order-${++_idSeq}`;
  const {
    side               = "yes",
    fillPriceCents     = 80,
    triggerPriceCents  = fillPriceCents + FALLING_KNIFE_GAP_CENTS, // falling knife by default
    contracts          = 1,
    win                = null,
    netPnlDollars      = null,
    outcomeReconciledAt = Date.now(),
    outcome            = "full_fill",
  } = overrides;

  return {
    id,
    timestampMs:            Date.now(),
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
    // market outcome fields
    win:                    win,
    netPnlDollars:          netPnlDollars,
    outcomeReconciledAt:    outcomeReconciledAt,
  } as unknown as OrderAttemptRecord;
}

// ── Helper to invoke the report with a small order list ───────────────────────

function runReport(orders: OrderAttemptRecord[]) {
  return getEntryGapReport(orders, "test", "2026-01-01", "2026-01-01");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reverse simulation — complement price formula", () => {
  it("noEntryCents === 100 − fillPriceCents for every falling-knife YES entry", () => {
    const fillCents = 78;
    const rec = makeRecord({ side: "yes", fillPriceCents: fillCents, win: false });
    const report = runReport([rec]);

    assert.equal(report.reverseSim.count, 1, "one falling-knife entry");
    assert.equal(
      report.reverseSim.avgNoEntryPriceCents,
      100 - fillCents,
      "NO entry price is the complement of YES fill price",
    );
    assert.equal(
      report.reverseSim.avgYesEntryPriceCents,
      fillCents,
      "YES entry price matches the fill",
    );
  });
});

describe("reverse simulation — scenario 1: YES won → NO loses", () => {
  it("simWin is false and simGross is negative", () => {
    // YES filled at 80¢ on 1 contract; market resolved YES → YES won
    // NO entry = 20¢; NO lost → simGross = −(20/100) × 1 = −0.20
    const fillCents = 80;
    const contracts = 1;
    const rec = makeRecord({ side: "yes", fillPriceCents: fillCents, contracts, win: true, netPnlDollars: 0.20 });
    const report = runReport([rec]);

    const sim = report.reverseSim;
    assert.equal(sim.count, 1, "one entry in sim");
    assert.equal(sim.simWins, 0, "NO did not win");
    assert.equal(sim.simLosses, 1, "NO lost");
    assert.equal(sim.simWinRate, 0, "sim win rate is 0");

    const noEntry = 100 - fillCents;           // 20
    const expectedSimGross = -(noEntry / 100) * contracts; // −0.20
    assert.ok(
      Math.abs(sim.simTotalPnlDollars! - expectedSimGross) < 1e-9,
      `simTotalPnlDollars should be ${expectedSimGross}, got ${sim.simTotalPnlDollars}`,
    );

    // Per-trade simNoWin = !win
    const trade = report.trades.find((t) => t.id === rec.id);
    assert.ok(trade, "trade should appear in the list");
    assert.equal(trade!.simNoWin, false, "simNoWin must be !win (false when YES won)");

    // Verify complement in per-trade field
    assert.equal(trade!.simNoEntryPriceCents, noEntry, "per-trade NO entry uses complement formula");
  });
});

describe("reverse simulation — scenario 2: YES lost → NO wins", () => {
  it("simWin is true and simGross is positive", () => {
    // YES filled at 75¢ on 1 contract; market resolved NO → YES lost
    // NO entry = 25¢; NO won → simGross = (1 − 25/100) × 1 = 0.75
    const fillCents = 75;
    const contracts = 1;
    const rec = makeRecord({ side: "yes", fillPriceCents: fillCents, contracts, win: false, netPnlDollars: -0.75 });
    const report = runReport([rec]);

    const sim = report.reverseSim;
    assert.equal(sim.count, 1);
    assert.equal(sim.simWins, 1, "NO won");
    assert.equal(sim.simLosses, 0, "NO did not lose");
    assert.equal(sim.simWinRate, 1, "sim win rate is 1");

    const noEntry = 100 - fillCents;                        // 25
    const expectedSimGross = (1 - noEntry / 100) * contracts; // 0.75
    assert.ok(
      Math.abs(sim.simTotalPnlDollars! - expectedSimGross) < 1e-9,
      `simTotalPnlDollars should be ${expectedSimGross}, got ${sim.simTotalPnlDollars}`,
    );

    // Per-trade simNoWin = !win
    const trade = report.trades.find((t) => t.id === rec.id);
    assert.ok(trade, "trade should appear");
    assert.equal(trade!.simNoWin, true, "simNoWin must be !win (true when YES lost)");
  });
});

describe("reverse simulation — scenario 3: mixed bag", () => {
  it("delta sign is positive when NO would have outperformed YES", () => {
    // Two falling-knife YES entries:
    //   A: fill=80¢, win=true  (YES won $0.20);  NO sim: −0.20
    //   B: fill=75¢, win=false (YES net=-$0.75); NO sim: +0.75
    //
    // actualAvg = (0.20 + (−0.75)) / 2 = −0.275
    // simAvg    = (−0.20 + 0.75)  / 2 =  0.275
    // delta     = simAvg − actualAvg  =  0.55 (positive → NO would have done better)

    const recA = makeRecord({ side: "yes", fillPriceCents: 80, contracts: 1, win: true,  netPnlDollars:  0.20 });
    const recB = makeRecord({ side: "yes", fillPriceCents: 75, contracts: 1, win: false, netPnlDollars: -0.75 });
    const report = runReport([recA, recB]);

    const sim = report.reverseSim;
    assert.equal(sim.count, 2, "two entries in sim");
    assert.equal(sim.simWins,   1, "one NO win");
    assert.equal(sim.simLosses, 1, "one NO loss");

    const expectedSimAvg    =  0.275;
    const expectedActualAvg = -0.275;
    const expectedDelta     =  0.55;

    assert.ok(
      Math.abs(sim.simAvgPnlDollars! - expectedSimAvg) < 1e-9,
      `simAvgPnlDollars expected ${expectedSimAvg}, got ${sim.simAvgPnlDollars}`,
    );
    assert.ok(
      Math.abs(sim.actualAvgPnlDollars! - expectedActualAvg) < 1e-9,
      `actualAvgPnlDollars expected ${expectedActualAvg}, got ${sim.actualAvgPnlDollars}`,
    );
    assert.ok(
      sim.deltaAvgPnlDollars! > 0,
      "deltaAvgPnlDollars must be positive (NO outperforms YES on falling knives)",
    );
    assert.ok(
      Math.abs(sim.deltaAvgPnlDollars! - expectedDelta) < 1e-9,
      `deltaAvgPnlDollars expected ${expectedDelta}, got ${sim.deltaAvgPnlDollars}`,
    );
  });

  it("delta sign is negative when YES actually outperformed NO", () => {
    // Unusual case: falling knife but YES still won big, NO would have lost.
    // Two entries, both YES won:
    //   A: fill=72¢, win=true, net=$0.28 → NO sim: −0.28
    //   B: fill=70¢, win=true, net=$0.30 → NO sim: −0.30
    // actualAvg = +0.29; simAvg = −0.29; delta = −0.58 (negative)

    const recA = makeRecord({ side: "yes", fillPriceCents: 72, contracts: 1, win: true, netPnlDollars: 0.28 });
    const recB = makeRecord({ side: "yes", fillPriceCents: 70, contracts: 1, win: true, netPnlDollars: 0.30 });
    const report = runReport([recA, recB]);

    const sim = report.reverseSim;
    assert.equal(sim.simWins, 0, "both NO positions would have lost");
    assert.ok(
      sim.deltaAvgPnlDollars! < 0,
      "deltaAvgPnlDollars is negative when YES outperformed the NO simulation",
    );
  });
});

describe("reverse simulation — simNoWin === !win invariant", () => {
  it("holds for every combination of win=true and win=false across multiple entries", () => {
    const entries = [
      makeRecord({ side: "yes", fillPriceCents: 80, win: true,  netPnlDollars:  0.20 }),
      makeRecord({ side: "yes", fillPriceCents: 75, win: false, netPnlDollars: -0.75 }),
      makeRecord({ side: "yes", fillPriceCents: 70, win: true,  netPnlDollars:  0.30 }),
      makeRecord({ side: "yes", fillPriceCents: 82, win: false, netPnlDollars: -0.82 }),
    ];
    const report = runReport(entries);
    assert.equal(report.reverseSim.count, 4, "all four entries qualify");

    for (const entry of entries) {
      const trade = report.trades.find((t) => t.id === entry.id);
      assert.ok(trade, `trade ${entry.id} should appear`);
      assert.equal(
        trade!.simNoWin,
        !entry.win,
        `simNoWin must equal !win for order ${entry.id} (win=${String(entry.win)})`,
      );
    }
  });
});

describe("reverse simulation — exclusion rules", () => {
  it("excludes entries with gap < FALLING_KNIFE_GAP_CENTS", () => {
    // Gap of exactly 6 — one below threshold (7)
    const smallGap = makeRecord({
      side:              "yes",
      fillPriceCents:    80,
      triggerPriceCents: 80 + FALLING_KNIFE_GAP_CENTS - 1, // gap = 6
      win:               false,
      netPnlDollars:     -0.80,
    });
    const report = runReport([smallGap]);
    assert.equal(report.reverseSim.count, 0, "sub-threshold gap excluded from sim");
  });

  it("excludes NO-side orders even when gap ≥ FALLING_KNIFE_GAP_CENTS", () => {
    // A NO-side fill with a large gap must NOT enter the reverse sim
    const noOrder = makeRecord({
      side:              "no",
      fillPriceCents:    20,
      triggerPriceCents: 20 + FALLING_KNIFE_GAP_CENTS + 5, // gap clearly above threshold
      win:               false,
      netPnlDollars:     -0.20,
    });
    const report = runReport([noOrder]);
    assert.equal(report.reverseSim.count, 0, "NO-side orders excluded from reverse sim");
  });

  it("excludes unreconciled entries (no outcomeReconciledAt)", () => {
    const unreconciled = makeRecord({
      side:               "yes",
      fillPriceCents:     80,
      win:                false,
      netPnlDollars:      null,
      outcomeReconciledAt: null,
    });
    const report = runReport([unreconciled]);
    assert.equal(report.reverseSim.count, 0, "unreconciled entry excluded from sim");
  });

  it("excludes entries where win is null", () => {
    const noOutcome = makeRecord({
      side:          "yes",
      fillPriceCents: 80,
      win:           null,
      netPnlDollars: null,
    });
    const report = runReport([noOutcome]);
    assert.equal(report.reverseSim.count, 0, "null-win entry excluded from sim");
  });
});

describe("reverse simulation — multi-contract P&L scaling", () => {
  it("simGross scales linearly with contract count", () => {
    // YES filled at 80¢ on 5 contracts; YES won.
    // NO entry = 20¢; NO lost → simGross = −(20/100) × 5 = −1.00
    const fillCents = 80;
    const contracts = 5;
    const rec = makeRecord({ side: "yes", fillPriceCents: fillCents, contracts, win: true, netPnlDollars: 1.0 });
    const report = runReport([rec]);

    const noEntry = 100 - fillCents;                             // 20
    const expectedSimGross = -(noEntry / 100) * contracts;       // −1.00
    assert.ok(
      Math.abs(report.reverseSim.simTotalPnlDollars! - expectedSimGross) < 1e-9,
      `simTotalPnlDollars with ${contracts} contracts expected ${expectedSimGross}`,
    );
  });
});
