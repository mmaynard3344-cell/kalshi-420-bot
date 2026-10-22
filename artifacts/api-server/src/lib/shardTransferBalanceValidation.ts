/** Pure fail-closed validation: no Kalshi client or logger initialization. */
export function requireFreshShardBalanceCents(read: {value: Record<string,unknown>;stale:boolean}): number {
  if (read.stale) throw new Error("Transfer blocked: exchange balance is stale");
  const cents = read.value["balance"];
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0)
    throw new Error("Transfer blocked: fresh shard balance unavailable");
  return cents;
}
