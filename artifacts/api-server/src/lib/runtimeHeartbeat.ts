/**
 * Durable process heartbeat for the unattended production runner.
 *
 * This module is intentionally operational only: it does not import trading
 * decisions or alter protective exits.  Entry code may query its fresh status
 * and fail closed when the runner/collector has not proved itself healthy.
 */
import { logger } from "./logger.js";
import {
  beginRuntimeRun,
  recordRuntimeHeartbeat,
  recordRuntimeLifecycleEvent,
} from "./tradeStore.js";
import { isProductionRuntime } from "./tradingKillSwitch.js";

export const RUNTIME_HEARTBEAT_INTERVAL_MS = 60_000;
export const RUNTIME_HEARTBEAT_STALE_MS = 120_000;

export type RuntimeComponentHealth = {
  runner: boolean;
  collector: boolean;
  watchdog: boolean;
  websocket: boolean;
  protectiveExit: boolean;
};

export type RuntimeHeartbeatStatus = {
  runId: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastPersistedAt: string | null;
  lastError: string | null;
  components: RuntimeComponentHealth | null;
  entryHealthy: boolean;
};

let runId: string | null = null;
let startedAt: string | null = null;
let lastHeartbeatAt: string | null = null;
let lastPersistedAt: string | null = null;
let lastError: string | null = null;
let components: RuntimeComponentHealth | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let snapshotProvider: (() => RuntimeComponentHealth) | null = null;

function calculateEntryHealthy(nowMs = Date.now()): boolean {
  if (!lastPersistedAt || !components) return false;
  const age = nowMs - Date.parse(lastPersistedAt);
  return Number.isFinite(age)
    && age <= RUNTIME_HEARTBEAT_STALE_MS
    && components.runner
    && components.collector
    && components.watchdog;
}

export function getRuntimeHeartbeatStatus(nowMs = Date.now()): RuntimeHeartbeatStatus {
  return {
    runId,
    startedAt,
    lastHeartbeatAt,
    lastPersistedAt,
    lastError,
    components: components ? { ...components } : null,
    entryHealthy: calculateEntryHealthy(nowMs),
  };
}

/** Used only by entry reservation. Protective exits must never call this gate. */
export function isRuntimeEntryHealthy(nowMs = Date.now()): boolean {
  return calculateEntryHealthy(nowMs);
}

async function writeHeartbeat(): Promise<void> {
  if (!runId || !snapshotProvider) return;
  const now = new Date();
  const next = snapshotProvider();
  lastHeartbeatAt = now.toISOString();
  components = next;
  try {
    await recordRuntimeHeartbeat({
      runId,
      occurredAtMs: now.getTime(),
      pid: process.pid,
      environment: isProductionRuntime() ? "production" : "workspace",
      components: next,
    });
    lastPersistedAt = now.toISOString();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err, runId }, "runtimeHeartbeat: durable heartbeat write failed; new entries remain blocked");
  }
}

export async function startRuntimeHeartbeat(params: {
  runId: string;
  startedAt: string;
  getComponents: () => RuntimeComponentHealth;
}): Promise<void> {
  if (heartbeatTimer) return;
  runId = params.runId;
  startedAt = params.startedAt;
  snapshotProvider = params.getComponents;
  const now = Date.now();
  await beginRuntimeRun({
    runId,
    occurredAtMs: now,
    pid: process.pid,
    environment: isProductionRuntime() ? "production" : "workspace",
  });
  await writeHeartbeat();
  heartbeatTimer = setInterval(() => { void writeHeartbeat(); }, RUNTIME_HEARTBEAT_INTERVAL_MS);
}

export async function stopRuntimeHeartbeat(reason: string): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (runId) {
    await recordRuntimeLifecycleEvent({
      runId,
      eventType: "shutdown",
      occurredAtMs: Date.now(),
      pid: process.pid,
      environment: isProductionRuntime() ? "production" : "workspace",
      reason,
    });
  }
}

export function _resetRuntimeHeartbeatForTesting(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  runId = null; startedAt = null; lastHeartbeatAt = null; lastPersistedAt = null;
  lastError = null; components = null; heartbeatTimer = null; snapshotProvider = null;
}

/** Test-only state seam for exercising the fail-closed entry predicate. */
export function _setRuntimeHeartbeatForTesting(params: {
  persistedAt: string | null;
  components: RuntimeComponentHealth | null;
}): void {
  lastPersistedAt = params.persistedAt;
  components = params.components;
}