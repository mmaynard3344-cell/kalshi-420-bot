// Recovery-first. All exchange reads are authenticated, no orders sent here.
import {getPendingAssetG,recordAssetGExchangeId,recordVerifiedAssetGFill,settleVerifiedAssetG} from "./multiAssetGStore.mjs";
import {verifyAssetGSettlement} from "./multiAssetGReconciliation.mjs";
export async function recoverAssetG({pool,asset,authJson,publicJson,publicBase}){
 const pending=await getPendingAssetG(pool,asset);
 if(!pending)return {state:"idle",asset};
 let exchangeOrderId=pending.exchangeOrderId;
 if(!exchangeOrderId){
  let cursor=null,found=null,complete=false;
  for(let page=0;page<50;page++){
   const r=await authJson("GET","/portfolio/orders?limit=100"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
   if(!Array.isArray(r?.orders))return {state:"held",reason:"order_history_unavailable",asset};
   found=r.orders.find(x=>x.client_order_id===pending.orderId&&x.ticker===pending.ticker);
   if(found)break;
   const next=r.cursor??"";
   if(!next){complete=true;break}
   if(next===cursor)return {state:"held",reason:"order_history_cursor_stalled",asset};
   cursor=next;
  }
  if(!found)return {state:"held",asset,reason:complete?"order_not_found_unverified":"order_history_truncated"};
  exchangeOrderId=found.order_id;
  if(!exchangeOrderId)return {state:"held",asset,reason:"exchange_id_unverified"};
 }
 const proof=await verifyAssetGSettlement({asset,clientOrderId:pending.orderId,ticker:pending.ticker,exchangeOrderId,authJson,publicJson,publicBase});
 if(proof.state!=="verified")return {...proof,asset};
 await recordAssetGExchangeId(pool,{asset,orderId:pending.orderId,exchangeOrderId});
 await recordVerifiedAssetGFill(pool,{asset,orderId:pending.orderId,exchangeOrderId,filledContracts:proof.filledContracts});
 const next=await settleVerifiedAssetG(pool,{asset,orderId:pending.orderId,settlementId:proof.settlementId,result:proof.outcome});
 return {state:"settled",asset,...next};
}
