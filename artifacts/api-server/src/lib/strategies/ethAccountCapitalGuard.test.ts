import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";

test("big bet is allowed only from capital left after A and safety reserves", () => {
  assert.deepEqual(evaluateEthAccountCapital({
    availableBalanceCents: 200_000,
    martingaleReserveCents: 50_000,
    safetyReserveCents: 25_000,
    otherBigBetReservedCents: 20_000,
    requestedRiskCents: 42_000,
  }), { allowed: true, freeAfterReservationCents: 63_000 });
});

test("B/C cannot consume capital reserved for A", () => {
  assert.deepEqual(evaluateEthAccountCapital({
    availableBalanceCents: 100_000,
    martingaleReserveCents: 50_000,
    safetyReserveCents: 10_000,
    otherBigBetReservedCents: 5_000,
    requestedRiskCents: 42_000,
  }), { allowed: false, reason: "insufficient_unreserved_capital", freeBeforeReservationCents: 35_000 });
});

test("invalid capital evidence fails closed", () => {
  assert.deepEqual(evaluateEthAccountCapital({
    availableBalanceCents: Number.NaN,
    martingaleReserveCents: 0,
    safetyReserveCents: 0,
    otherBigBetReservedCents: 0,
    requestedRiskCents: 42_000,
  }), { allowed: false, reason: "invalid_input", freeBeforeReservationCents: null });
});
