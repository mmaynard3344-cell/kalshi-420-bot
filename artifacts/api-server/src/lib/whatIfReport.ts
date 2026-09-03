/**
 * What-if zone/floor simulator — READ-ONLY.
 *
 * Replays historical order attempts against a hypothetical trigger-price
 * floor/ceiling and reports which trades would have been blocked, the P&L
 * delta, and win rate per trigger-price bucket. It never touches live
 * trading parameters or any persisted state.
 */

import type { OrderAttemptRecord } from "./analytics.js";

/** Trigger-price buckets requested by the partners. */
const WHAT_IF_BUCKETS = [
  { band: "70-74", min: 70, max: 74 },
  { band: "75-79", min: 75, max: 79 },
  { band: "80-84", min: 80, max: 84 },
  { band: "85-89", min: 85, max: 89 },
  { band: "90-93", min: 90, max: 93 },
] as const;

export interface WhatIfBucket {
  band:      string;
  minCents:  number;
  maxCents:  number;
  /** All reconciled fills whose trigger price falls in this bucket. */
  fills:     number;
  wins:      number;
  losses:    number;
  winRate:   number | null;
  netPnlDollars: number | null;
  /** Subset of this bucket that the hypothetical zone would have blocked. */
  blockedFills:  number;
  blockedWins:   number;
  blockedLosses: number;
  /** Net P&L of the blocked subset (negative = the block would have saved money). */
  blockedNetPnlDollars: number | null;
}

export interface WhatIfBlockedTrade {
  ticker:            string;
  timestampMs:       number;
  side:              "yes" | "no";
  triggerPriceCents: number;
  fillPriceCents:    number | null;
  contracts:         number;
  win:               boolean | null;
  netPnlDollars:     number | null;
  blockedBy:         "floor" | "ceiling";
}

export interface WhatIfReport {
  params: {
    floorCents:   number;
    ceilingCents: number;
    period:       string;
  };
  summary: {
    /** Reconciled fills examined. */
    totalFills:            number;
    blockedFills:          number;
    keptFills:             number;
    /** Actual historical net P&L over the period. */
    actualNetPnlDollars:       number;
    /** Net P&L had the hypothetical zone been active (kept trades only). */
    hypotheticalNetPnlDollars: number;
    /** hypothetical − actual. Positive = the change would have helped. */
    pnlDeltaDollars:           number;
    /** Losses avoided by blocking losing trades (positive number). */
    preventedLossDollars:      number;
    /** Wins given up by blocking winning trades (positive number). */
    forfeitedWinDollars:       number;
    actualWinRate:       number | null;
    hypotheticalWinRate: number | null;
  };
  byBucket:      WhatIfBucket[];
  blockedTrades: WhatIfBlockedTrade[];
  /** Filled orders excluded because market outcome is not yet reconciled. */
  pendingFills:  number;
  generatedAt:   string;
}

/**
 * Build a what-if report over the supplied order records.
 * Only reconciled fills (known win/loss) contribute; pending fills are counted
 * separately so it is clear how much data is outstanding.
 */
export function getWhatIfReport(
  orders:       OrderAttemptRecord[],
  floorCents:   number,
  ceilingCents: number,
  period:       string,
): WhatIfReport {
  const allFills = orders.filter(
    (o) => o.outcome === "full_fill" || o.outcome === "partial_fill",
  );
  const fills = allFills.filter((o) => o.outcomeReconciledAt != null);
  const pendingFills = allFills.length - fills.length;

  const isBlocked = (o: OrderAttemptRecord): "floor" | "ceiling" | null => {
    if (o.triggerPriceCents < floorCents)   return "floor";
    if (o.triggerPriceCents > ceilingCents) return "ceiling";
    return null;
  };

  const blocked = fills.filter((o) => isBlocked(o) !== null);
  const kept    = fills.filter((o) => isBlocked(o) === null);

  const netOf = (list: OrderAttemptRecord[]) =>
    list.reduce((s, o) => s + (o.netPnlDollars ?? 0), 0);
  const winsOf = (list: OrderAttemptRecord[]) =>
    list.filter((o) => o.win === true).length;

  const actualNet       = netOf(fills);
  const hypotheticalNet = netOf(kept);

  const blockedLosers  = blocked.filter((o) => (o.netPnlDollars ?? 0) < 0);
  const blockedWinners = blocked.filter((o) => (o.netPnlDollars ?? 0) > 0);
  const preventedLossDollars = -netOf(blockedLosers);
  const forfeitedWinDollars  = netOf(blockedWinners);

  const byBucket: WhatIfBucket[] = WHAT_IF_BUCKETS.map(({ band, min, max }) => {
    const bucket = fills.filter(
      (o) => o.triggerPriceCents >= min && o.triggerPriceCents <= max,
    );
    const bucketBlocked = bucket.filter((o) => isBlocked(o) !== null);
    const wins        = winsOf(bucket);
    const blockedWins = winsOf(bucketBlocked);
    return {
      band, minCents: min, maxCents: max,
      fills:   bucket.length,
      wins,
      losses:  bucket.length - wins,
      winRate: bucket.length > 0 ? wins / bucket.length : null,
      netPnlDollars: bucket.length > 0 ? netOf(bucket) : null,
      blockedFills:  bucketBlocked.length,
      blockedWins,
      blockedLosses: bucketBlocked.length - blockedWins,
      blockedNetPnlDollars: bucketBlocked.length > 0 ? netOf(bucketBlocked) : null,
    };
  });

  const blockedTrades: WhatIfBlockedTrade[] = blocked
    .slice()
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .map((o) => ({
      ticker:            o.ticker,
      timestampMs:       o.timestampMs,
      side:              o.side,
      triggerPriceCents: o.triggerPriceCents,
      fillPriceCents:    o.fillPriceCents.value,
      contracts:         o.contracts.value,
      win:               o.win ?? null,
      netPnlDollars:     o.netPnlDollars ?? null,
      blockedBy:         isBlocked(o) as "floor" | "ceiling",
    }));

  return {
    params: { floorCents, ceilingCents, period },
    summary: {
      totalFills:                fills.length,
      blockedFills:              blocked.length,
      keptFills:                 kept.length,
      actualNetPnlDollars:       actualNet,
      hypotheticalNetPnlDollars: hypotheticalNet,
      pnlDeltaDollars:           hypotheticalNet - actualNet,
      preventedLossDollars,
      forfeitedWinDollars,
      actualWinRate:       fills.length > 0 ? winsOf(fills) / fills.length : null,
      hypotheticalWinRate: kept.length > 0 ? winsOf(kept) / kept.length : null,
    },
    byBucket,
    blockedTrades,
    pendingFills,
    generatedAt: new Date().toISOString(),
  };
}
