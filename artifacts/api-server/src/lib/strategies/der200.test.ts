import assert from "node:assert/strict";
import test from "node:test";
import {
  DER200_MIN_HISTORY,
  DER200_WAGER_CENTS,
  DER200_LIMIT_PRICE_CENTS,
  der200HistoricalAbsoluteMoves,
  evaluateDer200,
} from "./der200.js";
import type { KalshiEth15mHistoricalFact } from "../kalshi.js";

const Q = 15 * 60_000;
const start = Date.UTC(2026, 0, 1, 0, 0, 0);

function facts(moveCount: number, pct = 0.001): KalshiEth15mHistoricalFact[] {
  const rows: KalshiEth15mHistoricalFact[] = [{
    ticker: "KXETH15M-H0", openTimeMs: start, floorStrike: 4000,
  }];
  for (let i = 1; i <= moveCount; i++) {
    const prior = rows[i - 1]!.floorStrike;
    rows.push({
      ticker: `KXETH15M-H${i}`,
      openTimeMs: start + i * Q,
      floorStrike: prior * (1 + (i % 2 === 0 ? pct : -pct)),
    });
  }
  return rows;
}

test("DER200 constants represent one YES contract at 50c", () => {
  assert.equal(DER200_WAGER_CENTS, 50);
  assert.equal(DER200_LIMIT_PRICE_CENTS, 50);
});

test("requires 200 prior valid adjacent moves", () => {
  const historyFacts = facts(DER200_MIN_HISTORY - 1);
  const prior = historyFacts.at(-1)!;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT",
    currentOpenTimeMs: prior.openTimeMs + Q,
    currentFloorStrike: prior.floorStrike * 0.99,
    historyFacts,
  });
  assert.equal(decision.qualifies, false);
  assert.equal(decision.reason, "insufficient_history");
});

test("uses only most recent 200 valid prior adjacent moves", () => {
  const historyFacts = facts(250);
  const currentOpenTimeMs = historyFacts.at(-1)!.openTimeMs + Q;
  assert.equal(der200HistoricalAbsoluteMoves(historyFacts, currentOpenTimeMs).length, DER200_MIN_HISTORY);
});

test("qualifies only on downward move at or above p97", () => {
  const historyFacts = facts(DER200_MIN_HISTORY, 0.001);
  const prior = historyFacts.at(-1)!;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT",
    currentOpenTimeMs: prior.openTimeMs + Q,
    currentFloorStrike: prior.floorStrike * 0.998,
    historyFacts,
  });
  assert.equal(decision.qualifies, true);
  assert.equal(decision.reason, "qualified");
});

test("upward move never qualifies", () => {
  const historyFacts = facts(DER200_MIN_HISTORY, 0.001);
  const prior = historyFacts.at(-1)!;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT",
    currentOpenTimeMs: prior.openTimeMs + Q,
    currentFloorStrike: prior.floorStrike * 1.01,
    historyFacts,
  });
  assert.equal(decision.qualifies, false);
  assert.equal(decision.reason, "not_downward");
});

test("missing exact predecessor fails closed", () => {
  const historyFacts = facts(DER200_MIN_HISTORY, 0.001).filter((_, i, rows) => i !== rows.length - 1);
  const currentOpenTimeMs = start + (DER200_MIN_HISTORY + 1) * Q;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT",
    currentOpenTimeMs,
    currentFloorStrike: 3900,
    historyFacts,
  });
  assert.equal(decision.qualifies, false);
  assert.equal(decision.reason, "missing_exact_predecessor");
});
