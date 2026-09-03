/**
 * Dispatch boundary regression tests.
 *
 * Retired strategy guards are tested as pure functions in preflightGate.ts and
 * autoTraderGuards.ts. This suite protects the live boundary instead: only an
 * ETH ticker may reach the ETH martingale evaluator, the sole new-entry POST
 * owner.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  _restFetchAllForTesting,
  _evaluateForTesting,
  _clearAutoTraderTestOverrides,
  _setEvaluateEthNoMartingaleForTesting,
  _setKalshiAuthFetchForTesting,
  _setKalshiSeriesFetchForTesting,
  _scheduleEthBoundaryDiscoveryForTesting,
} from "./autoTrader.js";
import type { MarketState } from "./autoTrader.js";
import {
  _setEthNoMartingaleDependenciesForTesting,
} from "./strategies/ethOnlyMartingale.js";
import {
  _resetProtectiveExitForTesting,
  _setProtectiveExitPositionLookupForTesting,
} from "./protectiveExit.js";

function openState(ticker: string): MarketState {
  return {
    ticker,
    exchangeIndex: 2,
    closeTime: new Date(Date.now() + 60_000).toISOString(),
    openTime: null,
    expirationTime: null,
    status: "open",
    lastPrice: null,
    yesBid: 50,
    yesAsk: 50,
    noBid: 50,
    noAsk: 50,
    bidUpdatedMs: Date.now(),
  };
}

describe("new-entry dispatcher boundary", () => {
  afterEach(() => {
    mock.timers.reset();
    _setEthNoMartingaleDependenciesForTesting(null);
    _clearAutoTraderTestOverrides();
    _resetProtectiveExitForTesting();
    delete process.env["ETH_NO_MARTINGALE_ENABLED"];
  });

  it("never lets BTC, SOL, or DOGE route into a new-entry POST", async () => {
    let postCount = 0;
    let reservationCount = 0;
    const now = Date.now();
    process.env["ETH_NO_MARTINGALE_ENABLED"] = "true";
    _setProtectiveExitPositionLookupForTesting(async () => 0);
    _setEthNoMartingaleDependenciesForTesting({
      now: () => now,
      isEthOrderSubmissionPermitted: () => true,
      store: {
        listUnsettledEthMartingaleOrders: async () => [],
        getEthMartingaleState: async () => ({
          easternDate: "2026-08-23",
          side: "no",
          martingaleStep: 0,
          spentCents: 0,
          realizedPnlCents: 0,
        }),
        reserveEthMartingaleEntry: async () => {
          reservationCount++;
          return true;
        },
        markEthMartingaleOrderPostStarted: async () => true,
        expireEthMartingaleReservation: async () => true,
        updateEthMartingaleOrder: async () => true,
        settleEthMartingaleOrder: async () => true,
      } as never,
      authFetch: async <T>(method: string): Promise<T> => {
        if (method === "POST") postCount++;
        return {} as T;
      },
    });
    _setKalshiAuthFetchForTesting(async <T>(method: string): Promise<T> => {
      if (method === "POST") postCount++;
      return {} as T;
    });

    await Promise.all([
      _evaluateForTesting(openState("KXBTC15M-retired-route"), 100, "websocket"),
      _evaluateForTesting(openState("KXSOL15M-retired-route"), 100, "websocket"),
      _evaluateForTesting(openState("KXDOGE15M-retired-route"), 100, "websocket"),
    ]);

    assert.equal(
      postCount,
      0,
      "non-ETH ticks must not reach the ETH martingale's new-entry POST dependency",
    );
    assert.equal(
      reservationCount,
      0,
      "non-ETH ticks must not reach the ETH martingale's durable entry reservation",
    );
  });

  it("re-evaluates the already-open ETH window once after the REST reconciliation sweep", async () => {
    const events: string[] = [];
    const exchangeIndexes: Array<number | null> = [];
    const ticker = "KXETH15M-handoff";
    _setKalshiSeriesFetchForTesting(async () => ({
      ticker,
      exchange_index: 2,
      status: "open",
      open_time: new Date(Date.now() - 60_000).toISOString(),
      close_time: new Date(Date.now() + 5 * 60_000).toISOString(),
    }));
    _setEvaluateEthNoMartingaleForTesting(async (state) => {
      exchangeIndexes.push(state.exchangeIndex ?? null);
      events.push(`evaluate:${state.ticker}`);
    });
    _setEthNoMartingaleDependenciesForTesting({
      store: {
        listEthMartingaleOrdersNeedingFillEconomics: async () => {
          events.push("reconcile:fill-economics");
          return [];
        },
        listUnsettledEthMartingaleOrders: async () => {
          events.push("reconcile:unsettled");
          return [];
        },
      } as never,
    });

    await _restFetchAllForTesting("rest_fallback");

    assert.deepEqual(events, [
      `evaluate:${ticker}`,
      "reconcile:fill-economics",
      "reconcile:unsettled",
      "reconcile:unsettled",
      `evaluate:${ticker}`,
    ]);
    assert.deepEqual(exchangeIndexes, [2, 2], "REST market exchange index must reach every ETH evaluation");
  });

  it("clears a stale exchange index when an authoritative REST snapshot omits it", async () => {
    const ticker = "KXETH15M-exchange-index-clear";
    const exchangeIndexes: Array<number | null> = [];
    let includeExchangeIndex = true;
    _setKalshiSeriesFetchForTesting(async () => ({
      ticker,
      ...(includeExchangeIndex ? { exchange_index: 2 } : {}),
      status: "open",
      open_time: new Date(Date.now() - 60_000).toISOString(),
      close_time: new Date(Date.now() + 5 * 60_000).toISOString(),
    }));
    _setEvaluateEthNoMartingaleForTesting(async (state) => {
      exchangeIndexes.push(state.exchangeIndex ?? null);
    });
    _setEthNoMartingaleDependenciesForTesting({
      store: {
        listEthMartingaleOrdersNeedingFillEconomics: async () => [],
        listUnsettledEthMartingaleOrders: async () => [],
      } as never,
    });

    await _restFetchAllForTesting("rest_fallback");
    includeExchangeIndex = false;
    await _restFetchAllForTesting("rest_fallback");

    assert.ok(exchangeIndexes.includes(2), "the initial REST snapshot supplies its exchange index");
    assert.ok(
      exchangeIndexes.includes(null),
      "a later authoritative REST snapshot without an index must clear stale routing metadata",
    );
  });

  it("retries one unresolved ETH handoff quickly and re-evaluates the current ticker", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const ticker = "KXETH15M-retry-handoff";
    let evaluations = 0;
    _setKalshiSeriesFetchForTesting(async () => ({
      ticker,
      status: "open",
      open_time: new Date(Date.now() - 60_000).toISOString(),
      close_time: new Date(Date.now() + 5 * 60_000).toISOString(),
    }));
    _setEvaluateEthNoMartingaleForTesting(async (state) => {
      if (state.ticker === ticker) evaluations++;
    });
    _setEthNoMartingaleDependenciesForTesting({
      store: {
        listEthMartingaleOrdersNeedingFillEconomics: async () => [],
        // A pending, pre-expiry row is still durable unresolved exposure. It
        // cannot be released by the retry merely because time elapsed.
        listUnsettledEthMartingaleOrders: async () => [{
          id: "eth-entry:unresolved", ticker: "KXETH15M-prior",
          outcome: "pending", submissionVersion: 1, createdAtMs: Date.now(),
          kalshiOrderId: null, filledContracts: null, filledFeeCents: null,
          actualFillPriceCents: null, actualNotionalDollars: null,
          actualFeeDollars: null, fillEconomicsVerifiedAtMs: null,
          fillEconomicsVerifiedContracts: null,
        }],
        expireEthMartingaleReservation: async () => true,
      } as never,
    });

    await _restFetchAllForTesting("rest_fallback");
    assert.equal(evaluations, 2, "normal fetch plus post-sweep handoff evaluate the current ETH ticker");

    mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(evaluations, 4, "the one bounded retry refreshes and re-evaluates the same current ETH ticker");

    mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(evaluations, 4,
      "the retry pass cannot re-arm itself into a five-second reconciliation loop");
    mock.timers.reset();
  });

  it("uses a fresh post-open lookup and never evaluates from the pre-open announcement", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const openedAt = Date.now() + 1_000;
    const ticker = "KXETH15M-boundary-fresh";
    const requests: Array<{ forceFresh?: boolean }> = [];
    let evaluations = 0;
    _setKalshiSeriesFetchForTesting(async (_series, options) => {
      requests.push(options ?? {});
      return {
        ticker, status: "open", exchange_index: 2,
        open_time: new Date(openedAt).toISOString(),
        close_time: new Date(openedAt + 15 * 60_000).toISOString(),
        floor_strike: 2500,
      };
    });
    _setEvaluateEthNoMartingaleForTesting(async () => { evaluations++; });

    _scheduleEthBoundaryDiscoveryForTesting({
      ticker, status: "initialized", open_time: new Date(openedAt).toISOString(),
    });
    mock.timers.tick(1_349);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(evaluations, 0, "initialized metadata must never evaluate directly");

    mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [{ forceFresh: true }], "boundary probe bypasses the normal cache");
    assert.equal(evaluations, 1, "only the fresh active response enters the existing evaluator");
  });

  it("bounds inactive boundary retries and preserves periodic fallback fetches", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const openedAt = Date.now() + 1_000;
    const ticker = "KXETH15M-boundary-retry";
    let calls = 0;
    _setKalshiSeriesFetchForTesting(async () => {
      calls++;
      return null;
    });
    _scheduleEthBoundaryDiscoveryForTesting({
      ticker, status: "initialized", open_time: new Date(openedAt).toISOString(),
    });
    // Advance each asynchronous retry separately so its completion has a chance
    // to arm the following timer (as it would in the live event loop).
    mock.timers.tick(1_350);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(2_000);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(2_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3, "one initial probe plus two short retries only");

    await _restFetchAllForTesting("rest_fallback");
    assert.equal(calls, 4, "ordinary periodic fallback remains available after probe exhaustion");
  });

  it("does not let a delayed prior probe cancel the following window's timer", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const firstOpen = Date.now() + 1_000;
    const secondOpen = firstOpen + 15 * 60_000;
    const firstTicker = "KXETH15M-boundary-a";
    const secondTicker = "KXETH15M-boundary-b";
    let resolveFirst!: (value: Record<string, unknown>) => void;
    const requested: string[] = [];
    _setKalshiSeriesFetchForTesting(async () => {
      const expected = requested.length === 0
        ? { ticker: firstTicker, open: firstOpen }
        : { ticker: secondTicker, open: secondOpen };
      requested.push(expected.ticker);
      if (expected.ticker === firstTicker) {
        return new Promise<Record<string, unknown>>((resolve) => { resolveFirst = resolve; });
      }
      return {
        ticker: expected.ticker, status: "open", exchange_index: 2,
        open_time: new Date(expected.open).toISOString(),
        close_time: new Date(expected.open + 15 * 60_000).toISOString(),
        floor_strike: 2500,
      };
    });
    _setEvaluateEthNoMartingaleForTesting(async () => {});

    _scheduleEthBoundaryDiscoveryForTesting({
      ticker: firstTicker, status: "initialized", open_time: new Date(firstOpen).toISOString(),
    });
    mock.timers.tick(1_350);
    await new Promise((resolve) => setImmediate(resolve));
    _scheduleEthBoundaryDiscoveryForTesting({
      ticker: secondTicker, status: "initialized", open_time: new Date(secondOpen).toISOString(),
    });
    resolveFirst({
      ticker: firstTicker, status: "open", exchange_index: 2,
      open_time: new Date(firstOpen).toISOString(),
      close_time: new Date(firstOpen + 15 * 60_000).toISOString(), floor_strike: 2500,
    });
    await new Promise((resolve) => setImmediate(resolve));

    mock.timers.tick(15 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requested, [firstTicker, secondTicker],
      "the delayed first probe cannot clear the following boundary's timer");
  });
});