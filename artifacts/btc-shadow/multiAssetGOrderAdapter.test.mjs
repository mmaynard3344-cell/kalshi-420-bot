import test from "node:test";import assert from "node:assert/strict";
import {submitAssetG} from "./multiAssetGOrderAdapter.mjs";
function pool(){
 const rows={SOL:{asset:"SOL",step:0,pending_order_id:null,version:0}};
 const client={query:async(sql)=>sql.startsWith("SELECT * FROM multi_asset_g_ladders")?{rows:[rows.SOL],rowCount:1}:{rows:[],rowCount:1},release(){}};
 return {connect:async()=>client};
}
const params={pool:pool(),asset:"SOL",ticker:"KXSOL15M-26OCT181430-30",side:"yes",orderId:"order-1",askCents:50};
test("disabled path cannot reserve or submit",async()=>{
 let requests=0;const p={connect:async()=>{requests++;throw Error("unexpected DB write")}};
 const r=await submitAssetG({...params,pool:p,send:async()=>{requests++}});
 assert.equal(r.state,"disabled");assert.equal(requests,0);
});
test("durably reserves before invoking injected exchange sender",async()=>{
 let called=false;const r=await submitAssetG({...params,enabled:true,send:async x=>{called=true;assert.equal(x.contracts,4);return {exchangeOrderId:"ex-1"}}});
 assert(called);assert.equal(r.exchangeOrderId,"ex-1");assert.equal(r.state,"held");
});
test("ambiguous network error holds order and never retries",async()=>{
 let calls=0;const r=await submitAssetG({...params,enabled:true,send:async()=>{calls++;throw Error("timeout")}});
 assert.equal(calls,1);assert.equal(r.reason,"ambiguous_exchange_submission_requires_recovery");
});
test("reject wrong-coin ticker before reservation",async()=>{
 await assert.rejects(submitAssetG({...params,ticker:"KXXRP15M-WRONG",enabled:true,send:async()=>{}}),/invalid_multi_asset_g_submission/);
});
