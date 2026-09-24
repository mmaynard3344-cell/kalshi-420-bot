export const A2_BASELINE_REVERSION_STRATEGY_ID = "a2_baseline_reversion" as const;
export const A2_BASELINE_REVERSION_DISPLAY_NAME = "A2 · Baseline Reversion" as const;
export const A2_SERIES = "KXBTC15M" as const;
export const A2_INTERVAL_MS = 15 * 60_000;
export const A2_DROP_THRESHOLD = 0.008;
export const A2_FIXED_STAKE_CENTS = 500;
export const A2_MAX_ENTRY_PRICE_CENTS = 45;
export const A2_MAX_ACTIVE_EXPOSURES = 1;

export interface A2BtcCandle {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  finalized: boolean;
}

export interface A2DestinationMarket {
  ticker: string;
  openTimeMs: number;
  closeTimeMs: number;
  yesAskCents: number | null;
  yesSettlesAboveStrike: boolean;
}

export type A2BaselineReversionReason =
  | "disabled"
  | "invalid_source"
  | "source_not_final"
  | "source_not_15m"
  | "drop_below_threshold"
  | "invalid_destination"
  | "not_immediate_following_window"
  | "yes_semantics_unverified"
  | "entry_price_unavailable"
  | "entry_price_above_cap"
  | "active_exposure_limit";

export type A2BaselineReversionDecision =
  | {
      signal: true;
      strategyId: typeof A2_BASELINE_REVERSION_STRATEGY_ID;
      side: "yes";
      ticker: string;
      stakeCents: typeof A2_FIXED_STAKE_CENTS;
      maxEntryPriceCents: typeof A2_MAX_ENTRY_PRICE_CENTS;
      sourceDropFraction: number;
    }
  | {
      signal: false;
      reason: A2BaselineReversionReason;
      sourceDropFraction?: number;
    };

export interface A2BaselineReversionConfig {
  enabled: boolean;
}

export function loadA2BaselineReversionConfig(
  env: NodeJS.ProcessEnv = process.env,
): A2BaselineReversionConfig {
  return {
    enabled: env["A2_BASELINE_REVERSION_ENABLED"] === "true",
  };
}

function validCandle(c: A2BtcCandle): boolean {
  return Number.isSafeInteger(c.openTimeMs)
    && Number.isSafeInteger(c.closeTimeMs)
    && [c.open, c.high, c.low, c.close].every(Number.isFinite)
    && c.open > 0
    && c.high >= c.low
    && c.open >= c.low && c.open <= c.high
    && c.close >= c.low && c.close <= c.high;
}

function validDestination(m: A2DestinationMarket): boolean {
  return /^KXBTC15M-/.test(m.ticker)
    && Number.isSafeInteger(m.openTimeMs)
    && Number.isSafeInteger(m.closeTimeMs)
    && m.closeTimeMs - m.openTimeMs === A2_INTERVAL_MS;
}

export function evaluateA2BaselineReversion(input: {
  config: A2BaselineReversionConfig;
  source: A2BtcCandle;
  destination: A2DestinationMarket;
  activeA2ExposureCount: number;
}): A2BaselineReversionDecision {
  if (!input.config.enabled) return { signal: false, reason: "disabled" };
  if (!validCandle(input.source)) return { signal: false, reason: "invalid_source" };
  if (!input.source.finalized) return { signal: false, reason: "source_not_final" };
  if (input.source.closeTimeMs - input.source.openTimeMs !== A2_INTERVAL_MS) {
    return { signal: false, reason: "source_not_15m" };
  }

  const sourceDropFraction = (input.source.open - input.source.close) / input.source.open;
  const thresholdClose = input.source.open * (1 - A2_DROP_THRESHOLD);
  const numericTolerance = Math.max(1, Math.abs(input.source.open)) * 1e-12;
  if (!Number.isFinite(sourceDropFraction)
    || input.source.close > thresholdClose + numericTolerance) {
    return { signal: false, reason: "drop_below_threshold", sourceDropFraction };
  }

  if (!validDestination(input.destination)) {
    return { signal: false, reason: "invalid_destination", sourceDropFraction };
  }
  if (input.destination.openTimeMs !== input.source.closeTimeMs) {
    return { signal: false, reason: "not_immediate_following_window", sourceDropFraction };
  }
  if (!input.destination.yesSettlesAboveStrike) {
    return { signal: false, reason: "yes_semantics_unverified", sourceDropFraction };
  }

  const ask = input.destination.yesAskCents;
  if (!Number.isInteger(ask) || ask == null || ask < 1 || ask > 99) {
    return { signal: false, reason: "entry_price_unavailable", sourceDropFraction };
  }
  if (ask > A2_MAX_ENTRY_PRICE_CENTS) {
    return { signal: false, reason: "entry_price_above_cap", sourceDropFraction };
  }

  if (!Number.isInteger(input.activeA2ExposureCount)
    || input.activeA2ExposureCount < 0
    || input.activeA2ExposureCount >= A2_MAX_ACTIVE_EXPOSURES) {
    return { signal: false, reason: "active_exposure_limit", sourceDropFraction };
  }

  return {
    signal: true,
    strategyId: A2_BASELINE_REVERSION_STRATEGY_ID,
    side: "yes",
    ticker: input.destination.ticker,
    stakeCents: A2_FIXED_STAKE_CENTS,
    maxEntryPriceCents: A2_MAX_ENTRY_PRICE_CENTS,
    sourceDropFraction,
  };
}
