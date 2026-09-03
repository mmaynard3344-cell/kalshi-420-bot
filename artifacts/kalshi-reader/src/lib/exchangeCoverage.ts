export interface ExchangeCoverage {
  complete?: boolean | null;
  truncated?: boolean;
}

export interface PnlVerificationStatus {
  exchange_reconciliation_complete?: boolean;
  exchange_history_coverage?: ExchangeCoverage;
}

/**
 * Bot P&L is verified only when both independent exchange checks have
 * completed. A bounded coverage scan that stopped at a cursor is not proof.
 */
export function isBotPnlVerifiedToday(status: PnlVerificationStatus | null | undefined): boolean {
  return status?.exchange_reconciliation_complete === true
    && status.exchange_history_coverage?.complete === true
    && status.exchange_history_coverage?.truncated !== true;
}