// Fail-closed, independent order coordination for SOL/XRP/DOGE G.
// No live credentials or network client here. The caller supplies send() and
// must gate live trading separately; review-only until full deployment validation.
import {assertAsset,G_STAKES_CENTS} from "./multiAssetGCore.mjs";
import {reserveAssetG} from "./multiAssetGStore.mjs";
export async function submitAssetG({pool,asset,ticker,side,orderId,askCents,feeCents=0,send,enabled=false}){
 const series=assertAsset(asset);
 if(!enabled)return {state:"disabled",reason:"multi_asset_g_live_disabled"};
 if(!pool||!ticker?.startsWith(series+"-")||!["yes","no"].includes(side)||
    !orderId||typeof send!=="function"||!Number.isInteger(askCents)||
    askCents<1||askCents>99||!Number.isInteger(feeCents)||feeCents<0)
    throw Error("invalid_multi_asset_g_submission");
 // A durable reservation must precede any exchange POST, and it is never
 // released for ambiguous errors or unknown fills.
 const reserved=await reserveAssetG(pool,{asset,orderId,ticker,side});
 const conservativeFeeCents=Math.ceil(0.07*askCents*(100-askCents)/100);
 const total=askCents+Math.max(feeCents,conservativeFeeCents);
 const contracts=Math.floor(reserved.stakeCents/total);
 if(!Number.isSafeInteger(contracts)||contracts<1)
   return {state:"held",reason:"reserved_without_affordable_contract",orderId};
 try{
  const response=await send({asset,clientOrderId:orderId,ticker,side,contracts,askCents});
  return {state:"held",reason:"await_authenticated_exchange_recovery",orderId,
   exchangeOrderId:response?.exchangeOrderId??null};
 }catch{
  return {state:"held",reason:"ambiguous_exchange_submission_requires_recovery",orderId};
 }
}
