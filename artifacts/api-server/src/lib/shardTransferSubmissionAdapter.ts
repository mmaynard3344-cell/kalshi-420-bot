import type { ShardTransferRequest } from "./shardTransferSafety.js";
import type { ShardTransferDependencies } from "./shardTransferOrchestrator.js";
import { buildShardTransferPayload } from "./shardTransferPayload.js";
import { parseShardTransferCreationResponse } from "./shardTransferApiContract.js";
import {
  reserveShardTransfer,
  claimShardTransfer,
  recordShardTransferAcceptance,
  markShardTransferUnknown,
} from "./shardTransferLedgerRepository.js";

/**
 * Transfer dependency adapter for an operator-only route.
 *
 * The exchange POST is deliberately injected, not imported from the trading
 * client. Importing or creating this adapter NEVER submits funds. It must
 * remain unused by production routes until independently reviewed and enabled.
 */
export function makeShardTransferDependencies(
  ports: {
    uncachedAvailableBalanceCents: (shard: 0 | 2) => Promise<number>;
    submitTransferOnce: (payload: ReturnType<typeof buildShardTransferPayload>) => Promise<unknown>;
  },
): ShardTransferDependencies {
  return {
    reserve: reserveShardTransfer,
    claim: claimShardTransfer,
    freshAvailableCents: ports.uncachedAvailableBalanceCents,
    submitOnce: async (request: ShardTransferRequest) => {
      const response = await ports.submitTransferOnce(buildShardTransferPayload(request));
      return { transferId: parseShardTransferCreationResponse(response) };
    },
    accepted: recordShardTransferAcceptance,
    unknown: markShardTransferUnknown,
  };
}
