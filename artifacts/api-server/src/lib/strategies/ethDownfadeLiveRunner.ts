import { logger } from "../logger.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { prepareEthDownfadeServiceIntent } from "./ethDownfadeServiceRuntime.js";
import { ETH_DOWNFADE_CONFIG, isEthDownfadeRole, type EthDownfadeRole } from "./ethDownfadeSignal.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethDownfadeExecutionStore, initEthDownfadeExecutionStore } from "./ethDownfadeExecutionStore.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { currentEthServiceEnablement } from "./ethServiceEnablementContract.js";
import { currentEthServiceRole } from "./ethServiceRole.js";
import { scheduleEthSignalEvidence } from "./ethSignalEvidenceLedger.js";

export const ETH_DOWNFADE_SERVICE_EXECUTION_APPROVED = true;
export type EthDownfadeLiveOutcome = "disabled"|"no_signal"|"capital_unavailable"|"capital_blocked"|"routing_unavailable"|"storage_unavailable"|"submitted"|"blocked_duplicate"|"blocked_invalid_size"|"reservation_failed"|"submission_unknown"|"rejected";

let storeReady: Promise<void> | null = null;
async function ensureStoreReady(): Promise<void> {
  if (!storeReady) {
    storeReady = initEthDownfadeExecutionStore().catch((err) => {
      storeReady = null;
      throw err;
    });
  }
  return storeReady;
}

export function isEthDownfadeServiceExecutionPermitted(role = currentEthServiceRole()): role is EthDownfadeRole {
  const enablement=currentEthServiceEnablement();
  return ETH_DOWNFADE_SERVICE_EXECUTION_APPROVED&&isEthDownfadeRole(role)&&enablement.valid&&enablement.mode==="downfade_live_requested"&&process.env["ETH_DOWNFADE_SERVICE_LIVE_ENABLED"]==="true";
}

export async function runEthDownfadeServiceWhenExplicitlyEnabled(input:{market:Eth420CandidateMarket;exchangeIndex:number|null|undefined;}):Promise<EthDownfadeLiveOutcome>{
  const role=currentEthServiceRole(); let currentMove:number|null=null,direction:string|null=null,p80:number|null=null,p90:number|null=null,p95:number|null=null,p99:number|null=null,validObservationCount=0; let signalRejectionReason:string|null=null;
  const finish=<T extends EthDownfadeLiveOutcome>(outcome:T,rejectionReason:string|null=null):T=>{
    const reason=rejectionReason??signalRejectionReason;
    logger.info({serviceRole:role,wagerCents:isEthDownfadeRole(role)?ETH_DOWNFADE_CONFIG[role].wagerCents:null,ticker:input.market.ticker,currentMove,direction,p80,p90,p95,p99,validObservationCount,outcome,rejectionReason:reason},"ETH Downfade evaluation");
    scheduleEthSignalEvidence({serviceRole:String(role),ticker:input.market.ticker,marketOpenTimeMs:input.market.openTimeMs,observedAtMs:input.market.observedAtMs,currentFloorStrike:input.market.floorStrike,currentMove,direction,p80,p90,p95,p99,sampleCount:validObservationCount,rejectionReason:reason,outcome});
    return outcome;
  };
  if(!isEthDownfadeServiceExecutionPermitted(role))return finish("disabled","execution_not_permitted");
  const intent=await prepareEthDownfadeServiceIntent({role,market:input.market,onEvaluation:(observation)=>{currentMove=observation.currentMove;direction=observation.direction;p80=observation.p80;p90=observation.p90;p95=observation.p95;p99=observation.p99;validObservationCount=observation.validObservationCount;signalRejectionReason=observation.rejectionReason;}});
  if(!intent)return finish("no_signal");
  if(input.exchangeIndex==null||!Number.isInteger(input.exchangeIndex)||input.exchangeIndex<0)return finish("routing_unavailable","invalid_exchange_index");
  try{await ensureStoreReady();}catch{return finish("storage_unavailable","execution_store_unavailable");}
  const capitalBase=await readApprovedEthBigBetCapitalBase(input.exchangeIndex);if(!capitalBase)return finish("capital_unavailable","capital_base_unavailable");
  const requestedRiskCents=ethBigBetCapitalRiskCents(intent.wagerCents,intent.limitPriceCents);if(requestedRiskCents<1)return finish("capital_unavailable","invalid_requested_risk");
  const capital=evaluateEthAccountCapital({...capitalBase,requestedRiskCents});if(!capital.allowed)return finish(capital.reason==="invalid_input"?"capital_unavailable":"capital_blocked",capital.reason);
  const exchange=createEthBigBetKalshiSubmitter(input.exchangeIndex);if(!exchange)return finish("routing_unavailable","exchange_route_unavailable");
  const outcome=await submitEthBigBetIntent({intent,store:ethDownfadeExecutionStore,exchange,capital:capitalBase,requestedRiskCents});
  const rejectionReason=outcome==="submitted"?null:outcome==="blocked_duplicate"?"duplicate_strategy_market":outcome==="blocked_invalid_size"?"invalid_order_size":outcome==="capital_blocked"?"capital_guard_blocked":outcome==="reservation_failed"?"durable_reservation_failed":outcome==="submission_unknown"?"exchange_submission_unknown":outcome==="rejected"?"exchange_rejected_reason_not_exposed_by_executor":outcome;
  return finish(outcome,rejectionReason);
}
