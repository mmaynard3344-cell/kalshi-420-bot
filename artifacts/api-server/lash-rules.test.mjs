import assert from "node:assert/strict";
import test from "node:test";
import {
  contractsForStep,
  restingIntent,
  signalFromFinalized,
  transition,
} from "./lash-rules.mjs";

const market = (ticker, result, status = "finalized") => ({ ticker, result, status });

test("two YES outcomes arm NO", () => {
  assert.deepEqual(signalFromFinalized([market("one", "YES"), market("two", "YES")]), {
    side: "NO", streakSide: "YES", signalTicker: "two",
  });
});

test("two NO outcomes arm YES", () => {
  assert.deepEqual(signalFromFinalized([market("one", "NO"), market("two", "NO")]), {
    side: "YES", streakSide: "NO", signalTicker: "two",
  });
});

test("mixed or nonfinal outcomes do not arm", () => {
  assert.equal(signalFromFinalized([market("one", "YES"), market("two", "NO")]), null);
  assert.equal(signalFromFinalized([market("one", "NO"), market("two", "NO", "settled")]), null);
});

test("ladder is 50, 100, 200 dollars at 50 cents", () => {
  assert.deepEqual([0, 1, 2].map(contractsForStep), [100, 200, 400]);
});

test("filled losses advance and retain side", () => {
  assert.deepEqual(transition({ step: 0, side: "NO" }, { filledContracts: 100, officialResult: "YES" }), {
    step: 1, side: "NO", active: true, reason: "loss_advance",
  });
  assert.deepEqual(transition({ step: 1, side: "NO" }, { filledContracts: 200, officialResult: "YES" }), {
    step: 2, side: "NO", active: true, reason: "loss_advance",
  });
});

test("win and third loss reset; zero fill is neutral", () => {
  assert.deepEqual(transition({ step: 1, side: "YES" }, { filledContracts: 200, officialResult: "YES" }), {
    step: 0, side: null, active: false, reason: "win_reset",
  });
  assert.deepEqual(transition({ step: 2, side: "YES" }, { filledContracts: 400, officialResult: "NO" }), {
    step: 0, side: null, active: false, reason: "step_three_loss_reset",
  });
  assert.deepEqual(transition({ step: 2, side: "YES" }, { filledContracts: 0, officialResult: "NO" }), {
    step: 2, side: "YES", active: true, reason: "zero_fill_neutral",
  });
});

test("resting intent is explicitly non-executable", () => {
  assert.deepEqual(restingIntent({ targetTicker: "target", signalTicker: "signal", side: "YES", step: 0 }), {
    strategy: "LASH_L",
    targetTicker: "target",
    signalTicker: "signal",
    side: "YES",
    step: 0,
    principalCents: 5000,
    contracts: 100,
    limitPriceCents: 50,
    timeInForce: "good_till_canceled",
    resting: true,
    executable: false,
  });
});
