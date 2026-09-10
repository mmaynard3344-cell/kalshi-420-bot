import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

/** Optimized from the 2026-03-01 through 2026-08-25 canonical replay. */
export const ETH_ASH_V2_DOWN_MIN_RATIO = 0.0060;
export const ETH_ASH_V2_DOWN_MAX_RATIO = 0.0099;
export const ETH_ASH_V2_UP_MIN_RATIO = 0.0050;
export const ETH_ASH_V2_UP_MAX_RATIO = 0.0080;
export const ETH_ASH_V2_WAGER_CENTS = 46_200;
export const ETH_ASH_V2_LIMIT_PRICE_CENTS = 50;
export const ETH_ASH_V2_ENTRY_WINDOW_MS = 120_000;
export const ETH_ASH_V2_ORDER_TAG = "eth-ash-v2-i-v1";

export interface EthAshV2Evidence {
  ticker: string;
  marketOpenTimeMs: number;
  currentStrike: number | null;
  priorStrike: number | null;
  moveRatio: number | null;
  ageMs: number | null;
}

export function buildEthAshV2Intent(evidence: EthAshV2Evidence): EthBigBetOrderIntent | null {
  if (!/^KXETH15M-/.test(evidence.ticker)
    || !Number.isInteger(evidence.marketOpenTimeMs)
    || evidence.marketOpenTimeMs <= 0
    || typeof evidence.currentStrike !== "number" || !Number.isFinite(evidence.currentStrike) || evidence.currentStrike <= 0
    || typeof evidence.priorStrike !== "number" || !Number.isFinite(evidence.priorStrike) || evidence.priorStrike <= 0
    || typeof evidence.moveRatio !== "number" || !Number.isFinite(evidence.moveRatio)
    || typeof evidence.ageMs !== "number" || !Number.isFinite(evidence.ageMs)) return null;

  if (evidence.ageMs < 0 || evidence.ageMs > ETH_ASH_V2_ENTRY_WINDOW_MS) return null;

  let side: "yes" | "no" | null = null;
  if (evidence.moveRatio < 0) {
    const decline = -evidence.moveRatio;
    if (decline >= ETH_ASH_V2_DOWN_MIN_RATIO && decline < ETH_ASH_V2_DOWN_MAX_RATIO) side = "yes";
  } else if (evidence.moveRatio > 0) {
    const rise = evidence.moveRatio;
    if (rise >= ETH_ASH_V2_UP_MIN_RATIO && rise < ETH_ASH_V2_UP_MAX_RATIO) side = "no";
  }
  if (!side) return null;

  return {
    strategy: "ash_v2_i",
    orderTag: ETH_ASH_V2_ORDER_TAG,
    ticker: evidence.ticker,
    side,
    wagerCents: ETH_ASH_V2_WAGER_CENTS,
    limitPriceCents: ETH_ASH_V2_LIMIT_PRICE_CENTS,
    marketOpenTimeMs: evidence.marketOpenTimeMs,
  };
}
