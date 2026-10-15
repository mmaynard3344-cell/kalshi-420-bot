// Pure, fail-closed evidence check. No database writes or live orders.
export function verifyBtcSettlementEvidence({reservation,order,fills,market}){
 if(!reservation?.clientOrderId||!reservation?.ticker||!["yes","no"].includes(reservation.side))
  return {ready:false,reason:"missing_reservation_identity"};
 if(!order||String(order.client_order_id??"")!==reservation.clientOrderId||
    String(order.ticker??"")!==reservation.ticker)
  return {ready:false,reason:"order_identity_unverified"};
 const orderId=String(order.order_id??"");
 if(!orderId)return {ready:false,reason:"missing_exchange_order_id"};
 if(!["executed","canceled","cancelled","closed","filled"].includes(String(order.status??"").toLowerCase()))
  return {ready:false,reason:"order_not_terminal"};
 const reported=Number(order.fill_count_fp??order.fill_count??order.filled_count_fp??order.filled_count);
 if(!Number.isFinite(reported)||reported<0)return {ready:false,reason:"exchange_fill_count_missing"};
 if(!Array.isArray(fills))return {ready:false,reason:"fill_history_unavailable"};
 let counted=0;
 for(const fill of fills){
  if(String(fill.order_id??"")!==orderId)return {ready:false,reason:"fill_order_mismatch"};
  const n=Number(fill.count_fp??fill.count);
  if(!Number.isFinite(n)||n<=0)return {ready:false,reason:"invalid_fill_count"};
  counted+=n;
 }
 if(Math.abs(counted-reported)>1e-8)return {ready:false,reason:"incomplete_fill_history"};
 if(reported===0)return {ready:true,kind:"ZERO_FILL",orderId};
 if(!market||String(market.ticker??"")!==reservation.ticker||
    !["yes","no"].includes(String(market.result??"").toLowerCase()))
  return {ready:false,reason:"settled_market_result_missing"};
 const result=String(market.result).toLowerCase();
 return {ready:true,kind:result===reservation.side?"WIN":"LOSS",orderId,filledContracts:counted};
}
