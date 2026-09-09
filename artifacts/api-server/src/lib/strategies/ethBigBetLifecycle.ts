/**
 * Shared lifecycle contract for stateless ETH big-bet services. These services
 * never mutate martingale sequence state. Settlement is accounting evidence
 * only and never gates evaluation of a later 15-minute market.
 */
export type EthBigBetStrategy =
  | "jump"
  | "reversal"
  | "downfade_p80_p90"
  | "downfade_p90_p95"
  | "downfade_p95_p99"
  | "probe_g";
export type EthBigBetSide = "yes" | "no";

export interface EthBigBetOrderIntent {
  strategy: EthBigBetStrategy;
  orderTag: string;
  ticker: string;
  side: EthBigBetSide;
  wagerCents: number;
  limitPriceCents: number;
  marketOpenTimeMs: number;
}

export interface EthBigBetSettlement {
  orderId: string;
  strategy: EthBigBetStrategy;
  ticker: string;
  side: EthBigBetSide;
  result: EthBigBetSide;
  filledContracts: number;
  notionalCents: number;
  feeCents: number;
}

export interface EthBigBetAccountingResult {
  pnlCents: number;
  won: boolean | null;
}

/** One immutable order identity per strategy+market prevents duplicate submits
 * without creating cross-market lifecycle coupling. */
export function ethBigBetOrderId(intent: Pick<EthBigBetOrderIntent, "ticker" | "orderTag">): string {
  return `${intent.ticker}:${intent.orderTag}`;
}

/** Full contracts affordable at the requested limit. The wager is a risk cap,
 * not a reason to derive any ladder state. */
export function ethBigBetContracts(wagerCents: number, limitPriceCents: number): number {
  if (!Number.isInteger(wagerCents) || wagerCents <= 0
    || !Number.isInteger(limitPriceCents) || limitPriceCents < 1 || limitPriceCents > 99) return 0;
  return Math.floor(wagerCents / limitPriceCents);
}

/** Conservative exchange-style fee headroom for a complete fill at the limit.
 * This mirrors the fee convention already used by A's prospective-loss guard. */
export function estimateEthBigBetFullFillFeeCents(wagerCents: number, limitPriceCents: number): number {
  const contracts = ethBigBetContracts(wagerCents, limitPriceCents);
  if (contracts < 1) return 0;
  return Math.ceil(0.07 * contracts * limitPriceCents * (100 - limitPriceCents) / 100);
}

/** Principal plus conservative full-fill fee headroom used only for account
 * capital admission. It does not alter order notional or settlement P&L. */
export function ethBigBetCapitalRiskCents(wagerCents: number, limitPriceCents: number): number {
  const fee = estimateEthBigBetFullFillFeeCents(wagerCents, limitPriceCents);
  if (fee < 1) return 0;
  const total = wagerCents + fee;
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

/** Settlement updates accounting only. A zero fill has zero P&L and does not
 * become a loss, a sequence transition, or a blocker for the next market. */
export function accountEthBigBetSettlement(input: EthBigBetSettlement): EthBigBetAccountingResult | null {
  if (!Number.isInteger(input.filledContracts) || input.filledContracts < 0
    || !Number.isInteger(input.notionalCents) || input.notionalCents < 0
    || !Number.isInteger(input.feeCents) || input.feeCents < 0) return null;
  if (input.filledContracts === 0) return { pnlCents: 0, won: null };
  const payoutCents = input.result === input.side ? input.filledContracts * 100 : 0;
  return {
    pnlCents: payoutCents - input.notionalCents - input.feeCents,
    won: input.result === input.side,
  };
}

/** Stateless services may evaluate a later market even when an earlier order is unresolved.
 * Only an unresolved order for the exact same strategy+market blocks another submit.
 * Account-level capital/exposure controls remain a separate guard. */
export function mayEvaluateBigBetMarket(input: {
  targetOrderId: string;
  unresolvedOrderIds: readonly string[];
}): boolean {
  return !input.unresolvedOrderIds.includes(input.targetOrderId);
}
