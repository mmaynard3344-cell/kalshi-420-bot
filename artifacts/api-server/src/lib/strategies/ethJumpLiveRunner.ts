import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthJumpServiceIntent } from "./ethJumpServiceRuntime.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
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

export async function runEthJumpServiceWhenExplicitlyEnabled(input: {
  store: JumpEvidenceStore;
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<
  | "disabled"
  | "no_signal"
  | "routing_unavailable"
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
  const exchange = input.exchangeIndex == null ? null : createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return "routing_unavailable";
  return submitEthBigBetIntent({ intent, store: ethBigBetExecutionStore, exchange });
}
