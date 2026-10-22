/**
 * Parse Kalshi GET /portfolio/intra_exchange_instance_transfers/{transfer_id}.
 * Only "pending" is confirmed by the published example. Unknown statuses do
 * not imply completion; the separate settlement criteria require verification.
 */
export function inspectKalshiTransferObservation(raw: unknown, expectedTransferId: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "manual_review" as const };
  const transfer = (raw as Record<string, unknown>).transfer;
  if (!transfer || typeof transfer !== "object" || Array.isArray(transfer))
    return { status: "manual_review" as const };
  const value = transfer as Record<string, unknown>;
  if (value.transfer_id !== expectedTransferId)
    return { status: "manual_review" as const };
  if (value.status === "pending")
    return { status: "pending" as const };
  return { status: "manual_review" as const };
}
