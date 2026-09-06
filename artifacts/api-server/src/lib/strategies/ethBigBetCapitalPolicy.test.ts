import assert from "node:assert/strict";
import test from "node:test";
import { buildEthBigBetCapitalBase } from "./ethBigBetCapitalPolicy.js";

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
