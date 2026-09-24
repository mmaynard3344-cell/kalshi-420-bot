/**
 * L — Sweep/Reclaim V1.
 *
 * Pure, side-effect-free strategy helpers for a completed ETH 15-minute candle.
 * This module intentionally does not submit orders or touch production state.
 *
 * Live activation is fail-closed until every literal risk/execution setting
 * required by the authoritative strategy specification is configured.
 */

export const SWEEP_RECLAIM_STRATEGY_ID = "SWEEP_RECLAIM_V1" as const;
export const SWEEP_RECLAIM_SERVICE_CODE = "L" as const;
export const SWEEP_RECLAIM_DISPLAY_NAME = "L · Sweep/Reclaim" as const;
export const ETH_15M_MS = 15 * 60_000;
export const PRIOR_24H_CANDLES = 96;

export interface Eth15mCandle {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  finalized: boolean;
}

export type SweepReclaimSkipReason =
  | "source_not_final"
  | "source_not_15m"
  | "invalid_source_ohlc"
  | "invalid_prior_history"
  | "prior_history_not_contiguous"
  | "zero_range"
  | "did_not_sweep_prior_24h_low"
  | "lower_wick_smaller_than_body"
  | "close_below_midpoint";

export interface SweepReclaimEvidence {
  prior24hLow: number;
  range: number;
  body: number;
  lowerWick: number;
  midpoint: number;
  closePositionFraction: number;
  sweptPrevious24hLow: boolean;
  wickCondition: boolean;
  upperHalfClose: boolean;
}

export type SweepReclaimDecision =
  | {
      qualifies: true;
      side: "yes";
      strategyId: typeof SWEEP_RECLAIM_STRATEGY_ID;
      serviceCode: typeof SWEEP_RECLAIM_SERVICE_CODE;
      evidence: SweepReclaimEvidence;
    }
  | {
      qualifies: false;
      reason: SweepReclaimSkipReason;
      evidence?: SweepReclaimEvidence;
    };

function finiteOhlc(candle: Eth15mCandle): boolean {
  return [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    && candle.high >= candle.low
    && candle.open >= candle.low && candle.open <= candle.high
    && candle.close >= candle.low && candle.close <= candle.high;
}

function contiguous15m(history: readonly Eth15mCandle[], source: Eth15mCandle): boolean {
  if (history.length !== PRIOR_24H_CANDLES) return false;
  for (let i = 0; i < history.length; i++) {
    const candle = history[i]!;
    if (!candle.finalized || candle.closeTimeMs - candle.openTimeMs !== ETH_15M_MS) return false;
    if (i > 0 && candle.openTimeMs !== history[i - 1]!.closeTimeMs) return false;
  }
  return history[history.length - 1]!.closeTimeMs === source.openTimeMs;
}

/**
 * Evaluate L from a fully completed 15-minute candle.
 *
 * The supplied prior history is exactly the 96 completed candles immediately
 * preceding the source candle. This makes the prior-24h-low definition
 * explicit and look-ahead-safe.
 */
export function evaluateSweepReclaimV1(
  source: Eth15mCandle,
  prior96: readonly Eth15mCandle[],
): SweepReclaimDecision {
  if (!source.finalized) return { qualifies: false, reason: "source_not_final" };
  if (source.closeTimeMs - source.openTimeMs !== ETH_15M_MS) {
    return { qualifies: false, reason: "source_not_15m" };
  }
  if (!finiteOhlc(source)) return { qualifies: false, reason: "invalid_source_ohlc" };
  if (prior96.length !== PRIOR_24H_CANDLES || prior96.some((c) => !finiteOhlc(c))) {
    return { qualifies: false, reason: "invalid_prior_history" };
  }
  if (!contiguous15m(prior96, source)) {
    return { qualifies: false, reason: "prior_history_not_contiguous" };
  }

  const range = source.high - source.low;
  if (range <= 0) return { qualifies: false, reason: "zero_range" };

  const prior24hLow = Math.min(...prior96.map((c) => c.low));
  const body = Math.abs(source.close - source.open);
  const lowerWick = Math.min(source.open, source.close) - source.low;
  const midpoint = source.low + range / 2;
  const closePositionFraction = (source.close - source.low) / range;
  const sweptPrevious24hLow = source.low <= prior24hLow;
  const wickCondition = lowerWick >= body;
  const upperHalfClose = source.close >= midpoint;

  const evidence: SweepReclaimEvidence = {
    prior24hLow,
    range,
    body,
    lowerWick,
    midpoint,
    closePositionFraction,
    sweptPrevious24hLow,
    wickCondition,
    upperHalfClose,
  };

  if (!sweptPrevious24hLow) {
    return { qualifies: false, reason: "did_not_sweep_prior_24h_low", evidence };
  }
  if (!wickCondition) {
    return { qualifies: false, reason: "lower_wick_smaller_than_body", evidence };
  }
  if (!upperHalfClose) {
    return { qualifies: false, reason: "close_below_midpoint", evidence };
  }

  return {
    qualifies: true,
    side: "yes",
    strategyId: SWEEP_RECLAIM_STRATEGY_ID,
    serviceCode: SWEEP_RECLAIM_SERVICE_CODE,
    evidence,
  };
}

export function isImmediateFollowingEth15mWindow(
  source: Eth15mCandle,
  destinationOpenTimeMs: number,
  destinationCloseTimeMs: number,
): boolean {
  return source.finalized
    && destinationOpenTimeMs === source.closeTimeMs
    && destinationCloseTimeMs - destinationOpenTimeMs === ETH_15M_MS;
}

export interface SweepReclaimRuntimeConfig {
  enabled: boolean;
  liveExecutionEnabled: boolean;
  maxEntryPriceCents: number | null;
  stakeCents: number | null;
  sharedCorrelatedExposureCapCents: number | null;
  minimumSecondsRemaining: number | null;
  orderType: string | null;
  activationReady: boolean;
  unresolved: string[];
}

function positiveIntEnv(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key];
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Fail-closed config loader. No numeric/order defaults are invented here.
 */
export function loadSweepReclaimRuntimeConfig(env: NodeJS.ProcessEnv = process.env): SweepReclaimRuntimeConfig {
  const enabled = env["L_SWEEP_RECLAIM_ENABLED"] === "true";
  const liveExecutionEnabled = env["L_SWEEP_RECLAIM_LIVE_EXECUTION_ENABLED"] === "true";
  const maxEntryPriceCents = positiveIntEnv(env, "L_SWEEP_RECLAIM_MAX_ENTRY_PRICE_CENTS");
  const stakeCents = positiveIntEnv(env, "L_SWEEP_RECLAIM_STAKE_CENTS");
  const sharedCorrelatedExposureCapCents = positiveIntEnv(env, "ETH_LONG_REVERSAL_SHARED_CAP_CENTS");
  const minimumSecondsRemaining = positiveIntEnv(env, "L_SWEEP_RECLAIM_MIN_SECONDS_REMAINING");
  const orderType = env["L_SWEEP_RECLAIM_ORDER_TYPE"]?.trim() || null;

  const unresolved: string[] = [];
  if (maxEntryPriceCents == null) unresolved.push("max_entry_price_cents");
  if (stakeCents == null) unresolved.push("stake_cents");
  if (sharedCorrelatedExposureCapCents == null) unresolved.push("shared_correlated_exposure_cap_cents");
  if (minimumSecondsRemaining == null) unresolved.push("minimum_seconds_remaining");
  if (orderType == null) unresolved.push("order_type");

  return {
    enabled,
    liveExecutionEnabled,
    maxEntryPriceCents,
    stakeCents,
    sharedCorrelatedExposureCapCents,
    minimumSecondsRemaining,
    orderType,
    activationReady: enabled && unresolved.length === 0,
    unresolved,
  };
}

export interface CorrelatedExposureAssessment {
  allowed: boolean;
  currentExposureCents: number;
  proposedExposureCents: number;
  capCents: number;
  postTradeExposureCents: number;
}

/**
 * Pure arithmetic used by the eventual transactional admission path.
 * Exactly-at-cap is allowed; one cent over is rejected.
 */
export function assessLongReversalExposure(
  currentExposureCents: number,
  proposedExposureCents: number,
  capCents: number,
): CorrelatedExposureAssessment {
  const postTradeExposureCents = currentExposureCents + proposedExposureCents;
  return {
    allowed: Number.isFinite(currentExposureCents)
      && Number.isFinite(proposedExposureCents)
      && Number.isFinite(capCents)
      && currentExposureCents >= 0
      && proposedExposureCents > 0
      && capCents > 0
      && postTradeExposureCents <= capCents,
    currentExposureCents,
    proposedExposureCents,
    capCents,
    postTradeExposureCents,
  };
}
