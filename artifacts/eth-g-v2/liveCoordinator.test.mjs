import test from "node:test";
import assert from "node:assert/strict";
import {submitEvaluatedEthG} from "./liveCoordinator.mjs";
test("no exchange POST for non-ready evaluation",async()=>{
 let sends=0;
 const r=await submitEvaluatedEthG({evaluation:{status:"blocked",reason:"settlements_missing"},send:async()=>{sends++},recordExchangeId:async()=>{}});
 assert.equal(r.kind,"skipped");assert.equal(sends,0);
});
test("fail closed if authenticated exchange adapter absent",async()=>{
 await assert.rejects(submitEvaluatedEthG({evaluation:{status:"ready",side:"yes",ticker:"KXETH15M-X",triggerKey:"t",step:0},orderId:"id",askCents:50}),/exchange_adapter_missing/);
});
