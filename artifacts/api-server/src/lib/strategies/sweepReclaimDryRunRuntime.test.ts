import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLDryRunOrderSize,
  parseKrakenEth15mRows,
  runLSweepReclaimDryRunOnce,
  type LDryRunRuntimeDeps,
} from "./sweepReclaimDryRunRuntime.js";
import { ETH_15M_MS } from "./sweepReclaimV1.js";

test("L dry-run sizing preserves configured stake cap plus conservative fee headroom",()=>{
  assert.deepEqual(buildLDryRunOrderSize(5000,99),{
    contracts:50,
    maxPrincipalCents:4950,
    feeHeadroomCents:4,
    requestedRiskCents:4954,
  });
});

test("Kraken ETH parser returns exact contiguous finalized candles",()=>{
  const start=0;
  const payload={result:{XETHZUSD:[
    [0,100,110,90,105,0,0,0],
    [900,105,111,95,108,0,0,0],
  ],last:1800}};
  const rows=parseKrakenEth15mRows(payload,start,2,2*ETH_15M_MS+1);
  assert.equal(rows.length,2);
  assert.equal(rows[0]?.open,100);
  assert.equal(rows[1]?.close,108);
  assert.equal(rows[1]?.finalized,true);
});

test("Kraken parser fails closed on a missing interval",()=>{
  const payload={result:{XETHZUSD:[[0,100,110,90,105,0,0,0]],last:1800}};
  assert.deepEqual(parseKrakenEth15mRows(payload,0,2,2*ETH_15M_MS+1),[]);
});


function enableLConfig(){
  process.env.L_SWEEP_RECLAIM_ENABLED="true";
  process.env.L_SWEEP_RECLAIM_LIVE_EXECUTION_ENABLED="false";
  process.env.L_SWEEP_RECLAIM_MAX_ENTRY_PRICE_CENTS="99";
  process.env.L_SWEEP_RECLAIM_STAKE_CENTS="5000";
  process.env.ETH_LONG_REVERSAL_SHARED_CAP_CENTS="10000";
  process.env.L_SWEEP_RECLAIM_MIN_SECONDS_REMAINING="120";
  process.env.L_SWEEP_RECLAIM_ORDER_TYPE="good_till_canceled";
}

function makeHistory(qualifies:boolean){
  const start=10_000_000;
  const prior96=Array.from({length:96},(_,i)=>({
    openTimeMs:start+i*ETH_15M_MS,
    closeTimeMs:start+(i+1)*ETH_15M_MS,
    open:105,high:110,low:100,close:106,finalized:true,
  }));
  const sourceOpen=prior96[95]!.closeTimeMs;
  const source=qualifies
    ? {openTimeMs:sourceOpen,closeTimeMs:sourceOpen+ETH_15M_MS,open:103,high:106,low:99,close:104,finalized:true}
    : {openTimeMs:sourceOpen,closeTimeMs:sourceOpen+ETH_15M_MS,open:104,high:106,low:101,close:105,finalized:true};
  return {prior96,source};
}

function makeDeps(qualifies:boolean,persisted:"created"|"duplicate"|"blocked"="created"){
  const history=makeHistory(qualifies);
  const destOpen=history.source.closeTimeMs;
  const raw={
    ticker:"KXETH15M-26SEP251800-00",
    open_time:new Date(destOpen).toISOString(),
    close_time:new Date(destOpen+ETH_15M_MS).toISOString(),
    yes_ask_dollars:"0.40",
  };
  let persistCalls=0;
  const deps:LDryRunRuntimeDeps={
    settleOpen:async()=>{},
    currentMarket:async()=>raw,
    fetchMarket:async()=>raw,
    fetchEthHistory:async()=>history,
    persistDryRun:async()=>{persistCalls++;return persisted;},
  };
  return {deps,nowMs:destOpen+1,getPersistCalls:()=>persistCalls};
}

test("L no-signal telemetry is observational only",async()=>{
  enableLConfig();
  const {deps,nowMs,getPersistCalls}=makeDeps(false);
  let captured:any=null;
  const out=await runLSweepReclaimDryRunOnce(nowMs,async(input)=>{captured=input;return true;},deps);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(out.outcome,"no_signal");
  assert.equal(getPersistCalls(),0);
  assert.equal(captured?.decision,"no_signal");
  assert.equal(captured?.wouldSubmit,false);
});

test("L qualified decision persists the same dry-run intent when telemetry rejects",async()=>{
  enableLConfig();
  const {deps,nowMs,getPersistCalls}=makeDeps(true,"created");
  const out=await runLSweepReclaimDryRunOnce(nowMs,async()=>{throw new Error("telemetry down");},deps);
  assert.equal(out.outcome,"created");
  assert.equal(getPersistCalls(),1);
});

test("L qualified decision persists the same dry-run intent when telemetry never resolves",async()=>{
  enableLConfig();
  const {deps,nowMs,getPersistCalls}=makeDeps(true,"created");
  const out=await runLSweepReclaimDryRunOnce(nowMs,()=>new Promise<boolean>(()=>{}),deps);
  assert.equal(out.outcome,"created");
  assert.equal(getPersistCalls(),1);
});

test("L qualified evaluator event records actual wouldSubmit result",async()=>{
  enableLConfig();
  const {deps,nowMs}=makeDeps(true,"blocked");
  let captured:any=null;
  const out=await runLSweepReclaimDryRunOnce(nowMs,async(input)=>{captured=input;return true;},deps);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(out.outcome,"blocked");
  assert.equal(captured?.decision,"qualified");
  assert.equal(captured?.wouldSubmit,false);
  assert.equal(captured?.primaryReason,"active_exposure_limit");
});
