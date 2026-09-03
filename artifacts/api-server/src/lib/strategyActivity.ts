import type { EvaluationEvent } from "./evaluationEventStore.js";
import type { Eth30DecisionEventParams, Sol30DecisionEventParams } from "./tradeStore.js";

type StrategyActivityEvent = {
  atMs: number;
  outcome: string;
  blockedReason: string | null;
};

export interface StrategyActivitySummary {
  state: "active" | "quiet" | "unavailable";
  last_activity_at: string | null;
  activity_count: number;
  blocked_reasons: Record<string, number>;
  storage: "healthy" | "degraded";
}

const ACTIVE_WITHIN_MS = 5 * 60_000;

function summarize(events: StrategyActivityEvent[], nowMs: number, storageHealthy: boolean): StrategyActivitySummary {
  if (!storageHealthy) {
    return { state: "unavailable", last_activity_at: null, activity_count: 0, blocked_reasons: {}, storage: "degraded" };
  }
  const latest = events.reduce<number | null>((value, event) => value == null || event.atMs > value ? event.atMs : value, null);
  const blockedReasons: Record<string, number> = {};
  for (const event of events) {
    if (event.blockedReason) blockedReasons[event.blockedReason] = (blockedReasons[event.blockedReason] ?? 0) + 1;
  }
  return {
    state: latest !== null && nowMs - latest <= ACTIVE_WITHIN_MS ? "active" : "quiet",
    last_activity_at: latest == null ? null : new Date(latest).toISOString(),
    activity_count: events.length,
    blocked_reasons: blockedReasons,
    storage: "healthy",
  };
}

/** Uses only the legacy per-tick ledger; it never infers ETH_30_50 ownership. */
export function summarizeLegacyStrategyActivity(events: readonly EvaluationEvent[], nowMs: number, storageHealthy: boolean): StrategyActivitySummary {
  return summarize(events.map((event) => ({
    atMs: event.timestampMs,
    outcome: event.outcome,
    blockedReason: event.outcome === "place_order_rejected" || event.outcome === "preflight_skip"
      ? event.preflightDecision
      : null,
  })), nowMs, storageHealthy);
}

/** Uses only ETH_30_50's isolated decision ledger. */
export function summarizeEth30StrategyActivity(events: readonly Eth30DecisionEventParams[], nowMs: number, storageHealthy: boolean): StrategyActivitySummary {
  return summarize(events.map((event) => ({
    atMs: event.occurredAtMs,
    outcome: event.decision,
    blockedReason: event.decision === "gate_blocked" || event.decision === "claim_conflict"
      ? event.note ?? event.decision
      : null,
  })), nowMs, storageHealthy);
}

/** Uses only SOL_30_50's isolated decision ledger. */
export function summarizeSol30StrategyActivity(events: readonly Sol30DecisionEventParams[], nowMs: number, storageHealthy: boolean): StrategyActivitySummary {
  return summarize(events.map((event) => ({
    atMs: event.occurredAtMs,
    outcome: event.decision,
    blockedReason: event.decision === "gate_blocked" || event.decision === "claim_conflict"
      ? event.note ?? event.decision
      : null,
  })), nowMs, storageHealthy);
}