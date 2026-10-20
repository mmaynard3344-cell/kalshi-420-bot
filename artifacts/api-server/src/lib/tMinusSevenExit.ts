/**
 * T−7:00 profitable-exit decision policy.
 *
 * This module is deliberately pure: an exchange order must NOT be submitted
 * without an independently confirmed strategy-owned fill ledger, fees and
 * executable held-side bid. Never use a ticker-level net position as proof of
 * ownership where different strategies can share a market.
 */
export const T_MINUS_SEVEN_MS = 7 * 60_000;
export const T_MINUS_SEVEN_GRACE_MS = 5_000;

export interface TMinusSevenSnapshot {
  nowMs: number;
  marketCloseMs: number;
  strategyOwnedContracts: number;
  confirmedExchangeContracts: number;
  // All-in historical costs in cents for precisely the open owned contracts.
  entryCostCents: number | null;
  entryFeesCents: number | null;
  // Buyers' executable bid on the side actually owned, not the opposite ask.
  executableBidCents: number | null;
  executableBidDepthContracts: number;
  estimatedExitFeesCents: number | null;
  pendingExitContracts: number;
  ownershipIsExclusive: boolean;
  exchangeOrderStateCertain: boolean;
}
export type TMinusSevenDecision =
  | { action: "hold"; reason: string }
  | { action: "sell_ioc"; contracts: number; minimumPriceCents: number; projectedNetProfitCents: number };

export function decideTMinusSevenExit(s: TMinusSevenSnapshot): TMinusSevenDecision {
  const hold = (reason: string): TMinusSevenDecision => ({ action: "hold", reason });
  const values = [
    s.nowMs, s.marketCloseMs, s.strategyOwnedContracts, s.confirmedExchangeContracts,
    s.executableBidDepthContracts, s.pendingExitContracts,
  ];
  if (values.some(v => !Number.isSafeInteger(v))) return hold("invalid_snapshot");
  if (s.marketCloseMs - s.nowMs > T_MINUS_SEVEN_MS ||
      s.marketCloseMs - s.nowMs < T_MINUS_SEVEN_MS - T_MINUS_SEVEN_GRACE_MS)
    return hold("outside_t_minus_seven_window");
  if (!s.ownershipIsExclusive || !s.exchangeOrderStateCertain) return hold("ownership_or_order_uncertain");
  if (s.strategyOwnedContracts <= 0 || s.confirmedExchangeContracts !== s.strategyOwnedContracts)
    return hold("position_mismatch");
  if (s.pendingExitContracts !== 0) return hold("existing_exit_order");
  if (s.entryCostCents === null || s.entryFeesCents === null ||
      s.estimatedExitFeesCents === null || s.executableBidCents === null)
    return hold("economics_unknown");
  const cost = s.entryCostCents;
  const entryFees = s.entryFeesCents;
  const exitFees = s.estimatedExitFeesCents;
  const bid = s.executableBidCents;
  if (![cost, entryFees, exitFees, bid].every(v => Number.isSafeInteger(v) && v >= 0))
    return hold("invalid_economics");
  if (bid < 1 || bid > 99) return hold("invalid_bid");
  if (s.executableBidDepthContracts < s.strategyOwnedContracts)
    return hold("insufficient_bid_depth");
  const projectedNetProfitCents =
    s.strategyOwnedContracts * bid - cost - entryFees - exitFees;
  if (projectedNetProfitCents <= 0) return hold("not_profitable_after_fees");
  return {
    action: "sell_ioc", contracts: s.strategyOwnedContracts,
    minimumPriceCents: bid, projectedNetProfitCents,
  };
}
