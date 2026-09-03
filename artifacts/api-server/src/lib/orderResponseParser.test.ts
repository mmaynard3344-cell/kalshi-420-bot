/**
 * Unit tests for parseKalshiOrderResponse.
 *
 * Covers:
 *  - User-specified canonical response shape
 *  - Nested { order: { ... } } wrapper (Kalshi GET /portfolio/orders/{id} shape)
 *  - Flat top-level shape
 *  - fp-suffixed numeric fields (fill_count_fp, remaining_count_fp)
 *  - Integer fallback fields (fill_count, remaining_count)
 *  - status field (primary) and order_status (backward-compat fallback)
 *  - Absent optional fields default correctly
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseKalshiOrderResponse } from "./orderResponseParser.js";

// ── Canonical shape specified by the user ─────────────────────────────────────

describe("parseKalshiOrderResponse — canonical IOC zero-fill shape", () => {
  it("reads status, fill_count_fp, and remaining_count_fp from a flat response", () => {
    // This is the exact shape the user specified must be correctly parsed.
    const raw = {
      status:             "canceled",
      fill_count_fp:      "0.00",
      remaining_count_fp: "0.00",
    };
    const result = parseKalshiOrderResponse(raw, 232);
    assert.equal(result.orderStatus,    "canceled", "order_status from status field");
    assert.equal(result.fillCount,      0,          "fill_count from fill_count_fp");
    assert.equal(result.remainingCount, 0,          "remaining_count from remaining_count_fp");
  });

  it("reads a non-zero fill_count_fp correctly", () => {
    const raw = {
      status:             "filled",
      fill_count_fp:      "50.00",
      remaining_count_fp: "0.00",
    };
    const result = parseKalshiOrderResponse(raw, 50);
    assert.equal(result.orderStatus,    "filled");
    assert.equal(result.fillCount,      50);
    assert.equal(result.remainingCount, 0);
  });

  it("reads a partial fill (some filled, some remaining)", () => {
    const raw = {
      status:             "resting",
      fill_count_fp:      "30.00",
      remaining_count_fp: "70.00",
    };
    const result = parseKalshiOrderResponse(raw, 100);
    assert.equal(result.fillCount,      30);
    assert.equal(result.remainingCount, 70);
  });

  it("preserves a valid fractional partial fill without truncation", () => {
    const raw = {
      status:             "canceled",
      fill_count_fp:      "0.01",
      remaining_count_fp: "59.99",
    };
    const result = parseKalshiOrderResponse(raw, 60);
    assert.equal(result.fillCount, 0.01);
    assert.equal(result.remainingCount, 59.99);
  });
});

// ── Nested { order: { ... } } wrapper ────────────────────────────────────────

describe("parseKalshiOrderResponse — nested order wrapper", () => {
  it("reads all fields from data.order when wrapper is present", () => {
    // Shape returned by GET /portfolio/orders/{order_id}.
    const raw = {
      order: {
        order_id:           "bcea8e68-6ad7-402a-a368-dff2acf33e8b",
        status:             "canceled",
        fill_count_fp:      "0.00",
        remaining_count_fp: "0.00",
        cancel_reason:      null,
        reject_reason:      null,
      },
    };
    const result = parseKalshiOrderResponse(raw, 232);
    assert.equal(result.kalshiOrderId,  "bcea8e68-6ad7-402a-a368-dff2acf33e8b");
    assert.equal(result.orderStatus,    "canceled");
    assert.equal(result.fillCount,      0);
    assert.equal(result.remainingCount, 0);
    assert.equal(result.cancelReason,   null);
    assert.equal(result.rejectReason,   null);
  });

  it("reads status when nested wrapper is present", () => {
    const raw = {
      order: {
        status:             "canceled",
        fill_count_fp:      "0.00",
        remaining_count_fp: "0.00",
      },
    };
    const result = parseKalshiOrderResponse(raw, 10);
    assert.equal(result.orderStatus, "canceled");
  });

  it("nested wrapper with no status falls through to top-level status", () => {
    // status absent from the nested object but present at the root — unusual but
    // the parser must handle it gracefully.
    const raw = {
      order:  { fill_count_fp: "0.00", remaining_count_fp: "0.00" },
      status: "canceled",
    };
    const result = parseKalshiOrderResponse(raw, 5);
    assert.equal(result.orderStatus, "canceled");
  });

  it("completely absent status yields null", () => {
    const raw = {
      order: { fill_count_fp: "0.00", remaining_count_fp: "0.00" },
    };
    const result = parseKalshiOrderResponse(raw, 5);
    assert.equal(result.orderStatus, null);
  });
});

// ── status vs order_status backward compatibility ─────────────────────────────

describe("parseKalshiOrderResponse — status field name variants", () => {
  it("reads from status (primary)", () => {
    const raw = { status: "canceled", fill_count_fp: "0.00", remaining_count_fp: "0.00" };
    assert.equal(parseKalshiOrderResponse(raw, 0).orderStatus, "canceled");
  });

  it("falls back to order_status when status is absent", () => {
    const raw = { order_status: "resting", fill_count_fp: "5.00", remaining_count_fp: "95.00" };
    assert.equal(parseKalshiOrderResponse(raw, 100).orderStatus, "resting");
  });

  it("prefers status over order_status when both are present", () => {
    const raw = {
      status:       "canceled",
      order_status: "old_value",
      fill_count_fp: "0.00",
      remaining_count_fp: "0.00",
    };
    assert.equal(parseKalshiOrderResponse(raw, 0).orderStatus, "canceled");
  });
});

// ── fill_count: fp-string primary, integer fallback ──────────────────────────

describe("parseKalshiOrderResponse — fill_count field variants", () => {
  it("reads fill_count_fp (primary)", () => {
    const raw = { status: "filled", fill_count_fp: "10.00", remaining_count_fp: "0.00" };
    assert.equal(parseKalshiOrderResponse(raw, 0).fillCount, 10);
  });

  it("falls back to integer fill_count when fp variant absent", () => {
    const raw = { status: "filled", fill_count: 10, remaining_count: 0 };
    assert.equal(parseKalshiOrderResponse(raw, 0).fillCount, 10);
  });

  it("prefers fill_count_fp over fill_count when both present", () => {
    const raw = { status: "filled", fill_count_fp: "10.00", fill_count: 99 };
    assert.equal(parseKalshiOrderResponse(raw, 0).fillCount, 10);
  });

  it("defaults to 0 when all fill_count variants absent", () => {
    const raw = { status: "canceled", remaining_count_fp: "0.00" };
    assert.equal(parseKalshiOrderResponse(raw, 5).fillCount, 0);
  });
});

// ── remaining_count: fp-string primary, integer fallback, caller default ──────

describe("parseKalshiOrderResponse — remaining_count field variants", () => {
  it("reads remaining_count_fp (primary)", () => {
    const raw = { status: "canceled", fill_count_fp: "0.00", remaining_count_fp: "232.00" };
    assert.equal(parseKalshiOrderResponse(raw, 0).remainingCount, 232);
  });

  it("falls back to integer remaining_count", () => {
    const raw = { status: "canceled", fill_count: 0, remaining_count: 232 };
    assert.equal(parseKalshiOrderResponse(raw, 0).remainingCount, 232);
  });

  it("prefers remaining_count_fp over remaining_count", () => {
    const raw = { status: "canceled", remaining_count_fp: "232.00", remaining_count: 999 };
    assert.equal(parseKalshiOrderResponse(raw, 0).remainingCount, 232);
  });

  it("falls back to caller-supplied fallbackRemainingCount when all variants absent", () => {
    const raw = { status: "canceled", fill_count_fp: "0.00" };
    assert.equal(parseKalshiOrderResponse(raw, 232).remainingCount, 232);
  });

  it("remaining_count_fp of zero is not treated as absent — returns 0, not fallback", () => {
    const raw = { status: "canceled", fill_count_fp: "0.00", remaining_count_fp: "0.00" };
    assert.equal(parseKalshiOrderResponse(raw, 999).remainingCount, 0);
  });
});

// ── cancel_reason and reject_reason ──────────────────────────────────────────

describe("parseKalshiOrderResponse — cancel/reject reason fields", () => {
  it("reads cancel_reason when present", () => {
    const raw = {
      status:             "canceled",
      cancel_reason:      "market_not_open",
      fill_count_fp:      "0.00",
      remaining_count_fp: "0.00",
    };
    assert.equal(parseKalshiOrderResponse(raw, 0).cancelReason, "market_not_open");
  });

  it("reads reject_reason when present", () => {
    const raw = {
      status:             "canceled",
      reject_reason:      "bad_price",
      fill_count_fp:      "0.00",
      remaining_count_fp: "0.00",
    };
    assert.equal(parseKalshiOrderResponse(raw, 0).rejectReason, "bad_price");
  });

  it("cancel_reason and reject_reason are null when absent", () => {
    const raw = { status: "canceled", fill_count_fp: "0.00", remaining_count_fp: "0.00" };
    const result = parseKalshiOrderResponse(raw, 0);
    assert.equal(result.cancelReason, null);
    assert.equal(result.rejectReason, null);
  });

  it("reads cancel_reason from nested order wrapper", () => {
    const raw = {
      order: {
        status:             "canceled",
        cancel_reason:      "market_not_open",
        fill_count_fp:      "0.00",
        remaining_count_fp: "0.00",
      },
    };
    assert.equal(parseKalshiOrderResponse(raw, 0).cancelReason, "market_not_open");
  });
});

// ── order_id ──────────────────────────────────────────────────────────────────

describe("parseKalshiOrderResponse — order_id", () => {
  it("reads order_id from flat response", () => {
    const raw = {
      order_id:           "abc-123",
      status:             "canceled",
      fill_count_fp:      "0.00",
      remaining_count_fp: "0.00",
    };
    assert.equal(parseKalshiOrderResponse(raw, 0).kalshiOrderId, "abc-123");
  });

  it("reads order_id from nested order wrapper", () => {
    const raw = {
      order: {
        order_id:           "abc-123",
        status:             "canceled",
        fill_count_fp:      "0.00",
        remaining_count_fp: "0.00",
      },
    };
    assert.equal(parseKalshiOrderResponse(raw, 0).kalshiOrderId, "abc-123");
  });

  it("returns null when order_id absent", () => {
    const raw = { status: "canceled", fill_count_fp: "0.00", remaining_count_fp: "0.00" };
    assert.equal(parseKalshiOrderResponse(raw, 0).kalshiOrderId, null);
  });
});

// ── exchange-reported fee ──────────────────────────────────────────────────────
describe("parseKalshiOrderResponse — exchange-reported fee", () => {
  it("reads fee_cost as dollar-decimal cents, including an authoritative zero", () => {
    assert.equal(
      parseKalshiOrderResponse({ fee_cost: "0.07" }, 0).reportedFeeCents,
      7,
      "fee_cost is dollars, not cents",
    );
    assert.equal(
      parseKalshiOrderResponse({ order: { fee_cost: "0.00" } }, 0).reportedFeeCents,
      0,
      "a reported zero fee must not be mistaken for an unavailable fee",
    );
  });

  it("treats missing or malformed fees as unavailable", () => {
    assert.equal(parseKalshiOrderResponse({}, 0).reportedFeeCents, null);
    assert.equal(parseKalshiOrderResponse({ fee_cost: "" }, 0).reportedFeeCents, null);
    assert.equal(parseKalshiOrderResponse({ fee_cost: "unknown" }, 0).reportedFeeCents, null);
  });
});
