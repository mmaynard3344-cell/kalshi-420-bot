import { ETH_JUMP_ORDER_TAG, ETH_JUMP_WAGER_CENTS, evaluateEthJumpSignal } from "./ethJumpSignal.js";
import { ETH_REVERSAL_ORDER_TAG, ETH_REVERSAL_WAGER_CENTS, evaluateEthNoStreakReversal } from "./ethNoStreakReversal.js";
import { ETH_BREAKOUT_REVERSAL_ORDER_TAG, ETH_BREAKOUT_REVERSAL_WAGER_CENTS, evaluateEthBreakoutReversal } from "./ethBreakoutReversal.js";
import type { EthBigBetOrderIntent, EthBigBetSide } from "./ethBigBetLifecycle.js";
import { applyEthMorningWagerMultiplier } from "./ethMorningWagerMultiplier.js";

export const ETH_BIG_BET_LIMIT_PRICE_CENTS = 50;

export function buildEthJumpOrderIntent(input: { ticker: string; marketOpenTimeMs: number; carriedSide: EthBigBetSide | null; currentMove: number | null; p95: number | null; p99: number | null; }): EthBigBetOrderIntent | null {
  if (!/^KXETH15M-/.test(input.ticker) || !Number.isInteger(input.marketOpenTimeMs) || (input.carriedSide !== "yes" && input.carriedSide !== "no")) return null;
  const signal = evaluateEthJumpSignal({ currentMove: input.currentMove, p95: input.p95, p99: input.p99, carriedSide: input.carriedSide });
  if (!signal.fires) return null;
  return { strategy: "jump", orderTag: ETH_JUMP_ORDER_TAG, ticker: input.ticker, side: signal.side ?? input.carriedSide, wagerCents: ETH_JUMP_WAGER_CENTS, limitPriceCents: ETH_BIG_BET_LIMIT_PRICE_CENTS, marketOpenTimeMs: input.marketOpenTimeMs };
}

export function buildEthReversalOrderIntent(input: { ticker: string; marketOpenTimeMs: number; consecutiveNoOutcomes: number; currentMove: number | null; p95: number | null; p99: number | null; }): EthBigBetOrderIntent | null {
  if (!/^KXETH15M-/.test(input.ticker) || !Number.isInteger(input.marketOpenTimeMs)) return null;
  const signal = evaluateEthNoStreakReversal({ consecutiveNoOutcomes: input.consecutiveNoOutcomes, currentMove: input.currentMove, p95: input.p95, p99: input.p99 });
  if (!signal.fires) return null;
  return { strategy: "reversal", orderTag: ETH_REVERSAL_ORDER_TAG, ticker: input.ticker, side: signal.side, wagerCents: ETH_REVERSAL_WAGER_CENTS, limitPriceCents: ETH_BIG_BET_LIMIT_PRICE_CENTS, marketOpenTimeMs: input.marketOpenTimeMs };
}

export function buildEthBreakoutReversalOrderIntent(input: { ticker: string; marketOpenTimeMs: number; consecutiveNoOutcomes: number; currentMove: number | null; p95: number | null; p99: number | null; }): EthBigBetOrderIntent | null {
  if (!/^KXETH15M-/.test(input.ticker) || !Number.isInteger(input.marketOpenTimeMs)) return null;
  const signal = evaluateEthBreakoutReversal({ consecutiveNoOutcomes: input.consecutiveNoOutcomes, currentMove: input.currentMove, p95: input.p95, p99: input.p99 });
  if (!signal.fires) return null;
  return { strategy: "breakout_reversal", orderTag: ETH_BREAKOUT_REVERSAL_ORDER_TAG, ticker: input.ticker, side: signal.side, wagerCents: applyEthMorningWagerMultiplier(ETH_BREAKOUT_REVERSAL_WAGER_CENTS), limitPriceCents: ETH_BIG_BET_LIMIT_PRICE_CENTS, marketOpenTimeMs: input.marketOpenTimeMs };
}
