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
  entry: { strategy: string; entryId: string; ticker: string; heldSide: "yes" | "no"; bidCents: number; contracts: number }): Target75ExecutionAdapter {
  return {
    reserveOnce: (key, quantity) => {
      if (quantity !== entry.contracts) return Promise.resolve(false);
      return reserveExit(db, {
        key, strategy: entry.strategy, entryId: entry.entryId,
        ticker: entry.ticker, side: entry.heldSide,
        quantity, bidCents: entry.bidCents,
      });
    },
    markPostStarted: (key) => fenceExitPost(db, key),
    async submitIocSell(input) {
      if (input.ticker !== entry.ticker || input.heldSide !== entry.heldSide ||
          input.contracts !== entry.contracts || input.minPriceCents !== entry.bidCents)
        throw new Error("exit_order_identity_changed");
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
