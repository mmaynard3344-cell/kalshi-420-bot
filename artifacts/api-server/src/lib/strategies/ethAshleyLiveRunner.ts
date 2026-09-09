import { logger } from "../logger.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthAshleyIntent } from "./ethAshleyServiceRuntime.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethDownfadeExecutionStore, initEthDownfadeExecutionStore } from "./ethDownfadeExecutionStore.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { currentEthServiceEnablement } from "./ethServiceEnablementContract.js";
import { currentEthServiceRole } from "./ethServiceRole.js";
import { ETH_ASHLEY_WAGER_CENTS } from "./ethAshleySignal.js";

export const ETH_ASHLEY_SERVICE_EXECUTION_APPROVED = true;

export type EthAshleyLiveOutcome =
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
  | "rejected";

let storeReady: Promise<void> | null = null;
async function ensureStoreReady(): Promise<void> {
  storeReady ??= initEthDownfadeExecutionStore();
  return storeReady;
}

export function isEthAshleyExecutionPermitted(): boolean {
  const role = currentEthServiceRole();
  const enablement = currentEthServiceEnablement();
  return ETH_ASHLEY_SERVICE_EXECUTION_APPROVED
    && role === "downfade_h"
    && enablement.valid
    && enablement.mode === "downfade_live_requested"
    && process.env["ETH_DOWNFADE_SERVICE_LIVE_ENABLED"] === "true";
}

export async function runEthAshleyWhenExplicitlyEnabled(input: {
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<EthAshleyLiveOutcome> {
  let currentStrike: number | null = null;
  let priorStrike: number | null = null;
  let moveRatio: number | null = null;
  let declineRatio: number | null = null;
  let ageMs: number | null = null;
  let signalRejectionReason: string | null = null;

  const finish = <T extends EthAshleyLiveOutcome>(outcome: T, rejectionReason: string | null = null): T => {
    logger.info({
      serviceRole: currentEthServiceRole(),
      serviceName: "Ashley",
      serviceLetter: "H",
      wagerCents: ETH_ASHLEY_WAGER_CENTS,
      ticker: input.market.ticker,
      currentStrike,
      priorStrike,
      moveRatio,
      declineRatio,
      ageMs,
      outcome,
      rejectionReason: rejectionReason ?? signalRejectionReason,
    }, "ETH Ashley H evaluation");
    return outcome;
  };

  if (!isEthAshleyExecutionPermitted()) return finish("disabled", "execution_not_permitted");

  const intent = await prepareEthAshleyIntent({
    market: input.market,
    onEvaluation: (observation) => {
      currentStrike = observation.currentStrike;
      priorStrike = observation.priorStrike;
      moveRatio = observation.moveRatio;
      declineRatio = observation.declineRatio;
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
  const outcome = await submitEthBigBetIntent({
    intent,
    store: ethDownfadeExecutionStore,
    exchange,
    capital: capitalBase,
    requestedRiskCents,
  });
  const rejectionReason = outcome === "submitted" ? null
    : outcome === "blocked_duplicate" ? "duplicate_strategy_market"
    : outcome === "blocked_invalid_size" ? "invalid_order_size"
    : outcome === "capital_blocked" ? "capital_guard_blocked"
    : outcome === "reservation_failed" ? "durable_reservation_failed"
    : outcome === "submission_unknown" ? "exchange_submission_unknown"
    : outcome === "rejected" ? "exchange_rejected_reason_not_exposed_by_executor" : outcome;
  return finish(outcome, rejectionReason);
}
