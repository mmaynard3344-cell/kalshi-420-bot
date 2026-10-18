// SOL/XRP/DOGE G standalone process. Defaults to public read-only evaluation.
// Explicit live activation requires database, credentials, per-asset switches,
// and a prior external schema migration. Does not change BTC or ETH processes.
import http from "node:http";
import {evaluateAssetG} from "./multiAssetGSignal.mjs";
import {runAssetGOnce} from "./multiAssetGEngine.mjs";
import {makeAssetGAuthClient} from "./multiAssetGAuthClient.mjs";
const assets=["SOL","XRP","DOGE"];
export async function startMultiAssetGService({port=Number(process.env.PORT||8080),intervalMs=60000}={}){
 const live=process.env.MULTI_ASSET_G_LIVE_ENABLED==="true";
 let pool=null;
 const auth={};
 if(live){
  if(!process.env.DATABASE_URL||!process.env.KALSHI_API_KEY_ID||!process.env.KALSHI_PRIVATE_KEY)
   throw Error("multi_asset_g_live_prerequisites_missing");
  const {default:pg}=await import("pg");
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4});
  for(const asset of assets)auth[asset]=makeAssetGAuthClient({
   asset,keyId:process.env.KALSHI_API_KEY_ID,privateKey:process.env.KALSHI_PRIVATE_KEY,allowOrders:true});
 }
 let busy=false,latest={};
 const poll=async()=>{
  if(busy)return;
  busy=true;
  try{
   for(const asset of assets){
    try{
     let r;
     if(live)r=await runAssetGOnce({asset,pool,authJson:auth[asset],liveEnabled:true});
     else{
      r=await evaluateAssetG({asset});
      if(r.status==="ready")r={...r,status:"shadow_ready"};
     }
     latest[asset]={...r,observedAt:new Date().toISOString()};
     console.log(JSON.stringify({event:"multi_asset_g_evaluation",...latest[asset]}));
    }catch(error){
     latest[asset]={asset,status:"blocked",reason:String(error?.message??error).slice(0,120),observedAt:new Date().toISOString()};
     console.error(JSON.stringify({event:"multi_asset_g_error",...latest[asset]}));
    }
   }
  }finally{busy=false}
 };
 const timer=setInterval(()=>{void poll()},intervalMs);
 void poll();
 const server=http.createServer((_req,res)=>{
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({service:"multi-asset-g",liveTrading:live,latest}));
 });
 server.listen(port);
 return {stop:async()=>{clearInterval(timer);server.close();if(pool)await pool.end()}};
}
if(process.argv[1]&&import.meta.url===new URL("file://"+process.argv[1]).href)
 startMultiAssetGService().catch(error=>{console.error(String(error));process.exitCode=1});
