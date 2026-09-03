import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizePnlCoverage } from './portfolioPnl.js';

describe('portfolio P&L coverage', () => {
  it('retains a confirmed NO-side win while another fill is awaiting settlement', () => {
    const coverage = summarizePnlCoverage([
      {
        side: 'no',
        yes_price_dollars: '0.0700',
        no_price_dollars: '0.9300',
        count_fp: '96.41',
        fee_cost: '0.4710',
        market_result: 'no',
      },
      {
        side: 'yes',
        yes_price_dollars: '0.9000',
        no_price_dollars: '0.1000',
        count_fp: '4.00',
        fee_cost: '0.0100',
        market_result: '',
      },
    ]);

    assert.equal(coverage.settledFillCount, 1);
    assert.equal(coverage.pendingSettlementCount, 1);
    assert.ok(coverage.realizedPnl !== null);
    assert.ok(Math.abs(coverage.realizedPnl - 6.2777) < 0.000001);
  });

  it('reports no P&L rather than a false zero before any fill settles', () => {
    const coverage = summarizePnlCoverage([{
      side: 'yes',
      yes_price_dollars: '0.9000',
      no_price_dollars: '0.1000',
      count_fp: '4.00',
      fee_cost: '0.0100',
      market_result: '',
    }]);

    assert.equal(coverage.realizedPnl, null);
    assert.equal(coverage.settledFillCount, 0);
    assert.equal(coverage.pendingSettlementCount, 1);
  });
});