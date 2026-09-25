import assert from "node:assert/strict";
import test from "node:test";
import { shadowEvaluatorStatus } from "./shadow-health.mjs";

test("unknown when no evaluator event exists",()=>{
  assert.equal(shadowEvaluatorStatus(1000,null).status,"unknown");
});

test("healthy through exactly two evaluation intervals",()=>{
  const latest={evaluatedAtMs:1000,evaluationIntervalMs:10_000};
  assert.equal(shadowEvaluatorStatus(21_000,latest).status,"healthy");
});

test("stale after two evaluation intervals",()=>{
  const latest={evaluatedAtMs:1000,evaluationIntervalMs:10_000};
  assert.equal(shadowEvaluatorStatus(21_001,latest).status,"stale");
});
