import assert from "node:assert/strict";
import test from "node:test";
import type { WindowLogEntry } from "../windowLog.js";
import {
  _readEthReversalDirectAdjacentMoveForTesting,
  _setEthReversalMarketFetcherForTesting,
  proveThreeAdjacentNoSettlements,
} from "./ethReversalServiceRuntime.js";

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

test("Service C direct fallback computes only the exact adjacent Kalshi strike move", async () => {
  const currentOpenMs = Date.parse("2026-09-08T03:30:00.000Z");
  const priorOpenMs = currentOpenMs - 15 * 60_000;
  const ticker = "KXETH15M-26SEP072330-30";
  _setEthReversalMarketFetcherForTesting((async (path: string) => {
    if (path === `/markets/${ticker}`) {
      return { market: { ticker, open_time: new Date(currentOpenMs).toISOString(), floor_strike: 2502 } };
    }
    if (path === "/markets") {
      return { markets: [
        { ticker: "KXETH15M-PRIOR", open_time: new Date(priorOpenMs).toISOString(), floor_strike: 2500 },
        { ticker: "KXETH15M-OLDER", open_time: new Date(priorOpenMs - 15 * 60_000).toISOString(), floor_strike: 2490 },
      ] };
    }
    throw new Error("unexpected path");
  }) as never);

  try {
    const move = await _readEthReversalDirectAdjacentMoveForTesting({
      ticker,
      easternDate: "2026-09-07",
      observedAtMs: currentOpenMs,
      floorStrike: 2502,
      openTimeMs: currentOpenMs,
    });
    assert.equal(move, Math.abs(2502 - 2500) / 2500);
  } finally {
    _setEthReversalMarketFetcherForTesting(null);
  }
});

test("Service C direct fallback fails closed when exact prior strike is ambiguous", async () => {
  const currentOpenMs = Date.parse("2026-09-08T03:45:00.000Z");
  const priorOpenMs = currentOpenMs - 15 * 60_000;
  const ticker = "KXETH15M-26SEP072345-45";
  _setEthReversalMarketFetcherForTesting((async (path: string) => {
    if (path === `/markets/${ticker}`) {
      return { market: { ticker, open_time: new Date(currentOpenMs).toISOString(), floor_strike: 2505 } };
    }
    if (path === "/markets") {
      return { markets: [
        { ticker: "KXETH15M-PRIOR-A", open_time: new Date(priorOpenMs).toISOString(), floor_strike: 2500 },
        { ticker: "KXETH15M-PRIOR-B", open_time: new Date(priorOpenMs).toISOString(), floor_strike: 2501 },
      ] };
    }
    throw new Error("unexpected path");
  }) as never);

  try {
    const move = await _readEthReversalDirectAdjacentMoveForTesting({
      ticker,
      easternDate: "2026-09-07",
      observedAtMs: currentOpenMs,
      floorStrike: 2505,
      openTimeMs: currentOpenMs,
    });
    assert.equal(move, null);
  } finally {
    _setEthReversalMarketFetcherForTesting(null);
  }
});
