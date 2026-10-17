import { singleTransferLookupPath } from "./shardTransferApiContract.js";
import { inspectKalshiTransferObservation } from "./shardTransferExchangeObservation.js";
import { assessTransferReconciliation } from "./shardTransferReconciliation.js";

/** Read-only reconciliation; no local state writes and no transfer submission. */
export async function checkShardTransferReadOnly(
  local: { state: string; exchangeTransferId: string | null },
  readTransfer: (path: string) => Promise<unknown>,
): Promise<"no_change" | "manual_review" | "eligible_to_complete"> {
  if (!local.exchangeTransferId) return "manual_review";
  if (local.state !== "submitted" && local.state !== "unknown") return "no_change";
  let raw: unknown;
  try {
    raw = await readTransfer(singleTransferLookupPath(local.exchangeTransferId));
  } catch {
    return "manual_review";
  }
  const observed = inspectKalshiTransferObservation(raw, local.exchangeTransferId);
  if (observed.status === "manual_review") return "manual_review";
  return assessTransferReconciliation(local, {
    transferId: local.exchangeTransferId,
    status: observed.status,
  });
}
