// Three finalized adjacent 15-minute markets, evaluated separately per coin.
// Read-only: never infer results from market prices or live orderbook.
import {assertAsset,decideG,WINDOW_MS} from "./multiAssetGCore.mjs";
import {currentTicker,inspectGMarket} from "./multiAssetGMarket.mjs";
const BASE="https://api.elections.kalshi.com/trade-api/v2";
export async function evaluateAssetG({asset,nowMs=Date.now(),fetcher=fetch}){
 assertAsset(asset);
 const current=await inspectGMarket(asset,nowMs,fetcher);
 if(current.status!=="ready")return {asset,status:"blocked",reason:current.reason,ticker:current.ticker};
 const closeMs=Math.floor(nowMs/WINDOW_MS)*WINDOW_MS+WINDOW_MS;
 const previous=[3,2,1].map(n=>currentTicker(asset,closeMs-n*WINDOW_MS-1));
 const outcomes=[];
 for(const ticker of previous){
  const res=await fetcher(BASE+"/markets/"+encodeURIComponent(ticker),{method:"GET",signal:AbortSignal.timeout(10000)});
  if(!res.ok)return {asset,status:"blocked",reason:"previous_market_unavailable",ticker:current.ticker};
  const raw=await res.json(),m=raw?.market;
  if(m?.ticker!==ticker||!["yes","no"].includes(m.result)||
    !["settled","finalized"].includes(m.status))
    return {asset,status:"blocked",reason:"previous_market_not_final",ticker:current.ticker};
  outcomes.push(m.result);
 }
 const decision=decideG(outcomes);
 return {asset,ticker:current.ticker,status:decision.fires?"ready":"no_signal",
  side:decision.side,reason:decision.reason,previous,outcomes};
}
