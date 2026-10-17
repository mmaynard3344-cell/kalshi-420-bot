/** Read-only transfer status. Never infer settlement from an accepted POST. */
export function describeShardTransferStatus(raw: Record<string, unknown>) {
  const state = raw["state"];
  if (typeof state !== "string" || !["reserved","submitting","submitted","completed","failed","unknown"].includes(state)) {
    throw new Error("Unrecognized transfer state");
  }
  const transferId = typeof raw["exchange_transfer_id"] === "string" ? raw["exchange_transfer_id"] : null;
  return {
    state,
    transferId,
    fundsArrived: state === "completed",
    requiresReconciliation: state === "unknown",
    message: state === "completed" ? "Exchange completion recorded"
      : state === "submitted" ? "Accepted by exchange; completion not yet verified"
      : state === "unknown" ? "Submission outcome uncertain; operator reconciliation required"
      : state === "failed" ? "Reconciled as failed"
      : "Not confirmed by exchange",
  };
}
