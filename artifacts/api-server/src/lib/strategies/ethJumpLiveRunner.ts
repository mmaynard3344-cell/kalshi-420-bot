import { logger } from "../logger.js";
import {reconcileBSharedJournalCycle} from "./ethJumpSharedLifecycle.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthJumpServiceIntent } from "./ethJumpServiceRuntime.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { currentEthServiceEnablement } from "./ethServiceEnablementContract.js";
import { currentEthServiceRole, serviceOwnsJump } from "./ethServiceRole.js";
import { scheduleEthSignalEvidence } from "./ethSignalEvidenceLedger.js";
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
type EthJumpLiveOutcome =
  | "disabled" | "no_signal" | "capital_unavailable" | "capital_blocked"
  | "routing_unavailable" | "storage_unavailable" | "submitted"
  | "blocked_duplicate" | "blocked_invalid_size" | "reservation_failed"
  | "submission_unknown" | "rejected";

let storeReady: Promise<void> | null = null;
async function ensureStoreReady(): Promise<void> { storeReady ??= initEthBigBetStore(); return storeReady; }

export async function runEthJumpServiceWhenExplicitlyEnabled(input: {
  store: JumpEvidenceStore;
  market: Eth420CandidateMarket;
  exchangeIndex: number | null | undefined;
}): Promise<EthJumpLiveOutcome> {
  let currentMove: number | null = null;
  let p95: number | null = null;
  let p99: number | null = null;
  let signalRejectionReason: string | null = null;

  const finish = <T extends EthJumpLiveOutcome>(outcome: T, rejectionReason: string | null = null): T => {
    const reason = rejectionReason ?? signalRejectionReason;
    logger.info({ ticker: input.market.ticker, currentMove, p95, p99, outcome, rejectionReason: reason }, "ETH Jump evaluation");
    scheduleEthSignalEvidence({
      serviceRole: "jump_b",
      ticker: input.market.ticker,
      marketOpenTimeMs: input.market.openTimeMs,
      observedAtMs: input.market.observedAtMs,
      currentFloorStrike: input.market.floorStrike,
      currentMove,
      p95,
      p99,
      rejectionReason: reason,
      outcome,
    });
    return outcome;
  };

  if (!isEthJumpServiceExecutionPermitted()) return finish("disabled", "execution_not_permitted");
  const intent = await prepareEthJumpServiceIntent({
    store: input.store,
    market: input.market,
    onEvaluation: (observation) => {
      currentMove = observation.currentMove;
      p95 = observation.p95;
      p99 = observation.p99;
      signalRejectionReason = observation.rejectionReason;
    },
  });
  if (!intent) return finish("no_signal");
  if (input.exchangeIndex == null || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0) return finish("routing_unavailable", "invalid_exchange_index");
  try { await ensureStoreReady(); } catch { return finish("storage_unavailable", "execution_store_unavailable"); }
  // A service must never fall back to its independent stake when the global
  // ETH shared-ladder cutover is requested but this executor is not bridged.
  // The shared claim, order identity, and exchange settlement must be wired
  // together before this gate can be replaced by the shared execution adapter.
  if(process.env["ETH_SHARED_MARTINGALE_ENABLED"]==="true"){
    // The shared journal reconciles first. B submission remains fail-closed
    // until the all-ETH coordinated cutover and production migration.
    try {
      const reconciliation=await reconcileBSharedJournalCycle();
      logger.info({ticker:input.market.ticker,reconciliation},"B shared ETH journal reconciliation");
    } catch(error) {
      logger.error({ticker:input.market.ticker,error:String(error)},"B shared ETH reconciliation unavailable; no order submitted");
      return finish("storage_unavailable","shared_reconciliation_unavailable");
    }
    // Explicit second activation gate: never enable this before every ETH
    // executor has the same shared claim fence and migrations are verified.
    if(process.env["ETH_B_SHARED_SUBMISSION_READY"]==="true"){
      const exchange=createEthBigBetKalshiSubmitter(input.exchangeIndex);
      if(!exchange)return finish("routing_unavailable","shared_exchange_unavailable");
      try{
        const submission=await submitBViaSharedEthClaim({
          intent,exchange,
          estimatedFeeCents:(contracts)=>Math.ceil(0.07*contracts*intent.limitPriceCents*(100-intent.limitPriceCents)/100),
        });
        logger.info({ticker:intent.ticker,kind:submission.kind},"B shared ETH submit result");
        return finish(submission.kind==="held"?"submitted":submission.kind==="skipped"?"blocked_duplicate":"submission_unknown");
      }catch(error){
        logger.error({ticker:intent.ticker,error:String(error)},"B shared ETH submission held for reconciliation");
        return finish("submission_unknown","shared_submission_error");
      }
    }
    logger.error({ticker:input.market.ticker,service:"B"},
      "ETH B shared cutover requested, but execution adapter not installed; fail closed");
    return finish("disabled","shared_eth_adapter_not_installed");
  }
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  if (requestedRiskCents < 1) return finish("capital_unavailable", "invalid_requested_risk");
  const flagEnabled = isBkFreshBalanceCapitalPolicyEnabled();
  const capitalBase = flagEnabled ? null : await readApprovedEthBigBetCapitalBase(input.exchangeIndex);
  if (!flagEnabled && !capitalBase) return finish("capital_unavailable", "capital_base_unavailable");
  const oldCapital = capitalBase ? evaluateEthAccountCapital({ ...capitalBase, requestedRiskCents }) : null;
  const freshAvailableBalanceCents = flagEnabled ? await readBkFreshSameShardBalance(input.exchangeIndex) : capitalBase!.availableBalanceCents;
  const admission = evaluateBkCapitalAdmission({ service: "B", ticker: input.market.ticker, exchangeIndex: input.exchangeIndex, requestedRiskCents, freshAvailableBalanceCents,
    oldPolicyDecision: flagEnabled ? "unavailable" : oldCapital!.allowed ? "allow" : oldCapital!.reason === "invalid_input" ? "unavailable" : "block",
    oldPolicyBlocker: flagEnabled ? "not_evaluated_flagged_fresh_balance_policy" : oldCapital!.allowed ? null : oldCapital!.reason });
  if (!admission.finalAllowed) { logger.info(bkCapitalTelemetry(admission, "not_attempted"), "BK capital admission"); return finish(admission.finalDecision === "unavailable" ? "capital_unavailable" : "capital_blocked", admission.flagEnabled ? `bk_fresh_balance_${admission.newPolicyDecision}` : (oldCapital!.allowed ? null : oldCapital!.reason)); }
  const exchange = createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) return finish("routing_unavailable", "exchange_route_unavailable");
  const executionCapital = flagEnabled ? { availableBalanceCents: freshAvailableBalanceCents!, martingaleReserveCents: 0, safetyReserveCents: 0, otherBigBetReservedCents: 0 } : capitalBase!;
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
