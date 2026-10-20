/** Profit-taking target: exit owned contracts whenever buyers bid 75¢ or better. */
export const PROFIT_TAKE_TARGET_CENTS = 75;
export const TARGET75_ETH_TICKER_PREFIX = "KXETH";
/** Covers ETH-family markets across ETH services; other assets always excluded. */
export function isTarget75PilotTicker(ticker: string): boolean {
  return /^KXETH[A-Z0-9]*-[A-Z0-9-]+$/.test(ticker);
}

export interface Target75Snapshot {
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
  /** True only after every entry GTC is confirmed terminal on exchange. */
  entryOrdersTerminal: boolean;
}
export type Target75Decision =
  | { action: "hold"; reason: string }
  | { action: "sell_ioc"; contracts: number; minimumPriceCents: number; projectedNetProfitCents: number };

export function decideTarget75Exit(s: Target75Snapshot): Target75Decision {
  const hold = (reason: string): Target75Decision => ({ action: "hold", reason });
  const values = [
    s.strategyOwnedContracts, s.confirmedExchangeContracts,
    s.executableBidDepthContracts, s.pendingExitContracts,
  ];
  if (values.some(v => !Number.isSafeInteger(v) || v < 0)) return hold("invalid_snapshot");
  if (!s.ownershipIsExclusive || !s.exchangeOrderStateCertain) return hold("ownership_or_order_uncertain");
  if (!s.entryOrdersTerminal) return hold("entry_orders_not_terminal");
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
  if (bid < PROFIT_TAKE_TARGET_CENTS || bid > 99) return hold("below_target");
  if (s.executableBidDepthContracts < s.strategyOwnedContracts)
    return hold("insufficient_bid_depth");
  const projectedNetProfitCents =
    s.strategyOwnedContracts * bid - cost - entryFees - exitFees;
  // A 75¢ bid alone is not proof of net profitability; preserve the explicitly
  // requested profit-taking behavior to avoid booking a loss after fees.
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
export interface Target75ExecutionAdapter {
  reserveOnce(decisionKey: string, quantity: number): Promise<boolean>;
  markPostStarted(decisionKey: string): Promise<boolean>;
  submitIocSell(input: {
    decisionKey: string; ticker: string; heldSide: "yes" | "no";
    contracts: number; minPriceCents: number;
  }): Promise<{ status: "filled" | "partial" | "unfilled" | "unknown"; orderId: string | null }>;
  recordResult(decisionKey: string, result: { status: string; orderId: string | null }): Promise<boolean>;
}

/** No live call site until strategy-specific ledgers and the adapter exist. */
export async function executeTarget75Decision(
  adapter: Target75ExecutionAdapter,
  input: { decisionKey: string; ticker: string; heldSide: "yes" | "no"; snapshot: Target75Snapshot },
): Promise<"held" | "reserved_elsewhere" | "persistence_failed" | "submitted" | "unknown"> {
  // Pilot is explicitly ETH 15-minute only; fail closed for all other assets.
  if (!isTarget75PilotTicker(input.ticker)) return "held";
  const decision = decideTarget75Exit(input.snapshot);
  if (decision.action !== "sell_ioc") return "held";
  // Any datastore exception fails closed, before an exchange POST.
  let reserved = false;
  try { reserved = await adapter.reserveOnce(input.decisionKey, decision.contracts); }
  catch { return "persistence_failed"; }
  if (!reserved) return "reserved_elsewhere";
  let fenced = false;
  try { fenced = await adapter.markPostStarted(input.decisionKey); }
  catch { return "persistence_failed"; }
  if (!fenced) return "persistence_failed";
  try {
    const result = await adapter.submitIocSell({
      decisionKey: input.decisionKey, ticker: input.ticker, heldSide: input.heldSide,
      contracts: decision.contracts, minPriceCents: decision.minimumPriceCents,
    });
    // An accepted-looking response may not have a provider order ID. Without
    // that ID we cannot reconcile partial fills; keep the durable fence.
    if (result.status !== "unfilled" && !result.orderId) return "unknown";
    if (!await adapter.recordResult(input.decisionKey, result)) return "unknown";
    return result.status === "unknown" ? "unknown" : "submitted";
  } catch {
    // The POST might have succeeded. The durable post_started fence must
    // prevent automatic retries until exchange reconciliation confirms it.
    return "unknown";
  }
}

/**
 * Kalshi event-order wire representation for closing a verified position.
 * YES is held as YES shares (ask YES); held NO is represented as a YES
 * short/negative position (bid YES). This follows the same event-order
 * convention as eth30_50.ts rather than the old protectiveExit.ts path.
 *
 * This is ONLY a payload builder; callers must enforce the durable ownership
 * and POST fences in executeTarget75Decision before invoking the exchange.
 */
export function buildTarget75IocPayload(input: {
  ticker: string; decisionKey: string; heldSide: "yes" | "no";
  contracts: number; minPriceCents: number;
}): {
  ticker: string; client_order_id: string; side: "ask" | "bid";
  count: string; price: string; time_in_force: "immediate_or_cancel";
  self_trade_prevention_type: "taker_at_cross";
} {
  if (!isTarget75PilotTicker(input.ticker) ||
      !input.decisionKey || !Number.isSafeInteger(input.contracts) || input.contracts <= 0 ||
      !Number.isSafeInteger(input.minPriceCents) ||
      input.minPriceCents < PROFIT_TAKE_TARGET_CENTS || input.minPriceCents > 99)
    throw new Error("invalid_target75_exit_order");
  return {
    ticker: input.ticker,
    client_order_id: input.decisionKey,
    side: input.heldSide === "yes" ? "ask" : "bid",
    count: input.contracts.toFixed(2),
    // Event-order price is denominated in YES. A held NO at 75¢ is
    // closed by buying YES for at most 25¢, not 75¢.
    price: ((input.heldSide === "yes" ? input.minPriceCents : 100 - input.minPriceCents) / 100).toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };
}

/**
 * Apply a VERIFIED exchange exit fill to the open strategy lot, without
 * treating it as a binary settlement. This does not change a martingale rung.
 * Each caller must durably store fill IDs and call this once per unique fill.
 */
export function applyTarget75VerifiedExitFill(input: {
  ownedContracts: number;
  previouslyExitedContracts: number;
  newExitFillContracts: number;
  grossExitProceedsCents: number;
  exitFeeCents: number;
  originalEntryNotionalCents: number;
  originalEntryFeesCents: number;
}): {
  remainingContracts: number;
  totalExitedContracts: number;
  realizedProfitNumerator: number;
  realizedProfitDenominator: number;
} {
  const n = input.ownedContracts;
  const e = input.previouslyExitedContracts;
  const f = input.newExitFillContracts;
  const integers = Object.values(input);
  if (integers.some(v => !Number.isSafeInteger(v) || v < 0)
    || n <= 0 || f <= 0 || e >= n || f > n - e)
    throw new Error("invalid_or_duplicate_target75_fill");
  // Retain exact rational allocated entry costs instead of rounding each
  // partial fill independently, which could overstate realized P&L.
  const originalCost = input.originalEntryNotionalCents + input.originalEntryFeesCents;
  if (!Number.isSafeInteger(originalCost)) throw new Error("invalid_entry_cost");
  const realizedProfitNumerator =
    (input.grossExitProceedsCents - input.exitFeeCents) * n - originalCost * f;
  if (!Number.isSafeInteger(realizedProfitNumerator)) throw new Error("overflow_exit_pnl");
  return {
    remainingContracts: n - e - f,
    totalExitedContracts: e + f,
    realizedProfitNumerator,
    realizedProfitDenominator: n,
  };
}
