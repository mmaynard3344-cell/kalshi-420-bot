/**
 * BTC B–L order submission boundary (review-only).
 * Its dependencies are injected so that tests never contact Kalshi.
 * Caller must supply an authenticated final order-status/fill reconciler.
 */
import {reserveBtcWager} from "./btcSharedLadderStore.mjs";
import {sizeBtcOrder} from "./btcSharedLadder.mjs";
export async function submitReservedBtcOrder({pool,orderId,askCents,feeCents,maxContracts=10000,send}){
 if(!orderId||typeof send!=="function")throw Error("missing BTC order dependency");
 if(!Number.isInteger(askCents)||askCents<1||askCents>99)throw Error("invalid ask");
 // Reservation is durable and committed BEFORE any API POST.
 const reservation=await reserveBtcWager(pool,orderId);
 const sizing=sizeBtcOrder({step:[100,200,400,800,1600,3200].indexOf(reservation.stakeCents)},askCents,feeCents,maxContracts);
 if(sizing.contracts<1) {
   // Do not release a reservation here: there is no verified zero-fill from the exchange.
   return {kind:"held",reason:"no_affordable_contract",orderId};
 }
 try{
  const ack=await send({orderId,contracts:sizing.contracts,totalCents:sizing.totalCents});
  if(!ack||!["accepted","rejected","uncertain"].includes(ack.kind))return {kind:"held",reason:"unknown_exchange_ack",orderId};
  return {kind:ack.kind==="accepted"?"submitted":"held",reason:ack.kind==="accepted"?null:"exchange_reconciliation_required",orderId,exchangeOrderId:ack.exchangeOrderId??null};
 }catch{
  return {kind:"held",reason:"exchange_reconciliation_required",orderId};
 }
}
