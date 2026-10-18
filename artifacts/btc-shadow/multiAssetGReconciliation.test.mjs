import test from "node:test";
import assert from "node:assert/strict";
import { verifyAssetGSettlement } from "./multiAssetGReconciliation.mjs";
const ticker="KXSOL15M-26OCT181430-30";
function inputs(overrides={}){
 const order={order_id:"exchange-1",client_order_id:"client-1",ticker,side:"no",status:"executed"};
 return {asset:"SOL",clientOrderId:"client-1",ticker,exchangeOrderId:"exchange-1",
 authJson:async(method,path)=>path.includes("/fills")
  ? {fills:[{order_id:"exchange-1",ticker,count:2}]} : {order:{...order,...(overrides.order||{})}},
 publicJson:async()=>({market:{ticker,result:"yes",...(overrides.market||{})}}),
 publicBase:"https://api.elections.kalshi.com/trade-api/v2",...overrides.inputs};
}
test("verified complete settlement returns exchange-derived loss or win",async()=>{
 assert.equal((await verifyAssetGSettlement(inputs())).outcome,"loss");
 assert.equal((await verifyAssetGSettlement(inputs({market:{result:"no"}}))).outcome,"win");
});
test("rejects cross-asset ticker",async()=>{
 await assert.rejects(verifyAssetGSettlement({...inputs(),asset:"XRP"}),/invalid_g_reconciliation_inputs/);
});
test("holds if exchange order identity is unverified",async()=>{
 assert.equal((await verifyAssetGSettlement(inputs({order:{client_order_id:"wrong"}}))).reason,"order_identity_unverified");
});
test("holds if market result missing",async()=>{
 const x=inputs();x.publicJson=async()=>({market:{ticker,result:""}});
 assert.equal((await verifyAssetGSettlement(x)).reason,"settled_market_result_missing");
});
test("holds if fill page incomplete or empty",async()=>{
 const x=inputs();x.authJson=async(method,path)=>path.includes("/fills")?{fills:[],cursor:"next"}:
 {order:{order_id:"exchange-1",client_order_id:"client-1",ticker,side:"no",status:"executed"}};
 assert.equal((await verifyAssetGSettlement(x)).reason,"fill_history_incomplete");
});
test("never assumes bid or ask is a verified outcome side",async()=>{
 assert.equal((await verifyAssetGSettlement(inputs({order:{side:"bid"}}))).reason,"order_side_not_verified");
});

test("holds on open order even when market is settled and fills exist",async()=>{
 assert.equal((await verifyAssetGSettlement(inputs({order:{status:"resting"}}))).reason,"order_not_final");
});
