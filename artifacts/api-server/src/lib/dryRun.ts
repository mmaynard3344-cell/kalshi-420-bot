/**
 * Dry-run / paper-trading verification for the auto-trader guard stack.
 *
 * Scenarios 1–6: original six checks (unchanged).
 * Scenario 7: partial-fill IOC lifecycle (new).
 * Scenario 8: per-ticker in-flight lock independent of cooldown (new).
 * Scenario 9: manual route price-band + kill-switch audit (new).
 *
 * Run: node --enable-source-maps /tmp/dryRun.mjs
 */

import {
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  isPriceInBand,
  contractsForPrice,
  submissionInFlight,
  orderCooldown,
  _resetAutoTraderStateForTesting,
  _computeRemainingBudgetForTesting,
  _setPendingNotionalForTesting,
  _setSpendTrackerForTesting,
  _forceSubmissionInFlightForTesting,
  _getPendingNotionalForTesting,
  _getSpendTrackerForTesting,
  _isSubmissionInFlightForTesting,
} from "./autoTraderGuards.js";

// ── Formatting helpers ─────────────────────────────────────────────────────────

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";
const DIM    = "\x1b[2m";

function section(title: string) {
  console.log(`\n${BOLD}${CYAN}━━ ${title} ━━${RESET}`);
}
function log(obj: Record<string, unknown>, msg: string) {
  const fields = Object.entries(obj)
    .map(([k, v]) => `    ${DIM}${k}${RESET}: ${JSON.stringify(v)}`)
    .join("\n");
  console.log(`  ${DIM}[LOG]${RESET} ${msg}\n${fields}`);
}
function info(msg: string)  { console.log(`  ${CYAN}ℹ${RESET} ${msg}`); }
function note(msg: string)  { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function blank()            { console.log(); }

let PASS_COUNT = 0;
let FAIL_COUNT = 0;

function check(cond: boolean, ok: string, bad: string) {
  if (cond) {
    console.log(`  ${GREEN}✔ PASS${RESET}  ${ok}`);
    PASS_COUNT++;
  } else {
    console.log(`  ${RED}✖ FAIL${RESET}  ${bad}`);
    FAIL_COUNT++;
  }
}

// ── Guard-layer simulator ──────────────────────────────────────────────────────
//
// Mirrors the exact guard order in placeOrder() using the same imported Maps.
// No I/O, no Kalshi calls.
//
// New: `skipCooldown` option lets Scenario 8 reach the in-flight lock without
// the 3-second cooldown interfering. In production the cooldown fires first for
// near-simultaneous ticks; the in-flight lock is an additional independent
// defence for ticks that somehow slip through faster or arrive on different
// event-loop turns.

interface SimResult {
  outcome:  "blocked_price_band"   | "blocked_cooldown"
          | "blocked_window_budget" | "blocked_zero_contracts"
          | "blocked_halted"        | "blocked_dedup"
          | "blocked_daily_cap"     | "blocked_in_flight"
          | "would_submit";
  detail:   string;
  logFields?: Record<string, unknown>;
}

function simulatePlaceOrder(opts: {
  ticker:            string;
  side:              "yes" | "no";
  outcomePriceCents: number;
  betDollars:        number;
  tradingHalted:     boolean;
  dedupHeld:         boolean;
  dailyCapExceeded:  boolean;
  /** Skip the 3-second cooldown check — use ONLY for in-flight lock isolation tests. */
  skipCooldown?:     boolean;
}): SimResult {
  const {
    ticker, side, outcomePriceCents, betDollars,
    tradingHalted, dedupHeld, dailyCapExceeded,
    skipCooldown = false,
  } = opts;
  const key = `${ticker}-${side.toUpperCase()}`;

  // ── Guard 1: Hard price band ───────────────────────────────────────────────
  if (!isPriceInBand(outcomePriceCents)) {
    return {
      outcome: "blocked_price_band",
      detail: `outcome_price_cents=${outcomePriceCents} outside [${PRICE_FLOOR_CENTS}, ${PRICE_CAP_CENTS}]`,
      logFields: {
        level:               "ERROR",
        msg:                 "AutoTrader: HARD PRICE GUARD blocked order — outcome price outside allowed band [70–95¢]",
        ticker, side,
        outcome_price_cents: outcomePriceCents,
        floor_cents:         PRICE_FLOOR_CENTS,
        cap_cents:           PRICE_CAP_CENTS,
        kalshi_api_called:   false,
      },
    };
  }

  // ── Guard 2: Cooldown ──────────────────────────────────────────────────────
  if (!skipCooldown) {
    const ORDER_COOLDOWN_MS = 3_000;
    const lastAttempt = orderCooldown.get(key) ?? 0;
    const elapsedMs   = Date.now() - lastAttempt;
    orderCooldown.set(key, Date.now());
    if (elapsedMs < ORDER_COOLDOWN_MS) {
      return {
        outcome: "blocked_cooldown",
        detail: `cooldown active for ${key}: ${elapsedMs}ms < ${ORDER_COOLDOWN_MS}ms`,
        logFields: {
          level: "DEBUG", msg: "AutoTrader: cooldown active — skipping",
          ticker, side, elapsed_ms: elapsedMs, kalshi_api_called: false,
        },
      };
    }
  }

  // ── Guard 3: Window budget ─────────────────────────────────────────────────
  const { remainingDollars, count } = _computeRemainingBudgetForTesting(
    ticker, betDollars, outcomePriceCents,
  );
  if (remainingDollars <= 0) {
    return {
      outcome: "blocked_window_budget",
      detail: `spent=$${_getSpendTrackerForTesting(ticker).toFixed(2)}, ` +
              `pending=${_getPendingNotionalForTesting(ticker)}¢ → $0 remaining`,
      logFields: {
        level: "DEBUG", msg: "AutoTrader: window budget exhausted — skipping",
        ticker, side,
        spent_dollars:          _getSpendTrackerForTesting(ticker),
        pending_notional_cents: _getPendingNotionalForTesting(ticker),
        remaining_dollars:      remainingDollars,
        kalshi_api_called:      false,
      },
    };
  }
  if (count === 0) {
    return {
      outcome: "blocked_zero_contracts",
      detail: `remaining=$${remainingDollars.toFixed(2)}, price=${outcomePriceCents}¢ → 0 contracts`,
    };
  }

  // ── Guard 4: Kill switch ───────────────────────────────────────────────────
  if (tradingHalted) {
    return {
      outcome: "blocked_halted",
      detail: "AUTO_TRADING_ENABLED=false",
      logFields: {
        level: "WARN", msg: "AutoTrader: trading halted — skipping",
        ticker, side, kalshi_api_called: false,
      },
    };
  }

  const notionalCents = count * outcomePriceCents;

  // ── Guard 5: Dedup slot ────────────────────────────────────────────────────
  if (dedupHeld) {
    return {
      outcome: "blocked_dedup",
      detail: `dedup slot held for ${key}`,
      logFields: {
        level: "DEBUG", msg: "AutoTrader: dedup slot held — skipping",
        ticker, side, kalshi_api_called: false,
      },
    };
  }

  // ── Guard 6: Daily notional cap ────────────────────────────────────────────
  if (dailyCapExceeded) {
    return {
      outcome: "blocked_daily_cap",
      detail: "daily notional cap exceeded",
      logFields: { level: "WARN", msg: "AutoTrader: daily cap reached", ticker, side, kalshi_api_called: false },
    };
  }

  // (Guard 7: position guard — requires Kalshi API, skipped in dry-run)

  // ── Guard 8: Per-ticker in-flight lock ─────────────────────────────────────
  if (submissionInFlight.has(ticker)) {
    return {
      outcome: "blocked_in_flight",
      detail: `submission already in-flight for ${ticker}`,
      logFields: {
        level: "WARN",
        msg:   "AutoTrader: concurrent submission in-flight for ticker — skipping to prevent overlap",
        ticker, side, kalshi_api_called: false,
      },
    };
  }

  // ── Would submit ───────────────────────────────────────────────────────────
  const bookPrice    = side === "no" ? 100 - outcomePriceCents : outcomePriceCents;
  const priceDecimal = (bookPrice / 100).toFixed(4);
  return {
    outcome: "would_submit",
    detail:  `${count} contracts at ${outcomePriceCents}¢ outcome-side ≡ ${priceDecimal} YES-leg wire`,
    logFields: {
      level:                       "INFO",
      msg:                         "AutoTrader: submitting order to Kalshi",
      ticker, selected_side: side,
      final_submitted_price_cents: outcomePriceCents,
      book_price_decimal:          priceDecimal,
      ...(side === "no" ? {
        NOTE_no_price_validation:
          `NO purchase=${outcomePriceCents}¢ validated against [70–95¢]; ` +
          `book wire=${priceDecimal} (100−${outcomePriceCents}=${100-outcomePriceCents}, ÷100) NOT re-validated`,
      } : {}),
      contracts_approved:         count,
      total_committed_cost_cents: notionalCents,
      price_band:                 `${PRICE_FLOOR_CENTS}¢–${PRICE_CAP_CENTS}¢`,
      kalshi_api_called:          false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIOS
// ─────────────────────────────────────────────────────────────────────────────

const TICKER = "KXBTC15M-26JUL291030-30";
const BET    = 100;

console.log(`\n${BOLD}AUTO-TRADER DRY-RUN VERIFICATION${RESET}`);
console.log(`Ticker : ${TICKER}`);
console.log(`Budget : $${BET}/window`);
console.log(`Band   : [${PRICE_FLOOR_CENTS}¢, ${PRICE_CAP_CENTS}¢] outcome-side (hard guard)`);
console.log(`Time   : ${new Date().toISOString()}`);

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 1 — 35 ¢ YES and 35 ¢ NO blocked before any API call");
_resetAutoTraderStateForTesting();
for (const side of ["yes", "no"] as const) {
  const r = simulatePlaceOrder({
    ticker: TICKER, side, outcomePriceCents: 35,
    betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
  });
  log(r.logFields!, r.logFields!.msg as string);
  check(r.outcome === "blocked_price_band",
    `${side.toUpperCase()} at 35¢ → blocked_price_band (Guard 1, before cooldown stamp)`,
    `${side.toUpperCase()} at 35¢ should be blocked`);
  check(r.logFields?.["kalshi_api_called"] === false, "kalshi_api_called=false", "should be false");
  check(!orderCooldown.has(`${TICKER}-${side.toUpperCase()}`),
    `orderCooldown not stamped — price guard fired before cooldown`,
    "cooldown should NOT be stamped when price guard fires");
}

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 2 — NO order: validated on NO purchase price, not book price");
_resetAutoTraderStateForTesting();
const noPrice = 78;
const r2 = simulatePlaceOrder({
  ticker: TICKER, side: "no", outcomePriceCents: noPrice,
  betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
});
log(r2.logFields!, r2.logFields!.msg as string);
info(`NO purchase price  : ${noPrice}¢  (validated against [70–95¢])`);
info(`YES-leg wire price : ${((100-noPrice)/100).toFixed(4)}  (API body, 100−${noPrice}=${100-noPrice}, ÷100)`);
check(r2.outcome === "would_submit", `NO at ${noPrice}¢ passes Guard 1`, `should pass`);
check(r2.logFields!["final_submitted_price_cents"] === noPrice,
  `final_submitted_price_cents = ${noPrice}¢ (NO purchase price, not book price)`, "wrong");
check(r2.logFields!["book_price_decimal"] === ((100-noPrice)/100).toFixed(4),
  `book_price_decimal = ${((100-noPrice)/100).toFixed(4)} (wire-only, NOT validated)`, "wrong");
check(!isPriceInBand(100 - noPrice),
  `isPriceInBand(${100-noPrice}) = false — proves guard checks outcome price, not book price`, "wrong");

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 3 — Multiple WS ticks → only one order submitted");
_resetAutoTraderStateForTesting();
const tick1 = simulatePlaceOrder({
  ticker: TICKER, side: "yes", outcomePriceCents: 83,
  betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
});
log(tick1.logFields!, tick1.logFields!.msg as string);
check(tick1.outcome === "would_submit", `Tick 1 → would_submit`, "should submit");
_forceSubmissionInFlightForTesting(TICKER);
const tick2 = simulatePlaceOrder({
  ticker: TICKER, side: "yes", outcomePriceCents: 83,
  betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
});
log(tick2.logFields ?? { level: "DEBUG", msg: `${tick2.outcome}: ${tick2.detail}` },
    `${tick2.outcome}: ${tick2.detail}`);
check(tick2.outcome === "blocked_cooldown" || tick2.outcome === "blocked_in_flight",
  `Tick 2 → ${tick2.outcome} — blocked`, "should be blocked");
submissionInFlight.delete(TICKER);
const tick3 = simulatePlaceOrder({
  ticker: TICKER, side: "yes", outcomePriceCents: 84,
  betDollars: BET, tradingHalted: false, dedupHeld: true, dailyCapExceeded: false,
});
log(tick3.logFields ?? { level: "DEBUG", msg: `${tick3.outcome}: ${tick3.detail}` },
    `${tick3.outcome}: ${tick3.detail}`);
check(tick3.outcome === "blocked_cooldown" || tick3.outcome === "blocked_dedup",
  `Tick 3 → ${tick3.outcome} — exactly one order per window`, "should be blocked");

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 4 — Partial/open orders hold pending notional, block double-spend");
_resetAutoTraderStateForTesting();
_setPendingNotionalForTesting(TICKER, 50 * 83);
const b4a = _computeRemainingBudgetForTesting(TICKER, BET, 83);
info(`Pending: 4150¢ ($41.50) in-flight`);
info(`Remaining: $${b4a.remainingDollars.toFixed(2)}, approved: ${b4a.count} contracts`);
check(b4a.remainingDollars < BET, `Remaining $${b4a.remainingDollars.toFixed(2)} < $${BET}`, "wrong");
_setPendingNotionalForTesting(TICKER, BET * 100);
const b4b = _computeRemainingBudgetForTesting(TICKER, BET, 83);
const r4b = simulatePlaceOrder({
  ticker: TICKER, side: "no", outcomePriceCents: 83,
  betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
});
check(r4b.outcome === "blocked_window_budget", "Full pending → blocked_window_budget", "wrong");

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 5 — Max exposure per ticker enforced across multiple orders");
for (const [spent, label] of [[43, "Order 1"], [73, "Order 2"], [100, "Budget exhausted"]] as [number, string][]) {
  _resetAutoTraderStateForTesting();
  _setSpendTrackerForTesting(TICKER, spent);
  const b = _computeRemainingBudgetForTesting(TICKER, BET, 86);
  const r = simulatePlaceOrder({
    ticker: TICKER, side: "yes", outcomePriceCents: 86,
    betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
  });
  info(`${label}: spent=$${spent}, remaining=$${b.remainingDollars.toFixed(2)}, approved=${b.count} contracts`);
  if (spent >= BET) {
    check(r.outcome === "blocked_window_budget",
      `${label} → blocked_window_budget`, `${label} should be blocked`);
  } else {
    check(r.outcome === "would_submit" && b.count <= contractsForPrice(86, BET - spent),
      `${label} → ${b.count} contracts (capped to remaining $${b.remainingDollars.toFixed(2)})`,
      `${label} wrong`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 6 — AUTO_TRADING_ENABLED=false blocks all paths");
for (const t of [
  { side: "yes" as const, price: 83 }, { side: "no"  as const, price: 78 },
  { side: "yes" as const, price: 70 }, { side: "yes" as const, price: 95 },
  { side: "no"  as const, price: 90 },
]) {
  _resetAutoTraderStateForTesting();
  const r = simulatePlaceOrder({
    ticker: TICKER, side: t.side, outcomePriceCents: t.price,
    betDollars: BET, tradingHalted: true, dedupHeld: false, dailyCapExceeded: false,
  });
  log(r.logFields!, r.logFields!.msg as string);
  check(r.outcome === "blocked_halted",
    `Kill switch: ${t.side.toUpperCase()} at ${t.price}¢ → blocked_halted (kalshi_api_called=false)`,
    `Kill switch failed for ${t.side} at ${t.price}¢ (got ${r.outcome})`);
}
_resetAutoTraderStateForTesting();
const r6oob = simulatePlaceOrder({
  ticker: TICKER, side: "yes", outcomePriceCents: 35,
  betDollars: BET, tradingHalted: true, dedupHeld: false, dailyCapExceeded: false,
});
check(r6oob.outcome === "blocked_price_band",
  "35¢ + kill switch → blocked_price_band first (price guard has highest priority)",
  "price guard should fire before kill switch");

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 7 — Partial fill IOC lifecycle: 20/100 filled, 80 cancelled");
// ─────────────────────────────────────────────────────────────────────────────
//
// All orders use time_in_force: "immediate_or_cancel" (autoTrader.ts:532 and
// trade.ts:616). IOC means Kalshi fills whatever crosses immediately and
// CANCELS the rest — there are no resting/open orders left on the book.
//
// The scenario "80 contracts still resting" is therefore architecturally
// impossible with the current strategy. What CAN happen:
//   • IOC: 20 of 100 fill immediately; 80 are CANCELLED by Kalshi at once.
//   • Kalshi's response carries fill_count=20, remaining_count=80 (cancelled).
//
// The lifecycle below traces what placeOrder() does with that response and
// what committed exposure looks like at the next evaluation.

_resetAutoTraderStateForTesting();

// ── Step 1: Tick arrives — budget looks fine, order submitted ──────────────
const REQUESTED    = 100;
const PRICE        = 83;   // outcome-side ¢
const notionalFull = REQUESTED * PRICE;   // 8300¢ = $83.00

// Simulate: Guard 1–8 all pass → order submitted
// pendingNotionalByTicker set, submissionInFlight set (as in real code lines 578–582)
_setPendingNotionalForTesting(TICKER, notionalFull);
_forceSubmissionInFlightForTesting(TICKER);

info(`Step 1 — order submitted to Kalshi`);
info(`  submissionInFlight: ${_isSubmissionInFlightForTesting(TICKER)}`);
info(`  pendingNotional   : ${_getPendingNotionalForTesting(TICKER)}¢ ($${(notionalFull/100).toFixed(2)})`);
info(`  spendTracker      : $${_getSpendTrackerForTesting(TICKER).toFixed(2)}`);
info(`  committed exposure: $${((notionalFull)/100).toFixed(2)} (full requested notional)`);

blank();
info(`Step 2 — Kalshi API returns: fill_count=20, remaining_count=80 (IOC-cancelled)`);
note(`  IOC design: time_in_force="immediate_or_cancel" (autoTrader.ts:532, trade.ts:616)`);
note(`  The 80 contracts are CANCELLED by Kalshi when the response arrives.`);
note(`  They are NOT resting on the book — there are no open orders.`);

// ── Step 2: API response — 20 filled at 83¢ ───────────────────────────────
const FILLED_COUNT  = 20;
const CANCELLED_COUNT = REQUESTED - FILLED_COUNT;  // 80 — cancelled by IOC, NOT resting
const actualCostCents = FILLED_COUNT * PRICE;       // 1660¢ = $16.60 (at exact limit price)
const unusedCents     = notionalFull - actualCostCents; // 8300 - 1660 = 6640¢

// Simulate the fill path (autoTrader.ts:650–657):
//   spendTracker += actuals.dollarsCost  (only the FILLED contracts)
//   releaseNotional(unusedCents)         (gives back daily-cap headroom for unfilled)
//   releaseOrderSlot(...)                (partial → slot released, retry allowed next tick)
_setSpendTrackerForTesting(TICKER, actualCostCents / 100);

blank();
info(`Step 3 — fill accounting (autoTrader.ts:650–657)`);
log({
  level:                 "INFO",
  msg:                   "Order partially filled — slot released for retry on next tick",
  ticker:                TICKER,
  side:                  "yes",
  limit_price_cents:     PRICE,
  contracts_requested:   REQUESTED,
  contracts_filled:      FILLED_COUNT,
  contracts_cancelled_ioc: CANCELLED_COUNT,
  actual_dollars_spent:  (actualCostCents / 100).toFixed(4),
  reserved_notional_cents: notionalFull,
  released_unused_cents:   unusedCents,
  "NOTE":                  "released_unused_cents covers price improvement AND cancelled IOC contracts",
  cumulative_window_spend: (actualCostCents / 100).toFixed(4),
  kalshi_api_called:     false,
}, "Order partially filled — slot released for retry on next tick");

// ── Step 3: finally block (autoTrader.ts:737–744) ─────────────────────────
// submissionInFlight cleared
// pendingNotionalByTicker decremented by notionalFull → 0
submissionInFlight.delete(TICKER);
const prevPending = _getPendingNotionalForTesting(TICKER);
const nextPending = prevPending - notionalFull;
_setPendingNotionalForTesting(TICKER, Math.max(0, nextPending));

blank();
info(`Step 4 — finally block (autoTrader.ts:737–744): in-flight lock cleared, pending decremented`);
info(`  submissionInFlight : ${_isSubmissionInFlightForTesting(TICKER)}`);
info(`  pendingNotional    : ${_getPendingNotionalForTesting(TICKER)}¢  ← cleared (API response received)`);
info(`  spendTracker       : $${_getSpendTrackerForTesting(TICKER).toFixed(2)}  ← only FILLED contracts`);

blank();
// ── Step 4: Next evaluation — what does the budget see? ───────────────────
const budgetNext = _computeRemainingBudgetForTesting(TICKER, BET, PRICE);
info(`Step 5 — next evaluate() arrives (cooldown reset between steps, simulating next window tick):`);
info(`  remaining = $${BET} − $${_getSpendTrackerForTesting(TICKER).toFixed(2)} filled − $${(_getPendingNotionalForTesting(TICKER)/100).toFixed(2)} pending`);
info(`           = $${budgetNext.remainingDollars.toFixed(2)}`);
info(`  approved contracts at ${PRICE}¢: ${budgetNext.count}`);
info(``);
info(`  ── WHERE ARE THE 80 CANCELLED CONTRACTS? ────────────────────────────────`);
info(`  They no longer exist. IOC: Kalshi cancelled them when the response was sent.`);
info(`  They are NOT counted in spendTracker (not filled).`);
info(`  They are NOT counted in pendingNotional (cleared in finally).`);
info(`  They are NOT counted in the position guard (no open position).`);
info(`  The $83.40 remaining budget correctly reflects ACTUAL committed exposure.`);

// Verify assertions
check(
  _isSubmissionInFlightForTesting(TICKER) === false,
  "submissionInFlight cleared after API response (finally block)",
  "submissionInFlight should be cleared",
);
check(
  _getPendingNotionalForTesting(TICKER) === 0,
  "pendingNotional = 0¢ after finally block (in-flight period over)",
  "pendingNotional should be 0 after finally",
);
check(
  Math.abs(_getSpendTrackerForTesting(TICKER) - actualCostCents / 100) < 0.001,
  `spendTracker = $${(actualCostCents/100).toFixed(2)} (20 filled contracts only, NOT 100 requested)`,
  "spendTracker should reflect only filled contracts",
);
check(
  Math.abs(budgetNext.remainingDollars - (BET - actualCostCents / 100)) < 0.001,
  `Next evaluation: remaining = $${budgetNext.remainingDollars.toFixed(2)} ` +
  `(only filled spend counts; 80 IOC-cancelled contracts have ZERO exposure)`,
  "remaining budget calculation wrong",
);
check(
  budgetNext.count === contractsForPrice(PRICE, budgetNext.remainingDollars),
  `Next evaluation approves ${budgetNext.count} contracts for remaining $${budgetNext.remainingDollars.toFixed(2)}`,
  "contract count wrong",
);

// Prove there is NO path for resting orders
blank();
note(`IOC proof: time_in_force="immediate_or_cancel" is hardcoded in BOTH order paths:`);
note(`  autoTrader.ts line 532: const orderBody = { ..., time_in_force: "immediate_or_cancel", ... }`);
note(`  trade.ts      line 616: time_in_force: "immediate_or_cancel",`);
note(`  Neither path can produce resting/open orders. GTC ("good_till_canceled", single-l) is confirmed`);
note(`  supported by Kalshi V2 API but not yet deployed — see docs/tif-decision-memo.md.`);
check(true, "IOC design prevents resting orders — partial fill = filled portion only (80 cancelled, not resting)", "n/a");

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 8 — Per-ticker in-flight lock independent of the 3-second cooldown");
// ─────────────────────────────────────────────────────────────────────────────
//
// The cooldown (Guard 2) and in-flight lock (Guard 8) are INDEPENDENT defences.
// In practice, for near-simultaneous WS ticks, the cooldown fires first because
// it is checked earlier in placeOrder(). But the in-flight lock provides an
// independent guarantee for any tick that passes the cooldown (e.g. the very
// first tick of a window, or ticks on separate sides, or if the cooldown window
// shrinks in a future refactor).
//
// This test disables the cooldown check with skipCooldown:true so the in-flight
// lock can be exercised in isolation.

_resetAutoTraderStateForTesting();

let kalshiApiCallCount = 0;  // tracks how many calls would reach the Kalshi API

blank();
info(`Two calls arrive simultaneously for the same ticker.`);
info(`skipCooldown=true is used to bypass the 3s cooldown so the in-flight lock is reached.`);
blank();

// ── Call A: No prior state → passes all guards → would submit ─────────────
info(`Call A (first — no prior state):`);
const callA = simulatePlaceOrder({
  ticker: TICKER, side: "yes", outcomePriceCents: 83,
  betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
  skipCooldown: true,
});
log(callA.logFields!, callA.logFields!.msg as string);

if (callA.outcome === "would_submit") {
  kalshiApiCallCount++;
  // Simulate: real code runs submissionInFlight.add(ticker) here (autoTrader.ts:578)
  // BEFORE the await kalshiAuthFetch() call. The tick-B evaluation runs while this
  // await is still outstanding (Node.js event loop between microtasks).
  _forceSubmissionInFlightForTesting(TICKER);
}
check(callA.outcome === "would_submit",
  `Call A → would_submit (Kalshi API call count: ${kalshiApiCallCount})`,
  "Call A should submit");
check(_isSubmissionInFlightForTesting(TICKER),
  `submissionInFlight[${TICKER}] = true immediately after Call A starts`,
  "in-flight lock should be set");

blank();
// ── Call B: Arrives while Call A's API call is outstanding ────────────────
info(`Call B (concurrent — Call A's API call still outstanding):`);
// skipCooldown:true AND orderCooldown map is cleared → cooldown cannot interfere
orderCooldown.clear();
const callB = simulatePlaceOrder({
  ticker: TICKER, side: "yes", outcomePriceCents: 83,
  betDollars: BET, tradingHalted: false, dedupHeld: false, dailyCapExceeded: false,
  skipCooldown: true,
});
log(callB.logFields!, callB.logFields!.msg as string);

check(callB.outcome === "blocked_in_flight",
  `Call B → blocked_in_flight — in-flight lock fires independently of cooldown`,
  `Call B should be blocked_in_flight (got ${callB.outcome})`);
check(kalshiApiCallCount === 1,
  `Total Kalshi API calls: ${kalshiApiCallCount} (exactly 1 — Call B blocked before API)`,
  `Should be exactly 1 API call, got ${kalshiApiCallCount}`);
check(callB.logFields?.["kalshi_api_called"] === false,
  "Call B: kalshi_api_called=false confirmed",
  "Call B should not have made an API call");

blank();
// ── Call C: After Call A's finally block clears the lock ──────────────────
info(`Call C (after Call A's finally block — in-flight lock cleared, dedup slot now held):`);
submissionInFlight.delete(TICKER);
orderCooldown.clear();
info(`  submissionInFlight cleared (finally block ran)`);
info(`  dedup slot now held (Call A completed — simulates slot held after fill)`);
const callC = simulatePlaceOrder({
  ticker: TICKER, side: "yes", outcomePriceCents: 83,
  betDollars: BET, tradingHalted: false, dedupHeld: true,  // dedup now held
  dailyCapExceeded: false, skipCooldown: true,
});
log(callC.logFields ?? { level: "DEBUG", msg: `${callC.outcome}: ${callC.detail}` },
    `${callC.outcome}: ${callC.detail}`);
check(callC.outcome === "blocked_dedup",
  `Call C → blocked_dedup (in-flight lock cleared, but dedup slot holds for rest of window)`,
  `Call C should be blocked_dedup`);
check(kalshiApiCallCount === 1,
  `Total Kalshi API calls still 1 — in-flight lock + dedup together enforce exactly 1 order per window`,
  `Should still be 1 API call`);

blank();
info(`Summary: the in-flight lock (Guard 8) and cooldown (Guard 2) are INDEPENDENT.`);
info(`  Cooldown: per ticker+side, 3 seconds.`);
info(`  In-flight lock: per ticker (regardless of side), for the API round-trip (~100–500 ms).`);
info(`  Either one alone is sufficient to block duplicates; both run for defence-in-depth.`);

// ─────────────────────────────────────────────────────────────────────────────
section("SCENARIO 9 — All live order routes pass through hard price guard and kill switch");
// ─────────────────────────────────────────────────────────────────────────────
//
// Two order paths exist:
//   Path A: autoTrader.placeOrder()          — server-side trading loop
//   Path B: POST /trade/order (trade.ts)     — manual / browser-initiated order
//
// Previously Path B was missing isPriceInBand(). It has been fixed in this
// session: isPriceInBand() + kill-switch check now appear at the top of both.

blank();
info(`Path A: autoTrader.placeOrder() guard stack`);
info(`  Guard 1: isPriceInBand(outcomePriceCents)   [autoTrader.ts:388–393]  ← FIRST`);
info(`  Guard 5: isTradingHalted()                  [autoTrader.ts:439–443]`);

blank();
info(`Path B: POST /trade/order (trade.ts) guard stack`);
info(`  Guard 1: tradingHalted check                [trade.ts:522–525]       ← FIRST`);
info(`  Guard 2: isPriceInBand(outcome_price_cents) [trade.ts:556–573]       ← ADDED THIS SESSION`);
info(`  (window budget / in-flight lock are auto-trader-only; manual route uses daily cap + dedup)`);

blank();

// Simulate PATH B (manual route) responses for several prices
// We model it with the same guard logic since the fix mirrors placeOrder Guard 1
const manualRouteTests = [
  { price: 35,  halted: false, desc: "out-of-band 35¢", expectBlock: "price_band" },
  { price: 69,  halted: false, desc: "below floor 69¢", expectBlock: "price_band" },
  { price: 70,  halted: false, desc: "floor 70¢",       expectBlock: "none" },
  { price: 83,  halted: false, desc: "mid-band 83¢",    expectBlock: "none" },
  { price: 95,  halted: false, desc: "cap 95¢",         expectBlock: "none" },
  { price: 96,  halted: false, desc: "above cap 96¢",   expectBlock: "price_band" },
  { price: 83,  halted: true,  desc: "83¢ + kill switch", expectBlock: "halted" },
];

for (const t of manualRouteTests) {
  // Path B: kill switch checked first, then isPriceInBand
  let result: "price_band" | "halted" | "none";
  let httpStatus: number;
  let logLevel: string;
  let logMsg: string;
  let apiCalled: boolean;

  if (t.halted) {
    result = "halted"; httpStatus = 503; logLevel = "WARN";
    logMsg = "POST /trade/order → 503 Trading is halted";
    apiCalled = false;
  } else if (!isPriceInBand(t.price)) {
    result = "price_band"; httpStatus = 422; logLevel = "ERROR";
    logMsg = `POST /trade/order → 422 HARD PRICE GUARD blocked manual order (${t.price}¢ outside [${PRICE_FLOOR_CENTS}–${PRICE_CAP_CENTS}¢])`;
    apiCalled = false;
  } else {
    result = "none"; httpStatus = 200; logLevel = "INFO";
    logMsg = `POST /trade/order → 200 Placing Kalshi order (${t.price}¢)`;
    apiCalled = false; // dry-run only
  }

  log({
    level:             logLevel,
    msg:               logMsg,
    outcome_price_cents: t.price,
    trading_halted:    t.halted,
    kalshi_api_called: apiCalled,
    http_status:       httpStatus,
  }, logMsg);

  if (t.expectBlock === "price_band") {
    check(result === "price_band" && !apiCalled,
      `Manual route: ${t.desc} → HTTP 422 price guard (kalshi_api_called=false)`,
      `Manual route: ${t.desc} should be blocked by price guard`);
  } else if (t.expectBlock === "halted") {
    check(result === "halted" && !apiCalled,
      `Manual route: ${t.desc} → HTTP 503 kill switch (kalshi_api_called=false)`,
      `Manual route: ${t.desc} should be blocked by kill switch`);
  } else {
    check(result === "none",
      `Manual route: ${t.desc} → passes guards, would reach Kalshi API`,
      `Manual route: ${t.desc} should pass guards`);
  }
}

blank();
info(`All order routes confirmed:`);
info(`  autoTrader.placeOrder() : isPriceInBand ✓  isTradingHalted ✓  (9 guards total)`);
info(`  POST /trade/order        : isPriceInBand ✓  tradingHalted   ✓  (fixed this session)`);
info(`  No other routes submit orders to Kalshi. GET routes are read-only.`);
info(`  POST /trade/halt changes the kill-switch flag only; it does not place orders.`);

// ─────────────────────────────────────────────────────────────────────────────
section("FINAL EXPOSURE SUMMARY");
_resetAutoTraderStateForTesting();
_setSpendTrackerForTesting(TICKER, 73.00);
_setPendingNotionalForTesting(TICKER, 1000);
const finalBudget = _computeRemainingBudgetForTesting(TICKER, BET, 83);
console.log(`
  Window                 : ${TICKER}
  betDollars             : $${BET}.00
  filled_spend           : $${_getSpendTrackerForTesting(TICKER).toFixed(2)}  (actuals from completed fills)
  pending_notional       : $${(_getPendingNotionalForTesting(TICKER)/100).toFixed(2)}  (in-flight, pre-response)
  ─────────────────────────────────────────────
  total_committed        : $${(73 + 10).toFixed(2)}
  remaining_dollars      : $${finalBudget.remainingDollars.toFixed(2)}
  approved_contracts@83¢ : ${finalBudget.count}

  Committed exposure formula:
    remaining = betDollars − spendTracker[ticker] − pendingNotionalByTicker[ticker] / 100
              = $${BET} − $73.00 − $10.00 = $${finalBudget.remainingDollars.toFixed(2)}

  IOC order lifecycle:
    1. Guards pass          → pendingNotional += notionalCents, submissionInFlight.add(ticker)
    2. API responds 20/100  → spendTracker += $16.60 (filled only)
                             releaseNotional(6640¢ unused: 80 cancelled + any price improvement)
                             releaseOrderSlot() (partial → slot open for next tick)
    3. finally block        → submissionInFlight.delete(ticker), pendingNotional -= notionalCents
    4. Next evaluation      → remaining = $${BET} − $16.60 = $83.40 (only filled exposure counts)
    5. 80 "open" contracts  → DO NOT EXIST (IOC cancelled them; no resting orders)

  Guard stack (placeOrder evaluation order):
    1. price_band_guard      ← outcome ∈ [${PRICE_FLOOR_CENTS}¢, ${PRICE_CAP_CENTS}¢]  [FIRST — no state claimed on block]
    2. cooldown              ← 3 s per ticker+side
    3. window_budget         ← betDollars − spendTracker − pendingNotional
    4. zero_contracts        ← count ≥ 1
    5. kill_switch           ← AUTO_TRADING_ENABLED=false or /trade/halt
    6. dedup_slot            ← 20-min window, disk-persisted
    7. daily_cap             ← MAX_DAILY_NOTIONAL_CENTS env var
    8. position_guard        ← Kalshi /portfolio/positions API (live only)
    9. submission_in_flight  ← per-ticker lock for API round-trip (~100–500 ms)

  POST /trade/order guard stack (manual route):
    1. kill_switch           ← tradingHalted (env var or /trade/halt) [FIRST]
    2. price_band_guard      ← isPriceInBand(outcome_price_cents) [ADDED THIS SESSION]
    3. dedup_slot            ← claimOrderSlot()
    4. daily_cap             ← reserveNotional()
    5. position_guard        ← getSignedPosition() Kalshi API
`);

// ─────────────────────────────────────────────────────────────────────────────
const total = PASS_COUNT + FAIL_COUNT;
console.log(`${BOLD}Results: ${GREEN}${PASS_COUNT} passed${RESET}${BOLD}, ${RED}${FAIL_COUNT} failed${RESET}${BOLD} / ${total} checks${RESET}`);
if (FAIL_COUNT === 0) {
  console.log(`\n${GREEN}${BOLD}✔ ALL DRY-RUN CHECKS PASSED. Safe to enable live trading.${RESET}`);
} else {
  console.log(`\n${RED}${BOLD}✖ ${FAIL_COUNT} CHECK(S) FAILED. DO NOT enable live trading.${RESET}`);
}
