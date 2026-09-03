import assert from "node:assert/strict";
import test from "node:test";
import { selectNearestFutureUnopenedMarket } from "./kalshi.js";

const nowMs = Date.parse("2026-08-30T12:45:00.000Z");

function market(ticker: string, openTime: string): Record<string, unknown> {
  return { ticker, open_time: openTime };
}

test("selectNearestFutureUnopenedMarket chooses the nearest future ETH window regardless of API order", () => {
  const selected = selectNearestFutureUnopenedMarket([
    market("KXETH15M-26AUG310000-00", "2026-08-31T03:45:00Z"),
    market("KXETH15M-26AUG300930-30", "2026-08-30T13:15:00Z"),
    market("KXETH15M-26AUG300915-15", "2026-08-30T13:00:00Z"),
    market("KXETH15M-26AUG300900-00", "2026-08-30T12:45:30Z"),
  ], nowMs);

  assert.equal(selected?.["ticker"], "KXETH15M-26AUG300900-00");
});

test("selectNearestFutureUnopenedMarket ignores invalid and already-past entries", () => {
  const selected = selectNearestFutureUnopenedMarket([
    market("KXETH15M-invalid", "not-a-date"),
    market("KXETH15M-26AUG300900-00", "2026-08-30T12:44:59.999Z"),
    market("KXETH15M-26AUG300915-15", "2026-08-30T13:00:00Z"),
    market("KXETH15M-26AUG300930-30", "2026-08-30T13:15:00Z"),
  ], nowMs);

  assert.equal(selected?.["ticker"], "KXETH15M-26AUG300915-15");
});