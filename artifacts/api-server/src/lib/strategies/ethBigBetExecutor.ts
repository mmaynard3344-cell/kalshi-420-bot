import type { EthAccountCapitalInput } from "./ethAccountCapitalGuard.js";
import {
  ethBigBetContracts,
  ethBigBetOrderId,
  mayEvaluateBigBetMarket,
  type EthBigBetOrderIntent,
} from "./ethBigBetLifecycle.js";

export type EthBigBetExecutionReservationResult = "reserved" | "capital_blocked" | "reservation_failed";

export interface EthBigBetExecutionStore {
  listUnresolvedEthBigBetOrderIds(strategy: EthBigBetOrderIntent["strategy"]): Promise<string[]>;
  reserveEthBigBetOrder(input: {
    orderId: string;
    intent: EthBigBetOrderIntent;
    requestedContracts: number;
    requestedRiskCents: number;
    capital: Omit<EthAccountCapitalInput, "requestedRiskCents">;
    reservedAtMs: number;
  }): Promise<EthBigBetExecutionReservationResult>;
  acknowledgeEthBigBetOrder(input: {
    orderId: string;
    exchangeOrderId: string | null;
    status: "submitted" | "submission_unknown" | "rejected";
    acknowledgedAtMs: number;
  }): Promise<boolean>;
}

export type EthBigBetSubmitResult =
  | { kind: "accepted"; exchangeOrderId: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown" };

export interface EthBigBetExchangeSubmitter {
  submit(input: {
    clientOrderId: string;
    ticker: string;
    side: "yes" | "no";
    contracts: number;
    limitPriceCents: number;
  }): Promise<EthBigBetSubmitResult>;
}

const ACK_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A Kalshi response is not considered durably represented until the shared
 * ledger row has been updated successfully. This closes the gap where an order
 * could be real on the exchange while the local row remained only `reserved`.
 */
async function acknowledgeDurably(
  store: EthBigBetExecutionStore,
  input: Parameters<EthBigBetExecutionStore["acknowledgeEthBigBetOrder"]>[0],
): Promise<boolean> {
  for (let attempt = 0; attempt < ACK_RETRY_DELAYS_MS.length; attempt++) {
    const delay = ACK_RETRY_DELAYS_MS[attempt]!;
    if (delay > 0) await sleep(delay);
    try {
      if (await store.acknowledgeEthBigBetOrder({ ...input, acknowledgedAtMs: Date.now() })) return true;
    } catch {
      // Retry a transient durable-store failure. The exchange order is never
      // resubmitted here, so retries cannot create a duplicate Kalshi order.
    }
  }
  return false;
}

/**
 * Stateless B-I submission seam. It deliberately has no martingale-state input
 * or settlement dependency. An unresolved earlier market is allowed; only the
 * exact same strategy+market identity can suppress a duplicate submission.
 *
 * Capital admission is repeated atomically by the production store under a
 * shared database lock before the durable reservation is inserted.
 *
 * Any thrown/ambiguous POST remains submission_unknown. Only an explicit,
 * authoritative exchange rejection may be persisted as rejected. An accepted
 * exchange response is reported as `submitted` only after its exchange order ID
 * is durably attached to the reserved parent row.
 */
export async function submitEthBigBetIntent(input: {
  intent: EthBigBetOrderIntent;
  store: EthBigBetExecutionStore;
  exchange: EthBigBetExchangeSubmitter;
  capital: Omit<EthAccountCapitalInput, "requestedRiskCents">;
  requestedRiskCents: number;
  nowMs?: number;
}): Promise<"submitted" | "blocked_duplicate" | "blocked_invalid_size" | "capital_blocked" | "reservation_failed" | "submission_unknown" | "rejected"> {
  const orderId = ethBigBetOrderId(input.intent);
  const unresolved = await input.store.listUnresolvedEthBigBetOrderIds(input.intent.strategy);
  if (!mayEvaluateBigBetMarket({ targetOrderId: orderId, unresolvedOrderIds: unresolved })) {
    return "blocked_duplicate";
  }
  const contracts = ethBigBetContracts(input.intent.wagerCents, input.intent.limitPriceCents);
  if (contracts < 1 || !Number.isSafeInteger(input.requestedRiskCents) || input.requestedRiskCents < 1) {
    return "blocked_invalid_size";
  }
  const nowMs = input.nowMs ?? Date.now();
  const reservation = await input.store.reserveEthBigBetOrder({
    orderId,
    intent: input.intent,
    requestedContracts: contracts,
    requestedRiskCents: input.requestedRiskCents,
    capital: input.capital,
    reservedAtMs: nowMs,
  });
  if (reservation === "capital_blocked") return "capital_blocked";
  if (reservation !== "reserved") return "reservation_failed";
  try {
    const submitted = await input.exchange.submit({
      clientOrderId: orderId,
      ticker: input.intent.ticker,
      side: input.intent.side,
      contracts,
      limitPriceCents: input.intent.limitPriceCents,
    });
    if (submitted.kind === "accepted") {
      const acknowledged = await acknowledgeDurably(input.store, {
        orderId,
        exchangeOrderId: submitted.exchangeOrderId,
        status: "submitted",
        acknowledgedAtMs: Date.now(),
      });
      if (acknowledged) return "submitted";

      // The exchange accepted the order but durable linkage failed. Do not
      // falsely report `submitted`; retain a fail-closed unresolved parent that
      // can be recovered later by immutable client_order_id.
      await acknowledgeDurably(input.store, {
        orderId,
        exchangeOrderId: null,
        status: "submission_unknown",
        acknowledgedAtMs: Date.now(),
      });
      return "submission_unknown";
    }
    if (submitted.kind === "rejected") {
      const acknowledged = await acknowledgeDurably(input.store, {
        orderId,
        exchangeOrderId: null,
        status: "rejected",
        acknowledgedAtMs: Date.now(),
      });
      return acknowledged ? "rejected" : "submission_unknown";
    }
    await acknowledgeDurably(input.store, {
      orderId,
      exchangeOrderId: null,
      status: "submission_unknown",
      acknowledgedAtMs: Date.now(),
    });
    return "submission_unknown";
  } catch {
    await acknowledgeDurably(input.store, {
      orderId,
      exchangeOrderId: null,
      status: "submission_unknown",
      acknowledgedAtMs: Date.now(),
    });
    return "submission_unknown";
  }
}
