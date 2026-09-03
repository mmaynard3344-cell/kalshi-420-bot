import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ETH_BOUNDARY_FAST_POLL_MS,
  ETH_BOUNDARY_PRECOMPUTE_LEAD_MS,
  ETH_BOUNDARY_SLOW_POLL_MS,
  _configureEthBoundarySettlementOrchestratorForTesting,
  _resetEthBoundarySettlementOrchestratorForTesting,
  armEthBoundarySettlementOrchestration,
  getEthBoundarySettlementCandidateHints,
  triggerEthBoundarySettlementOrchestration,
} from "./ethBoundarySettlementOrchestrator.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => _resetEthBoundarySettlementOrchestratorForTesting());

test("candidate precomputation is cache-only and never invokes reconciliation or evaluator", async () => {
  let now = 100_000;
  let reconciliationCalls = 0;
  let evaluatorCalls = 0;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  _configureEthBoundarySettlementOrchestratorForTesting({
    now: () => now,
    setTimer: (fn, delay) => {
      timers.push({ fn, delay });
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    reconcile: async () => { reconciliationCalls++; return false; },
    hasUnsettledExposure: async () => true,
    loadCandidateHints: async () => [{
      ticker: "KXETH15M-test", persistedSide: "no", persistedStep: 1,
      winNextSide: "yes", winNextStep: 0, lossNextSide: "no", lossNextStep: 2, createdAtMs: 1,
    }],
    onDurablySettled: async () => { evaluatorCalls++; },
  });
  armEthBoundarySettlementOrchestration(now + ETH_BOUNDARY_PRECOMPUTE_LEAD_MS + 1);
  assert.equal(timers[0]?.delay, 1);
  timers[0]!.fn();
  await flush();
  assert.equal(reconciliationCalls, 0);
  assert.equal(evaluatorCalls, 0);
  assert.deepEqual(getEthBoundarySettlementCandidateHints(), [{
    ticker: "KXETH15M-test", persistedSide: "no", persistedStep: 1,
    winNextSide: "yes", winNextStep: 0, lossNextSide: "no", lossNextStep: 2, createdAtMs: 1,
  }]);
});

test("concurrent lifecycle and scheduled triggers share one authoritative reconciliation", async () => {
  const boundary = 200_000;
  let reconciliationCalls = 0;
  let resolveReconcile!: (value: boolean) => void;
  _configureEthBoundarySettlementOrchestratorForTesting({
    now: () => boundary,
    setTimer: () => ({ unref() {} } as unknown as ReturnType<typeof setTimeout>),
    clearTimer: () => {},
    reconcile: () => {
      reconciliationCalls++;
      return new Promise<boolean>((resolve) => { resolveReconcile = resolve; });
    },
    hasUnsettledExposure: async () => false,
    loadCandidateHints: async () => [],
    onDurablySettled: async () => {},
  });
  triggerEthBoundarySettlementOrchestration(boundary);
  triggerEthBoundarySettlementOrchestration(boundary);
  await flush();
  assert.equal(reconciliationCalls, 1);
  resolveReconcile(true);
  await flush();
});

test("ambiguous prior exposure stays blocked even when reconciliation returns", async () => {
  const boundary = 300_000;
  let evaluatorCalls = 0;
  const delays: number[] = [];
  _configureEthBoundarySettlementOrchestratorForTesting({
    now: () => boundary,
    setTimer: (_fn, delay) => {
      delays.push(delay);
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    reconcile: async () => true,
    hasUnsettledExposure: async () => true,
    loadCandidateHints: async () => [],
    onDurablySettled: async () => { evaluatorCalls++; },
  });
  triggerEthBoundarySettlementOrchestration(boundary);
  await flush();
  assert.equal(evaluatorCalls, 0, "unsettled/ambiguous exposure must not return to evaluation");
  assert.ok(delays.includes(ETH_BOUNDARY_FAST_POLL_MS));
});

test("durable settlement returns control once through the existing evaluator host callback", async () => {
  const boundary = 400_000;
  let evaluatorCalls = 0;
  _configureEthBoundarySettlementOrchestratorForTesting({
    now: () => boundary,
    setTimer: () => ({ unref() {} } as unknown as ReturnType<typeof setTimeout>),
    clearTimer: () => {},
    reconcile: async () => true,
    hasUnsettledExposure: async () => false,
    loadCandidateHints: async () => [],
    onDurablySettled: async () => { evaluatorCalls++; },
  });
  triggerEthBoundarySettlementOrchestration(boundary);
  triggerEthBoundarySettlementOrchestration(boundary);
  await flush();
  assert.equal(evaluatorCalls, 1);
  assert.equal(ETH_BOUNDARY_SLOW_POLL_MS, 1_000);
});