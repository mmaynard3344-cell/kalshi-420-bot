import test from "node:test";
import assert from "node:assert/strict";
import { reserveAssetG, recordVerifiedAssetGFill, settleVerifiedAssetG } from "./multiAssetGStore.mjs";
const state = { asset:"SOL", step:0, pending_order_id:null, pending_settlement_id:null, version:0 };
function fakePool() {
 const queries=[];
 const client = {
   async query(sql,args=[]){
     queries.push({sql,args});
     if(sql.startsWith("SELECT * FROM multi_asset_g_ladders")) return {rows:[{...state}],rowCount:1};
     if(sql.startsWith("SELECT 1 FROM multi_asset_g_order_identity")) return {rows:[],rowCount:0};
     return {rows:[],rowCount:1};
   },release(){}
 };
 return {queries, connect:async()=>client};
}
test("SOL reserves independent order identity and does not issue exchange HTTP",async()=>{
 const p=fakePool();
 const r=await reserveAssetG(p,{asset:"SOL",orderId:"g-sol-order-1",ticker:"KXSOL15M-26OCT181430-30",side:"no"});
 assert.equal(r.stakeCents,200);
 assert(p.queries.some(q=>q.sql.includes("multi_asset_g_order_identity")));
 assert(p.queries.some(q=>q.sql==="COMMIT"));
});
test("wrong-market order cannot reserve another asset's ladder",async()=>{
 const p=fakePool();
 await assert.rejects(reserveAssetG(p,{asset:"SOL",orderId:"wrong",ticker:"KXBTC15M-TEST",side:"yes"}),/ticker_mismatch/);
 assert.equal(p.queries.length,0);
});
test("settlement cannot advance ladder without independently verified fill",async()=>{
 const p=fakePool();
 await assert.rejects(settleVerifiedAssetG(p,{asset:"SOL",orderId:"sol-1",settlementId:"s-1",result:"win"}),/order_mismatch/);
 assert(p.queries.some(q=>q.sql==="ROLLBACK"));
});
test("cannot record a zero or invalid fill as verified",async()=>{
 const p=fakePool();
 await assert.rejects(recordVerifiedAssetGFill(p,{asset:"SOL",orderId:"s1",exchangeOrderId:"ex1",filledContracts:0}),/invalid_verified_fill/);
 assert.equal(p.queries.length,0);
});
