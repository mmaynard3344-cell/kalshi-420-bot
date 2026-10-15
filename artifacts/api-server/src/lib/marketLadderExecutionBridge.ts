/**
 * Shared-ladder order-writer integration seam, not enabled in production.
 * The caller provides an initialized, healthy transaction-capable database and
 * a real order submission function. Never retries uncertain exchange responses.
 */
import {claimSizedMarketWager, type LadderDatabase} from "./marketSharedLadderStore.js";
import type {MarketLadder} from "./marketSharedLadder.js";
export type MarketLadderRequest={
 market:MarketLadder; clientOrderId:string; priceCents:number;
 maxContracts:number; feeCents:(contracts:number,priceCents:number)=>number;
};
export type OrderAck={kind:"accepted"|"rejected_zero_fill"|"uncertain";exchangeOrderId?:string};
export async function submitThroughMarketLadder(
 db:LadderDatabase,req:MarketLadderRequest,
 submit:(request:{clientOrderId:string;contracts:number;maxTotalCents:number})=>Promise<OrderAck>,
):Promise<{status:"accepted"|"uncertain"|"zero_fill"|"blocked";reason?:string;exchangeOrderId?:string}>{
 if(!req.clientOrderId)throw Error("client order ID required");
 // The durable reservation is committed before any exchange API call.
 const claim=await claimSizedMarketWager(db,req.market,req.clientOrderId,req.priceCents,req.feeCents,req.maxContracts);
 // A zero-fill rejection MUST be reconciled on the authenticated exchange
 // before releasing the reserved step. Do not release here.
 try {
   const ack=await submit({clientOrderId:req.clientOrderId,contracts:claim.contracts,maxTotalCents:claim.totalCents});
   if(ack.kind==="accepted")return {status:"accepted",exchangeOrderId:ack.exchangeOrderId};
   if(ack.kind==="rejected_zero_fill")return {status:"zero_fill",reason:"await_exchange_zero_fill_confirmation"};
   return {status:"uncertain",reason:"exchange_reconciliation_required"};
 }catch{
   return {status:"uncertain",reason:"exchange_reconciliation_required"};
 }
}
