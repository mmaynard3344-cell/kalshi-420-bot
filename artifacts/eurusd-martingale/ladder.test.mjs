import assert from "node:assert/strict";
import test from "node:test";
import {USD_STAKES_CENTS,nextUsdStep,classifyUsdSettlement,stakeForUsdStep} from "./ladder.mjs";
test("six sequential losses cycle budgets and reset",()=>{
 let s=0;const seen=[];for(let i=0;i<6;i++){seen.push(stakeForUsdStep(s));s=nextUsdStep(s,"LOSS")}
 assert.deepEqual(seen,[100,200,400,800,1600,3200]);assert.equal(s,0);
});
test("wins reset and zero-fill does not advance",()=>{
 assert.equal(nextUsdStep(4,"WIN"),0);assert.equal(nextUsdStep(3,"ZERO_FILL"),3);
});
test("canceled zero fill is not a loss",()=>{
 assert.equal(classifyUsdSettlement({filledContracts:0,orderStatus:"canceled",marketResult:"no",side:"YES"}),"ZERO_FILL");
});
test("only real fills with resolved market result count",()=>{
 assert.equal(classifyUsdSettlement({filledContracts:1,orderStatus:"executed",marketResult:"yes",side:"YES"}),"WIN");
 assert.equal(classifyUsdSettlement({filledContracts:1,orderStatus:"executed",marketResult:"no",side:"YES"}),"LOSS");
 assert.equal(classifyUsdSettlement({filledContracts:1,orderStatus:"executed",marketResult:null,side:"YES"}),"UNRESOLVED");
 assert.equal(classifyUsdSettlement({filledContracts:0,orderStatus:"open",marketResult:"yes",side:"YES"}),"UNRESOLVED");
});
test("fail closed on invalid inputs",()=>{
 assert.throws(()=>nextUsdStep(0,"PREDICTED_LOSS"));
 assert.throws(()=>stakeForUsdStep(6));assert.throws(()=>nextUsdStep(-1,"WIN"));
});
