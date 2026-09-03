/**
 * Pure helper to extract typed fields from a raw Kalshi order POST response.
 *
 * Kalshi's POST /portfolio/events/orders response may nest fields under an
 * "order" key or return them flat at the top level.  Within either level, the
 * API uses fixed-point string suffixes for numeric quantities:
 *
 *   fill_count_fp       — filled contract count, e.g. "3.00"
 *   remaining_count_fp  — unfilled contract count, e.g. "0.00"
 *
 * The un-suffixed integer variants (fill_count, remaining_count) may appear in
 * older API versions or schema-format responses and are kept as fallbacks.
 *
 * Order status is carried in the "status" field.  "order_status" is accepted
 * as a backward-compatible fallback for any older response shapes.
 *
 * Pure function — no I/O, no logging, safe to call from tests.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedOrderResponse {
  /** Kalshi-assigned UUID for the order, or null if absent. */
  kalshiOrderId:   string | null;
  /**
   * Exchange order status, e.g. "canceled", "resting", "filled".
   * Read from "status" (primary) then "order_status" (fallback).
   * Null if neither field is present.
   */
  orderStatus:     string | null;
  /** Number of contracts filled (0 for a zero-fill IOC). */
  fillCount:       number;
  /**
   * True only when the exchange response explicitly supplied a valid fill count.
   * Callers that transition a live/resting order to terminal must not treat the
   * parser's legacy zero fallback as authoritative exchange evidence.
   */
  fillCountProvided: boolean;
  /**
   * Number of contracts still open.  Falls back to `fallbackRemainingCount`
   * when neither remaining_count_fp nor remaining_count is present.
   */
  remainingCount:  number;
  /** Exchange-provided cancellation reason, or null. */
  cancelReason:    string | null;
  /** Exchange-provided rejection reason, or null. */
  rejectReason:    string | null;
  /**
   * Exchange-reported fee in whole cents, or null when the response does not
   * include a valid fee. Kalshi's `fee_cost` is a dollar-decimal value.
   */
  reportedFeeCents: number | null;
}

// ── Pure parser ───────────────────────────────────────────────────────────────

/**
 * Parse a raw Kalshi order POST response into typed fields.
 *
 * @param data                   Raw JSON object from kalshiAuthFetch.
 * @param fallbackRemainingCount Used when the response omits remaining_count
 *                               entirely.  Pass (requestedCount - fillCount)
 *                               as the caller-side default.
 */
export function parseKalshiOrderResponse(
  data:                    Record<string, unknown>,
  fallbackRemainingCount:  number,
): ParsedOrderResponse {
  // Kalshi may wrap all order fields under a top-level "order" key, or return
  // them flat.  Prefer the nested object; fall back to the root.
  const orderData =
    (data["order"] as Record<string, unknown> | undefined) ?? data;

  // ── Numeric quantities (fp-string primary, integer fallback) ──────────────
  const rawFillCount =
    orderData["fill_count_fp"] ?? orderData["fill_count"] ??
    data["fill_count_fp"]      ?? data["fill_count"];
  const parsedFillCount = rawFillCount == null ? NaN : Number(rawFillCount);
  const fillCountProvided = Number.isFinite(parsedFillCount) && parsedFillCount >= 0;
  // Retain the established parser fallback for acknowledgement callers. Terminal
  // cancellation code must additionally require fillCountProvided.
  const fillCount = fillCountProvided ? parsedFillCount : 0;

  const remainingCount = Number(
    orderData["remaining_count_fp"] ?? orderData["remaining_count"] ??
    data["remaining_count_fp"]      ?? data["remaining_count"]      ??
    fallbackRemainingCount,
  );

  // ── String fields ─────────────────────────────────────────────────────────
  const kalshiOrderId = (
    orderData["order_id"] ?? data["order_id"] ?? null
  ) as string | null;

  // "status" is the primary field name; "order_status" kept as backward-compat
  // fallback for any legacy response shapes.
  const orderStatus = (
    orderData["status"]       ?? orderData["order_status"] ??
    data["status"]            ?? data["order_status"]      ?? null
  ) as string | null;

  const cancelReason = (
    orderData["cancel_reason"] ?? data["cancel_reason"] ?? null
  ) as string | null;

  const rejectReason = (
    orderData["reject_reason"] ?? data["reject_reason"] ?? null
  ) as string | null;

  // `fee_cost` is a dollar-decimal amount (for example, "0.10" means ten
  // cents). Keep a reported zero distinct from a missing or malformed value:
  // zero is authoritative; null tells callers to retain their safe estimate.
  const rawFee = orderData["fee_cost"] ?? orderData["fee"] ??
    data["fee_cost"] ?? data["fee"];
  const parsedFee = typeof rawFee === "number"
    ? rawFee
    : typeof rawFee === "string" && rawFee.trim() !== ""
      ? Number(rawFee)
      : NaN;
  const reportedFeeCents = Number.isFinite(parsedFee) && parsedFee >= 0
    ? Math.round((parsedFee + Number.EPSILON) * 100)
    : null;

  return {
    kalshiOrderId,
    orderStatus,
    fillCount,
    fillCountProvided,
    remainingCount,
    cancelReason,
    rejectReason,
    reportedFeeCents,
  };
}
