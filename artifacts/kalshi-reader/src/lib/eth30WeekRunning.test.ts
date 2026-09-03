/**
 * Unit tests for computeEth30WeeklyRunningTotals — the source-owned helper
 * that Dashboard.tsx uses to build its ETH 30–50 weekly running-total column.
 *
 * Because the tests import and invoke the production helper directly, any
 * regression in the accumulation logic (loop order, net/gross selection,
 * partial-fee latching, empty-week handling) will surface here.
 *
 * Covering:
 *   1. Multi-week accumulation in oldest-first order
 *   2. A week with no fills contributes exactly 0 (not NaN or undefined)
 *   3. Uses netPnl when fees are complete, grossPnl fallback otherwise
 *   4. runningIsPartial latches true once any filled week lacks complete fees
 *   5. Week-boundary tickers (Sunday vs Monday claim) land in the right bucket
 *   6. Single-week and empty-input edge cases
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeEth30WeeklyRunningTotals } from './eth30WeekGroup.js';
import type { Eth30TickerRow } from './eth30FeeWarning.js';

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<Eth30TickerRow> & { easternDate: string }): Eth30TickerRow {
  return {
    ticker: 'ETH-2026-31-50',
    side: 'yes',
    entryContracts: 1,
    entryCostCents: 7000,
    entryAvgPriceCents: 7000,
    exitContracts: 0,
    exitProceedsCents: 0,
    settlementResult: null,
    settledContracts: 0,
    settlementPayoutCents: 0,
    openContracts: 0,
    realizedPnlCents: 0,
    totalFeeCents: null,
    netPnlCents: null,
    feesIncluded: false,
    anyFeesCaptured: false,
    status: 'settled',
    firstExecutable50AtMs: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeEth30WeeklyRunningTotals', () => {
  it('accumulates oldest-first across three weeks', () => {
    // Week 1 (Mon 2026-07-06): +100 ¢ gross
    // Week 2 (Mon 2026-07-13): +200 ¢ gross
    // Week 3 (Mon 2026-07-20): −50 ¢ gross
    // Input deliberately disordered to confirm sorting happens inside the helper.
    const tickers: Eth30TickerRow[] = [
      makeRow({ easternDate: '2026-07-20', realizedPnlCents: -50 }),   // week 3
      makeRow({ easternDate: '2026-07-06', realizedPnlCents: 100 }),   // week 1
      makeRow({ easternDate: '2026-07-13', realizedPnlCents: 200 }),   // week 2
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 3);

    // Oldest first
    assert.equal(entries[0].weekKey, '2026-07-06');
    assert.equal(entries[1].weekKey, '2026-07-13');
    assert.equal(entries[2].weekKey, '2026-07-20');

    // Running totals
    assert.equal(entries[0].runningNetPnl, 100);   // after week 1
    assert.equal(entries[1].runningNetPnl, 300);   // after week 2 (+200)
    assert.equal(entries[2].runningNetPnl, 250);   // after week 3 (−50)
  });

  it('week with no fills contributes exactly 0 (not NaN or undefined)', () => {
    // Week 1: filled row with +80 ¢
    // Week 2: unfilled row (entryContracts=0) — must contribute 0
    // Week 3: filled row with +40 ¢
    const tickers: Eth30TickerRow[] = [
      makeRow({ easternDate: '2026-07-06', entryContracts: 1, realizedPnlCents: 80 }),
      makeRow({ easternDate: '2026-07-13', entryContracts: 0, realizedPnlCents: 0 }),
      makeRow({ easternDate: '2026-07-20', entryContracts: 1, realizedPnlCents: 40 }),
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 3);
    assert.equal(entries[0].runningNetPnl, 80);    // week 1
    assert.equal(entries[1].runningNetPnl, 80);    // week 2 no-fill: unchanged
    assert.equal(entries[2].runningNetPnl, 120);   // week 3 +40

    for (const e of entries) {
      assert.ok(!Number.isNaN(e.runningNetPnl), `runningNetPnl for ${e.weekKey} must not be NaN`);
    }
  });

  it('uses netPnl when fees are complete, grossPnl fallback when fees are missing', () => {
    // Week 1: fees complete → netPnl = +60 (gross 70, fee 10)
    // Week 2: fees missing  → falls back to grossPnl = +50
    const tickers: Eth30TickerRow[] = [
      makeRow({
        easternDate: '2026-07-06',
        realizedPnlCents: 70,
        netPnlCents: 60,
        totalFeeCents: 10,
        feesIncluded: true,
        anyFeesCaptured: true,
      }),
      makeRow({
        easternDate: '2026-07-13',
        realizedPnlCents: 50,
        netPnlCents: null,
        totalFeeCents: null,
        feesIncluded: false,
        anyFeesCaptured: false,
      }),
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 2);
    assert.equal(entries[0].runningNetPnl, 60);   // net used (fees complete)
    assert.equal(entries[1].runningNetPnl, 110);  // gross fallback (+50)
  });

  it('runningIsPartial latches true once a filled week lacks complete fee data', () => {
    // Week 1: fees complete → runningIsPartial stays false
    // Week 2: fees missing, has fills → runningIsPartial becomes true and stays true
    // Week 3: fees complete → runningIsPartial remains true (latched)
    const tickers: Eth30TickerRow[] = [
      makeRow({ easternDate: '2026-07-06', feesIncluded: true, anyFeesCaptured: true,
                netPnlCents: 50, totalFeeCents: 5, realizedPnlCents: 55 }),
      makeRow({ easternDate: '2026-07-13', feesIncluded: false, anyFeesCaptured: false,
                realizedPnlCents: 30 }),
      makeRow({ easternDate: '2026-07-20', feesIncluded: true, anyFeesCaptured: true,
                netPnlCents: 40, totalFeeCents: 4, realizedPnlCents: 44 }),
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 3);
    assert.equal(entries[0].runningIsPartial, false);  // week 1: fees complete
    assert.equal(entries[1].runningIsPartial, true);   // week 2: latched
    assert.equal(entries[2].runningIsPartial, true);   // week 3: remains latched
  });

  it('unfilled week does not latch runningIsPartial', () => {
    // Week 1: fees complete
    // Week 2: no fills, feesIncluded=false — an unfilled week must NOT trigger the latch
    // Week 3: fees complete
    const tickers: Eth30TickerRow[] = [
      makeRow({ easternDate: '2026-07-06', feesIncluded: true, anyFeesCaptured: true,
                netPnlCents: 50, totalFeeCents: 5, realizedPnlCents: 55 }),
      makeRow({ easternDate: '2026-07-13', entryContracts: 0, feesIncluded: false,
                realizedPnlCents: 0 }),
      makeRow({ easternDate: '2026-07-20', feesIncluded: true, anyFeesCaptured: true,
                netPnlCents: 40, totalFeeCents: 4, realizedPnlCents: 44 }),
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 3);
    assert.equal(entries[0].runningIsPartial, false);
    assert.equal(entries[1].runningIsPartial, false);  // unfilled: no latch
    assert.equal(entries[2].runningIsPartial, false);
  });

  it('Sunday-claimed ticker belongs to previous ISO week, Monday-claimed opens a new week', () => {
    // 2026-08-09 is a Sunday → week of Mon 2026-08-03
    // 2026-08-10 is a Monday → week of Mon 2026-08-10
    const tickers: Eth30TickerRow[] = [
      makeRow({ easternDate: '2026-08-09', realizedPnlCents: 300 }),  // Sunday
      makeRow({ easternDate: '2026-08-10', realizedPnlCents: 500 }),  // Monday
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 2);

    // Sunday row lands in the week that started 2026-08-03
    assert.equal(entries[0].weekKey, '2026-08-03');
    assert.equal(entries[0].rows.length, 1);
    assert.equal(entries[0].rows[0].easternDate, '2026-08-09');
    assert.equal(entries[0].runningNetPnl, 300);

    // Monday row opens a new week
    assert.equal(entries[1].weekKey, '2026-08-10');
    assert.equal(entries[1].runningNetPnl, 800);
  });

  it('week-boundary Sunday/Monday pair both appear in the running total without gaps', () => {
    // 2026-08-02 is Sunday → week 2026-07-27
    // 2026-08-03 is Monday → week 2026-08-03
    const tickers: Eth30TickerRow[] = [
      makeRow({ easternDate: '2026-08-02', realizedPnlCents: 200 }),
      makeRow({ easternDate: '2026-08-03', realizedPnlCents: 150 }),
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 2);
    assert.equal(entries[0].weekKey, '2026-07-27');
    assert.equal(entries[1].weekKey, '2026-08-03');

    for (const e of entries) {
      assert.ok(!Number.isNaN(e.runningNetPnl), `runningNetPnl for ${e.weekKey} must not be NaN`);
    }
    assert.equal(entries[0].runningNetPnl, 200);
    assert.equal(entries[1].runningNetPnl, 350);
  });

  it('single-week scenario returns one entry with the correct running total', () => {
    const tickers: Eth30TickerRow[] = [
      makeRow({ easternDate: '2026-07-14', realizedPnlCents: 90 }),
      makeRow({ easternDate: '2026-07-16', realizedPnlCents: -30 }),
    ];

    const entries = computeEth30WeeklyRunningTotals(tickers);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].runningNetPnl, 60);  // 90 + (−30)
  });

  it('empty ticker list returns an empty array', () => {
    const entries = computeEth30WeeklyRunningTotals([]);
    assert.deepEqual(entries, []);
  });
});
