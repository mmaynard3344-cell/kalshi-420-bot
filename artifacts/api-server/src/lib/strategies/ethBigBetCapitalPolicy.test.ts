import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { buildEthBigBetCapitalBase } from "./ethBigBetCapitalPolicy.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";

const facts = {
  exchangeIndex: 2,
  availableBalanceCents: 200_000,
  otherBigBetReservedCents: 42_000,
  observedAtMs: 1_000,
};

test("explicit reserve policy produces capital-guard base without requested risk", () => {
  assert.deepEqual(buildEthBigBetCapitalBase(facts, {
    martingaleReserveCents: 48_000,
    safetyReserveCents: 25_000,
  }), {
    availableBalanceCents: 200_000,
    martingaleReserveCents: 48_000,
    safetyReserveCents: 25_000,
    otherBigBetReservedCents: 42_000,
  });
});

test("missing facts or policy fail closed", () => {
  assert.equal(buildEthBigBetCapitalBase(null, {
    martingaleReserveCents: 48_000,
    safetyReserveCents: 25_000,
  }), null);
  assert.equal(buildEthBigBetCapitalBase(facts, null), null);
});

test("invalid reserve values fail closed instead of defaulting", () => {
  assert.equal(buildEthBigBetCapitalBase(facts, {
    martingaleReserveCents: -1,
    safetyReserveCents: 25_000,
  }), null);
  assert.equal(buildEthBigBetCapitalBase(facts, {
    martingaleReserveCents: 48_000,
    safetyReserveCents: Number.NaN,
  }), null);
});

test("malformed authoritative facts fail closed", () => {
  assert.equal(buildEthBigBetCapitalBase({ ...facts, availableBalanceCents: Number.NaN }, {
    martingaleReserveCents: 48_000,
    safetyReserveCents: 25_000,
  }), null);
  assert.equal(buildEthBigBetCapitalBase({ ...facts, otherBigBetReservedCents: -1 }, {
    martingaleReserveCents: 48_000,
    safetyReserveCents: 25_000,
  }), null);
});

test("candidate conservative policy protects one max A order plus one full C-sized safety cushion", () => {
  const aMaxRisk = ethBigBetCapitalRiskCents(42_000, 50);
  const bRisk = ethBigBetCapitalRiskCents(42_000, 50);
  const cRisk = ethBigBetCapitalRiskCents(50_000, 50);
  assert.equal(aMaxRisk, 43_470);
  assert.equal(bRisk, 43_470);
  assert.equal(cRisk, 51_750);

  const policy = {
    martingaleReserveCents: aMaxRisk,
    safetyReserveCents: cRisk,
  };
  const protectedBase = policy.martingaleReserveCents + policy.safetyReserveCents;
  assert.equal(protectedBase, 95_220);

  // With no unresolved B/C risk, B is admitted exactly at its full protected threshold.
  assert.deepEqual(evaluateEthAccountCapital({
    availableBalanceCents: protectedBase + bRisk,
    ...policy,
    otherBigBetReservedCents: 0,
    requestedRiskCents: bRisk,
  }), { allowed: true, freeAfterReservationCents: 0 });

  // One cent less must fail closed.
  assert.deepEqual(evaluateEthAccountCapital({
    availableBalanceCents: protectedBase + bRisk - 1,
    ...policy,
    otherBigBetReservedCents: 0,
    requestedRiskCents: bRisk,
  }), { allowed: false, reason: "insufficient_unreserved_capital", freeBeforeReservationCents: bRisk - 1 });

  // B and C may both own the same market only when the account can fund both
  // fee-inclusive risks after preserving the protected base.
  assert.deepEqual(evaluateEthAccountCapital({
    availableBalanceCents: protectedBase + bRisk + cRisk,
    ...policy,
    otherBigBetReservedCents: bRisk,
    requestedRiskCents: cRisk,
  }), { allowed: true, freeAfterReservationCents: 0 });

  assert.equal(protectedBase + bRisk + cRisk, 190_440);
});
