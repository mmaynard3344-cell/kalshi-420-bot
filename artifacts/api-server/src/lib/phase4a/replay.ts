import type {
  ChronologicalPartition,
  MarketOutcome,
  ReplayCapture,
  ReplayExperiment,
  ReplayResult,
  ReplaySummary,
  ReplayTradeResult,
} from "./types.js";

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assetFor(capture: ReplayCapture): "BTC" | "ETH" | null {
  const text = `${capture.ticker} ${capture.series}`.toUpperCase();
  return text.includes("BTC") ? "BTC" : text.includes("ETH") ? "ETH" : null;
}

function rejects(capture: ReplayCapture, experiment: ReplayExperiment): string | null {
  const value = (field: number | null, predicate: (value: number) => boolean, name: string) =>
    field == null || !predicate(field) ? name : null;
  if (experiment.staleGapThresholdCents != null) {
    const reason = value(capture.staleGapCents, (v) => v >= experiment.staleGapThresholdCents!, "stale_gap");
    if (reason) return reason;
  }
  if (experiment.entryPriceFloorCents != null) {
    const reason = value(capture.entryPriceCents, (v) => v >= experiment.entryPriceFloorCents!, "entry_price_floor");
    if (reason) return reason;
  }
  if (experiment.entryPriceCeilingCents != null) {
    const reason = value(capture.entryPriceCents, (v) => v <= experiment.entryPriceCeilingCents!, "entry_price_ceiling");
    if (reason) return reason;
  }
  if (experiment.minSecondsLeft != null) {
    const reason = value(capture.secondsLeft, (v) => v >= experiment.minSecondsLeft!, "seconds_left_min");
    if (reason) return reason;
  }
  if (experiment.maxSecondsLeft != null) {
    const reason = value(capture.secondsLeft, (v) => v <= experiment.maxSecondsLeft!, "seconds_left_max");
    if (reason) return reason;
  }
  if (experiment.assets?.length && !experiment.assets.includes(assetFor(capture) ?? "BTC")) return "asset";
  if (experiment.sides?.length && !experiment.sides.includes(capture.side)) return "side";
  if (experiment.maxSpreadCents != null) {
    const reason = value(capture.spreadCents, (v) => v <= experiment.maxSpreadCents!, "spread");
    if (reason) return reason;
  }
  if (experiment.minDepthContracts != null) {
    const reason = value(capture.executableDepthContracts, (v) => v >= experiment.minDepthContracts!, "depth");
    if (reason) return reason;
  }
  if (experiment.minLiquidityDollars != null) {
    const reason = value(capture.liquidityDollars, (v) => v >= experiment.minLiquidityDollars!, "liquidity");
    if (reason) return reason;
  }
  if (experiment.minPriorDirectionalMoveCents != null) {
    const reason = value(capture.priorDirectionalMoveCents, (v) => Math.abs(v) >= experiment.minPriorDirectionalMoveCents!, "prior_move");
    if (reason) return reason;
  }
  if (experiment.easternHours?.length && (capture.easternHour == null || !experiment.easternHours.includes(capture.easternHour))) return "time_of_day";
  if (experiment.includeWeekends === false && (capture.easternWeekday === 0 || capture.easternWeekday === 6)) return "weekend";
  if (!Number.isInteger(capture.entryPriceCents) || capture.entryPriceCents! <= 0 || capture.entryPriceCents! >= 100) return "entry_price";
  if (!Number.isInteger(capture.contracts) || capture.contracts! <= 0) return "contracts";
  return null;
}

function baseResult(capture: ReplayCapture, outcome: MarketOutcome, rejectionReason: string | null, deduped = false): ReplayTradeResult {
  const accepted = rejectionReason === null && !deduped;
  if (!accepted) {
    return { captureId: capture.captureId, timestampMs: capture.timestampMs, ticker: capture.ticker, series: capture.series, side: capture.side, accepted, deduped, rejectionReason: deduped ? "deduplicated" : rejectionReason, entryPriceCents: capture.entryPriceCents, contracts: capture.contracts, entryCostDollars: null, feeDollars: null, payoutDollars: null, grossPnlDollars: null, netPnlDollars: null, roi: null, marketOutcome: outcome, unresolved: outcome === null };
  }
  const cost = money((capture.entryPriceCents! * capture.contracts!) / 100);
  const fee = capture.contracts! * 0; // replaced by runReplay's configured deterministic fee
  return { captureId: capture.captureId, timestampMs: capture.timestampMs, ticker: capture.ticker, series: capture.series, side: capture.side, accepted, deduped, rejectionReason: null, entryPriceCents: capture.entryPriceCents, contracts: capture.contracts, entryCostDollars: cost, feeDollars: fee, payoutDollars: null, grossPnlDollars: null, netPnlDollars: null, roi: null, marketOutcome: outcome, unresolved: outcome === null };
}

export function runReplay(
  captures: readonly ReplayCapture[],
  outcomes: ReadonlyMap<string, Exclude<MarketOutcome, null>>,
  experiment: ReplayExperiment,
): ReplayResult {
  const seenTickers = new Set<string>();
  const trades = [...captures]
    .sort((a, b) => a.timestampMs - b.timestampMs || a.captureId.localeCompare(b.captureId))
    .map((capture) => {
      const outcome = outcomes.get(capture.ticker) ?? null;
      const rejection = rejects(capture, experiment);
      const deduped = rejection === null && experiment.oneTradePerMarket === true && seenTickers.has(capture.ticker);
      if (rejection === null && !deduped && experiment.oneTradePerMarket) seenTickers.add(capture.ticker);
      const result = baseResult(capture, outcome, rejection, deduped);
      if (!result.accepted) return result;
      const fee = money(result.contracts! * (experiment.feeDollarsPerContract ?? 0));
      if (outcome === null) return { ...result, feeDollars: fee };
      const won = outcome === capture.side;
      const payout = won ? result.contracts! : 0;
      const gross = money(payout - result.entryCostDollars!);
      const net = money(gross - fee);
      return { ...result, feeDollars: fee, payoutDollars: payout, grossPnlDollars: gross, netPnlDollars: net, roi: net / result.entryCostDollars!, unresolved: false };
    });
  return { experiment: { ...experiment }, trades, summary: summarizeReplay(trades) };
}

export function summarizeReplay(trades: readonly ReplayTradeResult[]): ReplaySummary {
  const accepted = trades.filter((trade) => trade.accepted);
  const resolved = accepted.filter((trade) => !trade.unresolved);
  const sum = (items: readonly ReplayTradeResult[], key: "entryCostDollars" | "feeDollars" | "payoutDollars" | "grossPnlDollars" | "netPnlDollars") =>
    items.reduce((total, item) => total + (item[key] ?? 0), 0);
  const entryCostDollars = sum(resolved, "entryCostDollars");
  const netPnlDollars = sum(resolved, "netPnlDollars");
  return { totalCaptures: trades.length, accepted: accepted.length, rejected: trades.filter((trade) => !trade.accepted && !trade.deduped).length, deduped: trades.filter((trade) => trade.deduped).length, resolved: resolved.length, unresolved: accepted.filter((trade) => trade.unresolved).length, wins: resolved.filter((trade) => (trade.payoutDollars ?? 0) > 0).length, losses: resolved.filter((trade) => (trade.payoutDollars ?? 0) === 0).length, entryCostDollars, feeDollars: sum(resolved, "feeDollars"), payoutDollars: sum(resolved, "payoutDollars"), grossPnlDollars: sum(resolved, "grossPnlDollars"), netPnlDollars, roi: entryCostDollars === 0 ? null : netPnlDollars / entryCostDollars };
}

/** Strict chronological split: records at/before the cutoff are train; later records are test. */
export function partitionChronologically<T extends { timestampMs: number }>(
  records: readonly T[],
  trainEndMs: number,
): ChronologicalPartition<T> {
  if (!Number.isFinite(trainEndMs)) throw new Error("trainEndMs must be finite");
  const sorted = [...records].sort((a, b) => a.timestampMs - b.timestampMs);
  return { train: sorted.filter((record) => record.timestampMs <= trainEndMs), test: sorted.filter((record) => record.timestampMs > trainEndMs) };
}