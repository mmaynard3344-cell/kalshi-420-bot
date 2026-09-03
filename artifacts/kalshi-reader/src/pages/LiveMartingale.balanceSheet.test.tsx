import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Eth420BalanceSheet } from './LiveMartingale';

test('ETH 420 balance sheet uses the current candidate-ledger day instead of a fixed reconciliation date', () => {
  const markup = renderToStaticMarkup(
    <Eth420BalanceSheet
      balance={{ aggregate_balance_cents: 275_050, portfolio_value: 12_500, stale: false }}
      ledgerFreshness="fresh"
      data={{
        state: { easternDate: '2026-09-03', side: 'no', step: 2, realizedPnlCents: 8_740 },
        dailyPnl: {
          available: true,
          rows: [{
            easternDate: '2026-09-03',
            totalOrderCount: 4,
            settledOrderCount: 3,
            winningOrderCount: 2,
            losingOrderCount: 1,
            zeroPnlOrderCount: 0,
            totalBetsCents: 84_000,
            totalFeesCents: 420,
            grossWinningsCents: 12_000,
            grossLossesCents: -3_680,
            netRealizedPnlCents: 8_320,
          }],
        },
      }}
    />,
  );

  assert.match(markup, /Live · Sep 3, 2026/);
  assert.match(markup, /Current Eastern Time day: Sep 3, 2026/);
  assert.match(markup, /\$2,875.50/);
  assert.match(markup, /\+\$83.20/);
  assert.match(markup, /Candidate-ledger totals refresh automatically every 30 seconds/);
  assert.doesNotMatch(markup, /September 1 realized P&amp;L/);
});

test('ETH 420 balance sheet marks a previously successful ledger read stale after its next refresh fails', () => {
  // This is the retained payload after a successful Sep. 3 load followed by a failed refresh.
  const markup = renderToStaticMarkup(
    <Eth420BalanceSheet
      balance={{ aggregate_balance_cents: 275_050, portfolio_value: 0 }}
      ledgerFreshness="stale"
      data={{
        state: { easternDate: '2026-09-03', side: 'yes', step: 0, realizedPnlCents: 1_000 },
        dailyPnl: {
          available: true,
          rows: [{
            easternDate: '2026-09-03', totalOrderCount: 1, settledOrderCount: 1,
            winningOrderCount: 1, losingOrderCount: 0, zeroPnlOrderCount: 0,
            totalBetsCents: 1_500, totalFeesCents: 20, grossWinningsCents: 1_020,
            grossLossesCents: 0, netRealizedPnlCents: 1_000,
          }],
        },
      }}
    />,
  );

  assert.match(markup, /Retained ledger · stale/);
  assert.match(markup, /latest candidate-ledger refresh failed/i);
  assert.doesNotMatch(markup, /Live · Sep 3, 2026/);
  assert.doesNotMatch(markup, /Candidate-ledger totals refresh automatically every 30 seconds/);
});

test('ETH 420 balance sheet scopes figures as archival when the current candidate ledger is unavailable', () => {
  const markup = renderToStaticMarkup(
    <Eth420BalanceSheet
      balance={{ aggregate_balance_cents: 275_050, portfolio_value: 12_500 }}
      ledgerFreshness="fresh"
      data={{
        state: { easternDate: '2026-09-03', side: 'no', step: 2, realizedPnlCents: 8_740 },
        dailyPnl: {
          available: false,
          rows: [{
            easternDate: '2026-09-03', totalOrderCount: 4, settledOrderCount: 3,
            winningOrderCount: 2, losingOrderCount: 1, zeroPnlOrderCount: 0,
            totalBetsCents: 84_000, totalFeesCents: 420, grossWinningsCents: 12_000,
            grossLossesCents: -3_680, netRealizedPnlCents: 8_320,
          }],
        },
      }}
    />,
  );

  assert.match(markup, /Current candidate-ledger data is unavailable/);
  assert.match(markup, /Current ledger unavailable/);
  assert.match(markup, /Historical figures below are archival context, not a current balance sheet/);
  assert.match(markup, /Archival restoration context/);
  assert.match(markup, /Candidate-ledger realized P&amp;L unavailable/);
  assert.doesNotMatch(markup, /Live ·/);
  assert.doesNotMatch(markup, /Current Eastern Time day:/);
  assert.doesNotMatch(markup, /Current-day realized P&amp;L/);
  assert.doesNotMatch(markup, /Live data scope/);
  assert.doesNotMatch(markup, /Sep 3, 2026 realized P&amp;L/);
  assert.doesNotMatch(markup, /\+\$83\.20/);
  assert.doesNotMatch(markup, /\+\$87\.40/);
});