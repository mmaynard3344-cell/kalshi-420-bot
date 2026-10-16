import {reconcileBFromKalshi} from "./ethJumpSharedKalshiReconciler.js";
import {listUnresolvedBSharedClaims} from "./ethJumpSharedClaimJournal.js";
import type {TransactionProvider} from "../sharedEthClaimStore.js";

export type BSharedPendingOrder={
 claimId:string;clientOrderId:string;ticker:string;side:"yes"|"no";
 exchangeOrderId:string|null;
};
/** Durable source supplies unresolved B claim links. Never infer an order ID or
 * release a claim solely from an absent or failed exchange response. */
export async function reconcilePendingBSharedOrders(input:{
 listPending:()=>Promise<BSharedPendingOrder[]>;
 provider?:TransactionProvider;
}):Promise<{finalized:number;pending:number;errors:number}>{
 let finalized=0,pending=0,errors=0;
 const orders=await input.listPending();
 for(const order of orders){
  if(!order.claimId||!order.clientOrderId||!order.exchangeOrderId||!order.ticker.startsWith("KXETH15M-")){pending++;continue;}
  try{
   const result=await reconcileBFromKalshi({...order,exchangeOrderId:order.exchangeOrderId,provider:input.provider});
   if(result==="FINALIZED")finalized++;else pending++;
  }catch{errors++; /* fail closed: keep the shared reservation */ }
 }
 return {finalized,pending,errors};
}

/** Review-only entrypoint for a future B scheduler. Uses the durable shared
 * claim journal; callers must not start new shared orders after errors. */
export async function reconcileBSharedJournalCycle(provider?:TransactionProvider){
 return reconcilePendingBSharedOrders({
  listPending:()=>listUnresolvedBSharedClaims(provider),provider
 });
}
