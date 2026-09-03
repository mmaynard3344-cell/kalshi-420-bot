/**
 * End-to-end equivalence test: production path vs replay engine.
 *
 * Validates that the Simulator (replay engine) produces identical outputs to
 * the ProductionHarness — an independent, from-scratch re-implementation of
 * the autoTrader.ts placeOrder() guard pipeline — for every tick in a
 * deterministic multi-window fixture.
 *
 * Test strategy
 * ─────────────
 * Both paths:
 *   1. Call decide() from decide.ts (shared pure function — identical by definition)
 *   2. Run each TradeDecision through the same seven guards in the same order
 *   3. Return a SimResult with the same { guardOutcome, fill } for every tick
 *
 * The ProductionHarness is written independently of Simulator so that any
 * divergence in guard order, state transitions, or arithmetic surfaces as a
 * test failure.  If both implementations agree on every field for every tick,
 * the replay engine is validated against the production strategy.
 *
 * Guard order modelled (matches autoTrader.ts placeOrder() exactly)
 * ─────────────────────────────────────────────────────────────────
 *   1. Cooldown        — entry set on the way through (not only on fill)
 *   2. Per-window spend — keyed by ticker (YES+NO share same bucket)
 *   3. Contract count  — zero_contracts when remainingDollars < 1 contract
 *   4. Dedup slot      — claimed atomically; released on cap/position/zero-fill
 *   5. Daily cap       — tryReserve with injected nowMs
 *   6. Position guard  — cross-side only: NO after YES, or YES after NO
 *   7. Fill            — full fill at limit price (or zero fill per config)
 *
 *   Kill switch: always OFF (not modelled — no historical toggle record).
 *
 * Fixture coverage
 * ────────────────
 *   Main fixture (6 ticks, 2 BTC windows + 1 ETH window):
 *     W1-BTC-A  T0        YES fill         90¢ trigger → 91¢ limit
 *     W1-ETH-A  T0+500    NO fill          92¢ trigger → 92¢ limit
 *     W1-ETH-B  T0+1000   outside_price_zone (50¢, out of 90-92 zone)
 *     W1-BTC-B  T0+2000   cooldown         2 s < 3 s ORDER_COOLDOWN_MS
 *     W1-BTC-C  T0+4000   zero_contracts   budget exhausted after W1-BTC-A
 *     W2-BTC-A  T0+20000  YES fill         window rollover → fresh state
 *
 *   Additional it() blocks:
 *     daily_cap    — cap set below single-trade notional → daily_cap on first tick
 *     zero_fill    — fillAssumption:"zero" → both ticks zero_fill (dedup released)
 *     position_guard — direct simulate() calls; position seeded by YES fill
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  contractsForPrice,
  STRATEGY_VERSION,
} from "./decide.js";
import { Simulator } from "./simulator.js";
import { runReplay, DEFAULT_REPLAY_CONFIG } from "./replayRunner.js";
import {
  tryReserve,
  releaseCents,
  type DailyBudgetState,
} from "../lib/dailyBudget.js";
import type {
  ReplayConfig,
  ReplayTick,
  SimResult,
  SimulatedFill,
  StrategyDecision,
  TradeDecision,
  SkipDecision,
  GuardOutcome,
} from "./types.js";

// ── Shared config ──────────────────────────────────────────────────────────────

const CONFIG: ReplayConfig = {
  ...DEFAULT_REPLAY_CONFIG,
  strategyVersion: STRATEGY_VERSION,
  // Fixtures in this file are pinned to a $600 bet (652 contracts @92¢
  // etc.). Pin it here so the equivalence checks stay deterministic even when
  // the live BET_DOLLARS changes; the "defaults mirror live constants" test
  // below still asserts DEFAULT_REPLAY_CONFIG tracks the live value.
  betDollarsByTicker: { KXBTC15M: 600, KXETH15M: 600 },
};

// ── Fixture constants ─────────────────────────────────────────────────────────

/**
 * Fixed deterministic base timestamp.
 * 2025-06-15T22:13:20.000Z — arbitrary; chosen to be stable across test runs.
 */
const T0 = 1_750_000_000_000;

// Synthetic test tickers — start with the right series prefix so
// seriesForTicker() matches them to KXBTC15M / KXETH15M.
const BTC_W1 = "KXBTC15M-EQVTEST-W1";
const BTC_W2 = "KXBTC15M-EQVTEST-W2";
const ETH_W1 = "KXETH15M-EQVTEST-W1";

// Close times chosen so that all fixture ticks are inside the 120-second window.
//   secondsLeft = floor((closeTime - tickMs) / 1000)
//   W1 ticks run from T0 to T0+4000; close is T0+90000 → secondsLeft 86-90 ≤ 120 ✓
//   W2 tick is at T0+20000;           close is T0+110000 → secondsLeft 90 ≤ 120 ✓
const BTC_W1_CLOSE = new Date(T0 + 90_000).toISOString();
const ETH_W1_CLOSE = new Date(T0 + 90_000).toISOString();
const BTC_W2_CLOSE = new Date(T0 + 110_000).toISOString();

/**
 * Main fixture: 6 ticks, sorted ascending by timestampMs.
 *
 * Expected outcomes (derived manually — used as ground truth in comments):
 *
 *   W1-BTC-A  buy_yes  limit=91¢  count=floor(600/0.91)=659  cost=$599.69  → filled
 *   W1-ETH-A  buy_no   limit=93¢  count=floor(600/0.93)=645   cost=$599.85  → filled
 *   W1-ETH-B  skip(outside_price_zone)                                      → "cooldown" (runner convention)
 *   W1-BTC-B  buy_yes  (cooldown: 2000ms < 3000ms)                          → cooldown
 *   W1-BTC-C  buy_yes  (past cooldown; remaining=$0.31; count=0)            → zero_contracts
 *   W2-BTC-A  buy_yes  limit=91¢  count=659  cost=$599.69  (fresh window)   → filled
 */
const MAIN_FIXTURE: ReplayTick[] = [
  // W1-BTC-A: noBid=10 → yesDerivedAsk=100-10=90 (inside the current band)
  //           yesBid=99 → noDerivedAsk=100-99=1 (out of zone)
  {
    ticker:      BTC_W1,
    closeTime:   BTC_W1_CLOSE,
    yesBid:      99,
    yesAsk:      null,
    noBid:       10,
    noAsk:       null,
    timestampMs: T0,
  },
  // W1-ETH-A: yesBid=8 → noDerivedAsk=92 (at the ETH entry cap)
  //           noBid=99  → yesDerivedAsk=1  (out of zone)
  {
    ticker:      ETH_W1,
    closeTime:   ETH_W1_CLOSE,
    yesBid:      8,
    yesAsk:      null,
    noBid:       99,
    noAsk:       null,
    timestampMs: T0 + 500,
  },
  // W1-ETH-B: yesBid=50, noBid=50 → both derived asks=50¢ (below zone floor 90¢)
  {
    ticker:      ETH_W1,
    closeTime:   ETH_W1_CLOSE,
    yesBid:      50,
    yesAsk:      null,
    noBid:       50,
    noAsk:       null,
    timestampMs: T0 + 1_000,
  },
  // W1-BTC-B: same prices as W1-BTC-A; 2 s after W1-BTC-A → YES cooldown
  {
    ticker:      BTC_W1,
    closeTime:   BTC_W1_CLOSE,
    yesBid:      99,
    yesAsk:      null,
    noBid:       10,
    noAsk:       null,
    timestampMs: T0 + 2_000,
  },
  // W1-BTC-C: 4 s after W1-BTC-A → past cooldown; but $599.69 already spent,
  //           $0.31 remaining, count=floor(0.31/0.91)=0 → zero_contracts
  {
    ticker:      BTC_W1,
    closeTime:   BTC_W1_CLOSE,
    yesBid:      99,
    yesAsk:      null,
    noBid:       10,
    noAsk:       null,
    timestampMs: T0 + 4_000,
  },
  // W2-BTC-A: new window → rollover clears W1 state; fresh YES fill
  {
    ticker:      BTC_W2,
    closeTime:   BTC_W2_CLOSE,
    yesBid:      99,
    yesAsk:      null,
    noBid:       10,
    noAsk:       null,
    timestampMs: T0 + 20_000,
  },
];

// ── Local state merge ──────────────────────────────────────────────────────────
// Mirrors replayRunner.ts mergeLocalState() — used by both runReplay() and
// runHarness() so both pipelines merge state identically.

interface LocalState {
  ticker:    string;
  closeTime: string | null;
  yesBid:    number | null;
  noBid:     number | null;
}

function mergeLocalState(
  tick: ReplayTick,
  prev: LocalState | undefined,
): LocalState {
  return {
    ticker:    tick.ticker,
    closeTime: tick.closeTime ?? prev?.closeTime ?? null,
    yesBid:    tick.yesBid   ?? prev?.yesBid    ?? null,
    noBid:     tick.noBid    ?? prev?.noBid     ?? null,
  };
}

// ── Series lookup ──────────────────────────────────────────────────────────────

const TRACKED_SERIES = Object.keys(DEFAULT_REPLAY_CONFIG.betDollarsByTicker);

function seriesForTicker(ticker: string): string | undefined {
  return TRACKED_SERIES.find((s) => ticker.startsWith(s));
}

// ── Production Harness ─────────────────────────────────────────────────────────

/**
 * Independent re-implementation of the autoTrader.ts placeOrder() guard pipeline.
 *
 * Written separately from Simulator to cross-validate equivalence.
 * Any difference between this class and Simulator will surface as a test failure.
 *
 * Uses injected nowMs in place of Date.now() throughout, matching Simulator's
 * approach and making the test fully deterministic.
 */
class ProductionHarness {
  /** "${ticker}-${SIDE}" → last-attempt ms. Mirrors orderCooldown in autoTrader.ts. */
  private readonly cooldown     = new Map<string, number>();
  /** ticker → dollars spent this window. Mirrors spendTracker in autoTrader.ts. */
  private readonly spendTracker = new Map<string, number>();
  /** "${ticker}-${SIDE}" → placed-at ms. Mirrors recentOrders / claimOrderSlot. */
  private readonly recentOrders = new Map<string, number>();
  /** Full ticker → signed position (+YES, -NO). Mirrors getSignedPosition(). */
  private readonly positions    = new Map<string, number>();
  /** Daily budget state — mutated in place via tryReserve/releaseCents. */
  private budget: DailyBudgetState = { date: "", spentCents: 0 };

  constructor(private readonly config: ReplayConfig) {}

  /**
   * Clear per-window state when a ticker rolls over.
   * Mirrors handleWindowRollover() in autoTrader.ts.
   */
  rollWindow(prevTicker: string | undefined): void {
    if (!prevTicker) return;
    this.spendTracker.delete(prevTicker);
    for (const k of [...this.cooldown.keys()]) {
      if (k.startsWith(prevTicker)) this.cooldown.delete(k);
    }
    for (const k of [...this.recentOrders.keys()]) {
      if (k.startsWith(prevTicker)) this.recentOrders.delete(k);
    }
    // Positions keyed by full ticker — not cleared on rollover.
    // The next window's ticker starts at 0 because its key has never been seen.
  }

  /**
   * Run one StrategyDecision through the complete placeOrder() guard pipeline.
   * Returns a SimResult with guardOutcome and optional fill, matching Simulator's
   * output format exactly.
   */
  simulate(
    decision: StrategyDecision,
    ticker:   string,
    nowMs:    number,
  ): SimResult {
    // Skip decisions: price was outside zone — not sent to the guard pipeline.
    // Mirrors replayRunner.ts lines 191-196.
    if (decision.action === "skip") {
      return { decision, guardOutcome: "cooldown" };
    }

    const d                      = decision as TradeDecision;
    const { signal, betDollars } = d;
    const { side, limitCents }   = signal;
    const key                    = `${ticker}-${side.toUpperCase()}`;

    // ── 1. Cooldown ────────────────────────────────────────────────────────────
    // autoTrader.ts:311-316.  Entry is SET on the way through (before guards 2-7),
    // matching the live path: a cooldown-blocked tick still advances the timestamp.
    const lastAttempt = this.cooldown.get(key) ?? 0;
    if (nowMs - lastAttempt < this.config.orderCooldownMs) {
      return { decision, guardOutcome: "cooldown" };
    }
    this.cooldown.set(key, nowMs);

    // ── 2. Per-window spend cap ────────────────────────────────────────────────
    // autoTrader.ts:319-325.  Spend key = ticker only (YES + NO share budget).
    const spendKey         = ticker;
    const alreadySpent     = this.spendTracker.get(spendKey) ?? 0;
    const remainingDollars = betDollars - alreadySpent;
    if (remainingDollars <= 0) {
      return { decision, guardOutcome: "window_budget" };
    }

    // ── 3. Contract count ──────────────────────────────────────────────────────
    // autoTrader.ts:327-331.  Uses remaining, not full betDollars.
    const count = contractsForPrice(limitCents, remainingDollars);
    if (count === 0) {
      return { decision, guardOutcome: "zero_contracts" };
    }

    // (Kill switch: always OFF — not modelled in replay.)

    // ── 4. Dedup slot ──────────────────────────────────────────────────────────
    // autoTrader.ts:342-346 — mirrors claimOrderSlot() in trade.ts.
    // Expire stale entries first, then claim.
    // Slot is KEPT on full fill; RELEASED on daily_cap, position_guard, zero fill.
    for (const [k, ts] of this.recentOrders) {
      if (nowMs - ts > this.config.dedupWindowMs) this.recentOrders.delete(k);
    }
    if (this.recentOrders.has(key)) {
      return { decision, guardOutcome: "dedup" };
    }
    this.recentOrders.set(key, nowMs); // claim slot

    // ── 5. Daily notional cap ──────────────────────────────────────────────────
    // autoTrader.ts:348-354.  Release dedup slot before returning if blocked.
    const notionalCents = count * limitCents;
    const reserveResult = tryReserve(
      this.budget,
      notionalCents,
      this.config.maxDailyNotionalCents,
      new Date(nowMs), // injected clock — mirrors simulator.ts:180
    );
    if (!reserveResult.ok) {
      this.recentOrders.delete(key); // release slot — autoTrader.ts:350
      return { decision, guardOutcome: "daily_cap" };
    }
    this.budget = reserveResult.next;

    // unwind(): release slot + notional — called on position_guard block and zero fill.
    // Matches autoTrader.ts:356-359 and the calls at lines 367 and 440.
    const unwind = (): void => {
      this.recentOrders.delete(key);
      this.budget = releaseCents(this.budget, notionalCents);
    };

    // ── 6. Position guard ──────────────────────────────────────────────────────
    // autoTrader.ts:364-365.  Cross-side only:
    //   NO would close a YES position  →  (side==="no"  && position>0)
    //   YES would close a NO position  →  (side==="yes" && position<0)
    const position  = this.positions.get(ticker) ?? 0;
    const wouldClose =
      (side === "no"  && position > 0) ||
      (side === "yes" && position < 0);
    if (wouldClose) {
      unwind();
      return { decision, guardOutcome: "position_guard" };
    }

    // ── 7. Fill simulation ─────────────────────────────────────────────────────
    if (this.config.fillAssumption === "zero") {
      // IOC expired without fill — autoTrader.ts:440 calls unwind().
      unwind();
      return { decision, guardOutcome: "zero_fill" };
    }

    // Full fill at limit price (conservative upper bound; no per-fill price data).
    const dollarsCost = (count * limitCents) / 100;
    this.spendTracker.set(spendKey, alreadySpent + dollarsCost);

    // Update signed position: YES fill → +count, NO fill → -count.
    // Matches getSignedPosition() sign convention in trade.ts.
    const delta = side === "yes" ? count : -count;
    this.positions.set(ticker, (this.positions.get(ticker) ?? 0) + delta);

    const fill: SimulatedFill = { contracts: count, priceCents: limitCents, dollarsCost };
    return { decision, guardOutcome: "filled", fill };
  }
}

// ── Harness runner ─────────────────────────────────────────────────────────────

interface HarnessRecord {
  tickMs:     number;
  ticker:     string;
  simResults: SimResult[];
}

/**
 * Process a tick sequence through the ProductionHarness.
 *
 * Mirrors runReplay() in replayRunner.ts step-for-step:
 *   • Same rollover detection logic
 *   • Same state merge (mergeLocalState)
 *   • Same outside_time_window filter
 *   • Same skip-decision handling (guardOutcome:"cooldown" convention)
 *
 * This ensures both pipelines are driven identically, so any difference in
 * their SimResult outputs reflects a genuine guard-pipeline divergence.
 */
function runHarness(
  ticks:  ReplayTick[],
  config: ReplayConfig,
): HarnessRecord[] {
  const harness        = new ProductionHarness(config);
  const currentTickers = new Map<string, string>();
  const marketStates   = new Map<string, LocalState>();
  const records: HarnessRecord[] = [];

  for (const tick of ticks) {
    const series = seriesForTicker(tick.ticker);
    if (!series) continue;

    // Window rollover detection — mirrors replayRunner.ts:151-155.
    const prevTicker = currentTickers.get(series);
    if (prevTicker !== tick.ticker) {
      harness.rollWindow(prevTicker);
      currentTickers.set(series, tick.ticker);
    }

    // State merge — mirrors replayRunner.ts:158-160.
    const prev  = marketStates.get(tick.ticker);
    const state = mergeLocalState(tick, prev);
    marketStates.set(tick.ticker, state);

    if (!state.closeTime) continue;

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

    // Filter outside_time_window ticks — mirrors replayRunner.ts:178-183.
    const isOutsideTimeWindow =
      decisions.length === 1 &&
      decisions[0].action === "skip" &&
      (decisions[0] as SkipDecision).skipReason === "outside_time_window";
    if (isOutsideTimeWindow) continue;

    const simResults: SimResult[] = [];
    for (const decision of decisions) {
      if (decision.action === "skip") {
        // outside_price_zone — recorded with guardOutcome:"cooldown" by convention
        // (mirrors replayRunner.ts:191-196).
        simResults.push({ decision, guardOutcome: "cooldown" });
        continue;
      }
      simResults.push(harness.simulate(decision, tick.ticker, tick.timestampMs));
    }

    records.push({ tickMs: tick.timestampMs, ticker: tick.ticker, simResults });
  }

  return records;
}

// ── Assertion helper ───────────────────────────────────────────────────────────

/**
 * Assert field-by-field equality between replay and harness SimResult arrays
 * for one tick, reporting position information on failure.
 *
 * Fields checked:
 *   guardOutcome · decision.action · signal.side · signal.triggerCents
 *   signal.limitCents · signal.maxCount · betDollars ·
 *   fill presence · fill.contracts · fill.priceCents · fill.dollarsCost
 */
function assertSimResultsEqual(
  replayResults:  SimResult[],
  harnessResults: SimResult[],
  tickLabel:      string,
): void {
  assert.strictEqual(
    replayResults.length,
    harnessResults.length,
    `${tickLabel}: simResults.length`,
  );

  for (let i = 0; i < replayResults.length; i++) {
    const r   = replayResults[i];
    const h   = harnessResults[i];
    const ctx = `${tickLabel} result[${i}]`;

    // Guard outcome — the primary equivalence claim
    assert.strictEqual(r.guardOutcome, h.guardOutcome, `${ctx}: guardOutcome`);

    // Decision fields — both pipelines call decide() on the same input, so
    // these should match by construction; any divergence indicates a runner bug.
    assert.strictEqual(r.decision.action, h.decision.action, `${ctx}: decision.action`);

    if (r.decision.action !== "skip" && h.decision.action !== "skip") {
      const rd = r.decision as TradeDecision;
      const hd = h.decision as TradeDecision;
      assert.strictEqual(rd.signal.side,          hd.signal.side,          `${ctx}: signal.side`);
      assert.strictEqual(rd.signal.triggerCents,  hd.signal.triggerCents,  `${ctx}: signal.triggerCents`);
      assert.strictEqual(rd.signal.limitCents,    hd.signal.limitCents,    `${ctx}: signal.limitCents`);
      assert.strictEqual(rd.signal.maxCount,      hd.signal.maxCount,      `${ctx}: signal.maxCount`);
      assert.strictEqual(rd.betDollars,           hd.betDollars,           `${ctx}: betDollars`);
    }

    // Fill presence
    assert.strictEqual(r.fill != null, h.fill != null, `${ctx}: fill presence`);

    if (r.fill && h.fill) {
      assert.strictEqual(r.fill.contracts,  h.fill.contracts,  `${ctx}: fill.contracts`);
      assert.strictEqual(r.fill.priceCents, h.fill.priceCents, `${ctx}: fill.priceCents`);
      // dollarsCost is floating-point — compare to 4 decimal places
      assert.ok(
        Math.abs(r.fill.dollarsCost - h.fill.dollarsCost) < 0.0001,
        `${ctx}: fill.dollarsCost (replay=${r.fill.dollarsCost}, harness=${h.fill.dollarsCost})`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Equivalence: production path vs replay engine", () => {

  // ── Main fixture ─────────────────────────────────────────────────────────────

  it("main fixture: every guard outcome and fill field matches on all 6 ticks", () => {
    const replayResult   = runReplay(MAIN_FIXTURE, { persist: false, config: CONFIG });
    const harnessRecords = runHarness(MAIN_FIXTURE, CONFIG);

    assert.strictEqual(replayResult.records.length, harnessRecords.length, "tick count");
    for (let i = 0; i < replayResult.records.length; i++) {
      const replayRec  = replayResult.records[i];
      const harnessRec = harnessRecords[i];
      const label      = `tick[${i}] ${replayRec.ticker} @${replayRec.tickMs}`;

      assert.strictEqual(replayRec.tickMs, harnessRec.tickMs, `${label}: tickMs`);
      assert.strictEqual(replayRec.ticker, harnessRec.ticker, `${label}: ticker`);

      assertSimResultsEqual(replayRec.simResults, harnessRec.simResults, label);
    }
  });

  // Verify the concrete guard outcome on each tick so the test fails informatively
  // if the fixture produces an unexpected sequence.
  it("main fixture: guard outcome sequence matches expected values", () => {
    const result = runReplay(MAIN_FIXTURE, { persist: false, config: CONFIG });

    // Extract first simResult.guardOutcome per tick (one decision per tick in fixture)
    const outcomes = result.records.map((r) => ({
      ticker:  r.ticker,
      tickMs:  r.tickMs,
      outcome: r.simResults[0].guardOutcome,
    }));

    const expected = [
      { ticker: BTC_W1, tickMs: T0,          outcome: "filled"         as GuardOutcome },
      { ticker: ETH_W1, tickMs: T0 + 500,    outcome: "filled"         as GuardOutcome },
      { ticker: ETH_W1, tickMs: T0 + 1_000,  outcome: "cooldown"       as GuardOutcome }, // price skip
      { ticker: BTC_W1, tickMs: T0 + 2_000,  outcome: "cooldown"       as GuardOutcome }, // time cooldown
      { ticker: BTC_W1, tickMs: T0 + 4_000,  outcome: "zero_contracts" as GuardOutcome }, // budget exhausted
      { ticker: BTC_W2, tickMs: T0 + 20_000, outcome: "filled"         as GuardOutcome }, // fresh window
    ];

    assert.strictEqual(outcomes.length, expected.length, "Recorded tick count");
    for (let i = 0; i < result.records.length; i++) {
      assert.strictEqual(outcomes[i].ticker,  expected[i].ticker,  `tick[${i}]: ticker`);
      assert.strictEqual(outcomes[i].tickMs,  expected[i].tickMs,  `tick[${i}]: tickMs`);
      assert.strictEqual(outcomes[i].outcome, expected[i].outcome, `tick[${i}]: guardOutcome`);
    }
  });

  it("main fixture: fill amounts match expected arithmetic on filled ticks", () => {
    const expectedFill = (index: number) => index === 1
      ? { contracts: 645, limitCents: 93, cost: (645 * 93) / 100 } // ETH at 93¢
      : { contracts: 659, limitCents: 91, cost: (659 * 91) / 100 }; // BTC at 91¢

    const result         = runReplay(MAIN_FIXTURE, { persist: false, config: CONFIG });
    const harnessRecords = runHarness(MAIN_FIXTURE, CONFIG);

    const filledIndexes = [0, 1, 5]; // W1-BTC-A, W1-ETH-A, W2-BTC-A
    for (const i of filledIndexes) {
      const rf = result.records[i].simResults[0].fill;
      const hf = harnessRecords[i].simResults[0].fill;
      const expected = expectedFill(i);

      assert.ok(rf, `replay tick[${i}]: fill must be present`);
      assert.ok(hf, `harness tick[${i}]: fill must be present`);

      assert.strictEqual(rf.contracts,  expected.contracts,   `replay tick[${i}]: contracts`);
      assert.strictEqual(rf.priceCents, expected.limitCents,  `replay tick[${i}]: priceCents`);
      assert.ok(
        Math.abs(rf.dollarsCost - expected.cost) < 0.0001,
        `replay tick[${i}]: dollarsCost expected ${expected.cost}, got ${rf.dollarsCost}`,
      );

      assert.strictEqual(hf.contracts,  expected.contracts,   `harness tick[${i}]: contracts`);
      assert.strictEqual(hf.priceCents, expected.limitCents,  `harness tick[${i}]: priceCents`);
      assert.ok(
        Math.abs(hf.dollarsCost - expected.cost) < 0.0001,
        `harness tick[${i}]: dollarsCost expected ${expected.cost}, got ${hf.dollarsCost}`,
      );
    }
  });

  // ── Daily cap ────────────────────────────────────────────────────────────────

  it("daily_cap: both paths block the trade when cap is below single-trade notional", () => {
    // 659 contracts × 91¢ = 59969¢. Cap of 1000¢ is well below this → daily_cap.
    const LOW_CAP = 1_000;

    const SINGLE_TICK: ReplayTick[] = [
      {
        ticker:      BTC_W1,
        closeTime:   BTC_W1_CLOSE,
        yesBid:      99,
        yesAsk:      null,
        noBid:       10,   // yesDerivedAsk=90 (inside the current band)
        noAsk:       null,
        timestampMs: T0,
      },
    ];

    // Pin a $600 bet so the single-trade notional (659 × 91¢ = 59969¢) always
    // exceeds LOW_CAP regardless of the live BET_DOLLARS value.
    const lowCapConfig: ReplayConfig = {
      ...CONFIG,
      maxDailyNotionalCents: LOW_CAP,
      betDollarsByTicker: { KXBTC15M: 600, KXETH15M: 600 },
    };
    const replayResult   = runReplay(SINGLE_TICK, { persist: false, config: lowCapConfig });
    const harnessRecords = runHarness(SINGLE_TICK, lowCapConfig);

    assert.strictEqual(replayResult.records.length, harnessRecords.length, "tick count");
    for (let i = 0; i < replayResult.records.length; i++) {
      assertSimResultsEqual(
        replayResult.records[i].simResults,
        harnessRecords[i].simResults,
        `daily_cap tick[${i}]`,
      );
    }

    // Confirm both agreed on daily_cap
    const replayOutcome  = replayResult.records[0].simResults[0].guardOutcome;
    const harnessOutcome = harnessRecords[0].simResults[0].guardOutcome;
    assert.strictEqual(replayOutcome,  "daily_cap", "replay: expected daily_cap");
    assert.strictEqual(harnessOutcome, "daily_cap", "harness: expected daily_cap");
  });

  // ── Zero-fill ────────────────────────────────────────────────────────────────

  it("zero_fill: both paths return zero_fill and release dedup so the next tick retries", () => {
    // fillAssumption:"zero" → every IOC order expires; dedup slot released each time.
    // With cooldown=0, consecutive ticks can retry without waiting.
    const ZERO_CONFIG: ReplayConfig = {
      ...CONFIG,
      fillAssumption:  "zero",
      orderCooldownMs: 0,
    };

    const ZERO_TICKS: ReplayTick[] = [
      {
        ticker:      BTC_W1,
        closeTime:   BTC_W1_CLOSE,
        yesBid:      99,
        yesAsk:      null,
        noBid:       10,   // yesDerivedAsk=90 (inside the current band)
        noAsk:       null,
        timestampMs: T0,
      },
      // T0+5000: dedup was released by first zero_fill → passes dedup; zero_fills again
      {
        ticker:      BTC_W1,
        closeTime:   BTC_W1_CLOSE,
        yesBid:      99,
        yesAsk:      null,
        noBid:       10,
        noAsk:       null,
        timestampMs: T0 + 5_000,
      },
    ];

    const replayResult   = runReplay(ZERO_TICKS, { persist: false, config: ZERO_CONFIG });
    const harnessRecords = runHarness(ZERO_TICKS, ZERO_CONFIG);

    assert.strictEqual(replayResult.records.length, harnessRecords.length, "tick count");
    for (let i = 0; i < replayResult.records.length; i++) {
      assertSimResultsEqual(
        replayResult.records[i].simResults,
        harnessRecords[i].simResults,
        `zero_fill tick[${i}]`,
      );
    }

    // Confirm both ticks are zero_fill (not dedup-blocked on retry)
    const replayOutcomes  = replayResult.records.map((r) => r.simResults[0].guardOutcome);
    const harnessOutcomes = harnessRecords.map((r) => r.simResults[0].guardOutcome);
    assert.deepStrictEqual(replayOutcomes,  ["zero_fill", "zero_fill"], "replay: outcomes");
    assert.deepStrictEqual(harnessOutcomes, ["zero_fill", "zero_fill"], "harness: outcomes");

    // Neither tick should have a fill object
    for (const rec of [...replayResult.records, ...harnessRecords]) {
      assert.strictEqual(rec.simResults[0].fill, undefined, "zero_fill must have no fill object");
    }
  });

  // ── Position guard ───────────────────────────────────────────────────────────

  it("position_guard: both Simulator and ProductionHarness block a cross-side order after a fill", () => {
    // position_guard is unreachable through the normal decide() → runReplay() pipeline
    // with the default per-window budget at 72-90¢ prices (zero_contracts fires first because
    // the first fill exhausts the window budget). This test validates the guard
    // directly by calling simulate() with a 1¢ cross-side decision that bypasses
    // zero_contracts (floor($0.24/0.01)=24 > 0).
    //
    // Both Simulator and ProductionHarness must agree on "position_guard".

    const sim     = new Simulator(CONFIG);
    const harness = new ProductionHarness(CONFIG);

    const yesDecision: StrategyDecision = {
      action:        "buy_yes",
      signal:        { side: "yes", triggerCents: 90, limitCents: 91, maxCount: 109 },
      betDollars:    100,
      yesDerivedAsk: 90,
      noDerivedAsk:  null,
      secondsLeft:   90,
    };

    // Step 1: YES fill — sets position to +116 on both
    const simFill    = sim.simulate(yesDecision, BTC_W1, T0);
    const harnessFill = harness.simulate(yesDecision, BTC_W1, T0);
    assert.strictEqual(simFill.guardOutcome,    "filled", "sim: YES fill expected");
    assert.strictEqual(harnessFill.guardOutcome, "filled", "harness: YES fill expected");

    // Step 2: NO order at 1¢ limit (passes zero_contracts, hits position_guard)
    //   remaining = $0.24,  count = floor(0.24/0.01) = 24 > 0  →  passes step 3
    //   NO has no prior dedup slot                              →  passes step 4
    //   (side="no" && position=+116 > 0)                       →  position_guard
    const noDecision: StrategyDecision = {
      action:        "buy_no",
      signal:        { side: "no", triggerCents: 1, limitCents: 1, maxCount: 24 },
      betDollars:    100,
      yesDerivedAsk: null,
      noDerivedAsk:  1,
      secondsLeft:   90,
    };

    const simGuard    = sim.simulate(noDecision, BTC_W1, T0 + 5_000);
    const harnessGuard = harness.simulate(noDecision, BTC_W1, T0 + 5_000);

    assert.strictEqual(simGuard.guardOutcome,    "position_guard", "sim: position_guard expected");
    assert.strictEqual(harnessGuard.guardOutcome, "position_guard", "harness: position_guard expected");
    assert.strictEqual(simGuard.guardOutcome, harnessGuard.guardOutcome, "both paths agree");
    assert.strictEqual(simGuard.fill,    undefined, "sim: no fill on position_guard");
    assert.strictEqual(harnessGuard.fill, undefined, "harness: no fill on position_guard");
  });

  // ── Window rollover ───────────────────────────────────────────────────────────

  it("window rollover: both paths clear per-window state and fill on the new ticker", () => {
    // W1 fill exhausts the budget. W2 (different ticker) must fill again.
    const ROLLOVER_TICKS: ReplayTick[] = [
      {
        ticker:      BTC_W1,
        closeTime:   BTC_W1_CLOSE,
        yesBid:      99,
        yesAsk:      null,
        noBid:       10,   // yesDerivedAsk=90 (inside the current band)
        noAsk:       null,
        timestampMs: T0,
      },
      {
        ticker:      BTC_W2,
        closeTime:   BTC_W2_CLOSE,
        yesBid:      99,
        yesAsk:      null,
        noBid:       10,
        noAsk:       null,
        timestampMs: T0 + 20_000,
      },
    ];

    const replayResult   = runReplay(ROLLOVER_TICKS, { persist: false, config: CONFIG });
    const harnessRecords = runHarness(ROLLOVER_TICKS, CONFIG);

    assert.strictEqual(replayResult.records.length, harnessRecords.length, "tick count");
    for (let i = 0; i < replayResult.records.length; i++) {
      assertSimResultsEqual(
        replayResult.records[i].simResults,
        harnessRecords[i].simResults,
        `multi-series tick[${i}]`,
      );
    }

    // Both tickers must fill independently
    const outcomes = replayResult.records.map((r) => r.simResults[0].guardOutcome);
    assert.deepStrictEqual(outcomes, ["filled", "filled"], "replay: both windows fill");
    const harnessOutcomes = harnessRecords.map((r) => r.simResults[0].guardOutcome);
    assert.deepStrictEqual(harnessOutcomes, ["filled", "filled"], "harness: both windows fill");
  });

  // ── Multi-series independence ─────────────────────────────────────────────────

  it("BTC and ETH state is fully independent — fills on both without interference", () => {
    // Same result as W1-BTC-A and W1-ETH-A from the main fixture, validated in isolation.
    const TWO_SERIES: ReplayTick[] = [
      {
        ticker:      BTC_W1,
        closeTime:   BTC_W1_CLOSE,
        yesBid:      99,
        yesAsk:      null,
        noBid:       10,   // yesDerivedAsk=90 (inside the current band)
        noAsk:       null,
        timestampMs: T0,
      },
      {
        ticker:      ETH_W1,
        closeTime:   ETH_W1_CLOSE,
        yesBid:      8,    // noDerivedAsk=92 (at ETH cap)
        yesAsk:      null,
        noBid:       99,
        noAsk:       null,
        timestampMs: T0 + 500,
      },
    ];

    const replayResult   = runReplay(TWO_SERIES, { persist: false, config: CONFIG });
    const harnessRecords = runHarness(TWO_SERIES, CONFIG);

    assert.strictEqual(replayResult.records.length, harnessRecords.length, "tick count");
    for (let i = 0; i < replayResult.records.length; i++) {
      assertSimResultsEqual(
        replayResult.records[i].simResults,
        harnessRecords[i].simResults,
        `multi-series tick[${i}]`,
      );
    }

    // Both tickers must fill independently
    const outcomes = replayResult.records.map((r) => r.simResults[0].guardOutcome);
    assert.deepStrictEqual(outcomes, ["filled", "filled"], "replay: both series fill");
  });

  // ── Config parity ─────────────────────────────────────────────────────────────

  it("DEFAULT_REPLAY_CONFIG mirrors autoTrader.ts constants exactly", () => {
    // These constants must match autoTrader.ts exactly; any divergence here means
    // replay would model a different strategy than the live bot.
    const c = DEFAULT_REPLAY_CONFIG;
    assert.strictEqual(c.alertMin,               90,          "alertMin");
    assert.strictEqual(c.alertMax,               95,          "alertMax");
    assert.strictEqual(c.timeAlertSeconds,       120,         "timeAlertSeconds");
    assert.strictEqual(c.limitPriceBufferCents,  1,           "limitPriceBufferCents");
    assert.strictEqual(c.orderCooldownMs,        3_000,       "orderCooldownMs");
    assert.strictEqual(c.dedupWindowMs,          20 * 60_000, "dedupWindowMs");
    assert.strictEqual(c.maxDailyNotionalCents,  800_000,     "maxDailyNotionalCents");
    assert.strictEqual(c.betDollarsByTicker["KXBTC15M"], 1, "betDollars KXBTC15M");
    assert.strictEqual(c.betDollarsByTicker["KXETH15M"], 1, "betDollars KXETH15M");
    assert.strictEqual(c.fillAssumption,         "full",      "fillAssumption default");
  });

  it("replay result stores strategyVersion from decide.ts", () => {
    const result = runReplay([], { persist: false });
    assert.strictEqual(result.config.strategyVersion, STRATEGY_VERSION);
    assert.match(STRATEGY_VERSION, /^\d+\.\d+\.\d+$/, "semver format");
  });
});
