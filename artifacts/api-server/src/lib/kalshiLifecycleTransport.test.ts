import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _clearAutoTraderTestOverrides,
  _onEthMarketLifecycleForTesting,
  _resetAutoTraderStateForTesting,
  _setEvaluateEthNoMartingaleForTesting,
  _setKalshiSeriesFetchForTesting,
  _restFetchAllForTesting,
} from "./autoTrader.js";
import {
  KALSHI_ETH_WINDOW_MS,
  KALSHI_HTTP_PREWARM_LEAD_MS,
  _setKalshiAuthPrewarmRequestForTesting,
  nextKalshiAuthPrewarmAtMs,
  prewarmKalshiAuthTransport,
} from "./kalshiAuth.js";
import {
  buildKalshiSubscriptionPayloads,
  KALSHI_WS_URL,
  parseEthMarketLifecycle,
  type KalshiMarketLifecycleEvent,
} from "./kalshiStream.js";

const openMs = Date.UTC(2026, 8, 1, 12, 15, 0);
const lifecycle = (eventType: "created" | "activated"): KalshiMarketLifecycleEvent => ({
  ticker: "KXETH15M-26SEP011215-15",
  eventType,
  openTime: new Date(openMs).toISOString(),
  closeTime: new Date(openMs + KALSHI_ETH_WINDOW_MS).toISOString(),
  exchangeIndex: 0,
  floorStrike: 100_000,
});
const activeMarket = {
  ticker: "KXETH15M-26SEP011215-15",
  status: "open",
  open_time: new Date(openMs).toISOString(),
  close_time: new Date(openMs + KALSHI_ETH_WINDOW_MS).toISOString(),
  exchange_index: 0,
  floor_strike: 100_000,
  yes_bid: 28, yes_ask: 32, no_bid: 68, no_ask: 72,
};

describe("ETH lifecycle transport", () => {
  beforeEach(() => {
    _resetAutoTraderStateForTesting();
    _clearAutoTraderTestOverrides();
  });
  afterEach(() => {
    _setKalshiAuthPrewarmRequestForTesting(null);
    _clearAutoTraderTestOverrides();
  });

  it("parses only valid ETH created/activated lifecycle messages", () => {
    assert.deepEqual(parseEthMarketLifecycle({
      market_ticker: lifecycle("created").ticker, event_type: "created",
      open_ts: openMs / 1_000, close_ts: (openMs + KALSHI_ETH_WINDOW_MS) / 1_000,
      exchange_index: 0, additional_metadata: { floor_strike: 100_000 },
    }), lifecycle("created"));
    assert.equal(parseEthMarketLifecycle({
      market_ticker: "KXBTC15M-26SEP011215-15", event_type: "activated", open_ts: openMs / 1_000,
    }), null);
  });

  it("pre-registers created without evaluating, then immediately evaluates the verified activation", async () => {
    let fetches = 0;
    const evaluated: string[] = [];
    _setKalshiSeriesFetchForTesting(async () => { fetches++; return activeMarket; });
    _setEvaluateEthNoMartingaleForTesting(async ({ ticker }) => { evaluated.push(ticker); });
    _onEthMarketLifecycleForTesting(lifecycle("created"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 0, "created must never evaluate or fetch an orderable market");
    _onEthMarketLifecycleForTesting(lifecycle("activated"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1);
    assert.deepEqual(evaluated, [activeMarket.ticker]);
  });

  it("suppresses duplicate activated events while the first lifecycle handoff is in flight", async () => {
    let resolveFetch!: (value: typeof activeMarket) => void;
    let fetches = 0;
    _setKalshiSeriesFetchForTesting(() => {
      fetches++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    });
    _onEthMarketLifecycleForTesting(lifecycle("activated"));
    _onEthMarketLifecycleForTesting(lifecycle("activated"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1);
    resolveFetch(activeMarket);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("retains the ETH-only REST fallback path", async () => {
    const fetched: string[] = [];
    _setKalshiSeriesFetchForTesting(async (series) => { fetched.push(series); return null; });
    await _restFetchAllForTesting("rest_fallback");
    assert.deepEqual(fetched, ["KXETH15M"]);
  });

  it("uses the dedicated host and includes lifecycle on every subscription construction", () => {
    assert.equal(KALSHI_WS_URL, "wss://external-api-ws.kalshi.com/trade-api/ws/v2");
    const first = buildKalshiSubscriptionPayloads(["KXETH15M-A"], 5);
    const reconnect = buildKalshiSubscriptionPayloads(["KXETH15M-B"], 7);
    assert.deepEqual(first[1].params.channels, ["market_lifecycle_v2"]);
    assert.deepEqual(reconnect[1].params.channels, ["market_lifecycle_v2"]);
    assert.deepEqual(reconnect[0].params.market_tickers, ["KXETH15M-B"]);
  });

  it("pre-warms through one non-blocking authenticated balance read at every quarter-boundary minus five seconds", async () => {
    const hour = Date.UTC(2026, 8, 1, 12, 0, 0);
    for (const minutes of [14, 29, 44, 59]) {
      const expected = hour + minutes * 60_000 + 55_000;
      assert.equal(nextKalshiAuthPrewarmAtMs(expected - 1), expected);
    }
    let calls = 0;
    _setKalshiAuthPrewarmRequestForTesting(async () => { calls++; });
    prewarmKalshiAuthTransport();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(KALSHI_HTTP_PREWARM_LEAD_MS, 5_000);
  });
});