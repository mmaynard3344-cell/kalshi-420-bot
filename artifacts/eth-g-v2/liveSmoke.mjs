// Public Kalshi read-only smoke test. Never authenticates or submits an order.
import {readEthWindow,readLastThreeEthSettlements} from "./marketClient.mjs";
import {evaluateEthG} from "./evaluator.mjs";
const nowMs=Date.now();
let result;
try {
 const market=await readEthWindow({nowMs});
 const openMs=Date.parse(market.close_time)-900000;
 const history=await readLastThreeEthSettlements(openMs);
 result=await evaluateEthG({nowMs,market,fetchSettled:async()=>history,
  getState:async()=>({step:0,pendingClientOrderId:null,lastTriggerKey:null})});
 console.log(JSON.stringify({event:"eth_g_v2_public_smoke",currentMarket:market.ticker,
  marketStatus:market.status,history:history?.map(x=>({ticker:x.ticker,result:x.result}))??null,
  evaluation:result}));
 if(result.status==="blocked"&&result.reason==="current_market_unavailable")process.exitCode=1;
} catch(e) {
 console.error(JSON.stringify({event:"eth_g_v2_public_smoke_error",error:String(e?.message??e)}));
 process.exitCode=1;
}
