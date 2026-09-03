/**
 * Dashboard market-data-coverage panel derivation tests.
 *
 * Proves the panel:
 *  - shows an explicit UNKNOWN state when telemetry cannot be read (never
 *    implies a healthy window),
 *  - escalates to critical on a live gap or unresolved incident,
 *  - keeps unrecovered closed windows visible as warnings,
 *  - stays quiet when everything is healthy,
 *  - and is derivation-only: it produces no fields that could be mistaken
 *    for (or feed) the browser's trade alerts.
 *
 * Run via the api-server harness:
 *   cd artifacts/api-server && node_modules/.bin/esbuild \
 *     ../kalshi-reader/src/pages/Dashboard.coveragePanel.test.ts \
 *     --bundle --platform=node --format=esm --outfile=/tmp/coverage-panel.mjs && \
 *   node --test /tmp/coverage-panel.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCoveragePanelState,
  describeRecovery,
  type CoverageApiResponse,
  type CoverageIncidentDto,
  type CoverageTickerStatusDto,
} from '../lib/coveragePanel';

function makeStatus(overrides: Partial<CoverageTickerStatusDto> = {}): CoverageTickerStatusDto {
  return {
    ticker: 'KXETH15M-26AUG151200-00',
    series: 'KXETH15M',
    closeTime: new Date().toISOString(),
    secondsLeft: 90,
    state: 'healthy',
    lastUsableQuoteAgeMs: 3_000,
    finalWindowUsableQuotes: 5,
    finalWindowEvaluations: 5,
    wsConnected: true,
    incident: null,
    ...overrides,
  };
}

function makeIncident(overrides: Partial<CoverageIncidentDto> = {}): CoverageIncidentDto {
  return {
    incidentId: 'KXETH15M-26AUG151200-00@2026-08-15T12:00:00Z',
    ticker: 'KXETH15M-26AUG151200-00',
    series: 'KXETH15M',
    closeTime: '2026-08-15T12:00:00Z',
    detectedAtMs: Date.now() - 60_000,
    secondsLeftAtDetect: 95,
    wsConnected: true,
    recoveryAttempts: [{ attemptedAtMs: Date.now() - 55_000, outcome: 'resubscribed_on_open_connection' }],
    status: 'unresolved',
    recoveredAtMs: null,
    ...overrides,
  };
}

describe('coverage panel derivation', () => {
  it('fetch failure → explicit UNKNOWN, never implies healthy', () => {
    const panel = deriveCoveragePanelState(null);
    assert.equal(panel.severity, 'unknown');
    assert.match(panel.headline!, /UNKNOWN/);
    assert.match(panel.headline!, /not confirmed healthy/);
  });

  it('telemetryState degraded → UNKNOWN even with empty lists', () => {
    const panel = deriveCoveragePanelState({ telemetryState: 'degraded', status: [], incidents: [] });
    assert.equal(panel.severity, 'unknown');
    assert.ok(panel.headline);
  });

  it('live gap → critical with the affected ticker in the headline', () => {
    const gap = makeStatus({ state: 'gap', lastUsableQuoteAgeMs: 45_000 });
    const panel = deriveCoveragePanelState({ telemetryState: 'ok', status: [gap], incidents: [] });
    assert.equal(panel.severity, 'critical');
    assert.ok(panel.headline!.includes(gap.ticker));
    assert.equal(panel.activeGaps.length, 1);
  });

  it('unresolved incident → critical even when no live status row shows a gap', () => {
    const panel = deriveCoveragePanelState({
      telemetryState: 'ok',
      status: [makeStatus()],
      incidents: [makeIncident({ status: 'unresolved' })],
    });
    assert.equal(panel.severity, 'critical');
  });

  it('unrecovered closed window stays visible as a warning', () => {
    const panel = deriveCoveragePanelState({
      telemetryState: 'ok',
      status: [makeStatus()],
      incidents: [makeIncident({ status: 'unrecovered_window_closed' })],
    });
    assert.equal(panel.severity, 'warning');
    assert.match(panel.headline!, /unrecovered market-data gap/);
  });

  it('all healthy with only recovered incidents → ok, no headline', () => {
    const panel = deriveCoveragePanelState({
      telemetryState: 'ok',
      status: [makeStatus(), makeStatus({ ticker: 'KXBTC15M-X', series: 'KXBTC15M' })],
      incidents: [makeIncident({ status: 'recovered', recoveredAtMs: Date.now() })],
    });
    assert.equal(panel.severity, 'ok');
    assert.equal(panel.headline, null);
  });

  it('incidents sorted: unresolved first, then unrecovered, then recovered', () => {
    const rec = makeIncident({ incidentId: 'r', status: 'recovered', detectedAtMs: 3_000 });
    const unrec = makeIncident({ incidentId: 'u', status: 'unrecovered_window_closed', detectedAtMs: 2_000 });
    const open = makeIncident({ incidentId: 'o', status: 'unresolved', detectedAtMs: 1_000 });
    const panel = deriveCoveragePanelState({
      telemetryState: 'ok', status: [], incidents: [rec, unrec, open],
    });
    assert.deepEqual(panel.incidents.map((i) => i.incidentId), ['o', 'u', 'r']);
  });

  it('describeRecovery reports attempt count and last outcome', () => {
    assert.equal(describeRecovery(makeIncident({ recoveryAttempts: [] })), 'no recovery attempted');
    const two = makeIncident({
      recoveryAttempts: [
        { attemptedAtMs: 1, outcome: 'resubscribed_on_open_connection' },
        { attemptedAtMs: 2, outcome: 'reconnect_initiated' },
      ],
    });
    assert.equal(describeRecovery(two), '2 recovery attempts — last: reconnect_initiated');
  });

  it('panel output carries no trade-alert fields (must not feed fireAlert)', () => {
    const panel = deriveCoveragePanelState({
      telemetryState: 'ok', status: [makeStatus({ state: 'gap' })], incidents: [makeIncident()],
    });
    // AlertEntry fields that must never appear on the panel state itself.
    for (const banned of ['price', 'side', 'asset', 'eventTicker']) {
      assert.ok(!(banned in panel), `panel state must not carry alert field "${banned}"`);
    }
  });
});
