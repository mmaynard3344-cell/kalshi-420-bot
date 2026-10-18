// Order lifecycle orchestration: read-only recovery, then optional guarded submission.
// Requires externally supplied persistent pool and authenticated Kalshi client.
import {randomUUID} from "node:crypto";
import {getPendingEthG,attachEthGExchangeOrderId} from "./store.mjs";
import {recoverPendingEthG} from "./recoveryCoordinator.mjs";
import {submitEvaluatedEthG} from "./liveCoordinator.mjs";
import {orderPayload} from "./authClient.mjs";
export async function runEthGLifecycle({pool,authJson,marketJson,evaluation,askCents,feeCents=0,liveEnabled=false,idFactory=randomUUID}){
 if(!pool||typeof authJson!=="function"||typeof marketJson!=="function")throw Error("missing_lifecycle_dependencies");
 const pending=await getPendingEthG(pool);
 if(pending){
  const recovery=await recoverPendingEthG({pool,authJson,marketJson});
  // Never place a new order in the same tick as recovery.
  return {status:"recovery",...recovery};
 }
 if(evaluation?.status!=="ready")return {status:"evaluation",reason:evaluation?.reason??"not_ready"};
 if(!liveEnabled || process.env.ETH_G_V2_LIVE_TRADING!=="true")
  return {status:"shadow",reason:"live_order_submission_disabled",side:evaluation.side,ticker:evaluation.ticker};
 const clientOrderId=idFactory();
 return submitEvaluatedEthG({pool,evaluation,orderId:clientOrderId,askCents,feeCents,
  send:async({orderId,ticker,side,contracts,askCents:price})=>{
   const payload=orderPayload({ticker,side,clientOrderId:orderId,contracts,askCents:price});
   const response=await authJson("POST","/portfolio/events/orders",payload);
   const exchangeOrderId=response?.order?.order_id??response?.order_id;
   if(!exchangeOrderId)return {kind:"uncertain"};
   return {kind:"accepted",exchangeOrderId};
  },
  recordExchangeId:async({orderId,exchangeOrderId})=>attachEthGExchangeOrderId(pool,{clientOrderId:orderId,exchangeOrderId})
 });
}
