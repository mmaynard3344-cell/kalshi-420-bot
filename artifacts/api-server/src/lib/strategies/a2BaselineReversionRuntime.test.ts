import assert from "node:assert/strict";
import test from "node:test";
import {
  destinationFromRawMarket,
  parseKrakenBtc15mCandle,
  runA2BaselineReversionRuntimeOnce,
} from "./a2BaselineReversionRuntime.js";
import type {
  A2ShadowClaimInput,
  A2ShadowClaimOutcome,
  A2ShadowEvidenceRecord,
  A2ShadowStore,
} from "./a2BaselineReversionShadowStore.js";

class MemoryStore implements A2ShadowStore {
  evidence: A2ShadowEvidenceRecord[] = [];
  claims = new Map<string, { input: A2ShadowClaimInput; state: "shadow_open" | "shadow_settled" }>();
  async recordEvidence(input: A2ShadowEvidenceRecord): Promise<boolean> { this.evidence.push(input); return true; }
  async countOpen(): Promise<number> { return [...this.claims.values()].filter((x)=>x.state==="shadow_open").length; }
  async listOpen(): Promise<Array<{id:string;destinationTicker:string}>> {
    return [...this.claims.entries()].filter(([,x])=>x.state==="shadow_open").map(([id,x])=>({id,destinationTicker:x.input.destinationTicker}));
  }
  async claimOpen(input: A2ShadowClaimInput): Promise<A2ShadowClaimOutcome> {
    if (await this.countOpen() >= 1) return "active_exposure_limit";
    if (this.claims.has(input.id)) return "duplicate";
    this.claims.set(input.id,{input,state:"shadow_open"});
    return "opened";
  }
  async settle(input:{id:string;settlementResult:"yes"|"no";settledAtMs:number}):Promise<boolean>{
    const row=this.claims.get(input.id); if(!row||row.state!=="shadow_open") return false;
    this.claims.set(input.id,{...row,state:"shadow_settled"}); return true;
  }
}

const openMs=1_800_000;
const rawMarket={
  ticker:"KXBTC15M-26SEP250015-15",
  open_time:new Date(openMs).toISOString(),
  close_time:new Date(openMs+900_000).toISOString(),
  floor_strike:100_000,
  yes_ask_dollars:"0.45",
  yes_sub_title:"Bitcoin price above $100,000",
  rules_primary:"Resolves Yes if the Bitcoin price is above the strike at expiration.",
};

test("parses exact finalized Kraken source candle",()=>{
  const payload={result:{XXBTZUSD:[[900,100,101,98.5,99,99.5,10,20]],last:1800}};
  const c=parseKrakenBtc15mCandle(payload,900_000,1_800_001);
  assert.equal(c?.finalized,true);
  assert.equal(c?.open,100);
  assert.equal(c?.close,99);
});

test("destination requires BTC above-strike YES semantics",()=>{
  const d=destinationFromRawMarket(rawMarket);
  assert.equal(d?.yesSettlesAboveStrike,true);
  assert.equal(d?.yesAskCents,45);
  assert.equal(destinationFromRawMarket({...rawMarket,rules_primary:"Resolves Yes if Bitcoin is below the strike."})?.yesSettlesAboveStrike,false);
});

test("runtime opens shadow claim from immediate finalized source and current destination",async()=>{
  process.env.A2_BASELINE_REVERSION_ENABLED="true";
  const store=new MemoryStore();
  const out=await runA2BaselineReversionRuntimeOnce(store,{
    nowMs:()=>openMs+1,
    fetchCurrentMarket:async()=>rawMarket,
    fetchMarket:async()=>null,
    fetchSourceCandle:async(sourceOpen)=>({
      openTimeMs:sourceOpen,closeTimeMs:sourceOpen+900_000,
      open:100,high:101,low:98.5,close:99,finalized:true,
    }),
  });
  assert.equal(out.outcome,"shadow_opened");
  assert.equal(store.claims.size,1);
});

test("runtime settles prior shadow claim before evaluating later signal",async()=>{
  process.env.A2_BASELINE_REVERSION_ENABLED="true";
  const store=new MemoryStore();
  await runA2BaselineReversionRuntimeOnce(store,{
    nowMs:()=>openMs+1,
    fetchCurrentMarket:async()=>rawMarket,
    fetchMarket:async()=>null,
    fetchSourceCandle:async(sourceOpen)=>({
      openTimeMs:sourceOpen,closeTimeMs:sourceOpen+900_000,
      open:100,high:101,low:98.5,close:99,finalized:true,
    }),
  });
  const secondOpen=openMs+900_000;
  const secondRaw={...rawMarket,ticker:"KXBTC15M-26SEP250030-30",open_time:new Date(secondOpen).toISOString(),close_time:new Date(secondOpen+900_000).toISOString()};
  const out=await runA2BaselineReversionRuntimeOnce(store,{
    nowMs:()=>secondOpen+1,
    fetchCurrentMarket:async()=>secondRaw,
    fetchMarket:async()=>({result:"yes"}),
    fetchSourceCandle:async(sourceOpen)=>({
      openTimeMs:sourceOpen,closeTimeMs:sourceOpen+900_000,
      open:100,high:101,low:98.5,close:99,finalized:true,
    }),
  });
  assert.equal(out.outcome,"shadow_opened");
  assert.equal(await store.countOpen(),1);
});
