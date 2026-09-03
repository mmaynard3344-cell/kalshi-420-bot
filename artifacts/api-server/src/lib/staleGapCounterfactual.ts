/**
 * Pure inputs and calculations for future stale-BBO counterfactual analytics.
 *
 * This module is deliberately inert: it has no environment reads, I/O, queues,
 * persistence, timers, network access, or live-trading imports. It accepts
 * snapshots by value and returns a new result without mutating any input.
 */

import { PRICE_CAP_CENTS, PRICE_FLOOR_CENTS, contractsForPrice } from "./autoTraderGuards.js";
import { LIMIT_PRICE_BUFFER_CENTS } from "./preflightGate.js";
import { computeSnapshotFields, type L2Level } from "./orderbookParsing.js";

export type CounterfactualSide = "yes" | "no";

/** Immutable market, strategy, and hypothetical guard state at one evaluation. */
export interface StaleGapCounterfactualInput {
  side: CounterfactualSide;
  /** BBO-derived strategy limit before L2 verification. */
  bboDerivedLimitCents: number | null;
  /** Immutable outcome-side counterparty levels, already normalized to cents. */
  l2Levels: readonly Readonly<L2Level>[];
  strategy: Readonly<{
    betDollars: number;
    priceFloorCents?: number;
    priceCapCents?: number;
    limitPriceBufferCents?: number;
  }>;
  budget: Readonly<{
    /** Remaining per-window dollars before a hypothetical order. */
    windowRemainingDollars: number;
    /** Remaining daily notional cents before a hypothetical order. */
    dailyRemainingNotionalCents: number;
  }>;
  exposure: Readonly<{
    /** Existing signed contracts: positive YES, negative NO. */
    signedContracts: number;
    /** Optional absolute position ceiling for the candidate side. */
    maxAbsoluteContracts?: number | null;
  }>;
}

export type CounterfactualEligibility =
  | "eligible"
  | "invalid_input"
  | "no_executable_depth"
  | "strategy_limit_exceeded"
  | "window_budget_exhausted"
  | "daily_cap_exhausted"
  | "position_rejected"
  | "exposure_limit_rejected";

export interface StaleGapCounterfactualResult {
  side: CounterfactualSide;
  intendedLimitCents: number | null;
  intendedContracts: number;
  executableBestAskCents: number | null;
  hypotheticalLimitCents: number | null;
  executableDepthContracts: number;
  executableDepthDollars: number;
  liquidityAdjustedContracts: number;
  finalHypotheticalContracts: number;
  finalHypotheticalNotionalCents: number;
  eligibility: CounterfactualEligibility;
  budgetEligible: boolean;
  exposureEligible: boolean;
  positionEligible: boolean;
}

const EMPTY_RESULT: Omit<StaleGapCounterfactualResult, "side" | "eligibility"> = {
  intendedLimitCents: null,
  intendedContracts: 0,
  executableBestAskCents: null,
  hypotheticalLimitCents: null,
  executableDepthContracts: 0,
  executableDepthDollars: 0,
  liquidityAdjustedContracts: 0,
  finalHypotheticalContracts: 0,
  finalHypotheticalNotionalCents: 0,
  budgetEligible: false,
  exposureEligible: false,
  positionEligible: false,
};

function validCents(value: number | null | undefined): value is number {
  return value != null && Number.isInteger(value) && value > 0 && value < 100;
}

function validNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Computes a passive, hypothetical post-stale preflight result.
 *
 * It intentionally does not claim a live dedup slot, reserve a budget, mutate a
 * position, or interact with any order-submission path. Guard inputs are
 * read-only snapshots supplied by a future passive caller.
 */
export function calculateStaleGapCounterfactual(
  input: Readonly<StaleGapCounterfactualInput>,
): StaleGapCounterfactualResult {
  const { side, bboDerivedLimitCents, strategy, budget, exposure } = input;
  const priceFloorCents = strategy.priceFloorCents ?? PRICE_FLOOR_CENTS;
  const priceCapCents = strategy.priceCapCents ?? PRICE_CAP_CENTS;
  const limitBufferCents = strategy.limitPriceBufferCents ?? LIMIT_PRICE_BUFFER_CENTS;

  if (
    !validCents(bboDerivedLimitCents) ||
    !validCents(priceFloorCents) ||
    !validCents(priceCapCents) ||
    priceFloorCents > priceCapCents ||
    !Number.isInteger(limitBufferCents) ||
    limitBufferCents < 0 ||
    !validNonNegativeFinite(strategy.betDollars) ||
    !validNonNegativeFinite(budget.windowRemainingDollars) ||
    !validNonNegativeFinite(budget.dailyRemainingNotionalCents) ||
    !Number.isInteger(exposure.signedContracts) ||
    (exposure.maxAbsoluteContracts != null &&
      (!Number.isInteger(exposure.maxAbsoluteContracts) || exposure.maxAbsoluteContracts < 0))
  ) {
    return { side, eligibility: "invalid_input", ...EMPTY_RESULT };
  }

  const levels = input.l2Levels
    .filter((level) =>
      validCents(level.priceCents) &&
      validNonNegativeFinite(level.notionalDollars) &&
      Number.isInteger(level.contractsApprox) &&
      level.contractsApprox >= 0,
    )
    .map((level) => ({ ...level }));

  if (levels.length === 0) {
    return { side, eligibility: "no_executable_depth", ...EMPTY_RESULT };
  }

  const executableBestAskCents = Math.min(...levels.map((level) => level.priceCents));
  const authorizedLimitCents = Math.min(bboDerivedLimitCents, priceCapCents, 99);
  const intendedLimitCents = authorizedLimitCents;
  const intendedContracts = contractsForPrice(
    intendedLimitCents,
    Math.min(strategy.betDollars, budget.windowRemainingDollars),
  );

  if (executableBestAskCents > authorizedLimitCents) {
    return {
      side,
      eligibility: "strategy_limit_exceeded",
      ...EMPTY_RESULT,
      intendedLimitCents,
      intendedContracts,
      executableBestAskCents,
    };
  }

  const hypotheticalLimitCents = Math.min(
    Math.max(executableBestAskCents + limitBufferCents, priceFloorCents),
    authorizedLimitCents,
  );
  const depth = computeSnapshotFields(levels, hypotheticalLimitCents);
  const liquidityAdjustedContracts = Math.min(intendedContracts, depth.depthAtOrBetterContracts);

  if (depth.depthAtOrBetterContracts === 0) {
    return {
      side,
      eligibility: "no_executable_depth",
      ...EMPTY_RESULT,
      intendedLimitCents,
      intendedContracts,
      executableBestAskCents,
      hypotheticalLimitCents,
      executableDepthContracts: depth.depthAtOrBetterContracts,
      executableDepthDollars: depth.depthAtOrBetterDollars,
    };
  }

  const notionalCents = liquidityAdjustedContracts * hypotheticalLimitCents;
  const positionWouldClose =
    (side === "yes" && exposure.signedContracts < 0) ||
    (side === "no" && exposure.signedContracts > 0);
  if (positionWouldClose) {
    return {
      side,
      eligibility: "position_rejected",
      ...EMPTY_RESULT,
      intendedLimitCents,
      intendedContracts,
      executableBestAskCents,
      hypotheticalLimitCents,
      executableDepthContracts: depth.depthAtOrBetterContracts,
      executableDepthDollars: depth.depthAtOrBetterDollars,
      liquidityAdjustedContracts,
    };
  }

  const signedDelta = side === "yes" ? liquidityAdjustedContracts : -liquidityAdjustedContracts;
  const exposureEligible =
    exposure.maxAbsoluteContracts == null ||
    Math.abs(exposure.signedContracts + signedDelta) <= exposure.maxAbsoluteContracts;
  if (!exposureEligible) {
    return {
      side,
      eligibility: "exposure_limit_rejected",
      ...EMPTY_RESULT,
      intendedLimitCents,
      intendedContracts,
      executableBestAskCents,
      hypotheticalLimitCents,
      executableDepthContracts: depth.depthAtOrBetterContracts,
      executableDepthDollars: depth.depthAtOrBetterDollars,
      liquidityAdjustedContracts,
      positionEligible: true,
    };
  }

  if (budget.windowRemainingDollars <= 0) {
    return {
      side,
      eligibility: "window_budget_exhausted",
      ...EMPTY_RESULT,
      intendedLimitCents,
      intendedContracts,
      executableBestAskCents,
      hypotheticalLimitCents,
      executableDepthContracts: depth.depthAtOrBetterContracts,
      executableDepthDollars: depth.depthAtOrBetterDollars,
      liquidityAdjustedContracts,
      positionEligible: true,
      exposureEligible: true,
    };
  }

  if (notionalCents > budget.dailyRemainingNotionalCents) {
    return {
      side,
      eligibility: "daily_cap_exhausted",
      ...EMPTY_RESULT,
      intendedLimitCents,
      intendedContracts,
      executableBestAskCents,
      hypotheticalLimitCents,
      executableDepthContracts: depth.depthAtOrBetterContracts,
      executableDepthDollars: depth.depthAtOrBetterDollars,
      liquidityAdjustedContracts,
      positionEligible: true,
      exposureEligible: true,
    };
  }

  return {
    side,
    intendedLimitCents,
    intendedContracts,
    executableBestAskCents,
    hypotheticalLimitCents,
    executableDepthContracts: depth.depthAtOrBetterContracts,
    executableDepthDollars: depth.depthAtOrBetterDollars,
    liquidityAdjustedContracts,
    finalHypotheticalContracts: liquidityAdjustedContracts,
    finalHypotheticalNotionalCents: notionalCents,
    eligibility: "eligible",
    budgetEligible: true,
    exposureEligible: true,
    positionEligible: true,
  };
}