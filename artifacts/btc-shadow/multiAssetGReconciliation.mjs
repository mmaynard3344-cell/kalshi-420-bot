// Exchange evidence gate for SOL/XRP/DOGE G (review only).
// Never places orders or writes ladder state. Authenticated data is supplied by caller.
import { assertAsset } from "./multiAssetGCore.mjs";
export async function verifyAssetGSettlement({asset,clientOrderId,ticker,exchangeOrderId,authJson,publicJson,publicBase}) {
 const series=assertAsset(asset);
 if(!ticker?.startsWith(series+"-")||!clientOrderId||!exchangeOrderId ||
    typeof authJson!=="function"||typeof publicJson!=="function"||typeof publicBase!=="string")
   throw Error("invalid_g_reconciliation_inputs");
 const [orderBody,fillBody,marketBody] = await Promise.all([
  authJson("GET","/portfolio/orders/"+encodeURIComponent(exchangeOrderId)),
  authJson("GET","/portfolio/fills?order_id="+encodeURIComponent(exchangeOrderId)+"&limit=200"),
  publicJson(publicBase+"/markets/"+encodeURIComponent(ticker)),
 ]);
 const order=orderBody?.order??orderBody;
 if(!order||order.order_id!==exchangeOrderId||order.client_order_id!==clientOrderId||order.ticker!==ticker)
   return {state:"held",reason:"order_identity_unverified"};
 if(!Array.isArray(fillBody?.fills)||fillBody.cursor)
   return {state:"held",reason:"fill_history_incomplete"};
 if(!["executed","filled","closed","canceled","cancelled"].includes(String(order.status??"").toLowerCase()))
   return {state:"held",reason:"order_not_final"};
 const fills=fillBody.fills;
 if(fills.some(f=>f.order_id!==exchangeOrderId||f.ticker!==ticker))
   return {state:"held",reason:"fill_identity_mismatch"};
 const count=fills.reduce((sum,f)=>sum+Number(f.count??f.count_fp??NaN),0);
 if(!Number.isSafeInteger(count)||count<=0) return {state:"held",reason:"positive_fill_not_verified"};
 const market=marketBody?.market??marketBody;
 if(market?.ticker!==ticker||!["yes","no"].includes(market?.result))
   return {state:"held",reason:"settled_market_result_missing"};
 const side=String(order.action_side??order.side??"").toLowerCase();
 // Kalshi side may be bid/ask in some order schema; require explicit verified yes/no.
 if(!["yes","no"].includes(side)) return {state:"held",reason:"order_side_not_verified"};
 return {state:"verified",asset,clientOrderId,exchangeOrderId,ticker,filledContracts:count,
   settlementId:exchangeOrderId, outcome:market.result===side?"win":"loss"};
}
