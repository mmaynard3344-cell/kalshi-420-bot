// Authenticated, single-order recovery. No order submissions.
// All absent/truncated exchange evidence leaves the persistent ladder held.
import {loadBtcPendingIdentity,attachBtcExchangeOrderId} from "./btcSharedLadderStore.mjs";
import {applyBtcSettlementEvidence} from "./btcSettlementWriter.mjs";
export async function reconcilePendingBtcOrder({pool,authJson,publicJson,publicBase}){
 const reservation=await loadBtcPendingIdentity(pool);
 if(!reservation)return {state:"idle"};
 if(!reservation.exchangeOrderId)return {state:"held",reason:"exchange_order_id_not_persisted"};
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
