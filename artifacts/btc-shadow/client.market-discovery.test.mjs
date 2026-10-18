import test from "node:test";
import assert from "node:assert/strict";
import { selectCurrent } from "./client.mjs";

const WINDOW = 15 * 60_000;
const start = Date.parse("2026-10-18T18:00:00Z");
const market = (overrides = {}) => ({
  ticker: "KXBTC15M-26OCT181815-15",
  status: "active",
  open_time: new Date(start - 2 * WINDOW).toISOString(),
  close_time: new Date(start + WINDOW).toISOString(),
  floor_strike: 68420,
  ...overrides,
});

test("accepts active 15-minute window when Kalshi opens trading early", () => {
  assert.deepEqual(selectCurrent([market()], start + 60_000), {
    ticker: market().ticker,
    floorStrike: 68420,
    openTimeMs: start,
    observedAtMs: start + 60_000,
  });
});
test("does not trade before the outcome window opens", () => {
  assert.equal(selectCurrent([market()], start - 1), null);
});
test("does not trade at or after close", () => {
  assert.equal(selectCurrent([market()], start + WINDOW), null);
});
test("fails closed on multiple eligible markets", () => {
  assert.equal(selectCurrent([market(), market({ ticker: "KXBTC15M-OTHER" })], start + 1), null);
});
test("fails closed on missing, zero, and malformed floor strike", () => {
  for (const floor_strike of [null, undefined, "", 0, -1, "not-a-price"]) {
    assert.equal(selectCurrent([market({ floor_strike })], start + 1), null);
  }
});
test("fails closed on malformed or nonaligned close time", () => {
  assert.equal(selectCurrent([market({ close_time: "not-a-time" })], start + 1), null);
  assert.equal(selectCurrent([market({ close_time: new Date(start + WINDOW + 1).toISOString() })], start + 1), null);
});
test("fails closed on wrong status, invalid ticker, and listing not yet open", () => {
  assert.equal(selectCurrent([market({ status: "closed" })], start + 1), null);
  assert.equal(selectCurrent([market({ ticker: "KXETH15M-TEST" })], start + 1), null);
  assert.equal(selectCurrent([market({ open_time: new Date(start + 60_000).toISOString() })], start + 1), null);
});
test("selects the right interval from a list of future-open markets", () => {
  assert.equal(selectCurrent([market({close_time: new Date(start + 2 * WINDOW).toISOString(), ticker:"KXBTC15M-NEXT"}), market()], start + 1)?.ticker, market().ticker);
});
