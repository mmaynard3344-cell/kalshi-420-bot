import { ETH_JUMP_ORDER_TAG, ETH_JUMP_WAGER_CENTS, evaluateEthJumpSignal } from "./ethJumpSignal.js";
import { ETH_REVERSAL_ORDER_TAG, ETH_REVERSAL_WAGER_CENTS, evaluateEthNoStreakReversal } from "./ethNoStreakReversal.js";
import type { EthBigBetOrderIntent, EthBigBetSide } from "./ethBigBetLifecycle.js";
import { applyEthMorningWagerMultiplier } from "./ethMorningWagerMultiplier.js";

export const ETH_BIG_BET_LIMIT_PRICE_CENTS = 50;

/** Service B preserves the historical jump behavior: the signal owns sizing,
 * while direction is a read-only snapshot of Service A's carried side. */
export function buildEthJumpOrderIntent(input: {
  ticker: string;
  marketOpenTimeMs: number;
  carriedSide: EthBigBetSide | null;
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
}): EthBigBetOrderIntent | null {
  if (!/^KXETH15M-/.test(input.ticker) || !Number.isInteger(input.marketOpenTimeMs)
    || (input.carriedSide !== "yes" && input.carriedSide !== "no")) return null;
  const signal = evaluateEthJumpSignal({ currentMove: input.currentMove, p95: input.p95, p99: input.p99, carriedSide: input.carriedSide });
  if (!signal.fires) return null;
  return { strategy: "jump", orderTag: ETH_JUMP_ORDER_TAG, ticker: input.ticker, side: signal.side ?? input.carriedSide,
    wagerCents: ETH_JUMP_WAGER_CENTS, limitPriceCents: ETH_BIG_BET_LIMIT_PRICE_CENTS, marketOpenTimeMs: input.marketOpenTimeMs };
}

/** Service C is independent of A's sequence: a qualifying reversal is always
 * a flat $500 YES intent and never reads or mutates martingale state. */
export function buildEthReversalOrderIntent(input: {
  ticker: string;
  marketOpenTimeMs: number;
  consecutiveNoOutcomes: number;
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
}): EthBigBetOrderIntent | null {
  if (!/^KXETH15M-/.test(input.ticker) || !Number.isInteger(input.marketOpenTimeMs)) return null;
  const signal = evaluateEthNoStreakReversal({ consecutiveNoOutcomes: input.consecutiveNoOutcomes, currentMove: input.currentMove, p95: input.p95, p99: input.p99 });
  if (!signal.fires) return null;
  return { strategy: "reversal", orderTag: ETH_REVERSAL_ORDER_TAG, ticker: input.ticker, side: signal.side,
    wagerCents: applyEthMorningWagerMultiplier(ETH_REVERSAL_WAGER_CENTS), limitPriceCents: ETH_BIG_BET_LIMIT_PRICE_CENTS, marketOpenTimeMs: input.marketOpenTimeMs };
}
