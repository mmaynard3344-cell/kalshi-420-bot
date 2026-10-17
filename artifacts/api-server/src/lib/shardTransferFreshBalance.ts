import { fetchFreshKalshiBalanceForExchangeRead, kalshiBalanceCents } from "./kalshiBalance.js";

/** No cached/stale/aggregate balance may authorize a manual transfer. */
export function requireFreshShardBalanceCents(read: { value: Record<string, unknown>; stale: boolean }): number {
  if (read.stale) throw new Error("Transfer blocked: exchange balance is stale");
  const cents = kalshiBalanceCents(read.value);
  if (cents === null) throw new Error("Transfer blocked: fresh shard balance unavailable");
  return cents;
}

/** Only performs an uncached, exchange-index-scoped GET; never submits funds. */
export async function getFreshShardTransferBalanceCents(shard: 0 | 2): Promise<number> {
  return requireFreshShardBalanceCents(await fetchFreshKalshiBalanceForExchangeRead(shard));
}
