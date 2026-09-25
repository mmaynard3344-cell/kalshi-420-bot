import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

export type ShadowEvaluationService = "A2" | "L";
export type ShadowEvaluationDecision = "no_signal" | "qualified" | "error";

export interface ShadowEvaluationEventInput {
  service: ShadowEvaluationService;
  evaluatedAtMs: number;
  ticker: string | null;
  marketOpenTimeMs: number | null;
  decision: ShadowEvaluationDecision;
  primaryReason: string | null;
  wouldSubmit: boolean;
  evidence: unknown;
  evaluationIntervalMs: number;
  runtimeVersion?: string | null;
}

type ShadowEvaluationWrite = (input: ShadowEvaluationEventInput & { evidence: Record<string, unknown> }) => Promise<void>;

const MAX_EVIDENCE_KEYS = 32;
const MAX_EVIDENCE_STRING_LENGTH = 256;
const DEFAULT_RETENTION_DAYS = 30;

function boundedScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, MAX_EVIDENCE_STRING_LENGTH);
  return undefined;
}

export function boundShadowEvaluationEvidence(
  evidence: unknown,
): Record<string, unknown> {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(evidence as Record<string, unknown>).slice(0, MAX_EVIDENCE_KEYS)) {
    const value = boundedScalar(raw);
    if (value !== undefined) out[key.slice(0, 96)] = value;
  }
  return out;
}

let shadowEvaluationSchemaCompatible = false;

async function ensureShadowEvaluationSchemaCompatibility(): Promise<void> {
  if (shadowEvaluationSchemaCompatible) return;
  await db.execute(sql`
    ALTER TABLE shadow_evaluation_events
      ADD COLUMN IF NOT EXISTS evaluation_interval_ms BIGINT
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_shadow_evaluation_events_service_time
      ON shadow_evaluation_events (service, evaluated_at_ms DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_shadow_evaluation_events_service_decision_time
      ON shadow_evaluation_events (service, decision, evaluated_at_ms DESC)
  `);
  shadowEvaluationSchemaCompatible = true;
}

async function defaultWrite(input: ShadowEvaluationEventInput & { evidence: Record<string, unknown> }): Promise<void> {
  await ensureShadowEvaluationSchemaCompatibility();
  await db.execute(sql`
    INSERT INTO shadow_evaluation_events
      (service, evaluated_at_ms, ticker, market_open_time_ms, decision, primary_reason,
       would_submit, evidence_json, evaluation_interval_ms, runtime_version)
    VALUES
      (${input.service}, ${input.evaluatedAtMs}, ${input.ticker}, ${input.marketOpenTimeMs},
       ${input.decision}, ${input.primaryReason}, ${input.wouldSubmit},
       ${JSON.stringify(input.evidence)}::jsonb, ${input.evaluationIntervalMs},
       ${input.runtimeVersion ?? process.env["RAILWAY_GIT_COMMIT_SHA"] ?? null})
  `);
}

export async function recordShadowEvaluation(
  input: ShadowEvaluationEventInput,
  write: ShadowEvaluationWrite = defaultWrite,
): Promise<boolean> {
  const normalized: ShadowEvaluationEventInput & { evidence: Record<string, unknown> } = {
    ...input,
    wouldSubmit: input.decision === "qualified" ? input.wouldSubmit : false,
    evidence: boundShadowEvaluationEvidence(input.evidence),
  };
  try {
    await write(normalized);
    return true;
  } catch (err) {
    logger.warn(
      { err, service: input.service, decision: input.decision, ticker: input.ticker },
      "Failed to persist shadow evaluator telemetry",
    );
    return false;
  }
}

export function shadowEvaluationRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env["SHADOW_EVALUATION_RETENTION_DAYS"]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

export function shadowEvaluationRetentionCutoffMs(
  nowMs: number,
  retentionDays = shadowEvaluationRetentionDays(),
): number {
  if (!Number.isSafeInteger(nowMs) || !Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error("invalid shadow evaluation retention inputs");
  }
  return nowMs - retentionDays * 86_400_000;
}

export async function pruneShadowEvaluationEvents(
  retentionDays = shadowEvaluationRetentionDays(),
  nowMs = Date.now(),
): Promise<number> {
  const cutoffMs = shadowEvaluationRetentionCutoffMs(nowMs, retentionDays);
  const result = await db.execute(sql`
    DELETE FROM shadow_evaluation_events
    WHERE evaluated_at_ms < ${cutoffMs}
    RETURNING id
  `);
  const rows = (result as { rows?: unknown[] })?.rows ?? [];
  logger.info({ retentionDays, prunedCount: rows.length }, "Pruned shadow evaluator telemetry");
  return rows.length;
}
