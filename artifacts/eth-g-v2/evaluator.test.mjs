import test from "node:test";
import assert from "node:assert/strict";
import {evaluateEthG} from "./evaluator.mjs";
const t=Date.parse("2026-10-18T19:15:00Z");
const market={ticker:"KXETH15M-26OCT181530-30",status:"active",floor_strike:3000,close_time:"2026-10-18T19:30:00Z"};
const history=(outcomes=["no","yes","yes"])=>outcomes.map((result,i)=>({ticker:"prior-"+i,openMs:t-(3-i)*900000,result,finalized:true}));
const args=()=>({nowMs:t+60000,market,fetchSettled:async()=>history(),getState:async()=>({step:2,pendingClientOrderId:null,lastTriggerKey:null})});
test("follows latest of two settled same-side outcomes",async()=>{
 const x=await evaluateEthG(args());assert.equal(x.status,"ready");assert.equal(x.side,"yes");assert.equal(x.step,2);
});
test("reports pending reconciliation rather than evaluating new trade",async()=>{
 const a=args();a.getState=async()=>({step:0,pendingClientOrderId:"old"});
 assert.equal((await evaluateEthG(a)).reason,"prior_order_reconciliation_pending");
});
test("reports missing finalized settlement instead of no signal",async()=>{
 const a=args();a.fetchSettled=async()=>history().slice(0,2);
 assert.equal((await evaluateEthG(a)).reason,"last_three_settlements_incomplete");
});
test("reports absence of new signal with actual three settlements",async()=>{
 const a=args();a.fetchSettled=async()=>history(["yes","yes","yes"]);
 assert.equal((await evaluateEthG(a)).status,"no_signal");
});
test("rejects replayed trigger",async()=>{
 const a=args();a.getState=async()=>({step:0,lastTriggerKey:"prior-1|prior-2"});
 assert.equal((await evaluateEthG(a)).reason,"signal_already_processed");
});
