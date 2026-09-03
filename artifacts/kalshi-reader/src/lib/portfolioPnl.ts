export interface PortfolioPnlFill {
  side: 'yes' | 'no';
  yes_price_dollars: string;
  no_price_dollars: string;
  count_fp: string;
  fee_cost: string;
  market_result: string;
}

export interface PnlCoverage {
  realizedPnl: number | null;
  settledFillCount: number;
  pendingSettlementCount: number;
}

/**
 * Kalshi reports the actual held side in current fill records. The price
 * fallback only supports legacy records that do not include it.
 */
export function fillEffectiveSide(fill: PortfolioPnlFill): 'yes' | 'no' {
  if (fill.side === 'yes' || fill.side === 'no') return fill.side;
  const yesPrice = parseFloat(fill.yes_price_dollars);
  return yesPrice < 0.50 ? 'no' : 'yes';
}

/** Returns settled net P&L for one exchange fill, or null before settlement. */
export function computePnl(fill: PortfolioPnlFill): number | null {
  if (!fill.market_result) return null;
  const contracts = parseFloat(fill.count_fp);
  const effectiveSide = fillEffectiveSide(fill);
  const priceDollars = effectiveSide === 'no'
    ? parseFloat(fill.no_price_dollars)
    : parseFloat(fill.yes_price_dollars);
  const fees = parseFloat(fill.fee_cost || '0');
  if (!Number.isFinite(contracts) || !Number.isFinite(priceDollars) || !Number.isFinite(fees)) {
    return null;
  }
  const payout = effectiveSide === fill.market_result ? contracts : 0;
  return payout - (contracts * priceDollars) - fees;
}

/**
 * Keeps confirmed results visible even while later fills await settlement.
 * A null realizedPnl means there are no settled fills to report, not $0.
 */
export function summarizePnlCoverage(fills: PortfolioPnlFill[]): PnlCoverage {
  let realizedPnl: number | null = null;
  let settledFillCount = 0;
  let pendingSettlementCount = 0;

  for (const fill of fills) {
    const pnl = computePnl(fill);
    if (pnl === null) {
      pendingSettlementCount++;
      continue;
    }
    settledFillCount++;
    realizedPnl = (realizedPnl ?? 0) + pnl;
  }

  return { realizedPnl, settledFillCount, pendingSettlementCount };
}