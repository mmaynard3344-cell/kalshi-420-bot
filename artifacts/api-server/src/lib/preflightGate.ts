/**
 * preflightGate.ts — pure pre-flight gate logic, no I/O, no pino.
 *
 * Isolated here (pino-free) so tests can import and exercise the gate in
 * isolation without pulling in the logger dependency chain.
 *
 * autoTrader.ts imports the constants and computePreflightDecision from here,
 * then wraps the result with logging and SQL persistence side-effects.
 *
 * ── Strategy-ceiling enforcement ─────────────────────────────────────────────
 * The gate receives `bboDerivedLimitCents` — the maximum price the strategy is
 * willing to pay, computed by evaluate() BEFORE checkAndPlace is called as:
 *
 *   limitPrice = Math.min(derivedAsk + LIMIT_PRICE_BUFFER_CENTS, ALERT_MAX, 99)
 *
 * The gate MUST NOT submit above this price.  If the best executable ask
 * (execAsk) exceeds the authorized limit, the order cannot fill and the gate
 * skips with `skip_ask_above_strategy_limit` — a distinct reason from
 * `skip_stale_bbo_gap` because the gap check may have passed (the data is
 * fresh and the market has simply moved above the strategy-authorized ceiling).
 *
 * ── Two-stage price-band enforcement ─────────────────────────────────────────
 * ALERT_MIN (= PRICE_FLOOR_CENTS = 80¢):
 *   Signal filter — the BBO-derived ask must be ≥ ALERT_MIN for checkAndPlace
 *   to be called at all.
 *
 * Fresh executable L2 price:
 *   After the trigger, the selected-side executable L2 price must ALSO be
 *   inside the inclusive [PRICE_FLOOR_CENTS, PRICE_CAP_CENTS] band. A fresh
 *   price outside the band is a skip, not an opportunity to clamp the limit
 *   back into range.
 *
 * ── Falling-knife guard ───────────────────────────────────────────────────────
 * A positive move (execAsk > bboAsk) is explicitly allowed — price improvement
 * toward the seller is acceptable as long as it stays within the 80–92¢ band.
 *
 * A negative move ≥ MAX_BBO_L2_NEGATIVE_GAP_CENTS (10¢) is blocked:
 *   if execAsk ≤ bboAsk − 10  →  skip_stale_bbo_gap ("falling knife")
 * Example: trigger 92¢ → L2 executable 82¢ → gap −10 → BLOCKED.
 *          trigger 88¢ → L2 executable 80¢ → gap −8  → ALLOWED (still in band).
 *
 * The boundary is inclusive: a 10¢ drop is enough to block.
 *
 * ── Proof that verifiedLimit ≥ execAsk ───────────────────────────────────────
 * After the skip_ask_above_strategy_limit guard:
 *   • execAsk ≤ authorizedLimit                       (guard ensures this)
 *   • desiredLimit = max(execAsk + 1, floor) ≥ execAsk + 1 > execAsk
 *   • verifiedLimit = min(desiredLimit, authorizedLimit)
 *                   ≥ min(execAsk+1, execAsk) = execAsk
 * Therefore an IOC buy at verifiedLimit CAN execute against execAsk.
 *
 * ── Migration note ───────────────────────────────────────────────────────────
 * The `skip_price_band` decision value has been removed.  Analytics or queries
 * that filter on `skip_price_band` should also include
 * `skip_ask_above_strategy_limit` (the functional replacement) in their filter.
 */

import {
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  ALERT_MIN,
  ALERT_MAX,
  contractsForPrice,
  isEntryPriceInBandForSeries,
  type TrackedSeries,
} from "./autoTraderGuards.js";
import { parseOrderbookResponse, computeSnapshotFields } from "./orderbookParsing.js";

// ── Pre-flight gate constants ──────────────────────────────────────────────────
//
// Exported here (pino-free) so computePreflightDecision and gate-level tests
// can reference them without pulling in autoTrader.ts.

// OWNER-LOCKED: ALERT_MIN / ALERT_MAX are canonically defined in
// autoTraderGuards.ts (see the owner-lock banner there). Re-exported here so
// existing import sites keep working. Do NOT redefine them here.
export { ALERT_MIN, ALERT_MAX };

/**
 * Retained for analytics continuity (performance reports, phase-4b captures).
 * No longer used in the gate logic — positive BBO-to-L2 gaps are now allowed.
 * The gate previously blocked when execAsk > bboAsk + MAX_BBO_L2_GAP_CENTS;
 * that check was removed in favour of the one-sided falling-knife guard below.
 */
export const MAX_BBO_L2_GAP_CENTS = 2;

/**
 * Maximum difference between a side's direct BBO ask and its complementary,
 * opposite-bid-derived ask before treating the merged WS snapshot as incoherent.
 *
 * Kalshi streams YES and NO BBO fields independently.  A merged snapshot can
 * therefore briefly contain a newly-updated YES ask alongside a stale NO bid
 * (or the reverse).  The derived signal is useful only when those two
 * representations agree closely enough to describe the same market moment.
 *
 * This is a signal-quality check only: it does not change the owner-locked
 * 80–92¢ entry band, price buffer, sizing, or the mandatory L2 execution gate.
 */
export const MAX_DIRECT_DERIVED_BBO_GAP_CENTS = 2;

/** True only when the direct-side ask and complementary derived ask are coherent. */
export function isCoherentBboQuote(
  directAsk: number | null,
  derivedAsk: number | null,
): boolean {
  return directAsk != null &&
    derivedAsk != null &&
    Math.abs(directAsk - derivedAsk) <= MAX_DIRECT_DERIVED_BBO_GAP_CENTS;
}

/**
 * Falling-knife guard threshold (¢).
 *
 * An order is blocked when the fresh executable L2 ask is this many cents
 * BELOW the BBO-derived trigger price.  The check is INCLUSIVE: a drop of
 * exactly MAX_BBO_L2_NEGATIVE_GAP_CENTS is blocked.
 *
 *   gap = execAsk − bboAsk
 *   if gap <= −MAX_BBO_L2_NEGATIVE_GAP_CENTS  →  skip_stale_bbo_gap
 *
 * Example: trigger (bboAsk) 92¢ → L2 executable 82¢ → gap = −10 → BLOCKED.
 *          trigger 88¢ → L2 executable 80¢ → gap = −8 → ALLOWED.
 *
 * A positive move (execAsk > bboAsk) is explicitly allowed as long as the
 * executable price remains within the 80–92¢ band.
 *
 * `bboAsk` is the DERIVED opposite-bid reference (100−noBid for YES;
 * 100−yesBid for NO), matching the price basis of bboDerivedLimitCents.
 */
export const MAX_BBO_L2_NEGATIVE_GAP_CENTS = 10;

/**
 * Cents added to the executable ask to form the desired limit price.
 * 1¢ = one cent of price-improvement tolerance: we accept filling at asks up to
 * 1¢ above the L2 best, giving a marginally higher fill rate on thin books.
 * The final submitted limit is always capped at bboDerivedLimitCents (strategy
 * ceiling) and floored at PRICE_FLOOR_CENTS.
 */
export const LIMIT_PRICE_BUFFER_CENTS = 1;

/**
 * Maximum allowed BBO bid–ask spread (¢) for the entry side.
 * If the spread exceeds this at signal time, the entry is skipped as a
 * potential "knife falling" warning — market makers stepping back is an
 * early reversal signal before the L2 book goes thin.
 * Skip reason: "wide_spread".
 *
 * Threshold raised to 3¢ on 2026-08-02 after live observation: the 3:30 PM ET
 * ETH NO window had a 3¢ spread (83/86) that was blocked under the old 1¢ limit.
 * At $10 bets a 3¢ spread costs ~15¢ in adverse selection — acceptable.
 *
 * Comparison is STRICTLY GREATER THAN: spreadCents > MAX_SPREAD_CENTS.
 *   2¢ spread → 2 > 3 = false → allowed
 *   3¢ spread → 3 > 3 = false → allowed   ← boundary passes
 *   4¢ spread → 4 > 3 = true  → blocked
 */
export const MAX_SPREAD_CENTS = 3;

// ── Pre-flight result ─────────────────────────────────────────────────────────

export type PreflightDecision =
  | "submit"
  | "skip_zero_depth"                 // book empty, OR depth at limit rounds to 0 contracts
  | "skip_zero_contracts"             // depth exists at limit but budget too small
  | "skip_stale_bbo_gap"              // BBO-to-L2 price gap exceeds threshold
  | "skip_executable_price_outside_band" // fresh selected-side L2 price is outside [80¢, 92¢]
  | "skip_ask_above_strategy_limit";  // execAsk > strategy-authorized limit (replaces skip_price_band)
  //
  // NOTE: "skip_price_band" has been removed.  See migration note in module doc.

export interface PreflightResult {
  decision:               PreflightDecision;
  /** Minimum outcome-side price across all counterparty levels.  null = empty book. */
  executableBestAskCents: number | null;
  /** execAsk − bboAsk (null if bboAsk was null, treated as 0 in gap check). */
  bboToL2GapCents:        number | null;
  /** Submitted limit price after buffer + floor clamp + strategy cap.  null = gate blocked before this step. */
  verifiedLimitCents:     number | null;
  /** Contracts to request (min of intended-from-budget and available depth). */
  adjustedContracts:      number;
  /** Total notional dollars at-or-better than verifiedLimit. */
  depthAtLimitDollars:    number;
  /** Total contracts at-or-better than verifiedLimit. */
  depthAtLimitContracts:  number;
}

// ── Pure gate computation ─────────────────────────────────────────────────────

/**
 * Compute the pre-flight gate decision without any I/O or logging.
 *
 * Decision hierarchy (first matching rule wins):
 *   skip_zero_depth                — book has no counterparty levels at all
 *   skip_stale_bbo_gap             — execAsk is at least 10¢ below bboAsk
 *                                    (one-sided falling-knife protection)
 *   skip_executable_price_outside_band — fresh selected-side execAsk is outside the
 *                                    inclusive hard trading band
 *   skip_ask_above_strategy_limit  — execAsk > authorizedLimit (order cannot fill at
 *                                    the strategy-authorized price; NOT a staleness signal)
 *   skip_zero_depth                — depth at verifiedLimit rounds to 0 whole contracts
 *   skip_zero_contracts            — depth exists but budget too small for 1 contract
 *   submit                         — all checks passed
 *
 * Strategy-ceiling enforcement:
 *   authorizedLimit = min(bboDerivedLimitCents, PRICE_CAP_CENTS, 99)
 *   if execAsk > authorizedLimit  →  skip_ask_above_strategy_limit
 *   desiredLimit  = execAsk + LIMIT_PRICE_BUFFER_CENTS
 *   verifiedLimit = min(desiredLimit, authorizedLimit)
 *
 *   The gate NEVER submits above bboDerivedLimitCents.
 *   When execAsk ≤ authorizedLimit, verifiedLimit ≥ execAsk always (proven in header).
 *
 * @param opts.side                 "yes" or "no" — which side we are buying
 * @param opts.bboAsk               Quoted BBO ask for this side in ¢ (null = unavailable)
 * @param opts.rawYesDollars        Kalshi orderbook_fp.yes_dollars raw entries
 * @param opts.rawNoDollars         Kalshi orderbook_fp.no_dollars raw entries
 * @param opts.betDollars           Per-window budget in dollars (used to size contracts)
 * @param opts.bboDerivedLimitCents Maximum price the strategy authorizes for this order.
 *                                  Computed by evaluate() as min(derivedAsk + 1, ALERT_MAX, 99).
 *                                  The gate must not submit above this value.
 */
export function computePreflightDecision(opts: {
  /** Asset-specific entry policy is checked in addition to the global 80–92¢ guard. */
  series:               TrackedSeries;
  side:                 "yes" | "no";
  bboAsk:               number | null;
  rawYesDollars:        [string, string][];
  rawNoDollars:         [string, string][];
  betDollars:           number;
  bboDerivedLimitCents: number;
}): PreflightResult {
  const { series, side, bboAsk, rawYesDollars, rawNoDollars, betDollars, bboDerivedLimitCents } = opts;

  // ── 1. Parse counterparty levels (single pass) ────────────────────────────
  const levels = parseOrderbookResponse(
    { orderbook_fp: { yes_dollars: rawYesDollars, no_dollars: rawNoDollars } },
    side,
  );

  // ── 2. Empty book ─────────────────────────────────────────────────────────
  if (levels.length === 0) {
    return {
      decision: "skip_zero_depth",
      executableBestAskCents: null, bboToL2GapCents: null, verifiedLimitCents: null,
      adjustedContracts: 0, depthAtLimitDollars: 0, depthAtLimitContracts: 0,
    };
  }

  // ── 3. Executable best ask — minimum price across all counterparty levels ─
  const execAsk = Math.min(...levels.map((l) => l.priceCents));

  // ── 4. One-sided falling-knife check ──────────────────────────────────────
  // A higher fresh executable price is allowed when it remains in the hard
  // trading band and within the strategy-authorized limit below.  Reject only
  // a sharp downward move from the trigger/reference price. This runs before
  // the hard band check so a 92¢ → 82¢ fall retains its safety classification.
  const gap = bboAsk != null ? execAsk - bboAsk : 0;
  if (gap <= -MAX_BBO_L2_NEGATIVE_GAP_CENTS) {
    return {
      decision: "skip_stale_bbo_gap",
      executableBestAskCents: execAsk, bboToL2GapCents: gap, verifiedLimitCents: null,
      adjustedContracts: 0, depthAtLimitDollars: 0, depthAtLimitContracts: 0,
    };
  }

  // ── 5a. Fresh executable price must remain in the owner-approved band ─────
  // A valid trigger alone is insufficient. The selected-side price we could
  // actually execute against must still be in [80¢, 92¢]. This intentionally
  // rejects apparent price improvement below the floor.
  if (!isEntryPriceInBandForSeries(series, execAsk)) {
    return {
      decision: "skip_executable_price_outside_band",
      executableBestAskCents: execAsk, bboToL2GapCents: gap, verifiedLimitCents: null,
      adjustedContracts: 0, depthAtLimitDollars: 0, depthAtLimitContracts: 0,
    };
  }

  // ── 5b. Authorized limit (strategy ceiling) ───────────────────────────────
  // The evaluate() function computed bboDerivedLimitCents = min(derivedAsk + 1,
  // ALERT_MAX, 99) before calling checkAndPlace.  The gate must never submit
  // above this price — doing so would exceed what the strategy authorized.
  const authorizedLimit = Math.min(bboDerivedLimitCents, PRICE_CAP_CENTS, 99);

  // ── 5c. Reject if execAsk exceeds authorized limit ────────────────────────
  // An IOC buy at authorizedLimit cannot execute against an ask of execAsk where
  // execAsk > authorizedLimit — the counterparty would not cross.
  //
  // Distinct from skip_stale_bbo_gap: the gap check may have passed (data is fresh,
  // market is accurately quoted) — the market has simply moved above the strategy
  // ceiling.  Logging this separately lets callers distinguish "stale data" from
  // "market moved past our authorized price".
  if (execAsk > authorizedLimit) {
    return {
      decision: "skip_ask_above_strategy_limit",
      executableBestAskCents: execAsk, bboToL2GapCents: gap, verifiedLimitCents: null,
      adjustedContracts: 0, depthAtLimitDollars: 0, depthAtLimitContracts: 0,
    };
  }

  // ── 5d. Desired execution limit ───────────────────────────────────────────
  // The executable price has already passed the inclusive 80–92¢ check. Add
  // the small buffer, then cap at the strategy-authorized limit so the submitted
  // price never exceeds what the strategy authorized.
  //
  // Invariant (proven in header): verifiedLimit ≥ execAsk when execAsk ≤ authorizedLimit.
  const desiredLimit  = execAsk + LIMIT_PRICE_BUFFER_CENTS;
  const verifiedLimit = Math.min(desiredLimit, authorizedLimit);

  // ── 6. Depth at verified limit ────────────────────────────────────────────
  const depth = computeSnapshotFields(levels, verifiedLimit);

  // ── 7. Contract sizing ────────────────────────────────────────────────────
  // intendedContracts: how many the budget allows at verifiedLimit.
  // adjustedContracts: capped by available counterparty depth.
  const intendedContracts = contractsForPrice(verifiedLimit, betDollars);
  const adjustedContracts = Math.min(intendedContracts, depth.depthAtOrBetterContracts);

  // ── 8. Zero-contract discrimination ──────────────────────────────────────
  // Distinguishes the reason adjustedContracts reached zero:
  //
  //   skip_zero_depth     — no counterparty levels exist at-or-better than the
  //                         verified limit (or they round to 0 whole contracts).
  //
  //   skip_zero_contracts — depth EXISTS at the limit but the budget is too
  //                         small to buy even one contract.  Logging separately
  //                         prevents confusing "no depth" with "not enough budget".
  let decision: PreflightDecision;
  if (depth.depthAtOrBetterContracts === 0) {
    decision = "skip_zero_depth";       // no counterparty supply at limit
  } else if (adjustedContracts === 0) {
    decision = "skip_zero_contracts";   // supply exists, budget too small
  } else {
    decision = "submit";
  }

  return {
    decision,
    executableBestAskCents: execAsk,
    bboToL2GapCents:        gap,
    verifiedLimitCents:     verifiedLimit,
    adjustedContracts,
    depthAtLimitDollars:    depth.depthAtOrBetterDollars,
    depthAtLimitContracts:  depth.depthAtOrBetterContracts,
  };
}
