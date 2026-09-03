import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateStaleGapCounterfactual,
  type StaleGapCounterfactualInput,
} from "./staleGapCounterfactual.js";

function input(overrides: Partial<StaleGapCounterfactualInput> = {}): StaleGapCounterfactualInput {
  return {
    side: "yes",
    bboDerivedLimitCents: 82,
    l2Levels: [
      { priceCents: 78, contractsApprox: 200, notionalDollars: 156 },
      { priceCents: 80, contractsApprox: 100, notionalDollars: 80 },
    ],
    strategy: { betDollars: 100 },
    budget: { windowRemainingDollars: 100, dailyRemainingNotionalCents: 100_000 },
    exposure: { signedContracts: 0 },
    ...overrides,
  };
}

describe("calculateStaleGapCounterfactual", () => {
  it("calculates an ample-depth YES candidate without mutating its snapshots", () => {
    const value = input();
    const before = structuredClone(value);
    const result = calculateStaleGapCounterfactual(value);

    assert.deepEqual(value, before);
    assert.equal(result.eligibility, "eligible");
    assert.equal(result.intendedLimitCents, 82);
    assert.equal(result.hypotheticalLimitCents, 79);
    assert.equal(result.intendedContracts, 121);
    assert.equal(result.executableDepthContracts, 200);
    assert.equal(result.finalHypotheticalContracts, 121);
    assert.equal(result.finalHypotheticalNotionalCents, 9_559);
  });

  it("caps a candidate by partial L2 depth across multiple price levels", () => {
    const result = calculateStaleGapCounterfactual(input({
      l2Levels: [
        { priceCents: 76, contractsApprox: 10, notionalDollars: 7.6 },
        { priceCents: 79, contractsApprox: 20, notionalDollars: 15.8 },
        { priceCents: 81, contractsApprox: 999, notionalDollars: 809.19 },
      ],
    }));

    assert.equal(result.eligibility, "eligible");
    assert.equal(result.hypotheticalLimitCents, 77);
    assert.equal(result.executableDepthContracts, 10);
    assert.equal(result.liquidityAdjustedContracts, 10);
    assert.equal(result.finalHypotheticalNotionalCents, 770);
  });

  it("rejects absent, zero, and malformed L2 depth", () => {
    for (const l2Levels of [
      [],
      [{ priceCents: 78, contractsApprox: 0, notionalDollars: 0 }],
      [{ priceCents: 100, contractsApprox: 10, notionalDollars: 10 }],
    ]) {
      const result = calculateStaleGapCounterfactual(input({ l2Levels }));
      assert.equal(result.eligibility, "no_executable_depth");
      assert.equal(result.finalHypotheticalContracts, 0);
    }
  });

  it("applies floor clamp and authorized price cap boundaries", () => {
    const floor = calculateStaleGapCounterfactual(input({
      bboDerivedLimitCents: 72,
      l2Levels: [{ priceCents: 68, contractsApprox: 500, notionalDollars: 340 }],
    }));
    assert.equal(floor.eligibility, "eligible");
    assert.equal(floor.hypotheticalLimitCents, 70);

    const cap = calculateStaleGapCounterfactual(input({
      bboDerivedLimitCents: 82,
      strategy: { betDollars: 100, priceCapCents: 80 },
      l2Levels: [{ priceCents: 81, contractsApprox: 500, notionalDollars: 405 }],
    }));
    assert.equal(cap.eligibility, "strategy_limit_exceeded");
    assert.equal(cap.finalHypotheticalContracts, 0);
  });

  it("rejects daily and window budget exhaustion without mutating guard snapshots", () => {
    const daily = calculateStaleGapCounterfactual(input({
      budget: { windowRemainingDollars: 100, dailyRemainingNotionalCents: 1 },
    }));
    assert.equal(daily.eligibility, "daily_cap_exhausted");

    const exhausted = input({
      budget: { windowRemainingDollars: 0, dailyRemainingNotionalCents: 100_000 },
    });
    const before = structuredClone(exhausted);
    const window = calculateStaleGapCounterfactual(exhausted);
    assert.deepEqual(exhausted, before);
    assert.equal(window.eligibility, "window_budget_exhausted");
  });

  it("rejects a candidate that would close a live-side position or exceed exposure", () => {
    const closing = calculateStaleGapCounterfactual(input({
      side: "yes",
      exposure: { signedContracts: -5 },
    }));
    assert.equal(closing.eligibility, "position_rejected");

    const limited = calculateStaleGapCounterfactual(input({
      side: "no",
      exposure: { signedContracts: 0, maxAbsoluteContracts: 10 },
    }));
    assert.equal(limited.eligibility, "exposure_limit_rejected");
  });

  it("uses correct counterparty-normalized prices for a NO candidate", () => {
    const result = calculateStaleGapCounterfactual(input({
      side: "no",
      bboDerivedLimitCents: 80,
      l2Levels: [{ priceCents: 75, contractsApprox: 300, notionalDollars: 225 }],
    }));

    assert.equal(result.eligibility, "eligible");
    assert.equal(result.hypotheticalLimitCents, 76);
    assert.equal(result.finalHypotheticalContracts, 125);
  });

  it("rejects invalid inputs and is deterministic across repeated calculation", () => {
    const invalid = calculateStaleGapCounterfactual(input({ bboDerivedLimitCents: null }));
    assert.equal(invalid.eligibility, "invalid_input");

    const value = input();
    assert.deepEqual(
      calculateStaleGapCounterfactual(value),
      calculateStaleGapCounterfactual(value),
    );
  });
});