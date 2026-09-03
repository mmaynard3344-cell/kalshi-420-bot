/**
 * Unit tests for orderbookCapture.ts / orderbookParsing.ts
 *
 * Tests the pure parsing and depth-computation helpers without making any
 * HTTP calls.  Follows the same esbuild-bundle pattern as all other test files
 * in this suite (no module mocking required).
 *
 * ── Key semantics after the counterparty-side fix ────────────────────────────
 * Kalshi's orderbook_fp has two arrays:
 *   yes_dollars — resting BUY YES orders (YES buyers = implicit NO sellers)
 *   no_dollars  — resting BUY NO  orders (NO  buyers = implicit YES sellers)
 *
 * parseOrderbookResponse selects the counterparty array for the given side:
 *   side="no"  → reads yes_dollars; converts YES price → NO-eq (100 − rawYes)
 *   side="yes" → reads no_dollars;  converts NO  price → YES-eq (100 − rawNo)
 *
 * computeSnapshotFields then uses "priceCents ≤ limitCents" uniformly for
 * both sides (outcome-equivalent prices).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseOrderbookResponse,
  computeSnapshotFields,
} from "./orderbookParsing.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** Response body with yes_dollars entries — counterparty for BUY NO. */
function buyNoBody(yesDollarsLevels: [string, string][]) {
  return { orderbook_fp: { yes_dollars: yesDollarsLevels } };
}

/** Response body with no_dollars entries — counterparty for BUY YES. */
function buyYesBody(noDollarsLevels: [string, string][]) {
  return { orderbook_fp: { no_dollars: noDollarsLevels } };
}

/** Response body with both arrays — used for side-isolation tests. */
function bothBody(
  yesDollarsLevels: [string, string][],
  noDollarsLevels:  [string, string][],
) {
  return { orderbook_fp: { yes_dollars: yesDollarsLevels, no_dollars: noDollarsLevels } };
}

/**
 * Full snapshot for a BUY NO order.
 * yesDollarsLevels: raw YES-side entries; prices are YES¢ (converted to NO-eq).
 * noLimitCents: our NO limit in whole cents.
 */
function snapNo(yesDollarsLevels: [string, string][], noLimitCents: number) {
  const parsed = parseOrderbookResponse(buyNoBody(yesDollarsLevels), "no");
  return computeSnapshotFields(parsed, noLimitCents);
}

/**
 * Full snapshot for a BUY YES order.
 * noDollarsLevels: raw NO-side entries; prices are NO¢ (converted to YES-eq).
 * yesLimitCents: our YES limit in whole cents.
 */
function snapYes(noDollarsLevels: [string, string][], yesLimitCents: number) {
  const parsed = parseOrderbookResponse(buyYesBody(noDollarsLevels), "yes");
  return computeSnapshotFields(parsed, yesLimitCents);
}

// ── parseOrderbookResponse — counterparty-side selection (item 7 tests) ──────

describe("parseOrderbookResponse — counterparty-side selection", () => {
  it("BUY NO at 90¢ reads yes_dollars, ignores no_dollars", () => {
    // Both arrays present; yes_dollars has one 10¢ YES bid → NO-eq 90¢.
    // no_dollars has a 90¢ NO bid (same-side demand — must NOT be counted).
    const body = bothBody(
      [["0.1000", "100.00"]],   // YES bid 10¢ → NO-eq 90¢ (counterparty)
      [["0.9000", "900.00"]],   // NO  bid 90¢ (same side as our order)
    );
    const levels = parseOrderbookResponse(body, "no");
    // Should only have the one YES-derived level at 90¢ NO-eq.
    assert.equal(levels.length, 1, "should have exactly one counterparty level");
    assert.equal(levels[0]!.priceCents, 90, "NO-equivalent price should be 90¢");
  });

  it("YES bid of 10¢ is executable for BUY NO at 90¢", () => {
    // YES bid at 10¢ → NO-eq 90¢ ≤ limit 90¢ → depth > 0
    const s = snapNo([["0.1000", "100.00"]], 90);
    assert.ok(s.depthAtOrBetterDollars > 0, "YES bid at 10¢ should be executable for NO limit of 90¢");
    assert.equal(s.lowestLevelCents, 90, "lowest counterparty offer should be 90¢ NO-eq");
  });

  it("YES bid strictly below 10¢ is NOT executable for BUY NO at 90¢", () => {
    // YES bid at 9¢ → NO-eq 91¢ > limit 90¢ → zero depth
    const s = snapNo([["0.0900", "90.00"]], 90);
    assert.equal(s.depthAtOrBetterDollars, 0, "YES bid at 9¢ should not be executable at NO limit 90¢");
    assert.equal(s.lowestLevelCents, 91, "lowest counterparty offer should be 91¢ NO-eq (above limit)");
  });

  it("YES bid above 10¢ is executable for BUY NO at 90¢ (better fill)", () => {
    // YES bid at 11¢ → NO-eq 89¢ < limit 90¢ → executable (we get better than limit)
    const s = snapNo([["0.1100", "110.00"]], 90);
    assert.ok(s.depthAtOrBetterDollars > 0);
    assert.equal(s.lowestLevelCents, 89);
  });

  it("BUY YES reads no_dollars, ignores yes_dollars", () => {
    // Both arrays present; no_dollars has one 20¢ NO bid → YES-eq 80¢.
    // yes_dollars has an 80¢ YES bid (same side as our order — must NOT be counted).
    const body = bothBody(
      [["0.8000", "800.00"]],   // YES bid 80¢ (same side as our BUY YES — must be ignored)
      [["0.2000", "200.00"]],   // NO  bid 20¢ → YES-eq 80¢ (counterparty)
    );
    const levels = parseOrderbookResponse(body, "yes");
    assert.equal(levels.length, 1, "should have exactly one counterparty level");
    assert.equal(levels[0]!.priceCents, 80, "YES-equivalent price should be 80¢");
  });

  it("NO bid of 20¢ is executable for BUY YES at 80¢", () => {
    // NO bid at 20¢ → YES-eq 80¢ ≤ limit 80¢ → depth > 0
    const s = snapYes([["0.2000", "200.00"]], 80);
    assert.ok(s.depthAtOrBetterDollars > 0);
    assert.equal(s.lowestLevelCents, 80);
  });

  it("NO bid strictly below 20¢ is NOT executable for BUY YES at 80¢", () => {
    // NO bid at 19¢ → YES-eq 81¢ > limit 80¢ → zero depth
    const s = snapYes([["0.1900", "190.00"]], 80);
    assert.equal(s.depthAtOrBetterDollars, 0);
    assert.equal(s.lowestLevelCents, 81);
  });

  it("duplicate raw price entries are aggregated into one level", () => {
    // Three separate resting YES orders at 10¢ each — common in Kalshi's fp format.
    // Second tuple element is contracts: 100, 200, 50 → total 350 contracts @ 10¢.
    const s = snapNo([
      ["0.1000", "100.00"],
      ["0.1000", "200.00"],
      ["0.1000",  "50.00"],
    ], 90);
    assert.equal(s.totalLevels, 1, "three entries at same price → one aggregated level");
    assert.equal(s.depthAtOrBetterDollars, 35,  "notional = (100+200+50) contracts × 0.10 = $35");
    assert.equal(s.depthAtOrBetterContracts, 350, "contracts summed: 100+200+50 = 350");
  });

  it("two different executable prices are kept as separate levels after aggregation", () => {
    // 100 contracts @ 10¢ + 110 contracts @ 11¢ — both at-or-better for NO limit 90¢.
    const s = snapNo([
      ["0.1000", "100.00"],   // YES 10¢ → NO-eq 90¢, 100 contracts @ $0.10
      ["0.1100", "110.00"],   // YES 11¢ → NO-eq 89¢, 110 contracts @ $0.11
    ], 90);
    assert.equal(s.totalLevels, 2);
    assert.equal(s.depthAtOrBetterDollars, 100*0.10 + 110*0.11, "both levels at-or-better");
    assert.equal(s.depthAtOrBetterContracts, 100 + 110, "210 total contracts");
  });

  it("empty yes_dollars returns zero levels and depth (side=no)", () => {
    const s = snapNo([], 90);
    assert.equal(s.totalLevels, 0);
    assert.equal(s.depthAtOrBetterDollars, 0);
    assert.equal(s.lowestLevelCents, null);
  });

  it("empty no_dollars returns zero levels and depth (side=yes)", () => {
    const s = snapYes([], 80);
    assert.equal(s.totalLevels, 0);
    assert.equal(s.depthAtOrBetterDollars, 0);
  });

  it("completely empty response object returns zero depth without throwing", () => {
    assert.doesNotThrow(() => {
      const levels = parseOrderbookResponse({} as never, "no");
      computeSnapshotFields(levels, 90);
    });
    const levels = parseOrderbookResponse({} as never, "no");
    assert.equal(levels.length, 0);
  });

  it("response with only no_dollars returns empty for side=no (wrong side)", () => {
    // If Kalshi ever returns only no_dollars and no yes_dollars, a BUY NO order
    // sees an empty counterparty array — depth = 0, not a false positive.
    const body = { orderbook_fp: { no_dollars: [["0.9000", "900.00"] as [string, string]] } };
    const levels = parseOrderbookResponse(body, "no");
    assert.equal(levels.length, 0, "no_dollars should not be used for side=no");
  });

  it("skips entries with non-numeric price", () => {
    const levels = parseOrderbookResponse(buyNoBody([["bad", "100.00"], ["0.1000", "100.00"]]), "no");
    assert.equal(levels.length, 1);
    assert.equal(levels[0]!.priceCents, 90); // 100-10=90
  });

  it("skips entries with price = 0", () => {
    const levels = parseOrderbookResponse(buyNoBody([["0.0000", "500.00"], ["0.1800", "100.00"]]), "no");
    assert.equal(levels.length, 1);
    assert.equal(levels[0]!.priceCents, 82); // 100-18=82
  });

  it("skips entries with price >= 1.0 (would produce outcome price ≤ 0)", () => {
    const levels = parseOrderbookResponse(buyNoBody([["1.0000", "100.00"], ["0.1500", "150.00"]]), "no");
    assert.equal(levels.length, 1);
    assert.equal(levels[0]!.priceCents, 85); // 100-15=85
  });

  it("skips entries with negative price", () => {
    const levels = parseOrderbookResponse(buyNoBody([["-0.1000", "100.00"], ["0.1200", "120.00"]]), "no");
    assert.equal(levels.length, 1);
  });

  it("skips entries with non-numeric notional", () => {
    const levels = parseOrderbookResponse(buyNoBody([["0.1000", "bad"], ["0.1800", "300.00"]]), "no");
    assert.equal(levels.length, 1);
    assert.equal(levels[0]!.priceCents, 82);
  });

  it("sorts entries ascending by outcome-equivalent price", () => {
    // YES bids: 25¢, 18¢, 10¢ → NO-eq: 75¢, 82¢, 90¢ → sorted ascending: 75, 82, 90
    const levels = parseOrderbookResponse(buyNoBody([
      ["0.2500", "300.00"],
      ["0.1000", "200.00"],
      ["0.1800", "400.00"],
    ]), "no");
    assert.equal(levels[0]!.priceCents, 75);
    assert.equal(levels[1]!.priceCents, 82);
    assert.equal(levels[2]!.priceCents, 90);
  });

  it("falls back to schema yes[] for side=no when orderbook_fp absent", () => {
    // Schema format: price is in cents (YES cents), quantity in contracts.
    // YES at 10¢ → NO-eq 90¢.
    const raw = { yes: [{ price: 10, quantity: 100 }] };
    const levels = parseOrderbookResponse(raw as never, "no");
    assert.equal(levels.length, 1);
    assert.equal(levels[0]!.priceCents, 90);   // 100-10=90
    assert.equal(levels[0]!.contractsApprox, 100);
  });

  it("falls back to schema no[] for side=yes when orderbook_fp absent", () => {
    // NO at 20¢ → YES-eq 80¢.
    const raw = { no: [{ price: 20, quantity: 50 }] };
    const levels = parseOrderbookResponse(raw as never, "yes");
    assert.equal(levels.length, 1);
    assert.equal(levels[0]!.priceCents, 80);   // 100-20=80
    assert.equal(levels[0]!.contractsApprox, 50);
  });
});

// ── computeSnapshotFields — depth and level computation ──────────────────────

describe("computeSnapshotFields — depth and level computation", () => {
  it("returns all-zero/null for empty level list", () => {
    const s = computeSnapshotFields([], 90);
    assert.equal(s.totalLevels, 0);
    assert.equal(s.depthAtOrBetterDollars, 0);
    assert.equal(s.depthAtOrBetterContracts, 0);
    assert.equal(s.lowestLevelCents, null);
    assert.equal(s.highestLevelCents, null);
    assert.deepEqual(s.nearLimitLevels, []);
  });

  it("accumulates depth for all levels at-or-below the NO limit", () => {
    // YES bids at 25¢, 20¢, 18¢, 17¢ → NO-eq: 75¢, 80¢, 82¢, 83¢
    // BUY NO limit = 82¢ → executable: 75 (✓), 80 (✓), 82 (✓), 83 (✗)
    // Second tuple element is contracts; notional = contracts × unit price.
    const s = snapNo([
      ["0.2500", "300.00"],  // NO-eq 75¢ ≤ 82 ✓  300 contracts @ 25¢ = $75
      ["0.2000", "400.00"],  // NO-eq 80¢ ≤ 82 ✓  400 contracts @ 20¢ = $80
      ["0.1800", "200.00"],  // NO-eq 82¢ = 82 ✓  200 contracts @ 18¢ = $36
      ["0.1700", "500.00"],  // NO-eq 83¢ > 82 ✗  (not counted)
    ], 82);
    assert.equal(s.depthAtOrBetterDollars, 300*0.25 + 400*0.20 + 200*0.18,
      "75+80+36=191 dollars from the three executable levels");
    assert.equal(s.depthAtOrBetterContracts, 300 + 400 + 200,
      "900 contracts across the three executable levels");
  });

  it("returns zero depth when all counterparty offers are above limit", () => {
    // YES bids at 16¢, 10¢ → NO-eq 84¢, 90¢ — both above NO limit of 82¢
    const s = snapNo([["0.1600", "1000.00"], ["0.1000", "2000.00"]], 82);
    assert.equal(s.depthAtOrBetterDollars, 0);
    assert.equal(s.depthAtOrBetterContracts, 0);
    assert.equal(s.lowestLevelCents, 84); // cheapest counterparty offer > limit
  });

  it("counts a level exactly at the limit as at-or-better", () => {
    // YES bid at 18¢ → NO-eq 82¢ = limit 82¢ → executable.
    // 1640 contracts @ 18¢ = $295.20 notional.
    const s = snapNo([["0.1800", "1640.00"]], 82);
    assert.equal(s.depthAtOrBetterDollars,   1640 * 0.18, "1640 contracts × $0.18 = $295.20");
    assert.equal(s.depthAtOrBetterContracts, 1640,        "1640 contracts at limit");
  });

  it("reports correct lowest and highest level cents (outcome-side)", () => {
    // YES bids at 10¢, 18¢, 25¢ → NO-eq: 90¢, 82¢, 75¢ → sorted: 75, 82, 90
    const s = snapNo([["0.1000", "100.00"], ["0.1800", "200.00"], ["0.2500", "300.00"]], 85);
    assert.equal(s.lowestLevelCents, 75);   // cheapest counterparty = 75¢ NO-eq
    assert.equal(s.highestLevelCents, 90);  // most expensive counterparty = 90¢ NO-eq
  });

  it("nearLimitLevels includes at most 5 below and 5 above limit", () => {
    // 26 YES levels: 1¢ to 26¢ → NO-eq 99¢ to 74¢
    const levels: [string, string][] = [];
    for (let yesCents = 1; yesCents <= 26; yesCents++) {
      levels.push([`0.${String(yesCents).padStart(2, "0")}`, "100.00"]);
    }
    // BUY NO at 82¢ limit → at-or-better are YES bids ≥ 18¢ → NO-eq ≤ 82¢
    const s = snapNo(levels, 82);
    assert.ok(s.nearLimitLevels.length <= 10);
    const below = s.nearLimitLevels.filter((l) => l.priceCents <= 82);
    const above = s.nearLimitLevels.filter((l) => l.priceCents > 82);
    assert.ok(below.length <= 5, `expected ≤5 at-or-below, got ${below.length}`);
    assert.ok(above.length <= 5, `expected ≤5 above, got ${above.length}`);
  });

  it("nearLimitLevels are ordered ascending by outcome-equivalent price", () => {
    const s = snapNo([
      ["0.1000", "100.00"],  // NO-eq 90
      ["0.2200", "200.00"],  // NO-eq 78
      ["0.1800", "300.00"],  // NO-eq 82
    ], 85);
    const prices = s.nearLimitLevels.map((l) => l.priceCents);
    for (let i = 1; i < prices.length; i++) {
      assert.ok(prices[i]! >= prices[i - 1]!, `not sorted at index ${i}: ${prices}`);
    }
  });

  it("handles single level at limit", () => {
    // YES bid at 18¢ → NO-eq 82¢ = limit. 820 contracts @ 18¢ = $147.60 notional.
    const s = snapNo([["0.1800", "820.00"]], 82);
    assert.equal(s.totalLevels, 1);
    assert.equal(s.depthAtOrBetterDollars,   820 * 0.18, "820 contracts × $0.18 = $147.60");
    assert.equal(s.depthAtOrBetterContracts, 820);
    assert.equal(s.nearLimitLevels.length, 1);
    assert.equal(s.nearLimitLevels[0]!.priceCents, 82);
  });
});

// ── Miss classification evidence (from snapshot fields) ──────────────────────

describe("miss classification evidence (from snapshot fields)", () => {
  it("depthAtOrBetter=0, lowestLevel>limit → no_executable_depth evidence", () => {
    // YES bid at 16¢ → NO-eq 84¢ > limit 82¢ → no counterparty at our price
    const s = snapNo([["0.1600", "500.00"]], 82);
    assert.equal(s.depthAtOrBetterDollars, 0);
    assert.equal(s.lowestLevelCents, 84, "cheapest counterparty offer is 84¢ (above our 82¢ limit)");
  });

  it("depthAtOrBetter>0 → executable_depth_present_but_unfilled evidence", () => {
    // YES bid at 19¢ → NO-eq 81¢ ≤ limit 82¢ → depth present but IOC zero-filled
    const s = snapNo([["0.1900", "8100.00"]], 82);
    assert.ok(s.depthAtOrBetterDollars > 0, "depth present — IOC failure is unexplained");
    assert.equal(s.lowestLevelCents, 81, "best counterparty offer is 81¢ (below our limit)");
  });

  it("book empty (no levels) → genuine no-depth evidence", () => {
    const s = snapNo([], 82);
    assert.equal(s.depthAtOrBetterDollars, 0);
    assert.equal(s.lowestLevelCents, null);
  });
});

// ── Production-shaped fp tuples — unit verification ───────────────────────────
//
// Confirmed via live Kalshi API inspection: the second element of each
// orderbook_fp tuple is the CONTRACT COUNT at that price, not a notional-dollar
// value.  Example from KXBTC15M-26JUL301400-00:
//   ["0.0010", "174433.00"] → 174,433 contracts at 0.1¢ each = $174.43 notional
// Treating the second element as dollars would give 174,433,000 contracts —
// economically impossible.

describe("production-shaped fp tuples — unit verification", () => {
  it("second element is contracts: notional = contracts × unit price", () => {
    // ["0.1000", "9148.00"] → 9148 contracts at 10¢ = $914.80 notional.
    // Old wrong formula: notional=9148 → contracts=9148/0.10=91480 (wrong).
    const levels = parseOrderbookResponse(buyNoBody([["0.1000", "9148.00"]]), "no");
    assert.equal(levels.length, 1);
    assert.equal(levels[0]!.contractsApprox, 9148,       "second element is contract count");
    assert.equal(levels[0]!.notionalDollars, 9148 * 0.10, "notional = contracts × unit price");
  });

  it("Order-1 representative: 5 entries at ~0.5¢, 744 contracts total, depth=0 at YES 86¢", () => {
    // KXBTC15M-26JUL301345-45 BUY YES at 86¢ — Order 1 (2026-07-30 17:44:34Z).
    // Production log: l2_raw_entry_count=5, l2_total_levels=1, l2_lowest_level_cents=99.
    // Five no_dollars entries all had rawPrice≈0.005 (rounds to 1¢ NO → outcome 99¢).
    // Their second values (contracts) summed to 744; notional ≈ 744×0.005 = $3.72.
    // Depth at our 86¢ YES limit = 0 because all resting depth is at outcome 99¢.
    const s = snapYes([
      ["0.0050", "149.00"],
      ["0.0050", "180.00"],
      ["0.0050", "200.00"],
      ["0.0050",  "97.00"],
      ["0.0050", "118.00"],
    ], 86);
    assert.equal(s.totalLevels, 1,        "all 5 entries aggregate to one level at 99¢");
    assert.equal(s.lowestLevelCents, 99,  "resting depth is at outcome 99¢ YES-eq");
    assert.equal(s.lowestLevelContractsApprox, 744, "total contracts = 744");
    assert.ok(
      Math.abs(s.lowestLevelDollars! - (149+180+200+97+118)*0.005) < 1e-9,
      "notional ≈ $3.72",
    );
    assert.equal(s.depthAtOrBetterDollars,   0, "no depth at or below our 86¢ YES limit");
    assert.equal(s.depthAtOrBetterContracts, 0, "no contracts at or below our 86¢ YES limit");
  });

  it("entries with rawPrice ≤ 0.004 are filtered — would produce outcome price ≥ 100¢", () => {
    // Live market: ["0.0010", "174433.00"] → Math.round(0.001*100)=0 → outcome=100 → filtered.
    // Entries at 0.001, 0.002, 0.003, 0.004 all round to 0¢ → outcome 100¢ → excluded.
    const levels = parseOrderbookResponse(buyNoBody([
      ["0.0010", "174433.00"],  // rounds to outcome 100¢ — filtered
      ["0.0020",   "3441.00"],  // rounds to outcome 100¢ — filtered
      ["0.0040",    "635.00"],  // rounds to outcome 100¢ — filtered
      ["0.0050",    "795.00"],  // rounds to outcome  99¢ — kept
    ]), "no");
    assert.equal(levels.length, 1, "only the 0.5¢ entry survives; lower prices are filtered");
    assert.equal(levels[0]!.priceCents, 99);
    assert.equal(levels[0]!.contractsApprox, 795);
  });

  it("live-book representative: multiple entries aggregating at 99¢, depth=0 at NO 90¢", () => {
    // Based on live KXBTC15M-26JUL301400-00 no_dollars data (0.005¢–0.01¢ range).
    // All three round to outcome 99¢; BUY NO limit 90¢ → all above limit → depth=0.
    const s = snapNo([
      ["0.0050",  "795.00"],  // 795 contracts at 0.5¢ → outcome 99¢
      ["0.0060",  "172.00"],  // 172 contracts at 0.6¢ → outcome 99¢
      ["0.0100", "9148.00"],  // 9148 contracts at 1¢  → outcome 99¢
    ], 90);
    assert.equal(s.depthAtOrBetterDollars,   0, "all depth at 99¢, above NO limit of 90¢");
    assert.equal(s.depthAtOrBetterContracts, 0);
    assert.equal(s.totalLevels, 1, "all three entries aggregate to one 99¢ level");
    assert.equal(s.lowestLevelContractsApprox, 795 + 172 + 9148,
      "10115 total contracts at the 99¢ level");
  });
});

describe("miss classification evidence (from snapshot fields)", () => {
  it("representative fixture: both yes_dollars and no_dollars present", () => {
    // Simulates a real KXBTC15M-style response where both arrays are populated.
    // BUY NO at 90¢: counterparty = yes_dollars (YES buyers).
    const body = bothBody(
      // yes_dollars: YES bids at 11¢, 10¢, 9¢ → NO-eq: 89¢, 90¢, 91¢
      [
        ["0.1100", "110.00"],   // YES 11¢ → NO-eq 89¢ (executable: ≤90)
        ["0.1000", "100.00"],   // YES 10¢ → NO-eq 90¢ (executable: =90)
        ["0.1000",  "50.00"],   // YES 10¢ duplicate → aggregated with above
        ["0.0900",  "90.00"],   // YES  9¢ → NO-eq 91¢ (NOT executable: >90)
      ],
      // no_dollars: NO bids at 89¢, 90¢, 91¢ — same-side, must be ignored
      [
        ["0.8900", "890.00"],
        ["0.9000", "900.00"],
        ["0.9100", "910.00"],
      ],
    );
    const levels = parseOrderbookResponse(body, "no");
    // 4 raw YES entries: 11¢, 10¢+10¢(dup), 9¢ → 3 distinct prices → 3 levels
    assert.equal(levels.length, 3, "3 distinct outcome prices: 89¢, 90¢, 91¢");

    const s = computeSnapshotFields(levels, 90);
    // Executable: 89¢ (110 contracts @ 11¢ = $12.10) + 90¢ (150 contracts @ 10¢ = $15.00)
    assert.equal(s.depthAtOrBetterDollars, 110*0.11 + 150*0.10,
      "12.10 + 15.00 from the two executable levels");
    assert.equal(s.depthAtOrBetterContracts, 110 + 150,
      "260 total contracts across the two executable levels");
    assert.equal(s.totalLevels, 3);
    assert.equal(s.lowestLevelCents, 89, "best counterparty offer is 89¢");
    assert.equal(s.highestLevelCents, 91, "most expensive counterparty offer is 91¢");
  });
});
