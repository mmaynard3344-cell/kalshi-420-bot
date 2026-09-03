/**
 * marketDataCoverage.test.ts — deterministic tests for final-window coverage
 * tracking, incident creation, rate-limited recovery, and durable persistence.
 *
 * Proofs required by the task:
 *  - A gap is detected ONLY inside the final 120-second window.
 *  - Exactly ONE durable incident per ticker/window.
 *  - Recovery is rate-limited (spacing + per-window cap) and scoped to a
 *    ticker/window.
 *  - Recovery cannot alter live trading actions: the module has no imports
 *    from any order path, and the recovery handler is a pure injected
 *    callback whose invocations we count.
 *  - Incidents survive a restart (read back from NDJSON).
 *
 * Run:
 *   cd artifacts/api-server && node_modules/.bin/esbuild src/lib/marketDataCoverage.test.ts \
 *     --bundle --platform=node --format=esm --outfile=/tmp/coverage.mjs && node --test /tmp/coverage.mjs
 */

import { describe, it, beforeEach, before, after } from "node:test";
import assert                                       from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir }                                   from "node:os";
import { join }                                     from "node:path";

import {
  FINAL_WINDOW_SECONDS,
  COVERAGE_GAP_MS,
  MIN_RECOVERY_INTERVAL_MS,
  MAX_RECOVERY_ATTEMPTS_PER_WINDOW,
  trackCoverageWindow,
  recordCoverageUsableQuote,
  recordCoverageEvaluation,
  recordCoverageWsMessage,
  recordCoverageObservation,
  runCoverageCheck,
  getCoverageStatus,
  getCoverageWindowAudits,
  hydrateUnfinishedCoverageAudits,
  loadRecentCoverageIncidents,
  setCoverageRecoveryHandler,
  setCoverageWsConnectedProbe,
  _resetCoverageForTesting,
} from "./marketDataCoverage.js";

let testDir: string;

before(() => {
  testDir = mkdtempSync(join(tmpdir(), "coverage-test-"));
  process.env["COVERAGE_DATA_DIR"] = testDir;
});

after(() => {
  delete process.env["COVERAGE_DATA_DIR"];
  rmSync(testDir, { recursive: true, force: true });
});

/** Small helper: a window whose close time is `secsFromNow` after `base`. */
function setup(base: number, secsFromNow: number, ticker = "KXETH15M-TEST-00") {
  const closeTime = new Date(base + secsFromNow * 1000).toISOString();
  trackCoverageWindow(ticker, "KXETH15M", closeTime);
  return { ticker, closeTime };
}

/** Drain microtasks so async recovery handler .then() callbacks settle. */
async function settle() { await new Promise((r) => setTimeout(r, 5)); }

describe("marketDataCoverage (sequential)", () => {

  beforeEach(() => {
    _resetCoverageForTesting();
    // Fresh incident dir per test — one incident file namespace per test run.
    testDir = mkdtempSync(join(tmpdir(), "coverage-test-"));
    process.env["COVERAGE_DATA_DIR"] = testDir;
  });

  describe("gap detection scope", () => {
    it("no incident outside the final window even with no quotes at all", () => {
      const base = Date.now();
      setup(base, FINAL_WINDOW_SECONDS + 300); // 420 s to close — pre-window
      runCoverageCheck(base);
      const st = getCoverageStatus(base)[0];
      assert.equal(st.state, "pre_window");
      assert.equal(st.incident, null);
      assert.equal(loadRecentCoverageIncidents(0).length, 0);
    });

    it("detects a gap inside the final window when no usable quote is fresh", () => {
      const base = Date.now();
      const { ticker } = setup(base, 100); // 100 s to close — final window
      // Last usable quote 30 s ago (> COVERAGE_GAP_MS)
      recordCoverageUsableQuote(ticker, base - 30_000);
      runCoverageCheck(base);
      const st = getCoverageStatus(base)[0];
      assert.equal(st.state, "gap");
      assert.ok(st.incident, "incident must be created");
      assert.equal(st.incident!.status, "unresolved");
      assert.equal(st.incident!.ticker, ticker);
    });

    it("healthy when a usable quote is fresh inside the final window", () => {
      const base = Date.now();
      const { ticker } = setup(base, 100);
      recordCoverageUsableQuote(ticker, base - 5_000); // fresh
      runCoverageCheck(base);
      const st = getCoverageStatus(base)[0];
      assert.equal(st.state, "healthy");
      assert.equal(st.incident, null);
    });

    it("a connected WS alone is NOT coverage — control frames don't count as quotes", () => {
      const base = Date.now();
      setup(base, 90);
      setCoverageWsConnectedProbe(() => true);
      recordCoverageWsMessage("ack", base);       // subscription ack
      recordCoverageWsMessage("heartbeat", base); // heartbeat
      runCoverageCheck(base);
      const st = getCoverageStatus(base)[0];
      assert.equal(st.state, "gap", "control traffic must not mask a data gap");
      assert.equal(st.wsConnected, true);
      assert.ok(st.incident);
      assert.equal(st.incident!.wsConnected, true, "incident retains connection context");
    });
  });

  describe("one durable incident per ticker/window", () => {
    it("repeated checks create exactly one incident", () => {
      const base = Date.now();
      setup(base, 110);
      for (let i = 0; i < 10; i++) runCoverageCheck(base + i * 1000);
      const incidents = loadRecentCoverageIncidents(0);
      assert.equal(new Set(incidents.map((i) => i.incidentId)).size, 1);
      assert.equal(incidents.length, 1);
    });

    it("two tickers each get their own incident (correct scoping)", () => {
      const base = Date.now();
      setup(base, 100, "KXETH15M-A");
      setup(base, 100, "KXBTC15M-B");
      runCoverageCheck(base);
      const incidents = loadRecentCoverageIncidents(0);
      assert.equal(incidents.length, 2);
      const tickers = incidents.map((i) => i.ticker).sort();
      assert.deepEqual(tickers, ["KXBTC15M-B", "KXETH15M-A"]);
    });

    it("a usable quote after detection marks the incident recovered", () => {
      const base = Date.now();
      const { ticker } = setup(base, 110);
      runCoverageCheck(base);
      recordCoverageUsableQuote(ticker, base + 10_000);
      const incidents = loadRecentCoverageIncidents(0);
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].status, "recovered");
      assert.equal(incidents[0].recoveredAtMs, base + 10_000);
    });

    it("window closing without recovery seals the incident as unrecovered_window_closed", () => {
      const base = Date.now();
      setup(base, 60);
      runCoverageCheck(base);            // detect at T−60s
      runCoverageCheck(base + 61_000);   // window closed
      const incidents = loadRecentCoverageIncidents(0);
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].status, "unrecovered_window_closed");
    });

    it("a quote for ticker A does not resolve ticker B's incident", () => {
      const base = Date.now();
      setup(base, 100, "KXETH15M-A");
      setup(base, 100, "KXBTC15M-B");
      runCoverageCheck(base);
      recordCoverageUsableQuote("KXETH15M-A", base + 5_000);
      const byTicker = new Map(loadRecentCoverageIncidents(0).map((i) => [i.ticker, i]));
      assert.equal(byTicker.get("KXETH15M-A")!.status, "recovered");
      assert.equal(byTicker.get("KXBTC15M-B")!.status, "unresolved");
    });
  });

  describe("rate-limited recovery", () => {
    it("recovery fires once per detection tick, spaced by MIN_RECOVERY_INTERVAL_MS", async () => {
      const base = Date.now();
      setup(base, FINAL_WINDOW_SECONDS); // full final window available
      const calls: number[] = [];
      setCoverageRecoveryHandler(async () => { calls.push(1); return "resubscribed"; });

      runCoverageCheck(base);
      await settle();
      assert.equal(calls.length, 1, "first attempt fires immediately at detection");

      // Checks inside the spacing window must NOT fire again.
      runCoverageCheck(base + 5_000);
      runCoverageCheck(base + MIN_RECOVERY_INTERVAL_MS - 1);
      await settle();
      assert.equal(calls.length, 1, "attempts inside the spacing window are suppressed");

      // After the spacing elapses, one more attempt is allowed.
      runCoverageCheck(base + MIN_RECOVERY_INTERVAL_MS);
      await settle();
      assert.equal(calls.length, 2);
    });

    it("caps attempts at MAX_RECOVERY_ATTEMPTS_PER_WINDOW", async () => {
      const base = Date.now();
      // Very long "final window" is impossible (120 s max) — use a synthetic
      // window at exactly 120 s and step in spacing increments; only the steps
      // that remain inside the window can fire, and never more than the cap.
      setup(base, FINAL_WINDOW_SECONDS);
      let calls = 0;
      setCoverageRecoveryHandler(async () => { calls++; return "ok"; });
      for (let t = 0; t <= FINAL_WINDOW_SECONDS * 1000; t += MIN_RECOVERY_INTERVAL_MS) {
        runCoverageCheck(base + t);
        await settle();
      }
      assert.ok(calls <= MAX_RECOVERY_ATTEMPTS_PER_WINDOW,
        `attempts (${calls}) must not exceed cap (${MAX_RECOVERY_ATTEMPTS_PER_WINDOW})`);
      assert.ok(calls >= 2, "multiple spaced attempts should have fired");
    });

    it("records each attempt and its outcome on the durable incident", async () => {
      const base = Date.now();
      setup(base, 110);
      setCoverageRecoveryHandler(async () => "reconnect_initiated");
      runCoverageCheck(base);
      await settle();
      const inc = loadRecentCoverageIncidents(0)[0];
      assert.equal(inc.recoveryAttempts.length, 1);
      assert.equal(inc.recoveryAttempts[0].outcome, "reconnect_initiated");
    });

    it("a throwing recovery handler is contained and recorded", async () => {
      const base = Date.now();
      setup(base, 110);
      setCoverageRecoveryHandler(async () => { throw new Error("socket exploded"); });
      assert.doesNotThrow(() => runCoverageCheck(base));
      await settle();
      const inc = loadRecentCoverageIncidents(0)[0];
      assert.match(inc.recoveryAttempts[0].outcome, /handler_error: socket exploded/);
    });

    it("no recovery once the incident is recovered", async () => {
      const base = Date.now();
      const { ticker } = setup(base, FINAL_WINDOW_SECONDS);
      let calls = 0;
      setCoverageRecoveryHandler(async () => { calls++; return "ok"; });
      runCoverageCheck(base);
      await settle();
      recordCoverageUsableQuote(ticker, base + 2_000);
      // Keep the quote fresh — healthy, so no further attempts even after spacing.
      recordCoverageUsableQuote(ticker, base + MIN_RECOVERY_INTERVAL_MS);
      runCoverageCheck(base + MIN_RECOVERY_INTERVAL_MS + 1_000);
      await settle();
      assert.equal(calls, 1);
    });
  });

  describe("recovery cannot alter live trading actions", () => {
    it("module source imports nothing from any order/trading path", () => {
      // Structural proof: the bundled test includes marketDataCoverage.ts.
      // Verify the module file itself references no trading entry points.
      const src = readFileSync(join(process.cwd(), "src", "lib", "marketDataCoverage.ts"), "utf8");
      for (const banned of [
        "placeOrder", "checkAndPlace", "kalshiAuthFetch", "reserveAndRecord",
        "claimOrderSlot", "reserveNotional", "evaluate(", "protectiveExit",
        "autoTrader", "tradeStore",
      ]) {
        assert.ok(!src.includes(banned),
          `marketDataCoverage.ts must not reference trading symbol "${banned}"`);
      }
    });

    it("the recovery handler receives only ticker+reason — no order parameters exist", async () => {
      const base = Date.now();
      setup(base, 110, "KXETH15M-SCOPED");
      let received: Record<string, unknown> | null = null;
      setCoverageRecoveryHandler(async (input) => { received = { ...input }; return "ok"; });
      runCoverageCheck(base);
      await settle();
      assert.ok(received);
      assert.deepEqual(Object.keys(received!).sort(), ["reason", "ticker"]);
      assert.equal((received as Record<string, unknown>)["ticker"], "KXETH15M-SCOPED");
      assert.match(String((received as Record<string, unknown>)["reason"]), /final_window_quote_gap/);
    });
  });

  describe("durable persistence (restart survival)", () => {
    it("incidents are NDJSON on disk and re-readable with last-state-wins", async () => {
      const base = Date.now();
      const { ticker } = setup(base, 110);
      runCoverageCheck(base);                              // unresolved written
      recordCoverageUsableQuote(ticker, base + 8_000);     // recovered written
      const files = readdirSync(testDir).filter((f) => f.startsWith("coverage-incidents-"));
      assert.equal(files.length, 1);
      const lines = readFileSync(join(testDir, files[0]), "utf8").split("\n").filter(Boolean);
      assert.ok(lines.length >= 2, "each state change appends a full record");
      // Reader dedupes by incidentId keeping the latest state.
      const incidents = loadRecentCoverageIncidents(0);
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].status, "recovered");
    });

    it("a corrupted line does not hide other incidents", async () => {
      const base = Date.now();
      setup(base, 110);
      runCoverageCheck(base);
      const files = readdirSync(testDir).filter((f) => f.startsWith("coverage-incidents-"));
      const path = join(testDir, files[0]);
      const { appendFileSync } = await import("node:fs");
      appendFileSync(path, "{corrupted-not-json\n", "utf8");
      const incidents = loadRecentCoverageIncidents(0);
      assert.equal(incidents.length, 1, "valid incident still readable past corruption");
    });

    it("loadRecentCoverageIncidents returns [] when the directory is unreadable", () => {
      process.env["COVERAGE_DATA_DIR"] = "/nonexistent-root-path/we-cannot-create";
      // getDataDir's mkdir fails silently; readdir throws; loader returns [].
      const result = loadRecentCoverageIncidents(0);
      assert.deepEqual(result, []);
      process.env["COVERAGE_DATA_DIR"] = testDir;
    });
  });

  describe("registration independent of evaluation (REGRESSION)", () => {
    it("a window registered via raw observation with NO evaluations and NO quotes still produces an incident", () => {
      const base = Date.now();
      // Simulates: kalshiStream.refreshTickers discovered the window right
      // after a restart, but the stream stayed silent and no REST evaluation
      // path ever ran — recordCoverageObservation with no bids.
      recordCoverageObservation({
        ticker: "KXETH15M-SILENT",
        series: "KXETH15M",
        closeTime: new Date(base + 100_000).toISOString(),
        rawYesBid: null,
        rawNoBid:  null,
        nowMs: base,
      });
      runCoverageCheck(base); // inside final window (100 s left)
      const st = getCoverageStatus(base)[0];
      assert.equal(st.ticker, "KXETH15M-SILENT");
      assert.equal(st.state, "gap");
      assert.equal(st.finalWindowEvaluations, 0);
      assert.ok(st.incident, "silent window must still surface an incident");
      assert.equal(loadRecentCoverageIncidents(0).length, 1);
    });

    it("telemetry is never empty-healthy once discovery has seen the window", () => {
      const base = Date.now();
      recordCoverageObservation({
        ticker: "KXBTC15M-DISCOVERED",
        series: "KXBTC15M",
        closeTime: new Date(base + 600_000).toISOString(), // pre-window
        nowMs: base,
      });
      const status = getCoverageStatus(base);
      assert.equal(status.length, 1, "discovered window must appear in status even pre-window");
      assert.equal(status[0].state, "pre_window");
    });
  });

  describe("raw-BBO gating of usable quotes (REGRESSION)", () => {
    it("partial updates without raw bids do NOT refresh quote evidence", () => {
      const base = Date.now();
      const ticker = "KXETH15M-PARTIAL";
      const closeTime = new Date(base + 110_000).toISOString();
      // Real quote arrives 40 s before the check…
      recordCoverageObservation({
        ticker, series: "KXETH15M", closeTime, rawYesBid: 92, nowMs: base - 40_000,
      });
      // …followed by a stream of partial updates that omit BBO fields
      // (mergeState would retain the old bids, but coverage must not count them).
      for (let t = -30_000; t < 0; t += 5_000) {
        recordCoverageObservation({
          ticker, series: "KXETH15M", closeTime,
          rawYesBid: null, rawNoBid: null, nowMs: base + t,
        });
      }
      runCoverageCheck(base);
      const st = getCoverageStatus(base)[0];
      assert.equal(st.state, "gap", "stale merged bids must not mask the gap");
      assert.ok(st.incident);
      assert.equal(st.incident!.lastUsableQuoteMs, base - 40_000,
        "incident must retain the true last-usable-quote timestamp");
    });

    it("a raw bid on either side counts as a usable quote", () => {
      const base = Date.now();
      const closeTime = new Date(base + 100_000).toISOString();
      recordCoverageObservation({
        ticker: "KXBTC15M-NOBID", series: "KXBTC15M", closeTime,
        rawYesBid: null, rawNoBid: 7, nowMs: base - 2_000,
      });
      runCoverageCheck(base);
      assert.equal(getCoverageStatus(base)[0].state, "healthy");
    });
  });

  describe("recovery-to-evaluation integration (REGRESSION)", () => {
    it("a recovery that only refreshes a stream cache does NOT resolve the incident; only trader-path raw data does", async () => {
      const base = Date.now();
      const ticker = "KXETH15M-CTRLONLY";
      const closeTime = new Date(base + 110_000).toISOString();
      // Discovery registers the window WITHOUT quote evidence (mirrors
      // kalshiStream.refreshTickers, which passes no bid fields).
      recordCoverageObservation({ ticker, series: "KXETH15M", closeTime, nowMs: base });
      // WS stays connected but delivers only control frames.
      setCoverageWsConnectedProbe(() => true);
      recordCoverageWsMessage("ack", base);

      // Recovery handler that repairs the stream but feeds nothing to the
      // trader (the failure mode the review flagged).
      setCoverageRecoveryHandler(async () => "resubscribed_on_open_connection");
      runCoverageCheck(base);
      await settle();

      let inc = loadRecentCoverageIncidents(0)[0];
      assert.equal(inc.status, "unresolved",
        "stream-cache-only recovery must not count as recovered");
      assert.equal(getCoverageStatus(base + 1_000)[0].state, "gap");

      // Now the recovered data reaches the trader's own observation flow
      // (mergeState records from the raw payload) — only THIS resolves it.
      recordCoverageObservation({
        ticker, series: "KXETH15M", closeTime, rawYesBid: 93, nowMs: base + 2_000,
      });
      inc = loadRecentCoverageIncidents(0)[0];
      assert.equal(inc.status, "recovered");
      assert.equal(getCoverageStatus(base + 2_500)[0].state, "healthy");
    });

    it("a hung recovery for one ticker does not suppress recovery for another (per-window lock)", async () => {
      const base = Date.now();
      setup(base, 110, "KXETH15M-HUNG");
      setup(base, 110, "KXBTC15M-OK");
      const attempted: string[] = [];
      setCoverageRecoveryHandler(({ ticker }) => {
        attempted.push(ticker);
        if (ticker === "KXETH15M-HUNG") return new Promise(() => { /* never resolves */ });
        return Promise.resolve("ok");
      });
      runCoverageCheck(base);
      await settle();
      assert.deepEqual(attempted.sort(), ["KXBTC15M-OK", "KXETH15M-HUNG"],
        "both windows must attempt recovery despite one handler hanging");

      // And while HUNG is still in flight, the other window can attempt again
      // after the spacing interval (still capped by the per-window budget).
      runCoverageCheck(base + MIN_RECOVERY_INTERVAL_MS);
      await settle();
      assert.equal(attempted.filter((t) => t === "KXBTC15M-OK").length, 2);
      assert.equal(attempted.filter((t) => t === "KXETH15M-HUNG").length, 1,
        "in-flight window must not double-fire");
    });
  });

  describe("evaluation evidence counters", () => {
    it("counts final-window evaluations and usable quotes separately", () => {
      const base = Date.now();
      const { ticker } = setup(base, 100);
      recordCoverageEvaluation(ticker, base);
      recordCoverageEvaluation(ticker, base + 1_000);
      recordCoverageUsableQuote(ticker, base + 1_000);
      const st = getCoverageStatus(base + 2_000)[0];
      assert.equal(st.finalWindowEvaluations, 2);
      assert.equal(st.finalWindowUsableQuotes, 1);
      assert.equal(st.state, "healthy");
    });
  });

  describe("permanent ticker/window audit", () => {
    it("restart hydration seals unfinished evidence as degraded, without loading sealed history", () => {
      const base = Date.now();
      const audit = {
        auditId: "KXBTC15M-RESTART@x", ticker: "KXBTC15M-RESTART", series: "KXBTC15M",
        closeTime: new Date(base - 1_000).toISOString(), discoveredAtMs: base - 120_000,
        eligibleStartMs: base - 120_000, finalWindowStartedAtMs: base - 120_000,
        finalWindowClosedAtMs: null, firstUsableQuoteMs: base - 100_000, lastUsableQuoteMs: base - 90_000,
        firstEvaluationMs: null, lastEvaluationMs: null, finalWindowUsableQuotes: 1, finalWindowEvaluations: 0,
        status: "OBSERVING" as const, incidentId: null, transitions: [], recoveryAttempts: [],
        evidenceCompleteness: "complete" as const, restartEvidenceUncertain: false,
      };
      const sealedHistory = { ...audit, auditId: "old-sealed", status: "HEALTHY" as const, finalWindowClosedAtMs: base - 1_000 };
      hydrateUnfinishedCoverageAudits([audit, sealedHistory], base);
      runCoverageCheck(base);
      assert.equal(getCoverageWindowAudits().find((a) => a.auditId === audit.auditId)!.status, "DEGRADED_UNRECOVERED");
      assert.equal(getCoverageWindowAudits().some((a) => a.auditId === "old-sealed"), false);
    });

    it("seals HEALTHY only with positive raw usable-quote evidence and stays idempotent", () => {
      const base = Date.now();
      const { ticker } = setup(base, 60, "KXETH15M-AUDIT-HEALTHY");
      recordCoverageUsableQuote(ticker, base);
      recordCoverageUsableQuote(ticker, base + 15_000);
      runCoverageCheck(base);
      runCoverageCheck(base + 61_000);
      const audit = getCoverageWindowAudits().find((a) => a.ticker === ticker)!;
      assert.equal(audit.status, "HEALTHY");
      assert.equal(audit.finalWindowUsableQuotes, 2);
      const transitions = audit.transitions.length;
      runCoverageCheck(base + 70_000);
      assert.equal(getCoverageWindowAudits().find((a) => a.ticker === ticker)!.transitions.length, transitions);
    });

    it("seals a gap with later usable data as DEGRADED_RECOVERED and retains attempts", async () => {
      const base = Date.now();
      const { ticker } = setup(base, 60, "KXBTC15M-AUDIT-RECOVERED");
      setCoverageRecoveryHandler(async () => "resubscribed");
      runCoverageCheck(base);
      await settle();
      recordCoverageUsableQuote(ticker, base + 5_000);
      runCoverageCheck(base + 61_000);
      const audit = getCoverageWindowAudits().find((a) => a.ticker === ticker)!;
      assert.equal(audit.status, "DEGRADED_RECOVERED");
      assert.equal(audit.recoveryAttempts.length, 1);
      assert.ok(audit.finalWindowClosedAtMs);
    });

    it("seals a discovered but silent window as DEGRADED_UNRECOVERED, never HEALTHY", () => {
      const base = Date.now();
      const { ticker } = setup(base, 60, "KXETH15M-AUDIT-SILENT");
      runCoverageCheck(base);
      runCoverageCheck(base + 61_000);
      const audit = getCoverageWindowAudits().find((a) => a.ticker === ticker)!;
      assert.equal(audit.status, "DEGRADED_UNRECOVERED");
      assert.equal(audit.finalWindowUsableQuotes, 0);
    });
  });
});
