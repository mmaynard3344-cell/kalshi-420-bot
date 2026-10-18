// Read-only Kalshi ETH15M market adapter. No credentials or order operations.
const BASE="https://api.elections.kalshi.com/trade-api/v2";
const WINDOW=900000;
export function ethCurrentTicker(nowMs){
 const close=Math.floor(nowMs/WINDOW)*WINDOW+WINDOW;
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"2-digit",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(close)).map(x=>[x.type,x.value]));
 return "KXETH15M-"+parts.year+parts.month.toUpperCase()+parts.day+parts.hour+parts.minute+"-"+String(new Date(close).getUTCMinutes()).padStart(2,"0");
}
async function readMarket(ticker,fetcher){
 if(!/^KXETH15M-[A-Z0-9-]+$/.test(ticker))throw Error("invalid_eth_ticker");
 const response=await fetcher(BASE+"/markets/"+encodeURIComponent(ticker),{method:"GET",signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error("kalshi_market_http_"+response.status);
 const body=await response.json();
 return body.market??body;
}
export async function readEthWindow({nowMs,fetcher=fetch}){
 const ticker=ethCurrentTicker(nowMs);
 const market=await readMarket(ticker,fetcher);
 if(market.ticker!==ticker)throw Error("current_market_identity_mismatch");
 return market;
}
export async function readLastThreeEthSettlements(currentOpenMs,fetcher=fetch){
 const rows=[];
 for(let offset=3;offset>=1;offset--){
  const openMs=currentOpenMs-offset*WINDOW;
  const ticker=ethCurrentTicker(openMs);
  const market=await readMarket(ticker,fetcher);
  const actualOpen=Date.parse(market.open_time);
  if(market.ticker!==ticker||actualOpen!==openMs||!["settled","finalized"].includes(market.status)||!["yes","no"].includes(market.result))
   return null;
  rows.push({ticker,openMs,result:market.result,finalized:true});
 }
 return rows;
}
