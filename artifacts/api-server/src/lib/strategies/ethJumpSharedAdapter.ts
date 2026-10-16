import {submitThroughSharedEthGate} from "../sharedEthOrderGateway.js";
import type {TransactionProvider} from "../sharedEthClaimStore.js";
import {sharedEthPgProvider} from "../sharedEthPgProvider.js";
import {ethContractsWithinBudget} from "../sharedEthOrderSizing.js";
import {recordBClaimBeforePost,recordBExchangeOrderId} from "./ethJumpSharedClaimJournal.js";
import type {EthBigBetExchangeSubmitter,EthBigBetSubmitResult} from "./ethBigBetExecutor.js";
import type {EthBigBetOrderIntent} from "./ethBigBetLifecycle.js";

/** Review-only B adapter. Not a live path until durable B-to-claim linkage,
 * exchange reconciliation and cross-service cutover have been verified.
 * Does not mutate the existing independent B execution interface.
 */
export async function submitBViaSharedEthClaim(input:{
 intent:EthBigBetOrderIntent;
 exchange:EthBigBetExchangeSubmitter;
 estimatedFeeCents:(contracts:number)=>number;
 persistExchangeOrderId?:(claimId:string,exchangeOrderId:string)=>Promise<void>;
 /** Inject only the disposable test provider; production defaults to Railway PostgreSQL. */
 provider?:TransactionProvider;
 persistBeforePost?:(record:{
   claimId:string;clientOrderId:string;contracts:number;budgetCents:number;
   priceCents:number;ticker:string;side:"yes"|"no";
 })=>Promise<void>;
}):Promise<
 | {kind:"skipped"}
 | {kind:"held";claimId:string;result:EthBigBetSubmitResult}
 | {kind:"uncertain";claimId:string}
>{
 if(input.intent.strategy!=="jump")throw Error("ETH B adapter rejected another strategy");
 if(!input.intent.ticker.startsWith("KXETH15M-"))throw Error("ETH B adapter requires ETH15M");
 // Deterministic exchange correlation key. The global claim ID is random and
 // persisted separately. Never retry the POST just because the acknowledgment
 // failed; the global fence stays held until exchange reconciliation.
 const clientOrderId="eth-shared-B:"+input.intent.ticker;
 const outcome=await submitThroughSharedEthGate(input.provider??sharedEthPgProvider,{
  service:"B",ticker:input.intent.ticker,side:input.intent.side,clientOrderId
 },async (claim,id)=>{
  const size=ethContractsWithinBudget(claim.budgetCents,input.intent.limitPriceCents,input.estimatedFeeCents);
  if(size.contracts<1)throw Error("no affordable ETH B contracts including fees");
  await (input.persistBeforePost??(async record=>recordBClaimBeforePost({claimId:record.claimId,clientOrderId:record.clientOrderId,ticker:record.ticker,side:record.side,contracts:record.contracts},input.provider??sharedEthPgProvider)))({
   claimId:claim.claimId,clientOrderId:id,contracts:size.contracts,
   budgetCents:claim.budgetCents,priceCents:input.intent.limitPriceCents,
   ticker:input.intent.ticker,side:input.intent.side
  });
  return input.exchange.submit({
   clientOrderId:id,ticker:input.intent.ticker,side:input.intent.side,
   contracts:size.contracts,limitPriceCents:input.intent.limitPriceCents
  });
 });
 if(outcome.status==="SKIPPED_ACTIVE_CLAIM")return {kind:"skipped"};
 if(outcome.status==="SUBMISSION_UNCERTAIN")return {kind:"uncertain",claimId:outcome.claim.claimId};
 if(outcome.response.kind==="accepted")await (input.persistExchangeOrderId??((claimId,id)=>recordBExchangeOrderId(claimId,id,input.provider??sharedEthPgProvider)))(outcome.claim.claimId,outcome.response.exchangeOrderId);
 // An exchange-level rejection is still kept fenced until authoritative
 // no-fill reconciliation. No separate release on response alone.
 return {kind:"held",claimId:outcome.claim.claimId,result:outcome.response};
}
