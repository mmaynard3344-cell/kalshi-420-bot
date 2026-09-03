import assert from "node:assert/strict";
import test from "node:test";
import { fetchCompleteEth15mSettledHistory } from "./kalshi.js";
import { eth420MovesFromFacts } from "./strategies/eth420SixStepCandidate.js";

const interval = 900_000;
const currentOpen = Date.parse("2026-08-30T13:00:00.000Z");
const start = currentOpen - 28 * 86_400_000 - interval;
const market = (openTimeMs: number, floorStrike = 100, ticker = `KXETH15M-${openTimeMs}`) => ({
  ticker, status: "finalized", open_time: new Date(openTimeMs).toISOString(), floor_strike: floorStrike,
});
const completeMarkets = () => Array.from({ length: 28 * 96 + 1 }, (_, index) =>
  market(start + index * interval, 100 + index));

test("settled ETH history requires complete paginated coverage and rejects cursor loops", async () => {
  const complete = await fetchCompleteEth15mSettledHistory(currentOpen, async ({ cursor }) =>
    cursor ? { markets: completeMarkets() } : { markets: [market(currentOpen - interval, 100 + 28 * 96)], cursor: "older" });
  assert.equal(complete?.length, 28 * 96 + 1);
  const incomplete = await fetchCompleteEth15mSettledHistory(currentOpen, async () =>
    ({ markets: [market(currentOpen - interval)], cursor: "" }));
  assert.equal(incomplete, null);
  const missingExactPredecessor = await fetchCompleteEth15mSettledHistory(currentOpen, async () =>
    ({ markets: [market(start - interval, 98), market(currentOpen - interval, 101)], cursor: "" }));
  assert.equal(missingExactPredecessor, null);
  const loop = await fetchCompleteEth15mSettledHistory(currentOpen, async () =>
    ({ markets: [market(currentOpen - interval)], cursor: "same" }));
  assert.equal(loop, null);
});

test("settled ETH history excludes invalid rows, current markets, and conflicting duplicates", async () => {
  const accepted = await fetchCompleteEth15mSettledHistory(currentOpen, async () => ({
    markets: [
      ...completeMarkets(), market(currentOpen, 102),
      { ...market(currentOpen - 2 * interval), floor_strike: 0 },
    ],
  }));
  assert.equal(accepted?.length, 28 * 96 + 1);
  const conflict = await fetchCompleteEth15mSettledHistory(currentOpen, async () => ({
    markets: [...completeMarkets(), market(start, 98, "KXETH15M-duplicate"), market(start, 99, "KXETH15M-duplicate")],
  }));
  assert.equal(conflict, null);
  const internalGap = await fetchCompleteEth15mSettledHistory(currentOpen, async () => ({
    markets: completeMarkets().filter((row) => Date.parse(row.open_time) !== start + 400 * interval),
  }));
  assert.equal(internalGap?.length, 28 * 96);
  assert.equal(eth420MovesFromFacts(internalGap!.map((fact) => ({ ...fact, source: "bootstrap" as const }))).length, 28 * 96 - 2);
  const invalidStrike = await fetchCompleteEth15mSettledHistory(currentOpen, async () => ({
    markets: completeMarkets().map((row) =>
      Date.parse(row.open_time) === start + 800 * interval ? { ...row, floor_strike: 0 } : row),
  }));
  assert.equal(invalidStrike?.length, 28 * 96);
  assert.equal(eth420MovesFromFacts(invalidStrike!.map((fact) => ({ ...fact, source: "bootstrap" as const }))).length, 28 * 96 - 2);
  const invalidPredecessor = await fetchCompleteEth15mSettledHistory(currentOpen, async () => ({
    markets: completeMarkets().map((row) => Date.parse(row.open_time) === start ? { ...row, floor_strike: 0 } : row),
  }));
  assert.equal(invalidPredecessor?.length, 28 * 96);
  assert.equal(eth420MovesFromFacts(invalidPredecessor!.map((fact) => ({ ...fact, source: "bootstrap" as const }))).length, 28 * 96 - 1);
});

test("settled ETH history fails closed for malformed page payloads", async () => {
  const malformedRows = await fetchCompleteEth15mSettledHistory(currentOpen, async () =>
    ({ markets: [{ ticker: "KXETH15M-bad" } as any], cursor: null }));
  assert.equal(malformedRows, null);
  const malformedPage = await fetchCompleteEth15mSettledHistory(currentOpen, async () =>
    ({ cursor: null } as any));
  assert.equal(malformedPage, null);
  const transportFailure = await fetchCompleteEth15mSettledHistory(currentOpen, async () => {
    throw new Error("network unavailable");
  });
  assert.equal(transportFailure, null);
  const mixedMalformed = await fetchCompleteEth15mSettledHistory(currentOpen, async () => ({
    markets: [...completeMarkets(), { ...market(start + interval, 100), open_time: "not-a-time" }],
  }));
  assert.equal(mixedMalformed, null);
});