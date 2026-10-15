import test from "node:test";
import assert from "node:assert/strict";
import {submitReservedBtcOrder} from "./btcLadderOrderAdapter.mjs";
function pool(){
 const row={step:0,pending_order_id:null,pending_settlement_id:null,last_settlement_id:null,version:0};
 let postCount=0;
 const client={release(){},async query(q,args=[]){
  if(q.startsWith("SELECT step"))return {rows:[{...row}],rowCount:1};
  if(q.startsWith("UPDATE btc_shared_ladder")){
   [row.step,row.pending_order_id,row.pending_settlement_id,row.last_settlement_id,row.version]=args.slice(0,5);return {rowCount:1};
  }
  return {rowCount:1,rows:[]};
 }};
 return {db:{connect:async()=>client},state:row,posted:()=>postCount,send:async()=>{postCount++;return {kind:"accepted",exchangeOrderId:"ex1"}}};
}
test("reserves BTC stake before sending; leaves order pending",async()=>{
 const p=pool();
 const result=await submitReservedBtcOrder({pool:p.db,orderId:"id1",ticker:"KXBTC15M-EXAMPLE",side:"yes",askCents:50,feeCents:()=>0,send:p.send});
 assert.equal(result.kind,"submitted");
 assert.equal(p.posted(),1);
 assert.equal(p.state.pending_order_id,"id1");
});
test("cannot send second trade before settlement",async()=>{
 const p=pool();
 await submitReservedBtcOrder({pool:p.db,orderId:"id1",ticker:"KXBTC15M-EXAMPLE",side:"yes",askCents:50,feeCents:()=>0,send:p.send});
 await assert.rejects(()=>submitReservedBtcOrder({pool:p.db,orderId:"id2",ticker:"KXBTC15M-EXAMPLE",side:"no",askCents:50,feeCents:()=>0,send:p.send}),/busy/);
 assert.equal(p.posted(),1);
});
test("timeout retains durable pending order",async()=>{
 const p=pool();
 const result=await submitReservedBtcOrder({pool:p.db,orderId:"id1",ticker:"KXBTC15M-EXAMPLE",side:"yes",askCents:50,feeCents:()=>0,send:async()=>{throw Error("timeout")}});
 assert.equal(result.kind,"held");
 assert.equal(p.state.pending_order_id,"id1");
});

test("unaffordable step-one wager never reserves database state or submits",async()=>{
 const p=pool();
 const result=await submitReservedBtcOrder({pool:p.db,orderId:"unaffordable",ticker:"KXBTC15M-EXAMPLE",side:"yes",askCents:99,feeCents:()=>5,send:p.send});
 assert.equal(result.kind,"skipped");
 assert.equal(p.state.pending_order_id,null);
 assert.equal(p.posted(),0);
});
