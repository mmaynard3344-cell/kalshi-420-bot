/**
 * Offline-only Phase 4A replay types.
 *
 * This directory is intentionally independent from live order, routing, and
 * trading modules. It evaluates immutable historical capture snapshots only.
 */

export type ReplaySide = "yes" | "no";
export type MarketOutcome = ReplaySide | null;

export interface ReplayCapture {
  captureId: string;
  timestampMs: number;
  easternDate: string;
  ticker: string;
  series: string;
  side: ReplaySide;
  entryPriceCents: number | null;
  contracts: number | null;
  secondsLeft: number | null;
  staleGapCents: number | null;
  spreadCents: number | null;
  executableDepthContracts: number | null;
  liquidityDollars: number | null;
  priorDirectionalMoveCents: number | null;
  /** Eastern hour recorded or derived from timestamp. */
  easternHour: number | null;
  /** JavaScript-style day: 0 Sunday through 6 Saturday. */
  easternWeekday: number | null;
  rawPayload: Readonly<Record<string, unknown>>;
}

export interface ReplayExperiment {
  id: string;
  staleGapThresholdCents?: number;
  entryPriceFloorCents?: number;
  entryPriceCeilingCents?: number;
  minSecondsLeft?: number;
  maxSecondsLeft?: number;
  assets?: readonly ("BTC" | "ETH")[];
  sides?: readonly ReplaySide[];
  maxSpreadCents?: number;
  minDepthContracts?: number;
  minLiquidityDollars?: number;
  minPriorDirectionalMoveCents?: number;
  easternHours?: readonly number[];
  includeWeekends?: boolean;
  oneTradePerMarket?: boolean;
  /** Explicit historical fee estimate, in dollars per contract. Defaults to zero. */
  feeDollarsPerContract?: number;
}

export interface ReplayTradeResult {
  captureId: string;
  timestampMs: number;
  ticker: string;
  series: string;
  side: ReplaySide;
  accepted: boolean;
  deduped: boolean;
  rejectionReason: string | null;
  entryPriceCents: number | null;
  contracts: number | null;
  entryCostDollars: number | null;
  feeDollars: number | null;
  payoutDollars: number | null;
  grossPnlDollars: number | null;
  netPnlDollars: number | null;
  roi: number | null;
  marketOutcome: MarketOutcome;
  unresolved: boolean;
}

export interface ReplaySummary {
  totalCaptures: number;
  accepted: number;
  rejected: number;
  deduped: number;
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  entryCostDollars: number;
  feeDollars: number;
  payoutDollars: number;
  grossPnlDollars: number;
  netPnlDollars: number;
  roi: number | null;
}

export interface ReplayResult {
  experiment: ReplayExperiment;
  trades: readonly ReplayTradeResult[];
  summary: ReplaySummary;
}

export interface ChronologicalPartition<T> {
  train: readonly T[];
  test: readonly T[];
}