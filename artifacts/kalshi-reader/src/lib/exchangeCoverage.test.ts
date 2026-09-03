import assert from "node:assert/strict";
import test from "node:test";
import { isBotPnlVerifiedToday } from "./exchangeCoverage.js";

test("does not mark bot P&L verified when coverage was capped", () => {
  assert.equal(isBotPnlVerifiedToday({
    exchange_reconciliation_complete: true,
    exchange_history_coverage: { complete: false, truncated: true },
  }), false);
});

test("marks bot P&L verified only after both exchange checks complete", () => {
  assert.equal(isBotPnlVerifiedToday({
    exchange_reconciliation_complete: true,
    exchange_history_coverage: { complete: true, truncated: false },
  }), true);
});