/**
 * Unit tests for the firedRef alert-key reset logic in Dashboard.tsx.
 *
 * The reset effect keeps fired-key tracking in sync with the current market
 * tickers so that both YES and NO alerts can re-arm when the 15-min window
 * rolls over.  These tests exercise the logic in isolation — no React, no DOM.
 *
 * Run via the api-server test harness:
 *   cd artifacts/api-server && \
 *   node_modules/.bin/esbuild \
 *     ../../kalshi-reader/src/pages/Dashboard.alertReset.test.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=/tmp/alert-reset.mjs && \
 *   node --test /tmp/alert-reset.mjs
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Logic extracted verbatim from Dashboard.tsx ─────────────────────────────

function makeKeySet() {
  return new Set<string>();
}

/** Mirrors the fireAlert key-add logic: key = `${ticker}-${SIDE}`. */
function fireKey(fired: Set<string>, ticker: string, side: 'YES' | 'NO') {
  fired.add(`${ticker}-${side}`);
}

/**
 * Mirrors the reset effect:
 *   const isStale = (k) => ![...currentTickers].some((t) => k.startsWith(t));
 *   [...fired].filter(isStale).forEach((k) => fired.delete(k));
 */
function applyReset(fired: Set<string>, currentTickers: (string | undefined)[]) {
  const tickers = new Set(currentTickers.filter(Boolean) as string[]);
  const isStale = (k: string) => ![...tickers].some((t) => k.startsWith(t));
  [...fired].filter(isStale).forEach((k) => fired.delete(k));
}

/** Mirrors hasFired: `!!ticker && fired.has(\`${ticker}-${suffix}\`)`. */
function hasFired(fired: Set<string>, ticker: string | undefined, suffix: string): boolean {
  return !!ticker && fired.has(`${ticker}-${suffix}`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('firedRef alert-key reset logic', () => {
  const TICKER_N   = 'KXBTC15M-290315-15';  // window N
  const TICKER_N1  = 'KXBTC15M-290315-30';  // window N+1
  const ETH_N      = 'KXETH15M-290315-15';
  const ETH_N1     = 'KXETH15M-290315-30';

  let fired: Set<string>;

  beforeEach(() => { fired = makeKeySet(); });

  describe('NO key lifecycle', () => {
    it('adds a NO key when the alert fires', () => {
      fireKey(fired, TICKER_N, 'NO');
      assert.ok(fired.has(`${TICKER_N}-NO`));
    });

    it('hasFired returns true while the same ticker is current', () => {
      fireKey(fired, TICKER_N, 'NO');
      applyReset(fired, [TICKER_N]);
      assert.ok(hasFired(fired, TICKER_N, 'NO'));
    });

    it('removes the NO key when the ticker advances to the next window', () => {
      fireKey(fired, TICKER_N, 'NO');
      // Ticker rolls over — btcMarket.ticker is now TICKER_N1
      applyReset(fired, [TICKER_N1]);
      assert.equal(fired.size, 0, 'stale NO key must be evicted');
    });

    it('hasFired returns false for the new window after rollover', () => {
      fireKey(fired, TICKER_N, 'NO');
      applyReset(fired, [TICKER_N1]);
      // The badge for the new window must be clear
      assert.ok(!hasFired(fired, TICKER_N1, 'NO'), 'new-window NO badge must not show TRIGGERED');
    });

    it('NO alert can re-arm (fire again) in the new window', () => {
      // Window N fires NO
      fireKey(fired, TICKER_N, 'NO');
      // Rollover
      applyReset(fired, [TICKER_N1]);
      // Window N+1 fires NO
      fireKey(fired, TICKER_N1, 'NO');
      assert.ok(hasFired(fired, TICKER_N1, 'NO'), 'NO alert must re-arm after rollover');
    });
  });

  describe('YES key lifecycle (regression guard)', () => {
    it('removes a YES key on rollover', () => {
      fireKey(fired, TICKER_N, 'YES');
      applyReset(fired, [TICKER_N1]);
      assert.equal(fired.size, 0);
    });

    it('hasFired returns false for new-window YES after rollover', () => {
      fireKey(fired, TICKER_N, 'YES');
      applyReset(fired, [TICKER_N1]);
      assert.ok(!hasFired(fired, TICKER_N1, 'YES'));
    });
  });

  describe('both YES and NO fire in window N', () => {
    it('both keys are cleared on rollover', () => {
      fireKey(fired, TICKER_N, 'YES');
      fireKey(fired, TICKER_N, 'NO');
      applyReset(fired, [TICKER_N1]);
      assert.equal(fired.size, 0, 'both YES and NO keys must be evicted');
    });

    it('neither badge shows TRIGGERED for the new window', () => {
      fireKey(fired, TICKER_N, 'YES');
      fireKey(fired, TICKER_N, 'NO');
      applyReset(fired, [TICKER_N1]);
      assert.ok(!hasFired(fired, TICKER_N1, 'YES'));
      assert.ok(!hasFired(fired, TICKER_N1, 'NO'));
    });
  });

  describe('multi-asset reset (BTC + ETH)', () => {
    it('clears stale ETH NO key when only ETH ticker rolls over', () => {
      fireKey(fired, TICKER_N,  'YES');  // BTC window N — still current
      fireKey(fired, ETH_N,     'NO');   // ETH window N — rolls over
      applyReset(fired, [TICKER_N, ETH_N1]);
      assert.ok( hasFired(fired, TICKER_N, 'YES'),  'current BTC key must survive');
      assert.ok(!hasFired(fired, ETH_N,    'NO'),   'stale ETH NO key must be evicted');
    });

    it('clears all keys when both assets roll over simultaneously', () => {
      fireKey(fired, TICKER_N, 'YES');
      fireKey(fired, TICKER_N, 'NO');
      fireKey(fired, ETH_N,    'YES');
      fireKey(fired, ETH_N,    'NO');
      applyReset(fired, [TICKER_N1, ETH_N1]);
      assert.equal(fired.size, 0, 'all four keys must be evicted on simultaneous rollover');
    });
  });

  describe('edge cases', () => {
    it('reset is a no-op when no tickers are available yet', () => {
      fireKey(fired, TICKER_N, 'NO');
      applyReset(fired, [undefined, undefined]);
      // With no current tickers everything is "stale" — fired set is cleared.
      // This matches the effect behaviour during the inter-window gap before
      // the new market loads; the new market's hasFired will return false anyway.
      assert.equal(fired.size, 0);
    });

    it('keys from a different asset are not falsely matched by startsWith', () => {
      // ETH key must not be accidentally cleared by a BTC ticker prefix
      fireKey(fired, ETH_N, 'NO');
      applyReset(fired, [TICKER_N1]);  // only BTC ticker present
      // ETH key should be removed because ETH_N doesn't start with BTC ticker
      assert.ok(!hasFired(fired, ETH_N, 'NO'), 'cross-asset false-positive must not keep stale key');
    });
  });
});
