import {finalizeEthClaim, type TransactionProvider} from "../sharedEthClaimStore.js";
import {sharedEthPgProvider} from "../sharedEthPgProvider.js";

/**
 * The caller must obtain these fields from authenticated exchange order detail,
 * confirmed terminal status, and authoritative market result / fill summary.
 * This function does not itself fetch exchange evidence.
 */
export async function reconcileBSharedTerminal(input:{
 claimId:string;clientOrderId:string;expectedClientOrderId:string;
 ticker:string;side:"yes"|"no";
 exchangeOrderId:string|null;
 exchangeTerminal:boolean;finalFillCount:number|null;
 marketResult:"yes"|"no"|null;
 settlementId:string;
 provider?:TransactionProvider;
}):Promise<"PENDING"|"FINALIZED"> {
 if(!input.clientOrderId||input.clientOrderId!==input.expectedClientOrderId)
  throw Error("B claim exchange identity mismatch");
 if(!input.ticker.startsWith("KXETH15M-")||!input.claimId||!input.settlementId)
  throw Error("B reconciliation identity incomplete");
 if(!input.exchangeTerminal||input.finalFillCount===null)return "PENDING";
 if(!Number.isSafeInteger(input.finalFillCount)||input.finalFillCount<0)
  throw Error("B final fill count invalid");
 if(!input.exchangeOrderId)return "PENDING";
 if(input.finalFillCount>0 && input.marketResult===null)return "PENDING";
 const outcome=input.finalFillCount===0?"ZERO_FILL":input.marketResult===input.side?"WIN":"LOSS";
 await finalizeEthClaim(input.provider??sharedEthPgProvider,input.claimId,input.settlementId,outcome);
 return "FINALIZED";
}
