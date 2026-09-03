/**
 * Safe parser for OrderAttemptRecord NDJSON lines.
 *
 * Observed fillPriceCents shapes in production data (first seen 2026-07-29):
 *   A: { value: 76,   source: "estimated" }                 — filled order (estimated)
 *   B: { value: null, source: "estimated" }                 — zero-fill (value never set)
 *   C: { value: 76,   source: "confirmed_from_fills_api" }  — after fill reconciliation
 *   D: { value: 76,   source: "confirmed_from_response" }   — confirmed from order response
 *
 * Theoretically possible but not yet observed (guarded below):
 *   E: 76                    — bare number (hypothetical legacy serialization)
 *   F: null / undefined      — missing field entirely
 *   G: {}                    — empty object (corrupt write)
 *   H: { value: "76", ... }  — string value (serialization drift)
 *
 * All normalization functions return a valid TrackedValue and never throw.
 * parseOrderRecord() returns null on validation failure and populates a
 * ParseFailure describing exactly what was wrong, so callers can log and skip.
 */

import type {
  OrderAttemptRecord,
  TrackedValue,
  FillValueSource,
} from "./analytics.js";

// ── Source validation ─────────────────────────────────────────────────────────

const VALID_SOURCES = new Set<FillValueSource>([
  "estimated",
  "confirmed_from_response",
  "confirmed_from_fills_api",
]);

function coerceSource(raw: unknown): FillValueSource {
  return VALID_SOURCES.has(raw as FillValueSource)
    ? (raw as FillValueSource)
    : "estimated";
}

// ── TrackedValue normalization ────────────────────────────────────────────────

/**
 * Normalize any raw JSON value into TrackedValue<number | null>.
 * Used for fillPriceCents which may legitimately be null for zero-fills.
 *
 * Handles shapes A–H described in the module docstring.
 */
export function normalizeFillPriceCents(
  raw: unknown,
): TrackedValue<number | null> {
  // Shapes A / B / C / D: { value: number|null, source: string }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj    = raw as Record<string, unknown>;
    const source = coerceSource(obj["source"]);
    const v      = obj["value"];

    if (v === null || v === undefined) return { value: null, source };

    if (typeof v === "number") {
      // Explicit range check: 0 is a valid fill price; negative and >100 are malformed.
      // NaN and Infinity are always malformed.
      // NOTE: do NOT use `v || fallback` — that would incorrectly treat 0 as missing.
      if (!Number.isFinite(v) || v < 0 || v > 100) return { value: null, source };
      return { value: v, source };
    }

    // Shape H: string numeric
    if (typeof v === "string") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) return { value: null, source };
      return { value: n, source };
    }

    // value present but unreadable (bool, array, etc.)
    return { value: null, source };
  }

  // Shape E: bare number — same range rules as object form
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) return { value: null, source: "estimated" };
    return { value: raw, source: "estimated" };
  }

  // Shapes F / G / unknown
  return { value: null, source: "estimated" };
}

/**
 * Normalize any raw JSON value into TrackedValue<number> with an explicit fallback.
 * Used for contracts, notionalDollars, feeDollars which must be numeric.
 */
export function normalizeTrackedNumber(
  raw: unknown,
  fallback: number,
): TrackedValue<number> {
  // Object shapes A / C / D
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj    = raw as Record<string, unknown>;
    const source = coerceSource(obj["source"]);
    const v      = obj["value"];

    if (typeof v === "number" && Number.isFinite(v)) return { value: v, source };

    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return { value: n, source };
    }

    return { value: fallback, source };
  }

  // Shape E: bare number
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { value: raw, source: "estimated" };
  }

  return { value: fallback, source: "estimated" };
}

// ── Field validators ──────────────────────────────────────────────────────────

function isValidSide(s: unknown): s is "yes" | "no" {
  return s === "yes" || s === "no";
}

function isValidDataSource(s: unknown): s is "websocket" | "rest_fallback" {
  return s === "websocket" || s === "rest_fallback";
}

const VALID_OUTCOMES = new Set([
  "full_fill", "partial_fill", "zero_fill",
  "rejected", "ambiguous", "error",
]);

function isValidOutcome(s: unknown): s is OrderAttemptRecord["outcome"] {
  return typeof s === "string" && VALID_OUTCOMES.has(s);
}

// ── Public failure type ───────────────────────────────────────────────────────

export interface ParseFailure {
  reason:     "json_parse_error" | "not_an_object" | "missing_required_field" | "invalid_field";
  field?:     string;
  rawValue?:  unknown;
  lineSnippet?: string; // first 120 chars of the raw line
}

// ── Record parser ─────────────────────────────────────────────────────────────

/**
 * Parse and validate one NDJSON line into an OrderAttemptRecord.
 *
 * Returns { record, failure: null } on success.
 * Returns { record: null, failure } on any validation error.
 * Never throws.
 */
export function parseOrderRecord(
  line: string,
): { record: OrderAttemptRecord; failure: null }
  | { record: null; failure: ParseFailure } {

  // ── Step 1: JSON parse ────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      record: null,
      failure: { reason: "json_parse_error", lineSnippet: line.slice(0, 120) },
    };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { record: null, failure: { reason: "not_an_object" } };
  }

  const r = raw as Record<string, unknown>;

  // ── Step 2: required primitive fields ─────────────────────────────────────
  if (typeof r["id"] !== "string" || !r["id"]) {
    return { record: null, failure: { reason: "missing_required_field", field: "id" } };
  }
  if (typeof r["ticker"] !== "string" || !r["ticker"]) {
    return { record: null, failure: { reason: "missing_required_field", field: "ticker" } };
  }
  if (!isValidSide(r["side"])) {
    return { record: null, failure: { reason: "invalid_field", field: "side", rawValue: r["side"] } };
  }
  if (typeof r["timestampMs"] !== "number") {
    return { record: null, failure: { reason: "missing_required_field", field: "timestampMs" } };
  }

  // ── Step 3: normalize TrackedValue fields ──────────────────────────────────
  const fillPriceCents  = normalizeFillPriceCents(r["fillPriceCents"]);
  const contracts       = normalizeTrackedNumber(r["contracts"],       0);
  const notionalDollars = normalizeTrackedNumber(r["notionalDollars"], 0);
  const feeDollars      = normalizeTrackedNumber(r["feeDollars"],      0);

  // ── Step 4: assemble record ────────────────────────────────────────────────
  const record: OrderAttemptRecord = {
    id:                     r["id"] as string,
    timestampMs:            r["timestampMs"] as number,
    ticker:                 r["ticker"] as string,
    series:                 typeof r["series"] === "string" ? r["series"] : "",
    windowCloseTime:        typeof r["windowCloseTime"] === "string" ? r["windowCloseTime"] : null,
    side:                   r["side"] as "yes" | "no",
    attemptNumber:          typeof r["attemptNumber"] === "number" ? r["attemptNumber"] : 1,
    source:                 isValidDataSource(r["source"]) ? r["source"] : "rest_fallback",
    triggerPriceCents:      typeof r["triggerPriceCents"] === "number" ? r["triggerPriceCents"] : 0,
    limitPriceCents:        typeof r["limitPriceCents"] === "number" ? r["limitPriceCents"] : 0,
    requestedContracts:     typeof r["requestedContracts"] === "number" ? r["requestedContracts"] : 0,
    requestedNotionalCents: typeof r["requestedNotionalCents"] === "number" ? r["requestedNotionalCents"] : 0,
    clientOrderId:          typeof r["clientOrderId"] === "string" ? r["clientOrderId"] : "",
    orderId:                typeof r["orderId"] === "string" ? r["orderId"] : null,
    fillCount:              typeof r["fillCount"] === "number" ? r["fillCount"] : 0,
    remainingCount:         typeof r["remainingCount"] === "number" ? r["remainingCount"] : 0,
    contracts,
    fillPriceCents,
    notionalDollars,
    feeDollars,
    outcome:                isValidOutcome(r["outcome"]) ? r["outcome"] : "zero_fill",
    roundTripMs:            typeof r["roundTripMs"] === "number" ? r["roundTripMs"] : null,
    reconciled:             r["reconciled"] === true,
    // optional structured fields — accepted as-is if present (no deep validation needed)
    ...(r["zeroFillDiagnostic"] != null && typeof r["zeroFillDiagnostic"] === "object"
      ? { zeroFillDiagnostic: r["zeroFillDiagnostic"] as OrderAttemptRecord["zeroFillDiagnostic"] }
      : {}),
    ...(r["discrepancies"] != null && typeof r["discrepancies"] === "object"
      ? { discrepancies: r["discrepancies"] as OrderAttemptRecord["discrepancies"] }
      : {}),
    // outcome-reconciliation fields (optional, written after market settles)
    ...(r["marketResult"] !== undefined
      ? { marketResult: (r["marketResult"] === "yes" || r["marketResult"] === "no") ? r["marketResult"] : null }
      : {}),
    ...(r["win"] !== undefined
      ? { win: typeof r["win"] === "boolean" ? r["win"] : null }
      : {}),
    ...(r["grossPnlDollars"] !== undefined
      ? { grossPnlDollars: typeof r["grossPnlDollars"] === "number" ? r["grossPnlDollars"] : null }
      : {}),
    ...(r["netPnlDollars"] !== undefined
      ? { netPnlDollars: typeof r["netPnlDollars"] === "number" ? r["netPnlDollars"] : null }
      : {}),
    ...(r["roi"] !== undefined
      ? { roi: typeof r["roi"] === "number" ? r["roi"] : null }
      : {}),
    ...(r["outcomeReconciledAt"] !== undefined
      ? { outcomeReconciledAt: typeof r["outcomeReconciledAt"] === "number" ? r["outcomeReconciledAt"] : null }
      : {}),
    ...(r["windowClosedAtMs"] !== undefined
      ? { windowClosedAtMs: typeof r["windowClosedAtMs"] === "number" ? r["windowClosedAtMs"] : null }
      : {}),
    ...(r["holdMs"] !== undefined
      ? { holdMs: typeof r["holdMs"] === "number" ? r["holdMs"] : null }
      : {}),
  };

  return { record, failure: null };
}
