export interface MartingaleStatus {
  trading_halted?: boolean;
  environment_lock?: boolean;
  eth_order_submission_permitted?: boolean;
  eth_order_submission_reason?: string;
  eth_martingale_blocker?: {
    code?: string;
    message?: string;
    retryScheduled?: boolean;
    retryAttempt?: number;
    ticker?: string | null;
    exchangeIndex?: number | null;
    availableBalanceCents?: number | null;
    requiredBalanceCents?: number | null;
    balanceStale?: boolean;
  };
}

/**
 * ACTIVE is reserved for an explicit, authenticated server confirmation. This
 * keeps a missing or partially rolled-out status response fail-closed in the UI.
 */
export function isMartingaleEntryExplicitlyPermitted(
  status: MartingaleStatus | undefined,
): boolean {
  return status?.trading_halted === false
    && status.environment_lock === false
    && status.eth_order_submission_permitted === true
    && status.eth_order_submission_reason === "permitted";
}