import assert from "node:assert/strict";
import test from "node:test";
import {
  boundShadowEvaluationEvidence,
  recordShadowEvaluation,
  shadowEvaluationRetentionDays,
} from "./shadowEvaluationTelemetry.js";

test("bounds shadow evidence to scalar operational fields",()=>{
  const evidence=boundShadowEvaluationEvidence({
    ok:true,
    number:1.5,
    nested:{raw:"payload"},
    array:[1,2,3],
    long:"x".repeat(400),
  });
  assert.deepEqual(evidence.ok,true);
  assert.deepEqual(evidence.number,1.5);
  assert.equal("nested" in evidence,false);
  assert.equal("array" in evidence,false);
  assert.equal(String(evidence.long).length,256);
});

test("no-signal telemetry forces wouldSubmit false",async()=>{
  let captured:any=null;
  const ok=await recordShadowEvaluation({
    service:"A2",
    evaluatedAtMs:1,
    ticker:"KXBTC15M-X",
    marketOpenTimeMs:0,
    decision:"no_signal",
    primaryReason:"drop_below_threshold",
    wouldSubmit:true,
    evidence:{sourceDropPct:0.1},
    evaluationIntervalMs:10_000,
  },async(input)=>{captured=input;});
  assert.equal(ok,true);
  assert.equal(captured.wouldSubmit,false);
});

test("telemetry rejection is contained",async()=>{
  const ok=await recordShadowEvaluation({
    service:"L",
    evaluatedAtMs:1,
    ticker:"KXETH15M-X",
    marketOpenTimeMs:0,
    decision:"qualified",
    primaryReason:null,
    wouldSubmit:true,
    evidence:null,
    evaluationIntervalMs:10_000,
  },async()=>{throw new Error("db unavailable");});
  assert.equal(ok,false);
});

test("retention setting is explicit and validated",()=>{
  assert.equal(shadowEvaluationRetentionDays({SHADOW_EVALUATION_RETENTION_DAYS:"45"} as NodeJS.ProcessEnv),45);
  assert.equal(shadowEvaluationRetentionDays({SHADOW_EVALUATION_RETENTION_DAYS:"bad"} as NodeJS.ProcessEnv),30);
});
