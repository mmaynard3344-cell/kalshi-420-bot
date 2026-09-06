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

/**
 * Stateless B/C submission seam. It deliberately has no martingale-state input
 * or settlement dependency. An unresolved earlier market is allowed; only the
 * exact same strategy+market identity can suppress a duplicate submission.
 *
 * Capital admission is repeated atomically by the production store under a
 * shared B/C database lock before the durable reservation is inserted. This
 * closes the cross-process stale-snapshot race between independent services.
 *
 * Any thrown/ambiguous POST remains submission_unknown. Only an explicit,
 * authoritative exchange rejection may be persisted as rejected.
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
      await input.store.acknowledgeEthBigBetOrder({
        orderId,
        exchangeOrderId: submitted.exchangeOrderId,
        status: "submitted",
        acknowledgedAtMs: Date.now(),
      });
      return "submitted";
    }
    if (submitted.kind === "rejected") {
      await input.store.acknowledgeEthBigBetOrder({
        orderId,
        exchangeOrderId: null,
        status: "rejected",
        acknowledgedAtMs: Date.now(),
      });
      return "rejected";
    }
    await input.store.acknowledgeEthBigBetOrder({
      orderId,
      exchangeOrderId: null,
      status: "submission_unknown",
      acknowledgedAtMs: Date.now(),
    });
    return "submission_unknown";
  } catch {
    await input.store.acknowledgeEthBigBetOrder({
      orderId,
      exchangeOrderId: null,
      status: "submission_unknown",
      acknowledgedAtMs: Date.now(),
    });
    return "submission_unknown";
  }
}
