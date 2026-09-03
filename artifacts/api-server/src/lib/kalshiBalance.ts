import {
  createKeyedQuotaAwareCache,
  createQuotaAwareCache,
  kalshiAccountReadGate,
  type CachedRead,
} from "./kalshiAccountReads.js";
import { kalshiAuthFetch } from "./kalshiAuth.js";

export const BALANCE_CACHE_TTL_MS = 10_000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Shares concurrent requests and retains only successful responses briefly.
 * Errors intentionally bypass the cache so callers can observe and recover
 * from authentication failures, throttling, or an upstream outage immediately.
 */
export function createSuccessOnlySingleFlightCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
) {
  let cached: CacheEntry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    get(load: () => Promise<T>): Promise<T> {
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
      if (inFlight) return inFlight;

      const request = load().then((value) => {
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      });
      inFlight = request;
      void request.then(
        () => {
          if (inFlight === request) inFlight = null;
        },
        () => {
          if (inFlight === request) inFlight = null;
        },
      );
      return request;
    },
    clear(): void {
      cached = null;
    },
  };
}

const kalshiBalanceCache = createQuotaAwareCache<Record<string, unknown>>({
  ttlMs: BALANCE_CACHE_TTL_MS,
  gate: kalshiAccountReadGate,
});
const kalshiExchangeBalanceCache = createKeyedQuotaAwareCache<Record<string, unknown>>({
  ttlMs: BALANCE_CACHE_TTL_MS,
  gate: kalshiAccountReadGate,
});

/**
 * Fetch the account balance through the shared quota-aware read path.
 * Returns the value plus a `stale` flag: after a Kalshi 429 (or transient
 * failure) the last known balance is served as stale instead of erroring,
 * and no new exchange request is issued during the rate-limit cooldown.
 */
export function fetchKalshiBalanceRead(): Promise<CachedRead<Record<string, unknown>>> {
  return kalshiBalanceCache.get(() =>
    kalshiAuthFetch<Record<string, unknown>>("GET", "/portfolio/balance"),
  );
}

/**
 * Fetch an exchange-scoped available balance. Kalshi accounts can hold funds on
 * several exchange shards, so aggregate account cash must never authorize an
 * order routed to a specific exchange_index.
 */
export function fetchKalshiBalanceForExchangeRead(
  exchangeIndex: number,
): Promise<CachedRead<Record<string, unknown>>> {
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
    return Promise.reject(new Error("A non-negative integer exchange index is required for an exchange-scoped balance"));
  }
  return kalshiExchangeBalanceCache.get(String(exchangeIndex), () =>
    kalshiAuthFetch<Record<string, unknown>>(
      "GET",
      `/portfolio/balance?exchange_index=${encodeURIComponent(String(exchangeIndex))}`,
      undefined,
      { readPriority: "safety" },
    ),
  );
}

/**
 * Read a routed exchange's available balance for order authorization.
 *
 * This intentionally bypasses the dashboard cache: a recent dashboard read
 * cannot prove funds remain available after another order consumes them. Entry
 * code must call this immediately before it reserves and submits an order.
 */
export function fetchFreshKalshiBalanceForExchangeRead(
  exchangeIndex: number,
): Promise<CachedRead<Record<string, unknown>>> {
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
    return Promise.reject(new Error("A non-negative integer exchange index is required for an exchange-scoped balance"));
  }
  return kalshiAuthFetch<Record<string, unknown>>(
    "GET",
    `/portfolio/balance?exchange_index=${encodeURIComponent(String(exchangeIndex))}`,
    undefined,
    { readPriority: "safety" },
  ).then((value) => ({ value, stale: false }));
}

/** Returns the available Kalshi balance in integer cents, or null for malformed data. */
export function kalshiBalanceCents(value: Record<string, unknown>): number | null {
  const balance = value["balance"];
  return typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0
    ? balance
    : null;
}

export type TradeBalanceDashboardResponse = Record<string, unknown> & {
  stale: boolean;
  aggregate_balance_cents: number | null;
  aggregate_balance_dollars: string | null;
  active_eth_exchange_index: number | null;
  active_eth_exchange_balance: {
    exchange_index: number;
    available_balance_cents: number | null;
    available_balance_dollars: string | null;
    stale: boolean;
  } | null;
};

/**
 * Build the authenticated balance response consumed by the live martingale
 * dashboard. The active ETH balance is deliberately a separate scoped read:
 * Kalshi's aggregate balance does not mean funds are available on the exchange
 * shard where the active ETH market is routed.
 */
export function buildTradeBalanceDashboardResponse(
  aggregate: CachedRead<Record<string, unknown>>,
  activeEthExchangeIndex: number | null,
  activeEthExchangeBalance: CachedRead<Record<string, unknown>> | null,
): TradeBalanceDashboardResponse {
  const aggregateBalanceCents = kalshiBalanceCents(aggregate.value);
  const activeBalanceCents = activeEthExchangeBalance == null
    ? null
    : kalshiBalanceCents(activeEthExchangeBalance.value);
  return {
    ...aggregate.value,
    stale: aggregate.stale,
    aggregate_balance_cents: aggregateBalanceCents,
    aggregate_balance_dollars: aggregateBalanceCents == null ? null : (aggregateBalanceCents / 100).toFixed(2),
    active_eth_exchange_index: activeEthExchangeIndex,
    active_eth_exchange_balance: activeEthExchangeIndex == null
      ? null
      : {
        exchange_index: activeEthExchangeIndex,
        available_balance_cents: activeBalanceCents,
        available_balance_dollars: activeBalanceCents == null ? null : (activeBalanceCents / 100).toFixed(2),
        stale: activeEthExchangeBalance?.stale ?? true,
      },
  };
}

/** Fetch the account balance without duplicating nearby Kalshi API requests. */
export async function fetchKalshiBalance(): Promise<Record<string, unknown>> {
  return (await fetchKalshiBalanceRead()).value;
}