import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Eth420DailyTransactionLog } from './LiveMartingale';

test('Daily Transaction Log renders a newly refreshed ETH 420 order after the previous presentation cutoff', () => {
  const markup = renderToStaticMarkup(
    <Eth420DailyTransactionLog
      data={{
        ordersAvailability: { available: true },
        // This is the normal candidate-history response after its next refresh.
        // The newest order is intentionally after the former Sep. 1 cutoff.
        orders: [
          {
            id: 'settled-before-cutoff',
            ticker: 'KXETH15M-26SEP010000-15',
            side: 'no',
            step: 1,
            requestedContracts: 30,
            effectiveWagerCents: 1500,
            filledContracts: 30,
            realizedPnlDeltaCents: 300,
            status: 'settled',
            settlementResult: 'no',
            createdAtMs: Date.parse('2026-09-01T03:55:00Z'),
          },
          {
            id: 'new-unfilled-order',
            ticker: 'KXETH15M-26SEP021215-15',
            side: 'yes',
            step: 2,
            requestedContracts: 84,
            effectiveWagerCents: 42000,
            filledContracts: null,
            realizedPnlDeltaCents: null,
            status: 'submitted',
            settlementResult: null,
            createdAtMs: Date.parse('2026-09-02T16:01:00Z'),
          },
        ],
      }}
    />,
  );

  assert.match(markup, /Daily transaction log/);
  assert.match(markup, /2 records shown/);
  assert.match(markup, /KXETH15M-26SEP021215-15/);
  assert.match(markup, /84 \/ —/);
  assert.match(markup, /submitted/);
  assert.match(markup, /Pending/);
});