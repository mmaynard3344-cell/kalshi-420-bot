/**
 * Strictly interpret an exchange transfer observation.
 * Never infer completion from local acceptance, elapsed time, or balances.
 * This pure helper does not modify the ledger or contact Kalshi.
 *
 * Exchange response schema must be verified before this is connected to
 * a reconciliation job; unknown values must fail closed.
 */
export function assessTransferReconciliation(
  local: { state: string; exchangeTransferId: string | null },
  observed: { transferId: string; status: string } | null,
): "no_change" | "eligible_to_complete" | "manual_review" {
  if (local.state === "completed" || local.state === "failed") return "no_change";
  if (!observed) return "manual_review";
  if (!local.exchangeTransferId || observed.transferId !== local.exchangeTransferId) return "manual_review";
  if (local.state !== "submitted" && local.state !== "unknown") return "manual_review";
  // These values describe our internal normalized observation contract,
  // not unverified wire-format status strings from Kalshi.
  if (observed.status === "confirmed_completed") return "eligible_to_complete";
  if (observed.status === "pending") return "no_change";
  return "manual_review";
}
