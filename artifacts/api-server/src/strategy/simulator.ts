/**
 * Stateful simulator of the production auto-trading pipeline.
 *
 * Mirrors every guard in autoTrader.ts placeOrder() without making any live
 * API calls or writing any files.
 *
 * Create a new instance per replay run. All state is isolated to the instance
 * so replay runs cannot interfere with each other or with the live server.
 *
 * ── Guard order (matches autoTrader.ts placeOrder() exactly) ──────────────
 *
 *   1. Cooldown guard      – per "ticker-SIDE" key; entry set on the way through
 *   2. Per-window spend    – $betDollars per ticker, YES+NO share the same bucket
 *   3. Contract count      – floor division; 0 → zero_contracts
 *   4. Dedup slot          – claimOrderSlot equivalent; slot IS SET here atomically
 *                            before daily cap and position guard.
 *                            Released on: daily_cap block, position_guard block, zero fill.
 *                            Kept on: full fill (slot expires naturally after dedupWindowMs).
 *   5. Daily notional cap  – tryReserve; if blocked, dedup slot is released first
 *   6. Position guard      – (side==="no" && position>0) || (side==="yes" && position<0)
 *                            Cross-side only, matching autoTrader.ts line 364-365.
 *                            If blocked, dedup slot + notional released (unwind).
 *   7. Fill simulation     – full fill at limit price (default), or zero fill per config.
 *                            Zero fill → unwind (slot + notional released), matching
 *                            autoTrader.ts line 440.
 *
 * ── Position tracking ─────────────────────────────────────────────────────
 *
 *   The live engine calls getSignedPosition(ticker), an async Kalshi API call.
 *   Replay cannot make live API calls, so positions are tracked in-memory from
 *   simulated fills, using the same sign convention as getSignedPosition():
 *     positive = long YES,  negative = long NO.
 *
 *   Keyed by the full ticker string (e.g. "KXBTC15M-26JUL290445-45").
 *   A fill on one 15-minute market window does not affect any other window's ticker.
 *
 * ── Spend accounting ──────────────────────────────────────────────────────
 *
 *   The live engine uses parseFillActuals() to record the true fill price.
 *   Replay records limit price × contracts (conservative upper bound), since
 *   actual per-fill prices are not available in the historical tick stream.
 *
 * ── Kill switch ───────────────────────────────────────────────────────────
 *
 *   Not modelled. There is no record of when the kill switch was toggled in
 *   historical data, so replay assumes it was always OFF.
 */

import { tryReserve, releaseCents, type DailyBudgetState } from "../lib/dailyBudget.js";
import { contractsForPrice } from "./decide.js";
import type {
  ReplayConfig,
  StrategyDecision,
  TradeDecision,
  SimResult,
  SimulatedFill,
} from "./types.js";

export class Simulator {
  /**
   * "ticker-SIDE" → last-attempt ms.
   * Mirrors orderCooldown in autoTrader.ts.
   */
  private readonly cooldown = new Map<string, number>();

  /**
   * ticker → dollars spent this window (YES + NO combined).
   * Mirrors spendTracker in autoTrader.ts (keyed by ticker, not ticker-SIDE).
   */
  private readonly spendTracker = new Map<string, number>();

  /**
   * "ticker-SIDE" → placed-at ms.
   * Mirrors recentOrders in trade.ts / claimOrderSlot().
   *
   * The slot is SET when claimed (step 4), before daily cap and position guard.
   * Released on: daily_cap block, position_guard block, zero fill.
   * Kept on full fill (mirrors autoTrader.ts lines 503-508).
   */
  private readonly recentOrders = new Map<string, number>();

  /**
   * Full-ticker → signed position.
   * positive = long YES,  negative = long NO.
   * Matches the sign convention of getSignedPosition() in trade.ts.
   * Keyed by the complete ticker ID so each 15-minute window is independent.
   */
  private readonly positions = new Map<string, number>();

  /** Daily budget state — injected replayed clock via tryReserve's date arg. */
  private budget: DailyBudgetState = { date: "", spentCents: 0 };

  constructor(private readonly config: ReplayConfig) {}

  // ── Window lifecycle ───────────────────────────────────────────────────────

  /**
   * Call when a new ticker is detected for a series (window rollover).
   * Clears all per-window state for prevTicker, exactly as
   * handleWindowRollover() does in autoTrader.ts.
   *
   * Positions are NOT cleared — holdings from the prior window persist — but
   * the next window's ticker starts with position = 0 (different full ticker).
   */
  rollWindow(prevTicker: string | undefined, _newTicker: string): void {
    if (!prevTicker) return;

    this.spendTracker.delete(prevTicker);

    for (const k of [...this.cooldown.keys()]) {
      if (k.startsWith(prevTicker)) this.cooldown.delete(k);
    }

    for (const k of [...this.recentOrders.keys()]) {
      if (k.startsWith(prevTicker)) this.recentOrders.delete(k);
    }
  }

  // ── Simulate one trade decision ────────────────────────────────────────────

  /**
   * Run a TradeDecision through the full production guard pipeline.
   *
   * @param decision  TradeDecision from decide() — SkipDecisions are not accepted
   * @param ticker    Full market ticker (e.g. "KXBTC15M-26JUL290445-45")
   * @param nowMs     Replayed wall-clock time in milliseconds
   */
  simulate(decision: StrategyDecision, ticker: string, nowMs: number): SimResult {
    if (decision.action === "skip") {
      return { decision, guardOutcome: "cooldown" };
    }

    const d                      = decision as TradeDecision;
    const { signal, betDollars } = d;
    const { side, limitCents }   = signal;
    const key                    = `${ticker}-${side.toUpperCase()}`;

    // ── 1. Cooldown guard ───────────────────────────────────────────────────
    // Entry is set on the way through (not only on fill), matching autoTrader.ts:316.
    const lastAttempt = this.cooldown.get(key) ?? 0;
    if (nowMs - lastAttempt < this.config.orderCooldownMs) {
      return { decision, guardOutcome: "cooldown" };
    }
    this.cooldown.set(key, nowMs);

    // ── 2. Per-window spend cap ─────────────────────────────────────────────
    // Keyed by ticker only (YES+NO share budget), matching autoTrader.ts:319.
    const spendKey         = ticker;
    const alreadySpent     = this.spendTracker.get(spendKey) ?? 0;
    const remainingDollars = betDollars - alreadySpent;
    if (remainingDollars <= 0) {
      return { decision, guardOutcome: "window_budget" };
    }

    // ── 3. Contract count ───────────────────────────────────────────────────
    const count = contractsForPrice(limitCents, remainingDollars);
    if (count === 0) {
      return { decision, guardOutcome: "zero_contracts" };
    }

    // ── 4. Dedup slot ───────────────────────────────────────────────────────
    // Expire stale entries first, then attempt to claim the slot.
    // claimOrderSlot() in trade.ts sets the timestamp here atomically —
    // BEFORE the daily cap check, not after the fill.
    for (const [k, ts] of this.recentOrders) {
      if (nowMs - ts > this.config.dedupWindowMs) this.recentOrders.delete(k);
    }
    if (this.recentOrders.has(key)) {
      return { decision, guardOutcome: "dedup" };
    }
    this.recentOrders.set(key, nowMs); // slot claimed — may be released below

    // ── 5. Daily notional cap ───────────────────────────────────────────────
    // If cap is hit, release the dedup slot first (matches autoTrader.ts:350).
    const notionalCents = count * limitCents;
    const reserveResult = tryReserve(
      this.budget,
      notionalCents,
      this.config.maxDailyNotionalCents,
      new Date(nowMs), // injected replayed clock — NOT Date.now()
    );
    if (!reserveResult.ok) {
      this.recentOrders.delete(key); // release dedup slot
      return { decision, guardOutcome: "daily_cap" };
    }
    this.budget = reserveResult.next;

    // unwind() equivalent — releases dedup slot + notional (called on position_guard
    // block and zero fill, matching autoTrader.ts lines 356-359 and 440).
    const unwind = (): void => {
      this.recentOrders.delete(key);
      this.budget = releaseCents(this.budget, notionalCents);
    };

    // ── 6. Position guard ───────────────────────────────────────────────────
    // Rule: block orders that would CLOSE an existing position (cross-side only).
    // Matches autoTrader.ts line 364-365 and trade.ts line 579 verbatim.
    // NOT "block all orders when position != 0" — same-side re-entry is allowed
    // by the live engine; it is prevented by the dedup guard, not this guard.
    const position  = this.positions.get(ticker) ?? 0;
    const wouldClose =
      (side === "no"  && position > 0) ||
      (side === "yes" && position < 0);
    if (wouldClose) {
      unwind();
      return { decision, guardOutcome: "position_guard" };
    }

    // ── 7. Fill simulation ──────────────────────────────────────────────────
    if (this.config.fillAssumption === "zero") {
      // IOC order expired without a fill.
      // Production calls unwind() here (autoTrader.ts:440), releasing both
      // the dedup slot and the reserved notional.
      unwind();
      return { decision, guardOutcome: "zero_fill" };
    }

    // Optimistic default: full fill at limit price.
    // Real IOC fills may occur at price improvement; actual prices are not
    // available in the tick stream, so limit price is used as a conservative
    // upper bound for spend tracking.
    const dollarsCost = (count * limitCents) / 100;

    // Update spend tracker (dedup slot already set at step 4; kept on full fill).
    this.spendTracker.set(spendKey, alreadySpent + dollarsCost);

    // Track signed position for position guard on future ticks:
    //   YES fill → positive (long YES),  NO fill → negative (long NO).
    // Matches getSignedPosition() sign convention in trade.ts line 288.
    const delta = side === "yes" ? count : -count;
    this.positions.set(ticker, (this.positions.get(ticker) ?? 0) + delta);

    const fill: SimulatedFill = { contracts: count, priceCents: limitCents, dollarsCost };
    return { decision, guardOutcome: "filled", fill };
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** Signed position for the full ticker. Positive = YES, negative = NO. */
  getPosition(ticker: string): number {
    return this.positions.get(ticker) ?? 0;
  }

  getBudgetState(): Readonly<DailyBudgetState> {
    return this.budget;
  }

  getTotalSpent(): number {
    let total = 0;
    for (const v of this.spendTracker.values()) total += v;
    return total;
  }

  /**
   * Pre-seed a dedup slot — for testing only.
   *
   * In production the slot is set when an order is submitted. Replay tests
   * use this to simulate the state that exists when an order is already
   * in-flight or was placed in a prior run (loaded from disk by loadPersistedDedup).
   *
   * @param key   `${ticker}-${SIDE}` exactly as claimOrderSlot() uses
   * @param ts    Timestamp in ms (use a value within dedupWindowMs of nowMs to keep it active)
   */
  seedDedup(key: string, ts: number): void {
    this.recentOrders.set(key, ts);
  }
}
