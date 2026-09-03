/**
 * parseFillActuals() unit tests
 *
 * Confirms that autoTrader's fill parser reads fee_cost as dollar-decimal
 * (no /100), matching the fill reconciler (fillReconciler.test.ts test 12).
 *
 * Test cases
 * ──────────
 *   1. YES fill — yes_price field used; dollarsCost computed correctly.
 *   2. NO fill  — no_price field used, not yes_price.
 *   3. fee_cost dollar-decimal anchor — "0.10" → feeDollars=0.10, NOT 0.001.
 *   4. Zero-fee fills — fee_cost="0.00" → feeDollars=0.
 *   5. Empty fills array — falls back to limit-price estimate, pricesKnown=false.
 *   6. Multiple fills summed — contracts, dollarsCost, feeDollars all accumulated.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { _parseFillActualsForTesting } from "./autoTrader.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a raw fill record as Kalshi returns it (dollar-decimal strings). */
function rawFill(
  count: string,
  yes_price: string,
  no_price: string,
  fee_cost: string,
): Record<string, unknown> {
  return { count, yes_price, no_price, fee_cost, side: "yes" };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("parseFillActuals — fee and price parsing", () => {

  // ── 1. YES fill uses yes_price ──────────────────────────────────────────────
  it("1: YES fill — yes_price used for dollarsCost, not no_price", () => {
    // 200 contracts @ $0.80 YES price → dollarsCost = 200 × 0.80 = $160
    const actuals = _parseFillActualsForTesting(
      [rawFill("200", "0.80", "0.20", "0.05")],
      "yes",
      80,   // fallback (should not be used — fills present)
      200,
    );
    assert.strictEqual(actuals.contracts, 200, "contracts");
    assert.ok(
      Math.abs(actuals.dollarsCost - 160) < 0.001,
      `dollarsCost should be $160 (200 × $0.80), got ${actuals.dollarsCost}`,
    );
    assert.strictEqual(actuals.pricesKnown, true, "pricesKnown should be true when yes_price present");
    // Confirm no_price (0.20) was NOT used — that would give $40
    assert.ok(
      actuals.dollarsCost > 100,
      `dollarsCost ${actuals.dollarsCost} looks like no_price was used instead of yes_price`,
    );
  });

  // ── 2. NO fill uses no_price, not yes_price ─────────────────────────────────
  it("2: NO fill — no_price used for dollarsCost, not yes_price", () => {
    // 100 contracts @ $0.80 NO price → dollarsCost = 100 × 0.80 = $80
    // yes_price = 0.20; if mistakenly used → $20
    const actuals = _parseFillActualsForTesting(
      [rawFill("100", "0.20", "0.80", "0.03")],
      "no",
      80,
      100,
    );
    assert.strictEqual(actuals.contracts, 100, "contracts");
    assert.ok(
      Math.abs(actuals.dollarsCost - 80) < 0.001,
      `dollarsCost should be $80 (100 × $0.80 no_price), got ${actuals.dollarsCost}`,
    );
    // Guard: yes_price (0.20) would give dollarsCost = $20
    assert.ok(
      actuals.dollarsCost > 50,
      `dollarsCost ${actuals.dollarsCost} looks like yes_price was used for a NO fill`,
    );
  });

  // ── 3. fee_cost dollar-decimal anchor ───────────────────────────────────────
  it("3: fee_cost='0.10' → feeDollars=0.10 (dollar-decimal), not 0.001 (wrong cents/100 treatment)", () => {
    // This is the cross-parser consistency check.
    // fillReconciler.test.ts test 12 asserts the same: "0.10" = $0.10.
    // parseFillActuals() must match: it sums fee_cost directly as dollars.
    const actuals = _parseFillActualsForTesting(
      [rawFill("100", "0.86", "0.14", "0.10")],
      "yes",
      86,
      100,
    );
    assert.ok(actuals !== null, "should produce a result");
    // Dollar-decimal: feeDollars must equal $0.10
    assert.ok(
      Math.abs(actuals.feeDollars - 0.10) < 0.0001,
      `feeDollars should be 0.10 (dollar-decimal), got ${actuals.feeDollars}`,
    );
    // Guard: if divided by 100, feeDollars would be 0.001 — that is wrong
    assert.ok(
      actuals.feeDollars > 0.05,
      `feeDollars ${actuals.feeDollars} looks like cents-divided-by-100 (expected ~0.10)`,
    );
  });

  // ── 4. Zero-fee fills ────────────────────────────────────────────────────────
  it("4: fee_cost='0.00' → feeDollars=0 exactly", () => {
    const actuals = _parseFillActualsForTesting(
      [
        rawFill("50",  "0.75", "0.25", "0.00"),
        rawFill("50",  "0.76", "0.24", "0.00"),
      ],
      "yes",
      75,
      100,
    );
    assert.strictEqual(actuals.contracts, 100, "contracts");
    assert.strictEqual(actuals.feeDollars, 0, "feeDollars should be 0 for zero-fee fills");
    assert.strictEqual(actuals.pricesKnown, true, "pricesKnown");
  });

  // ── 5. Empty fills — fallback to limit-price estimate ───────────────────────
  it("5: empty fills array → fallback estimate, pricesKnown=false", () => {
    // No fills returned (IOC zero-fill); should use limit price as conservative fallback
    const actuals = _parseFillActualsForTesting(
      [],
      "yes",
      82,   // fallbackOutcomePriceCents
      143,  // fallbackFillCount
    );
    assert.strictEqual(actuals.contracts, 143, "contracts = fallbackFillCount");
    assert.ok(
      Math.abs(actuals.dollarsCost - (143 * 82) / 100) < 0.001,
      `dollarsCost should be fallback = ${(143 * 82) / 100}, got ${actuals.dollarsCost}`,
    );
    assert.strictEqual(actuals.feeDollars, 0, "feeDollars = 0 for empty fills");
    assert.strictEqual(actuals.pricesKnown, false, "pricesKnown must be false for fallback");
  });

  // ── 6. Multiple fills — contracts, cost, fees all accumulated ───────────────
  it("6: multiple fills → all fields correctly accumulated", () => {
    // 3 fills: 400 @ $0.84, 200 @ $0.85, 100 @ $0.86
    // contracts  = 700
    // dollarsCost= 400×0.84 + 200×0.85 + 100×0.86 = 336 + 170 + 86 = 592
    // feeDollars = 0.10 + 0.05 + 0.02 = 0.17
    const actuals = _parseFillActualsForTesting(
      [
        rawFill("400", "0.84", "0.16", "0.10"),
        rawFill("200", "0.85", "0.15", "0.05"),
        rawFill("100", "0.86", "0.14", "0.02"),
      ],
      "yes",
      84,
      700,
    );
    assert.strictEqual(actuals.contracts, 700, "total contracts");
    assert.ok(
      Math.abs(actuals.dollarsCost - 592) < 0.001,
      `dollarsCost should be $592, got ${actuals.dollarsCost}`,
    );
    assert.ok(
      Math.abs(actuals.feeDollars - 0.17) < 0.0001,
      `feeDollars should be $0.17, got ${actuals.feeDollars}`,
    );
    assert.strictEqual(actuals.pricesKnown, true, "pricesKnown");
  });

});
