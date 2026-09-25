import assert from "node:assert/strict";
import test from "node:test";
import { shadowEvaluatorStatus } from "./shadow-health.mjs";

test("unknown before the first evaluation",()=>assert.equal(shadowEvaluatorStatus(1,null).status,"unknown"));
test("healthy through two stored evaluation intervals",()=>assert.equal(shadowEvaluatorStatus(21_000,{evaluatedAtMs:1_000,evaluationIntervalMs:10_000}).status,"healthy"));
test("stale after two stored evaluation intervals",()=>assert.equal(shadowEvaluatorStatus(21_001,{evaluatedAtMs:1_000,evaluationIntervalMs:10_000}).status,"stale"));
