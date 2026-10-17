import test from "node:test";
import assert from "node:assert/strict";
import {verifyBtcSettlementEvidence as verify} from "./btcSettlementEvidence.mjs";
const reservation={clientOrderId:"c1",ticker:"KXBTC15M-EXAMPLE",side:"yes"};
const order={client_order_id:"c1",order_id:"o1",ticker:reservation.ticker,status:"executed",fill_count_fp:"2"};
const fills=[{order_id:"o1",count_fp:"2"}];
const market={ticker:reservation.ticker,result:"no"};
test("verified loss requires matching exchange order fills and settled result",()=>{
 assert.equal(verify({reservation,order,fills,market}).kind,"LOSS");
 assert.equal(verify({reservation,order,fills:[],market}).reason,"incomplete_fill_history");
 assert.equal(verify({reservation,order,fills,market:null}).reason,"settled_market_result_missing");
});
test("zero fills require explicit terminal order and zero reported fills",()=>{
 assert.equal(verify({reservation,order:{...order,fill_count_fp:"0",status:"canceled"},fills:[],market:null}).kind,"ZERO_FILL");
 assert.equal(verify({reservation,order:{...order,fill_count_fp:"0",status:"resting"},fills:[],market:null}).ready,false);
});
test("identity mismatches block settlements",()=>{
 assert.equal(verify({reservation,order:{...order,client_order_id:"other"},fills,market}).ready,false);
 assert.equal(verify({reservation,order,fills:[{order_id:"wrong",count_fp:"2"}],market}).ready,false);
});
