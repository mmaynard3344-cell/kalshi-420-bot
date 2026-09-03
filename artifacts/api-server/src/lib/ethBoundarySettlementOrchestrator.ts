/**
 * Boundary-only orchestration for the ETH martingale settlement path.
 *
 * This module has no order, database-write, sequence-transition, or exchange
 * authority. It can only call the existing authoritative reconciliation and,
 * after that path proves there is no unresolved exposure, hand control back to
 * the existing market evaluator route supplied by its host.
 */
export const ETH_BOUNDARY_FAST_POLL_UNTIL_MS = 5_000;
export const ETH_BOUNDARY_POLL_DEADLINE_MS = 30_000;
export const ETH_BOUNDARY_FAST_POLL_MS = 250;
export const ETH_BOUNDARY_SLOW_POLL_MS = 1_000;
export const ETH_BOUNDARY_PRECOMPUTE_LEAD_MS = 15_000;

export type EthSettlementCandidateHint = Readonly<{
  ticker: string;
  persistedSide: "yes" | "no";
  persistedStep: number;
  winNextSide: "yes" | "no";
  winNextStep: number;
  lossNextSide: "yes" | "no";
  lossNextStep: number;
  createdAtMs: number;
}>;

type Dependencies = {
  now: () => number;
  setTimer: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  reconcile: () => Promise<boolean>;
  hasUnsettledExposure: () => Promise<boolean | null>;
  loadCandidateHints: () => Promise<EthSettlementCandidateHint[]>;
  onDurablySettled: () => Promise<void>;
};

let deps: Dependencies | null = null;
let targetBoundaryMs: number | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let precomputeTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight: Promise<void> | null = null;
let candidates: EthSettlementCandidateHint[] = [];

function requireDeps(): Dependencies {
  if (!deps) throw new Error("ETH boundary settlement orchestrator was not configured");
  return deps;
}

function clearTimer(which: "poll" | "precompute"): void {
  const timer = which === "poll" ? pollTimer : precomputeTimer;
  if (timer != null) requireDeps().clearTimer(timer);
  if (which === "poll") pollTimer = null;
  else precomputeTimer = null;
}

function stopPolling(): void {
  clearTimer("poll");
  targetBoundaryMs = null;
}

function nextDelayMs(now: number): number | null {
  if (targetBoundaryMs == null) return null;
  const elapsed = now - targetBoundaryMs;
  if (elapsed < 0) return Math.max(0, -elapsed);
  if (elapsed > ETH_BOUNDARY_POLL_DEADLINE_MS) return null;
  return elapsed < ETH_BOUNDARY_FAST_POLL_UNTIL_MS
    ? ETH_BOUNDARY_FAST_POLL_MS
    : ETH_BOUNDARY_SLOW_POLL_MS;
}

function armNextPoll(): void {
  const d = requireDeps();
  clearTimer("poll");
  const delay = nextDelayMs(d.now());
  if (delay == null) {
    stopPolling();
    return;
  }
  pollTimer = d.setTimer(() => {
    pollTimer = null;
    void runPoll();
  }, delay);
  pollTimer.unref?.();
}

async function runPrecompute(): Promise<void> {
  precomputeTimer = null;
  // Hints intentionally contain only persisted immutable prior-order facts.
  // They are never read by reconciliation, reservation, or submission.
  candidates = await requireDeps().loadCandidateHints();
}

async function runPoll(): Promise<void> {
  if (pollInFlight != null) {
    return pollInFlight;
  }
  const d = requireDeps();
  const current = (async () => {
    const settled = await d.reconcile();
    const exposure = settled ? await d.hasUnsettledExposure() : true;
    if (settled && exposure === false) {
      stopPolling();
      // The host must use its normal evaluator path; this module has no
      // reference to the evaluator or an order endpoint.
      await d.onDurablySettled();
      return;
    }
    armNextPoll();
  })();
  pollInFlight = current;
  try {
    await current;
  } finally {
    if (pollInFlight === current) pollInFlight = null;
  }
}

/** Arm a future close boundary. Safe to call repeatedly for the same boundary. */
export function armEthBoundarySettlementOrchestration(boundaryMs: number): void {
  const d = requireDeps();
  if (!Number.isFinite(boundaryMs)) return;
  if (targetBoundaryMs !== boundaryMs) {
    stopPolling();
    clearTimer("precompute");
    candidates = [];
    targetBoundaryMs = boundaryMs;
    const precomputeDelay = boundaryMs - ETH_BOUNDARY_PRECOMPUTE_LEAD_MS - d.now();
    if (precomputeDelay > 0) {
      precomputeTimer = d.setTimer(() => { void runPrecompute().catch(() => {}); }, precomputeDelay);
      precomputeTimer.unref?.();
    } else if (d.now() < boundaryMs) {
      void runPrecompute().catch(() => {});
    }
  }
  armNextPoll();
}

/** Lifecycle events only accelerate the same authoritative reconciliation call. */
export function triggerEthBoundarySettlementOrchestration(boundaryMs: number): void {
  armEthBoundarySettlementOrchestration(boundaryMs);
  if (requireDeps().now() >= boundaryMs) void runPoll();
}

export function getEthBoundarySettlementCandidateHints(): readonly EthSettlementCandidateHint[] {
  return candidates.map((candidate) => ({ ...candidate }));
}

export function _configureEthBoundarySettlementOrchestratorForTesting(overrides: Partial<Dependencies>): void {
  deps = {
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    reconcile: async () => false,
    hasUnsettledExposure: async () => true,
    loadCandidateHints: async () => [],
    onDurablySettled: async () => {},
    ...overrides,
  };
}

export function _resetEthBoundarySettlementOrchestratorForTesting(): void {
  if (deps) {
    clearTimer("poll");
    clearTimer("precompute");
  }
  deps = null;
  targetBoundaryMs = null;
  pollInFlight = null;
  candidates = [];
}