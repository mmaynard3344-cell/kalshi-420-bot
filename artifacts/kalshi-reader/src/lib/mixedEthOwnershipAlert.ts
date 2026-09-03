/**
 * Shared view model for the mixed ETH strategy-ownership safety alert.
 *
 * Keeping the operator-facing copy and ticker/evidence selection here lets the
 * dashboard use one contract for the status response and gives the regression
 * test a deterministic, DOM-free way to verify the live safety path.
 */

export const PROTECTIVE_EXIT_EVIDENCE_SECTION_ID = 'protective-exits';

export const MIXED_ETH_OWNERSHIP_ALERT = {
  title: 'MANUAL ACTION REQUIRED — MIXED ETH OWNERSHIP',
  explanation: 'Automatic legacy exits are intentionally withheld because Kalshi reports one net position for contracts also owned by the ETH martingale. Withholding the exit protects martingale contracts from being reduced by the legacy strategy.',
  selectionHint: 'Select a ticker to view its durable protective-exit evidence below.',
} as const;

export interface ProtectiveExitMonitorStatus {
  mixedEthStrategyOwnershipTickers: string[];
}

export interface ProtectiveExitEvidence {
  ticker: string;
}

export function getMixedEthOwnershipAlert(
  status: ProtectiveExitMonitorStatus | null | undefined,
) {
  const tickers = status?.mixedEthStrategyOwnershipTickers ?? [];
  return tickers.length > 0 ? { ...MIXED_ETH_OWNERSHIP_ALERT, tickers } : null;
}

export function filterProtectiveExitEvidence<T extends ProtectiveExitEvidence>(
  evidence: readonly T[],
  selectedTicker: string | null,
): T[] {
  return selectedTicker ? evidence.filter((entry) => entry.ticker === selectedTicker) : [...evidence];
}