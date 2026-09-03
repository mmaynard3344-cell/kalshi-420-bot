/**
 * autoTrader.preflight.test.ts
 *
 * Gate-level tests for the pre-flight L2 executability check.
 * Tests run against the real computePreflightDecision() exported from
 * preflightGate.ts — the same logic used inline in autoTrader.ts
 * checkAndPlace().
 *
 * ── What is under test ───────────────────────────────────────────────────────
 * computePreflightDecision() takes the raw L2 book data and BBO context and
 * returns { decision, verifiedLimitCents, adjustedContracts, ... } without
 * any I/O or logging.  autoTrader.ts wraps it with L2 fetch, logging, and SQL
 * side-effects — those are tested via integration tests and production logs.
 *
 * ── Strategy design intent confirmed by these tests ─────────────────────────
 * 1. Entry band (ALERT_MIN–ALERT_MAX = 89–95¢) is a SIGNAL filter. It is
 *    checked against the BBO-derived ask before checkAndPlace is called. The
 *    fresh selected-side executable L2 price must independently remain inside
 *    the same inclusive band before an order may be submitted.
 *
 * 2. A fresh executable L2 price outside 89–95¢ is a hard skip. It is not
 *    clamped back into range.
 *
 * 3. The one-sided falling-knife check blocks a fresh executable price that is
 *    10¢ or more below the BBO-derived trigger/reference. Higher fresh prices
 *    remain eligible when they satisfy the hard band and authorized limit.
 *
 * ── Counterparty side reading (confirmed correct) ────────────────────────────
 * For BUY NO:  counterparty = yes_dollars (YES buyers = implicit NO sellers).
 *              outcomePriceCents = 100 − rawYesPriceCents.
 * For BUY YES: counterparty = no_dollars (NO buyers = implicit YES sellers).
 *              outcomePriceCents = 100 − rawNoPriceCents.
 * depth at verifiedLimit counts levels where outcomePriceCents ≤ verifiedLimit.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  computePreflightDecision,
  ALERT_MIN,
  ALERT_MAX,
  MAX_BBO_L2_NEGATIVE_GAP_CENTS,
  LIMIT_PRICE_BUFFER_CENTS,
} from "./preflightGate.js";
import {
  PRICE_FLOOR_CENTS,
  type TrackedSeries,
  _resetAutoTraderStateForTesting,
  _forcePreflightInFlightForTesting,
  _isPreflightInFlightForTesting,
  _clearPreflightInFlightForTesting,
  _forceSubmissionInFlightForTesting,
  _isSubmissionInFlightForTesting,
  preflightInFlight,
  submissionInFlight,
} from "./autoTraderGuards.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const BET = 100; // dollars — standard per-window budget

/**
 * YES-dollars entry for a BUY NO order.
 * yesPriceCents: the YES bid price.  outcomePriceCents = 100 − yesPriceCents.
 * notional: depth in dollars.
 */
function yes(yesPriceCents: number, notional: number): [string, string] {
  return [(yesPriceCents / 100).toFixed(4), notional.toFixed(2)];
}

/**
 * NO-dollars entry for a BUY YES order.
 * noPriceCents: the NO bid price.  outcomePriceCents = 100 − noPriceCents.
 * notional: depth in dollars.
 */
function no(noPriceCents: number, notional: number): [string, string] {
  return [(noPriceCents / 100).toFixed(4), notional.toFixed(2)];
}

// Reset shared state between tests (zero-fill suppression cache etc.)
beforeEach(() => { _resetAutoTraderStateForTesting(); });

// ── Test wrapper ──────────────────────────────────────────────────────────────
//
// Most tests are NOT testing the strategy ceiling — they are testing gap logic
// and depth counting. Using bboDerivedLimitCents = ALERT_MAX (92¢) lets every
// in-band executable price reach the behavior the fixture is meant to exercise.
//
// Tests that specifically exercise the ceiling (Section 12) override
// bboDerivedLimitCents by passing it explicitly.
function pf(opts: {
  series?:               TrackedSeries;
  side:                  "yes" | "no";
  bboAsk:                number | null;
  rawYesDollars:         [string, string][];
  rawNoDollars:          [string, string][];
  betDollars:            number;
  bboDerivedLimitCents?: number;
}): ReturnType<typeof computePreflightDecision> {
  return computePreflightDecision({
    series: "KXBTC15M",
    bboDerivedLimitCents: ALERT_MAX,
    ...opts,
  });
}

// ── Section 1: BUY NO — executable price-band cases ──────────────────────────

describe("computePreflightDecision — BUY NO executable price-band cases", () => {

  it("execAsk 68¢ (BBO 70¢, gap −2¢): skips outside the executable band", () => {
    // YES buyer at 32¢ YES → NO-eq 68¢.  Depth $500 at ≤70¢ limit.
    const r = pf({
      side:          "no",
      bboAsk:        70,
      rawYesDollars: [yes(32, 500)],
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,           "skip_executable_price_outside_band");
    assert.equal(r.executableBestAskCents, 68,            "execAsk must be 68¢");
    assert.equal(r.verifiedLimitCents, null);
    assert.equal(r.bboToL2GapCents,   -2,                "gap = 68 − 70 = −2¢");
    assert.equal(r.adjustedContracts, 0);
  });

  it("execAsk 69¢ (BBO 70¢): skips outside the executable band", () => {
    // YES buyer at 31¢ → NO-eq 69¢
    const r = pf({
      side:          "no",
      bboAsk:        70,
      rawYesDollars: [yes(31, 400)],
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,           "skip_executable_price_outside_band");
    assert.equal(r.executableBestAskCents, 69);
    assert.equal(r.verifiedLimitCents, null);
    assert.equal(r.adjustedContracts, 0);
  });

  it("execAsk 90¢ (BBO 91¢): inclusive executable floor submits", () => {
    // YES buyer at 10¢ → NO-eq 90¢
    const r = pf({
      side:          "no",
      bboAsk:        91,
      rawYesDollars: [yes(10, 300)],
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,           "submit");
    assert.equal(r.executableBestAskCents, 90);
    assert.equal(r.verifiedLimitCents, 91);
    assert.ok(r.depthAtLimitDollars  > 0);
    assert.ok(r.adjustedContracts    > 0);
  });

  it("execAsk 91¢ (BBO 91¢): buffer gives 92¢ → submit", () => {
    // YES buyer at 9¢ → NO-eq 91¢. Depth at ≤92¢ includes the 91¢ level.
    const r = pf({
      side:          "no",
      bboAsk:        91,
      rawYesDollars: [yes(9, 300)],
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,           "submit");
    assert.equal(r.executableBestAskCents, 91);
    assert.equal(r.verifiedLimitCents, 92);
    assert.ok(r.depthAtLimitDollars > 0, "91¢ is ≤ 92¢ limit");
  });

  // 1d-corrected: book exists but contractsApprox rounds to 0 → skip_zero_depth
  //
  // The second element of a yes_dollars / no_dollars tuple is the CONTRACT COUNT
  // (not notional dollars).  contractsApprox = Math.round(rawContracts).
  // When rawContracts < 0.5, Math.round rounds it to 0 → depthAtOrBetterContracts=0.
  //
  // Since execAsk = min(levels) and verifiedLimit ≥ execAsk, the minimum level is
  // always at-or-below verifiedLimit.  skip_zero_depth in a non-empty book therefore
  // requires a level whose rawContracts rounds to 0.
  it("counterparty level rounds to 0 contracts → depthAtOrBetterContracts=0 → skip_zero_depth", () => {
    // YES buyer at 10¢ → NO-eq 90¢, rawContracts=0.2.
    // contractsApprox = Math.round(0.2) = 0 → depthAtOrBetterContracts = 0.
    // notionalDollars = 0.2 × 0.30 = $0.06 > 0 (dollars exist, but no whole contracts).
    const r = pf({
      side:          "no",
      bboAsk:        90,
      rawYesDollars: [yes(10, 0.2)], // NO-eq 90¢, rawContracts=0.2 → rounds to 0
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,              "skip_zero_depth",
      "depth dollars present but 0 whole contracts → skip_zero_depth");
    assert.equal(r.adjustedContracts,     0);
    assert.ok(r.depthAtLimitDollars       > 0,  "some notional exists at limit ($0.06)");
    assert.equal(r.depthAtLimitContracts, 0,    "but rawContracts=0.2 rounds to 0");
  });
});

// ── Section 2: Empty book ──────────────────────────────────────────────────────

describe("computePreflightDecision — empty book", () => {

  it("no counterparty levels → skip_zero_depth with null verifiedLimit", () => {
    const r = pf({
      side:          "no",
      bboAsk:        72,
      rawYesDollars: [],
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,               "skip_zero_depth");
    assert.equal(r.executableBestAskCents, null);
    assert.equal(r.bboToL2GapCents,        null);
    assert.equal(r.verifiedLimitCents,     null);
    assert.equal(r.adjustedContracts,      0);
    assert.equal(r.depthAtLimitDollars,    0);
  });

  it("BUY YES: no counterparty levels → skip_zero_depth", () => {
    const r = pf({
      side:          "yes",
      bboAsk:        80,
      rawYesDollars: [],
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision, "skip_zero_depth");
    assert.equal(r.executableBestAskCents, null);
  });
});

// ── Section 3: BBO-to-L2 gap checks ──────────────────────────────────────────

describe("computePreflightDecision — BBO-to-L2 gap", () => {

  it("positive gap (+2¢): remains eligible for submission", () => {
    // execAsk = 92¢, bboAsk = 90¢, gap = +2. Higher prices are permitted
    // when they remain in the hard band and the authorized limit permits them.
    const r = pf({
      side:          "no",
      bboAsk:        90,
      rawYesDollars: [yes(8, 300)], // NO-eq 92¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.notEqual(r.decision, "skip_stale_bbo_gap", "gap = exactly threshold — should pass");
    assert.equal(r.bboToL2GapCents, 2);
  });

  it("positive gap (+3¢): can submit inside the hard band", () => {
    // execAsk = 92¢, bboAsk = 89¢, gap = +3. Positive movement no longer
    // triggers the stale-gap classification.
    const r = pf({
      side:          "no",
      bboAsk:        89,
      rawYesDollars: [yes(8, 200)], // NO-eq 92¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,         "submit");
    assert.equal(r.bboToL2GapCents,  3);
    assert.equal(r.verifiedLimitCents, 93);
    assert.ok(r.adjustedContracts > 0);
  });

  it("negative gap exactly at threshold (92¢ → 82¢): skip_stale_bbo_gap", () => {
    // execAsk = 82¢, bboAsk = 92¢, gap = −10. The falling-knife threshold
    // is inclusive, even though 82¢ is independently inside the hard band.
    const r = pf({
      side:          "no",
      bboAsk:        92,
      rawYesDollars: [yes(18, 200)], // NO-eq 82¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision, "skip_stale_bbo_gap");
    assert.equal(r.bboToL2GapCents, -10);
    assert.equal(r.verifiedLimitCents, null);
    assert.equal(r.adjustedContracts, 0);
  });

  it("negative gap exceeds threshold (−12¢ < −10¢) → skip_stale_bbo_gap", () => {
    // execAsk = 60¢, bboAsk = 72¢, gap = −12 < −MAX_BBO_L2_NEGATIVE_GAP_CENTS(10)
    const r = pf({
      side:          "no",
      bboAsk:        72,
      rawYesDollars: [yes(40, 200)], // NO-eq 60¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,         "skip_stale_bbo_gap");
    assert.equal(r.bboToL2GapCents,  -12);
    assert.equal(r.verifiedLimitCents, null);
    assert.equal(r.adjustedContracts,  0);
  });

  it("null bboAsk (unavailable): gap defaults to 0 but still enforces executable band", () => {
    // When bboAsk is null, gap = 0 by convention — always passes gap check.
    const r = pf({
      side:          "no",
      bboAsk:        null,
      rawYesDollars: [yes(22, 500)], // NO-eq 78¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision, "skip_executable_price_outside_band");
    assert.equal(r.bboToL2GapCents, 0);
  });
});

// ── Section 4: Price band boundaries ──────────────────────────────────────────

describe("computePreflightDecision — inclusive executable price band", () => {

  // The pf() wrapper authorizes one cent above the BBO-derived price by default.

  it("execAsk 91¢ (bboAsk 91¢): verifiedLimit 92¢ → submit", () => {
    const r = pf({
      side:          "no",
      bboAsk:        91,
      rawYesDollars: [yes(9, 100)], // NO-eq 91¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision, "submit",
      "in-band executable price must submit");
    assert.equal(r.verifiedLimitCents, 92,
      "verifiedLimit is one cent above the executable ask");
    assert.ok(r.adjustedContracts > 0);
  });

  it("execAsk 92¢ (bboAsk 92¢): verifiedLimit 93¢ → submit", () => {
    const r = pf({
      side:          "no",
      bboAsk:        92,
      rawYesDollars: [yes(8, 100)], // NO-eq 92¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision, "submit",
      "execAsk = authorizedLimit still fills");
    assert.equal(r.verifiedLimitCents, 93);
    assert.ok(r.adjustedContracts > 0,
      "92¢ level ≤ 93¢ verifiedLimit → depth counts");
  });

   it("lower-bound case skips when the fresh executable price is below 89¢", () => {
    const r = pf({
      side:          "no",
      bboAsk:        70,
      rawYesDollars: [yes(32, 500)], // execAsk=68¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
     assert.equal(r.decision, "skip_executable_price_outside_band");
  });
});

describe("computePreflightDecision — ETH-specific executable entry band", () => {
  it("accepts ETH at the inclusive 90¢ floor", () => {
    const r = pf({
      series: "KXETH15M",
      side: "no",
      bboAsk: 90,
      rawYesDollars: [yes(10, 300)], // NO-equivalent 90¢
      rawNoDollars: [],
      betDollars: 100,
    });
    assert.equal(r.decision, "submit");
    assert.equal(r.executableBestAskCents, 90);
  });

  it("accepts ETH above the inclusive floor and uses the ETH cash cap", () => {
    const r = pf({
      series: "KXETH15M",
      side: "no",
      bboAsk: 90,
      rawYesDollars: [yes(10, 1000)], // NO-equivalent 90¢
      rawNoDollars: [],
      betDollars: 100,
    });
    assert.equal(r.decision, "submit");
    assert.equal(r.executableBestAskCents, 90);
    assert.equal(r.adjustedContracts, Math.floor(100 / 0.91));
  });

  it("accepts ETH at the inclusive 92¢ cap", () => {
    const r = pf({
      series: "KXETH15M",
      side: "no",
      bboAsk: 92,
      rawYesDollars: [yes(8, 1000)], // NO-equivalent 92¢
      rawNoDollars: [],
      betDollars: 100,
    });
    assert.equal(r.decision, "submit");
    assert.equal(r.executableBestAskCents, 92);
  });
});

// ── Section 5: BUY YES symmetry ───────────────────────────────────────────────

describe("computePreflightDecision — BUY YES counterparty side and executable band", () => {

  it("BUY YES: reads no_dollars, ignores yes_dollars; execAsk 90¢ → submit", () => {
    // NO buyer at 10¢ → YES-eq 90¢ (counterparty for BUY YES).
    // yes_dollars has a large entry that must be IGNORED (same-side demand).
    const r = pf({
      side:          "yes",
      bboAsk:        90,
      rawYesDollars: [yes(20, 99999)], // YES buyer 20¢ — same side as our BUY YES, must be ignored
      rawNoDollars:  [no(10, 400)],    // NO buyer 10¢ → YES-eq 90¢ (counterparty)
      betDollars:    BET,
    });
    assert.equal(r.decision,               "submit");
    assert.equal(r.executableBestAskCents, 90, "only no_dollars should be read");
    assert.equal(r.verifiedLimitCents,     91, "90 + 1 buffer = 91");
    assert.ok(r.depthAtLimitDollars > 0);
  });

  it("BUY YES: execAsk 68¢ (NO buyer at 32¢) → skips below executable floor", () => {
    // NO buyer at 32¢ → YES-eq 68¢.
    const r = pf({
      side:          "yes",
      bboAsk:        70,
      rawYesDollars: [],
      rawNoDollars:  [no(32, 400)], // NO at 32¢ → YES-eq 68¢
      betDollars:    BET,
    });
    assert.equal(r.decision,           "skip_executable_price_outside_band");
    assert.equal(r.executableBestAskCents, 68);
    assert.equal(r.verifiedLimitCents, null);
    assert.equal(r.bboToL2GapCents,   -2,                 "gap = 68 − 70 = −2¢");
    assert.equal(r.adjustedContracts, 0);
  });

  it("BUY YES: execAsk 92¢ (bboAsk 92¢): verifiedLimit 93¢ → submit", () => {
    const r = pf({
      side:          "yes",
      bboAsk:        92,
      rawYesDollars: [],
      rawNoDollars:  [no(8, 100)], // NO at 8¢ → YES-eq 92¢
      betDollars:    BET,
    });
    assert.equal(r.decision, "submit",
      "execAsk = authorizedLimit → submit at capped verifiedLimit");
    assert.equal(r.verifiedLimitCents, 93);
    assert.ok(r.adjustedContracts > 0);
  });

  it("BUY YES: higher L2 price (+3¢) can submit inside the hard band", () => {
    // NO buyer at 8¢ → YES-eq 92¢. bboAsk=89. gap = +3 is allowed.
    const r = pf({
      side:          "yes",
      bboAsk:        89,
      rawYesDollars: [],
      rawNoDollars:  [no(8, 200)], // YES-eq 92¢
      betDollars:    BET,
    });
    assert.equal(r.decision,        "submit");
    assert.equal(r.bboToL2GapCents, 3);
  });
});

// ── Section 6: Budget and dedup invariants ────────────────────────────────────

describe("computePreflightDecision — budget and dedup invariants", () => {

  it("betDollars=0 with depth present → adjustedContracts=0 → skip_zero_contracts", () => {
    // The gate discriminates:
    //   depthAtOrBetterContracts=0  → skip_zero_depth    (no supply at limit)
    //   adjustedContracts=0 but depth>0 → skip_zero_contracts (budget too small)
    // With betDollars=0, contractsForPrice(limit, 0)=0, but depth exists → skip_zero_contracts.
    const r = pf({
      side:          "no",
      bboAsk:        91,
      rawYesDollars: [yes(10, 500)], // NO-eq 90¢, plenty of depth
      rawNoDollars:  [],
      betDollars:    0,
    });
    assert.equal(r.decision,          "skip_zero_contracts",
      "depth exists but budget=0 → adjustedContracts=0 → skip_zero_contracts, not skip_zero_depth");
    assert.equal(r.adjustedContracts, 0);
    // Depth itself is non-zero — budget is the binding constraint.
    assert.ok(r.depthAtLimitDollars > 0, "depth exists but budget is zero");
  });

  it("computePreflightDecision is pure — no shared-state mutation between calls", () => {
    // Call twice with identical inputs.  Results must match exactly.
    // If the function mutated any module-level state (e.g. zeroFillSuppressionCache),
    // results would diverge on the second call.
    const opts = {
      side:          "no" as const,
      bboAsk:        91,
      rawYesDollars: [yes(9, 200)], // NO-eq 91¢
      rawNoDollars:  [],
      betDollars:    BET,
    };
    const r1 = pf(opts);
    const r2 = pf(opts);
    assert.deepEqual(r1, r2, "pure function — same inputs must produce identical outputs");
  });

  it("zeroFillSuppressionCache unaffected by computePreflightDecision", () => {
    // computePreflightDecision must not read or write zeroFillSuppressionCache.
    // If it did, an injected cache entry would change the decision.
    // We verify this by importing _setZeroFillSuppressionForTesting and confirming
    // the decision stays "submit" regardless of the cached entry.
    // (The cache is only read in checkAndPlace's outer scope, not inside the gate.)
    const { _setZeroFillSuppressionForTesting } = require("./autoTraderGuards.js") as typeof import("./autoTraderGuards.js");
    _setZeroFillSuppressionForTesting("KXBTC15M-CACHE-TEST", "no", {
      limitCents: 91, yesAsk: 15, noAsk: 91, yesBid: 14, noBid: 90, cachedAt: 0,
    });
    const r = pf({
      side:          "no",
      bboAsk:        91,
      rawYesDollars: [yes(9, 300)], // NO-eq 91¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    // Gate must ignore the suppression cache — it is a concern of checkAndPlace's outer layer.
    assert.equal(r.decision, "submit", "suppression cache must not affect gate decision");
  });
});

// ── Section 8: skip_zero_contracts discrimination ─────────────────────────────

describe("computePreflightDecision — skip_zero_contracts (depth exists, budget too small)", () => {

  // When there IS counterparty supply at the verified limit but the budget is
  // insufficient to buy even one contract, the gate must return skip_zero_contracts
  // (not skip_zero_depth) so analytics can distinguish the two failure modes.

  it("betDollars=0: contractsForPrice=0 but depth>0 → skip_zero_contracts", () => {
    // YES buyer at 10¢ → NO-eq 90¢. BBO=90¢. verifiedLimit=91¢.
    const r = pf({
      side:          "no",
      bboAsk:        90,
      rawYesDollars: [yes(10, 300)], // NO-eq 90¢
      rawNoDollars:  [],
      betDollars:    0,
    });
    assert.equal(r.decision,          "skip_zero_contracts",
      "budget=0 with depth must give skip_zero_contracts");
    assert.equal(r.adjustedContracts, 0);
    assert.ok(r.depthAtLimitDollars  > 0, "depth must be non-zero");
    assert.ok(r.depthAtLimitContracts > 0, "contracts at limit must be non-zero");
    // verifiedLimitCents is set (gate reaches step 8 before discriminating)
    assert.notEqual(r.verifiedLimitCents, null);
  });

  it("betDollars too small for one contract at verifiedLimit → skip_zero_contracts", () => {
    // verifiedLimit=91¢. One contract costs $0.91. Budget=$0.50 < $0.91.
    const r = pf({
      side:          "no",
      bboAsk:        90,
      rawYesDollars: [yes(10, 200)], // NO-eq 90¢
      rawNoDollars:  [],
      betDollars:    0.50,           // $0.50 — floor(0.50 / 0.80) = 0 contracts
    });
    assert.equal(r.decision,          "skip_zero_contracts");
    assert.equal(r.adjustedContracts, 0);
    assert.ok(r.depthAtLimitDollars  > 0, "depth exists at limit");
    assert.equal(r.verifiedLimitCents, 91);
  });

  it("skip_zero_contracts vs skip_zero_depth: distinct results on same book with different budgets", () => {
    const baseOpts = {
      side:          "no" as const,
      bboAsk:        91,
      rawYesDollars: [yes(9, 500)], // NO-eq 91¢, depth at ≤92¢ (verifiedLimit)
      rawNoDollars:  [],
    };
    // With real budget → submit
    const rOk = pf({ ...baseOpts, betDollars: 100 });
    assert.equal(rOk.decision, "submit");

    // With zero budget → skip_zero_contracts (not skip_zero_depth)
    const rZero = pf({ ...baseOpts, betDollars: 0 });
    assert.equal(rZero.decision, "skip_zero_contracts");
    assert.notEqual(rZero.decision, "skip_zero_depth",
      "non-zero depth with zero budget must not report skip_zero_depth");

    // With empty book (no levels) → skip_zero_depth (book really is empty)
    const rEmpty = pf({ ...baseOpts, betDollars: 100, rawYesDollars: [] });
    assert.equal(rEmpty.decision, "skip_zero_depth");
  });
});

// ── Section 9: BBO-cap breach tests (three specific regression cases) ─────────

describe("computePreflightDecision — BBO-cap breach cases", () => {

  // Case 1: BBO 79¢, execAsk 92¢ → higher price is allowed inside the band.
  it("BBO 79 / execAsk 92 (gap +13): submit", () => {
    // YES buyer at 8¢ → NO-eq 92¢.
    const r = pf({
      side:          "no",
      bboAsk:        79,
      rawYesDollars: [yes(8, 200)], // NO-eq 92¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,        "submit");
    assert.equal(r.bboToL2GapCents, 13, "gap = 92 − 79 = +13¢");
    assert.equal(r.verifiedLimitCents, 93);
    assert.ok(r.adjustedContracts > 0);
  });

  // Case 2: BBO 80¢, execAsk 96¢ → hard ceiling rejects the fresh price.
  it("BBO 80 / execAsk 96 (gap +16): skip_executable_price_outside_band", () => {
    // YES buyer at 4¢ → NO-eq 96¢.
    const r = pf({
      side:          "no",
      bboAsk:        80,
      rawYesDollars: [yes(4, 200)], // NO-eq 96¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,        "skip_executable_price_outside_band");
    assert.equal(r.bboToL2GapCents, 16, "gap = 96 − 80 = +16¢");
    assert.equal(r.adjustedContracts, 0);
  });

  it("BBO 92 / execAsk 96 (gap +4): passes gap check → skip_executable_price_outside_band", () => {
    // YES buyer at 4¢ → NO-eq 96¢.
    const r = pf({
      side:          "no",
      bboAsk:        92,
      rawYesDollars: [yes(4, 200)], // NO-eq 96¢
      rawNoDollars:  [],
      betDollars:    BET,
    });
    assert.equal(r.decision,           "skip_executable_price_outside_band");
    assert.equal(r.bboToL2GapCents,    4);
    assert.equal(r.verifiedLimitCents, null, "gate stops before computing limit");
    assert.equal(r.adjustedContracts,  0);
  });
});

// ── Section 10: preflightInFlight lock helpers ─────────────────────────────────

describe("preflightInFlight lock helpers (state verified by checkAndPlace in production)", () => {
  // These tests verify the lock helper functions that checkAndPlace uses to
  // implement the pre-flight concurrency guard.  The pure computePreflightDecision
  // function does NOT interact with this lock — it is managed by checkAndPlace.
  // Tests here confirm the test-helper contract matches what checkAndPlace does.

  // Helpers imported at top of file: _forcePreflightInFlightForTesting,
  // _isPreflightInFlightForTesting, _clearPreflightInFlightForTesting,
  // _forceSubmissionInFlightForTesting, _isSubmissionInFlightForTesting,
  // preflightInFlight, submissionInFlight.

  const LOCK_TICKER = "KXBTC15M-LOCK-TEST";

  it("_forcePreflightInFlightForTesting sets the lock", () => {
    _forcePreflightInFlightForTesting(LOCK_TICKER);
    assert.ok(_isPreflightInFlightForTesting(LOCK_TICKER),
      "lock must be set after force");
  });

  it("_clearPreflightInFlightForTesting releases the lock", () => {
    _forcePreflightInFlightForTesting(LOCK_TICKER);
    _clearPreflightInFlightForTesting(LOCK_TICKER);
    assert.ok(!_isPreflightInFlightForTesting(LOCK_TICKER),
      "lock must be cleared after release");
  });

  it("preflightInFlight and submissionInFlight are independent locks", () => {
    _forcePreflightInFlightForTesting(LOCK_TICKER);
    assert.ok(!_isSubmissionInFlightForTesting(LOCK_TICKER),
      "submission lock is independent — preflight lock must not affect it");
    _forceSubmissionInFlightForTesting(LOCK_TICKER);
    assert.ok(_isPreflightInFlightForTesting(LOCK_TICKER),  "preflight still set");
    assert.ok(_isSubmissionInFlightForTesting(LOCK_TICKER), "submission also set");
  });

  it("checkAndPlace early guard pattern: either lock held → call would be blocked", () => {
    // Simulate the check that checkAndPlace performs synchronously before any await.
    // Two ticks arrive simultaneously; first sets preflightInFlight, second checks.
    // preflightInFlight and submissionInFlight are the same module-singleton Sets
    // that checkAndPlace reads at runtime.
    _forcePreflightInFlightForTesting(LOCK_TICKER);
    const wouldBeBlocked = preflightInFlight.has(LOCK_TICKER) || submissionInFlight.has(LOCK_TICKER);
    assert.ok(wouldBeBlocked,
      "concurrent tick would be blocked by the preflightInFlight guard");
  });

  it("_resetAutoTraderStateForTesting clears preflightInFlight lock", () => {
    _forcePreflightInFlightForTesting(LOCK_TICKER);
    _resetAutoTraderStateForTesting();
    assert.ok(!_isPreflightInFlightForTesting(LOCK_TICKER),
      "full state reset must clear preflight lock");
  });
});

// ── Section 12: Band and authorized-limit invariants ──────────────────────────

describe("computePreflightDecision — band and authorized-limit invariants", () => {
  it("an in-band L2 price above a lower authorized limit skips without submission", () => {
    const r = pf({
      side: "no", bboAsk: 91, betDollars: BET,
      rawYesDollars: [yes(9, 200)], // NO-eq 91¢
      rawNoDollars: [],
      bboDerivedLimitCents: 90,
    });
    assert.equal(r.decision, "skip_ask_above_strategy_limit");
    assert.equal(r.verifiedLimitCents, null);
  });

  it("every submitted result has an executable and submitted price inside 90–95¢", () => {
    for (const execAsk of [90, 91, 92, 93, 94, 95]) {
      const r = pf({
        side: "no", bboAsk: execAsk, betDollars: BET,
        rawYesDollars: [yes(100 - execAsk, 200)],
        rawNoDollars: [],
      });
      assert.equal(r.decision, "submit", `${execAsk}¢ is inclusive in the executable band`);
      assert.ok(r.verifiedLimitCents! >= execAsk);
      assert.ok(r.verifiedLimitCents! >= ALERT_MIN && r.verifiedLimitCents! <= ALERT_MAX);
    }
  });
});

// ── Section 7: Constants verification ────────────────────────────────────────

describe("preflightGate exported constants", () => {

  it("ALERT_MIN matches PRICE_FLOOR_CENTS (both 90¢)", () => {
    assert.equal(ALERT_MIN, PRICE_FLOOR_CENTS,
      "trigger and executable floors must match");
  });

  it("constants match the owner-approved 90–95¢ band", () => {
    assert.equal(ALERT_MIN, 90);
    assert.equal(ALERT_MAX, 95);
    assert.ok(ALERT_MAX > ALERT_MIN,                "ALERT_MAX must be > ALERT_MIN");
    assert.ok(MAX_BBO_L2_NEGATIVE_GAP_CENTS >= 5 && MAX_BBO_L2_NEGATIVE_GAP_CENTS <= 15,
      `MAX_BBO_L2_NEGATIVE_GAP_CENTS ${MAX_BBO_L2_NEGATIVE_GAP_CENTS} out of expected range`);
    assert.ok(LIMIT_PRICE_BUFFER_CENTS >= 0 && LIMIT_PRICE_BUFFER_CENTS <= 3,
      `LIMIT_PRICE_BUFFER_CENTS ${LIMIT_PRICE_BUFFER_CENTS} out of expected range`);
  });

  it("prices outside the executable band never submit through a floor clamp", () => {
    for (const execAsk of [68, 88, 96, 97]) {
      const r = pf({
        side: "no", bboAsk: execAsk, betDollars: BET,
        rawYesDollars: [yes(100 - execAsk, 200)],
        rawNoDollars: [],
      });
      assert.notEqual(r.decision, "submit", `${execAsk}¢ must not be floor- or cap-clamped into a submission`);
      assert.equal(r.verifiedLimitCents, null);
    }
  });
});
