/**
 * Shared types for the offline replay engine.
 *
 * These types define the contract between:
 *   decide.ts      — pure strategy signal function
 *   simulator.ts   — stateful pipeline guard simulator
 *   replayRunner.ts — orchestrator that feeds ticks through both
 *
 * No imports from live infrastructure (autoTrader, trade, kalshi*).
 */

// ── Tick input ─────────────────────────────────────────────────────────────────

/**
 * A single normalized market update fed into the replay engine.
 * Fields mirror autoTrader.ts MarketState; null means "not present in this
 * update" — the runner merges them with the prior cached state, just like
 * the live path does.
 */
export interface ReplayTick {
  /** Full market ticker, e.g. KXBTC15M-26JUL290445-45 */
  ticker:      string;
  closeTime:   string | null;
  yesBid:      number | null;  // integer cents
  yesAsk:      number | null;
  noBid:       number | null;
  noAsk:       number | null;
  /** Wall-clock ms when this update was received (replayed clock). */
  timestampMs: number;
}

// ── Strategy input / output ────────────────────────────────────────────────────

/** Input to the pure decide() function. */
export interface StrategyInput {
  ticker:     string;
  series:     string;  // series prefix, e.g. KXBTC15M
  closeTime:  string | null;
  yesBid:     number | null;
  noBid:      number | null;
  betDollars: number;
  /** Injected clock — Date.now() in live, tick.timestampMs in replay. */
  nowMs:      number;
}

/** A YES or NO signal produced by decide() when prices are in zone. */
export interface StrategySignal {
  side:          "yes" | "no";
  triggerCents:  number;   // derived ask that triggered (100 − opposite bid)
  limitCents:    number;   // trigger + buffer, capped at the series policy ceiling
  /** Max contracts at limit price given the full betDollars budget. */
  maxCount:      number;
}

export interface SkipDecision {
  action:         "skip";
  skipReason:     string;
  yesDerivedAsk?: number | null;
  noDerivedAsk?:  number | null;
  secondsLeft?:   number | null;
}

export interface TradeDecision {
  action:        "buy_yes" | "buy_no";
  signal:        StrategySignal;
  /** Original betDollars passed in — needed by the simulator's spend cap. */
  betDollars:    number;
  yesDerivedAsk: number | null;
  noDerivedAsk:  number | null;
  secondsLeft:   number;
}

export type StrategyDecision = SkipDecision | TradeDecision;

// ── Simulation results ────────────────────────────────────────────────────────

/**
 * Outcome returned by Simulator.simulate().
 *
 *  filled         — passed all guards; fill simulated at limit price
 *  zero_fill      — passed guards but fillAssumption="zero" (IOC expired)
 *  cooldown       — blocked by per-key cooldown timer
 *  window_budget  — window spend cap exhausted
 *  zero_contracts — remainingDollars too small for even one contract
 *  dedup          — order slot already claimed for this ticker+side
 *  daily_cap      — daily notional cap would be exceeded
 *  position_guard — existing position on same side would be reduced
 */
export type GuardOutcome =
  | "filled"
  | "zero_fill"
  | "cooldown"
  | "window_budget"
  | "zero_contracts"
  | "dedup"
  | "daily_cap"
  | "position_guard";

export interface SimulatedFill {
  contracts:   number;
  /** Limit price used (replay assumes fill at limit; see fillAssumption). */
  priceCents:  number;
  dollarsCost: number;
}

export interface SimResult {
  decision:     StrategyDecision;
  guardOutcome: GuardOutcome;
  fill?:        SimulatedFill;
}

// ── Replay configuration ───────────────────────────────────────────────────────

/**
 * Complete strategy + guard configuration snapshot.
 *
 * Stored verbatim in every replay result file so future engineers can
 * reproduce the exact run even after constants change.
 */
export interface ReplayConfig {
  /** Must match autoTrader.ts ALERT_MIN */
  alertMin:               number;
  /** Must match autoTrader.ts ALERT_MAX */
  alertMax:               number;
  /** Must match autoTrader.ts TIME_ALERT_SECONDS */
  timeAlertSeconds:       number;
  /** Must match autoTrader.ts LIMIT_PRICE_BUFFER_CENTS */
  limitPriceBufferCents:  number;
  /** Per-series bet cap in dollars, keyed by series prefix (e.g. KXBTC15M). */
  betDollarsByTicker:     Record<string, number>;
  /** Must match autoTrader.ts ORDER_COOLDOWN_MS */
  orderCooldownMs:        number;
  /** Must match trade.ts ORDER_DEDUP_WINDOW_MS */
  dedupWindowMs:          number;
  /** Must match trade.ts MAX_DAILY_NOTIONAL_CENTS */
  maxDailyNotionalCents:  number;
  /**
   * Fill assumption for simulated IOC orders.
   *  "full" — optimistic: assume full fill at limit price
   *  "zero" — pessimistic: assume IOC always expires unfilled
   */
  fillAssumption:         "full" | "zero";
  /**
   * Semver string from decide.ts STRATEGY_VERSION.
   * Bumped whenever signal logic changes, so replay results remain tied
   * to the exact rules that produced them.
   */
  strategyVersion:        string;
}

// ── Replay output ─────────────────────────────────────────────────────────────

/** One evaluated tick and its simulated outcomes. */
export interface ReplayTickRecord {
  tickMs:        number;
  ticker:        string;
  series:        string;
  closeTime:     string | null;
  yesBid:        number | null;
  noBid:         number | null;
  secondsLeft:   number | null;
  yesDerivedAsk: number | null;
  noDerivedAsk:  number | null;
  simResults:    SimResult[];
}

export interface ReplaySummary {
  /** Ticks that passed the TIME_ALERT_SECONDS gate (recorded). */
  ticksEvaluated:   number;
  /** Distinct market tickers that had ≥1 evaluated tick. */
  windowsEntered:   number;
  /** Simulated fills (guardOutcome === "filled"). */
  tradeCount:       number;
  /** Orders that passed guards but fill assumption produced a 0-fill. */
  zeroFillCount:    number;
  /** Ticks in zone that were blocked by a guard (cooldown/dedup/cap/etc.). */
  skippedByGuard:   number;
  /** Evaluated ticks where price was outside the 72–90¢ zone. */
  skippedOutOfZone: number;
  totalSpentDollars: number;
}

export interface ReplayResult {
  replayId:   string;
  runAt:      string;          // ISO timestamp of when the replay was run
  config:     ReplayConfig;    // complete config snapshot — enables future reproduction
  summary:    ReplaySummary;
  records:    ReplayTickRecord[];
  /** Per-30-second time-bucket breakdown, ordered 180→0 s. Present when runReplay produces it. */
  timeBuckets?: TimeBucket[];
  /** Per-5¢ price-band breakdown across ALERT_MIN–ALERT_MAX. Present when runReplay produces it. */
  priceBands?:  PriceBandBreakdown[];
}

// ── Time-bucket and price-band breakdown ────────────────────────────────────────

/**
 * Aggregated stats for one 30-second evaluation window.
 * Buckets are defined by seconds remaining before close:
 *   180–151 s, 150–121 s, 120–91 s, 90–61 s, 60–31 s, 30–0 s
 */
export interface TimeBucket {
  /** Human-readable label, e.g. "90–61s". */
  label:              string;
  /** Inclusive upper bound in seconds (closer to open, e.g. 90 in "90–61s"). */
  upperBoundSecs:     number;
  /** Inclusive lower bound in seconds (closer to close, e.g. 61 in "90–61s"). */
  lowerBoundSecs:     number;
  /** TradeDecisions that entered this bucket (price in zone + time gate). */
  candidateTrades:    number;
  /** Candidates that passed all guards (guardOutcome === "filled"). */
  executableCandidates: number;
  /** Filled trades where the market resolved in our favour. */
  wins:               number;
  /** Filled trades where the market resolved against us. */
  losses:             number;
  /**
   * wins / (wins + losses).  Null when no completed trades in this bucket
   * (market result unknown or no fills).
   */
  winRate:            number | null;
  /** Sum of (payout − cost) in dollars across all completed trades. */
  totalPnlDollars:    number;
  /** Sum of fill cost in dollars across all filled trades. */
  totalCostDollars:   number;
  /** totalPnlDollars / totalCostDollars.  Null when totalCostDollars === 0. */
  roi:                number | null;
  /** Weighted average fill price in cents across all filled trades. */
  avgEntryPriceCents: number | null;
  /** totalPnlDollars / totalContracts.  Null when totalContracts === 0. */
  evPerContract:      number | null;
  /** Total contracts across all filled trades in this bucket. */
  totalContracts:     number;
  btc:                BucketSeriesBreakdown;
  eth:                BucketSeriesBreakdown;
}

/** Per-series stats within one time bucket. */
export interface BucketSeriesBreakdown {
  candidateTrades:    number;
  executableCandidates: number;
  wins:               number;
  losses:             number;
  winRate:            number | null;
  totalPnlDollars:    number;
  totalCostDollars:   number;
  roi:                number | null;
  avgEntryPriceCents: number | null;
  evPerContract:      number | null;
  totalContracts:     number;
}

/** Aggregated stats for one 5-cent price band within ALERT_MIN–ALERT_MAX. */
export interface PriceBandBreakdown {
  /** Human-readable label, e.g. "72–76¢". */
  label:               string;
  lowerCents:          number;
  upperCents:          number;
  executableCandidates: number;
  wins:                number;
  losses:              number;
  winRate:             number | null;
  totalPnlDollars:     number;
  totalCostDollars:    number;
  roi:                 number | null;
  evPerContract:       number | null;
  totalContracts:      number;
}
