/**
 * Candidate-only boundary orchestration. This module has no order, database
 * write, sequence-transition, or exchange authority. It only accelerates the
 * established candidate reconciliation and hands back to its host evaluator
 * after durable recovery proves candidate exposure is clear.
 */
export const ETH420_BOUNDARY_FAST_POLL_UNTIL_MS = 5_000;
export const ETH420_BOUNDARY_POLL_DEADLINE_MS = 30_000;
export const ETH420_BOUNDARY_FAST_POLL_MS = 250;
export const ETH420_BOUNDARY_SLOW_POLL_MS = 1_000;
export const ETH420_BOUNDARY_PRECOMPUTE_LEAD_MS = 15_000;

export type Eth420SettlementCandidateHint = Readonly<{
  ticker: string; persistedSide: "yes" | "no"; persistedStep: number;
  winNextSide: "yes" | "no"; winNextStep: number;
  lossNextSide: "yes" | "no"; lossNextStep: number; createdAtMs: number;
}>;

type Dependencies = {
  now: () => number;
  setTimer: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  reconcile: () => Promise<number>;
  hasUnresolvedExposure: () => Promise<boolean | null>;
  loadCandidateHints: () => Promise<Eth420SettlementCandidateHint[]>;
  onDurablySettled: () => Promise<void>;
};

let deps: Dependencies | null = null;
let targetBoundaryMs: number | null = null;
let targetGeneration = 0;
let completedBoundaryMs: number | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let precomputeTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight: Promise<void> | null = null;
let hints: Eth420SettlementCandidateHint[] = [];

function requireDeps(): Dependencies {
  if (!deps) throw new Error("ETH 420 boundary settlement orchestrator was not configured");
  return deps;
}
function clearTimer(which: "poll" | "precompute"): void {
  const timer = which === "poll" ? pollTimer : precomputeTimer;
  if (timer != null) requireDeps().clearTimer(timer);
  if (which === "poll") pollTimer = null; else precomputeTimer = null;
}
function nextDelayMs(now: number): number | null {
  if (targetBoundaryMs == null) return null;
  const elapsed = now - targetBoundaryMs;
  if (elapsed < 0) return -elapsed;
  if (elapsed > ETH420_BOUNDARY_POLL_DEADLINE_MS) return null;
  return elapsed < ETH420_BOUNDARY_FAST_POLL_UNTIL_MS
    ? ETH420_BOUNDARY_FAST_POLL_MS : ETH420_BOUNDARY_SLOW_POLL_MS;
}
function armNextPoll(): void {
  const d = requireDeps();
  clearTimer("poll");
  const delay = nextDelayMs(d.now());
  if (delay == null) return;
  const generation = targetGeneration;
  pollTimer = d.setTimer(() => { pollTimer = null; void runPoll(generation); }, delay);
  pollTimer.unref?.();
}
async function runPrecompute(generation: number): Promise<void> {
  precomputeTimer = null;
  // These diagnostics are never read by candidate recovery, state, reservation,
  // sizing, or submission code.
  const loaded = await requireDeps().loadCandidateHints();
  if (generation === targetGeneration) hints = loaded;
}
async function runPoll(generation = targetGeneration): Promise<void> {
  if (pollInFlight != null) return pollInFlight;
  if (generation !== targetGeneration || targetBoundaryMs == null
    || completedBoundaryMs === targetBoundaryMs) return;
  const d = requireDeps();
  const boundaryMs = targetBoundaryMs;
  const current = (async () => {
    await d.reconcile();
    // A newer boundary owns its own reconciliation/handoff. An older completion
    // must never cancel, clear hints for, or evaluate the new boundary.
    if (generation !== targetGeneration || boundaryMs !== targetBoundaryMs) return;
    // Exact false is required; unknown storage state remains fail-closed.
    if (await d.hasUnresolvedExposure() === false) {
      if (generation !== targetGeneration || boundaryMs !== targetBoundaryMs) return;
      completedBoundaryMs = boundaryMs;
      clearTimer("poll");
      await d.onDurablySettled();
      return;
    }
    armNextPoll();
  })();
  pollInFlight = current;
  try { await current; } finally {
    if (pollInFlight === current) {
      pollInFlight = null;
      // A lifecycle event can retarget while reconciliation is single-flight.
      // Start the current target immediately once the older sweep is finished.
      if (generation !== targetGeneration && targetBoundaryMs != null
        && completedBoundaryMs !== targetBoundaryMs) {
        clearTimer("poll");
        if (d.now() >= targetBoundaryMs) void runPoll(targetGeneration);
        else armNextPoll();
      }
    }
  }
}

export function armEth420BoundarySettlementOrchestration(boundaryMs: number): void {
  const d = requireDeps();
  if (!Number.isFinite(boundaryMs)) return;
  if (completedBoundaryMs != null && boundaryMs <= completedBoundaryMs) return;
  if (targetBoundaryMs !== boundaryMs) {
    if (targetBoundaryMs != null && boundaryMs < targetBoundaryMs) return;
    clearTimer("poll"); clearTimer("precompute"); hints = []; targetBoundaryMs = boundaryMs;
    targetGeneration++;
    if (completedBoundaryMs != null && boundaryMs > completedBoundaryMs) completedBoundaryMs = null;
    const delay = boundaryMs - ETH420_BOUNDARY_PRECOMPUTE_LEAD_MS - d.now();
    if (delay > 0) {
      const generation = targetGeneration;
      precomputeTimer = d.setTimer(() => { void runPrecompute(generation).catch(() => {}); }, delay);
      precomputeTimer.unref?.();
    } else if (d.now() < boundaryMs) void runPrecompute(targetGeneration).catch(() => {});
  }
  armNextPoll();
}
export function triggerEth420BoundarySettlementOrchestration(boundaryMs: number): void {
  armEth420BoundarySettlementOrchestration(boundaryMs);
  if (completedBoundaryMs === boundaryMs) return;
  if (requireDeps().now() >= boundaryMs) void runPoll(targetGeneration);
}
export function getEth420BoundarySettlementCandidateHints(): readonly Eth420SettlementCandidateHint[] {
  return hints.map((hint) => ({ ...hint }));
}
export function _configureEth420BoundarySettlementOrchestratorForTesting(overrides: Partial<Dependencies>): void {
  deps = {
    now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
    reconcile: async () => 0, hasUnresolvedExposure: async () => true,
    loadCandidateHints: async () => [], onDurablySettled: async () => {}, ...overrides,
  };
}
export function _resetEth420BoundarySettlementOrchestratorForTesting(): void {
  if (deps) { clearTimer("poll"); clearTimer("precompute"); }
  deps = null; targetBoundaryMs = null; targetGeneration = 0; completedBoundaryMs = null;
  pollInFlight = null; hints = [];
}