/**
 * recordParser unit tests.
 *
 * Covers every observed and theoretically possible fillPriceCents shape,
 * normalizeTrackedNumber, and the full parseOrderRecord validation pipeline.
 *
 * Shapes tested for fillPriceCents:
 *   A  { value: number, source: "estimated" }              — normal estimated fill
 *   B  { value: null,   source: "estimated" }              — zero-fill
 *   C  { value: number, source: "confirmed_from_fills_api"} — confirmed after reconciliation
 *   D  { value: number, source: "confirmed_from_response" } — confirmed from order response
 *   E  76  (bare number)                                   — hypothetical legacy
 *   F  null                                                — missing field
 *   G  {}  (empty object)                                  — corrupt write
 *   H  { value: "76", source: "estimated" }               — string value
 *
 * Run: node --test artifacts/api-server/src/lib/recordParser.test.ts
 */

import assert from "node:assert/strict";
import { it } from "node:test";
import {
  normalizeFillPriceCents,
  normalizeTrackedNumber,
  parseOrderRecord,
} from "./recordParser.js";

// ── normalizeFillPriceCents ───────────────────────────────────────────────────

it("Shape A: {value: number, source: 'estimated'} — normal estimated fill", () => {
  const r = normalizeFillPriceCents({ value: 76, source: "estimated" });
  assert.equal(r.value, 76);
  assert.equal(r.source, "estimated");
});

it("Shape B: {value: null, source: 'estimated'} — zero-fill (never filled)", () => {
  const r = normalizeFillPriceCents({ value: null, source: "estimated" });
  assert.equal(r.value, null);
  assert.equal(r.source, "estimated");
});

it("Shape C: {value: number, source: 'confirmed_from_fills_api'} — confirmed fill", () => {
  const r = normalizeFillPriceCents({ value: 82, source: "confirmed_from_fills_api" });
  assert.equal(r.value, 82);
  assert.equal(r.source, "confirmed_from_fills_api");
});

it("Shape D: {value: number, source: 'confirmed_from_response'} — confirmed from response", () => {
  const r = normalizeFillPriceCents({ value: 83, source: "confirmed_from_response" });
  assert.equal(r.value, 83);
  assert.equal(r.source, "confirmed_from_response");
});

it("Shape E: bare number — legacy serialization", () => {
  const r = normalizeFillPriceCents(76);
  assert.equal(r.value, 76);
  assert.equal(r.source, "estimated");
});

it("Shape F: null — missing field entirely", () => {
  const r = normalizeFillPriceCents(null);
  assert.equal(r.value, null);
  assert.equal(r.source, "estimated");
});

it("Shape F: undefined — missing field entirely", () => {
  const r = normalizeFillPriceCents(undefined);
  assert.equal(r.value, null);
  assert.equal(r.source, "estimated");
});

it("Shape G: empty object {} — corrupt write", () => {
  const r = normalizeFillPriceCents({});
  assert.equal(r.value, null);
  assert.equal(r.source, "estimated");
});

it("Shape H: string numeric value coerces to number", () => {
  const r = normalizeFillPriceCents({ value: "83", source: "estimated" });
  assert.equal(r.value, 83);
  assert.equal(r.source, "estimated");
});

it("NaN in value treated as null", () => {
  const r = normalizeFillPriceCents({ value: NaN, source: "estimated" });
  assert.equal(r.value, null);
});

it("value: 83 — normal positive fill price in mid-band", () => {
  const r = normalizeFillPriceCents({ value: 83, source: "estimated" });
  assert.equal(r.value, 83);
  assert.equal(r.source, "estimated");
});

it("value: 0 — zero is a valid fill price (must NOT fall back)", () => {
  // This is the key truthiness trap: `value || fallback` would incorrectly skip 0.
  // The parser must return 0, not null or a fallback.
  const r = normalizeFillPriceCents({ value: 0, source: "estimated" });
  assert.equal(r.value, 0);
  assert.equal(r.source, "estimated");
});

it("value: -5 — negative fill price is malformed → null", () => {
  const r = normalizeFillPriceCents({ value: -5, source: "estimated" });
  assert.equal(r.value, null);
});

it("value: 101 — above 100 is malformed for Kalshi prices → null", () => {
  const r = normalizeFillPriceCents({ value: 101, source: "estimated" });
  assert.equal(r.value, null);
});

it("value: 100 — exactly 100 is on the boundary and valid", () => {
  const r = normalizeFillPriceCents({ value: 100, source: "estimated" });
  assert.equal(r.value, 100);
});

it("Shape E (bare 0) — bare numeric 0 is valid", () => {
  const r = normalizeFillPriceCents(0);
  assert.equal(r.value, 0);
  assert.equal(r.source, "estimated");
});

it("Shape E (bare -5) — bare negative is invalid → null", () => {
  const r = normalizeFillPriceCents(-5);
  assert.equal(r.value, null);
});

it("Shape E (bare 105) — bare above-100 is invalid → null", () => {
  const r = normalizeFillPriceCents(105);
  assert.equal(r.value, null);
});

it("unrecognised source falls back to 'estimated'", () => {
  const r = normalizeFillPriceCents({ value: 80, source: "future_unknown_source" });
  assert.equal(r.value, 80);
  assert.equal(r.source, "estimated");
});

it("array as raw value — treated as missing", () => {
  const r = normalizeFillPriceCents([76, "estimated"]);
  assert.equal(r.value, null);
  assert.equal(r.source, "estimated");
});

// ── normalizeTrackedNumber ────────────────────────────────────────────────────

it("normalizeTrackedNumber: {value: 131, source: 'estimated'} — normal", () => {
  const r = normalizeTrackedNumber({ value: 131, source: "estimated" }, 0);
  assert.equal(r.value, 131);
  assert.equal(r.source, "estimated");
});

it("normalizeTrackedNumber: bare number — legacy", () => {
  const r = normalizeTrackedNumber(131, 0);
  assert.equal(r.value, 131);
  assert.equal(r.source, "estimated");
});

it("normalizeTrackedNumber: null — uses fallback", () => {
  const r = normalizeTrackedNumber(null, 99);
  assert.equal(r.value, 99);
  assert.equal(r.source, "estimated");
});

it("normalizeTrackedNumber: string numeric value coerces", () => {
  const r = normalizeTrackedNumber({ value: "99.56", source: "estimated" }, 0);
  assert.equal(r.value, 99.56);
});

// ── parseOrderRecord ──────────────────────────────────────────────────────────

/** Minimal valid full_fill line */
const VALID_BASE = {
  id: "abc-1",
  timestampMs: 1785324482411,
  ticker: "KXBTC15M-26JUL290730-30",
  series: "KXBTC15M",
  windowCloseTime: "2026-07-29T11:30:00Z",
  side: "yes",
  attemptNumber: 1,
  source: "rest_fallback",
  triggerPriceCents: 75,
  limitPriceCents: 76,
  requestedContracts: 131,
  requestedNotionalCents: 9956,
  clientOrderId: "abc",
  orderId: "ord-123",
  fillCount: 131,
  remainingCount: 0,
  contracts: { value: 131, source: "estimated" },
  fillPriceCents: { value: 76, source: "estimated" },
  notionalDollars: { value: 99.56, source: "estimated" },
  feeDollars: { value: 0, source: "estimated" },
  outcome: "full_fill",
  roundTripMs: 179,
  reconciled: false,
};

const validLine = () => JSON.stringify(VALID_BASE);

it("parseOrderRecord: valid full_fill record parses correctly", () => {
  const { record, failure } = parseOrderRecord(validLine());
  assert.equal(failure, null);
  assert.ok(record);
  assert.equal(record.id, "abc-1");
  assert.equal(record.fillPriceCents.value, 76);
  assert.equal(record.fillPriceCents.source, "estimated");
  assert.equal(record.outcome, "full_fill");
  assert.equal(record.side, "yes");
  assert.equal(record.reconciled, false);
});

it("parseOrderRecord: Shape B fillPriceCents (null value) parses without error", () => {
  const line = JSON.stringify({ ...VALID_BASE, fillPriceCents: { value: null, source: "estimated" }, outcome: "zero_fill" });
  const { record, failure } = parseOrderRecord(line);
  assert.equal(failure, null);
  assert.ok(record);
  assert.equal(record.fillPriceCents.value, null);
  assert.equal(record.outcome, "zero_fill");
});

it("parseOrderRecord: bare number fillPriceCents (Shape E) normalizes to TrackedValue", () => {
  const line = JSON.stringify({ ...VALID_BASE, fillPriceCents: 76 });
  const { record, failure } = parseOrderRecord(line);
  assert.equal(failure, null);
  assert.ok(record);
  assert.equal(record.fillPriceCents.value, 76);
  assert.equal(record.fillPriceCents.source, "estimated");
});

it("parseOrderRecord: null fillPriceCents (Shape F) normalizes gracefully", () => {
  const line = JSON.stringify({ ...VALID_BASE, fillPriceCents: null, outcome: "zero_fill" });
  const { record, failure } = parseOrderRecord(line);
  assert.equal(failure, null);
  assert.ok(record);
  assert.equal(record.fillPriceCents.value, null);
});

it("parseOrderRecord: invalid JSON returns json_parse_error", () => {
  const { record, failure } = parseOrderRecord("{ not valid json }");
  assert.equal(record, null);
  assert.ok(failure);
  assert.equal(failure.reason, "json_parse_error");
  assert.ok(failure.lineSnippet);
});

it("parseOrderRecord: missing id returns missing_required_field", () => {
  const { id: _id, ...withoutId } = VALID_BASE;
  const { record, failure } = parseOrderRecord(JSON.stringify(withoutId));
  assert.equal(record, null);
  assert.ok(failure);
  assert.equal(failure.reason, "missing_required_field");
  assert.equal(failure.field, "id");
});

it("parseOrderRecord: missing ticker returns missing_required_field", () => {
  const { ticker: _t, ...withoutTicker } = VALID_BASE;
  const { record, failure } = parseOrderRecord(JSON.stringify(withoutTicker));
  assert.equal(record, null);
  assert.ok(failure);
  assert.equal(failure.field, "ticker");
});

it("parseOrderRecord: invalid side returns invalid_field", () => {
  const line = JSON.stringify({ ...VALID_BASE, side: "maybe" });
  const { record, failure } = parseOrderRecord(line);
  assert.equal(record, null);
  assert.ok(failure);
  assert.equal(failure.reason, "invalid_field");
  assert.equal(failure.field, "side");
  assert.equal(failure.rawValue, "maybe");
});

it("parseOrderRecord: missing timestampMs returns missing_required_field", () => {
  const { timestampMs: _ts, ...withoutTs } = VALID_BASE;
  const { record, failure } = parseOrderRecord(JSON.stringify(withoutTs));
  assert.equal(record, null);
  assert.ok(failure);
  assert.equal(failure.field, "timestampMs");
});

it("parseOrderRecord: outcome reconciliation fields preserved when present", () => {
  const line = JSON.stringify({
    ...VALID_BASE,
    marketResult: "no",
    win: false,
    grossPnlDollars: -99.56,
    netPnlDollars: -99.56,
    roi: -1.0,
    outcomeReconciledAt: 1785324999000,
    windowClosedAtMs: 1785324600000,
    holdMs: 117589,
  });
  const { record, failure } = parseOrderRecord(line);
  assert.equal(failure, null);
  assert.ok(record);
  assert.equal(record.marketResult, "no");
  assert.equal(record.win, false);
  assert.equal(record.grossPnlDollars, -99.56);
  assert.equal(record.netPnlDollars, -99.56);
  assert.equal(record.roi, -1.0);
  assert.equal(record.outcomeReconciledAt, 1785324999000);
  assert.equal(record.windowClosedAtMs, 1785324600000);
  assert.equal(record.holdMs, 117589);
});

it("parseOrderRecord: confirmed_from_fills_api source preserved (Shape C)", () => {
  const line = JSON.stringify({
    ...VALID_BASE,
    fillPriceCents: { value: 75, source: "confirmed_from_fills_api" },
    reconciled: true,
  });
  const { record, failure } = parseOrderRecord(line);
  assert.equal(failure, null);
  assert.ok(record);
  assert.equal(record.fillPriceCents.source, "confirmed_from_fills_api");
  assert.equal(record.fillPriceCents.value, 75);
  assert.equal(record.reconciled, true);
});

it("parseOrderRecord: non-object root returns not_an_object", () => {
  const { record, failure } = parseOrderRecord('"just a string"');
  assert.equal(record, null);
  assert.ok(failure);
  assert.equal(failure.reason, "not_an_object");
});

it("parseOrderRecord: array root returns not_an_object", () => {
  const { record, failure } = parseOrderRecord("[1,2,3]");
  assert.equal(record, null);
  assert.ok(failure);
  assert.equal(failure.reason, "not_an_object");
});
