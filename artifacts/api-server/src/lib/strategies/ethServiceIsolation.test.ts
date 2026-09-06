import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEthServiceRole,
  serviceMayRunMartingale,
  serviceOwnsJump,
  serviceOwnsMartingale,
  serviceOwnsReversal,
} from "./ethServiceRole.js";
import { dispatchEthServiceSignal } from "./ethServiceDispatch.js";
import {
  ETH_MARTINGALE_ORDER_TAG,
  ETH_MARTINGALE_WAGERS_CENTS,
  evaluateEthMartingaleSignal,
} from "./ethMartingaleSignal.js";
import { ETH_JUMP_ORDER_TAG, ETH_JUMP_WAGER_CENTS, evaluateEthJumpSignal } from "./ethJumpSignal.js";
import {
  ETH_REVERSAL_ORDER_TAG,
  ETH_REVERSAL_WAGER_CENTS,
  evaluateEthNoStreakReversal,
} from "./ethNoStreakReversal.js";

test("service roles have exclusive strategy ownership", () => {
  const martingale = parseEthServiceRole("martingale");
  const jump = parseEthServiceRole("jump");
  const reversal = parseEthServiceRole("reversal");
  assert.equal(serviceOwnsMartingale(martingale), true);
  assert.equal(serviceOwnsJump(martingale), false);
  assert.equal(serviceOwnsReversal(martingale), false);
  assert.equal(serviceOwnsMartingale(jump), false);
  assert.equal(serviceOwnsJump(jump), true);
  assert.equal(serviceOwnsReversal(jump), false);
  assert.equal(serviceOwnsMartingale(reversal), false);
  assert.equal(serviceOwnsJump(reversal), false);
  assert.equal(serviceOwnsReversal(reversal), true);
  assert.equal(parseEthServiceRole(""), null);
  assert.equal(parseEthServiceRole("both"), null);
});

test("A runtime gate preserves truly-unset legacy behavior but fails closed on explicit B/C or invalid roles", () => {
  assert.equal(serviceMayRunMartingale(null, undefined), true);
  assert.equal(serviceMayRunMartingale("martingale", "martingale"), true);
  assert.equal(serviceMayRunMartingale("jump", "jump"), false);
  assert.equal(serviceMayRunMartingale("reversal", "reversal"), false);
  assert.equal(serviceMayRunMartingale(null, ""), false);
  assert.equal(serviceMayRunMartingale(null, "jumpp"), false);
  assert.equal(serviceMayRunMartingale(null, "both"), false);
});

test("Service A owns only its six-rung martingale wager", () => {
  assert.deepEqual(ETH_MARTINGALE_WAGERS_CENTS, [1500, 3000, 6000, 12000, 24000, 32000]);
  const decision = evaluateEthMartingaleSignal({ side: "no", step: 4 });
  assert.deepEqual(decision, {
    strategy: "martingale",
    orderTag: ETH_MARTINGALE_ORDER_TAG,
    side: "no",
    step: 4,
    wagerCents: 24000,
  });
  assert.notEqual(decision.wagerCents, ETH_JUMP_WAGER_CENTS);
  assert.notEqual(ETH_MARTINGALE_ORDER_TAG, ETH_JUMP_ORDER_TAG);
  assert.notEqual(ETH_MARTINGALE_ORDER_TAG, ETH_REVERSAL_ORDER_TAG);
});

test("role-gated dispatch cannot evaluate another service", () => {
  const allInputs = {
    martingaleState: { side: "no" as const, step: 2 },
    jump: { currentMove: 0.06, p95: 0.05, p99: 0.09, carriedSide: "no" as const },
    reversal: { consecutiveNoOutcomes: 3, currentMove: 0.06, p95: 0.05, p99: 0.09 },
  };
  const a = dispatchEthServiceSignal({ role: "martingale", ...allInputs });
  const b = dispatchEthServiceSignal({ role: "jump", ...allInputs });
  const c = dispatchEthServiceSignal({ role: "reversal", ...allInputs });
  assert.equal(a?.role, "martingale");
  assert.equal(b?.role, "jump");
  assert.equal(c?.role, "reversal");
  assert.equal(a?.role === "martingale" ? a.decision.wagerCents : null, 6000);
  assert.equal(b?.role === "jump" ? b.decision.fires : null, true);
  assert.equal(b?.role === "jump" ? b.decision.side : null, "no");
  assert.equal(c?.role === "reversal" ? c.decision.wagerCents : null, 10000);
});

test("jump signal is fixed-size, preserves A side read-only, and p95 inclusive / p99 exclusive", () => {
  assert.equal(ETH_JUMP_WAGER_CENTS, 42_000);
  assert.notEqual(ETH_JUMP_ORDER_TAG, ETH_REVERSAL_ORDER_TAG);
  assert.deepEqual(evaluateEthJumpSignal({ currentMove: 0.05, p95: 0.05, p99: 0.09, carriedSide: "yes" }), {
    fires: true, band: "p95_to_p99", side: "yes",
  });
  assert.equal(evaluateEthJumpSignal({ currentMove: 0.05, p95: 0.05, p99: 0.09 }).fires, false);
  assert.equal(evaluateEthJumpSignal({ currentMove: 0.09, p95: 0.05, p99: 0.09, carriedSide: "no" }).fires, false);
});

test("reversal requires 3+ NO outcomes and uses an independent $100 wager", () => {
  assert.equal(ETH_REVERSAL_WAGER_CENTS, 10_000);
  assert.equal(evaluateEthNoStreakReversal({ consecutiveNoOutcomes: 2, currentMove: 0.06, p95: 0.05, p99: 0.09 }).fires, false);
  const decision = evaluateEthNoStreakReversal({ consecutiveNoOutcomes: 3, currentMove: 0.06, p95: 0.05, p99: 0.09 });
  assert.equal(decision.fires, true);
  assert.equal(decision.side, "yes");
  assert.equal(decision.wagerCents, 10_000);
});
