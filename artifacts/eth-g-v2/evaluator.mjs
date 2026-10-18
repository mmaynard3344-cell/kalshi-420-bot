// Read-only ETH G v2 evaluation. Uses finalized adjacent market results.
// Returns an explicit decision for every gate rather than silently skipping.
import {decide,validateMarket} from "./core.mjs";
export async function evaluateEthG({nowMs,market,fetchSettled,getState}){
 if(!Number.isSafeInteger(nowMs)||typeof fetchSettled!=="function"||typeof getState!=="function")
  throw Error("invalid_evaluator_dependencies");
 const current=validateMarket(market,nowMs);
 if(!current)return {status:"blocked",reason:"current_market_unavailable"};
 const state=await getState();
 if(!state)return {status:"blocked",reason:"ladder_state_unavailable",ticker:current.ticker};
 if(state.pendingClientOrderId)return {status:"blocked",reason:"prior_order_reconciliation_pending",ticker:current.ticker};
 const history=await fetchSettled(current.windowStartMs);
 if(!Array.isArray(history)||history.length!==3||
  history.some((x,i)=>!x||x.openMs!==current.windowStartMs-(3-i)*900000||!["yes","no"].includes(x.result)||!x.finalized))
  return {status:"blocked",reason:"last_three_settlements_incomplete",ticker:current.ticker};
 const signal=decide(history.map(x=>x.result));
 if(!signal.fires)return {status:"no_signal",reason:signal.reason,ticker:current.ticker};
 const triggerKey=history.slice(-2).map(x=>x.ticker).join("|");
 if(!triggerKey||triggerKey.includes("undefined"))return {status:"blocked",reason:"settled_ticker_missing",ticker:current.ticker};
 if(state.lastTriggerKey===triggerKey)return {status:"blocked",reason:"signal_already_processed",ticker:current.ticker};
 return {status:"ready",reason:signal.reason,side:signal.side,ticker:current.ticker,triggerKey,step:state.step};
}
