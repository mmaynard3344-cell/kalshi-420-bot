import { logger } from "../logger.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthAshV2Intent } from "./ethAshV2ServiceRuntime.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetWithLongReversalAdmission } from "./ethLongReversalBigBetBridge.js";
import { ethDownfadeExecutionStore, initEthDownfadeExecutionStore } from "./ethDownfadeExecutionStore.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { currentEthServiceEnablement } from "./ethServiceEnablementContract.js";
import { currentEthServiceRole } from "./ethServiceRole.js";
import { ETH_ASH_V2_WAGER_CENTS } from "./ethAshV2Signal.js";

export const ETH_ASH_V2_SERVICE_EXECUTION_APPROVED = true;

export type EthAshV2LiveOutcome =
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
  | "correlated_cap_unavailable"
  | "correlated_cap_blocked";

let storeReady: Promise<void> | null = null;
async function ensureStoreReady(): Promise<void> {
  storeReady ??= initEthDownfadeExecutionStore();
  return storeReady;
}

export function isEthAshV2ExecutionPermitted(): boolean {
  const role = currentEthServiceRole();
  const enablement = currentEthServiceEnablement();
  return ETH_ASH_V2_SERVICE_EXECUTION_APPROVED
    && role === "ash_v2_i"
    && enablement.valid
    && enablement.mode === "ash_v2_live_requested"
    && process.env["ETH_ASH_V2_SERVICE_LIVE_ENABLED"] === "true";
}

export async function runEthAshV2WhenExplicitlyEnabled(input: {
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<EthAshV2LiveOutcome> {
  let currentStrike: number | null = null;
  let priorStrike: number | null = null;
  let moveRatio: number | null = null;
  let ageMs: number | null = null;
  let signalRejectionReason: string | null = null;

  const finish = <T extends EthAshV2LiveOutcome>(outcome: T, rejectionReason: string | null = null): T => {
    logger.info({
      serviceRole: currentEthServiceRole(),
      serviceName: "Ash V2",
      serviceLetter: "I",
      wagerCents: ETH_ASH_V2_WAGER_CENTS,
      ticker: input.market.ticker,
      currentStrike,
      priorStrike,
      moveRatio,
      ageMs,
      outcome,
      rejectionReason: rejectionReason ?? signalRejectionReason,
    }, "ETH Ash V2 I evaluation");
    return outcome;
  };

  if (!isEthAshV2ExecutionPermitted()) return finish("disabled", "execution_not_permitted");

  const intent = await prepareEthAshV2Intent({
    market: input.market,
    onEvaluation: (observation) => {
      currentStrike = observation.currentStrike;
      priorStrike = observation.priorStrike;
      moveRatio = observation.moveRatio;
      ageMs = observation.ageMs;
      signalRejectionReason = observation.rejectionReason;
    },
  });
  if (!intent) return finish("no_signal");

  if (input.exchangeIndex == null || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) {
    return finish("routing_unavailable", "invalid_exchange_index");
  }

  try { await ensureStoreReady(); }
  catch { return finish("storage_unavailable", "execution_store_unavailable"); }

  const capitalBase = await readApprovedEthBigBetCapitalBase(input.exchangeIndex);
  if (!capitalBase) return finish("capital_unavailable", "capital_base_unavailable");
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  if (requestedRiskCents < 1) return finish("capital_unavailable", "invalid_requested_risk");
  const capital = evaluateEthAccountCapital({ ...capitalBase, requestedRiskCents });
  if (!capital.allowed) {
    return finish(capital.reason === "invalid_input" ? "capital_unavailable" : "capital_blocked", capital.reason);
  }

  const exchange = createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return finish("routing_unavailable", "exchange_route_unavailable");
  const outcome = await submitEthBigBetWithLongReversalAdmission({
    service: "I",
    intent,
    exchangeIndex: input.exchangeIndex,
    executionStore: ethDownfadeExecutionStore,
    exchange,
    capital: capitalBase,
    requestedRiskCents,
  });
  const rejectionReason = outcome === "submitted" ? null
    : outcome === "correlated_cap_unavailable" ? "long_reversal_cap_unavailable"
    : outcome === "correlated_cap_blocked" ? "long_reversal_cap_blocked"
    : outcome === "blocked_duplicate" ? "duplicate_strategy_market"
    : outcome === "blocked_invalid_size" ? "invalid_order_size"
    : outcome === "capital_blocked" ? "capital_guard_blocked"
    : outcome === "reservation_failed" ? "durable_reservation_failed"
    : outcome === "submission_unknown" ? "exchange_submission_unknown"
    : outcome === "rejected" ? "exchange_rejected_reason_not_exposed_by_executor" : outcome;
  return finish(outcome, rejectionReason);
}
