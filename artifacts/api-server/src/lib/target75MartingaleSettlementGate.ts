/**
 * Fail-closed guard for settling an ETH martingale claim when a position
 * might have been sold before market resolution.
 *
 * Callers must obtain the fill count from authenticated Kalshi order/fill
 * evidence and the exited-contract count from the durable 75c journal.
 * Never finalize a binary WIN/LOSS for contracts already sold.
 */
export function decideEthBinarySettlementWithEarlyExits(input: {
  authenticatedEntryFills: number;
  authenticatedEarlyExitFills: number | null;
  journalReadConfirmed: boolean;
  unresolvedExitAttempt: boolean;
}): { action: "normal_binary_settlement"; contracts: number } |
    { action: "defer"; reason: string } {
  const {authenticatedEntryFills: entered, authenticatedEarlyExitFills: exited} = input;
  if (!input.journalReadConfirmed || exited === null ||
      !Number.isSafeInteger(entered) || entered < 0 ||
      !Number.isSafeInteger(exited) || exited < 0 || exited > entered)
    return {action:"defer",reason:"unverified_entry_or_exit_quantity"};
  if (input.unresolvedExitAttempt)
    return {action:"defer",reason:"exit_order_not_reconciled"};
  if (exited > 0)
    return {action:"defer",reason:"early_exited_position_requires_allocation"};
  return {action:"normal_binary_settlement",contracts:entered};
}
