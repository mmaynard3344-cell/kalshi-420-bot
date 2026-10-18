// Connect evaluated signal to durable reservation-first ETH G order adapter.
// No credentials or automatic invocation: runner must enforce single-worker lock.
import {submitEthG} from "./orderAdapter.mjs";
import {reserveEthG} from "./store.mjs";
export async function submitEvaluatedEthG({pool,evaluation,orderId,askCents,feeCents,send,recordExchangeId}){
 if(evaluation?.status!=="ready"||!evaluation.triggerKey||!["yes","no"].includes(evaluation.side))
  return {kind:"skipped",reason:"evaluation_not_ready"};
 if(typeof send!=="function"||typeof recordExchangeId!=="function")throw Error("exchange_adapter_missing");
 return submitEthG({
  state:{step:evaluation.step,pendingOrderId:null},orderId,
  ticker:evaluation.ticker,side:evaluation.side,askCents,feeCents,
  reserve:async({orderId,ticker,side})=>reserveEthG(pool,{clientOrderId:orderId,ticker,side,triggerKey:evaluation.triggerKey}),
  recordExchangeId,send
 });
}
