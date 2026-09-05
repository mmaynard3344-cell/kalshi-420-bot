import { getWindowLog } from "../windowLog.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { evaluateEthAccountCapital, type EthAccountCapitalInput } from "./ethAccountCapitalGuard.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { prepareEthReversalServiceIntent } from "./ethReversalServiceRuntime.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";

/** Hard code fence for Service C. Environment configuration alone cannot enable it. */
export const ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = false;

export function isEthReversalServiceExecutionPermitted(role = currentEthServiceRole()): boolean {
  return ETH_REVERSAL_SERVICE_EXECUTION_APPROVED
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
  capital: Omit<EthAccountCapitalInput, "requestedRiskCents"> | null;
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
  const intent = await prepareEthReversalServiceIntent({
    store: input.store,
    market: input.market,
    windowEntries: getWindowLog(),
  });
  if (!intent) return "no_signal";
  if (!input.capital) return "capital_unavailable";
  const capital = evaluateEthAccountCapital({ ...input.capital, requestedRiskCents: intent.wagerCents });
  if (!capital.allowed) return capital.reason === "invalid_input" ? "capital_unavailable" : "capital_blocked";
  const exchange = input.exchangeIndex == null ? null : createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return "routing_unavailable";
  try {
    await ensureStoreReady();
  } catch {
    return "storage_unavailable";
  }
  return submitEthBigBetIntent({ intent, store: ethBigBetExecutionStore, exchange });
}
