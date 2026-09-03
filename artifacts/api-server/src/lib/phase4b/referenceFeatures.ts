import type { Phase4BCausalEvidenceStatus, Phase4BReferenceObservation } from "./types.js";
import { PHASE4B_SCHEMA_VERSION } from "./types.js";

export interface RawReferencePoint { timestampMs: number; price: number; }

/** A causal prior within this window still counts as fresh evidence. */
export const PHASE4B_CAUSAL_FRESH_MS = 15_000;

/**
 * Latest strictly-causal (at-or-before capture) reference pairing. The live
 * fetch participates only when its own source timestamp is causal; future
 * timestamps are never used and later values are never substituted.
 */
function causalReferenceFields(input: {
  referencePrice: number | null; sourceTimestampMs: number | null; capturedAtMs: number;
  error: string | null; history: readonly RawReferencePoint[];
}): Pick<Phase4BReferenceObservation, "causalReferencePrice" | "causalReferenceSourceTimestampMs" | "causalReferenceAgeMs" | "causalEvidenceStatus"> {
  const livePoint = input.referencePrice != null && input.referencePrice > 0
    && input.sourceTimestampMs != null && input.sourceTimestampMs <= input.capturedAtMs && input.error == null
    ? { timestampMs: input.sourceTimestampMs, price: input.referencePrice }
    : null;
  const candidates = input.history
    .filter((point) => Number.isFinite(point.price) && point.price > 0
      && Number.isFinite(point.timestampMs) && point.timestampMs <= input.capturedAtMs);
  if (livePoint) candidates.push(livePoint);
  const chosen = candidates.sort((a, b) => b.timestampMs - a.timestampMs)[0] ?? null;
  if (!chosen) {
    return { causalReferencePrice: null, causalReferenceSourceTimestampMs: null, causalReferenceAgeMs: null, causalEvidenceStatus: "unavailable" };
  }
  const ageMs = Math.max(0, input.capturedAtMs - chosen.timestampMs);
  const status: Phase4BCausalEvidenceStatus = livePoint && chosen.timestampMs === livePoint.timestampMs && chosen.price === livePoint.price
    ? "live"
    : ageMs <= PHASE4B_CAUSAL_FRESH_MS ? "fresh_prior" : "aged_prior";
  return {
    causalReferencePrice: chosen.price,
    causalReferenceSourceTimestampMs: chosen.timestampMs,
    causalReferenceAgeMs: ageMs,
    causalEvidenceStatus: status,
  };
}

function closestAtOrBefore(points: readonly RawReferencePoint[], timestampMs: number): RawReferencePoint | null {
  return [...points].filter((point) => point.timestampMs <= timestampMs).sort((a, b) => b.timestampMs - a.timestampMs)[0] ?? null;
}

function returnFrom(now: number, before: RawReferencePoint | null): number | null {
  return before && before.price > 0 ? (now - before.price) / before.price : null;
}

function volatility(points: readonly RawReferencePoint[]): number | null {
  if (points.length < 2) return null;
  const returns = points.slice(1).map((point, index) => Math.log(point.price / points[index]!.price)).filter(Number.isFinite);
  if (returns.length < 1) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length);
}

export function buildPhase4BReferenceObservation(input: {
  snapshotId: string; asset: Phase4BReferenceObservation["asset"]; source: string; referencePrice: number | null;
  sourceTimestampMs: number | null; capturedAtMs: number; error?: string | null; history: readonly RawReferencePoint[]; intervalStartMs: number | null;
  cacheAgeMs?: number | null; stale?: boolean;
}): Phase4BReferenceObservation {
  const error = input.error ?? (input.referencePrice == null ? "missing_reference_price" : null);
  const futureSource = input.sourceTimestampMs != null && input.sourceTimestampMs > input.capturedAtMs;
  const causalError = futureSource ? "future_reference_timestamp" : error;
  if (input.referencePrice == null || input.sourceTimestampMs == null || causalError) {
    const causal = causalReferenceFields({ referencePrice: input.referencePrice, sourceTimestampMs: input.sourceTimestampMs, capturedAtMs: input.capturedAtMs, error: causalError, history: input.history });
    return { snapshotId: input.snapshotId, asset: input.asset, source: input.source, referencePrice: input.referencePrice, sourceTimestampMs: input.sourceTimestampMs, capturedAtMs: input.capturedAtMs, sourceAgeMs: input.sourceTimestampMs == null ? null : Math.max(0, input.capturedAtMs - input.sourceTimestampMs), cacheAgeMs: input.cacheAgeMs ?? null, stale: input.stale ?? false, error: causalError, return5s: null, return15s: null, return30s: null, causal30sAnchorPrice: null, causal30sAnchorSourceTimestampMs: null, causal30sAnchorStatus: "reference_unavailable", ...causal, return60s: null, return5m: null, intervalToDateReturn: null, direction: null, realizedVolatility60s: null, realizedVolatility5m: null, acceleration: null, schemaVersion: PHASE4B_SCHEMA_VERSION };
  }
  const history = input.history.filter((point) => Number.isFinite(point.price) && point.price > 0 && point.timestampMs <= input.capturedAtMs);
  const r5 = returnFrom(input.referencePrice, closestAtOrBefore(history, input.capturedAtMs - 5_000));
  const r15 = returnFrom(input.referencePrice, closestAtOrBefore(history, input.capturedAtMs - 15_000));
  const anchor30 = closestAtOrBefore(history, input.capturedAtMs - 30_000);
  const anchor30Status = anchor30 == null ? "missing" as const
    : anchor30.timestampMs < input.capturedAtMs - 35_000 ? "outside_30s_5s_window" as const
      : "available" as const;
  const r30 = returnFrom(input.referencePrice, anchor30);
  const r60 = returnFrom(input.referencePrice, closestAtOrBefore(history, input.capturedAtMs - 60_000));
  const r5m = returnFrom(input.referencePrice, closestAtOrBefore(history, input.capturedAtMs - 300_000));
  const interval = input.intervalStartMs == null ? null : returnFrom(input.referencePrice, closestAtOrBefore(history, input.intervalStartMs));
  return {
    snapshotId: input.snapshotId, asset: input.asset, source: input.source, referencePrice: input.referencePrice, sourceTimestampMs: input.sourceTimestampMs, capturedAtMs: input.capturedAtMs, sourceAgeMs: Math.max(0, input.capturedAtMs - input.sourceTimestampMs), cacheAgeMs: input.cacheAgeMs ?? null, stale: input.stale ?? false, error: null,
    return5s: r5, return15s: r15, return30s: r30,
    causal30sAnchorPrice: anchor30Status === "available" ? anchor30!.price : null,
    causal30sAnchorSourceTimestampMs: anchor30Status === "available" ? anchor30!.timestampMs : null,
    causal30sAnchorStatus: anchor30Status,
    ...causalReferenceFields({ referencePrice: input.referencePrice, sourceTimestampMs: input.sourceTimestampMs, capturedAtMs: input.capturedAtMs, error: null, history }),
    return60s: r60, return5m: r5m, intervalToDateReturn: interval,
    direction: r30 == null ? null : r30 > 0 ? "up" : r30 < 0 ? "down" : "flat",
    realizedVolatility60s: volatility(history.filter((point) => point.timestampMs >= input.capturedAtMs - 60_000)),
    realizedVolatility5m: volatility(history.filter((point) => point.timestampMs >= input.capturedAtMs - 300_000)),
    acceleration: r30 != null && r60 != null ? r30 - r60 : null, schemaVersion: PHASE4B_SCHEMA_VERSION,
  };
}