/**
 * Pure derivation logic for the Market Data Coverage panel.
 *
 * Separated from Dashboard.tsx so the panel's alerting rules are unit-testable
 * without a DOM. This panel is observability-only — it must never alter the
 * browser's trade alerts (fireAlert / AlertEntry stay untouched).
 */

export interface CoverageRecoveryAttempt {
  attemptedAtMs: number;
  outcome:       string;
}

export interface CoverageIncidentDto {
  incidentId:          string;
  ticker:              string;
  series:              string;
  closeTime:           string;
  detectedAtMs:        number;
  secondsLeftAtDetect: number;
  wsConnected:         boolean;
  recoveryAttempts:    CoverageRecoveryAttempt[];
  status:              'unresolved' | 'recovered' | 'unrecovered_window_closed';
  recoveredAtMs:       number | null;
}

export interface CoverageTickerStatusDto {
  ticker:                  string;
  series:                  string;
  closeTime:               string;
  secondsLeft:             number;
  state:                   'pre_window' | 'healthy' | 'gap' | 'closed';
  lastUsableQuoteAgeMs:    number | null;
  finalWindowUsableQuotes: number;
  finalWindowEvaluations:  number;
  wsConnected:             boolean;
  incident:                CoverageIncidentDto | null;
}

export interface CoverageWindowAuditDto {
  auditId: string;
  ticker: string;
  closeTime: string;
  finalWindowClosedAtMs: number | null;
  finalWindowUsableQuotes: number;
  finalWindowEvaluations: number;
  status: 'OBSERVING' | 'HEALTHY' | 'DEGRADED_RECOVERED' | 'DEGRADED_UNRECOVERED';
  recoveryAttempts: CoverageRecoveryAttempt[];
  evidenceCompleteness?: 'complete' | 'restart_continuity_unknown';
  restartEvidenceUncertain?: boolean;
}

export interface CoverageApiResponse {
  telemetryState: 'ok' | 'degraded';
  source?: 'sql' | 'file_fallback';
  retentionDays?: number;
  evidenceCompleteness?: 'complete' | 'restart_continuity_unknown';
  status:         CoverageTickerStatusDto[];
  incidents:      CoverageIncidentDto[];
  audits?:        CoverageWindowAuditDto[];
}

export interface CoveragePanelState {
  /** Overall severity for panel styling. */
  severity: 'ok' | 'warning' | 'critical' | 'unknown';
  /** Prominent one-line headline; null when there is nothing to surface. */
  headline: string | null;
  /** Live tickers currently showing a data gap. */
  activeGaps: CoverageTickerStatusDto[];
  /** Recent incidents, newest first (unresolved/unrecovered before recovered). */
  incidents: CoverageIncidentDto[];
  audits: CoverageWindowAuditDto[];
}

/** Human label for an incident's recovery outcome. */
export function describeRecovery(incident: CoverageIncidentDto): string {
  if (incident.recoveryAttempts.length === 0) return 'no recovery attempted';
  const last = incident.recoveryAttempts[incident.recoveryAttempts.length - 1];
  return `${incident.recoveryAttempts.length} recovery attempt${incident.recoveryAttempts.length === 1 ? '' : 's'} — last: ${last.outcome}`;
}

/**
 * Derive the panel state from the API response (or a fetch failure).
 *
 * Rules:
 *  - fetch failed or telemetryState=degraded → severity "unknown" with an
 *    explicit headline (never imply the window was healthy).
 *  - any live ticker in "gap" OR any unresolved incident → "critical".
 *  - any unrecovered_window_closed incident in the response → "warning"
 *    (the window is gone but the gap must stay visible).
 *  - otherwise "ok" with no headline (panel can collapse).
 */
export function deriveCoveragePanelState(
  response: CoverageApiResponse | null,
): CoveragePanelState {
  if (response === null || response.telemetryState !== 'ok') {
    return {
      severity: 'unknown',
      headline: 'Market-data coverage telemetry unavailable — window health is UNKNOWN, not confirmed healthy',
      activeGaps: [],
      incidents: response?.incidents ?? [],
      audits: response?.audits ?? [],
    };
  }

  const activeGaps = response.status.filter((s) => s.state === 'gap');
  const rank = (i: CoverageIncidentDto) =>
    i.status === 'unresolved' ? 0 : i.status === 'unrecovered_window_closed' ? 1 : 2;
  const incidents = [...response.incidents].sort(
    (a, b) => rank(a) - rank(b) || b.detectedAtMs - a.detectedAtMs,
  );

  const unresolved  = incidents.filter((i) => i.status === 'unresolved');
  const unrecovered = incidents.filter((i) => i.status === 'unrecovered_window_closed');

  if (activeGaps.length > 0 || unresolved.length > 0) {
    const t = activeGaps[0]?.ticker ?? unresolved[0]?.ticker;
    return {
      severity: 'critical',
      headline: `LIVE DATA GAP: no usable quote for ${t} during the final window`,
      activeGaps,
      incidents,
      audits: response.audits ?? [],
    };
  }

  if (unrecovered.length > 0) {
    return {
      severity: 'warning',
      headline: `${unrecovered.length} window${unrecovered.length === 1 ? '' : 's'} closed with an unrecovered market-data gap`,
      activeGaps,
      incidents,
      audits: response.audits ?? [],
    };
  }

  return { severity: 'ok', headline: null, activeGaps, incidents, audits: response.audits ?? [] };
}
