/**
 * Pure state transition rules for manual fund transfers.
 * Persistence must be implemented separately before live submission is enabled.
 * An uncertain result is never automatically retried.
 */
export type ShardTransferState =
  | "reserved"
  | "submitting"
  | "submitted"
  | "completed"
  | "failed"
  | "unknown";
export type ShardTransferRecord = {
  requestId: string;
  state: ShardTransferState;
  exchangeTransferId: string | null;
};
export function maySubmitTransfer(record: ShardTransferRecord | null): boolean {
  return record === null;
}
export function updateTransferState(
  current: ShardTransferRecord,
  next: ShardTransferState,
  exchangeTransferId: string | null = current.exchangeTransferId,
): ShardTransferRecord {
  const allowed: Record<ShardTransferState, readonly ShardTransferState[]> = {
    reserved: ["submitting", "failed"],
    submitting: ["submitted", "unknown", "failed"],
    submitted: ["completed", "failed", "unknown"],
    unknown: ["submitted", "completed", "failed"],
    completed: [],
    failed: [],
  };
  if (!allowed[current.state].includes(next)) {
    throw new Error(`Invalid transfer state transition: ${current.state} to ${next}`);
  }
  if (next === "submitted" && !exchangeTransferId) {
    throw new Error("A Kalshi transfer ID is required to mark a transfer submitted");
  }
  return { ...current, state: next, exchangeTransferId };
}
