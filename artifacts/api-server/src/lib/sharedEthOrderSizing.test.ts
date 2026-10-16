import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {ethContractsWithinBudget} from "./sharedEthOrderSizing";
describe("shared ETH fee-inclusive order budget",()=>{
 const fee=(contracts:number)=>Math.ceil(contracts*2);
 it("never exceeds 1-dollar rung after fees",()=>{
  const x=ethContractsWithinBudget(100,50,fee);
  assert.equal(x.contracts,1);assert.equal(x.totalCents,52);
 });
 it("prices a larger rung within budget including fees",()=>{
  const x=ethContractsWithinBudget(200,50,fee);
  assert.equal(x.contracts,3);assert.equal(x.totalCents,156);
 });
 it("refuses unfundable orders",()=>{
  assert.equal(ethContractsWithinBudget(1,50,fee).contracts,0);
 });
 it("rejects invalid or missing fee assumptions",()=>{
  assert.throws(()=>ethContractsWithinBudget(100,50,()=>NaN));
  assert.throws(()=>ethContractsWithinBudget(100,0,fee));
 });
});