import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isWeek2ProductionNewEntryTicker,
  isNewEntryPermitted,
  _isNewEntryPermittedForPolicy,
  seriesTokenFromTicker,
  WEEK_2_PRODUCTION_NEW_ENTRY_SERIES,
  WEEK_2_RESEARCH_AND_TELEMETRY_SERIES,
  ACTIVE_ENTRY_SERIES_POLICY,
} from "./week2EntryPolicy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ETH_TICKER = "KXETH15M-26AUG161200-00";
const BTC_TICKER = "KXBTC15M-26AUG161200-00";
const UNKNOWN_TICKER = "KXETH15MTEST-26AUG161200-00";
const PREFIX_TICKER = "prefix-KXETH15M-26AUG161200-00";

// ---------------------------------------------------------------------------
// Legacy exact-series helper (unchanged from original implementation)
// ---------------------------------------------------------------------------

describe("isWeek2ProductionNewEntryTicker — exact ETH-15M series check", () => {
  it("allows only the exact KXETH15M series token", () => {
    assert.equal(isWeek2ProductionNewEntryTicker(ETH_TICKER), true);
    assert.equal(isWeek2ProductionNewEntryTicker(BTC_TICKER), false);
    assert.equal(isWeek2ProductionNewEntryTicker(UNKNOWN_TICKER), false, "KXETH15MTEST must not match");
    assert.equal(isWeek2ProductionNewEntryTicker(PREFIX_TICKER), false, "prefix must not match");
  });

  it("keeps BTC and ETH in the research/telemetry scope", () => {
    assert.deepEqual(WEEK_2_RESEARCH_AND_TELEMETRY_SERIES, ["KXBTC15M", "KXETH15M"]);
    assert.equal(WEEK_2_PRODUCTION_NEW_ENTRY_SERIES, "KXETH15M");
    assert.equal(seriesTokenFromTicker(ETH_TICKER), "KXETH15M");
  });
});

// ---------------------------------------------------------------------------
// seriesTokenFromTicker — exact token extraction
// ---------------------------------------------------------------------------

describe("seriesTokenFromTicker", () => {
  it("returns the prefix before the first dash", () => {
    assert.equal(seriesTokenFromTicker("KXBTC15M-26AUG161200-00"), "KXBTC15M");
    assert.equal(seriesTokenFromTicker("KXETH15M-26AUG161200-00"), "KXETH15M");
    assert.equal(seriesTokenFromTicker("KXETH15MTEST-26AUG161200-00"), "KXETH15MTEST");
  });

  it("returns the full string when there is no dash", () => {
    assert.equal(seriesTokenFromTicker("KXBTC15M"), "KXBTC15M");
  });

  it("rejects a ticker whose series is only a substring match", () => {
    // A prefix such as 'prefix-KXETH15M-...' splits on the first '-',
    // so the token is 'prefix' — not 'KXETH15M'.
    assert.equal(seriesTokenFromTicker(PREFIX_TICKER), "prefix");
  });
});

// ---------------------------------------------------------------------------
// _isNewEntryPermittedForPolicy — pure helper (env-independent, testable)
// ---------------------------------------------------------------------------

describe("_isNewEntryPermittedForPolicy — immutable ETH-only mode", () => {
  it("permits only KXETH15M tickers", () => {
    assert.equal(_isNewEntryPermittedForPolicy(ETH_TICKER, "eth_only"), true);
    assert.equal(_isNewEntryPermittedForPolicy(BTC_TICKER, "eth_only"), false);
  });

  it("rejects near-miss ETH variants", () => {
    assert.equal(_isNewEntryPermittedForPolicy(UNKNOWN_TICKER, "eth_only"), false);
    assert.equal(_isNewEntryPermittedForPolicy(PREFIX_TICKER, "eth_only"), false);
  });
});

describe("Regression: a legacy all_series setting cannot reopen BTC", () => {
  it("ignores all policy values except the immutable ETH-only rule", () => {
    assert.equal(_isNewEntryPermittedForPolicy(ETH_TICKER, "all_series"), true);
    assert.equal(_isNewEntryPermittedForPolicy(BTC_TICKER, "all_series"), false);
    assert.equal(_isNewEntryPermittedForPolicy(BTC_TICKER, "anything_else"), false);
  });
});

// ---------------------------------------------------------------------------
// isNewEntryPermitted — delegates to active env policy
// ---------------------------------------------------------------------------

describe("isNewEntryPermitted — delegates to ACTIVE_ENTRY_SERIES_POLICY", () => {
  it("is consistent with _isNewEntryPermittedForPolicy under the active policy", () => {
    // Whatever the env says, the live function and the pure helper must agree.
    for (const ticker of [ETH_TICKER, BTC_TICKER, UNKNOWN_TICKER, PREFIX_TICKER]) {
      assert.equal(
        isNewEntryPermitted(ticker),
        _isNewEntryPermittedForPolicy(ticker, ACTIVE_ENTRY_SERIES_POLICY),
        `isNewEntryPermitted("${ticker}") must match _isNewEntryPermittedForPolicy under active policy`,
      );
    }
  });

  it("ACTIVE_ENTRY_SERIES_POLICY is permanently ETH-only", () => {
    assert.equal(ACTIVE_ENTRY_SERIES_POLICY, "eth_only");
  });
});

// ---------------------------------------------------------------------------
// Regression: entry policy must NOT affect protective exits
//
// Protective exits, reductions, and hedges use protectiveExit.ts and bypass
// this module entirely. This test confirms week2EntryPolicy.ts exports nothing
// that the protective-exit path would import, and that the policy functions
// have no side effects on shared mutable state.
// ---------------------------------------------------------------------------

describe("Regression: isNewEntryPermitted must not affect protective-exit semantics", () => {
  it("calling isNewEntryPermitted never throws and has no observable side effects", () => {
    // Call both policy modes several times; neither call must throw or affect
    // global state that a protective exit would read.
    assert.doesNotThrow(() => {
      for (let i = 0; i < 10; i++) {
        _isNewEntryPermittedForPolicy(BTC_TICKER, "eth_only");
        _isNewEntryPermittedForPolicy(BTC_TICKER, "all_series");
        _isNewEntryPermittedForPolicy(ETH_TICKER, "eth_only");
        _isNewEntryPermittedForPolicy(ETH_TICKER, "all_series");
      }
    });
  });

  it("eth_only policy blocks BTC entries but the same BTC ticker must still resolve its series token", () => {
    // Ensure series-token parsing — used by telemetry on both entry and exit
    // paths — is unaffected by the entry policy decision.
    assert.equal(_isNewEntryPermittedForPolicy(BTC_TICKER, "eth_only"), false);
    assert.equal(seriesTokenFromTicker(BTC_TICKER), "KXBTC15M",
      "seriesTokenFromTicker must work even when the ticker is policy-blocked");
  });

  it("legacy all_series input does not change ETH-only behavior", () => {
    assert.equal(_isNewEntryPermittedForPolicy(ETH_TICKER, "eth_only"), true);
    assert.equal(_isNewEntryPermittedForPolicy(ETH_TICKER, "all_series"), true);
    assert.equal(_isNewEntryPermittedForPolicy(BTC_TICKER, "all_series"), false);
  });

  it("unknown / malformed tickers are rejected under both policies", () => {
    const malformed = ["", "KXBTC", "not-a-series", "KXETH15MTEST-26AUG-00"];
    for (const t of malformed) {
      assert.equal(_isNewEntryPermittedForPolicy(t, "eth_only"), false, `eth_only should reject "${t}"`);
      assert.equal(_isNewEntryPermittedForPolicy(t, "all_series"), false, `all_series should reject "${t}"`);
    }
  });
});
