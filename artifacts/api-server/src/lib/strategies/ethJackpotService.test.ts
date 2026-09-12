import assert from "node:assert/strict";
import test from "node:test";
import {
  JACKPOT_MAX_PRICE_CENTS,
  JACKPOT_WAGER_CENTS,
  jackpotContracts,
  jackpotWireOrder,
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
  }), false, "50c executable depth is not a Jackpot");
  assert.equal(shouldTriggerJackpot({
    exchangeFillCount: 0, fillCountProvided: true, orderStatus: "resting",
    bestAskCents: 91, depthAt50Contracts: 0,
  }), false, "above-ceiling runaway fails closed");
  assert.equal(shouldTriggerJackpot({
    exchangeFillCount: 0, fillCountProvided: false, orderStatus: "resting",
    bestAskCents: 61, depthAt50Contracts: 0,
  }), false, "missing authoritative fill count fails closed");
});

test("Jackpot validation size cannot exceed $10 at the 90c ceiling", () => {
  assert.equal(JACKPOT_WAGER_CENTS, 1000);
  assert.equal(JACKPOT_MAX_PRICE_CENTS, 90);
  assert.equal(jackpotContracts(), 11);
  assert.ok(jackpotContracts() * JACKPOT_MAX_PRICE_CENTS <= JACKPOT_WAGER_CENTS);
});

test("Jackpot uses native IOC and correct Kalshi wire complement for NO", () => {
  const yes = jackpotWireOrder({ ticker: "KXETH15M-X", side: "yes", clientOrderId: "y", exchangeIndex: 1 });
  assert.equal(yes.time_in_force, "immediate_or_cancel");
  assert.equal(yes.side, "bid");
  assert.equal(yes.price, "0.9000");
  assert.equal(yes.count, "11.00");

  const no = jackpotWireOrder({ ticker: "KXETH15M-X", side: "no", clientOrderId: "n", exchangeIndex: 1 });
  assert.equal(no.time_in_force, "immediate_or_cancel");
  assert.equal(no.side, "ask");
  assert.equal(no.price, "0.1000", "BUY NO at 90c is SELL YES at 10c on V2 wire");
  assert.equal(no.count, "11.00");
});

test("descriptive sweep quote respects both budget and ceiling", () => {
  const q = sweepQuote([
    { priceCents: 60, contracts: 5 },
    { priceCents: 65, contracts: 10 },
    { priceCents: 95, contracts: 100 },
  ], 1000, 90);
  assert.equal(q.contracts, 15);
  assert.equal(q.costCents, 950);
  assert.equal(q.unusedBudgetCents, 50);
  assert.equal(q.vwapCents, 950 / 15);
});
