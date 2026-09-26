import assert from "node:assert/strict";
import test from "node:test";
import {
  DER200_CONTRACTS,
  DER200_LIMIT_PRICE_CENTS,
  DER200_MIN_HISTORY,
  der200HistoricalAbsoluteMoves,
  evaluateDer200,
} from "./der200.js";

const Q = 15 * 60_000;
const start = Date.UTC(2026, 0, 1, 0, 0, 0);

function facts(moveCount: number, pct = 0.001) {
  const rows = [{ ticker: "KXETH15M-H0", openTimeMs: start, floorStrike: 4000 }];
  for (let i = 1; i <= moveCount; i++) {
    const prior = rows[i - 1]!.floorStrike!;
    rows.push({
      ticker: `KXETH15M-H${i}`,
      openTimeMs: start + i * Q,
      floorStrike: prior * (1 + (i % 2 === 0 ? pct : -pct)),
    });
  }
  return rows;
}

test("requires 200 prior valid adjacent moves", () => {
  const historyFacts = facts(DER200_MIN_HISTORY - 1);
  const currentOpenTimeMs = start + DER200_MIN_HISTORY * Q;
  const prior = historyFacts.at(-1)!;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT", currentOpenTimeMs,
    currentFloorStrike: prior.floorStrike! * 0.99,
    priorOpenTimeMs: prior.openTimeMs, priorFloorStrike: prior.floorStrike,
    historyFacts,
  });
  assert.equal(decision.qualifies, false);
  assert.equal(decision.reason, "insufficient_history");
});

test("uses only the most recent 200 valid prior adjacent moves", () => {
  const historyFacts = facts(250);
  const currentOpenTimeMs = start + 251 * Q;
  const moves = der200HistoricalAbsoluteMoves(historyFacts, currentOpenTimeMs);
  assert.equal(moves.length, DER200_MIN_HISTORY);
});

test("qualifying downward p97 move creates exactly one YES 50c GTC intent", () => {
  const historyFacts = facts(DER200_MIN_HISTORY, 0.001);
  const prior = historyFacts.at(-1)!;
  const currentOpenTimeMs = prior.openTimeMs + Q;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT", currentOpenTimeMs,
    currentFloorStrike: prior.floorStrike! * 0.998,
    priorOpenTimeMs: prior.openTimeMs, priorFloorStrike: prior.floorStrike,
    historyFacts,
  });
  assert.equal(decision.qualifies, true);
  assert.equal(decision.reason, "qualified");
  assert.deepEqual(decision.orderIntent, {
    side: "yes", contracts: DER200_CONTRACTS, limitPriceCents: DER200_LIMIT_PRICE_CENTS,
    timeInForce: "good_till_canceled",
  });
});

test("upward move never qualifies even when magnitude exceeds p97", () => {
  const historyFacts = facts(DER200_MIN_HISTORY, 0.001);
  const prior = historyFacts.at(-1)!;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT", currentOpenTimeMs: prior.openTimeMs + Q,
    currentFloorStrike: prior.floorStrike! * 1.01,
    priorOpenTimeMs: prior.openTimeMs, priorFloorStrike: prior.floorStrike,
    historyFacts,
  });
  assert.equal(decision.qualifies, false);
  assert.equal(decision.reason, "not_downward");
  assert.equal(decision.orderIntent, null);
});

test("non-adjacent current evidence fails closed", () => {
  const historyFacts = facts(DER200_MIN_HISTORY, 0.001);
  const prior = historyFacts.at(-1)!;
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT", currentOpenTimeMs: prior.openTimeMs + 2 * Q,
    currentFloorStrike: prior.floorStrike! * 0.99,
    priorOpenTimeMs: prior.openTimeMs, priorFloorStrike: prior.floorStrike,
    historyFacts,
  });
  assert.equal(decision.qualifies, false);
  assert.equal(decision.reason, "invalid_current_adjacency");
});

test("future facts cannot leak into the historical percentile", () => {
  const historyFacts = facts(DER200_MIN_HISTORY, 0.001);
  const prior = historyFacts.at(-1)!;
  historyFacts.push({
    ticker: "KXETH15M-FUTURE",
    openTimeMs: prior.openTimeMs + 2 * Q,
    floorStrike: prior.floorStrike! * 2,
  });
  const decision = evaluateDer200({
    ticker: "KXETH15M-CURRENT", currentOpenTimeMs: prior.openTimeMs + Q,
    currentFloorStrike: prior.floorStrike! * 0.998,
    priorOpenTimeMs: prior.openTimeMs, priorFloorStrike: prior.floorStrike,
    historyFacts,
  });
  assert.equal(decision.validHistoricalMoves, DER200_MIN_HISTORY);
  assert.equal(decision.qualifies, true);
});
