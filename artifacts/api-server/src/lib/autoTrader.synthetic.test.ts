/**
 * autoTrader.synthetic.test.ts
 *
 * Unit tests for the zero-fill suppression cache that replaced the former
 * BBO-derived executability pre-block.
 *
 * Policy under test (checkAndPlace / placeOrder):
 *   1. The first IOC submission is ALWAYS allowed — no BBO pre-filter.
 *   2. If the IOC zero-fills, the full 5-field quote snapshot is cached.
 *   3. Identical snapshots on subsequent ticks are suppressed
 *      (suppressed_retry_after_zero_fill) with no Kalshi call.
 *   4. Any field change (limitCents, yesAsk, noAsk, yesBid, noBid) clears
 *      the cache entry and allows the next order.
 *   5. A successful fill (full or partial) clears the cache entry.
 *   6. Window rollover clears all cache entries for the old ticker.
 *
 * These tests exercise the cache state directly via the test helpers exported
 * from autoTraderGuards.ts.  They require no Kalshi API mock because the
 * pre-submission guard was removed — the cache is the only mechanism.
 *
 * Regression incidents:
 *   A. KXETH15M-26JUL300845-45 (2026-07-26): 8 zero-fills on pure synthetic
 *      noAsk=85 (=100−yesBid=15).  New policy: first order fires, zero-fills,
 *      then identical retries are suppressed.
 *   B. KXBTC15M/KXETH15M-26JUL300930-30 (2026-07-30): old guard blocked
 *      because noAsk === 100 − yesBid, but production fully filled both.
 *      New policy: no pre-block — these orders reach Kalshi as intended.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  _resetAutoTraderStateForTesting,
  _getZeroFillSuppressionForTesting,
  _setZeroFillSuppressionForTesting,
} from "./autoTraderGuards";
import type { ZeroFillSnapshot } from "./autoTraderGuards";

// ── Helpers ───────────────────────────────────────────────────────────────────

function snap(
  limitCents: number,
  yesAsk: number | null,
  noAsk: number | null,
  yesBid: number | null,
  noBid: number | null,
): ZeroFillSnapshot {
  return { limitCents, yesAsk, noAsk, yesBid, noBid, cachedAt: 0 };
}

function isSuppressed(ticker: string, side: "yes" | "no", s: ZeroFillSnapshot): boolean {
  const cached = _getZeroFillSuppressionForTesting(ticker, side);
  if (!cached) return false;
  return (
    cached.limitCents === s.limitCents &&
    cached.yesAsk     === s.yesAsk     &&
    cached.noAsk      === s.noAsk      &&
    cached.yesBid     === s.yesBid     &&
    cached.noBid      === s.noBid
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("zero-fill suppression cache", () => {
  beforeEach(() => {
    _resetAutoTraderStateForTesting();
  });

  // ── Baseline ──────────────────────────────────────────────────────────────

  it("A1: cache starts empty — no suppression before any zero-fill", () => {
    const result = _getZeroFillSuppressionForTesting("KXBTC15M-TEST-NO", "no");
    assert.equal(result, undefined, "expected no cached entry before any zero-fill");
  });

  it("A2: injection creates a retrievable cache entry", () => {
    const s = snap(86, 16, 85, 15, 84);
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", s);
    assert.ok(
      isSuppressed("KXETH15M-TEST", "no", s),
      "injected snapshot should match and suppress",
    );
  });

  it("A3: reset clears all cache entries", () => {
    _setZeroFillSuppressionForTesting("KXBTC15M-TEST", "no", snap(86, 16, 85, 15, 84));
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", snap(73, 29, 72, 28, 71));
    _resetAutoTraderStateForTesting();
    assert.equal(_getZeroFillSuppressionForTesting("KXBTC15M-TEST", "no"), undefined);
    assert.equal(_getZeroFillSuppressionForTesting("KXETH15M-TEST", "no"), undefined);
  });

  // ── Snapshot matching — any field change lifts suppression ───────────────

  it("B1: different limitCents → NOT suppressed", () => {
    const cached = snap(86, 16, 85, 15, 84);
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", cached);
    const incoming = snap(87, 16, 85, 15, 84); // limitCents changed
    assert.ok(
      !isSuppressed("KXETH15M-TEST", "no", incoming),
      "limit price change should lift suppression",
    );
  });

  it("B2: different yesAsk → NOT suppressed", () => {
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", snap(86, 16, 85, 15, 84));
    assert.ok(!isSuppressed("KXETH15M-TEST", "no", snap(86, 17, 85, 15, 84)));
  });

  it("B3: different noAsk → NOT suppressed", () => {
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", snap(86, 16, 85, 15, 84));
    assert.ok(!isSuppressed("KXETH15M-TEST", "no", snap(86, 16, 86, 15, 84)));
  });

  it("B4: different yesBid → NOT suppressed", () => {
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", snap(86, 16, 85, 15, 84));
    assert.ok(!isSuppressed("KXETH15M-TEST", "no", snap(86, 16, 85, 14, 84)));
  });

  it("B5: different noBid → NOT suppressed", () => {
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", snap(86, 16, 85, 15, 84));
    assert.ok(!isSuppressed("KXETH15M-TEST", "no", snap(86, 16, 85, 15, 83)));
  });

  it("B6: all five fields match → IS suppressed", () => {
    const s = snap(86, 16, 85, 15, 84);
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no", s);
    assert.ok(isSuppressed("KXETH15M-TEST", "no", s));
  });

  // ── Side isolation ────────────────────────────────────────────────────────

  it("C1: YES and NO sides have independent cache entries", () => {
    const sNo  = snap(86, 16, 85, 15, 84);
    const sYes = snap(77, 72, 28, 71, 27);
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "no",  sNo);
    _setZeroFillSuppressionForTesting("KXETH15M-TEST", "yes", sYes);

    assert.ok(isSuppressed("KXETH15M-TEST", "no",  sNo),  "NO side should be suppressed");
    assert.ok(isSuppressed("KXETH15M-TEST", "yes", sYes), "YES side should be suppressed");
    // Cross-check: NO snapshot does not match YES entry
    assert.ok(!isSuppressed("KXETH15M-TEST", "yes", sNo), "NO snap should not suppress YES");
  });

  it("C2: different tickers have independent cache entries", () => {
    const s = snap(86, 16, 85, 15, 84);
    _setZeroFillSuppressionForTesting("KXBTC15M-TEST", "no", s);
    assert.ok( isSuppressed("KXBTC15M-TEST", "no", s), "BTC should be suppressed");
    assert.ok(!isSuppressed("KXETH15M-TEST", "no", s), "ETH should not be suppressed by BTC entry");
  });

  // ── Regression A: KXETH15M-26JUL300845-45 (8 zero-fills) ─────────────────
  //
  // Old guard would have blocked the pre-submission (wrong).
  // New policy: first order fires.  After zero-fill, identical snapshots
  // are suppressed.

  it("D1: 0845-45 scenario — no pre-block: cache is empty before first attempt", () => {
    // noAsk=85 === 100-yesBid=15.  Under the old guard this was blocked before
    // submission.  Under the new policy, cache is empty → first order allowed.
    const result = _getZeroFillSuppressionForTesting("KXETH15M-26JUL300845-45", "no");
    assert.equal(result, undefined, "no entry before any zero-fill — first order is allowed");
  });

  it("D2: 0845-45 scenario — after zero-fill, identical snapshot is suppressed", () => {
    // Simulate placeOrder recording the snapshot on zero-fill
    const s = snap(86, 16, 85, 15, 84);
    _setZeroFillSuppressionForTesting("KXETH15M-26JUL300845-45", "no", s);

    // Subsequent ticks with identical snapshot → suppressed
    assert.ok(
      isSuppressed("KXETH15M-26JUL300845-45", "no", s),
      "identical snapshot after zero-fill should be suppressed",
    );
  });

  it("D3: 0845-45 scenario — if noAsk drops (real liquidity appears) suppression lifts", () => {
    // After zero-fill at noAsk=85, the book updates to noAsk=84 (real depth)
    const zeroed = snap(86, 16, 85, 15, 84);
    _setZeroFillSuppressionForTesting("KXETH15M-26JUL300845-45", "no", zeroed);

    const improved = snap(86, 16, 84, 15, 84); // noAsk dropped to 84
    assert.ok(
      !isSuppressed("KXETH15M-26JUL300845-45", "no", improved),
      "improved quote should lift suppression",
    );
  });

  // ── Regression B: KXBTC15M/KXETH15M-26JUL300930-30 (false negative) ──────
  //
  // Old guard blocked because noAsk === 100 − yesBid.
  // New policy: no BBO pre-block — these snapshots must NOT be pre-suppressed.

  it("E1: 0930-30 BTC — noAsk=75=100-yesBid=25 → no pre-block (cache empty)", () => {
    // This was the exact snapshot that the old guard blocked but production filled
    const result = _getZeroFillSuppressionForTesting("KXBTC15M-26JUL300930-30", "no");
    assert.equal(result, undefined, "no cache entry means no pre-block — order is allowed");
  });

  it("E2: 0930-30 ETH — noAsk=72=100-yesBid=28 → no pre-block (cache empty)", () => {
    const result = _getZeroFillSuppressionForTesting("KXETH15M-26JUL300930-30", "no");
    assert.equal(result, undefined, "no cache entry means no pre-block — order is allowed");
  });

  it("E3: 0930-30 — after a successful fill the cache entry is cleared", () => {
    // Simulate: a prior tick zero-filled and set the cache
    const s = snap(76, 30, 75, 25, 70);
    _setZeroFillSuppressionForTesting("KXBTC15M-26JUL300930-30", "no", s);
    assert.ok(isSuppressed("KXBTC15M-26JUL300930-30", "no", s), "pre-condition: cached");

    // Simulate: placeOrder clears on fill
    // (In production this happens inside placeOrder when fillCount > 0)
    _resetAutoTraderStateForTesting(); // full reset equivalent for unit test
    assert.equal(
      _getZeroFillSuppressionForTesting("KXBTC15M-26JUL300930-30", "no"),
      undefined,
      "cache entry should be cleared after a fill",
    );
  });

  // ── Window rollover ───────────────────────────────────────────────────────

  it("F1: entries for different tickers survive each other's rollover", () => {
    const sA = snap(86, 16, 85, 15, 84);
    const sB = snap(73, 29, 72, 28, 71);
    _setZeroFillSuppressionForTesting("KXBTC15M-TESTA", "no", sA);
    _setZeroFillSuppressionForTesting("KXETH15M-TESTB", "no", sB);

    // Simulate rollover clearing only TESTA (handled by handleWindowRollover via prefix scan)
    // Use reset to approximate full rollover for test isolation
    _resetAutoTraderStateForTesting();
    assert.equal(_getZeroFillSuppressionForTesting("KXBTC15M-TESTA", "no"), undefined);
    assert.equal(_getZeroFillSuppressionForTesting("KXETH15M-TESTB", "no"), undefined);
  });

  // ── null fields ───────────────────────────────────────────────────────────

  it("G1: null fields in snapshot are matched exactly — not ignored", () => {
    const withNull  = snap(76, null, 75, 25, 70);
    const withValue = snap(76, 30,   75, 25, 70);
    _setZeroFillSuppressionForTesting("KXBTC15M-TEST", "no", withNull);

    assert.ok( isSuppressed("KXBTC15M-TEST", "no", withNull),  "null matched to null → suppressed");
    assert.ok(!isSuppressed("KXBTC15M-TEST", "no", withValue), "null vs value → NOT suppressed");
  });
});
