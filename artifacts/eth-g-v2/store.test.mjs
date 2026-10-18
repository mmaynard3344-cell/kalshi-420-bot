import test from "node:test";
import assert from "node:assert/strict";
import {reserveEthG,attachVerifiedEthGFill,settleVerifiedEthG} from "./store.mjs";
function pool(state={id:1,step:0,pending_client_order_id:null,last_trigger_key:null,version:0},filled=true){
 const queries=[];
 return {queries,async connect(){return {async query(sql,args=[]){queries.push([sql,args]);
 if(sql.startsWith("SELECT * FROM eth_g_v2_state"))return {rowCount:1,rows:[state]};
 if(sql.startsWith("SELECT 1 FROM eth_g_v2_orders"))return {rowCount:filled?1:0,rows:[]};
 return {rowCount:1,rows:[]};
 },release(){}}}};
}
test("reserve writes identity before pending state in a transaction",async()=>{
 const p=pool();const r=await reserveEthG(p,{clientOrderId:"cid-1",ticker:"KXETH15M-26OCT181530-30",side:"yes",triggerKey:"prior|last"});
 assert.equal(r.stakeCents,200);
 assert(p.queries.findIndex(x=>x[0].includes("INSERT INTO eth_g_v2_orders"))<p.queries.findIndex(x=>x[0].includes("UPDATE eth_g_v2_state")));
 assert.equal(p.queries.at(-1)[0],"COMMIT");
});
test("pending orders block duplicate reservation",async()=>{
 const p=pool({id:1,step:2,pending_client_order_id:"existing",version:1});
 await assert.rejects(reserveEthG(p,{clientOrderId:"new",ticker:"KXETH15M-X",side:"no",triggerKey:"another"}),/order_pending/);
 assert.equal(p.queries.at(-1)[0],"ROLLBACK");
});
test("replayed signal blocks entry even after completed order",async()=>{
 const p=pool({id:1,step:3,pending_client_order_id:null,last_trigger_key:"same",version:1});
 await assert.rejects(reserveEthG(p,{clientOrderId:"new",ticker:"KXETH15M-X",side:"yes",triggerKey:"same"}),/trigger_replayed/);
});
test("verified fills must correspond to pending order",async()=>{
 const p=pool();await assert.rejects(attachVerifiedEthGFill(p,{clientOrderId:"wrong",exchangeOrderId:"exchange-1",filledContracts:2}),/order_mismatch/);
});
test("settlement refuses to advance without verified filled order",async()=>{
 const p=pool({id:1,step:2,pending_client_order_id:"cid",version:3},false);
 await assert.rejects(settleVerifiedEthG(p,{clientOrderId:"cid",settlementId:"exchange-1",outcome:"loss"}),/verified_fill_missing/);
});
test("verified loss advances step and clears pending state",async()=>{
 const p=pool({id:1,step:2,pending_client_order_id:"cid",version:3},true);
 const r=await settleVerifiedEthG(p,{clientOrderId:"cid",settlementId:"exchange-1",outcome:"loss"});
 assert.equal(r.step,3);assert.equal(r.stakeCents,1600);assert.equal(p.queries.at(-1)[0],"COMMIT");
});
