import type { EthBigBetExecutionStore } from "./ethBigBetExecutor.js";
import {
  acknowledgeEthBigBetSubmission,
  listUnresolvedEthBigBetOrderIds,
  markEthBigBetRejected,
  markEthBigBetSubmissionUnknown,
  reserveEthBigBetIntent,
} from "./ethBigBetStore.js";
import { ethBigBetContracts, ethBigBetOrderId } from "./ethBigBetLifecycle.js";

/** Production adapter between the generic stateless B/C executor and the
 * dedicated eth_big_bet_orders ledger. It performs no martingale reads/writes. */
export const ethBigBetExecutionStore: EthBigBetExecutionStore = {
  listUnresolvedEthBigBetOrderIds,

  async reserveEthBigBetOrder(input) {
    if (input.orderId !== ethBigBetOrderId(input.intent)) return false;
    if (input.requestedContracts !== ethBigBetContracts(input.intent.wagerCents, input.intent.limitPriceCents)) return false;
    return reserveEthBigBetIntent(input.intent);
  },

  async acknowledgeEthBigBetOrder(input) {
    if (input.status === "submitted") {
      return input.exchangeOrderId != null
        ? acknowledgeEthBigBetSubmission({ id: input.orderId, kalshiOrderId: input.exchangeOrderId })
        : false;
    }
    if (input.status === "submission_unknown") {
      return input.exchangeOrderId == null
        ? markEthBigBetSubmissionUnknown(input.orderId)
        : false;
    }
    return input.exchangeOrderId == null
      ? markEthBigBetRejected(input.orderId)
      : false;
  },
};
