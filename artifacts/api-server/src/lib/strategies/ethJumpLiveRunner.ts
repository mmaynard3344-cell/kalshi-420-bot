import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthJumpServiceIntent } from "./ethJumpServiceRuntime.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { currentEthServiceRole, serviceOwnsJump } from "./ethServiceRole.js";

/**
 * Hard code fence. This remains false while Service B is staged and validated.
 * Neither ETH_SERVICE_ROLE nor an environment flag can make B submit until this
 * constant is changed in a separately reviewed commit.
 */
export const ETH_JUMP_SERVICE_EXECUTION_APPROVED = false;

export function isEthJumpServiceExecutionPermitted(role = currentEthServiceRole()): boolean {
  return ETH_JUMP_SERVICE_EXECUTION_APPROVED
    && serviceOwnsJump(role)
    && process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"] === "true";
}

type JumpEvidenceStore = Parameters<typeof prepareEthJumpServiceIntent>[0]["store"];
let storeReady: Promise<void> | null = null;

async function ensureStoreReady(): Promise<void> {
  storeReady ??= initEthBigBetStore();
  return storeReady;
}

export async function runEthJumpServiceWhenExplicitlyEnabled(input: {
  store: JumpEvidenceStore;
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
  if (!isEthJumpServiceExecutionPermitted()) return "disabled";
  const intent = await prepareEthJumpServiceIntent({ store: input.store, market: input.market });
  if (!intent) return "no_signal";
  if (input.exchangeIndex == null || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) {
    return "routing_unavailable";
  }
  const capitalBase = await readApprovedEthBigBetCapitalBase(input.exchangeIndex);
  if (!capitalBase) return "capital_unavailable";
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  if (requestedRiskCents < 1) return "capital_unavailable";
  const capital = evaluateEthAccountCapital({ ...capitalBase, requestedRiskCents });
  if (!capital.allowed) return capital.reason === "invalid_input" ? "capital_unavailable" : "capital_blocked";
  const exchange = createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return "routing_unavailable";
  try {
    await ensureStoreReady();
  } catch {
    return "storage_unavailable";
  }
  return submitEthBigBetIntent({
    intent,
    store: ethBigBetExecutionStore,
    exchange,
    capital: capitalBase,
    requestedRiskCents,
  });
}
