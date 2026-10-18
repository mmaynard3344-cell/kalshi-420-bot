// Kalshi authenticated transport for isolated SOL/XRP/DOGE G.
// No orders sent unless global + per-asset trading gates are explicitly enabled.
import {createSign} from "node:crypto";
import {assertAsset} from "./multiAssetGCore.mjs";
const BASE="https://api.elections.kalshi.com/trade-api/v2";
export function assetGHeaders(method,path,{keyId,privateKey,now=Date.now()}){
 if(!["GET","POST"].includes(method)||!/^\/portfolio\//.test(path)||!keyId||!privateKey)throw Error("invalid_asset_g_auth");
 const timestamp=String(now),signature=createSign("SHA256");
 signature.update(timestamp+method+"/trade-api/v2"+path.split("?")[0]);signature.end();
 return {"content-type":"application/json","KALSHI-ACCESS-KEY":keyId,
 "KALSHI-ACCESS-SIGNATURE":signature.sign({key:privateKey.replace(/\\n/g,"\n"),padding:6,saltLength:32}).toString("base64"),
 "KALSHI-ACCESS-TIMESTAMP":timestamp};
}
export function assetGOrderPayload({ticker,asset,side,clientOrderId,contracts,askCents}){
 const series=assertAsset(asset);
 if(!ticker?.startsWith(series+"-")||!["yes","no"].includes(side)||!clientOrderId||
 !Number.isSafeInteger(contracts)||contracts<1||!Number.isInteger(askCents)||askCents<1||askCents>99)
  throw Error("invalid_asset_g_order_payload");
 return {ticker,client_order_id:clientOrderId,side:side==="yes"?"bid":"ask",
  count:contracts+".00",price:((side==="yes"?askCents:100-askCents)/100).toFixed(4),
  time_in_force:"good_till_canceled",self_trade_prevention_type:"taker_at_cross"};
}
export function makeAssetGAuthClient({asset,keyId,privateKey,fetcher=fetch,allowOrders=false}){
 assertAsset(asset);
 return async(method,path,body)=>{
  if(!["GET","POST"].includes(method)||!/^\/portfolio\/(orders|fills|balance|events\/orders)(\/|\?|$)/.test(path))
   throw Error("asset_g_unapproved_auth_request");
  if(method==="POST"&&(!allowOrders||process.env.MULTI_ASSET_G_LIVE_ENABLED!=="true"||
   process.env[asset+"_G_LIVE_ENABLED"]!=="true"))
   throw Error("asset_g_order_execution_disabled");
  const res=await fetcher(BASE+path,{method,headers:assetGHeaders(method,path,{keyId,privateKey}),
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await res.json();
  if(!res.ok)throw Error("kalshi_http_"+res.status);
  return data;
 };
}
