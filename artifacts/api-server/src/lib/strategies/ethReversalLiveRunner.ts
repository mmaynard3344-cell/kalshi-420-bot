import { logger } from "../logger.js";
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
import { scheduleEthSignalEvidence } from "./ethSignalEvidenceLedger.js";
import { bkCapitalTelemetry, evaluateBkCapitalAdmission, isBkFreshBalanceCapitalPolicyEnabled, readBkFreshSameShardBalance } from "./bkFreshBalanceCapitalPolicy.js";

export const ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = true;
export function isEthReversalServiceExecutionPermitted(role = currentEthServiceRole()): boolean {
  const enablement = currentEthServiceEnablement();
  return ETH_REVERSAL_SERVICE_EXECUTION_APPROVED && enablement.valid
    && enablement.mode === "reversal_live_requested" && serviceOwnsReversal(role)
    && process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"] === "true";
}
type ReversalEvidenceStore = Parameters<typeof prepareEthReversalServiceIntent>[0]["store"];
type ReversalOutcome = "disabled"|"no_signal"|"capital_unavailable"|"capital_blocked"|"routing_unavailable"|"storage_unavailable"|"submitted"|"blocked_duplicate"|"blocked_invalid_size"|"reservation_failed"|"submission_unknown"|"rejected";
let storeReady: Promise<void>|null=null;
async function ensureStoreReady(){storeReady??=initEthBigBetStore();return storeReady;}

export async function runEthReversalServiceWhenExplicitlyEnabled(input:{store:ReversalEvidenceStore;market:Eth420CandidateMarket;exchangeIndex:number|null|undefined;}):Promise<ReversalOutcome>{
  let priorOutcomes:Array<"yes"|"no"|"missing_or_conflict">=[];
  let consecutiveNoOutcomes:number|null=null,currentMove:number|null=null,p95:number|null=null,p99:number|null=null,signalRejectionReason:string|null=null;
  const finish=<T extends ReversalOutcome>(outcome:T,rejectionReason:string|null=null):T=>{
    const reason=rejectionReason??signalRejectionReason;
    logger.info({ticker:input.market.ticker,priorOutcomes,consecutiveNoOutcomes,currentMove,p95,p99,outcome,rejectionReason:reason},"ETH Reversal evaluation");
    scheduleEthSignalEvidence({serviceRole:"reversal_c",ticker:input.market.ticker,marketOpenTimeMs:input.market.openTimeMs,observedAtMs:input.market.observedAtMs,currentFloorStrike:input.market.floorStrike,currentMove,p95,p99,rejectionReason:reason,outcome,evidence:{priorOutcomes,consecutiveNoOutcomes}});
    return outcome;
  };
  if(!isEthReversalServiceExecutionPermitted())return finish("disabled","execution_not_permitted");
  const {getWindowLog}=await import("../windowLog.js");
  const intent=await prepareEthReversalServiceIntent({store:input.store,market:input.market,windowEntries:getWindowLog(),onEvaluation:(context)=>{priorOutcomes=context.priorOutcomes;consecutiveNoOutcomes=context.consecutiveNoOutcomes;currentMove=context.currentMove;p95=context.p95;p99=context.p99;signalRejectionReason=context.rejectionReason;}});
  if(!intent)return finish("no_signal",signalRejectionReason??"signal_not_qualified");
  if(input.exchangeIndex==null||!Number.isInteger(input.exchangeIndex)||input.exchangeIndex<0)return finish("routing_unavailable","invalid_exchange_index");
  const requestedRiskCents=ethBigBetCapitalRiskCents(intent.wagerCents,intent.limitPriceCents);if(requestedRiskCents<1)return finish("capital_unavailable","invalid_requested_risk");
  const flagEnabled=isBkFreshBalanceCapitalPolicyEnabled();const capitalBase=flagEnabled?null:await readApprovedEthBigBetCapitalBase(input.exchangeIndex);if(!flagEnabled&&!capitalBase)return finish("capital_unavailable","capital_base_unavailable");const oldCapital=capitalBase?evaluateEthAccountCapital({...capitalBase,requestedRiskCents}):null;const freshAvailableBalanceCents=flagEnabled?await readBkFreshSameShardBalance(input.exchangeIndex):capitalBase!.availableBalanceCents;const admission=evaluateBkCapitalAdmission({service:"C",ticker:input.market.ticker,exchangeIndex:input.exchangeIndex,requestedRiskCents,freshAvailableBalanceCents,oldPolicyDecision:flagEnabled?"unavailable":oldCapital!.allowed?"allow":oldCapital!.reason==="invalid_input"?"unavailable":"block",oldPolicyBlocker:flagEnabled?"not_evaluated_flagged_fresh_balance_policy":oldCapital!.allowed?null:oldCapital!.reason});if(!admission.finalAllowed){logger.info(bkCapitalTelemetry(admission,"not_attempted"),"BK capital admission");return finish(admission.finalDecision==="unavailable"?"capital_unavailable":"capital_blocked",admission.flagEnabled?`bk_fresh_balance_${admission.newPolicyDecision}`:(oldCapital!.allowed?null:oldCapital!.reason));}
  const exchange=createEthBigBetKalshiSubmitter(input.exchangeIndex);if(!exchange)return finish("routing_unavailable","exchange_route_unavailable");
  try{await ensureStoreReady();}catch{return finish("storage_unavailable","execution_store_unavailable");}
  const outcome=await submitEthBigBetIntent({intent,store:ethBigBetExecutionStore,exchange,capital:flagEnabled?{availableBalanceCents:freshAvailableBalanceCents!,martingaleReserveCents:0,safetyReserveCents:0,otherBigBetReservedCents:0}:capitalBase!,requestedRiskCents});logger.info(bkCapitalTelemetry(admission,outcome),"BK capital admission");
  return finish(outcome,outcome==="submitted"?null:outcome==="rejected"?"exchange_rejected_reason_not_exposed_by_executor":outcome);
}
