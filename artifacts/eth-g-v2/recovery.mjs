// Authenticated, read-only order/settlement recovery for ETH G v2.
// Never infer zero fills from absence and never submit replacement orders.
export async function reconcileEthG({pending,authJson,marketJson}){
 if(!pending)return {state:"idle"};
 if(!pending.clientOrderId||!/^KXETH15M-/.test(pending.ticker)||!["yes","no"].includes(pending.side))throw Error("invalid_pending_identity");
 if(typeof authJson!=="function"||typeof marketJson!=="function")throw Error("missing_exchange_reader");
 let exchangeOrderId=pending.exchangeOrderId??null;
 if(!exchangeOrderId){
  let cursor=null,found=null,complete=false;
  for(let page=0;page<50;page++){
   const data=await authJson("GET","/portfolio/orders?limit=100"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
   if(!Array.isArray(data?.orders))return {state:"held",reason:"order_history_unavailable"};
   found=data.orders.find(o=>o.client_order_id===pending.clientOrderId&&o.ticker===pending.ticker);
   if(found)break;
   const next=String(data.cursor??"");
   if(!next){complete=true;break}
   if(next===cursor)return {state:"held",reason:"order_cursor_stalled"};
   cursor=next;
  }
  if(!found)return {state:"held",reason:complete?"order_absent_unverified":"order_history_truncated"};
  exchangeOrderId=found.order_id;
  if(!exchangeOrderId)return {state:"held",reason:"exchange_order_id_missing"};
 }
 const data=await authJson("GET","/portfolio/orders/"+encodeURIComponent(exchangeOrderId));
 const order=data?.order??data;
 if(order?.order_id!==exchangeOrderId||order?.client_order_id!==pending.clientOrderId||order?.ticker!==pending.ticker)
  return {state:"held",reason:"order_identity_mismatch"};
 if(order.side!=null && order.side!==pending.side)return {state:"held",reason:"order_side_mismatch"};
 // Market settlement alone does not prove a partially filled GTC order is closed.
 // Never advance while the exchange can still fill the remaining contracts.
 if(!["executed","canceled","cancelled","filled","closed"].includes(String(order.status??"").toLowerCase()))
  return {state:"held",reason:"exchange_order_not_final"};
 let cursor=null;const fills=[];let completed=false;
 for(let page=0;page<50;page++){
  const payload=await authJson("GET","/portfolio/fills?order_id="+encodeURIComponent(exchangeOrderId)+"&limit=200"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
  if(!Array.isArray(payload?.fills))return {state:"held",reason:"fills_unavailable"};
  if(payload.fills.some(f=>f.order_id!==exchangeOrderId||f.ticker!==pending.ticker))return {state:"held",reason:"fill_identity_mismatch"};
  fills.push(...payload.fills);
  const next=String(payload.cursor??"");
  if(!next){completed=true;break}
  if(next===cursor)return {state:"held",reason:"fill_cursor_stalled"};
  cursor=next;
 }
 if(!completed)return {state:"held",reason:"fills_truncated"};
 const filled=fills.reduce((sum,f)=>sum+Number(f.count??NaN),0);
 if(!Number.isSafeInteger(filled)||filled<0)return {state:"held",reason:"invalid_fills"};
 if(filled===0)return {state:"held",reason:"zero_fill_requires_exchange_finality"};
 const marketRaw=await marketJson(pending.ticker),market=marketRaw?.market??marketRaw;
 if(market?.ticker!==pending.ticker||!["yes","no"].includes(market.result))
  return {state:"held",reason:"settlement_not_final"};
 return {state:"verified",clientOrderId:pending.clientOrderId,exchangeOrderId,filledContracts:filled,
  settlementId:exchangeOrderId,outcome:market.result===pending.side?"win":"loss"};
}
