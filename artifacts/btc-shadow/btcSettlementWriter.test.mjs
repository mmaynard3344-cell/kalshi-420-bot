import test from "node:test";
import assert from "node:assert/strict";
import {applyBtcSettlementEvidence} from "./btcSettlementWriter.mjs";
const reservation={clientOrderId:"c1",ticker:"KXBTC15M-EXAMPLE",side:"yes"};
const order={client_order_id:"c1",order_id:"o1",ticker:reservation.ticker,status:"executed",fill_count_fp:2};
test("missing exchange evidence cannot write ladder",async()=>{
 const result=await applyBtcSettlementEvidence({pool:null,reservation,order,fills:[],market:{ticker:reservation.ticker,result:"no"}});
 assert.deepEqual(result,{applied:false,reason:"incomplete_fill_history"});
});
test("valid evidence requires an actual database",async()=>{
 await assert.rejects(()=>applyBtcSettlementEvidence({pool:null,reservation,order,fills:[{order_id:"o1",count_fp:2}],market:{ticker:reservation.ticker,result:"no"}}),/database missing/);
});
