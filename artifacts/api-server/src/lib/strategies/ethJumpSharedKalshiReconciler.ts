import {kalshiAuthFetch} from "../kalshiAuth.js";
import {kalshiFetch} from "../kalshi.js";
import {reconcileBSharedTerminal} from "./ethJumpSharedSettlement.js";
import type {TransactionProvider} from "../sharedEthClaimStore.js";

/** Review-only authenticated proof reader; NEVER treats an ambiguous API
 * response as a zero-fill or a settlement. No production caller yet. */
export async function reconcileBFromKalshi(input:{
 claimId:string;clientOrderId:string;ticker:string;side:"yes"|"no";
 exchangeOrderId:string;provider?:TransactionProvider;
}):Promise<"PENDING"|"FINALIZED"> {
 if(!input.exchangeOrderId||!input.clientOrderId||!input.ticker.startsWith("KXETH15M-"))
  throw Error("B exchange reconciliation identity missing");
 const raw=await kalshiAuthFetch<Record<string,unknown>>("GET",
  "/portfolio/orders/"+encodeURIComponent(input.exchangeOrderId),undefined,{readPriority:"safety"});
 const order=(raw["order"]&&typeof raw["order"]==="object"?raw["order"]:raw) as Record<string,unknown>;
 if(order["order_id"]!==input.exchangeOrderId || order["client_order_id"]!==input.clientOrderId
   ||order["ticker"]!==input.ticker)return "PENDING";
 const status=order["status"];
 if(status!=="canceled"&&status!=="executed"&&status!=="expired"&&status!=="rejected")return "PENDING";
 // An absent fill-count is *unknown*, never silently zero.
 const fills=order["fill_count"];
 const fillCount=typeof fills==="number"?fills:
  typeof fills==="string"&&/^\d+$/.test(fills)?Number(fills):null;
 if(fillCount===null||!Number.isSafeInteger(fillCount))return "PENDING";
 const marketRaw=await kalshiFetch<{market?:Record<string,unknown>}>(
   "/markets/"+encodeURIComponent(input.ticker));
 const market=marketRaw?.market;
 const winner=market?.["result"];
 const result=winner==="yes"||winner==="no"?winner:null;
 return reconcileBSharedTerminal({
  ...input,expectedClientOrderId:input.clientOrderId,
  exchangeTerminal:true,finalFillCount:fillCount,marketResult:result,
  settlementId:"B:"+input.exchangeOrderId+":"+(result??"zero-fill"),
 });
}
