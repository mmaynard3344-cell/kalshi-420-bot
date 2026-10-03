import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluatePortfolio, evaluateStrategy, evaluateL, evaluateJ, buildEvidence, ORDER_EXECUTION_ENABLED, WINDOW_MS } from "./signals.mjs";
import { publicJson, selectCurrent, parseFact, parseCandles, bootstrapHistory, PUBLIC_BASE } from "./client.mjs";

const start = 1_800_000_000_000;
const baseline = { signedMove: -0.004, absoluteMove: 0.004, noStreak: 3, outcomes: ["no", "no", "yes"],
  p80: 0.001, p90: 0.002, p95: 0.003, p99: 0.005, historyCount: 200 };
function fixture() {
  const history = []; let floorStrike = 60_000;
  for (let i = 0; i <= 250; i++) {
    if (i > 0) floorStrike *= 1 + i / 100_000;
    const openTimeMs = start + i * WINDOW_MS;
    history.push({ ticker: `KXBTC15M-H${i}`, openTimeMs, floorStrike, finalized: true,
      finalizedAtMs: openTimeMs + WINDOW_MS, result: i === 247 ? "yes" : "no" });
  }
  const prior = history.at(-1);
  return { history, market: { ticker: "KXBTC15M-CURRENT", openTimeMs: prior.openTimeMs + WINDOW_MS,
    observedAtMs: prior.openTimeMs + WINDOW_MS + 10_000, floorStrike: prior.floorStrike * 1.00242 } };
}
test("all BTC strategies evaluate at $5 with orders hard-disabled; B stays YES", () => {
  for (const sign of [1, -1]) {
    const input = fixture(); input.market.floorStrike = input.history.at(-1).floorStrike * (1 + sign * .00242);
    const rows = evaluatePortfolio(input);
    assert.equal(rows.length, 11);
    assert.deepEqual(rows.map((r) => r.service), ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]);
    assert.ok(rows.every((r) => r.stakeCents === 500 && r.ordersEnabled === false && r.mode === "shadow"));
    assert.equal(rows.find((r) => r.service === "B").side, "yes");
    assert.equal(rows.find((r) => r.service === "J").reason, "no_btc_a_order");
    assert.equal(rows.find((r) => r.service === "K").reason, "weather_service_excluded_from_btc");
  }
  process.env.TRADING_ENABLED = "true";
  assert.equal(ORDER_EXECUTION_ENABLED, false);
  delete process.env.TRADING_ENABLED;
});
test("C requires three prior NO outcomes and D requires upper-half jump band", () => {
  assert.equal(evaluateStrategy("C", baseline).fires, true);
  assert.equal(evaluateStrategy("C", { ...baseline, noStreak: 2 }).fires, false);
  assert.equal(evaluateStrategy("D", baseline).fires, true);
  assert.equal(evaluateStrategy("D", { ...baseline, absoluteMove: 0.0039 }).fires, false);
  assert.equal(evaluateStrategy("D", { ...baseline, absoluteMove: 0.005 }).fires, false);
});
test("E and F keep their distinct downward percentile bands", () => {
  assert.equal(evaluateStrategy("E", { ...baseline, absoluteMove: 0.001 }).fires, true);
  assert.equal(evaluateStrategy("E", { ...baseline, absoluteMove: 0.002 }).fires, false);
  assert.equal(evaluateStrategy("F", { ...baseline, absoluteMove: 0.002 }).fires, true);
  assert.equal(evaluateStrategy("F", { ...baseline, absoluteMove: 0.003 }).fires, false);
  assert.equal(evaluateStrategy("E", { ...baseline, signedMove: .0015, absoluteMove: .0015 }).fires, false);
});
test("G reverses exactly two, excluding three consecutive equal outcomes", () => {
  assert.equal(evaluateStrategy("G", baseline).side, "yes");
  assert.equal(evaluateStrategy("G", { ...baseline, outcomes: ["yes", "yes", "no"] }).side, "no");
  assert.equal(evaluateStrategy("G", { ...baseline, outcomes: ["no", "no", "no"] }).fires, false);
  assert.equal(evaluateStrategy("G", { ...baseline, outcomes: ["no", "no", null] }).fires, false);
});
test("H and I preserve their percentage thresholds and directions", () => {
  assert.equal(evaluateStrategy("H", { ...baseline, signedMove: -.007 }).side, "yes");
  assert.equal(evaluateStrategy("H", { ...baseline, signedMove: -.0095 }).fires, false);
  assert.equal(evaluateStrategy("I", { ...baseline, signedMove: -.006 }).side, "yes");
  assert.equal(evaluateStrategy("I", { ...baseline, signedMove: -.0099 }).fires, false);
  assert.equal(evaluateStrategy("I", { ...baseline, signedMove: .005 }).side, "no");
  assert.equal(evaluateStrategy("I", { ...baseline, signedMove: .008 }).fires, false);
});
test("J requires verified same-ticker paper A and the zero-fill/depth/price condition", () => {
  const market = fixture().market;
  const a = { ticker: market.ticker, service: "A", mode: "paper", verified: true, side: "yes", fillCount: 0, status: "resting" };
  const quote = { yesAskCents: 60, yesDepthAt50: 0 };
  assert.equal(evaluateJ(a, market, quote).fires, true);
  for (const patch of [{ ticker: "KXETH15M-OLD" }, { fillCount: 1 }, { verified: false }, { mode: "live" }])
    assert.equal(evaluateJ({ ...a, ...patch }, market, quote).fires, false);
  assert.equal(evaluateJ(a, market, { yesAskCents: 91, yesDepthAt50: 0 }).fires, false);
});
test("L uses completed trigger candle and 96 contiguous prior candles, excluding source", () => {
  const prior = Array.from({ length: 96 }, (_, i) => ({ openTimeMs: start + i * WINDOW_MS,
    closeTimeMs: start + (i + 1) * WINDOW_MS, open: 101, high: 102, low: 99, close: 101, finalized: true }));
  const source = { openTimeMs: start + 96 * WINDOW_MS, closeTimeMs: start + 97 * WINDOW_MS,
    open: 101, high: 103, low: 97, close: 102, finalized: true };
  const result = evaluateL(source, prior, source.closeTimeMs);
  assert.equal(result.fires, true); assert.equal(result.evidence.prior24hLow, 99);
  assert.equal(evaluateL({ ...source, finalized: false }, prior, source.closeTimeMs).fires, false);
  assert.equal(evaluateL(source, prior.slice(1), source.closeTimeMs).fires, false);
  assert.equal(evaluateL(source, prior, source.closeTimeMs + WINDOW_MS).fires, false);
  assert.equal(evaluateL({ ...source, low: 100 }, prior, source.closeTimeMs).fires, false);
});
test("BTC evidence excludes ETH, current, future-known, unfinished and nonadjacent history", () => {
  const input = fixture(), baseline = buildEvidence(input.market, input.history);
  const extra = [ { ...input.history[0], ticker: "KXETH15M-POISON", floorStrike: 1 },
    { ...input.history[1], ticker: "KXBTC15M-POISON", finalized: false },
    { ...input.history[2], ticker: "KXBTC15M-FUTURE", finalizedAtMs: input.market.observedAtMs + 1 },
    { ...input.history[3], ticker: "KXBTC15M-CURRENT", openTimeMs: input.market.openTimeMs } ];
  assert.deepEqual(buildEvidence(input.market, [...input.history, ...extra]), baseline);
  assert.throws(() => buildEvidence(input.market, [...input.history, { ...input.history[1], floorStrike: 1 }]), /conflicting/);
  input.history.splice(100, 1);
  assert.equal(buildEvidence(input.market, input.history).historyCount, 248);
});
test("current market discovery rejects future and ambiguous windows", () => {
  const row = { ticker: "KXBTC15M-CURRENT", status: "active", open_time: new Date(start).toISOString(),
    close_time: new Date(start + WINDOW_MS).toISOString(), floor_strike: 60000 };
  assert.ok(selectCurrent([row], start + 1));
  assert.equal(selectCurrent([row, row], start + 1), null);
  assert.equal(selectCurrent([row], start - 1), null);
  assert.equal(selectCurrent([row], start + WINDOW_MS), null);
});
test("fact parser requires authoritative finalization and result", () => {
  const row = { ticker: "KXBTC15M-H", status: "finalized", open_time: new Date(start).toISOString(),
    floor_strike: 60000, settlement_ts: new Date(start + WINDOW_MS + 1000).toISOString(), result: "yes" };
  assert.ok(parseFact(row));
  assert.equal(parseFact({ ...row, result: "" }), null);
  assert.equal(parseFact({ ...row, ticker: "KXETH15M-H" }), null);
});
test("Kraken source excludes unfinished candles and ambiguous payloads", () => {
  const rows = [[start / 1000, "100", "102", "99", "101"], [(start + WINDOW_MS) / 1000, "101", "103", "100", "102"]];
  assert.equal(parseCandles({ error: [], result: { XXBTZUSD: rows, last: 1 } }, start + WINDOW_MS + 1).length, 1);
  assert.throws(() => parseCandles({ error: ["failure"] }, start), /kraken/);
});
test("public data client has only allowlisted unsigned GETs and rejects order/account endpoints", async () => {
  let calls = 0;
  const fetcher = async (url, opts) => { calls++; assert.equal(opts.method, "GET"); assert.equal(opts.headers, undefined); return { ok: true, json: async () => ({ markets: [] }) }; };
  await publicJson(`${PUBLIC_BASE}/markets?series_ticker=KXBTC15M`, fetcher);
  for (const url of ["http://api.elections.kalshi.com/trade-api/v2/markets", `${PUBLIC_BASE}/portfolio/orders`, "https://example.com/markets"])
    await assert.rejects(() => publicJson(url, fetcher), /unapproved/);
  assert.equal(calls, 1);
});
test("bootstrap rejects incomplete rolling history instead of trading on a truncated catalog", async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ markets: [], cursor: "" }) });
  await assert.rejects(() => bootstrapHistory(start + WINDOW_MS, fetcher), /incomplete_28_day/);
});
test("deployed import graph cannot use authenticated order clients or database state", () => {
  for (const name of ["index.mjs", "client.mjs", "signals.mjs", "btcJumpSignal.mjs"]) {
    const source = fs.readFileSync(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /kalshiAuthFetch|createSign|KALSHI_PRIVATE_KEY|DATABASE_URL|portfolio\/orders|eth420_candidate/);
  }
});
