import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { responseIndicatesStale } from "./Portfolio.js";

/**
 * Regression coverage for the fulfilled-but-stale account response contract:
 * while Kalshi rate-limits, the API server returns HTTP 200 with the last
 * known balance/positions/fills payload plus `stale: true`. The Portfolio
 * page must map that onto its per-section staleness flags rather than
 * presenting cached data as fresh.
 */
describe("Portfolio stale-flag handling for fulfilled responses", () => {
  it("marks a section stale when a fulfilled response carries stale: true", () => {
    assert.equal(responseIndicatesStale({ balance: 12345, stale: true }), true);
    assert.equal(responseIndicatesStale({ market_positions: [], stale: true }), true);
    assert.equal(responseIndicatesStale({ fills: [], stale: true }), true);
  });

  it("treats fresh responses (stale false or absent) as not stale", () => {
    assert.equal(responseIndicatesStale({ balance: 12345, stale: false }), false);
    assert.equal(responseIndicatesStale({ market_positions: [] }), false);
    assert.equal(responseIndicatesStale({ fills: [] }), false);
  });

  it("never throws on unexpected payload shapes", () => {
    assert.equal(responseIndicatesStale(null), false);
    assert.equal(responseIndicatesStale(undefined), false);
    assert.equal(responseIndicatesStale("error"), false);
    assert.equal(responseIndicatesStale(42), false);
  });

  it("simulates the fulfilled-response mapping used by usePortfolio", () => {
    // Mirror of the state update: a fulfilled response drives the flag from
    // the payload, not a hardcoded `false`.
    const results = {
      balance: { status: "fulfilled" as const, value: { balance: 1, stale: true } },
      positions: { status: "fulfilled" as const, value: { market_positions: [], stale: false } },
      fills: { status: "fulfilled" as const, value: { fills: [], stale: true } },
    };
    const staleness = {
      balance: responseIndicatesStale(results.balance.value),
      positions: responseIndicatesStale(results.positions.value),
      fills: responseIndicatesStale(results.fills.value),
    };
    assert.deepEqual(staleness, { balance: true, positions: false, fills: true });
  });
});
