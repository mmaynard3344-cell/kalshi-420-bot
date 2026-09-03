/**
 * ETH-only routing regression tests.
 *
 * This file intentionally retains its historical SOL-oriented name so the
 * dedicated runner continues to guard the cutover: retired SOL ticks must not
 * reach the active ETH new-entry evaluator, the only evaluator on this route
 * that can submit a new order.
 *
 * The runner redirects writable paths to temporary directories. These tests use
 * injected evaluators and fetches, so no Kalshi API or database is contacted.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _clearAutoTraderTestOverrides,
  _evaluateForTesting,
  _getLiveTrackedSeriesForTesting,
  _onWsTickForTesting,
  _resetAutoTraderStateForTesting,
  _restFetchAllForTesting,
  _setEvaluateEthNoMartingaleForTesting,
  _setKalshiSeriesFetchForTesting,
  _setLegacyEvaluateSpyForTesting,
} from "./autoTrader.js";
import type { MarketState } from "./autoTrader.js";
import {
  isNewEntryPermitted,
  isWeek2ProductionNewEntryTicker,
} from "./week2EntryPolicy.js";

function makeTick(ticker: string): Record<string, unknown> {
  return {
    ticker,
    status: "active",
    open_time: new Date(Date.now() - 60_000).toISOString(),
    close_time: new Date(Date.now() + 120_000).toISOString(),
    yes_bid: 28,
    yes_ask: 32,
    no_bid: 68,
    no_ask: 72,
  };
}

function makeSolState(): MarketState {
  return {
    ticker: "KXSOL15M-26AUG300-T",
    exchangeIndex: 2,
    closeTime: null,
    openTime: null,
    expirationTime: null,
    status: "active",
    lastPrice: null,
    yesBid: 10,
    yesAsk: 15,
    noBid: 85,
    noAsk: 90,
    bidUpdatedMs: Date.now(),
  };
}

describe("Retired SOL routing boundary", () => {
  beforeEach(() => {
    _resetAutoTraderStateForTesting();
    _clearAutoTraderTestOverrides();
  });

  afterEach(() => {
    _clearAutoTraderTestOverrides();
  });

  it("permits only exact ETH series tickers to create new entries", () => {
    assert.equal(isWeek2ProductionNewEntryTicker("KXETH15M-26AUG300-T"), true);
    assert.equal(isNewEntryPermitted("KXETH15M-26AUG300-T"), true);
    assert.equal(isWeek2ProductionNewEntryTicker("KXSOL15M-26AUG300-T"), false);
    assert.equal(isNewEntryPermitted("KXSOL15M-26AUG300-T"), false);
    assert.equal(isNewEntryPermitted("KXETH15MTEST-26AUG300-T"), false);
  });

  it("uses ETH alone for every live timer, stream-health, and snapshot work list", () => {
    assert.deepEqual(_getLiveTrackedSeriesForTesting(), ["KXETH15M"]);
  });

  it("drops a SOL WebSocket tick before either entry evaluator can run", async () => {
    const legacyTickers: string[] = [];
    const ethEntryTickers: string[] = [];
    _setLegacyEvaluateSpyForTesting((ticker) => legacyTickers.push(ticker));
    _setEvaluateEthNoMartingaleForTesting(async ({ ticker }) => {
      ethEntryTickers.push(ticker);
    });

    _onWsTickForTesting(makeTick("KXSOL15M-26AUG300-T"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(legacyTickers, []);
    assert.deepEqual(ethEntryTickers, []);
  });

  it("cannot route a SOL state to the POST-capable ETH entry evaluator", async () => {
    const ethEntryTickers: string[] = [];
    _setEvaluateEthNoMartingaleForTesting(async ({ ticker }) => {
      ethEntryTickers.push(ticker);
    });

    await _evaluateForTesting(makeSolState(), 100, "websocket");

    assert.deepEqual(ethEntryTickers, []);
  });

  it("routes an ETH WebSocket tick to the active entry evaluator", async () => {
    const ethEntryTickers: string[] = [];
    _setEvaluateEthNoMartingaleForTesting(async ({ ticker }) => {
      ethEntryTickers.push(ticker);
    });

    _onWsTickForTesting(makeTick("KXETH15M-26AUG300-T"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(ethEntryTickers, ["KXETH15M-26AUG300-T"]);
  });

  it("fetches only ETH through the aggregate REST entry path", async () => {
    const fetchedSeries: string[] = [];
    _setKalshiSeriesFetchForTesting(async (series) => {
      fetchedSeries.push(series);
      return null;
    });

    await _restFetchAllForTesting("rest_fallback");

    assert.deepEqual(fetchedSeries, ["KXETH15M"]);
  });
});