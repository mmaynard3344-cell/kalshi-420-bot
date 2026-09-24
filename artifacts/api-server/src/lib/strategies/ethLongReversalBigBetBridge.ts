import type { EthAccountCapitalInput } from "./ethAccountCapitalGuard.js";
import type { EthBigBetExchangeSubmitter, EthBigBetExecutionStore } from "./ethBigBetExecutor.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetOrderId, type EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import {
  PostgresEthLongReversalStore,
  acquireEthLongReversalExposure,
  isEthLongReversalExposure,
  readEthLongReversalCapCents,
  type EthLongReversalService,
  type EthLongReversalStore,
} from "./ethLongReversalExposure.js";

let storePromise: Promise<EthLongReversalStore> | null = null;
let storeOverride: EthLongReversalStore | null = null;

export function _setLongReversalBridgeStoreForTesting(store: EthLongReversalStore | null): void {
  storeOverride = store;
  storePromise = null;
}

async function productionStore(): Promise<EthLongReversalStore> {
  if (storeOverride) return storeOverride;
  storePromise ??= import("@workspace/db").then((mod) =>
    new PostgresEthLongReversalStore(mod.db as any),
  );
  return storePromise;
}

export type LongReversalWrappedOutcome =
  | "submitted"
  | "blocked_duplicate"
  | "blocked_invalid_size"
  | "capital_blocked"
  | "reservation_failed"
  | "submission_unknown"
  | "rejected"
  | "correlated_cap_unavailable"
  | "correlated_cap_blocked";

export async function submitEthBigBetWithLongReversalAdmission(input: {
  service: EthLongReversalService;
  intent: EthBigBetOrderIntent;
  exchangeIndex: number;
  executionStore: EthBigBetExecutionStore;
  exchange: EthBigBetExchangeSubmitter;
  capital: Omit<EthAccountCapitalInput, "requestedRiskCents">;
  requestedRiskCents: number;
}): Promise<LongReversalWrappedOutcome> {
  if (!isEthLongReversalExposure(input.service, input.intent.side)) {
    return submitEthBigBetIntent({
      intent: input.intent,
      store: input.executionStore,
      exchange: input.exchange,
      capital: input.capital,
      requestedRiskCents: input.requestedRiskCents,
    });
  }

  const capCents = readEthLongReversalCapCents();
  if (capCents == null) return "correlated_cap_unavailable";

  const sourceOrderId = ethBigBetOrderId(input.intent);
  const reservationId = `long-reversal:${input.service}:${sourceOrderId}`;
  const store = await productionStore();
  const admission = await acquireEthLongReversalExposure({
    id: reservationId,
    service: input.service,
    strategy: input.intent.strategy,
    ticker: input.intent.ticker,
    side: input.intent.side,
    clientOrderId: sourceOrderId,
    sourceOrderId,
    exchangeIndex: input.exchangeIndex,
    requestedRiskCents: input.requestedRiskCents,
    capCents,
    store,
  });

  if (!admission.allowed) {
    return admission.reason === "cap_exceeded"
      ? "correlated_cap_blocked"
      : "correlated_cap_unavailable";
  }

  const outcome = await submitEthBigBetIntent({
    intent: input.intent,
    store: input.executionStore,
    exchange: input.exchange,
    capital: input.capital,
    requestedRiskCents: input.requestedRiskCents,
  });

  if (outcome === "submitted") {
    await store.transition({ id: reservationId, from: "reserved", to: "submitted", updatedAtMs: Date.now() });
  } else if (outcome === "submission_unknown") {
    await store.transition({ id: reservationId, from: "reserved", to: "submission_unknown", updatedAtMs: Date.now() });
  } else if (outcome === "rejected") {
    await store.transition({ id: reservationId, from: ["reserved","submission_unknown"], to: "rejected", updatedAtMs: Date.now() });
  } else {
    await store.transition({ id: reservationId, from: "reserved", to: "released", updatedAtMs: Date.now() });
  }
  return outcome;
}
