/**
 * Service A: pure ETH martingale decision contract.
 *
 * This module intentionally knows nothing about percentile jumps, reversal
 * streaks, or exchange execution. It describes only the durable carried-side
 * ladder that Service A owns.
 */
export const ETH_MARTINGALE_WAGERS_CENTS = [1500, 3000, 6000, 12000, 24000, 32000] as const;
export const ETH_MARTINGALE_ORDER_TAG = "eth-martingale-v1" as const;

export type EthMartingaleSide = "yes" | "no";

export interface EthMartingaleState {
  side: EthMartingaleSide;
  step: number;
}

export interface EthMartingaleDecision {
  strategy: "martingale";
  orderTag: typeof ETH_MARTINGALE_ORDER_TAG;
  side: EthMartingaleSide;
  step: number;
  wagerCents: number;
}

export function martingaleWagerForStep(step: number): number {
  const bounded = Math.max(0, Math.min(ETH_MARTINGALE_WAGERS_CENTS.length - 1, Math.trunc(step)));
  return ETH_MARTINGALE_WAGERS_CENTS[bounded]!;
}

export function evaluateEthMartingaleSignal(state: EthMartingaleState): EthMartingaleDecision {
  const step = Math.max(0, Math.min(ETH_MARTINGALE_WAGERS_CENTS.length - 1, Math.trunc(state.step)));
  return {
    strategy: "martingale",
    orderTag: ETH_MARTINGALE_ORDER_TAG,
    side: state.side,
    step,
    wagerCents: martingaleWagerForStep(step),
  };
}
