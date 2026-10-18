// Read-only Kalshi current-market discovery for non-BTC G assets.
// Deliberately no authenticated endpoints or trading operations.
import { ASSET_SERIES, WINDOW_MS, selectGMarket } from "./multiAssetGCore.mjs";
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const dateParts = (when) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "2-digit", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(when).map(part => [part.type,part.value]));
export function currentTicker(asset, nowMs) {
  const series=ASSET_SERIES[asset];
  if(!series || !Number.isSafeInteger(nowMs)) throw Error("invalid_g_asset_or_time");
  const close=Math.floor(nowMs/WINDOW_MS)*WINDOW_MS+WINDOW_MS;
  const p=dateParts(new Date(close));
  return `${series}-${p.year}${p.month.toUpperCase()}${p.day}${p.hour}${p.minute}-${p.minute}`;
}
export async function inspectGMarket(asset, nowMs=Date.now(), fetcher=fetch) {
  const ticker=currentTicker(asset,nowMs);
  const response=await fetcher(`${BASE}/markets/${encodeURIComponent(ticker)}`,{method:"GET",signal:AbortSignal.timeout(10000)});
  if(!response.ok) return {asset,ticker,status:"unavailable",reason:`market_http_${response.status}`,market:null};
  const body=await response.json();
  const market=selectGMarket(asset,body?.market,nowMs);
  return {asset,ticker,status:market?"ready":"unavailable",reason:market?null:"market_failed_validation",market};
}
export async function inspectAllGMarkets(nowMs=Date.now(), fetcher=fetch) {
  return Promise.all(Object.keys(ASSET_SERIES).map(async asset=>{
    try{return await inspectGMarket(asset,nowMs,fetcher)}
    catch(e){return {asset,ticker:currentTicker(asset,nowMs),status:"unavailable",reason:e instanceof Error?e.message:"market_fetch_error",market:null}}
  }));
}
