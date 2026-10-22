import { fetchFreshKalshiBalanceForExchangeRead } from "./kalshiBalance.js";
import { requireFreshShardBalanceCents } from "./shardTransferBalanceValidation.js";

/** Only performs an uncached, exchange-index-scoped GET; never submits funds. */
export async function getFreshShardTransferBalanceCents(shard: 0 | 2): Promise<number> {
  return requireFreshShardBalanceCents(await fetchFreshKalshiBalanceForExchangeRead(shard));
}
