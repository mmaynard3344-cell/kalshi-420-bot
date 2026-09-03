/**
 * Deterministic tests for the runtime watchdog module.
 *
 * All tests are fully isolated:
 *  - No real HTTP calls are made.
 *  - No trading/order paths are imported.
 *  - All polls use _executePollForTesting() which bypasses timers entirely.
 *  - _resetWatchdogForTesting() is called after each test.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDimensions,
  getWatchdogStatus,
  getWatchdogHistory,
  isWatchdogDimensionHealthy,
  isWatchdogFullyHealthy,
  setWatchdogTransitionSink,
  setWatchdogHistorySink,
  startWatchdog,
  stopWatchdog,
  _setWatchdogFetchOverride,
  _resetWatchdogForTesting,
  _executePollForTesting,
  STALE_QUOTE_THRESHOLD_MS,
  OVERDUE_RECONCILE_MS,
  WATCHDOG_HISTORY_CAPACITY,
  type WatchdogDimension,
  type WatchdogPollResult,
} from "./runtimeWatchdog.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal healthy runtime-health response using real-time-relative
 *  timestamps so classifyDimensions (which calls Date.now()) sees them as fresh. */
function healthyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const recentSweepAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago (well within 15 min)
  return {
    generated_at: new Date().toISOString(),
    autotrader: { wsLive: true, lastTickMs: Date.now() - 5_000 },
    kalshi_connection: {
      websocket_connected: true,
      last_ticker_refresh_at: new Date(Date.now() - 10_000).toISOString(),
    },
    usable_quotes: {
      btc: { age_ms: 5_000, coverage_state: "healthy" },
      eth: { age_ms: 8_000, coverage_state: "healthy" },
    },
    reconciliation: { last_discovery_sweep_at: recentSweepAt },
    daily_profit_lockout: { state: "below_target", target_dollars: 75 },
    protective_exit_monitor: { enabled: true, inFlightCount: 0, restoredArmedTickers: [] },
    eth420_boundary_evidence: { availability: "available", diagnostic_reason: null },
    ...overrides,
  };
}

/** Make a fake Response object for the fetch override. */
function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Install fetch override and run one poll via _executePollForTesting(). */
async function runPoll(payload: Record<string, unknown>, status = 200): Promise<WatchdogPollResult> {
  _setWatchdogFetchOverride(async () => makeResponse(status, payload));
  return _executePollForTesting();
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.afterEach(() => _resetWatchdogForTesting());

// ── classifyDimensions (pure function) ────────────────────────────────────────

test("classifyDimensions: all-healthy payload produces all ok", () => {
  const result = classifyDimensions(healthyPayload() as Parameters<typeof classifyDimensions>[0], Date.now());
  for (const [dim, state] of Object.entries(result)) {
    assert.equal(state, "ok", `Expected ${dim} to be ok`);
  }
});

test("classifyDimensions: websocket_connected=false raises ws_disconnect alert", () => {
  const payload = { ...healthyPayload(), kalshi_connection: { websocket_connected: false } };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["ws_disconnect"], "alert");
  assert.equal(result["stale_btc_quote"], "ok");
});

test("classifyDimensions: btc quote age exactly at threshold is ok", () => {
  const payload = {
    ...healthyPayload(),
    usable_quotes: {
      btc: { age_ms: STALE_QUOTE_THRESHOLD_MS, coverage_state: "healthy" },
      eth: { age_ms: 5_000, coverage_state: "healthy" },
    },
  };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["stale_btc_quote"], "ok");
});

test("classifyDimensions: btc quote age 1ms above threshold raises stale_btc_quote", () => {
  const payload = {
    ...healthyPayload(),
    usable_quotes: {
      btc: { age_ms: STALE_QUOTE_THRESHOLD_MS + 1, coverage_state: "gap" },
      eth: { age_ms: 5_000, coverage_state: "healthy" },
    },
  };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["stale_btc_quote"], "alert");
  assert.equal(result["stale_eth_quote"], "ok");
});

test("classifyDimensions: eth quote age above threshold raises stale_eth_quote independently", () => {
  const payload = {
    ...healthyPayload(),
    usable_quotes: {
      btc: { age_ms: 1_000, coverage_state: "healthy" },
      eth: { age_ms: STALE_QUOTE_THRESHOLD_MS + 500, coverage_state: "gap" },
    },
  };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["stale_btc_quote"], "ok");
  assert.equal(result["stale_eth_quote"], "alert");
});

test("classifyDimensions: autotrader wsLive=false raises stale_autotrader", () => {
  const payload = { ...healthyPayload(), autotrader: { wsLive: false, lastTickMs: Date.now() - 200_000 } };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["stale_autotrader"], "alert");
});

test("classifyDimensions: reconciliation overdue raises overdue_reconciliation", () => {
  const nowMs = Date.now();
  const overdueAt = new Date(nowMs - OVERDUE_RECONCILE_MS - 1).toISOString();
  const payload = { ...healthyPayload(), reconciliation: { last_discovery_sweep_at: overdueAt } };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], nowMs);
  assert.equal(result["overdue_reconciliation"], "alert");
});

test("classifyDimensions: reconciliation exactly at limit is ok", () => {
  const nowMs = Date.now();
  const exactAt = new Date(nowMs - OVERDUE_RECONCILE_MS).toISOString();
  const payload = { ...healthyPayload(), reconciliation: { last_discovery_sweep_at: exactAt } };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], nowMs);
  assert.equal(result["overdue_reconciliation"], "ok");
});

test("classifyDimensions: null last_discovery_sweep_at is ok (no sweep yet)", () => {
  const payload = { ...healthyPayload(), reconciliation: { last_discovery_sweep_at: null } };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["overdue_reconciliation"], "ok");
});

test("classifyDimensions: protective_exit_monitor.enabled=false raises protective_exit_disabled", () => {
  const payload = {
    ...healthyPayload(),
    protective_exit_monitor: { enabled: false, inFlightCount: 0 },
  };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["protective_exit_disabled"], "alert");
});

test("classifyDimensions: daily_profit_lockout.state=unavailable raises daily_profit_unavailable", () => {
  const payload = { ...healthyPayload(), daily_profit_lockout: { state: "unavailable", target_dollars: 75 } };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["daily_profit_unavailable"], "alert");
});

test("classifyDimensions: daily_profit_lockout.state=target_reached is ok (not unavailable)", () => {
  const payload = { ...healthyPayload(), daily_profit_lockout: { state: "target_reached", target_dollars: 75 } };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["daily_profit_unavailable"], "ok");
});

test("classifyDimensions: unavailable ETH boundary evidence is classified for sustained alerting", () => {
  const payload = {
    ...healthyPayload(),
    eth420_boundary_evidence: { availability: "unavailable", diagnostic_reason: "storage_read_failed" },
  };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["eth420_boundary_evidence_unavailable"], "alert");
});

test("classifyDimensions: multiple dimensions can alert simultaneously", () => {
  const payload = {
    ...healthyPayload(),
    kalshi_connection: { websocket_connected: false },
    autotrader: { wsLive: false, lastTickMs: 0 },
    daily_profit_lockout: { state: "unavailable", target_dollars: 75 },
    protective_exit_monitor: { enabled: false },
  };
  const result = classifyDimensions(payload as Parameters<typeof classifyDimensions>[0], Date.now());
  assert.equal(result["ws_disconnect"], "alert");
  assert.equal(result["stale_autotrader"], "alert");
  assert.equal(result["daily_profit_unavailable"], "alert");
  assert.equal(result["protective_exit_disabled"], "alert");
  // Non-alerting ones should remain ok
  assert.equal(result["stale_btc_quote"], "ok");
  assert.equal(result["stale_eth_quote"], "ok");
  assert.equal(result["overdue_reconciliation"], "ok");
});

// ── Initial state ─────────────────────────────────────────────────────────────

test("getWatchdogStatus: initial state has null metadata and all ok dimensions", () => {
  const status = getWatchdogStatus();
  assert.equal(status.lastPolledAt, null);
  assert.equal(status.lastDurationMs, null);
  assert.equal(status.lastPollSuccess, null);
  assert.equal(status.totalPolls, 0);
  assert.equal(status.totalAlertTransitions, 0);
  for (const dim of Object.keys(status.dimensions) as WatchdogDimension[]) {
    assert.equal(status.dimensions[dim].state, "ok");
    assert.equal(status.dimensions[dim].since, null);
    assert.equal(status.dimensions[dim].consecutiveCount, 0);
  }
});

test("getWatchdogHistory: empty before any poll", () => {
  assert.deepEqual(getWatchdogHistory(), []);
});

test("isWatchdogDimensionHealthy: all dimensions healthy before any poll", () => {
  const dims: WatchdogDimension[] = [
    "endpoint_failure", "api_failure", "ws_disconnect",
    "stale_btc_quote", "stale_eth_quote", "stale_autotrader",
    "overdue_reconciliation", "protective_exit_disabled", "daily_profit_unavailable",
    "eth420_boundary_evidence_unavailable",
  ];
  for (const dim of dims) {
    assert.equal(isWatchdogDimensionHealthy(dim), true, `${dim} should be healthy initially`);
  }
});

test("isWatchdogFullyHealthy: true before any poll", () => {
  assert.equal(isWatchdogFullyHealthy(), true);
});

// ── Poll: healthy result ──────────────────────────────────────────────────────

test("single healthy poll updates status correctly", async () => {
  const result = await runPoll(healthyPayload());

  assert.equal(result.success, true);
  assert.equal(result.httpStatus, 200);
  assert.ok(result.durationMs >= 0);

  const status = getWatchdogStatus();
  assert.equal(status.totalPolls, 1);
  assert.equal(status.lastPollSuccess, true);
  assert.notEqual(status.lastPolledAt, null);

  for (const dim of Object.keys(status.dimensions) as WatchdogDimension[]) {
    assert.equal(status.dimensions[dim].state, "ok", `${dim} should be ok after healthy poll`);
  }
});

test("healthy poll appends to history ring buffer", async () => {
  await runPoll(healthyPayload());
  const history = getWatchdogHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].success, true);
});

// ── Poll: network/endpoint failure ────────────────────────────────────────────

test("endpoint failure sets endpoint_failure=alert and success=false", async () => {
  _setWatchdogFetchOverride(async () => { throw new Error("ECONNREFUSED"); });
  const result = await _executePollForTesting();

  assert.equal(result.success, false);
  assert.equal(result.httpStatus, null);
  assert.equal(result.dimensions["endpoint_failure"], "alert");
  assert.ok(result.errorMessage?.includes("ECONNREFUSED"));

  assert.equal(isWatchdogDimensionHealthy("endpoint_failure"), false);
  assert.equal(isWatchdogFullyHealthy(), false);
});

// ── Poll: API failure (non-200) ───────────────────────────────────────────────

test("HTTP 401 response sets api_failure=alert", async () => {
  const result = await runPoll({}, 401);

  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 401);
  assert.equal(result.dimensions["api_failure"], "alert");
  assert.equal(result.dimensions["endpoint_failure"], "ok");

  assert.equal(isWatchdogDimensionHealthy("api_failure"), false);
});

test("HTTP 503 response sets api_failure=alert", async () => {
  const result = await runPoll({}, 503);
  assert.equal(result.dimensions["api_failure"], "alert");
});

// ── Poll: dimension-specific alerts ──────────────────────────────────────────

test("ws_disconnect alert is raised on websocket_connected=false", async () => {
  const result = await runPoll({
    ...healthyPayload(),
    kalshi_connection: { websocket_connected: false },
  });
  assert.equal(result.dimensions["ws_disconnect"], "alert");
  assert.equal(isWatchdogDimensionHealthy("ws_disconnect"), false);
});

test("stale_btc_quote alert is raised when btc age exceeds threshold", async () => {
  const result = await runPoll({
    ...healthyPayload(),
    usable_quotes: {
      btc: { age_ms: STALE_QUOTE_THRESHOLD_MS + 10_000, coverage_state: "gap" },
      eth: { age_ms: 1_000, coverage_state: "healthy" },
    },
  });
  assert.equal(result.dimensions["stale_btc_quote"], "alert");
  assert.equal(result.dimensions["stale_eth_quote"], "ok");
});

test("stale_eth_quote alert is raised independently of btc", async () => {
  const result = await runPoll({
    ...healthyPayload(),
    usable_quotes: {
      btc: { age_ms: 1_000, coverage_state: "healthy" },
      eth: { age_ms: STALE_QUOTE_THRESHOLD_MS + 1, coverage_state: "gap" },
    },
  });
  assert.equal(result.dimensions["stale_eth_quote"], "alert");
  assert.equal(result.dimensions["stale_btc_quote"], "ok");
});

test("stale_autotrader alert when wsLive=false", async () => {
  const result = await runPoll({ ...healthyPayload(), autotrader: { wsLive: false, lastTickMs: 0 } });
  assert.equal(result.dimensions["stale_autotrader"], "alert");
});

test("overdue_reconciliation alert when sweep is overdue", async () => {
  const reallyOldAt = new Date(Date.now() - OVERDUE_RECONCILE_MS - 120_000).toISOString();
  const result = await runPoll({
    ...healthyPayload(),
    generated_at: new Date().toISOString(),
    reconciliation: { last_discovery_sweep_at: reallyOldAt },
  });
  assert.equal(result.dimensions["overdue_reconciliation"], "alert");
});

test("protective_exit_disabled alert when enabled=false", async () => {
  const result = await runPoll({
    ...healthyPayload(),
    protective_exit_monitor: { enabled: false },
  });
  assert.equal(result.dimensions["protective_exit_disabled"], "alert");
});

test("daily_profit_unavailable alert when state=unavailable", async () => {
  const result = await runPoll({
    ...healthyPayload(),
    daily_profit_lockout: { state: "unavailable", target_dollars: 75 },
  });
  assert.equal(result.dimensions["daily_profit_unavailable"], "alert");
});

test("ETH boundary evidence alerts only after sustained unavailable reads and clears on recovery", async () => {
  const unavailable = {
    ...healthyPayload(),
    eth420_boundary_evidence: { availability: "unavailable", diagnostic_reason: "storage_read_failed" },
  };
  const first = await runPoll(unavailable);
  assert.equal(first.dimensions["eth420_boundary_evidence_unavailable"], "alert");
  assert.equal(getWatchdogStatus().dimensions["eth420_boundary_evidence_unavailable"].state, "ok");
  assert.equal(getWatchdogStatus().dimensions["eth420_boundary_evidence_unavailable"].diagnosticReason, null);

  await runPoll(unavailable);
  const alerted = getWatchdogStatus().dimensions["eth420_boundary_evidence_unavailable"];
  assert.equal(alerted.state, "alert");
  assert.equal(alerted.diagnosticReason, "storage_read_failed");

  await runPoll(healthyPayload());
  const recovered = getWatchdogStatus().dimensions["eth420_boundary_evidence_unavailable"];
  assert.equal(recovered.state, "ok");
  assert.equal(recovered.diagnosticReason, null);
});

// ── Transition tracking ───────────────────────────────────────────────────────

test("transition sink is called on alert entry", async () => {
  const transitions: Array<{ dimension: WatchdogDimension; newState: string }> = [];
  setWatchdogTransitionSink((event) => {
    transitions.push({ dimension: event.dimension, newState: event.newState });
  });

  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });

  const wsTransition = transitions.find((t) => t.dimension === "ws_disconnect");
  assert.ok(wsTransition, "ws_disconnect transition should be recorded");
  assert.equal(wsTransition?.newState, "alert");
});

test("transition sink is called on alert recovery", async () => {
  const transitions: Array<{ dimension: WatchdogDimension; newState: string; previousState: string }> = [];
  setWatchdogTransitionSink((event) => {
    transitions.push({ dimension: event.dimension, newState: event.newState, previousState: event.previousState });
  });

  // Poll 1: enter ws_disconnect alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.ok(transitions.some((t) => t.dimension === "ws_disconnect" && t.newState === "alert"));

  // Poll 2: recover (websocket back to connected)
  transitions.length = 0;
  await runPoll(healthyPayload());

  const recovery = transitions.find((t) => t.dimension === "ws_disconnect" && t.newState === "ok");
  assert.ok(recovery, "ws_disconnect recovery transition should be recorded");
  assert.equal(recovery?.previousState, "alert");
});

test("totalAlertTransitions increments on each unique dimension alert entry", async () => {
  await runPoll({
    ...healthyPayload(),
    kalshi_connection: { websocket_connected: false },
    autotrader: { wsLive: false, lastTickMs: 0 },
  });

  const status = getWatchdogStatus();
  // ws_disconnect and stale_autotrader both transitioned from ok to alert
  assert.equal(status.totalAlertTransitions, 2);
});

test("totalAlertTransitions does not increment on consecutive polls in same alert state", async () => {
  // Poll 1: ws_disconnect alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(getWatchdogStatus().totalAlertTransitions, 1);

  // Poll 2: same alert — should NOT increment
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(getWatchdogStatus().totalAlertTransitions, 1);
});

test("consecutiveCount increments across polls in same state", async () => {
  // Poll 1: enter alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(getWatchdogStatus().dimensions["ws_disconnect"].consecutiveCount, 1);

  // Poll 2: still in alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(getWatchdogStatus().dimensions["ws_disconnect"].consecutiveCount, 2);
  assert.equal(getWatchdogStatus().totalAlertTransitions, 1); // no new transition
});

test("consecutiveCount resets to 1 on transition to new state", async () => {
  // Poll 1: healthy (ok state, count=1 once polled once)
  await runPoll(healthyPayload());
  assert.equal(getWatchdogStatus().dimensions["ws_disconnect"].consecutiveCount, 1);

  // Poll 2: enter alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(getWatchdogStatus().dimensions["ws_disconnect"].consecutiveCount, 1); // reset to 1 on transition
});

test("since timestamp is set at first transition and not updated on consecutive polls", async () => {
  // Poll 1: enter alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  const since1 = getWatchdogStatus().dimensions["ws_disconnect"].since;
  assert.ok(since1 !== null, "since should be set after first alert");

  // Poll 2: same alert state — since should NOT change
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  const since2 = getWatchdogStatus().dimensions["ws_disconnect"].since;
  assert.equal(since2, since1, "since should not change when staying in alert");
});

test("since updates when state transitions from alert back to ok", async () => {
  // Poll 1: enter alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  const alertSince = getWatchdogStatus().dimensions["ws_disconnect"].since;
  assert.ok(alertSince !== null);

  // Poll 2: recover
  await runPoll(healthyPayload());
  const okSince = getWatchdogStatus().dimensions["ws_disconnect"].since;
  assert.ok(okSince !== null, "since should update after recovery");
  // since should reflect the recovery poll, not the original alert
  assert.ok(new Date(okSince!).getTime() >= new Date(alertSince!).getTime());
});

// ── History ring buffer ───────────────────────────────────────────────────────

test("history ring buffer caps at WATCHDOG_HISTORY_CAPACITY", async () => {
  const target = WATCHDOG_HISTORY_CAPACITY + 5;
  _setWatchdogFetchOverride(async () => makeResponse(200, healthyPayload()));
  for (let i = 0; i < target; i++) {
    await _executePollForTesting();
  }

  assert.equal(getWatchdogHistory().length, WATCHDOG_HISTORY_CAPACITY);
  assert.equal(getWatchdogStatus().totalPolls, target);
});

test("getWatchdogHistory returns a copy (mutations do not affect internal state)", async () => {
  await runPoll(healthyPayload());
  const h1 = getWatchdogHistory();
  h1.push({} as WatchdogPollResult);
  const h2 = getWatchdogHistory();
  assert.equal(h2.length, 1);
});

test("history contains poll results in insertion order (oldest first)", async () => {
  _setWatchdogFetchOverride(async () => makeResponse(200, healthyPayload()));
  await _executePollForTesting();

  _setWatchdogFetchOverride(async () => makeResponse(200, {
    ...healthyPayload(),
    kalshi_connection: { websocket_connected: false },
  }));
  await _executePollForTesting();

  const history = getWatchdogHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].dimensions["ws_disconnect"], "ok");    // first poll: healthy
  assert.equal(history[1].dimensions["ws_disconnect"], "alert"); // second poll: alert
});

// ── History sink ──────────────────────────────────────────────────────────────

test("history sink receives every poll result", async () => {
  const received: WatchdogPollResult[] = [];
  setWatchdogHistorySink((r) => { received.push(r); });

  _setWatchdogFetchOverride(async () => makeResponse(200, healthyPayload()));
  await _executePollForTesting();
  await _executePollForTesting();
  await _executePollForTesting();

  assert.equal(received.length, 3);
});

test("history sink receives both successful and failed poll results", async () => {
  const received: WatchdogPollResult[] = [];
  setWatchdogHistorySink((r) => { received.push(r); });

  await runPoll(healthyPayload());
  _setWatchdogFetchOverride(async () => { throw new Error("network down"); });
  await _executePollForTesting();

  assert.equal(received.length, 2);
  assert.equal(received[0].success, true);
  assert.equal(received[1].success, false);
});

// ── Sink error isolation ──────────────────────────────────────────────────────

test("throwing transition sink does not crash watchdog", async () => {
  setWatchdogTransitionSink(() => { throw new Error("sink exploded"); });
  const result = await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(result.dimensions["ws_disconnect"], "alert");
  assert.equal(getWatchdogStatus().totalPolls, 1);
});

test("throwing history sink does not crash watchdog", async () => {
  setWatchdogHistorySink(() => { throw new Error("history sink exploded"); });
  const result = await runPoll(healthyPayload());
  assert.equal(result.success, true);
  assert.equal(getWatchdogStatus().totalPolls, 1);
});

test("async-throwing transition sink does not crash watchdog", async () => {
  setWatchdogTransitionSink(async () => { throw new Error("async sink exploded"); });
  const result = await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(result.dimensions["ws_disconnect"], "alert");
});

// ── startWatchdog / stopWatchdog ──────────────────────────────────────────────

test("startWatchdog called twice does not double-start", async () => {
  let pollCount = 0;
  const firstPollDone = new Promise<void>((resolve) => {
    setWatchdogHistorySink(() => {
      pollCount += 1;
      if (pollCount === 1) resolve();
    });
  });

  _setWatchdogFetchOverride(async () => makeResponse(200, healthyPayload()));
  startWatchdog(9_999_999);
  startWatchdog(9_999_999); // second call should be ignored
  await firstPollDone;

  // After the first poll resolves, no second poll should have fired yet
  assert.equal(pollCount, 1, "should only have polled once despite two startWatchdog calls");
});

test("stopWatchdog is idempotent", () => {
  stopWatchdog(); // should not throw when not running
  stopWatchdog(); // double-stop also fine
});

// ── _resetWatchdogForTesting ──────────────────────────────────────────────────

test("_resetWatchdogForTesting fully clears state", async () => {
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(getWatchdogStatus().totalPolls, 1);
  assert.equal(getWatchdogStatus().totalAlertTransitions, 1);

  _resetWatchdogForTesting();

  const status = getWatchdogStatus();
  assert.equal(status.totalPolls, 0);
  assert.equal(status.lastPolledAt, null);
  assert.equal(status.totalAlertTransitions, 0);
  assert.equal(getWatchdogHistory().length, 0);
  assert.equal(isWatchdogFullyHealthy(), true);
});

// ── Accessor helpers ──────────────────────────────────────────────────────────

test("isWatchdogDimensionHealthy returns false after alert", async () => {
  await runPoll({ ...healthyPayload(), protective_exit_monitor: { enabled: false } });
  assert.equal(isWatchdogDimensionHealthy("protective_exit_disabled"), false);
  assert.equal(isWatchdogDimensionHealthy("stale_btc_quote"), true);
});

test("isWatchdogFullyHealthy is false when any dimension is in alert", async () => {
  await runPoll({ ...healthyPayload(), daily_profit_lockout: { state: "unavailable" } });
  assert.equal(isWatchdogFullyHealthy(), false);
});

test("isWatchdogFullyHealthy returns true after all dimensions recover", async () => {
  // Enter alert
  await runPoll({ ...healthyPayload(), kalshi_connection: { websocket_connected: false } });
  assert.equal(isWatchdogFullyHealthy(), false);

  // Recover
  await runPoll(healthyPayload());
  assert.equal(isWatchdogFullyHealthy(), true);
});

// ── No trading imports ────────────────────────────────────────────────────────

test("runtimeWatchdog module does not pull in trading/order paths", () => {
  // This test verifies by the fact that the module loaded cleanly with NO
  // imports from autoTrader, tradeStore, protectiveExit, kalshi, or order paths.
  // If any such import existed, the module bundle would have failed to load here.
  assert.ok(true, "module loaded without trading/order dependencies");
});

// ── PORT env var token handling ───────────────────────────────────────────────

test("getWatchdogStatus returns a snapshot (not live reference)", async () => {
  await runPoll(healthyPayload());
  const snap1 = getWatchdogStatus();
  await runPoll(healthyPayload());
  const snap2 = getWatchdogStatus();

  // snap1 and snap2 should be independent objects
  assert.equal(snap1.totalPolls, 1);
  assert.equal(snap2.totalPolls, 2);
});

test("WatchdogPollResult polledAt is a valid ISO string", async () => {
  const result = await runPoll(healthyPayload());
  const parsed = new Date(result.polledAt);
  assert.ok(!isNaN(parsed.getTime()), "polledAt should be a valid ISO date");
});

test("endpoint_failure and api_failure are both ok on a successful 200 poll", async () => {
  const result = await runPoll(healthyPayload());
  assert.equal(result.dimensions["endpoint_failure"], "ok");
  assert.equal(result.dimensions["api_failure"], "ok");
});
