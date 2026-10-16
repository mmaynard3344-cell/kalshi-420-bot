import {applyUsdSettlement,getUsdLadder,hasUnresolvedUsdOrders} from './store.mjs';
/**
 * Read-only exchange reconciliation adapter. The caller supplies authenticated
 * order lookup and public finalized market lookup. No live order submissions.
 */
export async function reconcileUsdLadder(db,{getOrder,getMarket,now=()=>new Date().toISOString()}) {
 const state=getUsdLadder(db);
 const claims=db.query("SELECT ticker,created_at,side,status,exchange_order_id FROM fx_live_order_claims WHERE created_at >= ? AND status NOT IN ('ladder_won','ladder_lost','ladder_zero_fill') ORDER BY created_at ASC").all(state.activated_at);
 for(const c of claims){
   if(!c.exchange_order_id)return {ready:false,reason:'ORDER_ID_UNKNOWN',ticker:c.ticker};
   let order;
   try{order=await getOrder(c.exchange_order_id)}catch{return {ready:false,reason:'ORDER_LOOKUP_FAILED',ticker:c.ticker}}
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
