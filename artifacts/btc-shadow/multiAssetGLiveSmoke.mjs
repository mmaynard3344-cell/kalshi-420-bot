// Read-only live probe: reports actual availability of the 15-minute
// series, never creates or cancels orders and requires no secrets.
import {inspectAllGMarkets} from "./multiAssetGMarket.mjs";
const rows=await inspectAllGMarkets();
for(const row of rows)console.log(JSON.stringify({event:"g_asset_market_probe",
 asset:row.asset,ticker:row.ticker,status:row.status,reason:row.reason}));
if(rows.length!==3||rows.some(x=>!["SOL","XRP","DOGE"].includes(x.asset)))
 process.exitCode=1;
