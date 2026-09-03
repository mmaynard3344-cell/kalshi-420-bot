import assert from "node:assert/strict";
import test from "node:test";
import { dashboardOutcomeFromAnalytics, mergeDashboardWindow } from "./dashboardWindowOutcome.js";
import type { WindowAnalytics } from "./analytics.js";

test("dashboard outcome uses the authoritative analytics result", () => {
  assert.equal(dashboardOutcomeFromAnalytics("filled"), "traded");
  assert.equal(dashboardOutcomeFromAnalytics("partial_fill"), "traded");
  assert.equal(dashboardOutcomeFromAnalytics("zero_fill_only"), "zero_fill");
  assert.equal(dashboardOutcomeFromAnalytics("no_submission"), "skipped");
  assert.equal(dashboardOutcomeFromAnalytics("outside_zone"), "out_of_zone");
  assert.equal(dashboardOutcomeFromAnalytics("blocked"), "pending");
  assert.equal(dashboardOutcomeFromAnalytics("pending"), "pending");
});

function analyticsFor(ticker: string, result: WindowAnalytics["result"]): WindowAnalytics {
  return {
    ticker,
    series: "KXETH15M",
    windowStartMs: 1_754_611_200_000,
    windowClose: "2026-08-07T17:15:00.000Z",
    yesEnteredZone: false,
    noEnteredZone: true,
    firstInZoneMs: 1_754_611_150_000,
    lastInZoneMs: 1_754_611_190_000,
    qualifyingEvaluations: 2,
    submittedOrders: 1,
    zeroFills: 0,
    partialFills: result === "partial_fill" ? 1 : 0,
    fullFills: result === "filled" ? 1 : 0,
    attemptNumberThatFilled: 1,
    attempts: [{ attemptNumber: 1, side: "no", triggerPriceCents: 82, limitPriceCents: 82, requestedContracts: 12 }],
    actualFilledContracts: 12,
    actualFillPriceCents: 82,
    totalSpendDollars: 9.84,
    totalFeesDollars: 0.17,
    result,
  };
}

test("same-ticker analytics corrects stale Window Log status without losing context", () => {
  const ticker = "KXETH15M-26AUG071715-15";
  const rawEntry = {
    ticker,
    outcome: "out_of_zone",
    firstSeenMs: 1_754_611_100_000,
    closeTime: "2026-08-07T17:15:00.000Z",
    inZone: false,
    noDerivedAsk: null,
  };
  const analyticsMap = new Map([
    [ticker, analyticsFor(ticker, "filled")],
    ["KXETH15M-26AUG071730-15", analyticsFor("KXETH15M-26AUG071730-15", "partial_fill")],
  ]);

  const merged = mergeDashboardWindow(rawEntry, analyticsMap.get(rawEntry.ticker));

  assert.equal(merged.outcome, "traded");
  assert.equal(merged.analyticsResult, "filled");
  assert.equal(merged.submittedOrders, 1);
  assert.equal(merged.fullFills, 1);
  assert.equal(merged.totalSpendDollars, 9.84);
  assert.deepEqual(merged.attempts, analyticsMap.get(ticker)!.attempts);
  assert.equal(merged.firstSeenMs, rawEntry.firstSeenMs);
  assert.equal(merged.closeTime, rawEntry.closeTime);
  assert.equal(merged.inZone, rawEntry.inZone);

  const unmatched = mergeDashboardWindow(
    { ...rawEntry, ticker: "KXETH15M-26AUG071745-15", outcome: "pending" },
    analyticsMap.get("KXETH15M-26AUG071745-15"),
  );
  assert.equal(unmatched.outcome, "pending");
  assert.equal(unmatched.submittedOrders, 0);
});