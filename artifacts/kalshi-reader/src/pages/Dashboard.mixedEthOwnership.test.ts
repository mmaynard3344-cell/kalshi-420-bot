/**
 * Regression coverage for the mixed ETH ownership alert.
 *
 * The dashboard receives this status from
 * /api/trade/analytics/protective-exit-status. A live ticker must render a
 * manual-action explanation, and selecting it must focus the durable
 * protective-exit evidence filtered to that ticker.
 *
 * Run via the api-server esbuild harness:
 *   cd artifacts/api-server && \
 *   node scripts/run-dashboard-mixed-eth-ownership-test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterProtectiveExitEvidence,
  getMixedEthOwnershipAlert,
  PROTECTIVE_EXIT_EVIDENCE_SECTION_ID,
  type ProtectiveExitMonitorStatus,
} from '../lib/mixedEthOwnershipAlert.js';

const MIXED_TICKER = 'KXETH15M-26AUG231200-00';

const monitorStatusFixture: ProtectiveExitMonitorStatus = {
  mixedEthStrategyOwnershipTickers: [MIXED_TICKER],
};

const durableEvidence = [
  { id: 'mixed-evidence', ticker: MIXED_TICKER, outcome: 'mixed_eth_strategy_ownership' },
  { id: 'other-evidence', ticker: 'KXETH15M-26AUG231215-00', outcome: 'full_fill' },
] as const;

describe('mixed ETH ownership dashboard alert', () => {
  it('renders the manual-action alert and martingale-protection explanation from an active status fixture', () => {
    const alert = getMixedEthOwnershipAlert(monitorStatusFixture);

    assert.ok(alert, 'an active mixed-ownership ticker must produce a visible dashboard alert');
    assert.equal(alert.title, 'MANUAL ACTION REQUIRED — MIXED ETH OWNERSHIP');
    assert.match(alert.explanation, /legacy exits are intentionally withheld/);
    assert.match(alert.explanation, /ETH martingale/);
    assert.match(alert.explanation, /protects martingale contracts/);
    assert.deepEqual(alert.tickers, [MIXED_TICKER]);
  });

  it('selects the ticker, targets the protective-exit audit section, and shows only matching durable evidence', () => {
    const alert = getMixedEthOwnershipAlert(monitorStatusFixture);
    assert.ok(alert);

    // This mirrors the alert button's onViewEvidence(ticker) callback.
    const selectedTicker = alert.tickers[0];
    assert.equal(PROTECTIVE_EXIT_EVIDENCE_SECTION_ID, 'protective-exits');

    const filteredEvidence = filterProtectiveExitEvidence(durableEvidence, selectedTicker);
    assert.deepEqual(filteredEvidence, [durableEvidence[0]]);
    assert.equal(filteredEvidence[0]?.outcome, 'mixed_eth_strategy_ownership');
  });
});