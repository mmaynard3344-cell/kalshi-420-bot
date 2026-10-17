import {randomUUID} from "node:crypto";
import {claimFirstEthSignal,markEthClaimSubmitted,releaseUnsubmittedEthClaim,type TransactionProvider,type EthClaim} from "./sharedEthClaimStore.js";

/**
 * Shared ETH order submission boundary. Review-only: NOT connected to any live executor.
 * Safe call contract: the order identity is recorded BEFORE any exchange network request.
 * After entering submit(), any rejection/timeout is uncertain; claim MUST stay reserved.
 */
export type SharedEthOrderRequest = {
 service: string;
 ticker: string;
 side: "yes"|"no";
 clientOrderId: string;
 expectedVersion?: number;
};
export type SharedEthSubmitResult<T> =
 | {status:"SKIPPED_ACTIVE_CLAIM"}
 | {status:"SUBMISSION_UNCERTAIN";claim:EthClaim;error:unknown}
 | {status:"SUBMITTED";claim:EthClaim;response:T};

export async function submitThroughSharedEthGate<T>(
 db:TransactionProvider,
 request:SharedEthOrderRequest,
 submit:(claim:EthClaim,clientOrderId:string)=>Promise<T>,
):Promise<SharedEthSubmitResult<T>> {
 if(!request.ticker.startsWith("KXETH15M-"))throw new Error("ETH-only boundary rejects non-ETH ticker");
 if(!request.clientOrderId || !request.service)throw new Error("missing ETH order identity");
 const claimId=randomUUID();
 const claim=await claimFirstEthSignal(db,{claimId,service:request.service,ticker:request.ticker,side:request.side,expectedVersion:request.expectedVersion});
 if(!claim)return {status:"SKIPPED_ACTIVE_CLAIM"};
 // Persist SUBMITTED with durable client-order identity first. This deliberately
 // holds the claim even if the following network submission fails or times out.
 await markEthClaimSubmitted(db,claimId,request.clientOrderId);
 try{
   const response=await submit(claim,request.clientOrderId);
   return {status:"SUBMITTED",claim,response};
 }catch(error){
   return {status:"SUBMISSION_UNCERTAIN",claim,error};
 }
}

/** Only valid BEFORE a submission attempt, if caller has proof that the
 * exchange endpoint was never contacted. Otherwise reconcile from exchange. */
export {releaseUnsubmittedEthClaim};
