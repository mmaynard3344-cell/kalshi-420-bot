// Fail-closed execution boundary adapted from BTC G's durable reservation pattern.
// Does not contain credentials; dependencies are injected and review-only.
import {stake} from "./core.mjs";
export async function submitEthG({state,orderId,ticker,side,askCents,feeCents=0,
 reserve,recordExchangeId,send,maxContracts=10000}){
 if(!state||!Number.isInteger(state.step)||state.pendingOrderId||!orderId||
 !/^KXETH15M-/.test(ticker)||!["yes","no"].includes(side)||
 !Number.isInteger(askCents)||askCents<1||askCents>99||
 !Number.isInteger(feeCents)||feeCents<0||
 [reserve,recordExchangeId,send].some(fn=>typeof fn!=="function"))throw Error("invalid_eth_g_submission");
 const principal=stake(state.step);
 const price=askCents+feeCents;
 const contracts=Math.min(maxContracts,Math.floor(principal/price));
 if(!Number.isSafeInteger(contracts)||contracts<1)
  return {kind:"skipped",reason:"insufficient_principal_to_buy_one_contract"};
 // This callback must atomically persist state and client ID before any HTTP POST.
 const reserved=await reserve({orderId,ticker,side,step:state.step});
 if(!reserved||reserved.clientOrderId!==orderId||reserved.step!==state.step||reserved.stakeCents!==principal)
  return {kind:"held",reason:"reservation_state_changed"};
 try{
  const ack=await send({orderId,ticker,side,contracts,askCents});
  if(ack?.exchangeOrderId)await recordExchangeId({orderId,exchangeOrderId:ack.exchangeOrderId});
  return {kind:ack?.kind==="accepted"?"submitted":"held",reason:ack?.kind==="accepted"?null:"exchange_reconciliation_required",orderId};
 }catch{
  // Never resubmit on ambiguity, timeout, HTTP rejection or restart.
  return {kind:"held",reason:"exchange_reconciliation_required",orderId};
 }
}
