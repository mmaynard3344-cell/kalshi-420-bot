/**
 * BTC B–L order submission boundary (review-only).
 * Its dependencies are injected so that tests never contact Kalshi.
 * Caller must supply an authenticated final order-status/fill reconciler.
 */
import {reserveBtcWagerWithIdentity,attachBtcExchangeOrderId} from "./btcSharedLadderStore.mjs";
import {sizeBtcOrder,initialBtcLadder} from "./btcSharedLadder.mjs";
export async function submitReservedBtcOrder({pool,orderId,ticker,side,askCents,feeCents,maxContracts=10000,send}){
 if(!orderId||typeof send!=="function")throw Error("missing BTC order dependency");
 if(!Number.isInteger(askCents)||askCents<1||askCents>99)throw Error("invalid ask");
 // At step one, even one contract must be affordable; otherwise never claim a
 // durable reservation that cannot be released by an exchange zero-fill.
 if(sizeBtcOrder(initialBtcLadder(),askCents,feeCents,maxContracts).contracts<1)
  return {kind:"skipped",reason:"no_affordable_contract_at_step_one",orderId};
 // Reservation is durable and committed BEFORE any API POST.
 const reservation=await reserveBtcWagerWithIdentity(pool,{clientOrderId:orderId,ticker,side});
 const sizing=sizeBtcOrder({step:[200,400,800,1600,3200,6400].indexOf(reservation.stakeCents)},askCents,feeCents,maxContracts);
 if(sizing.contracts<1) {
   // Do not release a reservation here: there is no verified zero-fill from the exchange.
   return {kind:"held",reason:"no_affordable_contract",orderId};
 }
 try{
  const ack=await send({orderId,contracts:sizing.contracts,totalCents:sizing.totalCents});
  if(!ack||!["accepted","rejected","uncertain"].includes(ack.kind))return {kind:"held",reason:"unknown_exchange_ack",orderId};
  if (ack.exchangeOrderId) await attachBtcExchangeOrderId(pool,orderId,ack.exchangeOrderId);
  return {kind:ack.kind==="accepted"?"submitted":"held",reason:ack.kind==="accepted"?null:"exchange_reconciliation_required",orderId,exchangeOrderId:ack.exchangeOrderId??null};
 }catch{
  return {kind:"held",reason:"exchange_reconciliation_required",orderId};
 }
}
