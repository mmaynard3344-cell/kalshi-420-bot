import { buildTarget75IocPayload, type Target75ExecutionAdapter } from "./tMinusSevenExit.js";
import { reserveExit, fenceExitPost, linkExitProviderOrder, type ExitDb } from "./target75ExitStore.js";

/**
 * Exchange boundary for the ETH-wide 75c exit.
 * The strategy-specific caller must still verify ownership, cancel/reconcile
 * entry GTCs, supply orderbook depth and costs, and account for early settlement.
 */
export type Target75Exchange = {
  postOrder(payload: ReturnType<typeof buildTarget75IocPayload>):
    Promise<{ providerOrderId: string | null; state: "filled" | "partial" | "unfilled" | "unknown" }>;
};

export function makeTarget75Adapter(db: ExitDb, exchange: Target75Exchange,
  entry: { strategy: string; entryId: string }): Target75ExecutionAdapter {
  return {
    reserveOnce: (key, quantity) => {
      // The target decision's bid/side/ticker are not provided to reserveOnce.
      // Fail closed; do not invent a reserve from incomplete input.
      void key; void quantity; return Promise.resolve(false);
    },
    markPostStarted: (key) => fenceExitPost(db, key),
    async submitIocSell(input) {
      const payload = buildTarget75IocPayload({
        ticker: input.ticker, decisionKey: input.decisionKey,
        heldSide: input.heldSide, contracts: input.contracts,
        minPriceCents: input.minPriceCents,
      });
      const result = await exchange.postOrder(payload);
      if (result.providerOrderId &&
          !await linkExitProviderOrder(db, input.decisionKey, result.providerOrderId))
        return { status: "unknown", orderId: null };
      return { status: result.state, orderId: result.providerOrderId };
    },
    async recordResult(_key, result) {
      // Acknowledgement is not a verified fill. The order reconciliation
      // worker must authenticate and record every fill by provider fill ID.
      return result.status === "unfilled" || !!result.orderId;
    },
  };
}

/** Explicit reserve operation requiring all immutable exit coordinates. */
export async function reserveVerifiedTarget75Position(db: ExitDb, input: {
  key: string; strategy: string; entryId: string; ticker: string;
  side: "yes" | "no"; contracts: number; bidCents: number;
}): Promise<boolean> {
  return reserveExit(db, {
    key: input.key, strategy: input.strategy, entryId: input.entryId,
    ticker: input.ticker, side: input.side,
    quantity: input.contracts, bidCents: input.bidCents,
  });
}
