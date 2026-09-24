import assert from "node:assert/strict";
import test from "node:test";
import {
  KRAKEN_ETH_OHLC_URL,
  fetchKrakenEth15mCandles,
  isContiguousFinalizedEth15m,
  parseKrakenEth15mPayload,
  parseKrakenEth15mRow,
  selectContiguousPriorCandles,
} from "./krakenEth15mCandles.js";
import { ETH_15M_MS } from "./sweepReclaimV1.js";

const t0 = Date.UTC(2026, 8, 24, 10, 0, 0);

function wire(openMs: number, o = 100, h = 110, l = 90, c = 105) {
  return [openMs / 1000, String(o), String(h), String(l), String(c), "101", "10", "5"];
}

test("parses only fully finalized 15-minute Kraken rows", () => {
  const row = parseKrakenEth15mRow(wire(t0), t0 + ETH_15M_MS);
  assert.equal(row?.openTimeMs, t0);
  assert.equal(row?.closeTimeMs, t0 + ETH_15M_MS);
  assert.equal(row?.finalized, true);
  assert.equal(parseKrakenEth15mRow(wire(t0 + ETH_15M_MS), t0 + ETH_15M_MS), null);
});

test("rejects malformed and impossible OHLC rows", () => {
  assert.equal(parseKrakenEth15mRow(["bad"], t0 + ETH_15M_MS), null);
  assert.equal(parseKrakenEth15mRow(wire(t0, 100, 90, 95, 100), t0 + ETH_15M_MS), null);
  assert.equal(parseKrakenEth15mRow(wire(t0 + 1, 100, 110, 90, 105), t0 + ETH_15M_MS + 1), null);
});

test("payload parser ignores last cursor, deduplicates, and sorts", () => {
  const payload = {
    error: [],
    result: {
      XETHZUSD: [wire(t0 + ETH_15M_MS), wire(t0), wire(t0)],
      last: "0",
    },
  };
  const rows = parseKrakenEth15mPayload(payload, t0 + 2 * ETH_15M_MS);
  assert.deepEqual(rows.map((x) => x.openTimeMs), [t0, t0 + ETH_15M_MS]);
});

test("contiguous selector fails closed on gaps and exact boundary mismatch", () => {
  const candles = [0, 1, 2].map((i) => ({
    openTimeMs: t0 + i * ETH_15M_MS,
    closeTimeMs: t0 + (i + 1) * ETH_15M_MS,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    finalized: true,
  }));
  assert.equal(isContiguousFinalizedEth15m(candles), true);
  assert.equal(selectContiguousPriorCandles(candles, t0 + 3 * ETH_15M_MS, 3)?.length, 3);
  const gap = [candles[0]!, candles[2]!];
  assert.equal(isContiguousFinalizedEth15m(gap), false);
  assert.equal(selectContiguousPriorCandles(gap, t0 + 3 * ETH_15M_MS, 2), null);
  assert.equal(selectContiguousPriorCandles(candles, t0 + 4 * ETH_15M_MS, 3), null);
});

test("fetcher uses canonical endpoint and excludes trailing in-progress candle", async () => {
  let seenUrl = "";
  const fakeFetch = (async (url: string | URL | Request) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({
      error: [],
      result: {
        XETHZUSD: [wire(t0), wire(t0 + ETH_15M_MS)],
        last: "0",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const batch = await fetchKrakenEth15mCandles(t0 + ETH_15M_MS, fakeFetch);
  assert.equal(seenUrl, KRAKEN_ETH_OHLC_URL);
  assert.equal(batch.source, "kraken");
  assert.deepEqual(batch.candles.map((x) => x.openTimeMs), [t0]);
});
