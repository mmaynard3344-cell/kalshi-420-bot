import { kalshiAuthFetch } from "../kalshiAuth.js";
import { parseKalshiOrderResponse } from "../orderResponseParser.js";
import type { EthBigBetExchangeSubmitter, EthBigBetSubmitResult } from "./ethBigBetExecutor.js";

type AuthFetch = typeof kalshiAuthFetch;
let authFetch: AuthFetch = kalshiAuthFetch;

const G_PROBE_ORDER_TAG = ":eth-probe-g-5m-30c-v1";
const RECOVERY_DELAYS_MS = [100, 300, 800] as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface KalshiOrderWire {
  order_id?: unknown;
  client_order_id?: unknown;
  ticker?: unknown;
  [key: string]: unknown;
}

interface KalshiOrdersResponse {
  orders?: KalshiOrderWire[];
  [key: string]: unknown;
}

export function _setEthBigBetAuthFetchForTesting(fetcher: AuthFetch | null): void {
  authFetch = fetcher ?? kalshiAuthFetch;
}

function exactOrderId(order: KalshiOrderWire | null | undefined): string | null {
  return typeof order?.order_id === "string" && order.order_id.trim() ? order.order_id : null;
}

function exactIdentity(order: KalshiOrderWire | null | undefined, clientOrderId: string, ticker: string): string | null {
  const orderId = exactOrderId(order);
  return orderId
    && order?.client_order_id === clientOrderId
    && order?.ticker === ticker
    ? orderId
    : null;
}

async function findByClientOrderId(clientOrderId: string, ticker: string): Promise<string | null> {
  try {
    const response = await authFetch<KalshiOrdersResponse>(
      "GET",
      `/portfolio/orders?client_order_id=${encodeURIComponent(clientOrderId)}&limit=10`,
    );
    const matches = Array.isArray(response?.orders)
      ? response.orders.map((order) => exactIdentity(order, clientOrderId, ticker)).filter((id): id is string => id != null)
      : [];
    return matches.length === 1 ? matches[0]! : null;
  } catch {
    return null;
  }
}

async function verifyByOrderId(orderId: string, clientOrderId: string, ticker: string): Promise<string | null> {
  try {
    const response = await authFetch<Record<string, unknown>>(
      "GET",
      `/portfolio/orders/${encodeURIComponent(orderId)}`,
    );
    const order = (response["order"] as KalshiOrderWire | undefined) ?? response as KalshiOrderWire;
    return exactIdentity(order, clientOrderId, ticker);
  } catch {
    return null;
  }
}

async function recoverAcceptedOrder(clientOrderId: string, ticker: string): Promise<string | null> {
  for (const delayMs of RECOVERY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs);
    const found = await findByClientOrderId(clientOrderId, ticker);
    if (found) return found;
  }
  return null;
}

/**
 * Shared B/C/E/F/G exchange adapter with same-client-id recovery.
 * Ambiguous POSTs are reconciled against Kalshi before one bounded retry with
 * the SAME immutable client_order_id, preventing a false duplicate lock from
 * consuming the rest of a qualifying market.
 */
export function createEthBigBetKalshiSubmitter(exchangeIndex: number): EthBigBetExchangeSubmitter | null {
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) return null;

  const post = async (input: {
    clientOrderId: string;
    ticker: string;
    side: "yes" | "no";
    contracts: number;
    limitPriceCents: number;
  }): Promise<string | null> => {
    try {
      const isGProbe = input.clientOrderId.endsWith(G_PROBE_ORDER_TAG);
      const wirePriceCents = isGProbe && input.side === "no"
        ? 100 - input.limitPriceCents
        : input.limitPriceCents;
      const raw = await authFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", {
        ticker: input.ticker,
        client_order_id: input.clientOrderId,
        side: input.side === "yes" ? "bid" : "ask",
        count: `${input.contracts}.00`,
        price: (wirePriceCents / 100).toFixed(4),
        time_in_force: "good_till_canceled",
        self_trade_prevention_type: "taker_at_cross",
        exchange_index: exchangeIndex,
      });
      const wire = (raw["order"] as KalshiOrderWire | undefined) ?? raw as KalshiOrderWire;
      const direct = exactIdentity(wire, input.clientOrderId, input.ticker);
      if (direct) return direct;

      const parsed = parseKalshiOrderResponse(raw, input.contracts);
      if (parsed.kalshiOrderId) {
        const verified = await verifyByOrderId(parsed.kalshiOrderId, input.clientOrderId, input.ticker);
        if (verified) return verified;
      }
      return null;
    } catch {
      return null;
    }
  };

  return {
    async submit(input): Promise<EthBigBetSubmitResult> {
      const first = await post(input);
      if (first) return { kind: "accepted", exchangeOrderId: first };

      const recovered = await recoverAcceptedOrder(input.clientOrderId, input.ticker);
      if (recovered) return { kind: "accepted", exchangeOrderId: recovered };

      const second = await post(input);
      if (second) return { kind: "accepted", exchangeOrderId: second };

      const recoveredAfterRetry = await recoverAcceptedOrder(input.clientOrderId, input.ticker);
      return recoveredAfterRetry
        ? { kind: "accepted", exchangeOrderId: recoveredAfterRetry }
        : { kind: "unknown" };
    },
  };
}
