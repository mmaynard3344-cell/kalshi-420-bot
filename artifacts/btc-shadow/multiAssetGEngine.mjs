// One pass of isolated G execution, with authenticated recovery first.
// Only explicit global and per-asset gates may authorize new real-money orders.
import {randomUUID} from "node:crypto";
import {assertAsset} from "./multiAssetGCore.mjs";
import {evaluateAssetG} from "./multiAssetGSignal.mjs";
import {getPendingAssetG,recordAssetGExchangeId} from "./multiAssetGStore.mjs";
import {recoverAssetG} from "./multiAssetGRecovery.mjs";
import {submitAssetG} from "./multiAssetGOrderAdapter.mjs";
import {assetGOrderPayload} from "./multiAssetGAuthClient.mjs";
const BASE="https://api.elections.kalshi.com/trade-api/v2";
export function quoteAssetG(market,side){
 const raw=side==="yes"?(market?.yes_ask??market?.yes_ask_dollars):(market?.no_ask??market?.no_ask_dollars);
 const n=Number(raw);
 if(!Number.isFinite(n))return null;
 const cents=n>0&&n<1?Math.round(n*100):Math.round(n);
 return cents>=1&&cents<=99?cents:null;
}
export async function runAssetGOnce({asset,pool,authJson,fetcher=fetch,
 nowMs=Date.now(),liveEnabled=false,idFactory=randomUUID}){
 assertAsset(asset);
 if(!pool)throw Error("asset_g_database_unavailable");
 const pending=await getPendingAssetG(pool,asset);
 if(pending){
  if(typeof authJson!=="function")return {asset,status:"held",reason:"authenticated_recovery_unavailable"};
  const publicJson=async url=>{
   const r=await fetcher(url,{method:"GET",signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw Error("market_http_"+r.status);
   return r.json();
  };
  const outcome=await recoverAssetG({pool,asset,authJson,publicJson,publicBase:BASE});
  return {asset,status:"recovery",outcome};
 }
 const signal=await evaluateAssetG({asset,nowMs,fetcher});
 if(signal.status!=="ready")return {asset,status:signal.status,reason:signal.reason,ticker:signal.ticker};
 const authorized=liveEnabled&&process.env.MULTI_ASSET_G_LIVE_ENABLED==="true"&&
  process.env[asset+"_G_LIVE_ENABLED"]==="true";
 if(!authorized)return {asset,status:"shadow_ready",side:signal.side,ticker:signal.ticker};
 if(typeof authJson!=="function")return {asset,status:"blocked",reason:"authenticated_order_client_unavailable"};
 const current=await fetcher(BASE+"/markets/"+encodeURIComponent(signal.ticker),{method:"GET",signal:AbortSignal.timeout(10000)});
 if(!current.ok)return {asset,status:"blocked",reason:"market_quote_unavailable"};
 const raw=await current.json();
 if(raw?.market?.ticker!==signal.ticker||!["open","active"].includes(raw.market.status))
  return {asset,status:"blocked",reason:"market_no_longer_tradeable"};
 const askCents=quoteAssetG(raw.market,signal.side);
 if(askCents==null)return {asset,status:"blocked",reason:"ask_quote_unavailable"};
 const orderId=idFactory();
 const attempt=await submitAssetG({asset,pool,orderId,ticker:signal.ticker,side:signal.side,askCents,enabled:true,
  send:async({clientOrderId,ticker,side,contracts,askCents})=>{
   const body=assetGOrderPayload({asset,clientOrderId,ticker,side,contracts,askCents});
   const raw=await authJson("POST","/portfolio/events/orders",body);
   return {exchangeOrderId:raw?.order?.order_id??raw?.order_id??null};
  }});
 if(attempt.exchangeOrderId)
  await recordAssetGExchangeId(pool,{asset,orderId,exchangeOrderId:attempt.exchangeOrderId});
 return {asset,status:attempt.state,reason:attempt.reason,orderId:attempt.orderId??null};
}
