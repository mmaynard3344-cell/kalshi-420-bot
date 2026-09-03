/**
 * autoTrader.concurrency.test.ts
 *
 * Tests for the runWithPreflightLock function exported from autoTraderGuards.ts.
 *
 * runWithPreflightLock is the single shared implementation of the pre-flight
 * concurrency lock used by autoTrader.ts checkAndPlace. These tests call it
 * directly with injectable mock callbacks — no lock logic is duplicated or
 * imitated here.
 *
 * ── What is under test ───────────────────────────────────────────────────────
 *   runWithPreflightLock(ticker, fn)
 *     • Returns { blocked: true, reason } when preflightInFlight or
 *       submissionInFlight is already held for ticker.
 *     • Returns { blocked: false, result } when fn() runs to completion.
 *     • Releases preflightInFlight in a finally block on normal return,
 *       early return (gate skip), and thrown error.
 *     • Provides cross-ticker independence — different tickers can hold
 *       their own locks simultaneously.
 *
 * ── What is NOT under test ───────────────────────────────────────────────────
 *   autoTrader.ts internals (L2 fetch, gate logic, placeOrder) — those are
 *   tested by autoTrader.preflight.test.ts and the integration test suite.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  runWithPreflightLock,
  preflightInFlight,
  submissionInFlight,
  submissionOrderIds,
  _resetAutoTraderStateForTesting,
  _forceSubmissionInFlightForTesting,
} from "./autoTraderGuards.js";

const T1 = "KXBTC15M-CONCUR-TEST-01";
const T2 = "KXETH15M-CONCUR-TEST-02";

beforeEach(() => _resetAutoTraderStateForTesting());

// ── Basic lock acquisition and release ────────────────────────────────────────

describe("runWithPreflightLock — lock lifecycle", () => {

  it("1: returns { blocked: false, result } and releases lock on success", async () => {
    let lockHeldInsideFn = false;
    const r = await runWithPreflightLock(T1, async () => {
      lockHeldInsideFn = preflightInFlight.has(T1);
      return "gate_decision";
    });
    assert.deepEqual(r, { blocked: false, result: "gate_decision" });
    assert.ok(lockHeldInsideFn, "lock must be held inside fn()");
    assert.ok(!preflightInFlight.has(T1), "lock must be released after fn() returns");
  });

  it("2: releases lock even when fn() throws (L2 fetch error path)", async () => {
    let errorPropagated = false;
    try {
      await runWithPreflightLock(T1, async () => {
        throw new Error("L2 fetch timeout");
      });
    } catch {
      errorPropagated = true;
    }
    assert.ok(errorPropagated, "error from fn() must propagate to caller");
    assert.ok(!preflightInFlight.has(T1), "lock must be released even after fn() throws");
  });

  it("3: releases lock when fn() resolves early (gate skip path)", async () => {
    const r = await runWithPreflightLock(T1, async () => "skip_zero_depth" as const);
    assert.deepEqual(r, { blocked: false, result: "skip_zero_depth" });
    assert.ok(!preflightInFlight.has(T1), "lock cleared on gate-skip path");
  });

});

// ── Blocking behavior ─────────────────────────────────────────────────────────

describe("runWithPreflightLock — concurrent call blocking", () => {

  it("4: same ticker, concurrent calls — second blocked by preflightInFlight", async () => {
    let captureOrderbookCalls = 0;

    // Barrier: resolve when first call has acquired the lock
    let barrierResolve!: () => void;
    const barrier = new Promise<void>((r) => { barrierResolve = r; });

    // First call: acquires lock, signals barrier, simulates L2 fetch latency
    const call1 = runWithPreflightLock(T1, async () => {
      captureOrderbookCalls++;
      barrierResolve();
      await new Promise<void>((r) => setTimeout(r, 15));
    });

    // Second call: starts after first has acquired the lock
    await barrier;
    const result2 = await runWithPreflightLock(T1, async () => {
      captureOrderbookCalls++; // must NOT be called if blocked
    });
    const result1 = await call1;

    assert.deepEqual(result1, { blocked: false, result: undefined },
      "first call must succeed");
    assert.equal(result2.blocked, true,
      "second call must be blocked by first");
    assert.equal(
      (result2 as { blocked: true; reason: string }).reason,
      "preflight_in_flight",
      "reason must be preflight_in_flight",
    );
    assert.equal(captureOrderbookCalls, 1,
      "captureOrderbook must only run once — second call was blocked");
  });

  it("5: submissionInFlight blocks runWithPreflightLock with reason submission_in_flight", async () => {
    _forceSubmissionInFlightForTesting(T1);

    const result = await runWithPreflightLock(T1, async () => {
      assert.fail("fn() must not be called when submissionInFlight holds ticker");
    });

    assert.equal(result.blocked, true);
    assert.equal(
      (result as { blocked: true; reason: string }).reason,
      "submission_in_flight",
    );
  });

  it("6: submissionInFlight for ticker X does not block ticker Y", async () => {
    _forceSubmissionInFlightForTesting(T1);

    let t2FnCalled = false;
    const resultT2 = await runWithPreflightLock(T2, async () => {
      t2FnCalled = true;
    });

    assert.equal(resultT2.blocked, false,
      "T2 must not be blocked by T1's submissionInFlight");
    assert.ok(t2FnCalled, "T2 fn() must be called independently");
  });

  it("7: different tickers proceed independently when both in-flight", async () => {
    let t1Ran = false;
    let t2Ran = false;

    let t1Resolve!: () => void;
    const t1Barrier = new Promise<void>((r) => { t1Resolve = r; });

    // Start T1 — holds its lock and signals
    const call1 = runWithPreflightLock(T1, async () => {
      t1Ran = true;
      t1Resolve();
      await new Promise<void>((r) => setTimeout(r, 15));
    });

    // Wait for T1 to hold its lock, then start T2
    await t1Barrier;
    const call2 = runWithPreflightLock(T2, async () => {
      t2Ran = true;
    });

    const [r1, r2] = await Promise.all([call1, call2]);

    assert.equal(r1.blocked, false, "T1 must succeed");
    assert.equal(r2.blocked, false, "T2 must succeed independently");
    assert.ok(t1Ran, "T1 fn() must have run");
    assert.ok(t2Ran, "T2 fn() must have run while T1 still held its lock");
  });

});

// ── State management ──────────────────────────────────────────────────────────

describe("runWithPreflightLock — state management", () => {

  it("8: _resetAutoTraderStateForTesting clears preflightInFlight", async () => {
    // Acquire the lock
    const lockStarted = new Promise<void>((r) => {
      runWithPreflightLock(T1, async () => {
        r(); // lock acquired
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }).catch(() => {});
    });
    await lockStarted;

    assert.ok(preflightInFlight.has(T1), "lock must be held before reset");
    _resetAutoTraderStateForTesting();
    assert.ok(!preflightInFlight.has(T1), "reset must clear preflightInFlight");
    assert.ok(!submissionInFlight.has(T1), "reset must clear submissionInFlight");
    assert.ok(!submissionOrderIds.has(T1), "reset must clear submissionOrderIds");
  });

  it("9: blocked call does not alter preflightInFlight", async () => {
    _forceSubmissionInFlightForTesting(T1);
    assert.ok(!preflightInFlight.has(T1), "before: preflightInFlight must be clear");

    const r = await runWithPreflightLock(T1, async () => {});
    assert.equal(r.blocked, true);

    // preflightInFlight must still be clear — blocked path never adds to it
    assert.ok(!preflightInFlight.has(T1),
      "blocked call must not add ticker to preflightInFlight");
  });

});

// ── SIGTERM state helpers ─────────────────────────────────────────────────────

describe("submissionOrderIds — SIGTERM correlation state", () => {

  it("10: submissionOrderIds clears on _resetAutoTraderStateForTesting", () => {
    submissionOrderIds.set(T1, "test-cid-001");
    submissionOrderIds.set(T2, "test-cid-002");
    _resetAutoTraderStateForTesting();
    assert.equal(submissionOrderIds.size, 0,
      "reset must clear all submissionOrderIds entries");
  });

  it("11: SIGTERM log format — Object.fromEntries produces correct clientOrderId map", () => {
    // Simulate the state that would exist when SIGTERM fires mid-submission.
    // The SIGTERM handler constructs: Object.fromEntries(submissionOrderIds)
    // This test verifies the format is correct for log parsing and SQL reconciliation.
    submissionOrderIds.set(T1, "client-order-id-btc-0001");
    submissionOrderIds.set(T2, "client-order-id-eth-0002");

    const sigtermLogPayload: Record<string, string> = Object.fromEntries(submissionOrderIds);
    assert.deepEqual(sigtermLogPayload, {
      [T1]: "client-order-id-btc-0001",
      [T2]: "client-order-id-eth-0002",
    }, "SIGTERM log must contain ticker → clientOrderId mapping");

    // The tickers are the same Set as submissionInFlight would have
    const inFlightTickers = [T1, T2] as const;
    assert.deepEqual(
      inFlightTickers.map((t) => (sigtermLogPayload as Record<string, string>)[t]),
      ["client-order-id-btc-0001", "client-order-id-eth-0002"],
      "each in-flight ticker must resolve to its clientOrderId",
    );
  });

});
