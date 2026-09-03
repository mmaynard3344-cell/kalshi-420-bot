/**
 * Integration-level tests for the target-liquidity adaptive polling loop.
 *
 * Tests exercise startTargetLiquidityLoop directly with mocked fetch and
 * setTimeout — no React, no DOM — so the actual loop code is under test,
 * not a parallel simulation of it.
 *
 * Key assertions:
 *   1. An initially open report → first scheduled timeout is 15 000 ms.
 *   2. A closed-then-open transition → timeout becomes 15 000 ms on the
 *      poll that first discovers the open position.
 *   3. A fetch error preserves the prior open-state (no downgrade to 30 s).
 *   4. Closed positions → 30 000 ms interval throughout.
 *
 * Run via the api-server test harness:
 *   cd artifacts/api-server && \
 *   node_modules/.bin/esbuild \
 *     ../kalshi-reader/src/pages/Dashboard.targetLiquidityPoll.test.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=/tmp/tl-poll.mjs && \
 *   node --test /tmp/tl-poll.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTargetLiquidityLoop,
  reportHasOpen,
  TARGET_LIQUIDITY_FAST_INTERVAL_MS,
  TARGET_LIQUIDITY_NORMAL_INTERVAL_MS,
  type TLReport,
} from '../lib/targetLiquidityPoller.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a mock fetch that returns the given per-poll responses in order.
 * Each entry covers one poll (Promise.all with eth30 + sol30 URLs).
 * Separate counters are kept per URL pattern so eth30 and sol30 each
 * advance on their own poll index — preventing the single-counter bug
 * where the second URL fetch consumes the next poll's entry.
 */
function makeFetch(
  ...polls: Array<{ eth30: TLReport | null; sol30: TLReport | null } | 'error'>
): (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> {
  let eth30Poll = 0;
  let sol30Poll = 0;
  return async (url: string) => {
    const isEth = url.includes('eth30');
    const idx = isEth ? eth30Poll++ : sol30Poll++;
    const resp = polls[Math.min(idx, polls.length - 1)];
    if (resp === 'error') throw new Error('simulated fetch error');
    const report = isEth ? resp.eth30 : resp.sol30;
    if (!report) return { ok: false, json: async () => null };
    return { ok: true, json: async () => report };
  };
}

const OPEN_REPORT: TLReport = {
  positions: [{ openContracts: 3, classification: 'never_reached_target' }],
};
const CLOSED_REPORT: TLReport = {
  positions: [{ openContracts: 0, classification: 'target_filled' }],
};
const EMPTY_REPORT: TLReport = { positions: [] };

// ─── reportHasOpen unit tests ─────────────────────────────────────────────────

describe('reportHasOpen', () => {
  it('returns false for null', () => {
    assert.equal(reportHasOpen(null), false);
  });
  it('returns false for empty positions', () => {
    assert.equal(reportHasOpen(EMPTY_REPORT), false);
  });
  it('returns false when openContracts is 0', () => {
    assert.equal(
      reportHasOpen({ positions: [{ openContracts: 0, classification: 'never_reached_target' }] }),
      false,
    );
  });
  it('returns false when classification is target_filled even with open contracts', () => {
    assert.equal(
      reportHasOpen({ positions: [{ openContracts: 5, classification: 'target_filled' }] }),
      false,
    );
  });
  it('returns true for an active open position', () => {
    assert.equal(reportHasOpen(OPEN_REPORT), true);
  });
  it('returns true when only one of several positions is open', () => {
    assert.equal(
      reportHasOpen({
        positions: [
          { openContracts: 0, classification: 'target_filled' },
          { openContracts: 2, classification: 'insufficient_depth' },
        ],
      }),
      true,
    );
  });
});

// ─── startTargetLiquidityLoop integration tests ───────────────────────────────

describe('startTargetLiquidityLoop — startup sequencing', () => {
  it('schedules FAST interval after the initial fetch discovers an open position', async () => {
    const scheduledIntervals: number[] = [];

    const stop = startTargetLiquidityLoop({
      fetchFn: makeFetch({ eth30: OPEN_REPORT, sol30: EMPTY_REPORT }),
      scheduleTimeout: (_cb, delay) => scheduledIntervals.push(delay),
      onEth30: () => {},
      onSol30: () => {},
    });

    // Allow the initial async fetch to complete.
    await new Promise((r) => setImmediate(r));
    stop();

    assert.equal(
      scheduledIntervals.length,
      1,
      'exactly one timeout should have been scheduled after the initial fetch',
    );
    assert.equal(
      scheduledIntervals[0],
      TARGET_LIQUIDITY_FAST_INTERVAL_MS,
      'first timeout must be 15 000 ms when an open position is found on the first poll',
    );
  });

  it('schedules NORMAL interval when no open positions on first poll', async () => {
    const scheduledIntervals: number[] = [];

    const stop = startTargetLiquidityLoop({
      fetchFn: makeFetch({ eth30: CLOSED_REPORT, sol30: CLOSED_REPORT }),
      scheduleTimeout: (_cb, delay) => scheduledIntervals.push(delay),
      onEth30: () => {},
      onSol30: () => {},
    });

    await new Promise((r) => setImmediate(r));
    stop();

    assert.equal(scheduledIntervals[0], TARGET_LIQUIDITY_NORMAL_INTERVAL_MS);
  });

  it('schedules NORMAL interval when both reports are absent (fetch returns not-ok)', async () => {
    const scheduledIntervals: number[] = [];

    const stop = startTargetLiquidityLoop({
      fetchFn: makeFetch({ eth30: null, sol30: null }),
      scheduleTimeout: (_cb, delay) => scheduledIntervals.push(delay),
      onEth30: () => {},
      onSol30: () => {},
    });

    await new Promise((r) => setImmediate(r));
    stop();

    assert.equal(scheduledIntervals[0], TARGET_LIQUIDITY_NORMAL_INTERVAL_MS);
  });
});

describe('startTargetLiquidityLoop — closed-to-open transition', () => {
  it('switches to FAST on the poll that first discovers an open position', async () => {
    const scheduledIntervals: number[] = [];

    // Use a real (but minimal) setTimeout so the second poll can actually fire.
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleTimeout = (cb: () => void, delay: number) => {
      scheduledIntervals.push(delay);
      // Only let the first timer fire to trigger the second poll.
      const id = setTimeout(cb, 0);
      pendingTimers.push(id);
      return id;
    };

    const stop = startTargetLiquidityLoop({
      // Poll 1 → closed; Poll 2 → open
      fetchFn: makeFetch(
        { eth30: CLOSED_REPORT, sol30: CLOSED_REPORT },
        { eth30: OPEN_REPORT,   sol30: CLOSED_REPORT },
      ),
      scheduleTimeout,
      onEth30: () => {},
      onSol30: () => {},
    });

    // Wait for both async fetch+schedule cycles to complete.
    await new Promise((r) => setTimeout(r, 20));
    stop();
    for (const id of pendingTimers) clearTimeout(id);

    assert.ok(scheduledIntervals.length >= 2, 'at least two timeouts should have been scheduled');
    assert.equal(scheduledIntervals[0], TARGET_LIQUIDITY_NORMAL_INTERVAL_MS, 'first poll: no open → 30 s');
    assert.equal(scheduledIntervals[1], TARGET_LIQUIDITY_FAST_INTERVAL_MS,   'second poll: open found → 15 s');
  });
});

describe('startTargetLiquidityLoop — error resilience', () => {
  it('preserves the FAST interval when a fetch error follows an open-position poll', async () => {
    const scheduledIntervals: number[] = [];

    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleTimeout = (cb: () => void, delay: number) => {
      scheduledIntervals.push(delay);
      const id = setTimeout(cb, 0);
      pendingTimers.push(id);
      return id;
    };

    const stop = startTargetLiquidityLoop({
      // Poll 1 → open position found; Poll 2 → fetch throws
      fetchFn: makeFetch(
        { eth30: OPEN_REPORT, sol30: EMPTY_REPORT },
        'error',
      ),
      scheduleTimeout,
      onEth30: () => {},
      onSol30: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    stop();
    for (const id of pendingTimers) clearTimeout(id);

    assert.ok(scheduledIntervals.length >= 2, 'two timeouts should have been scheduled');
    assert.equal(scheduledIntervals[0], TARGET_LIQUIDITY_FAST_INTERVAL_MS,  'first poll: open → 15 s');
    assert.equal(scheduledIntervals[1], TARGET_LIQUIDITY_FAST_INTERVAL_MS,  'error poll must NOT downgrade to 30 s');
  });

  it('uses NORMAL interval when an error occurs with no prior open-state', async () => {
    const scheduledIntervals: number[] = [];

    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleTimeout = (cb: () => void, delay: number) => {
      scheduledIntervals.push(delay);
      const id = setTimeout(cb, 0);
      pendingTimers.push(id);
      return id;
    };

    const stop = startTargetLiquidityLoop({
      fetchFn: makeFetch('error', { eth30: CLOSED_REPORT, sol30: CLOSED_REPORT }),
      scheduleTimeout,
      onEth30: () => {},
      onSol30: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    stop();
    for (const id of pendingTimers) clearTimeout(id);

    assert.ok(scheduledIntervals.length >= 1);
    assert.equal(scheduledIntervals[0], TARGET_LIQUIDITY_NORMAL_INTERVAL_MS, 'error with no prior open-state → 30 s');
  });
});

describe('startTargetLiquidityLoop — per-endpoint HTTP failure (ok: false)', () => {
  // fetch() resolves normally for 4xx/5xx — the loop must treat ok:false as
  // "no new data for this endpoint" and preserve that endpoint's prior open-state.

  it('preserves FAST interval when eth30 returns ok:false after previously reporting open', async () => {
    const scheduledIntervals: number[] = [];

    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleTimeout = (cb: () => void, delay: number) => {
      scheduledIntervals.push(delay);
      const id = setTimeout(cb, 0);
      pendingTimers.push(id);
      return id;
    };

    // Poll 1: eth30=open, sol30=closed → FAST scheduled
    // Poll 2: eth30=ok:false (server error), sol30=closed → FAST must be preserved
    const eth30Polls: Array<TLReport | null> = [OPEN_REPORT, null];   // null → ok:false
    const sol30Polls: Array<TLReport | null> = [CLOSED_REPORT, CLOSED_REPORT];
    let eth30i = 0, sol30i = 0;

    const stop = startTargetLiquidityLoop({
      fetchFn: async (url) => {
        if (url.includes('eth30')) {
          const r = eth30Polls[Math.min(eth30i++, eth30Polls.length - 1)];
          if (!r) return { ok: false, json: async () => null };
          return { ok: true, json: async () => r };
        } else {
          const r = sol30Polls[Math.min(sol30i++, sol30Polls.length - 1)];
          if (!r) return { ok: false, json: async () => null };
          return { ok: true, json: async () => r };
        }
      },
      scheduleTimeout,
      onEth30: () => {},
      onSol30: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    stop();
    for (const id of pendingTimers) clearTimeout(id);

    assert.ok(scheduledIntervals.length >= 2, 'two timeouts should have been scheduled');
    assert.equal(scheduledIntervals[0], TARGET_LIQUIDITY_FAST_INTERVAL_MS,  'poll 1: open eth30 → 15 s');
    assert.equal(
      scheduledIntervals[1],
      TARGET_LIQUIDITY_FAST_INTERVAL_MS,
      'poll 2: eth30 ok:false must preserve prior open-state → still 15 s',
    );
  });

  it('preserves FAST interval when sol30 returns ok:false after previously reporting open', async () => {
    const scheduledIntervals: number[] = [];

    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleTimeout = (cb: () => void, delay: number) => {
      scheduledIntervals.push(delay);
      const id = setTimeout(cb, 0);
      pendingTimers.push(id);
      return id;
    };

    const eth30Polls: Array<TLReport | null> = [CLOSED_REPORT, CLOSED_REPORT];
    const sol30Polls: Array<TLReport | null> = [OPEN_REPORT, null];  // null → ok:false on poll 2
    let eth30i = 0, sol30i = 0;

    const stop = startTargetLiquidityLoop({
      fetchFn: async (url) => {
        if (url.includes('eth30')) {
          const r = eth30Polls[Math.min(eth30i++, eth30Polls.length - 1)];
          if (!r) return { ok: false, json: async () => null };
          return { ok: true, json: async () => r };
        } else {
          const r = sol30Polls[Math.min(sol30i++, sol30Polls.length - 1)];
          if (!r) return { ok: false, json: async () => null };
          return { ok: true, json: async () => r };
        }
      },
      scheduleTimeout,
      onEth30: () => {},
      onSol30: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    stop();
    for (const id of pendingTimers) clearTimeout(id);

    assert.ok(scheduledIntervals.length >= 2);
    assert.equal(scheduledIntervals[0], TARGET_LIQUIDITY_FAST_INTERVAL_MS,  'poll 1: open sol30 → 15 s');
    assert.equal(
      scheduledIntervals[1],
      TARGET_LIQUIDITY_FAST_INTERVAL_MS,
      'poll 2: sol30 ok:false must not downgrade to 30 s',
    );
  });
});

describe('startTargetLiquidityLoop — callbacks', () => {
  it('calls onEth30 and onSol30 with parsed reports', async () => {
    const eth30Received: TLReport[] = [];
    const sol30Received: TLReport[] = [];

    const stop = startTargetLiquidityLoop({
      fetchFn: makeFetch({ eth30: OPEN_REPORT, sol30: CLOSED_REPORT }),
      scheduleTimeout: () => {},
      onEth30: (r) => eth30Received.push(r),
      onSol30: (r) => sol30Received.push(r),
    });

    await new Promise((r) => setImmediate(r));
    stop();

    assert.equal(eth30Received.length, 1);
    assert.deepEqual(eth30Received[0], OPEN_REPORT);
    assert.equal(sol30Received.length, 1);
    assert.deepEqual(sol30Received[0], CLOSED_REPORT);
  });

  it('does not call onEth30 / onSol30 after stop() is called', async () => {
    const called: string[] = [];

    const stop = startTargetLiquidityLoop({
      fetchFn: async (url) => {
        // Pause long enough for stop() to fire before json() resolves.
        await new Promise((r) => setTimeout(r, 5));
        return {
          ok: true,
          json: async () => (url.includes('eth30') ? OPEN_REPORT : CLOSED_REPORT),
        };
      },
      scheduleTimeout: () => {},
      onEth30: () => called.push('eth30'),
      onSol30: () => called.push('sol30'),
    });

    // Stop before the fetch has time to complete.
    stop();

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(called.length, 0, 'callbacks must not fire after stop()');
  });
});
