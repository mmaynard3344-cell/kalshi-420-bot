// Durable BTC settlement application: requires independently verified exchange evidence.
// Does not poll exchanges or place orders; callers must provide authenticated records.
import {verifyBtcSettlementEvidence} from "./btcSettlementEvidence.mjs";
import {recordBtcFilled,recordBtcVerifiedZeroFill,recordBtcVerifiedSettlement} from "./btcSharedLadderStore.mjs";
export async function applyBtcSettlementEvidence({pool,reservation,order,fills,market}){
 const proof=verifyBtcSettlementEvidence({reservation,order,fills,market});
 if(!proof.ready)return {applied:false,reason:proof.reason};
 if(!pool)throw Error("BTC ladder database missing");
 if(proof.kind==="ZERO_FILL"){
  await recordBtcVerifiedZeroFill(pool,reservation.clientOrderId);
  return {applied:true,kind:"ZERO_FILL"};
 }
 const settlementId=reservation.clientOrderId;
 await recordBtcFilled(pool,reservation.clientOrderId,settlementId);
 const result=await recordBtcVerifiedSettlement(pool,settlementId,proof.kind);
 return {applied:!result.alreadyProcessed,kind:proof.kind,step:result.step};
}
