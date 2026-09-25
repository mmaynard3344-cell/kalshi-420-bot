import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export const SHADOW_EVALUATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type ShadowEvaluationService = "A2" | "L";

export interface ShadowEvaluationEventInput {
  service: ShadowEvaluationService;
  evaluatedAtMs: number;
  ticker: string | null;
  marketOpenTimeMs: number | null;
  decision: string;
  primaryReason: string | null;
  sourceMovePct?: number | null;
  triggerThresholdPct?: number | null;
  qualified: boolean;
  wouldSubmit: boolean;
  intentId: string | null;
  evidence: unknown;
  runtimeVersion?: string | null;
}

export async function ensureShadowEvaluationLedgerSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS shadow_evaluation_events (
      id bigserial PRIMARY KEY,
      service text NOT NULL CHECK (service IN ('A2', 'L')),
      evaluated_at_ms bigint NOT NULL,
      ticker text,
      market_open_time_ms bigint,
      decision text NOT NULL,
      primary_reason text,
      source_move_pct numeric,
      trigger_threshold_pct numeric,
      qualified boolean NOT NULL DEFAULT false,
      would_submit boolean NOT NULL DEFAULT false,
      intent_id text,
      evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      runtime_version text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_evaluation_events_service_time
      ON shadow_evaluation_events (service, evaluated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_shadow_evaluation_events_service_decision_time
      ON shadow_evaluation_events (service, decision, evaluated_at_ms DESC);
  `);
}

export async function recordShadowEvaluationEvent(input: ShadowEvaluationEventInput): Promise<boolean> {
  try {
    await db.execute(sql`
      INSERT INTO shadow_evaluation_events (
        service, evaluated_at_ms, ticker, market_open_time_ms, decision,
        primary_reason, source_move_pct, trigger_threshold_pct,
        qualified, would_submit, intent_id, evidence_json, runtime_version
      ) VALUES (
        ${input.service}, ${input.evaluatedAtMs}, ${input.ticker}, ${input.marketOpenTimeMs},
        ${input.decision}, ${input.primaryReason}, ${input.sourceMovePct ?? null},
        ${input.triggerThresholdPct ?? null}, ${input.qualified}, ${input.wouldSubmit},
        ${input.intentId}, ${JSON.stringify(input.evidence ?? {})}::jsonb,
        ${input.runtimeVersion ?? process.env["COMMIT_SHA"] ?? null}
      )
    `);
    return true;
  } catch {
    return false;
  }
}

export async function pruneShadowEvaluationEvents(
  nowMs = Date.now(),
  retentionMs = SHADOW_EVALUATION_RETENTION_MS,
): Promise<boolean> {
  try {
    const cutoffMs = nowMs - retentionMs;
    await db.execute(sql`
      DELETE FROM shadow_evaluation_events
      WHERE evaluated_at_ms < ${cutoffMs}
    `);
    return true;
  } catch {
    return false;
  }
}
