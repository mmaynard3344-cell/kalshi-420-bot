import assert from "node:assert/strict";
import test from "node:test";
import {
  JACKPOT_MAX_PRICE_CENTS,
  JACKPOT_REOBSERVE_COOLDOWN_MS,
  JACKPOT_REOBSERVE_WINDOW_MS,
  JACKPOT_WAGER_CENTS,
  jackpotContracts,
  jackpotWireOrder,
  shouldReobserveJackpotAttempt,
  shouldTriggerJackpot,
  sweepQuote,
} from "./ethJackpotService.js";

test("Jackpot triggers only on authoritative A zero fill with runaway book", () => {
  assert.equal(shouldTriggerJackpot({
    exchangeFillCount: 0, fillCountProvided: true, orderStatus: "resting",
    bestAskCents: 61, depthAt50Contracts: 0,
  }), true);
  assert.equal(shouldTriggerJackpot({
    exchangeFillCount: 1, fillCountProvided: true, orderStatus: "resting",
    bestAskCents: 61, depthAt50Contracts: 0,
  }), false, "any A fill blocks J");
  assert.equal(shouldTriggerJackpot({
    exchangeFillCount: 0, fillCountProvided: true, orderStatus: "resting",
    bestAskCents: 61, depthAt50Contracts: 2,
  }), false, "50c executable depth is not a rescue");
  assert.equal(shouldTriggerJackpot({
    exchangeFillCount: 0, fillCountProvided: true, orderStatus: "resting",
    bestAskCents: 76, depthAt50Contracts: 0,
  }), false, "above-ceiling runaway fails closed");
  assert.equal(shouldTriggerJackpot({
    exchangeFillCount: 0, fillCountProvided: false, orderStatus: "resting",
    bestAskCents: 61, depthAt50Contracts: 0,
  }), false, "missing authoritative fill count fails closed");
});

test("Jackpot only re-observes a zero-fill during the short rescue window", () => {
  const now = 1_000_000;
  assert.equal(JACKPOT_REOBSERVE_WINDOW_MS, 5_000);
  assert.equal(shouldReobserveJackpotAttempt({
    status: "no_trigger", reason: "ask_not_runaway",
    updatedAtMs: now - JACKPOT_REOBSERVE_COOLDOWN_MS,
    orderCreatedAtMs: now - 2_000, nowMs: now,
  }), true);
  assert.equal(shouldReobserveJackpotAttempt({
    status: "no_trigger", reason: "depth_at_50",
    updatedAtMs: now - JACKPOT_REOBSERVE_COOLDOWN_MS,
    orderCreatedAtMs: now - 2_000, nowMs: now,
  }), true);
  assert.equal(shouldReobserveJackpotAttempt({
    status: "no_trigger", reason: "ask_above_75",
    updatedAtMs: now - 1_000, orderCreatedAtMs: now - 2_000, nowMs: now,
  }), false, "overshoot above the chase ceiling is terminal for J");
  assert.equal(shouldReobserveJackpotAttempt({
    status: "no_trigger", reason: "a_filled",
    updatedAtMs: now - 1_000, orderCreatedAtMs: now - 2_000, nowMs: now,
  }), false, "an A fill is terminal for J");
  assert.equal(shouldReobserveJackpotAttempt({
    status: "blocked", reason: "a_not_still_resting_zero_fill",
    updatedAtMs: now - 1_000, orderCreatedAtMs: now - 2_000, nowMs: now,
  }), false, "blocked safety states are never re-opened");
  assert.equal(shouldReobserveJackpotAttempt({
    status: "no_trigger", reason: "ask_not_runaway",
    updatedAtMs: now - JACKPOT_REOBSERVE_COOLDOWN_MS + 1,
    orderCreatedAtMs: now - 2_000, nowMs: now,
  }), false, "cooldown prevents a read storm");
  assert.equal(shouldReobserveJackpotAttempt({
    status: "no_trigger", reason: "ask_not_runaway",
    updatedAtMs: now - 1_000,
    orderCreatedAtMs: now - JACKPOT_REOBSERVE_WINDOW_MS,
    nowMs: now,
  }), false, "re-observation cannot outlive the 5-second rescue window");
});

test("Jackpot fixed $100 sizing respects the 75c ceiling", () => {
  assert.equal(JACKPOT_WAGER_CENTS, 10_000);
  assert.equal(JACKPOT_MAX_PRICE_CENTS, 75);
  assert.equal(jackpotContracts(), Math.floor(JACKPOT_WAGER_CENTS / JACKPOT_MAX_PRICE_CENTS));
  assert.ok(jackpotContracts() * JACKPOT_MAX_PRICE_CENTS <= JACKPOT_WAGER_CENTS);
});

test("Jackpot uses native IOC and correct Kalshi wire complement for NO", () => {
  const expectedCount = `${jackpotContracts()}.00`;
  const yes = jackpotWireOrder({ ticker: "KXETH15M-X", side: "yes", clientOrderId: "y", exchangeIndex: 1 });
  assert.equal(yes.time_in_force, "immediate_or_cancel");
  assert.equal(yes.side, "bid");
  assert.equal(yes.price, "0.7500");
  assert.equal(yes.count, expectedCount);

  const no = jackpotWireOrder({ ticker: "KXETH15M-X", side: "no", clientOrderId: "n", exchangeIndex: 1 });
  assert.equal(no.time_in_force, "immediate_or_cancel");
  assert.equal(no.side, "ask");
  assert.equal(no.price, "0.2500", "BUY NO at 75c is SELL YES at 25c on V2 wire");
  assert.equal(no.count, expectedCount);
});

test("descriptive sweep quote respects both budget and ceiling", () => {
  const q = sweepQuote([
    { priceCents: 60, contracts: 5 },
    { priceCents: 65, contracts: 10 },
    { priceCents: 80, contracts: 100 },
  ], 1000, 75);
  assert.equal(q.contracts, 15);
  assert.equal(q.costCents, 950);
  assert.equal(q.unusedBudgetCents, 50);
  assert.equal(q.vwapCents, 950 / 15);
});
