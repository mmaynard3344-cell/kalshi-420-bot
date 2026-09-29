import assert from "node:assert/strict";
import test from "node:test";
import { runLSweepReclaimLiveOnce, lLiveClaimId, type LLiveRuntimeDeps } from "./sweepReclaimLiveRuntime.js";
import { ETH_15M_MS, type SweepReclaimRuntimeConfig } from "./sweepReclaimV1.js";

function harness() {
  const prior96 = Array.from({length:96},(_,i)=>({openTimeMs:(100+i)*ETH_15M_MS,closeTimeMs:(101+i)*ETH_15M_MS,
    open:105,high:110,low:100,close:106,finalized:true}));
  const source = {openTimeMs:196*ETH_15M_MS,closeTimeMs:197*ETH_15M_MS,open:103,high:106,low:99,close:104,finalized:true};
  const config: SweepReclaimRuntimeConfig = {enabled:true,liveExecutionEnabled:true,activationReady:true,
    stakeCents:5000,maxEntryPriceCents:75,sharedCorrelatedExposureCapCents:5200,minimumSecondsRemaining:120,
    orderType:"good_till_canceled",unresolved:[]};
  let submitted=0,claimed=0,recovered=0;
  const ids = new Set<string>();
  const deps: LLiveRuntimeDeps = { config:()=>config,permitted:()=>true,reconcile:async()=>{recovered++;},
    currentMarket:async()=>({ticker:"KXETH15M-LIVE-TEST",status:"active",exchange_index:2,
      open_time:new Date(source.closeTimeMs).toISOString(),close_time:new Date(source.closeTimeMs+ETH_15M_MS).toISOString()}),
    history:async()=>({source,prior96}),claim:async input=>{claimed++;if(ids.has(input.id))return false;ids.add(input.id);return true;},
    execute:async input=>{assert.equal(input.exchangeIndex,2);assert.equal(input.config.stakeCents,5000);
      assert.equal(input.config.maxEntryPriceCents,75);assert.equal(input.clientOrderId,input.claimId);submitted++;return "submitted";}};
  return {deps,config,source,now:source.closeTimeMs+1000,get submitted(){return submitted;},get claimed(){return claimed;},get recovered(){return recovered;}};
}

test("qualified finalized source reaches live adapter once across repeated polls",async()=>{
  const h=harness(); assert.equal(await runLSweepReclaimLiveOnce(h.now,h.deps),"submitted");
  assert.equal(await runLSweepReclaimLiveOnce(h.now,h.deps),"duplicate_or_storage_unavailable");assert.equal(h.submitted,1);
});
test("disabled live flag still recovers orders but never claims or submits",async()=>{
  const h=harness();h.config.liveExecutionEnabled=false;assert.equal(await runLSweepReclaimLiveOnce(h.now,h.deps),"disabled");
  assert.equal(h.recovered,1);assert.equal(h.claimed,0);assert.equal(h.submitted,0);
});
test("unfinished source and missing routing never submit",async()=>{
  const h=harness();h.source.finalized=false;assert.equal(await runLSweepReclaimLiveOnce(h.now,h.deps),"source_not_final");
  h.deps.currentMarket=async()=>({ticker:"KXETH15M-TEST",status:"active",open_time:new Date(h.now-1000).toISOString(),close_time:new Date(h.now+800000).toISOString()});
  assert.equal(await runLSweepReclaimLiveOnce(h.now,h.deps),"invalid_destination");assert.equal(h.submitted,0);
});
test("halt and late entry prevent execution",async()=>{
  const h=harness();h.deps.permitted=()=>false;assert.equal(await runLSweepReclaimLiveOnce(h.now,h.deps),"disabled");
  h.deps.permitted=()=>true;assert.equal(await runLSweepReclaimLiveOnce(h.source.closeTimeMs+ETH_15M_MS-1000,h.deps),"too_late");assert.equal(h.submitted,0);
});
test("claim identifier is a stable UUID specific to source and destination",()=>{
  const id=lLiveClaimId(100,"KXETH15M-TEST");assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id,lLiveClaimId(100,"KXETH15M-TEST"));assert.notEqual(id,lLiveClaimId(101,"KXETH15M-TEST"));
});
