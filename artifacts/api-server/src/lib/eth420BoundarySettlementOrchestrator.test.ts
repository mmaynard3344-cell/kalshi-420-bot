import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ETH420_BOUNDARY_FAST_POLL_MS, ETH420_BOUNDARY_PRECOMPUTE_LEAD_MS,
  _configureEth420BoundarySettlementOrchestratorForTesting,
  _resetEth420BoundarySettlementOrchestratorForTesting,
  armEth420BoundarySettlementOrchestration,
  getEth420BoundarySettlementCandidateHints,
  triggerEth420BoundarySettlementOrchestration,
} from "./eth420BoundarySettlementOrchestrator.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => _resetEth420BoundarySettlementOrchestratorForTesting());

test("candidate hints are cache-only and cannot reconcile or invoke its evaluator", async () => {
  let now = 1_000; let reconciled = 0; let evaluated = 0;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  _configureEth420BoundarySettlementOrchestratorForTesting({
    now: () => now, setTimer: (fn, delay) => {
      timers.push({ fn, delay }); return { unref() {} } as ReturnType<typeof setTimeout>;
    }, clearTimer: () => {}, reconcile: async () => { reconciled++; return 0; },
    hasUnresolvedExposure: async () => true,
    loadCandidateHints: async () => [{ ticker: "KXETH15M-test", persistedSide: "no", persistedStep: 1,
      winNextSide: "yes", winNextStep: 0, lossNextSide: "no", lossNextStep: 2, createdAtMs: 0 }],
    onDurablySettled: async () => { evaluated++; },
  });
  armEth420BoundarySettlementOrchestration(now + ETH420_BOUNDARY_PRECOMPUTE_LEAD_MS + 1);
  assert.equal(timers[0]?.delay, 1); timers[0]!.fn(); await flush();
  assert.equal(reconciled, 0); assert.equal(evaluated, 0);
  assert.equal(getEth420BoundarySettlementCandidateHints().length, 1);
});

test("scheduled and lifecycle candidate triggers coalesce into one reconciliation", async () => {
  const boundary = 2_000; let calls = 0; let resolve!: (n: number) => void;
  _configureEth420BoundarySettlementOrchestratorForTesting({
    now: () => boundary, setTimer: () => ({ unref() {} } as ReturnType<typeof setTimeout>), clearTimer: () => {},
    reconcile: () => { calls++; return new Promise<number>((done) => { resolve = done; }); },
    hasUnresolvedExposure: async () => false, loadCandidateHints: async () => [], onDurablySettled: async () => {},
  });
  triggerEth420BoundarySettlementOrchestration(boundary); triggerEth420BoundarySettlementOrchestration(boundary);
  await flush(); assert.equal(calls, 1); resolve(1); await flush();
});

test("candidate unresolved exposure blocks evaluator handoff", async () => {
  const delays: number[] = []; let calls = 0;
  _configureEth420BoundarySettlementOrchestratorForTesting({
    now: () => 3_000, setTimer: (_fn, delay) => {
      delays.push(delay); return { unref() {} } as ReturnType<typeof setTimeout>;
    }, clearTimer: () => {}, reconcile: async () => 0, hasUnresolvedExposure: async () => true,
    loadCandidateHints: async () => [], onDurablySettled: async () => { calls++; },
  });
  triggerEth420BoundarySettlementOrchestration(3_000); await flush();
  assert.equal(calls, 0); assert.ok(delays.includes(ETH420_BOUNDARY_FAST_POLL_MS));
});

test("candidate durable clearance hands back to its evaluator exactly once", async () => {
  let calls = 0;
  _configureEth420BoundarySettlementOrchestratorForTesting({
    now: () => 4_000, setTimer: () => ({ unref() {} } as ReturnType<typeof setTimeout>), clearTimer: () => {},
    reconcile: async () => 1, hasUnresolvedExposure: async () => false,
    loadCandidateHints: async () => [], onDurablySettled: async () => { calls++; },
  });
  triggerEth420BoundarySettlementOrchestration(4_000); triggerEth420BoundarySettlementOrchestration(4_000);
  await flush(); assert.equal(calls, 1);
  triggerEth420BoundarySettlementOrchestration(4_000);
  await flush(); assert.equal(calls, 1);
});

test("an older reconciliation cannot hand off or cancel a newly armed boundary", async () => {
  const firstBoundary = 5_000;
  const secondBoundary = 6_000;
  let now = firstBoundary; let reconcileCalls = 0; let handoffs = 0; let resolveFirst!: (value: number) => void;
  _configureEth420BoundarySettlementOrchestratorForTesting({
    now: () => now,
    setTimer: () => ({ unref() {} } as ReturnType<typeof setTimeout>), clearTimer: () => {},
    reconcile: () => {
      reconcileCalls++;
      return reconcileCalls === 1 ? new Promise<number>((resolve) => { resolveFirst = resolve; }) : Promise.resolve(1);
    },
    hasUnresolvedExposure: async () => false,
    loadCandidateHints: async () => [],
    onDurablySettled: async () => { handoffs++; },
  });
  triggerEth420BoundarySettlementOrchestration(firstBoundary);
  await flush();
  armEth420BoundarySettlementOrchestration(secondBoundary);
  resolveFirst(1);
  await flush(); await flush();
  assert.equal(reconcileCalls, 1);
  assert.equal(handoffs, 0);
  now = secondBoundary;
  triggerEth420BoundarySettlementOrchestration(secondBoundary);
  await flush(); await flush();
  assert.equal(reconcileCalls, 2);
  assert.equal(handoffs, 1);
});