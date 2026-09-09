import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

/** Frozen from the 2026-03-01 through 2026-08-25 canonical replay. */
export const ETH_ASHLEY_MIN_DECLINE_RATIO = 0.0070;
export const ETH_ASHLEY_MAX_DECLINE_RATIO = 0.0095;
export const ETH_ASHLEY_WAGER_CENTS = 10_000;
export const ETH_ASHLEY_LIMIT_PRICE_CENTS = 50;
export const ETH_ASHLEY_ENTRY_WINDOW_MS = 120_000;
export const ETH_ASHLEY_ORDER_TAG = "eth-ashley-h-v1";

export interface EthAshleyEvidence {
  ticker: string;
  marketOpenTimeMs: number;
  currentStrike: number | null;
  priorStrike: number | null;
  moveRatio: number | null;
  declineRatio: number | null;
  ageMs: number | null;
}

export function buildEthAshleyIntent(evidence: EthAshleyEvidence): EthBigBetOrderIntent | null {
  if (!/^KXETH15M-/.test(evidence.ticker)
    || !Number.isInteger(evidence.marketOpenTimeMs)
    || evidence.marketOpenTimeMs <= 0
    || typeof evidence.currentStrike !== "number" || !Number.isFinite(evidence.currentStrike) || evidence.currentStrike <= 0
    || typeof evidence.priorStrike !== "number" || !Number.isFinite(evidence.priorStrike) || evidence.priorStrike <= 0
    || typeof evidence.moveRatio !== "number" || !Number.isFinite(evidence.moveRatio)
    || typeof evidence.declineRatio !== "number" || !Number.isFinite(evidence.declineRatio)
    || typeof evidence.ageMs !== "number" || !Number.isFinite(evidence.ageMs)) return null;

  // Ashley is opening-window mean reversion only: a DOWN adjacent-strike move
  // of 0.70% inclusive through 0.95% exclusive, evaluated in the first 120 s.
  if (evidence.ageMs < 0 || evidence.ageMs > ETH_ASHLEY_ENTRY_WINDOW_MS) return null;
  if (evidence.moveRatio >= 0) return null;
  if (evidence.declineRatio < ETH_ASHLEY_MIN_DECLINE_RATIO
    || evidence.declineRatio >= ETH_ASHLEY_MAX_DECLINE_RATIO) return null;

  return {
    // Reuse the dormant p95-p99 big-bet strategy ledger slot so the shared
    // B/C/E/F/G SQL constraint remains compatible. Ashley's unique orderTag
    // keeps its strategy+market order identity independent and auditable.
    strategy: "downfade_p95_p99",
    orderTag: ETH_ASHLEY_ORDER_TAG,
    ticker: evidence.ticker,
    side: "yes",
    wagerCents: ETH_ASHLEY_WAGER_CENTS,
    limitPriceCents: ETH_ASHLEY_LIMIT_PRICE_CENTS,
    marketOpenTimeMs: evidence.marketOpenTimeMs,
  };
}
