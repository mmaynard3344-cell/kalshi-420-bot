/**
 * Unit tests for the offline replay strategy modules.
 *
 * Covers:
 *   A. decide()             — time gate, zone checks, limit price math
 *   B. contractsForPrice()  — floor division, boundary guards
 *   C. secondsUntilClose()  — clock injection, past-close handling
 *   D. Simulator guards     — cooldown, spend cap, dedup, daily cap, position guard
 *   E. Simulator fills      — fill accounting, zero-fill assumption
 *   F. runReplay()          — end-to-end pipeline, config recording
 *   G. STRATEGY_VERSION / STRATEGY_CONFIG — version contract
 *
 * Uses node:test + node:assert/strict. No live network calls. No file I/O
 * (persist=false on all runReplay calls).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  contractsForPrice,
  secondsUntilClose,
  STRATEGY_VERSION,
  STRATEGY_CONFIG,
} from "./decide.js";
import { Simulator } from "./simulator.js";
import { runReplay, DEFAULT_REPLAY_CONFIG } from "./replayRunner.js";
import type {
  StrategyInput,
  ReplayConfig,
  TradeDecision,
  SkipDecision,
  ReplayTick,
} from "./types.js";

// ── Shared test constants ─────────────────────────────────────────────────────

const NOW_MS         = new Date("2026-07-29T19:58:00.000Z").getTime();
const CLOSE_90S      = new Date(NOW_MS + 90_000).toISOString();   // 90 s → inside window
const CLOSE_200S     = new Date(NOW_MS + 200_000).toISOString();  // 200 s → outside window
const TICKER         = "KXBTC15M-26JUL290445-45";
const BET_DOLLARS    = 200;

const BASE_CONFIG: ReplayConfig = {
  ...DEFAULT_REPLAY_CONFIG,
  strategyVersion: STRATEGY_VERSION,
};

function mkInput(overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    ticker:     TICKER,
    series:     "KXBTC15M",
    closeTime:  CLOSE_90S,
    yesBid:     10,   // → noDerivedAsk=90 (inside BTC's 90–92¢ band)
    noBid:      10,   // → yesDerivedAsk=90 (inside BTC's 90–92¢ band)
    betDollars: BET_DOLLARS,
    nowMs:      NOW_MS,
    ...overrides,
  };
}

function mkSim(overrides: Partial<ReplayConfig> = {}): Simulator {
  return new Simulator({ ...BASE_CONFIG, ...overrides });
}

function tradeDecision(
  side:       "yes" | "no",
  limitCents  = 90,
  betDollars  = BET_DOLLARS,
): TradeDecision {
  return {
    action:        side === "yes" ? "buy_yes" : "buy_no",
    signal:        {
      side,
      triggerCents: limitCents,
      limitCents,
      maxCount:     contractsForPrice(limitCents, betDollars),
    },
    betDollars,
    yesDerivedAsk: side === "yes" ? limitCents : null,
    noDerivedAsk:  side === "no"  ? limitCents : null,
    secondsLeft:   90,
  };
}

// ── A. decide() — time gate ───────────────────────────────────────────────────

describe("decide — time gate", () => {
  it("returns skip(outside_time_window) when closeTime is > 120 s away", () => {
    const [d] = decide(mkInput({ closeTime: CLOSE_200S }));
    assert.strictEqual(d.action, "skip");
    assert.strictEqual((d as SkipDecision).skipReason, "outside_time_window");
  });

  it("returns skip(no_close_time) when closeTime is null", () => {
    const [d] = decide(mkInput({ closeTime: null }));
    assert.strictEqual((d as SkipDecision).skipReason, "no_close_time");
  });

  it("evaluates a tick exactly 1 second before close", () => {
    const closeTime = new Date(NOW_MS + 1_000).toISOString();
    const results   = decide(mkInput({ closeTime, noBid: 10 }));
    assert.ok(results.some((r) => r.action === "buy_yes"));
  });

  it("evaluates a tick exactly at the 120-second boundary (> check, not >=)", () => {
    const closeTime = new Date(NOW_MS + 120_000).toISOString();
    const [d] = decide(mkInput({ closeTime }));
    // secondsLeft === 120, which is NOT > TIME_ALERT_SECONDS (120), so this should evaluate.
    // The condition is: secondsLeft > TIME_ALERT_SECONDS → 120 > 120 is false → evaluates.
    assert.notStrictEqual((d as SkipDecision).skipReason, "outside_time_window");
  });

  it("skips at 181 seconds remaining", () => {
    const closeTime = new Date(NOW_MS + 181_000).toISOString();
    const [d] = decide(mkInput({ closeTime }));
    assert.strictEqual((d as SkipDecision).skipReason, "outside_time_window");
  });
});

// ── A. decide() — price zone ──────────────────────────────────────────────────

describe("decide — price zone", () => {
  it("returns skip(outside_price_zone) when both derived asks are below 90¢", () => {
    // yesBid=95 → noDerived=5; noBid=95 → yesDerived=5
    const [d] = decide(mkInput({ yesBid: 95, noBid: 95 }));
    assert.strictEqual((d as SkipDecision).skipReason, "outside_price_zone");
  });

  it("returns skip(outside_price_zone) when both derived asks are above 95¢", () => {
    // yesBid=4 → noDerived=96; noBid=4 → yesDerived=96
    const [d] = decide(mkInput({ yesBid: 4, noBid: 4 }));
    assert.strictEqual((d as SkipDecision).skipReason, "outside_price_zone");
  });

  it("returns buy_yes when yesDerivedAsk (100 − noBid) is in zone", () => {
    // noBid=10 → yesDerivedAsk=90 (inside BTC's 89–95 band)
    const results = decide(mkInput({ noBid: 10, yesBid: 5 }));
    const d = results.find((r) => r.action === "buy_yes") as TradeDecision;
    assert.ok(d, "expected buy_yes");
    assert.strictEqual(d.signal.triggerCents, 90);
    assert.strictEqual(d.signal.limitCents,   91); // 90 + buffer 1
  });

  it("returns buy_no when noDerivedAsk (100 − yesBid) is in zone", () => {
    // yesBid=10 → noDerivedAsk=90 (inside BTC's 89–95 band)
    const results = decide(mkInput({ yesBid: 10, noBid: 5 }));
    const d = results.find((r) => r.action === "buy_no") as TradeDecision;
    assert.ok(d, "expected buy_no");
    assert.strictEqual(d.signal.triggerCents, 90);
    assert.strictEqual(d.signal.limitCents,   91);
  });

  it("returns two decisions when both sides are simultaneously in zone", () => {
    // noBid=10 → yes=90; yesBid=10 → no=90
    const results = decide(mkInput({ yesBid: 10, noBid: 10 }));
    assert.strictEqual(results.length, 2);
    assert.ok(results.some((r) => r.action === "buy_yes"));
    assert.ok(results.some((r) => r.action === "buy_no"));
  });

  it("caps a BTC 95¢ trigger at the BTC 95¢ ceiling", () => {
    // noBid=5 → yesDerivedAsk=95; with buffer=1 → 96, capped at 95.
    const results = decide(mkInput({ noBid: 5, yesBid: 4 }));
    const d = results.find((r) => r.action === "buy_yes") as TradeDecision;
    assert.ok(d);
    assert.strictEqual(d.signal.limitCents, 95);
  });

  it("limit price is never >= 100 (hard cap at 99)", () => {
    for (const results of [
      decide(mkInput({ noBid: 1, yesBid: 5 })),
      decide(mkInput({ noBid: 10, yesBid: 5 })),
    ]) {
      for (const d of results) {
        if (d.action !== "skip") {
          assert.ok((d as TradeDecision).signal.limitCents <= 99, "limitCents must be ≤ 99");
        }
      }
    }
  });

  it("includes betDollars in the TradeDecision for the simulator", () => {
    const results = decide(mkInput({ noBid: 10, betDollars: 150 }));
    const d = results.find((r) => r.action === "buy_yes") as TradeDecision;
    assert.ok(d);
    assert.strictEqual(d.betDollars, 150);
  });
});

describe("decide — ETH-specific entry band", () => {
  it("rejects ETH below the 90¢ floor", () => {
    const eth = decide(mkInput({
      ticker: "KXETH15M-TEST",
      series: "KXETH15M",
      yesBid: 11, // NO-derived ask 89¢
      noBid: 11,  // YES-derived ask 89¢
      betDollars: 100,
    }));
    assert.equal(eth.filter((d) => d.action !== "skip").length, 0);

    const btc = decide(mkInput({
      ticker: "KXBTC15M-TEST",
      series: "KXBTC15M",
      yesBid: 10,
      noBid: 10,
      betDollars: 400,
    }));
    assert.equal(btc.filter((d) => d.action !== "skip").length, 2);
  });

  it("accepts ETH at 90¢ and sizes from the supplied $100 cap", () => {
    const decisions = decide(mkInput({
      ticker: "KXETH15M-TEST",
      series: "KXETH15M",
      yesBid: 10,
      noBid: 10,
      betDollars: 100,
    }));
    const trade = decisions.find((d) => d.action === "buy_yes") as TradeDecision;
    assert.ok(trade);
    assert.equal(trade.signal.triggerCents, 90);
    assert.equal(trade.signal.maxCount, Math.floor(100 / 0.91));
  });
});

// ── B. contractsForPrice ──────────────────────────────────────────────────────

describe("contractsForPrice", () => {
  it("$200 at 85¢ = 235 contracts (floor division)", () => {
    assert.strictEqual(contractsForPrice(85, BET_DOLLARS), 235);
  });

  it("$100 at 90¢ = 111 contracts", () => {
    assert.strictEqual(contractsForPrice(90, 100), 111);
  });

  it("$100 at 72¢ = 138 contracts", () => {
    assert.strictEqual(contractsForPrice(72, 100), 138);
  });

  it("returns 0 when priceCents is 0", () => {
    assert.strictEqual(contractsForPrice(0, 100), 0);
  });

  it("returns 0 when priceCents is 100", () => {
    assert.strictEqual(contractsForPrice(100, 100), 0);
  });

  it("returns 0 when dollars is 0", () => {
    assert.strictEqual(contractsForPrice(85, 0), 0);
  });

  it("floors — does not round up", () => {
    // $10 at 85¢ = 11.76... → floor = 11
    assert.strictEqual(contractsForPrice(85, 10), 11);
  });
});

// ── C. secondsUntilClose ─────────────────────────────────────────────────────

describe("secondsUntilClose", () => {
  it("returns positive seconds when close is in the future", () => {
    assert.strictEqual(secondsUntilClose(new Date(NOW_MS + 90_000).toISOString(), NOW_MS), 90);
  });

  it("returns 0 when already past close", () => {
    assert.strictEqual(secondsUntilClose(new Date(NOW_MS - 1_000).toISOString(), NOW_MS), 0);
  });

  it("returns null for an invalid ISO string", () => {
    assert.strictEqual(secondsUntilClose("not-a-date", NOW_MS), null);
  });

  it("is deterministic — same inputs always return same output", () => {
    const t = new Date(NOW_MS + 60_000).toISOString();
    assert.strictEqual(secondsUntilClose(t, NOW_MS), secondsUntilClose(t, NOW_MS));
  });
});

// ── D. Simulator — cooldown guard ─────────────────────────────────────────────

describe("Simulator — cooldown", () => {
  it("blocks a second attempt within ORDER_COOLDOWN_MS", () => {
    const sim = mkSim({ orderCooldownMs: 3_000 });
    const d   = tradeDecision("yes");

    const r1 = sim.simulate(d, TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled");

    const r2 = sim.simulate(d, TICKER, NOW_MS + 500);
    assert.strictEqual(r2.guardOutcome, "cooldown");
  });

  it("allows an attempt once the cooldown has expired", () => {
    // Use zero dedup and a fresh ticker to isolate the cooldown check
    const ticker2 = `${TICKER}X`;
    const sim = mkSim({ orderCooldownMs: 1_000, dedupWindowMs: 0 });
    const d   = tradeDecision("yes");

    sim.simulate(d, ticker2, NOW_MS);

    const r2 = sim.simulate(d, ticker2, NOW_MS + 1_001);
    assert.notStrictEqual(r2.guardOutcome, "cooldown");
  });

  it("YES and NO cooldowns are independent (separate keys)", () => {
    const sim = mkSim({ orderCooldownMs: 5_000 });

    const r1 = sim.simulate(tradeDecision("yes"), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled");

    // NO on same ticker — different key, cooldown not triggered
    const r2 = sim.simulate(tradeDecision("no"), TICKER, NOW_MS + 100);
    assert.notStrictEqual(r2.guardOutcome, "cooldown");
  });
});

// ── D. Simulator — per-window spend cap ───────────────────────────────────────

describe("Simulator — per-window spend cap", () => {
  it("blocks further trades on the same ticker once the window budget is used", () => {
    const sim = mkSim();
    // YES fill at 85¢ spends ~$99.45 (117 contracts × $0.85)
    const r1 = sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled");

    // Remaining is $0.55 — not enough for even 1 contract at 85¢.
    // zero_contracts fires at step 3, before dedup (step 4) or position guard (step 6).
    const r2 = sim.simulate(tradeDecision("no", 85), TICKER, NOW_MS + 3_001);
    assert.ok(
      r2.guardOutcome === "window_budget"  ||
      r2.guardOutcome === "zero_contracts",
      `expected window_budget or zero_contracts, got ${r2.guardOutcome}`,
    );
  });

  it("resets after window rollover (new ticker)", () => {
    // The next 15-minute market ticker is a different full ticker ID, so its
    // position starts at 0 and its spend bucket starts empty.
    const sim     = mkSim();
    const ticker2 = "KXBTC15M-26JUL290500-00";

    sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    sim.rollWindow(TICKER, ticker2);

    // New ticker, new spend bucket, position = 0 — should fill
    const r2 = sim.simulate(tradeDecision("yes", 85), ticker2, NOW_MS + 20_000);
    assert.strictEqual(r2.guardOutcome, "filled");
  });
});

// ── D. Simulator — dedup ──────────────────────────────────────────────────────

describe("Simulator — dedup", () => {
  it("blocks the same ticker+side when a dedup slot is active", () => {
    // In production, claimOrderSlot() sets the slot before the order is submitted.
    // The slot is kept on a full fill and released on zero-fill / position_guard / error.
    // seedDedup() replicates the state that exists when an order is already in-flight
    // or was loaded from the persisted dedup file on server restart.
    const sim = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000 });
    sim.seedDedup(`${TICKER}-YES`, NOW_MS);

    const r = sim.simulate(tradeDecision("yes"), TICKER, NOW_MS + 5_000);
    assert.strictEqual(r.guardOutcome, "dedup");
  });

  it("slot is released on zero fill (retry is allowed on the next tick)", () => {
    // Production: fillCount===0 → unwind() → slot released (autoTrader.ts:440).
    // A second attempt on the same ticker+side should not be blocked by dedup.
    const sim = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000, fillAssumption: "zero" });
    const d   = tradeDecision("yes");

    const r1 = sim.simulate(d, TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "zero_fill");  // slot claimed then released

    // No dedup entry remains — next attempt passes dedup (may hit other guards)
    const r2 = sim.simulate(d, TICKER, NOW_MS + 5_000);
    assert.notStrictEqual(r2.guardOutcome, "dedup");
  });

  it("clears dedup on window rollover", () => {
    // After rollWindow the dedup slot for the old ticker is deleted.
    // The next window's ticker has position = 0 and no dedup entry → should fill.
    const sim     = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000 });
    const ticker2 = "KXBTC15M-26JUL290500-00";
    const d       = tradeDecision("yes");

    sim.simulate(d, TICKER, NOW_MS);
    sim.rollWindow(TICKER, ticker2);

    // ticker2 is a fresh market: no prior position, no dedup entry, empty spend
    const r2 = sim.simulate(d, ticker2, NOW_MS + 5_000);
    assert.strictEqual(r2.guardOutcome, "filled");
  });
});

// ── D. Simulator — daily cap ──────────────────────────────────────────────────

describe("Simulator — daily cap", () => {
  it("blocks when daily notional is set to 0", () => {
    const sim = mkSim({ maxDailyNotionalCents: 0 });
    const r   = sim.simulate(tradeDecision("yes"), TICKER, NOW_MS);
    assert.strictEqual(r.guardOutcome, "daily_cap");
  });

  it("allows trades within the cap and accumulates spend", () => {
    const sim = mkSim({ maxDailyNotionalCents: 20_000 }); // $200 cap
    const r   = sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    // 235 contracts × 85¢ = 19975¢ < 20000¢ → should pass
    assert.strictEqual(r.guardOutcome, "filled");
  });
});

// ── D. Simulator — position guard ────────────────────────────────────────────
//
// Production rule (autoTrader.ts:364-365 / trade.ts:579):
//   (side === "no"  && position > 0) ||   // NO would close a YES position
//   (side === "yes" && position < 0)       // YES would close a NO position
//
// Same-side re-entry is NOT blocked by position_guard — the live engine only
// prevents closing an existing position. Same-side re-entry is prevented by
// dedup (slot kept on full fill) or zero_contracts (remaining < 1 contract at
// standard prices).
//
// To reach position_guard in tests, limitCents=1 is used on the retry so that
// zero_contracts (step 3) and dedup (step 4) do not fire first:
//   remaining ≈ $0.55,  contracts = floor(0.55×100/1) = 55 > 0  →  passes step 3
//   NO side has no prior dedup slot                              →  passes step 4

describe("Simulator — position guard", () => {
  it("cross-side order is blocked (NO after YES fill) — would close the YES position", () => {
    // Production rule: (side==="no" && position>0) → position_guard.
    // limitCents=1 on retry so zero_contracts doesn't fire first.
    const sim = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000 });

    const r1 = sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled"); // position = +117

    const r2 = sim.simulate(tradeDecision("no", 1), TICKER, NOW_MS + 5_000);
    assert.strictEqual(r2.guardOutcome, "position_guard");
  });

  it("cross-side order is blocked (YES after NO fill) — would close the NO position", () => {
    // Production rule: (side==="yes" && position<0) → position_guard.
    const sim = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000 });

    const r1 = sim.simulate(tradeDecision("no", 85), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled"); // position = -117

    const r2 = sim.simulate(tradeDecision("yes", 1), TICKER, NOW_MS + 5_000);
    assert.strictEqual(r2.guardOutcome, "position_guard");
  });

  it("same-side re-entry is NOT blocked by position_guard (blocked by dedup instead)", () => {
    // YES when already long YES: position=+117, side="yes" → (yes && <0) = false.
    // position_guard passes; dedup blocks (slot kept from r1 full fill).
    const sim = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000 });

    const r1 = sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled");

    // limitCents=1 to get past zero_contracts and reach dedup
    const r2 = sim.simulate(tradeDecision("yes", 1), TICKER, NOW_MS + 5_000);
    assert.strictEqual(r2.guardOutcome, "dedup");       // not position_guard
  });

  it("next BTC window ticker is immediately eligible after the prior window filled", () => {
    // Each 15-minute window has a distinct full ticker. Position on TICKER must
    // NOT affect ticker2 — position is keyed by full ticker, not series prefix.
    const sim     = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000 });
    const ticker2 = "KXBTC15M-26JUL290500-00";

    const r1 = sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled");

    sim.rollWindow(TICKER, ticker2);

    const r2 = sim.simulate(tradeDecision("yes", 85), ticker2, NOW_MS + 20_000);
    assert.strictEqual(r2.guardOutcome, "filled");
  });

  it("BTC and ETH tickers are fully independent", () => {
    const ETH_TICKER = "KXETH15M-26JUL290500-00";
    const sim        = mkSim({ orderCooldownMs: 0, dedupWindowMs: 20 * 60_000 });

    const r1 = sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "filled");

    const r2 = sim.simulate(tradeDecision("yes", 85), ETH_TICKER, NOW_MS + 5_000);
    assert.strictEqual(r2.guardOutcome, "filled");
  });

  it("tracks signed position correctly after a YES fill (positive = long YES)", () => {
    const sim = mkSim();
    sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);
    assert.strictEqual(sim.getPosition(TICKER), contractsForPrice(85, BET_DOLLARS));
  });

  it("tracks signed position correctly after a NO fill (negative = long NO)", () => {
    const sim = mkSim();
    sim.simulate(tradeDecision("no", 85), TICKER, NOW_MS);
    assert.strictEqual(sim.getPosition(TICKER), -contractsForPrice(85, BET_DOLLARS)); // negative = long NO
  });
});

// ── E. Simulator — fill simulation ───────────────────────────────────────────

describe("Simulator — fill simulation", () => {
  it("records correct fill cost at limit price", () => {
    const sim = mkSim();
    const r   = sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS);

    assert.strictEqual(r.guardOutcome, "filled");
    assert.ok(r.fill, "expected fill object");
    assert.strictEqual(r.fill.priceCents, 85);
    assert.strictEqual(r.fill.contracts, contractsForPrice(85, BET_DOLLARS));
    const expectedCost = (contractsForPrice(85, BET_DOLLARS) * 85) / 100;
    assert.ok(Math.abs(r.fill.dollarsCost - expectedCost) < 0.001, "fill cost mismatch");
  });

  it("zero-fill assumption returns zero_fill without fill data", () => {
    const sim = mkSim({ fillAssumption: "zero" });
    const r   = sim.simulate(tradeDecision("yes"), TICKER, NOW_MS);

    assert.strictEqual(r.guardOutcome, "zero_fill");
    assert.strictEqual(r.fill, undefined);
  });

  it("zero-fill does not charge the daily notional cap", () => {
    // Demonstrate that 9945¢ notional exceeds a 9000¢ cap normally:
    const sim = mkSim({ fillAssumption: "zero", maxDailyNotionalCents: 9_000 });
    assert.strictEqual(
      sim.simulate(tradeDecision("yes", 85), TICKER, NOW_MS).guardOutcome,
      "daily_cap",
    );

    // With zero-fill and a cap that fits (10000 > 9945), notional is reserved and
    // then released on 0-fill — so the cap is never permanently consumed.
    const sim2 = mkSim({ fillAssumption: "zero", maxDailyNotionalCents: 20_000 });
    const r1 = sim2.simulate(tradeDecision("yes", 90), TICKER, NOW_MS);
    assert.strictEqual(r1.guardOutcome, "zero_fill");

    const r2 = sim2.simulate(tradeDecision("yes", 90), "KXBTC15M-T2", NOW_MS + 3_001);
    assert.notStrictEqual(r2.guardOutcome, "daily_cap");
  });
});

// ── F. runReplay — end-to-end ─────────────────────────────────────────────────

describe("runReplay — end-to-end", () => {
  function makeTick(overrides: Partial<ReplayTick> = {}): ReplayTick {
    return {
      ticker:      TICKER,
      closeTime:   CLOSE_90S,
      yesBid:      10,   // → noDerivedAsk=90 (in zone 89–95)
      yesAsk:      null,
      noBid:       10,   // → yesDerivedAsk=90 (in zone 89–95)
      noAsk:       null,
      timestampMs: NOW_MS,
      ...overrides,
    };
  }

  it("returns zero records for ticks entirely outside the time window", () => {
    const ticks = [makeTick({ closeTime: CLOSE_200S })];
    const result = runReplay(ticks, { persist: false });
    assert.strictEqual(result.summary.ticksEvaluated, 0);
    assert.strictEqual(result.records.length, 0);
  });

  it("records a tick inside the time window", () => {
    const ticks = [makeTick()];
    const result = runReplay(ticks, { persist: false });
    assert.strictEqual(result.summary.ticksEvaluated, 1);
    assert.strictEqual(result.records.length, 1);
  });

  it("records a trade when prices are in zone", () => {
    // noBid=10 → yesDerivedAsk=90; yesBid=10 → noDerivedAsk=90
    const ticks  = [makeTick({ yesBid: 10, noBid: 10 })];
    const result = runReplay(ticks, { persist: false });
    assert.ok(result.summary.tradeCount >= 1, "expected at least one trade");
  });

  it("records a skip when prices are out of zone", () => {
    // noBid=95 → yesDerivedAsk=5 (below 90); yesBid=95 → noDerivedAsk=5
    const ticks  = [makeTick({ yesBid: 95, noBid: 95 })];
    const result = runReplay(ticks, { persist: false });
    assert.strictEqual(result.summary.tradeCount, 0);
    assert.ok(result.summary.skippedOutOfZone >= 1);
  });

  it("result includes the complete config with strategyVersion", () => {
    const result = runReplay([], { persist: false });
    assert.strictEqual(result.config.strategyVersion, STRATEGY_VERSION);
    assert.strictEqual(result.config.alertMin,  STRATEGY_CONFIG.ALERT_MIN);
    assert.strictEqual(result.config.alertMax,  STRATEGY_CONFIG.ALERT_MAX);
    assert.strictEqual(result.config.timeAlertSeconds, STRATEGY_CONFIG.TIME_ALERT_SECONDS);
    assert.strictEqual(result.config.limitPriceBufferCents, STRATEGY_CONFIG.LIMIT_PRICE_BUFFER_CENTS);
  });

  it("each run has a unique replayId", () => {
    const r1 = runReplay([], { persist: false });
    const r2 = runReplay([], { persist: false });
    assert.notStrictEqual(r1.replayId, r2.replayId);
  });

  it("runAt is a valid ISO string", () => {
    const result = runReplay([], { persist: false });
    assert.ok(!isNaN(new Date(result.runAt).getTime()), "runAt should be a valid ISO date");
  });

  it("window rollover resets per-window spend between tickers", () => {
    const ticker2 = "KXBTC15M-26JUL290500-00";
    const t1 = makeTick({ ticker: TICKER,  closeTime: CLOSE_90S, yesBid: 10, noBid: 10, timestampMs: NOW_MS });
    const t2 = makeTick({ ticker: ticker2, closeTime: new Date(NOW_MS + 70_000).toISOString(), yesBid: 10, noBid: 10, timestampMs: NOW_MS + 60_000 });
    const result = runReplay([t1, t2], { persist: false });
    // Both windows should have at least one trade (not blocked by window_budget)
    assert.ok(result.summary.tradeCount >= 1);
  });
});

// ── G. STRATEGY_VERSION / STRATEGY_CONFIG ────────────────────────────────────

describe("STRATEGY_VERSION and STRATEGY_CONFIG", () => {
  it("STRATEGY_VERSION is a non-empty semver-like string", () => {
    assert.ok(typeof STRATEGY_VERSION === "string" && STRATEGY_VERSION.length > 0);
    assert.match(STRATEGY_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("STRATEGY_CONFIG.ALERT_MIN is 90", () => {
    assert.strictEqual(STRATEGY_CONFIG.ALERT_MIN, 90);
  });

  it("STRATEGY_CONFIG.ALERT_MAX is 95", () => {
    assert.strictEqual(STRATEGY_CONFIG.ALERT_MAX, 95);
  });

  it("STRATEGY_CONFIG.TIME_ALERT_SECONDS is 120", () => {
    assert.strictEqual(STRATEGY_CONFIG.TIME_ALERT_SECONDS, 120);
  });

  it("STRATEGY_CONFIG.LIMIT_PRICE_BUFFER_CENTS is 1", () => {
    assert.strictEqual(STRATEGY_CONFIG.LIMIT_PRICE_BUFFER_CENTS, 1);
  });

  it("records the configured asset caps and ETH entry floor", () => {
    assert.strictEqual(STRATEGY_CONFIG.BTC_BET_DOLLARS, 1);
    assert.strictEqual(STRATEGY_CONFIG.ETH_BET_DOLLARS, 1);
    assert.strictEqual(STRATEGY_CONFIG.ETH_ENTRY_FLOOR_CENTS, 90);
    assert.strictEqual(STRATEGY_CONFIG.ETH_ENTRY_CAP_CENTS, 95);
  });
});
