import {applyUsdSettlement,getUsdLadder,hasUnresolvedUsdOrders} from './store.mjs';
/**
 * Read-only exchange reconciliation adapter. The caller supplies authenticated
 * order lookup and public finalized market lookup. No live order submissions.
 */
export async function reconcileUsdLadder(db,{getOrder,getMarket,findOrderByClientId,now=()=>new Date().toISOString()}) {
 const state=getUsdLadder(db);
 const claims=db.query("SELECT * FROM fx_live_order_claims WHERE created_at >= ? AND status NOT IN ('ladder_won','ladder_lost','ladder_zero_fill') ORDER BY created_at ASC").all(state.activated_at);
 for(const c of claims){
   let exchangeOrderId=c.exchange_order_id;
   if(!exchangeOrderId){
     if(typeof findOrderByClientId!=='function')return {ready:false,reason:'ORDER_ID_UNKNOWN',ticker:c.ticker};
     let matched;
     try{matched=await findOrderByClientId(c.client_order_id,c.ticker)}catch{return {ready:false,reason:'ORDER_RECOVERY_FAILED',ticker:c.ticker}}
     if(!matched?.order_id || matched.client_order_id!==c.client_order_id || matched.ticker!==c.ticker)return {ready:false,reason:'ORDER_NOT_RECOVERED',ticker:c.ticker};
     exchangeOrderId=matched.order_id;
     db.query('UPDATE fx_live_order_claims SET exchange_order_id=? WHERE ticker=? AND client_order_id=?').run(exchangeOrderId,c.ticker,c.client_order_id);
   }
   let order;
   try{order=await getOrder(exchangeOrderId)}catch{return {ready:false,reason:'ORDER_LOOKUP_FAILED',ticker:c.ticker}}
   const count=Number(order.fill_count_fp??order.fill_count??NaN);
   if(!Number.isFinite(count))return {ready:false,reason:'FILL_UNKNOWN',ticker:c.ticker};
   let market=null;
   if(count>0){
     try{market=await getMarket(c.ticker)}catch{return {ready:false,reason:'MARKET_LOOKUP_FAILED',ticker:c.ticker}}
   }
   const applied=applyUsdSettlement(db,{ticker:c.ticker,createdAt:c.created_at,filledContracts:count,orderStatus:order.status,marketResult:market?.result??null,side:c.side,settledAt:now()});
   if(applied.status==='UNRESOLVED')return {ready:false,reason:'SETTLEMENT_UNRESOLVED',ticker:c.ticker};
   const terminal=applied.outcome==='ZERO_FILL'?'ladder_zero_fill':applied.outcome==='WIN'?'ladder_won':'ladder_lost';
   db.query('UPDATE fx_live_order_claims SET status=? WHERE ticker=?').run(terminal,c.ticker);
 }
 return {ready:!hasUnresolvedUsdOrders(db),state:getUsdLadder(db)};
}
