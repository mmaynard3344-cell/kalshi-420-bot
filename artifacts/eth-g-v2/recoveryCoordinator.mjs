// Single-pending-order recovery. All ambiguous evidence fails closed.
import {getPendingEthG,attachVerifiedEthGFill,settleVerifiedEthG} from "./store.mjs";
import {reconcileEthG} from "./recovery.mjs";
export async function recoverPendingEthG({pool,authJson,marketJson}){
 const pending=await getPendingEthG(pool);
 if(!pending)return {state:"idle"};
 const evidence=await reconcileEthG({pending,authJson,marketJson});
 if(evidence.state!=="verified")return evidence;
 await attachVerifiedEthGFill(pool,{
  clientOrderId:pending.clientOrderId,
  exchangeOrderId:evidence.exchangeOrderId,
  filledContracts:evidence.filledContracts
 });
 const result=await settleVerifiedEthG(pool,{
  clientOrderId:pending.clientOrderId,
  settlementId:evidence.settlementId,
  outcome:evidence.outcome
 });
 return {state:"settled",ticker:pending.ticker,outcome:evidence.outcome,...result};
}
