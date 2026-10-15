import {test,expect,mock} from "bun:test";
import {submitThroughMarketLadder} from "../src/lib/marketLadderExecutionBridge";
import {initialLadder,reserveOrder,affordableContracts} from "../src/lib/marketSharedLadder";

mock.module("../src/lib/marketSharedLadderStore.js",()=>({
 claimSizedMarketWager:async (_db:unknown,market:string,id:string,price:number,fee:(n:number,p:number)=>number,max:number)=>{
  const prior=initialLadder(market as "BTC");
  const sizing=affordableContracts(prior,price,fee,max);
  return {...sizing,dollars:1,state:reserveOrder(prior,id)};
 }
}));
const db={} as any;
const fee=()=>0;
test("submits reserved amount with same id and bounded debit",async()=>{
 let posted:any=null;
 const result=await submitThroughMarketLadder(db,{market:"BTC",clientOrderId:"fixed-id",priceCents:40,maxContracts:10,feeCents:fee},async x=>{
  posted=x;return {kind:"accepted",exchangeOrderId:"k123"};
 });
 expect(posted).toEqual({clientOrderId:"fixed-id",contracts:2,maxTotalCents:80});
 expect(result).toEqual({status:"accepted",exchangeOrderId:"k123"});
});
test("uncertain exchange acknowledgements are not treated as released",async()=>{
 const result=await submitThroughMarketLadder(db,{market:"ETH",clientOrderId:"u1",priceCents:50,maxContracts:10,feeCents:fee},async()=>{throw Error("timeout")});
 expect(result).toEqual({status:"uncertain",reason:"exchange_reconciliation_required"});
});
test("zero fill acknowledgements require separate reconciliation",async()=>{
 const result=await submitThroughMarketLadder(db,{market:"EURUSD",clientOrderId:"z1",priceCents:50,maxContracts:10,feeCents:fee},async()=>({kind:"rejected_zero_fill"}));
 expect(result.status).toBe("zero_fill");
 expect(result.reason).toBe("await_exchange_zero_fill_confirmation");
});
