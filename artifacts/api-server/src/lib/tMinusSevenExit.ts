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

/**
 * Runner-side execution contract. The exchange integration must implement a
 * durable, atomic reserve (ticker + strategy + close time), and recover unknown
 * order outcomes before permitting another reservation. A false reservation
 * means no POST, even if this process restarted during the window.
 */
export interface TMinusSevenExecutionAdapter {
  reserveOnce(decisionKey: string, quantity: number): Promise<boolean>;
  markPostStarted(decisionKey: string): Promise<boolean>;
  submitIocSell(input: {
    decisionKey: string; ticker: string; heldSide: "yes" | "no";
    contracts: number; minPriceCents: number;
  }): Promise<{ status: "filled" | "partial" | "unfilled" | "unknown"; orderId: string | null }>;
  recordResult(decisionKey: string, result: { status: string; orderId: string | null }): Promise<boolean>;
}

/** No live call site until strategy-specific ledgers and the adapter exist. */
export async function executeTMinusSevenDecision(
  adapter: TMinusSevenExecutionAdapter,
  input: { decisionKey: string; ticker: string; heldSide: "yes" | "no"; snapshot: TMinusSevenSnapshot },
): Promise<"held" | "reserved_elsewhere" | "persistence_failed" | "submitted" | "unknown"> {
  const decision = decideTMinusSevenExit(input.snapshot);
  if (decision.action !== "sell_ioc") return "held";
  if (!await adapter.reserveOnce(input.decisionKey, decision.contracts)) return "reserved_elsewhere";
  if (!await adapter.markPostStarted(input.decisionKey)) return "persistence_failed";
  try {
    const result = await adapter.submitIocSell({
      decisionKey: input.decisionKey, ticker: input.ticker, heldSide: input.heldSide,
      contracts: decision.contracts, minPriceCents: decision.minimumPriceCents,
    });
    if (!await adapter.recordResult(input.decisionKey, result)) return "unknown";
    return result.status === "unknown" ? "unknown" : "submitted";
  } catch {
    // The POST might have succeeded. The durable post_started fence must
    // prevent automatic retries until exchange reconciliation confirms it.
    return "unknown";
  }
}
