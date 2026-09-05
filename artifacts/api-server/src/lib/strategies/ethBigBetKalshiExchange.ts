import { kalshiAuthFetch } from "../kalshiAuth.js";
import { parseKalshiOrderResponse } from "../orderResponseParser.js";
import type { EthBigBetExchangeSubmitter, EthBigBetSubmitResult } from "./ethBigBetExecutor.js";

type AuthFetch = typeof kalshiAuthFetch;
let authFetch: AuthFetch = kalshiAuthFetch;

export function _setEthBigBetAuthFetchForTesting(fetcher: AuthFetch | null): void {
  authFetch = fetcher ?? kalshiAuthFetch;
}

/**
 * Dedicated B/C exchange adapter. A missing/ambiguous response never becomes a
 * rejection; it remains unknown so durable recovery can prove identity later.
 */
export function createEthBigBetKalshiSubmitter(exchangeIndex: number): EthBigBetExchangeSubmitter | null {
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) return null;
  return {
    async submit(input): Promise<EthBigBetSubmitResult> {
      try {
        const raw = await authFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", {
          ticker: input.ticker,
          client_order_id: input.clientOrderId,
          side: input.side === "yes" ? "bid" : "ask",
          count: `${input.contracts}.00`,
          price: (input.limitPriceCents / 100).toFixed(4),
          time_in_force: "good_till_canceled",
          self_trade_prevention_type: "taker_at_cross",
          exchange_index: exchangeIndex,
        });
        const wire = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
        const parsed = parseKalshiOrderResponse(raw, input.contracts);
        if (!parsed.kalshiOrderId
          || wire["client_order_id"] !== input.clientOrderId
          || wire["ticker"] !== input.ticker) {
          return { kind: "unknown" };
        }
        return { kind: "accepted", exchangeOrderId: parsed.kalshiOrderId };
      } catch {
        return { kind: "unknown" };
      }
    },
  };
}
