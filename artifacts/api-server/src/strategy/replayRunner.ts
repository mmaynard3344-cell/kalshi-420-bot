/**
 * Offline replay runner — orchestrates the full production pipeline simulation.
 *
 * Usage:
 *   import { runReplay } from "./strategy/replayRunner.js";
 *
 *   const result = runReplay(ticks, { persist: true });
 *   console.log(result.summary);
 *
 * What it does for each tick (in order):
 *   1. Detects window rollover → calls simulator.rollWindow()
 *   2. Merges partial state updates into the per-ticker state cache
 *      (mirrors autoTrader.ts mergeState(), kept local to avoid circular dep)
 *   3. Calls decide() with the merged state and injected tick timestamp
 *   4. For every TradeDecision, calls simulator.simulate()
 *   5. Records all evaluated ticks (those inside the 2-min gate)
 *   6. On completion, writes a <replayId>.json to data/replays/ atomically
 *
 * The result file permanently records:
 *   - The full ReplayConfig (strategy version + all guard constants)
 *   - Per-tick decision records with guard outcomes
 *   - A summary with trade/skip/zero-fill counts and total spend
 *
 * This makes every replay run independently reproducible after future
 * strategy changes — the stored config shows exactly what rules were active.
 */

import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { decide, STRATEGY_VERSION, STRATEGY_CONFIG } from "./decide.js";
import { Simulator } from "./simulator.js";
import type {
  ReplayTick,
  ReplayConfig,
  ReplayResult,
  ReplayTickRecord,
  ReplaySummary,
  SimResult,
  TradeDecision,
  SkipDecision,
  StrategyDecision,
  TimeBucket,
  BucketSeriesBreakdown,
  PriceBandBreakdown,
} from "./types.js";

// ── Default config (mirrors production autoTrader.ts / trade.ts constants) ────

export const DEFAULT_REPLAY_CONFIG: Omit<ReplayConfig, "strategyVersion"> = {
  alertMin:               STRATEGY_CONFIG.ALERT_MIN,
  alertMax:               STRATEGY_CONFIG.ALERT_MAX,
  timeAlertSeconds:       STRATEGY_CONFIG.TIME_ALERT_SECONDS,
  limitPriceBufferCents:  STRATEGY_CONFIG.LIMIT_PRICE_BUFFER_CENTS,
  betDollarsByTicker:     {
    KXBTC15M: STRATEGY_CONFIG.BTC_BET_DOLLARS,
    KXETH15M: STRATEGY_CONFIG.ETH_BET_DOLLARS,
  },
  orderCooldownMs:        3_000,
  dedupWindowMs:          20 * 60_000,
  maxDailyNotionalCents:  800_000,
  fillAssumption:         "full",
};

const DATA_DIR = join(process.cwd(), "data", "replays");

// ── Local state merge ─────────────────────────────────────────────────────────
// Mirrors autoTrader.ts mergeState(). Kept local to avoid importing from
// autoTrader.ts and creating a circular dependency.

interface LocalMarketState {
  ticker:    string;
  closeTime: string | null;
  yesBid:    number | null;
  yesAsk:    number | null;
  noBid:     number | null;
  noAsk:     number | null;
}

function mergeLocalState(
  tick: ReplayTick,
  prev: LocalMarketState | undefined,
): LocalMarketState {
  return {
    ticker:    tick.ticker,
    closeTime: tick.closeTime ?? prev?.closeTime ?? null,
    yesBid:    tick.yesBid   ?? prev?.yesBid    ?? null,
    yesAsk:    tick.yesAsk   ?? prev?.yesAsk    ?? null,
    noBid:     tick.noBid    ?? prev?.noBid     ?? null,
    noAsk:     tick.noAsk    ?? prev?.noAsk     ?? null,
  };
}

// ── Series lookup ─────────────────────────────────────────────────────────────

const TRACKED_SERIES = Object.keys(DEFAULT_REPLAY_CONFIG.betDollarsByTicker);

function seriesForTicker(ticker: string): string | undefined {
  return TRACKED_SERIES.find((s) => ticker.startsWith(s));
}

// ── Runner ────────────────────────────────────────────────────────────────────

export interface RunReplayOptions {
  /** Override any subset of the default config. strategyVersion is auto-set. */
  config?:  Partial<Omit<ReplayConfig, "strategyVersion">>;
  /**
   * Write result to data/replays/<replayId>.json (default: true).
   * Set to false for in-memory testing without disk I/O.
   */
  persist?: boolean;
  /**
   * Market settlement results keyed by full ticker.
   * When provided, the runner computes per-bucket and per-price-band P&L,
   * win rate, ROI, and expected value metrics.
   * Value: "yes" if the market resolved YES, "no" if NO.
   */
  marketResults?: Map<string, "yes" | "no">;
}

/**
 * Run the full replay pipeline over a sequence of normalized ticks.
 *
 * Ticks should be sorted ascending by timestampMs. Out-of-order ticks are
 * processed in the order given — the clock does not backtrack.
 *
 * @param ticks   Array of normalized market updates (see ReplayTick)
 * @param options Config overrides and persistence flag
 * @returns       Complete replay result including per-tick records and summary
 */
export function runReplay(
  ticks:   ReplayTick[],
  options: RunReplayOptions = {},
): ReplayResult {
  const config: ReplayConfig = {
    ...DEFAULT_REPLAY_CONFIG,
    ...options.config,
    strategyVersion: STRATEGY_VERSION,
  };

  const persist       = options.persist ?? true;
  const marketResults = options.marketResults ?? new Map<string, "yes" | "no">();
  const simulator  = new Simulator(config);

  /** series → current ticker */
  const currentTickers = new Map<string, string>();
  /** ticker → merged state */
  const marketStates   = new Map<string, LocalMarketState>();

  const records: ReplayTickRecord[] = [];
  const seenWindows     = new Set<string>(); // tickers with ≥1 in-gate tick

  let ticksEvaluated    = 0;
  let tradeCount        = 0;
  let zeroFillCount     = 0;
  let skippedByGuard    = 0;
  let skippedOutOfZone  = 0;
  let totalSpentDollars = 0;

  for (const tick of ticks) {
    const series = seriesForTicker(tick.ticker);
    if (!series) continue;

    // ── Window rollover detection ──────────────────────────────────────────
    const prevTicker = currentTickers.get(series);
    if (prevTicker !== tick.ticker) {
      simulator.rollWindow(prevTicker, tick.ticker);
      currentTickers.set(series, tick.ticker);
    }

    // ── State merge (preserves prior bid/ask when tick is partial) ─────────
    const prev  = marketStates.get(tick.ticker);
    const state = mergeLocalState(tick, prev);
    marketStates.set(tick.ticker, state);

    if (!state.closeTime) continue;

    // ── Strategy decisions ─────────────────────────────────────────────────
    const betDollars = config.betDollarsByTicker[series] ?? 100;
    const decisions  = decide({
      ticker:     tick.ticker,
      series,
      closeTime:  state.closeTime,
      yesBid:     state.yesBid,
      noBid:      state.noBid,
      betDollars,
      nowMs:      tick.timestampMs,
    });

    // Skip ticks that are entirely outside the time window (don't record them —
    // they'd create enormous output files for data sets with many historical ticks)
    const isOutsideTimeWindow =
      decisions.length === 1 &&
      decisions[0].action === "skip" &&
      (decisions[0] as SkipDecision).skipReason === "outside_time_window";

    if (isOutsideTimeWindow) continue;

    ticksEvaluated++;

    // ── Simulate each decision ─────────────────────────────────────────────
    const simResults: SimResult[] = [];

    for (const decision of decisions) {
      if (decision.action === "skip") {
        // Price was outside zone — record but don't simulate
        skippedOutOfZone++;
        simResults.push({ decision, guardOutcome: "cooldown" });
        continue;
      }

      const result = simulator.simulate(decision, tick.ticker, tick.timestampMs);
      simResults.push(result);
      seenWindows.add(tick.ticker);

      switch (result.guardOutcome) {
        case "filled":
          tradeCount++;
          totalSpentDollars += result.fill?.dollarsCost ?? 0;
          break;
        case "zero_fill":
          zeroFillCount++;
          break;
        default:
          skippedByGuard++;
          break;
      }
    }

    // ── Build display values from the first non-skip decision ──────────────
    const firstTrade = decisions.find((d): d is TradeDecision => d.action !== "skip") as TradeDecision | undefined;
    const firstSkip  = decisions[0] as StrategyDecision;

    const yesDerivedAsk =
      firstTrade?.yesDerivedAsk ??
      (firstSkip.action === "skip" ? (firstSkip as SkipDecision).yesDerivedAsk ?? null : null);
    const noDerivedAsk  =
      firstTrade?.noDerivedAsk ??
      (firstSkip.action === "skip" ? (firstSkip as SkipDecision).noDerivedAsk ?? null : null);
    const secondsLeft   =
      firstTrade?.secondsLeft ??
      (firstSkip.action === "skip" ? (firstSkip as SkipDecision).secondsLeft ?? null : null) ??
      null;

    records.push({
      tickMs:       tick.timestampMs,
      ticker:       tick.ticker,
      series,
      closeTime:    state.closeTime,
      yesBid:       state.yesBid,
      noBid:        state.noBid,
      secondsLeft,
      yesDerivedAsk,
      noDerivedAsk,
      simResults,
    });
  }

  // ── Assemble result ────────────────────────────────────────────────────────
  const summary: ReplaySummary = {
    ticksEvaluated,
    windowsEntered:   seenWindows.size,
    tradeCount,
    zeroFillCount,
    skippedByGuard,
    skippedOutOfZone,
    totalSpentDollars,
  };

  const timeBuckets = computeTimeBuckets(records, marketResults);
  const priceBands  = computePriceBands(records, marketResults);

  const result: ReplayResult = {
    replayId: randomUUID(),
    runAt:    new Date().toISOString(),
    config,
    summary,
    records,
    timeBuckets,
    priceBands,
  };

  if (persist) {
    saveReplay(result);
  }

  return result;
}

// ── Time-bucket and price-band breakdown ─────────────────────────────────────

const BUCKET_DEFS = [
  { label: "180–151s", upper: 180, lower: 151 },
  { label: "150–121s", upper: 150, lower: 121 },
  { label: "120–91s",  upper: 120, lower:  91 },
  { label: "90–61s",   upper:  90, lower:  61 },
  { label: "60–31s",   upper:  60, lower:  31 },
  { label: "30–0s",    upper:  30, lower:   0 },
] as const;

const PRICE_BAND_DEFS = [
  { label: "72–76¢", lower: 72, upper: 76 },
  { label: "77–81¢", lower: 77, upper: 81 },
  { label: "82–86¢", lower: 82, upper: 86 },
  { label: "87–90¢", lower: 87, upper: 90 },
] as const;

function zeroBucketSeries(): BucketSeriesBreakdown {
  return {
    candidateTrades: 0, executableCandidates: 0,
    wins: 0, losses: 0, winRate: null,
    totalPnlDollars: 0, totalCostDollars: 0, roi: null,
    avgEntryPriceCents: null, evPerContract: null, totalContracts: 0,
  };
}

/** Resolve per-fill P&L.  Returns null when marketResult is unknown. */
function fillPnl(
  side:         "yes" | "no",
  priceCents:   number,
  contracts:    number,
  marketResult: "yes" | "no" | undefined,
): { win: boolean; pnl: number } | null {
  if (marketResult == null) return null;
  const isWin = marketResult === side;
  const pnl   = isWin
    ? (100 - priceCents) * contracts / 100
    : -priceCents * contracts / 100;
  return { win: isWin, pnl };
}

function finaliseAccumulator(acc: {
  wins: number; losses: number;
  totalPnlDollars: number; totalCostDollars: number; totalContracts: number;
}) {
  const completed = acc.wins + acc.losses;
  return {
    winRate:            completed > 0  ? acc.wins / completed                      : null,
    // ROI and EV require market results — show null when none are available
    roi:                completed > 0  ? acc.totalPnlDollars / acc.totalCostDollars : null,
    // avgEntryPriceCents is meaningful even without market results
    avgEntryPriceCents: acc.totalContracts > 0
                          ? (acc.totalCostDollars * 100) / acc.totalContracts      : null,
    evPerContract:      completed > 0
                          ? acc.totalPnlDollars / acc.totalContracts               : null,
  };
}

/** Accumulate one fill into a mutable BucketSeriesBreakdown. */
function accumFill(
  acc:          BucketSeriesBreakdown,
  fill:         { contracts: number; priceCents: number; dollarsCost: number },
  side:         "yes" | "no",
  marketResult: "yes" | "no" | undefined,
): void {
  acc.executableCandidates++;
  acc.totalCostDollars += fill.dollarsCost;
  acc.totalContracts   += fill.contracts;
  const outcome = fillPnl(side, fill.priceCents, fill.contracts, marketResult);
  if (outcome) {
    if (outcome.win) acc.wins++; else acc.losses++;
    acc.totalPnlDollars += outcome.pnl;
  }
}

function computeTimeBuckets(
  records:       ReplayTickRecord[],
  marketResults: Map<string, "yes" | "no">,
): TimeBucket[] {
  return BUCKET_DEFS.map((def) => {
    const btc = zeroBucketSeries();
    const eth = zeroBucketSeries();

    for (const record of records) {
      const secs = record.secondsLeft;
      if (secs === null || secs < def.lower || secs > def.upper) continue;

      const mr     = marketResults.get(record.ticker);
      const isBtc  = record.series === "KXBTC15M";
      const series = isBtc ? btc : eth;

      for (const sr of record.simResults) {
        if (sr.decision.action === "skip") continue;
        const td   = sr.decision as TradeDecision;
        const side = td.signal.side;
        series.candidateTrades++;

        if (sr.guardOutcome === "filled" && sr.fill) {
          accumFill(series, sr.fill, side, mr);
        }
      }
    }

    const combined = {
      candidateTrades:     btc.candidateTrades     + eth.candidateTrades,
      executableCandidates: btc.executableCandidates + eth.executableCandidates,
      wins:                btc.wins                + eth.wins,
      losses:              btc.losses              + eth.losses,
      totalPnlDollars:     btc.totalPnlDollars     + eth.totalPnlDollars,
      totalCostDollars:    btc.totalCostDollars     + eth.totalCostDollars,
      totalContracts:      btc.totalContracts       + eth.totalContracts,
    };

    // Finalise derived fields on both series
    const btcDerived = finaliseAccumulator(btc);
    const ethDerived = finaliseAccumulator(eth);
    const comDerived = finaliseAccumulator(combined);

    Object.assign(btc, btcDerived);
    Object.assign(eth, ethDerived);

    return {
      label:              def.label,
      upperBoundSecs:     def.upper,
      lowerBoundSecs:     def.lower,
      ...combined,
      ...comDerived,
      btc,
      eth,
    } satisfies TimeBucket;
  });
}

function computePriceBands(
  records:       ReplayTickRecord[],
  marketResults: Map<string, "yes" | "no">,
): PriceBandBreakdown[] {
  return PRICE_BAND_DEFS.map((def) => {
    let executableCandidates = 0;
    let wins = 0, losses = 0;
    let totalPnlDollars = 0, totalCostDollars = 0, totalContracts = 0;

    for (const record of records) {
      const mr = marketResults.get(record.ticker);

      for (const sr of record.simResults) {
        if (sr.decision.action === "skip") continue;
        if (sr.guardOutcome !== "filled" || !sr.fill) continue;

        const td         = sr.decision as TradeDecision;
        const side       = td.signal.side;
        const priceCents = sr.fill.priceCents;
        if (priceCents < def.lower || priceCents > def.upper) continue;

        executableCandidates++;
        totalCostDollars += sr.fill.dollarsCost;
        totalContracts   += sr.fill.contracts;

        const outcome = fillPnl(side, priceCents, sr.fill.contracts, mr);
        if (outcome) {
          if (outcome.win) wins++; else losses++;
          totalPnlDollars += outcome.pnl;
        }
      }
    }

    const completed = wins + losses;
    return {
      label:               def.label,
      lowerCents:          def.lower,
      upperCents:          def.upper,
      executableCandidates,
      wins, losses,
      winRate:             completed > 0  ? wins / completed                  : null,
      totalPnlDollars,
      totalCostDollars,
      roi:                 totalCostDollars > 0
                             ? totalPnlDollars / totalCostDollars             : null,
      evPerContract:       totalContracts > 0
                             ? totalPnlDollars / totalContracts               : null,
      totalContracts,
    } satisfies PriceBandBreakdown;
  });
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Atomically write the replay result to data/replays/<replayId>.json.
 * Uses write-to-temp-then-rename to prevent corrupt files on crash.
 * Non-fatal: replay still returns the result even if the save fails.
 */
function saveReplay(result: ReplayResult): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const path = join(DATA_DIR, `${result.replayId}.json`);
    const tmp  = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(result, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    // Non-fatal — the caller still receives the full result in memory
  }
}
