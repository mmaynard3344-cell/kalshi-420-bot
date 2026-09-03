export type RuntimeWatchdogDimension =
  | 'endpoint_failure'
  | 'api_failure'
  | 'ws_disconnect'
  | 'stale_btc_quote'
  | 'stale_eth_quote'
  | 'stale_autotrader'
  | 'overdue_reconciliation'
  | 'protective_exit_disabled'
  | 'daily_profit_unavailable'
  | 'eth420_boundary_evidence_unavailable';

export interface RuntimeWatchdogStatus {
  dimensions: Record<RuntimeWatchdogDimension, {
    state: 'ok' | 'alert';
    since: string | null;
    diagnosticReason: 'storage_unavailable' | 'storage_read_failed' | null;
  }>;
}

/** Shape returned by GET /api/trade/runtime-watchdog. */
export interface RuntimeWatchdogResponse {
  status: RuntimeWatchdogStatus;
}

const WATCHDOG_ALERT_COPY: Record<RuntimeWatchdogDimension, { title: string; detail: string }> = {
  endpoint_failure: { title: 'Runtime watchdog endpoint unavailable', detail: 'The server health monitor cannot reach its local status check.' },
  api_failure: { title: 'Runtime health check failed', detail: 'The server health monitor received an unsuccessful status response.' },
  ws_disconnect: { title: 'Kalshi WebSocket disconnected', detail: 'The server is not currently connected to the Kalshi market stream.' },
  stale_btc_quote: { title: 'BTC quote feed is stale', detail: 'The server has not received a recent usable BTC quote.' },
  stale_eth_quote: { title: 'ETH quote feed is stale', detail: 'The server has not received a recent usable ETH quote.' },
  stale_autotrader: { title: 'AutoTrader feed is stale', detail: 'The server AutoTrader trigger is not receiving live ticks.' },
  overdue_reconciliation: { title: 'Order reconciliation is overdue', detail: 'The server has not completed a recent exchange reconciliation sweep.' },
  protective_exit_disabled: { title: 'Protective-exit monitor disabled', detail: 'The server-side protective-exit monitor is not enabled.' },
  daily_profit_unavailable: { title: 'Daily profit status unavailable', detail: 'The server cannot currently read the daily profit reporting status.' },
  eth420_boundary_evidence_unavailable: { title: 'ETH boundary evidence unavailable', detail: 'The server cannot safely read ETH boundary-evidence storage.' },
};

const ETH_BOUNDARY_EVIDENCE_DIAGNOSTICS = {
  storage_unavailable: 'Boundary-evidence storage is unavailable.',
  storage_read_failed: 'Boundary-evidence storage could not be read.',
} as const;

export interface OperatorHealthAlert {
  dimension: RuntimeWatchdogDimension;
  title: string;
  detail: string;
  since: string | null;
}

/** Converts the authenticated watchdog response into display-safe operator alerts. */
export function getActiveRuntimeWatchdogAlerts(
  response: RuntimeWatchdogResponse | null,
): OperatorHealthAlert[] {
  if (!response) return [];
  return (Object.entries(response.status.dimensions) as Array<[
    RuntimeWatchdogDimension,
    RuntimeWatchdogStatus['dimensions'][RuntimeWatchdogDimension],
  ]>)
    .filter(([, dimension]) => dimension.state === 'alert')
    .map(([dimension, alert]) => ({
      dimension,
      title: WATCHDOG_ALERT_COPY[dimension].title,
      detail: dimension === 'eth420_boundary_evidence_unavailable' && alert.diagnosticReason
        ? ETH_BOUNDARY_EVIDENCE_DIAGNOSTICS[alert.diagnosticReason]
        : WATCHDOG_ALERT_COPY[dimension].detail,
      since: alert.since,
    }));
}