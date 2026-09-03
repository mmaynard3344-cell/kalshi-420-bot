/**
 * Unit tests for the ETH 30–50 fee-missing warning indicators.
 *
 * All helpers are imported from @/lib/eth30FeeWarning — the same module that
 * Dashboard.tsx uses — so changes to the source logic break these tests, not
 * just a disconnected reimplementation.
 *
 * Run via the api-server test harness:
 *   cd artifacts/api-server && \
 *   node_modules/.bin/esbuild \
 *     ../kalshi-reader/src/pages/Dashboard.eth30FeeWarning.test.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=/tmp/eth30-fee-warning.mjs && \
 *   node --test /tmp/eth30-fee-warning.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeEth30WeekSummary,
  eth30HeaderBadgeText,
  eth30SummaryPnlLabel,
  eth30SummaryPnlCents,
  eth30ShowsGrossPnlColumn,
  eth30NetPnlHeaderHasAsterisk,
  eth30FeesPaidShowsPartialAnnotation,
  eth30FooterNoteKind,
  eth30RowNetPnlCellKind,
  eth30RowFeeCellKind,
  type Eth30Report,
  type Eth30TickerRow,
} from '../lib/eth30FeeWarning';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<Eth30Report['summary']> = {}): Eth30Report['summary'] {
  return {
    claimedTickers: 3,
    tickersWithFills: 2,
    entryContracts: 10,
    entryCostCents: -4000,
    exitProceedsCents: 0,
    settlementPayoutCents: 10000,
    openContracts: 5,
    totalFeeCents: 120,
    netPnlCents: 5880,
    realizedPnlCents: 6000,
    settledTickers: 1,
    wins: 1,
    losses: 0,
    ...overrides,
  };
}

function makeReport(
  feesIncluded: boolean,
  summaryOverrides: Partial<Eth30Report['summary']> = {},
  rows: Eth30TickerRow[] = [],
): Eth30Report {
  return {
    strategy: 'ETH_30_50',
    source: 'test',
    feesIncluded,
    summary: makeSummary(summaryOverrides),
    tickers: rows,
  };
}

function makeRow(overrides: Partial<Eth30TickerRow> = {}): Eth30TickerRow {
  return {
    ticker: 'KXETH-26AUG-30-50',
    easternDate: '2026-08-26',
    side: 'yes',
    entryContracts: 10,
    entryCostCents: 400,
    entryAvgPriceCents: 40,
    exitContracts: 0,
    exitProceedsCents: 0,
    settlementResult: 'yes',
    settledContracts: 10,
    settlementPayoutCents: 1000,
    openContracts: 0,
    realizedPnlCents: 600,
    totalFeeCents: 12,
    netPnlCents: 588,
    feesIncluded: true,
    anyFeesCaptured: true,
    status: 'settled',
    firstExecutable50AtMs: null,
    ...overrides,
  };
}

// ─── computeEth30WeekSummary — the critical weekly aggregation ────────────────

describe('computeEth30WeekSummary', () => {
  it('returns exact netPnl when all filled rows have feesIncluded=true', () => {
    const rowA = makeRow({ realizedPnlCents: 100, netPnlCents: 97, totalFeeCents: 3, feesIncluded: true, anyFeesCaptured: true, status: 'settled' });
    const rowB = makeRow({ realizedPnlCents: 200, netPnlCents: 195, totalFeeCents: 5, feesIncluded: true, anyFeesCaptured: true, status: 'settled' });
    const summary = computeEth30WeekSummary([rowA, rowB]);
    assert.equal(summary.allFeesIncluded, true, 'allFeesIncluded must be true when every row has feesIncluded');
    assert.equal(summary.netPnl, 97 + 195, 'netPnl must be exact sum of per-row netPnlCents');
    assert.equal(summary.grossPnl, 300);
    assert.equal(summary.fees, 8);
    assert.equal(summary.wins, 2);
    assert.equal(summary.losses, 0);
  });

  it('returns netPnl=null when ANY filled row has feesIncluded=false — no silent gross fallback', () => {
    // Row A has complete fee coverage; row B has partial coverage (anyFeesCaptured but not feesIncluded).
    // The weekly sum must be null — never show a mix of exact-net + gross as if it were net.
    const rowWithFees = makeRow({ realizedPnlCents: 100, netPnlCents: 97, totalFeeCents: 3, feesIncluded: true, anyFeesCaptured: true, status: 'settled' });
    const rowPartialFees = makeRow({ realizedPnlCents: 200, netPnlCents: null, totalFeeCents: null, feesIncluded: false, anyFeesCaptured: true, status: 'settled' });
    const summary = computeEth30WeekSummary([rowWithFees, rowPartialFees]);
    assert.equal(summary.allFeesIncluded, false, 'allFeesIncluded must be false — one row has feesIncluded=false');
    assert.equal(summary.netPnl, null, 'netPnl must be null when any filled row lacks complete fee coverage');
    assert.equal(summary.grossPnl, 300, 'grossPnl is always exact');
    assert.equal(summary.anyFeesCaptured, true, 'anyFeesCaptured reflects at least one row with fee data');
  });

  it('returns netPnl=null when any row has feesIncluded=false even if all have anyFeesCaptured=true', () => {
    // This is the exact bug that was filed: anyFeesCaptured=true on every row does NOT mean
    // all fills have complete fee data — a row with one populated chunk and one null chunk
    // has anyFeesCaptured=true but feesIncluded=false.
    const rowA = makeRow({ feesIncluded: true, anyFeesCaptured: true, netPnlCents: 97, realizedPnlCents: 100 });
    const rowB = makeRow({ feesIncluded: false, anyFeesCaptured: true, netPnlCents: null, realizedPnlCents: 50 });
    const summary = computeEth30WeekSummary([rowA, rowB]);
    assert.equal(summary.allFeesIncluded, false);
    assert.equal(summary.netPnl, null, 'netPnl must be null — anyFeesCaptured=true on all rows is not sufficient');
  });

  it('returns netPnl=null and anyFeesCaptured=false when no rows have any fees', () => {
    const row = makeRow({ feesIncluded: false, anyFeesCaptured: false, netPnlCents: null, totalFeeCents: null });
    const summary = computeEth30WeekSummary([row]);
    assert.equal(summary.allFeesIncluded, false);
    assert.equal(summary.netPnl, null);
    assert.equal(summary.anyFeesCaptured, false);
    assert.equal(summary.grossPnl, row.realizedPnlCents);
  });

  it('ignores no-fill rows (entryContracts=0) for all aggregations', () => {
    const filled = makeRow({ entryContracts: 5, realizedPnlCents: 100, netPnlCents: 97, feesIncluded: true, anyFeesCaptured: true });
    const noFill = makeRow({ entryContracts: 0, realizedPnlCents: 0, netPnlCents: null, feesIncluded: false, anyFeesCaptured: false });
    const summary = computeEth30WeekSummary([filled, noFill]);
    // No-fill row must not make allFeesIncluded false
    assert.equal(summary.allFeesIncluded, true, 'no-fill rows must not affect allFeesIncluded');
    assert.equal(summary.netPnl, 97);
    assert.equal(summary.grossPnl, 100);
  });
});

// ─── Other helpers ────────────────────────────────────────────────────────────

describe('ETH 30–50 fee-missing warning indicators (source: eth30FeeWarning.ts)', () => {

  // ── Header badge ─────────────────────────────────────────────────────────────

  describe('eth30HeaderBadgeText', () => {
    it('returns NET OF FEES when feesIncluded=true', () => {
      assert.equal(eth30HeaderBadgeText(makeReport(true)), 'NET OF FEES');
    });

    it('returns FEES PARTIAL when feesIncluded=false and tickersWithFills > 0', () => {
      assert.equal(eth30HeaderBadgeText(makeReport(false, { tickersWithFills: 2 })), 'FEES PARTIAL');
    });

    it('returns GROSS OF FEES when feesIncluded=false and no tickers have fills', () => {
      assert.equal(eth30HeaderBadgeText(makeReport(false, { tickersWithFills: 0 })), 'GROSS OF FEES');
    });
  });

  // ── Summary P&L tile ─────────────────────────────────────────────────────────

  describe('eth30SummaryPnlLabel', () => {
    it('returns "Net P&L" when feesIncluded=true', () => {
      assert.equal(eth30SummaryPnlLabel(makeReport(true)), 'Net P&L');
    });

    it('returns "Gross P&L" when feesIncluded=false', () => {
      assert.equal(eth30SummaryPnlLabel(makeReport(false)), 'Gross P&L');
    });
  });

  describe('eth30SummaryPnlCents', () => {
    it('returns netPnlCents when feesIncluded=true', () => {
      const report = makeReport(true, { realizedPnlCents: 6000, netPnlCents: 5880 });
      assert.equal(eth30SummaryPnlCents(report), 5880);
    });

    it('returns realizedPnlCents (gross) when feesIncluded=false', () => {
      const report = makeReport(false, { realizedPnlCents: 6000, netPnlCents: 5880 });
      assert.equal(eth30SummaryPnlCents(report), 6000);
    });

    it('falls back to realizedPnlCents when netPnlCents is null', () => {
      const report = makeReport(true, { realizedPnlCents: 6000, netPnlCents: null });
      assert.equal(eth30SummaryPnlCents(report), 6000);
    });

    it('returns null rather than coercing an unverified strategy total to zero', () => {
      const report = makeReport(false, { realizedPnlCents: null, netPnlCents: null });
      assert.equal(eth30SummaryPnlCents(report), null);
    });
  });

  // ── Table column & header indicators ─────────────────────────────────────────

  describe('eth30ShowsGrossPnlColumn', () => {
    it('returns true when feesIncluded=false', () => {
      assert.ok(eth30ShowsGrossPnlColumn(makeReport(false)));
    });

    it('returns false when feesIncluded=true', () => {
      assert.ok(!eth30ShowsGrossPnlColumn(makeReport(true)));
    });
  });

  describe('eth30NetPnlHeaderHasAsterisk', () => {
    it('returns true when feesIncluded=false', () => {
      assert.ok(eth30NetPnlHeaderHasAsterisk(makeReport(false)));
    });

    it('returns false when feesIncluded=true', () => {
      assert.ok(!eth30NetPnlHeaderHasAsterisk(makeReport(true)));
    });
  });

  // ── Fees-paid tile annotation ─────────────────────────────────────────────────

  describe('eth30FeesPaidShowsPartialAnnotation', () => {
    it('returns true when feesIncluded=false and tickersWithFills > 0', () => {
      assert.ok(eth30FeesPaidShowsPartialAnnotation(makeReport(false, { tickersWithFills: 2 })));
    });

    it('returns false when feesIncluded=true', () => {
      assert.ok(!eth30FeesPaidShowsPartialAnnotation(makeReport(true, { tickersWithFills: 2 })));
    });

    it('returns false when feesIncluded=false but no fills exist yet', () => {
      assert.ok(!eth30FeesPaidShowsPartialAnnotation(makeReport(false, { tickersWithFills: 0 })));
    });
  });

  // ── Footer note ───────────────────────────────────────────────────────────────

  describe('eth30FooterNoteKind', () => {
    it('returns "net-formula" when feesIncluded=true', () => {
      assert.equal(eth30FooterNoteKind(makeReport(true)), 'net-formula');
    });

    it('returns "fee-warning" when feesIncluded=false', () => {
      assert.equal(eth30FooterNoteKind(makeReport(false)), 'fee-warning');
    });
  });

  // ── Per-row net P&L cell ──────────────────────────────────────────────────────

  describe('eth30RowNetPnlCellKind', () => {
    it('returns "net" when row.feesIncluded=true', () => {
      assert.equal(eth30RowNetPnlCellKind(makeRow({ feesIncluded: true, anyFeesCaptured: true })), 'net');
    });

    it('returns "partial" when row.feesIncluded=false and anyFeesCaptured=true', () => {
      assert.equal(eth30RowNetPnlCellKind(makeRow({ feesIncluded: false, anyFeesCaptured: true })), 'partial');
    });

    it('returns "not-loaded" when row.feesIncluded=false and anyFeesCaptured=false', () => {
      assert.equal(eth30RowNetPnlCellKind(makeRow({ feesIncluded: false, anyFeesCaptured: false, entryContracts: 10 })), 'not-loaded');
    });

    it('returns "dash" when entryContracts=0 regardless of fee status', () => {
      assert.equal(eth30RowNetPnlCellKind(makeRow({ entryContracts: 0, feesIncluded: false })), 'dash');
    });
  });

  // ── Per-row fee cell ──────────────────────────────────────────────────────────

  describe('eth30RowFeeCellKind', () => {
    it('returns "amount" when anyFeesCaptured=true', () => {
      assert.equal(eth30RowFeeCellKind(makeRow({ entryContracts: 5, anyFeesCaptured: true })), 'amount');
    });

    it('returns "not-loaded" when anyFeesCaptured=false and entry fills exist', () => {
      assert.equal(eth30RowFeeCellKind(makeRow({ entryContracts: 5, anyFeesCaptured: false })), 'not-loaded');
    });

    it('returns "dash" when entryContracts=0', () => {
      assert.equal(eth30RowFeeCellKind(makeRow({ entryContracts: 0 })), 'dash');
    });
  });

  // ── No false positives when feesIncluded=true ─────────────────────────────────

  describe('no false positives when feesIncluded=true with filled tickers', () => {
    it('all warning indicators are absent', () => {
      const report = makeReport(true, { tickersWithFills: 3 });
      assert.equal(eth30HeaderBadgeText(report),          'NET OF FEES', 'badge must be NET OF FEES');
      assert.equal(eth30SummaryPnlLabel(report),          'Net P&L',     'label must be Net P&L');
      assert.ok(!eth30ShowsGrossPnlColumn(report),                        'gross column must not appear');
      assert.ok(!eth30NetPnlHeaderHasAsterisk(report),                    'asterisk must not appear');
      assert.ok(!eth30FeesPaidShowsPartialAnnotation(report),             'partial annotation must not appear');
      assert.equal(eth30FooterNoteKind(report),           'net-formula',  'footer must show net formula');
    });
  });

  // ── All warnings present when feesIncluded=false and fills exist ──────────────

  describe('all warnings present when feesIncluded=false and fills exist', () => {
    it('every warning indicator is active', () => {
      const report = makeReport(false, { tickersWithFills: 2 });
      assert.equal(eth30HeaderBadgeText(report),         'FEES PARTIAL', 'badge must warn FEES PARTIAL');
      assert.equal(eth30SummaryPnlLabel(report),         'Gross P&L',    'label must be Gross P&L');
      assert.ok(eth30ShowsGrossPnlColumn(report),                         'gross column must appear');
      assert.ok(eth30NetPnlHeaderHasAsterisk(report),                     'asterisk must appear on Net P&L header');
      assert.ok(eth30FeesPaidShowsPartialAnnotation(report),              'partial annotation must appear');
      assert.equal(eth30FooterNoteKind(report),          'fee-warning',   'footer must show fee warning');
    });
  });
});
