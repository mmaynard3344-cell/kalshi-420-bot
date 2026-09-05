import assert from "node:assert/strict";
import test from "node:test";
import type { WindowLogEntry } from "../windowLog.js";
import { proveThreeAdjacentNoSettlements } from "./ethReversalServiceRuntime.js";

const T = Date.parse("2026-09-06T00:00:00.000Z");
function row(closeMs: number, result: "yes" | "no", overrides: Partial<WindowLogEntry> = {}): WindowLogEntry {
  return {
    ticker: `KXETH15M-${closeMs}`,
    series: "KXETH15M",
    closeTime: new Date(closeMs).toISOString(),
    firstSeenMs: closeMs - 15 * 60_000,
    entered: true,
    inZone: false,
    yesDerivedAsk: null,
    noDerivedAsk: null,
    outcome: "out_of_zone",
    side: null,
    priceCents: null,
    contractsFilled: null,
    spentDollars: null,
    skipReason: null,
    settlementResult: result,
    ...overrides,
  };
}

test("Service C proves only three immediately adjacent NO settlements", () => {
  assert.equal(proveThreeAdjacentNoSettlements([
    row(T, "no"), row(T - 15 * 60_000, "no"), row(T - 30 * 60_000, "no"),
  ], T), 3);
  assert.equal(proveThreeAdjacentNoSettlements([
    row(T, "no"), row(T - 15 * 60_000, "yes"), row(T - 30 * 60_000, "no"),
  ], T), null);
  assert.equal(proveThreeAdjacentNoSettlements([
    row(T, "no"), row(T - 30 * 60_000, "no"),
  ], T), null);
});

test("Service C fails closed on conflicting duplicate settlement evidence", () => {
  assert.equal(proveThreeAdjacentNoSettlements([
    row(T, "no"), row(T, "yes"),
    row(T - 15 * 60_000, "no"), row(T - 30 * 60_000, "no"),
  ], T), null);
});

test("non-ETH and unfinalized window rows cannot satisfy C", () => {
  assert.equal(proveThreeAdjacentNoSettlements([
    row(T, "no", { series: "KXBTC15M" }),
    row(T - 15 * 60_000, "no"), row(T - 30 * 60_000, "no"),
  ], T), null);
  assert.equal(proveThreeAdjacentNoSettlements([
    row(T, "no", { settlementResult: null }),
    row(T - 15 * 60_000, "no"), row(T - 30 * 60_000, "no"),
  ], T), null);
});
