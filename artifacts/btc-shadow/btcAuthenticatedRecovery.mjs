// Authenticated, single-order recovery. No order submissions.
// All absent/truncated exchange evidence leaves the persistent ladder held.
import {loadBtcPendingIdentity,attachBtcExchangeOrderId,recordBtcVerifiedZeroFill} from "./btcSharedLadderStore.mjs";
import {applyBtcSettlementEvidence} from "./btcSettlementWriter.mjs";
export async function reconcilePendingBtcOrder({pool,authJson,publicJson,publicBase}){
 const reservation=await loadBtcPendingIdentity(pool);
 if(!reservation)return {state:"idle"};
 if(!reservation.exchangeOrderId){
  // A network timeout can lose the POST acknowledgement. Search authenticated
  // order history for the deterministic client ID; never issue another POST.
  let cursor=null,found=null,complete=false;
  for(let page=0;page<50;page++){
   const path="/portfolio/orders?limit=100"+(cursor?"&cursor="+encodeURIComponent(cursor):"");
   const data=await authJson("GET",path);
   if(!Array.isArray(data?.orders))return {state:"held",reason:"order_history_unavailable"};
   found=data.orders.find(o=>o.client_order_id===reservation.clientOrderId&&o.ticker===reservation.ticker);
   if(found)break;
   const next=String(data.cursor??"");
   if(!next){complete=true;break}
   if(next===cursor)return {state:"held",reason:"order_cursor_did_not_advance"};
   cursor=next;
  }
  if(!found){
   // One-time, user-authorized recovery of a specific orphaned reservation.
   // Only after exhaustive authenticated order-history pagination confirms absence.
   const approvedId="e32ca4c4-e32b-48f8-9248-fb0ee32f1981";
   const knownRejected = reservation.clientOrderId==="9ee54b6c-d656-4d1e-92ef-fe40730882c4" && reservation.ticker==="KXBTC15M-26OCT171800-00";
   // The knownRejected reservation has independently logged an explicit Kalshi
   // HTTP 400 insufficient-balance rejection. Still require exhaustive
   // authenticated order history and official settlement before release.
   if(complete && ((reservation.clientOrderId===approvedId && reservation.ticker==="KXBTC15M-26OCT171100-00") || knownRejected)){
    const marketRaw=await publicJson(publicBase+"/markets/"+encodeURIComponent(reservation.ticker));
    const market=marketRaw?.market??marketRaw;
    if(!["yes","no"].includes(String(market?.result??"").toLowerCase()))
     return {state:"held",reason:"orphan_release_market_not_settled"};
    await recordBtcVerifiedZeroFill(pool,reservation.clientOrderId);
    return {state:"released",kind:"AUTHORIZED_ORPHAN_ZERO_FILL",step:1};
   }
   return {state:"held",reason:complete?"exchange_order_not_found":"order_history_pagination_limit"};
  }
  if(!found.order_id)return {state:"held",reason:"exchange_order_id_missing"};
  await attachBtcExchangeOrderId(pool,reservation.clientOrderId,found.order_id);
  reservation.exchangeOrderId=found.order_id;
 }
 const orderRaw=await authJson("GET", "/portfolio/orders/"+encodeURIComponent(reservation.exchangeOrderId));
 const order=orderRaw?.order??orderRaw;
 if(!order||!order.order_id)return {state:"held",reason:"authenticated_order_missing"};
 const all=[];let cursor=null;
 for(let page=0;page<50;page++){
  const q="/portfolio/fills?order_id="+encodeURIComponent(reservation.exchangeOrderId)+"&limit=200"+(cursor?"&cursor="+encodeURIComponent(cursor):"");
  const data=await authJson("GET",q);
  if(!Array.isArray(data?.fills))return {state:"held",reason:"authenticated_fills_missing"};
  all.push(...data.fills);
  const next=String(data.cursor??"");
  if(!next){
   const marketRaw=await publicJson(publicBase+"/markets/"+encodeURIComponent(reservation.ticker));
   const market=marketRaw?.market??marketRaw;
   const outcome=await applyBtcSettlementEvidence({pool,reservation,order,fills:all,market});
   return outcome.applied?{state:"settled",kind:outcome.kind,step:outcome.step}:{state:"held",reason:outcome.reason??"already_reconciled"};
  }
  if(next===cursor)return {state:"held",reason:"fill_cursor_did_not_advance"};
  cursor=next;
 }
 return {state:"held",reason:"fill_history_pagination_limit"};
}
