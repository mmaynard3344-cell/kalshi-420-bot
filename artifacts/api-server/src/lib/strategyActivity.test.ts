import assert from "node:assert/strict";
import test from "node:test";
import { summarizeEth30StrategyActivity, summarizeLegacyStrategyActivity } from "./strategyActivity.js";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

test("legacy activity reports recent guard blocks without claiming ETH ownership", () => {
  const summary = summarizeLegacyStrategyActivity([{
    ticker: "KXBTC15M-TEST", series: "KXBTC15M", timestampMs: NOW - 1_000,
    secondsLeft: 60, source: "websocket", yesBid: 10, yesAsk: 11, noBid: 89, noAsk: 90,
    yesDerivedAsk: 11, noDerivedAsk: 90, side: "no", limitCents: 90,
    outcome: "place_order_rejected", preflightDecision: "daily_cap",
  }], NOW, true);
  assert.equal(summary.state, "active");
  assert.equal(summary.blocked_reasons.daily_cap, 1);
  assert.equal(summary.storage, "healthy");
});

test("ETH_30_50 activity uses only its own ledger and reports unavailable storage fail-closed", () => {
  const active = summarizeEth30StrategyActivity([{
    id: "eth30-decision", ticker: "KXETH15M-TEST", easternDate: "2026-08-16",
    decision: "gate_blocked", side: null, priceCents: null, contracts: null,
    note: "global_halt", occurredAtMs: NOW - 1_000,
  }], NOW, true);
  assert.equal(active.state, "active");
  assert.equal(active.blocked_reasons.global_halt, 1);
  const unavailable = summarizeEth30StrategyActivity([], NOW, false);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.storage, "degraded");
});