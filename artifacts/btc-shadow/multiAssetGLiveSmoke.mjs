// Read-only live probe: reports actual availability of the 15-minute
// series, never creates or cancels orders and requires no secrets.
import {inspectAllGMarkets} from "./multiAssetGMarket.mjs";
import {evaluateAssetG} from "./multiAssetGSignal.mjs";
const rows=await inspectAllGMarkets();
for(const row of rows)console.log(JSON.stringify({event:"g_asset_market_probe",
 asset:row.asset,ticker:row.ticker,status:row.status,reason:row.reason}));
if(rows.length!==3||rows.some(x=>!["SOL","XRP","DOGE"].includes(x.asset)))
 process.exitCode=1;

for(const asset of ["SOL","XRP","DOGE"]){
 try{const result=await evaluateAssetG({asset});
  console.log(JSON.stringify({event:"g_asset_live_signal_probe",asset,status:result.status,reason:result.reason,outcomes:result.outcomes??null}));
 }catch(error){console.log(JSON.stringify({event:"g_asset_live_signal_probe",asset,status:"blocked",reason:String(error.message)}));}
}
