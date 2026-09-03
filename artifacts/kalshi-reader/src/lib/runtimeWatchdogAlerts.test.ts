import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getActiveRuntimeWatchdogAlerts,
  type RuntimeWatchdogResponse,
  type RuntimeWatchdogDimension,
} from './runtimeWatchdogAlerts';

function healthyResponse(): RuntimeWatchdogResponse {
  const dimensions = {} as RuntimeWatchdogResponse['status']['dimensions'];
  const names: RuntimeWatchdogDimension[] = [
    'endpoint_failure', 'api_failure', 'ws_disconnect', 'stale_btc_quote',
    'stale_eth_quote', 'stale_autotrader', 'overdue_reconciliation',
    'protective_exit_disabled', 'daily_profit_unavailable',
    'eth420_boundary_evidence_unavailable',
  ];
  for (const name of names) {
    dimensions[name] = { state: 'ok', since: null, diagnosticReason: null };
  }
  return { status: { dimensions } };
}

describe('runtime watchdog dashboard alerts', () => {
  it('reads dimensions from the endpoint status envelope and exposes the ETH alert title', () => {
    const response = healthyResponse();
    response.status.dimensions.eth420_boundary_evidence_unavailable = {
      state: 'alert',
      since: '2026-09-01T08:00:00.000Z',
      diagnosticReason: 'storage_read_failed',
    };

    assert.deepEqual(getActiveRuntimeWatchdogAlerts(response), [{
      dimension: 'eth420_boundary_evidence_unavailable',
      title: 'ETH boundary evidence unavailable',
      detail: 'Boundary-evidence storage could not be read.',
      since: '2026-09-01T08:00:00.000Z',
    }]);
  });

  it('removes the alert after a healthy watchdog response', () => {
    assert.deepEqual(getActiveRuntimeWatchdogAlerts(healthyResponse()), []);
  });
});