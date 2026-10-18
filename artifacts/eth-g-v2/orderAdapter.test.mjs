import test from "node:test";
import assert from "node:assert/strict";
import {submitEthG} from "./orderAdapter.mjs";
const base={state:{step:1,pendingOrderId:null},orderId:"client-eth-1",ticker:"KXETH15M-26OCT181530-30",side:"yes",askCents:50};
test("durable reservation occurs before exchange submission",async()=>{
 const events=[];
 const r=await submitEthG({...base,reserve:async x=>{events.push("reserve");return {clientOrderId:x.orderId}},
 recordExchangeId:async()=>events.push("attach"),
 send:async x=>{events.push("send");assert.equal(x.contracts,8);return {kind:"accepted",exchangeOrderId:"ex-1"}}});
 assert.deepEqual(events,["reserve","send","attach"]);assert.equal(r.kind,"submitted");
});
test("ambiguous POST never invokes a retry",async()=>{
 let sendCount=0;
 const r=await submitEthG({...base,reserve:async x=>({clientOrderId:x.orderId}),
 recordExchangeId:async()=>{},send:async()=>{sendCount++;throw Error("timeout")}});
 assert.equal(r.kind,"held");assert.equal(sendCount,1);
});
test("no order when pending or wrong ticker",async()=>{
 await assert.rejects(submitEthG({...base,state:{step:1,pendingOrderId:"held"}}),/invalid_eth_g_submission/);
 await assert.rejects(submitEthG({...base,ticker:"KXBTC15M-X"}),/invalid_eth_g_submission/);
});
test("cannot reserve when one contract exceeds wager principal",async()=>{
 let reserved=false;
 const r=await submitEthG({...base,state:{step:0,pendingOrderId:null},askCents:99,feeCents:102,
 reserve:async()=>{reserved=true},recordExchangeId:async()=>{},send:async()=>{}});
 assert.equal(r.kind,"skipped");assert.equal(reserved,false);
});
