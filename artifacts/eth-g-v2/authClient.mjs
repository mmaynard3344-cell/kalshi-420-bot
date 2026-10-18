// ETH G v2 authenticated Kalshi boundary. No request is sent without a caller action.
// The write path is disabled by default, and is never invoked by the read-only observer.
import {createSign} from "node:crypto";
const BASE="https://api.elections.kalshi.com/trade-api/v2";
export function authHeaders(method,path,{keyId,privateKey,now=Date.now()}){
 if(!["GET","POST"].includes(method)||!/^\/portfolio\//.test(path)||!keyId||!privateKey)throw Error("invalid_kalshi_credentials_or_path");
 const timestamp=String(now);
 const sign=createSign("RSA-SHA256");
 sign.update(timestamp+method+"/trade-api/v2"+path.split("?")[0]);
 sign.end();
 const signature=sign.sign({key:privateKey.replace(/\\n/g,"\n"),padding:6,saltLength:32}).toString("base64");
 return {"content-type":"application/json","KALSHI-ACCESS-KEY":keyId,
  "KALSHI-ACCESS-SIGNATURE":signature,"KALSHI-ACCESS-TIMESTAMP":timestamp};
}
export function orderPayload({ticker,side,clientOrderId,contracts,askCents}){
 if(!/^KXETH15M-[A-Z0-9-]+$/.test(ticker)||!["yes","no"].includes(side)||
  !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(clientOrderId)||!Number.isSafeInteger(contracts)||contracts<1||
  !Number.isSafeInteger(askCents)||askCents<1||askCents>99)throw Error("invalid_eth_order_payload");
 return {ticker,client_order_id:clientOrderId,side:side==="yes"?"bid":"ask",
  count:contracts+".00",price:((side==="yes"?askCents:100-askCents)/100).toFixed(4),
  time_in_force:"good_till_canceled",self_trade_prevention_type:"taker_at_cross"};
}
export function makeAuthClient({keyId,privateKey,fetcher=fetch,allowLiveOrders=false}){
 return async function authJson(method,path,body){
  if(!/^\/portfolio\/(orders|fills|balance|events\/orders)(\/|\?|$)/.test(path))throw Error("unapproved_kalshi_path");
  if(method==="POST"&&(!allowLiveOrders||process.env.ETH_G_V2_LIVE_TRADING!=="true"))
   throw Error("eth_g_v2_live_orders_disabled");
  const response=await fetcher(BASE+path,{method,
   headers:authHeaders(method,path,{keyId,privateKey}),
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const payload=await response.json();
  if(!response.ok)throw Error("kalshi_http_"+response.status);
  return payload;
 };
}
