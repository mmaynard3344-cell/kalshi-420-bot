// Read-only ETH G v2 observer. No order submission and no DB mutation.
import http from "node:http";
import {evaluateEthG} from "./evaluator.mjs";
import {readEthWindow,readLastThreeEthSettlements} from "./marketClient.mjs";
export async function observeOnce({nowMs=Date.now(),fetcher=fetch,log=console.log}={}){
 let result;
 try{
  const market=await readEthWindow({nowMs,fetcher});
  result=await evaluateEthG({
   nowMs,market,
   fetchSettled:openMs=>readLastThreeEthSettlements(openMs,fetcher),
   // Observer uses no orders and does not claim a production ladder state.
   getState:async()=>({step:0,pendingClientOrderId:null,lastTriggerKey:null})
  });
  if(result.status==="ready")result={...result,status:"shadow_ready",reason:"would_trade_if_live_but_observer_cannot_submit"};
 }catch(error){
  result={status:"blocked",reason:"kalshi_market_read_failed",error:String(error?.message??error).slice(0,160)};
 }
 log(JSON.stringify({event:"eth_g_v2_shadow_evaluation",observedAt:new Date(nowMs).toISOString(),...result}));
 return result;
}
export function startObserver({intervalMs=60000,port=Number(process.env.PORT||3000)}={}){
 if(process.env.ETH_G_V2_LIVE_TRADING==="true")throw Error("observer_must_not_enable_live_trading");
 let last=null,busy=false;
 const tick=async()=>{
  if(busy)return;
  busy=true;try{last=await observeOnce()}finally{busy=false}
 };
 const timer=setInterval(()=>{void tick()},intervalMs);
 void tick();
 const server=http.createServer((req,res)=>{
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({role:"eth-g-v2-read-only",liveTrading:false,last}));
 });
 server.listen(port);
 return {stop:()=>{clearInterval(timer);server.close()}};
}
if(process.argv[1]&&import.meta.url===new URL("file://"+process.argv[1]).href)startObserver();
