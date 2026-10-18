import test from "node:test";
import assert from "node:assert/strict";
import {reconcileEthG} from "./recovery.mjs";
const ticker="KXETH15M-26OCT181530-30";
const pending={clientOrderId:"client1",ticker,side:"yes",exchangeOrderId:"exchange1"};
const order={order_id:"exchange1",client_order_id:"client1",ticker};
function args(){return {pending,authJson:async(method,path)=>path.includes("/fills")?{fills:[{order_id:"exchange1",ticker,count:2}]}:{order},
 marketJson:async()=>({market:{ticker,result:"yes"}})}}
test("verified outcome based on authenticated order, fills and final market",async()=>{
 const x=await reconcileEthG(args());assert.equal(x.state,"verified");assert.equal(x.outcome,"win");assert.equal(x.filledContracts,2);
});
test("does not infer zero fill from empty authenticated fills",async()=>{
 const x=args();x.authJson=async(method,path)=>path.includes("/fills")?{fills:[]}:{order};
 assert.equal((await reconcileEthG(x)).reason,"zero_fill_requires_exchange_finality");
});
test("keeps unresolved settlement held",async()=>{
 const x=args();x.marketJson=async()=>({market:{ticker,result:""}});
 assert.equal((await reconcileEthG(x)).reason,"settlement_not_final");
});
test("rejects mistaken exchange order identity",async()=>{
 const x=args();x.authJson=async(method,path)=>path.includes("/fills")?{fills:[]}:{order:{...order,client_order_id:"other"}};
 assert.equal((await reconcileEthG(x)).reason,"order_identity_mismatch");
});
test("does not release orphan when order history is empty",async()=>{
 const x=args();x.pending={...pending,exchangeOrderId:null};x.authJson=async()=>({orders:[]});
 assert.equal((await reconcileEthG(x)).reason,"order_absent_unverified");
});
test("fully paginates fills before deciding",async()=>{
 const x=args();x.authJson=async(method,path)=>{
 if(!path.includes("/fills"))return {order};
 if(!path.includes("cursor="))return {fills:[{order_id:"exchange1",ticker,count:1}],cursor:"page2"};
 return {fills:[{order_id:"exchange1",ticker,count:2}]};
 };
 assert.equal((await reconcileEthG(x)).filledContracts,3);
});
