import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { applyEthMorningWagerMultiplier } from "./ethMorningWagerMultiplier.js";

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Frozen from the 2026-03-01 through 2026-08-25 canonical replay. */
export const ETH_ASHLEY_MIN_DECLINE_RATIO = 0.0070;
export const ETH_ASHLEY_MAX_DECLINE_RATIO = 0.0095;
export const ETH_ASHLEY_WAGER_CENTS = positiveIntegerEnv("ETH_H_WAGER_CENTS", 22_000);
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
  if (evidence.ageMs < 0 || evidence.ageMs > ETH_ASHLEY_ENTRY_WINDOW_MS) return null;
  if (evidence.moveRatio >= 0) return null;
  if (evidence.declineRatio < ETH_ASHLEY_MIN_DECLINE_RATIO || evidence.declineRatio >= ETH_ASHLEY_MAX_DECLINE_RATIO) return null;
  return {
    strategy: "downfade_p95_p99",
    orderTag: ETH_ASHLEY_ORDER_TAG,
    ticker: evidence.ticker,
    side: "yes",
    wagerCents: applyEthMorningWagerMultiplier(ETH_ASHLEY_WAGER_CENTS),
    limitPriceCents: ETH_ASHLEY_LIMIT_PRICE_CENTS,
    marketOpenTimeMs: evidence.marketOpenTimeMs,
  };
}
