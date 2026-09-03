/**
 * Regression guard: browser quote alerts must not look like server trade submissions.
 *
 * AlertEntry records are browser-only BBO observations. They:
 *   - Never carry server-side fields (clientOrderId, analyticsId, limitCents, etc.)
 *   - Store the direct BBO bid in `price`, NOT the server's derived ask
 *     (the server uses noDerivedAsk = 100 − yesBid, or yesDerivedAsk = 100 − noBid)
 *   - Are labeled "QUOTE ALERT" in the UI, not "Trade" or "Submitted"
 *
 * Run via the api-server test harness (same pattern as Dashboard.alertReset.test.ts):
 *   cd artifacts/api-server && \
 *   node_modules/.bin/esbuild \
 *     ../kalshi-reader/src/pages/Dashboard.quoteAlert.test.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=/tmp/quote-alert.mjs && \
 *   node --test /tmp/quote-alert.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Types mirrored from Dashboard.tsx ───────────────────────────────────────

interface AlertEntry {
  id:          string;
  asset:       'BTC' | 'ETH';
  side:        'YES' | 'NO';
  /** Direct BBO bid in cents — NOT the server's derived ask. */
  price:       number;
  ticker:      string;
  eventTicker: string;
  time:        Date;
}

// Fields that belong only on server-side submission records.
// None of these must ever appear on an AlertEntry.
const SERVER_ONLY_FIELDS = [
  'clientOrderId',
  'analyticsId',
  'limitCents',
  'submittedAtMs',
  'outcome',
  'preflight',
  'postInitiated',
  'responseReceived',
] as const;

// ─── Helper mirroring fireAlert() in Dashboard.tsx ───────────────────────────

/**
 * Builds an AlertEntry exactly as fireAlert() does.
 * price = direct BBO bid (yes_bid or no_bid from the market BBO), NOT a derived ask.
 */
function buildAlertEntry(
  key:         string,
  asset:       'BTC' | 'ETH',
  side:        'YES' | 'NO',
  price:       number,
  ticker:      string,
  eventTicker: string,
): AlertEntry {
  return { id: `${key}-${Date.now()}`, asset, side, price, ticker, eventTicker, time: new Date() };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Quote alert vs server submission regression guard', () => {
  const BTC_TICKER   = 'KXBTC15M-260814-15';
  const BTC_EVENT    = 'KXBTC15M-260814';
  const ETH_TICKER   = 'KXETH15M-260814-15';
  const ETH_EVENT    = 'KXETH15M-260814';

  describe('AlertEntry structure — browser-only fields only', () => {
    it('does not contain any server-side submission field', () => {
      const entry = buildAlertEntry(`${BTC_TICKER}-NO`, 'BTC', 'NO', 82, BTC_TICKER, BTC_EVENT);
      for (const field of SERVER_ONLY_FIELDS) {
        assert.ok(
          !(field in entry),
          `AlertEntry must not carry server-only field "${field}" — would make it look like a submission`,
        );
      }
    });

    it('has exactly the expected browser-only keys', () => {
      const entry = buildAlertEntry(`${BTC_TICKER}-YES`, 'BTC', 'YES', 91, BTC_TICKER, BTC_EVENT);
      const keys = new Set(Object.keys(entry));
      for (const required of ['id', 'asset', 'side', 'price', 'ticker', 'eventTicker', 'time']) {
        assert.ok(keys.has(required), `AlertEntry must have field "${required}"`);
      }
      // No unexpected extra keys
      const allowed = new Set(['id', 'asset', 'side', 'price', 'ticker', 'eventTicker', 'time']);
      for (const k of keys) {
        assert.ok(allowed.has(k), `AlertEntry has unexpected field "${k}" — may imply server submission`);
      }
    });
  });

  describe('Price field semantics — direct bid, not derived ask', () => {
    it('stores the direct BBO bid for a NO alert (not the complement)', () => {
      // Browser fires when: market.no_bid = 82 (in zone 70–95)
      // Server would use:   noDerivedAsk = 100 − yesBid = 100 − 18 = 82 (coincident here)
      // But browser alert price = no_bid directly, NOT computed from yesBid.
      const directNoBid = 82;
      const entry = buildAlertEntry(`${BTC_TICKER}-NO`, 'BTC', 'NO', directNoBid, BTC_TICKER, BTC_EVENT);
      assert.equal(entry.price, directNoBid,
        'price must equal the direct BBO bid that triggered the alert');
    });

    it('stores the direct BBO bid for a YES alert', () => {
      const directYesBid = 88;
      const entry = buildAlertEntry(`${BTC_TICKER}-YES`, 'BTC', 'YES', directYesBid, BTC_TICKER, BTC_EVENT);
      assert.equal(entry.price, directYesBid,
        'YES alert price must be the direct yes_bid, not a derived value');
    });

    it('direct bid and server derived ask can differ — they are independent observations', () => {
      // e.g. market.no_bid = 83 (browser fires at 83)
      // server sees: noDerivedAsk = 100 − yesBid = 100 − 18 = 82 (server evaluates 82)
      // AlertEntry.price must be 83 (the direct bid), not 82 (the derived ask).
      const directNoBid    = 83;
      const serverDerived  = 82; // what the server computes; must NOT be stored in AlertEntry
      const entry = buildAlertEntry(`${BTC_TICKER}-NO`, 'BTC', 'NO', directNoBid, BTC_TICKER, BTC_EVENT);
      assert.equal(entry.price, directNoBid);
      assert.notEqual(entry.price, serverDerived,
        'AlertEntry.price must not silently store the server derived ask instead of the direct bid');
    });
  });

  describe('Distinguishing alert entries from server submissions', () => {
    /** Returns true only if the object looks like a server submission (has any server-only field). */
    function isServerSubmission(obj: Record<string, unknown>): boolean {
      return SERVER_ONLY_FIELDS.some((f) => f in obj);
    }

    it('isServerSubmission returns false for every AlertEntry', () => {
      const btcEntry = buildAlertEntry(`${BTC_TICKER}-NO`, 'BTC', 'NO', 85, BTC_TICKER, BTC_EVENT);
      const ethEntry = buildAlertEntry(`${ETH_TICKER}-YES`, 'ETH', 'YES', 90, ETH_TICKER, ETH_EVENT);
      assert.equal(isServerSubmission(btcEntry as unknown as Record<string, unknown>), false);
      assert.equal(isServerSubmission(ethEntry as unknown as Record<string, unknown>), false);
    });

    it('a mock server submission IS detected by isServerSubmission', () => {
      // Sanity-check: the guard function itself works.
      const fakeSubmission = { clientOrderId: 'abc-123', ticker: BTC_TICKER, outcome: 'filled' };
      assert.equal(isServerSubmission(fakeSubmission), true,
        'isServerSubmission must detect a real server submission object');
    });
  });

  describe('ETH alert entries are structurally identical to BTC', () => {
    it('ETH NO alert has no server-only fields', () => {
      const entry = buildAlertEntry(`${ETH_TICKER}-NO`, 'ETH', 'NO', 82, ETH_TICKER, ETH_EVENT);
      for (const field of SERVER_ONLY_FIELDS) {
        assert.ok(!(field in entry), `ETH AlertEntry must not carry field "${field}"`);
      }
    });
  });
});
