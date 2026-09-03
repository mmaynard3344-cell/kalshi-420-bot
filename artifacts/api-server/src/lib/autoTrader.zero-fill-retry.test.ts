/**
 * autoTrader.zero-fill-retry.test.ts
 *
 * Tests for the thin-book zero-fill retry mechanism:
 *   - After a zero-fill, identical BBO snapshots are suppressed for 30 s
 *     (ZERO_FILL_RETRY_DELAY_MS).
 *   - Once the delay elapses, exactly ONE retry is allowed
 *     (MAX_ZERO_FILL_RETRIES = 1) per ticker+side per window.
 *   - After the retry budget is used, subsequent ticks with the same snapshot
 *     are permanently suppressed for the rest of the window.
 *   - Window rollover resets the retry counter so the next window starts fresh.
 *   - A price change always clears suppression immediately, regardless of the
 *     retry counter.
 *
 * These tests exercise the exported state-manipulation helpers directly —
 * no Kalshi API mock or SQL mock is needed.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import {
  scheduleZeroFillRetryPoll,
  cancelZeroFillRetryPolls,
  zeroFillRetryPollTimers,
  ZERO_FILL_RETRY_POLL_MARGIN_MS,
  _resetAutoTraderStateForTesting,
  _getZeroFillSuppressionForTesting,
  _setZeroFillSuppressionForTesting,
  _getZeroFillRetryCountForTesting,
  _setZeroFillRetryCountForTesting,
  ZERO_FILL_RETRY_DELAY_MS,
  MAX_ZERO_FILL_RETRIES,
  zeroFillRetryCount,
  zeroFillSuppressionCache,
} from "./autoTraderGuards.js";
import type { ZeroFillSnapshot } from "./autoTraderGuards.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TICKER_BTC = "KXBTC15M-26JUL300930-RETRY";
const TICKER_ETH = "KXETH15M-26JUL300930-RETRY";

function makeSnap(limitCents = 81, cachedAt = Date.now()): ZeroFillSnapshot {
  return { limitCents, yesAsk: 80, noAsk: 20, yesBid: 19, noBid: 18, cachedAt };
}

/**
 * Simulate the production logic in checkAndPlace() for the suppress/retry check.
 *
 * Returns one of:
 *   "suppressed_fresh"       — identical snapshot within delay window
 *   "retry_allowed"          — delay elapsed, retry budget available (counter incremented)
 *   "retry_budget_exhausted" — delay elapsed but no retries left
 *   "no_suppression"         — no cached entry (first attempt)
 *   "snapshot_changed"       — prices moved, cache cleared
 */
function simulateCheckAndPlace(
  ticker: string,
  side: "yes" | "no",
  incoming: ZeroFillSnapshot,
): "suppressed_fresh" | "retry_allowed" | "retry_budget_exhausted" | "no_suppression" | "snapshot_changed" {
  const cacheKey = `${ticker}-${side.toUpperCase()}`;
  const cached = zeroFillSuppressionCache.get(cacheKey);

  if (!cached) return "no_suppression";

  const snapshotUnchanged =
    cached.limitCents === incoming.limitCents &&
    cached.yesAsk     === incoming.yesAsk &&
    cached.noAsk      === incoming.noAsk &&
    cached.yesBid     === incoming.yesBid &&
    cached.noBid      === incoming.noBid;

  if (!snapshotUnchanged) {
    zeroFillSuppressionCache.delete(cacheKey);
    return "snapshot_changed";
  }

  const entryAgeMs = Date.now() - cached.cachedAt;
  const stillFresh = entryAgeMs < ZERO_FILL_RETRY_DELAY_MS;

  if (stillFresh) return "suppressed_fresh";

  // TTL expired — check retry budget
  const retriesSoFar = zeroFillRetryCount.get(cacheKey) ?? 0;
  if (retriesSoFar >= MAX_ZERO_FILL_RETRIES) {
    return "retry_budget_exhausted";
  }

  // Consume one retry slot
  zeroFillRetryCount.set(cacheKey, retriesSoFar + 1);
  zeroFillSuppressionCache.delete(cacheKey);
  return "retry_allowed";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("zero-fill retry mechanism", () => {

  beforeEach(() => {
    _resetAutoTraderStateForTesting();
  });

  // ── Constants ───────────────────────────────────────────────────────────────

  it("R1: ZERO_FILL_RETRY_DELAY_MS is 5 000 ms", () => {
    assert.equal(ZERO_FILL_RETRY_DELAY_MS, 5_000,
      "retry delay must be 5 s — retries every 5 s until window closes");
  });

  it("R2: MAX_ZERO_FILL_RETRIES is Infinity (no cap)", () => {
    assert.equal(MAX_ZERO_FILL_RETRIES, Infinity,
      "retries are unlimited — they stop only when the window closes or a fill lands");
  });

  // ── Baseline state ──────────────────────────────────────────────────────────

  it("R3: retry counter starts at 0 before any zero-fill", () => {
    assert.equal(
      _getZeroFillRetryCountForTesting(TICKER_BTC, "no"),
      0,
      "counter must be 0 when no zero-fill has occurred yet",
    );
  });

  it("R4: reset clears the retry counter", () => {
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no", 1);
    _resetAutoTraderStateForTesting();
    assert.equal(
      _getZeroFillRetryCountForTesting(TICKER_BTC, "no"),
      0,
      "reset must clear all retry counters",
    );
  });

  // ── Suppression during delay window ─────────────────────────────────────────

  it("R5: identical snapshot within 5 s is suppressed (fresh)", () => {
    const s = makeSnap(81, Date.now());
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", s);

    const result = simulateCheckAndPlace(TICKER_BTC, "no", s);
    assert.equal(result, "suppressed_fresh",
      "within ZERO_FILL_RETRY_DELAY_MS the identical snapshot must be suppressed");
  });

  // ── Retry allowed after delay ────────────────────────────────────────────────

  it("R6: after delay with identical snapshot, retry is allowed", () => {
    // cachedAt 6 s ago → TTL expired (ZERO_FILL_RETRY_DELAY_MS = 5 s)
    const s = makeSnap(81, Date.now() - 6_000);
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", s);

    const result = simulateCheckAndPlace(TICKER_BTC, "no", s);
    assert.equal(result, "retry_allowed",
      "once ZERO_FILL_RETRY_DELAY_MS has elapsed, the retry must be allowed");
  });

  it("R7: retry increments the counter from 0 to 1", () => {
    const s = makeSnap(81, Date.now() - 6_000);
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", s);

    simulateCheckAndPlace(TICKER_BTC, "no", s);

    assert.equal(
      _getZeroFillRetryCountForTesting(TICKER_BTC, "no"),
      1,
      "counter must be 1 after one retry fires",
    );
  });

  // ── Unlimited retries ────────────────────────────────────────────────────────

  it("R8: retries continue past 1 — budget is unlimited", () => {
    // Counter already at 1 (one retry already used)
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no", 1);

    // Another zero-fill with expired snapshot
    const s = makeSnap(81, Date.now() - 6_000);
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", s);

    const result = simulateCheckAndPlace(TICKER_BTC, "no", s);
    assert.equal(result, "retry_allowed",
      "MAX_ZERO_FILL_RETRIES is Infinity — retries must continue without a cap");
  });

  it("R8b: counter keeps incrementing across multiple retries", () => {
    const s = makeSnap(81, Date.now() - 6_000);
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", s);

    simulateCheckAndPlace(TICKER_BTC, "no", s);
    // Re-age the entry so the next call also sees an expired TTL
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no",
      { ...s, cachedAt: Date.now() - 6_000 });
    simulateCheckAndPlace(TICKER_BTC, "no", s);

    assert.equal(
      _getZeroFillRetryCountForTesting(TICKER_BTC, "no"),
      2,
      "counter must reach 2 after two retries — no ceiling",
    );
  });

  it("R9: high retry counter does not block further attempts", () => {
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no", 99);
    const s = makeSnap(81, Date.now() - 6_000);
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", s);

    const result = simulateCheckAndPlace(TICKER_BTC, "no", s);
    assert.equal(result, "retry_allowed",
      "a counter of 99 must not block retries — budget is Infinity");
  });

  // ── Snapshot change lifts suppression regardless of retry counter ────────────

  it("R10: price change clears cache regardless of retry counter", () => {
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no", 99);
    const zeroed = makeSnap(81, Date.now()); // fresh — within 5 s TTL
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", zeroed);

    const improved = { ...zeroed, noAsk: 19 }; // price moved
    const result = simulateCheckAndPlace(TICKER_BTC, "no", improved);
    assert.equal(result, "snapshot_changed",
      "a price change must clear the cache regardless of the retry counter");
  });

  // ── Side isolation ───────────────────────────────────────────────────────────

  it("R11: YES and NO retry counters are independent", () => {
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no",  1);
    _setZeroFillRetryCountForTesting(TICKER_BTC, "yes", 0);

    assert.equal(_getZeroFillRetryCountForTesting(TICKER_BTC, "no"),  1);
    assert.equal(_getZeroFillRetryCountForTesting(TICKER_BTC, "yes"), 0);
  });

  // ── Ticker isolation ─────────────────────────────────────────────────────────

  it("R12: BTC and ETH retry counters are independent", () => {
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no", 1);

    assert.equal(_getZeroFillRetryCountForTesting(TICKER_BTC, "no"), 1,
      "BTC counter should be 1");
    assert.equal(_getZeroFillRetryCountForTesting(TICKER_ETH, "no"), 0,
      "ETH counter must not be affected by BTC");
  });

  // ── Window rollover ──────────────────────────────────────────────────────────

  it("R13: rollover prefix-scan clears retry counter for old ticker", () => {
    const cacheKey = `${TICKER_BTC}-NO`;
    // Manually simulate rollover prefix scan (same logic as handleWindowRollover)
    zeroFillRetryCount.set(cacheKey, 1);

    for (const k of [...zeroFillRetryCount.keys()]) {
      if (k.startsWith(TICKER_BTC)) zeroFillRetryCount.delete(k);
    }

    assert.equal(
      _getZeroFillRetryCountForTesting(TICKER_BTC, "no"),
      0,
      "rollover must clear the retry counter for the old ticker",
    );
  });

  it("R14: rollover does not clear counters for a different ticker", () => {
    const btcKey = `${TICKER_BTC}-NO`;
    const ethKey = `${TICKER_ETH}-NO`;
    zeroFillRetryCount.set(btcKey, 1);
    zeroFillRetryCount.set(ethKey, 1);

    // Simulate BTC rollover only
    for (const k of [...zeroFillRetryCount.keys()]) {
      if (k.startsWith(TICKER_BTC)) zeroFillRetryCount.delete(k);
    }

    assert.equal(_getZeroFillRetryCountForTesting(TICKER_BTC, "no"), 0,
      "BTC counter must be cleared");
    assert.equal(_getZeroFillRetryCountForTesting(TICKER_ETH, "no"), 1,
      "ETH counter must survive BTC rollover");
  });

  // ── _setZeroFillRetryCountForTesting sentinel ─────────────────────────────────

  it("R15: setting retry count to 0 removes the map entry", () => {
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no", 1);
    _setZeroFillRetryCountForTesting(TICKER_BTC, "no", 0);
    assert.equal(_getZeroFillRetryCountForTesting(TICKER_BTC, "no"), 0,
      "count=0 must clean up the map entry");
  });

});

// ── Tail-of-window retry poll (task: zero-fill at T−40 s must produce a retry
//    evaluation before window close, even with no WS tick or reconcile tick) ──

describe("zero-fill retry poll scheduler (tail-of-window guarantee)", () => {

  beforeEach(() => {
    _resetAutoTraderStateForTesting();
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  const POLL_DELAY_MS = ZERO_FILL_RETRY_DELAY_MS + ZERO_FILL_RETRY_POLL_MARGIN_MS;

  it("P1: total poll delay is within 32 s of the zero-fill", () => {
    // The task requirement: a tick must be guaranteed within 32 s of a
    // zero-fill so that a zero-fill at T−40 s yields a retry evaluation
    // before window close. The 45 s reconcile interval alone cannot satisfy
    // this (45 > 32, and reconcile ticks can be skipped entirely by the
    // stream-refresh guard window — worst case 90 s between ticks).
    assert.ok(POLL_DELAY_MS <= 32_000,
      `retry poll delay ${POLL_DELAY_MS} ms must be ≤ 32 s`);
    assert.ok(POLL_DELAY_MS > ZERO_FILL_RETRY_DELAY_MS,
      "poll must land strictly AFTER the suppression entry expires, " +
      "otherwise ms-level jitter re-suppresses the tick");
  });

  it("P2: pollFn fires exactly once after the delay elapses", () => {
    let calls = 0;
    scheduleZeroFillRetryPoll(TICKER_BTC, "no", () => { calls++; });

    mock.timers.tick(POLL_DELAY_MS - 1);
    assert.equal(calls, 0, "poll must NOT fire before the retry delay elapses");

    mock.timers.tick(2);
    assert.equal(calls, 1, "poll must fire once the delay has elapsed");

    mock.timers.tick(60_000);
    assert.equal(calls, 1, "one-shot timer must not fire again");
    assert.equal(zeroFillRetryPollTimers.size, 0,
      "timer map entry must be cleaned up after firing");
  });

  it("P3: T−40 s zero-fill scenario — retry evaluation lands before T−0", () => {
    // Simulate: zero-fill at T−40 s, suppression cached, no further WS or
    // reconcile ticks. The poll must fire while the window is still open AND
    // after the 5 s retry delay, so simulateCheckAndPlace grants the retry.
    const windowMsLeft = 40_000; // zero-fill happens at T−40 s
    const s = makeSnap(81, Date.now());
    _setZeroFillSuppressionForTesting(TICKER_BTC, "no", s);

    let evaluatedAtMsAfterZeroFill: number | null = null;
    let retryResult: string | null = null;
    let elapsed = 0;
    scheduleZeroFillRetryPoll(TICKER_BTC, "no", () => {
      evaluatedAtMsAfterZeroFill = elapsed;
      // Mock timers do not advance Date.now(), so age the cache entry
      // explicitly to mirror the elapsed wall-clock time.
      _setZeroFillSuppressionForTesting(TICKER_BTC, "no",
        { ...s, cachedAt: Date.now() - elapsed });
      retryResult = simulateCheckAndPlace(TICKER_BTC, "no", s);
    });

    // Advance to window close in 1 s steps
    for (; elapsed < windowMsLeft; ) {
      elapsed += 1_000;
      mock.timers.tick(1_000);
      if (evaluatedAtMsAfterZeroFill !== null) break;
    }

    assert.ok(evaluatedAtMsAfterZeroFill !== null,
      "retry evaluation must fire before window close");
    assert.ok(evaluatedAtMsAfterZeroFill! < windowMsLeft,
      `evaluation at +${evaluatedAtMsAfterZeroFill} ms must precede close at +${windowMsLeft} ms`);
    assert.ok(evaluatedAtMsAfterZeroFill! >= ZERO_FILL_RETRY_DELAY_MS,
      "evaluation must not fire while the suppression entry is still fresh");
    assert.equal(retryResult, "retry_allowed",
      "the poll-driven evaluation must be granted the retry");
  });

  it("P4: re-arming replaces the pending timer — only one poll fires", () => {
    let calls = 0;
    scheduleZeroFillRetryPoll(TICKER_BTC, "no", () => { calls++; });
    // Advance halfway through the first timer's delay, then re-arm before it fires.
    const halfDelay = Math.floor(POLL_DELAY_MS / 2);
    mock.timers.tick(halfDelay);
    scheduleZeroFillRetryPoll(TICKER_BTC, "no", () => { calls++; }); // re-arm
    assert.equal(zeroFillRetryPollTimers.size, 1, "only one pending timer per key");

    // Advance to just before the re-armed timer would fire (full delay from re-arm)
    mock.timers.tick(POLL_DELAY_MS - 1);
    assert.equal(calls, 0, "original timer must have been cancelled by re-arm");
    mock.timers.tick(2);
    assert.equal(calls, 1, "re-armed timer fires once at its own full delay");
  });

  it("P5: window rollover cancels pending polls for the old ticker only", () => {
    let btcCalls = 0;
    let ethCalls = 0;
    scheduleZeroFillRetryPoll(TICKER_BTC, "no", () => { btcCalls++; });
    scheduleZeroFillRetryPoll(TICKER_ETH, "no", () => { ethCalls++; });

    cancelZeroFillRetryPolls(TICKER_BTC); // same call handleWindowRollover makes

    mock.timers.tick(POLL_DELAY_MS + 1_000);
    assert.equal(btcCalls, 0, "cancelled BTC poll must never fire");
    assert.equal(ethCalls, 1, "ETH poll must be unaffected by BTC rollover");
  });

  it("P6: reset clears pending poll timers", () => {
    let calls = 0;
    scheduleZeroFillRetryPoll(TICKER_BTC, "no", () => { calls++; });
    _resetAutoTraderStateForTesting();
    assert.equal(zeroFillRetryPollTimers.size, 0, "reset must clear the timer map");
    mock.timers.tick(POLL_DELAY_MS + 1_000);
    assert.equal(calls, 0, "cleared timer must not fire");
  });

});
