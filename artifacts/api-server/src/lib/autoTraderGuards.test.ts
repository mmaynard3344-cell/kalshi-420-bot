/**
 * Standalone historical guard coverage.
 *
 * These checks deliberately import the pure guard module rather than the
 * AutoTrader evaluator, so preserving analytics/research guard behavior can
 * never reintroduce a live exchange-order path.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  BTC_BET_DOLLARS,
  BTC_ENTRY_CAP_CENTS,
  BTC_ENTRY_FLOOR_CENTS,
  ETH_BET_DOLLARS,
  ETH_ENTRY_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  PRICE_FLOOR_CENTS,
  SERIES_ENTRY_POLICY,
  _computeRemainingBudgetForTesting,
  _getPendingNotionalForTesting,
  _resetAutoTraderStateForTesting,
  _setPendingNotionalForTesting,
  _setSpendTrackerForTesting,
  contractsForPrice,
  isEntryPriceInBandForSeries,
  isPriceInBand,
} from "./autoTraderGuards.js";

const TICKER = "KXBTC15M-guard-test";

describe("historical entry guards", () => {
  beforeEach(() => _resetAutoTraderStateForTesting());

  it("keeps the inclusive outcome-side price boundaries", () => {
    assert.equal(PRICE_FLOOR_CENTS, 90);
    assert.equal(PRICE_CAP_CENTS, 95);
    assert.equal(isPriceInBand(89), false);
    assert.equal(isPriceInBand(90), true);
    assert.equal(isPriceInBand(95), true);
    assert.equal(isPriceInBand(96), false);
  });

  it("preserves the historical BTC and ETH policy contracts without evaluating orders", () => {
    assert.equal(BTC_ENTRY_FLOOR_CENTS, 90);
    assert.equal(BTC_ENTRY_CAP_CENTS, 95);
    assert.equal(ETH_ENTRY_FLOOR_CENTS, 90);
    assert.equal(isEntryPriceInBandForSeries("KXBTC15M", 90), true);
    assert.equal(isEntryPriceInBandForSeries("KXETH15M", 95), true);
    assert.equal(isEntryPriceInBandForSeries("KXBTC15M", 96), false);
    assert.equal(contractsForPrice(90, BTC_BET_DOLLARS), Math.floor((BTC_BET_DOLLARS * 100) / 90));
    assert.equal(contractsForPrice(90, ETH_BET_DOLLARS), Math.floor((ETH_BET_DOLLARS * 100) / 90));
    assert.equal(SERIES_ENTRY_POLICY.KXBTC15M.betDollars, BTC_BET_DOLLARS);
  });

  it("counts pending and filled notional against the historical window budget", () => {
    _setPendingNotionalForTesting(TICKER, 4_000);
    _setSpendTrackerForTesting(TICKER, 40);

    const budget = _computeRemainingBudgetForTesting(TICKER, 100, 80);
    assert.equal(_getPendingNotionalForTesting(TICKER), 4_000);
    assert.equal(budget.remainingDollars, 20);
    assert.equal(budget.count, 25);
  });
});