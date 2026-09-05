import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEth420Candidate,
  type Eth420EvaluationInput,
} from "./eth420SixStepCandidate.js";

function input(overrides: Partial<Eth420EvaluationInput> = {}): Eth420EvaluationInput {
  const currentOpen = 2_000_000_000_000;
  const priorOpen = currentOpen - 15 * 60_000;
  const trailingMoves = Array.from({ length: 100 }, (_, i) => 0.001 + i * 0.00001);
  return {
    ticker: "KXETH15M-CUTOVER",
    easternDate: "2026-09-05",
    observedAtMs: currentOpen,
    floorStrike: 100.2,
    openTimeMs: currentOpen,
    priorMarket: {
      ticker: "KXETH15M-PRIOR",
      easternDate: "2026-09-05",
      observedAtMs: priorOpen,
      floorStrike: 100,
      openTimeMs: priorOpen,
    },
    trailingMoves,
    state: {
      easternDate: "2026-09-05",
      side: "no",
      step: 2,
      realizedPnlCents: 0,
      lastBlockResetAtMs: null,
    },
    estimatedFeeCents: 210,
    ...overrides,
  };
}

test("Service A never upsizes its ladder wager when the p95-p99 jump band fires", () => {
  const base = input();
  const sorted = [...base.trailingMoves].filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const p95Index = (sorted.length - 1) * 0.95;
  const lo = Math.floor(p95Index), hi = Math.ceil(p95Index);
  const p95 = lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (p95Index - lo);
  const p99Index = (sorted.length - 1) * 0.99;
  const lo99 = Math.floor(p99Index), hi99 = Math.ceil(p99Index);
  const p99 = lo99 === hi99 ? sorted[lo99]! : sorted[lo99]! + (sorted[hi99]! - sorted[lo99]!) * (p99Index - lo99);
  const targetMove = (p95 + p99) / 2;
  const priorFloor = base.priorMarket!.floorStrike!;
  const decision = evaluateEth420Candidate({
    ...base,
    floorStrike: priorFloor * (1 + targetMove),
  });
  assert.equal(decision.resultingBand, "p95_to_p99");
  assert.equal(decision.normalWagerCents, 6000);
  assert.equal(decision.effectiveWagerCents, decision.normalWagerCents);
  assert.equal(decision.overrideIncreasedWager, false);
});
