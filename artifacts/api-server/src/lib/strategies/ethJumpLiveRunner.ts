import { logger } from "../logger.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthJumpServiceIntent } from "./ethJumpServiceRuntime.js";
import { runEthDownfadeServiceWhenExplicitlyEnabled, type EthDownfadeLiveOutcome } from "./ethDownfadeLiveRunner.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { currentEthServiceEnablement } from "./ethServiceEnablementContract.js";
import { currentEthServiceRole, serviceOwnsJump, serviceOwnsDownfade } from "./ethServiceRole.js";
import { bkCapitalTelemetry, evaluateBkCapitalAdmission, isBkFreshBalanceCapitalPolicyEnabled, readBkFreshSameShardBalance } from "./bkFreshBalanceCapitalPolicy.js";

export const ETH_JUMP_SERVICE_EXECUTION_APPROVED = true;

export function isEthJumpServiceExecutionPermitted(role = currentEthServiceRole()): boolean {
  const enablement = currentEthServiceEnablement();
  return ETH_JUMP_SERVICE_EXECUTION_APPROVED
    && enablement.valid
    && enablement.mode === "jump_live_requested"
    && serviceOwnsJump(role)
    && process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"] === "true";
}

type JumpEvidenceStore = Parameters<typeof prepareEthJumpServiceIntent>[0]["store"];
type EthJumpLiveOutcome = EthDownfadeLiveOutcome;

let storeReady: Promise<void> | null = null;
async function ensureStoreReady(): Promise<void> {
  storeReady ??= initEthBigBetStore();
  return storeReady;
}

export async function runEthJumpServiceWhenExplicitlyEnabled(input: {
  store: JumpEvidenceStore;
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<EthJumpLiveOutcome> {
  const role = currentEthServiceRole();
  // AutoTrader already invokes this isolated stateless seam for every ETH
  // market. E/F/G use it only as a dispatcher; B's code path below is unchanged.
  if (serviceOwnsDownfade(role)) {
    return runEthDownfadeServiceWhenExplicitlyEnabled({ market: input.market, exchangeIndex: input.exchangeIndex });
  }

  let currentMove: number | null = null;
  let p95: number | null = null;
  let p99: number | null = null;
  let signalRejectionReason: string | null = null;
  const finish = <T extends EthJumpLiveOutcome>(outcome: T, rejectionReason: string | null = null): T => {
    logger.info({ ticker: input.market.ticker, currentMove, p95, p99, outcome,
      rejectionReason: rejectionReason ?? signalRejectionReason }, "ETH Jump evaluation");
    return outcome;
  };

  if (!isEthJumpServiceExecutionPermitted(role)) return finish("disabled", "execution_not_permitted");
  const intent = await prepareEthJumpServiceIntent({
    store: input.store, market: input.market,
    onEvaluation: (observation) => {
      currentMove = observation.currentMove; p95 = observation.p95; p99 = observation.p99;
      signalRejectionReason = observation.rejectionReason;
    },
  });
  if (!intent) return finish("no_signal");
  if (input.exchangeIndex == null || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) {
    return finish("routing_unavailable", "invalid_exchange_index");
  }
  try { await ensureStoreReady(); }
  catch { return finish("storage_unavailable", "execution_store_unavailable"); }
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  if (requestedRiskCents < 1) return finish("capital_unavailable", "invalid_requested_risk");
  const flagEnabled = isBkFreshBalanceCapitalPolicyEnabled();
  const capitalBase = flagEnabled ? null : await readApprovedEthBigBetCapitalBase(input.exchangeIndex);
  if (!flagEnabled && !capitalBase) return finish("capital_unavailable", "capital_base_unavailable");
  const oldCapital = capitalBase ? evaluateEthAccountCapital({ ...capitalBase, requestedRiskCents }) : null;
  const freshAvailableBalanceCents = flagEnabled
    ? await readBkFreshSameShardBalance(input.exchangeIndex)
    : capitalBase!.availableBalanceCents;
  const admission = evaluateBkCapitalAdmission({ service: "B", ticker: input.market.ticker, exchangeIndex: input.exchangeIndex,
    requestedRiskCents, freshAvailableBalanceCents,
    oldPolicyDecision: flagEnabled ? "unavailable" : oldCapital!.allowed ? "allow" : oldCapital!.reason === "invalid_input" ? "unavailable" : "block",
    oldPolicyBlocker: flagEnabled ? "not_evaluated_flagged_fresh_balance_policy" : oldCapital!.allowed ? null : oldCapital!.reason });
  if (!admission.finalAllowed) {
    logger.info(bkCapitalTelemetry(admission, "not_attempted"), "BK capital admission");
    return finish(admission.finalDecision === "unavailable" ? "capital_unavailable" : "capital_blocked",
      admission.flagEnabled ? `bk_fresh_balance_${admission.newPolicyDecision}` : (oldCapital!.allowed ? null : oldCapital!.reason));
  }
  const exchange = createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return finish("routing_unavailable", "exchange_route_unavailable");
  const executionCapital = flagEnabled
    ? { availableBalanceCents: freshAvailableBalanceCents!, martingaleReserveCents: 0, safetyReserveCents: 0, otherBigBetReservedCents: 0 }
    : capitalBase!;
  const outcome = await submitEthBigBetIntent({ intent, store: ethBigBetExecutionStore, exchange, capital: executionCapital, requestedRiskCents });
  logger.info(bkCapitalTelemetry(admission, outcome), "BK capital admission");
  const rejectionReason = outcome === "submitted" ? null
    : outcome === "blocked_duplicate" ? "duplicate_strategy_market"
    : outcome === "blocked_invalid_size" ? "invalid_order_size"
    : outcome === "capital_blocked" ? "capital_guard_blocked"
    : outcome === "reservation_failed" ? "durable_reservation_failed"
    : outcome === "submission_unknown" ? "exchange_submission_unknown"
    : outcome === "rejected" ? "exchange_rejected_reason_not_exposed_by_executor" : outcome;
  return finish(outcome, rejectionReason);
}
