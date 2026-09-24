import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { prepareEthReversalServiceIntent } from "./ethReversalServiceRuntime.js";
import { currentEthServiceEnablement } from "./ethServiceEnablementContract.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";
import { bkCapitalTelemetry, evaluateBkCapitalAdmission, isBkFreshBalanceCapitalPolicyEnabled, readBkFreshSameShardBalance } from "./bkFreshBalanceCapitalPolicy.js";
import { logger } from "../logger.js";

/**
 * Service C code-side approval. Runtime execution still requires the exact
 * reversal role, the matching live environment flag, and a valid enablement
 * contract. Environment misconfiguration therefore remains fail-closed.
 */
export const ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = true;

export function isEthReversalServiceExecutionPermitted(role = currentEthServiceRole()): boolean {
  const enablement = currentEthServiceEnablement();
  return ETH_REVERSAL_SERVICE_EXECUTION_APPROVED
    && enablement.valid
    && enablement.mode === "reversal_live_requested"
    && serviceOwnsReversal(role)
    && process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"] === "true";
}

type ReversalEvidenceStore = Parameters<typeof prepareEthReversalServiceIntent>[0]["store"];
let storeReady: Promise<void> | null = null;

async function ensureStoreReady(): Promise<void> {
  storeReady ??= initEthBigBetStore();
  return storeReady;
}

export async function runEthReversalServiceWhenExplicitlyEnabled(input: {
  store: ReversalEvidenceStore;
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<
  | "disabled"
  | "no_signal"
  | "capital_unavailable"
  | "capital_blocked"
  | "routing_unavailable"
  | "storage_unavailable"
  | "submitted"
  | "blocked_duplicate"
  | "blocked_invalid_size"
  | "reservation_failed"
  | "submission_unknown"
  | "rejected"
> {
  if (!isEthReversalServiceExecutionPermitted()) return "disabled";
  // Load the durable window-result reader only after every execution gate is
  // open. A disabled C service must remain inert even without DATABASE_URL.
  const { getWindowLog } = await import("../windowLog.js");
  const intent = await prepareEthReversalServiceIntent({
    store: input.store,
    market: input.market,
    windowEntries: getWindowLog(),
  });
  if (!intent) return "no_signal";
  if (input.exchangeIndex == null || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) {
    return "routing_unavailable";
  }
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  if (requestedRiskCents < 1) return "capital_unavailable";
  const flagEnabled = isBkFreshBalanceCapitalPolicyEnabled();
  const capitalBase = await readApprovedEthBigBetCapitalBase(input.exchangeIndex);
  if (!flagEnabled && !capitalBase) return "capital_unavailable";
  const oldCapital = capitalBase ? evaluateEthAccountCapital({ ...capitalBase, requestedRiskCents }) : null;
  const freshAvailableBalanceCents = flagEnabled
    ? await readBkFreshSameShardBalance(input.exchangeIndex)
    : capitalBase!.availableBalanceCents;
  const admission = evaluateBkCapitalAdmission({ service: "C", ticker: input.market.ticker, exchangeIndex: input.exchangeIndex,
    requestedRiskCents, freshAvailableBalanceCents,
    oldPolicyDecision: oldCapital == null ? "unavailable" : oldCapital.allowed ? "allow" : oldCapital.reason === "invalid_input" ? "unavailable" : "block",
    oldPolicyBlocker: oldCapital == null || oldCapital.allowed ? null : oldCapital.reason });
  if (!admission.finalAllowed) {
    logger.info(bkCapitalTelemetry(admission, "not_attempted"), "BK capital admission");
    return admission.finalDecision === "unavailable" ? "capital_unavailable" : "capital_blocked";
  }
  const exchange = createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return "routing_unavailable";
  try {
    await ensureStoreReady();
  } catch {
    return "storage_unavailable";
  }
  const outcome = await submitEthBigBetIntent({
    intent,
    store: ethBigBetExecutionStore,
    exchange,
    capital: capitalBase ?? { availableBalanceCents: freshAvailableBalanceCents!, martingaleReserveCents: 0, safetyReserveCents: 0, otherBigBetReservedCents: 0 },
    requestedRiskCents,
  });
  logger.info(bkCapitalTelemetry(admission, outcome), "BK capital admission");
  return outcome;
}
