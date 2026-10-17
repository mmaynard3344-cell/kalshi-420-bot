import test from "node:test";
import assert from "node:assert/strict";
import {initialBtcLadder,stakeCents,claim,confirmFill,confirmZeroFill,confirmSettlement,sizeBtcOrder} from "./btcSharedLadder.mjs";
test("six consecutive losses follow 2,4,8,16,32,64 and reset",()=>{
 let s=initialBtcLadder();
 for(const amount of [200,400,800,1600,3200,6400]){
  assert.equal(stakeCents(s),amount);
  const id="o"+amount,settlement="s"+amount;
  s=confirmSettlement(confirmFill(claim(s,id),id,settlement),settlement,"LOSS");
 }
 assert.equal(stakeCents(s),200);
});
test("unsettled claims block reentry; cancelled zero fill does not advance",()=>{
 let s=claim(initialBtcLadder(),"a");
 assert.throws(()=>claim(s,"b"));
 s=confirmZeroFill(s,"a");
 assert.equal(stakeCents(s),200);
 s=confirmFill(claim(s,"b"),"b","s");
 assert.throws(()=>claim(s,"c"));
 s=confirmSettlement(s,"s","WIN");
 assert.equal(stakeCents(s),200);
});
test("fee-aware sizing never overspends stake",()=>{
 const s=initialBtcLadder();
 const x=sizeBtcOrder(s,50,(n)=>Math.ceil(n*2));
 assert.deepEqual(x,{contracts:3,totalCents:156});
});
