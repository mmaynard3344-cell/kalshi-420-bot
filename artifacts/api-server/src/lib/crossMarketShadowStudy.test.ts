import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import {
  CROSS_MARKET_SHADOW_STUDY_VERSION,
  CROSS_MARKET_MIN_P95_HISTORY,
  _resetCrossMarketShadowForTesting,
  assetFromCrossMarketTicker,
  causalCompletedReturns,
  classifyPriorWindowCandidateSides,
  frozenBaselineYesProbability,
  isCrossMarketShadowEnabled,
  observeCrossMarketShadowStudy,
  percentile,
  refreshCrossMarketShadowSettlement,
  type CrossMarketShadowStore,
  type ShadowObservationRow,
  type ShadowEventRow,
} from "./crossMarketShadowStudy.js";

afterEach(() => {
  delete process.env["CROSS_MARKET_SHADOW_ENABLED"];
  _resetCrossMarketShadowForTesting();
});

function memoryStore(seed: ShadowObservationRow[] = []) {
  const observations = [...seed];
  const events: ShadowEventRow[] = [];
  const store: CrossMarketShadowStore = {
    insertEth30ShadowObservation: async (row) => {
      if (observations.some((old) => old.id === row.id)) return false;
      observations.push(row); return true;
    },
    listEth30ShadowObservations: async (ticker, afterMs = 0) =>
      observations.filter((row) => row.ticker === ticker && row.observedAtMs >= afterMs).sort((a,b)=>a.observedAtMs-b.observedAtMs),
    listCrossMarketShadowAnchors: async (asset, beforeMs, limit = 500) =>
      observations.filter((row) => row.observedAtMs < beforeMs && row.ticker.startsWith(asset === "BTC" ? "KXBTC15M-" : "KXETH15M-"))
        .filter((row) => {
          try {
            const p = JSON.parse(row.payloadJson);
            return p.studyVersion === CROSS_MARKET_SHADOW_STUDY_VERSION && p.observationKind === "open_anchor";
          } catch { return false; }
        }).sort((a,b)=>a.observedAtMs-b.observedAtMs).slice(-limit),
    listEth30ShadowEvents: async (ticker) => events.filter((row) => row.ticker === ticker),
    upsertEth30ShadowEvent: async (row) => {
      const i = events.findIndex((old) => old.id === row.id);
      if (i >= 0) events[i] = row; else events.push(row);
    },
  };
  return { store, observations, events };
}

function anchor(asset: "BTC"|"ETH", n: number, price: number): ShadowObservationRow {
  const openTimeMs = 1_000_000 + n * 900_000;
  const ticker = `KX${asset}15M-anchor-${n}`;
  return {
    id: `${ticker}:anchor`, ticker, observedAtMs: openTimeMs + 1_000,
    payloadJson: JSON.stringify({
      label: "SHADOW_ONLY_NOT_EXECUTED", studyVersion: CROSS_MARKET_SHADOW_STUDY_VERSION,
      observationKind: "open_anchor", anchorQuality: "on_time", openTimeMs, referencePrice: price,
    }),
  };
}

test("disabled by default and exact BTC/ETH ticker filtering", () => {
  assert.equal(isCrossMarketShadowEnabled({}), false);
  assert.equal(isCrossMarketShadowEnabled({ CROSS_MARKET_SHADOW_ENABLED: "true" }), true);
  assert.equal(assetFromCrossMarketTicker("KXBTC15M-x"), "BTC");
  assert.equal(assetFromCrossMarketTicker("KXETH15M-x"), "ETH");
  assert.equal(assetFromCrossMarketTicker("KXSOL15M-x"), null);
});

test("p95 burn-in is frozen at 200 valid adjacent returns", () => {
  const at199 = Array.from({ length: 199 }, () => .001).concat(.02).slice(0, 199);
  const at200 = Array.from({ length: 199 }, () => .001).concat(.02);
  const before = classifyPriorWindowCandidateSides({ completedReturns: at199, comparisonOperator: ">=" });
  const ready = classifyPriorWindowCandidateSides({ completedReturns: at200, comparisonOperator: ">=" });
  assert.equal(CROSS_MARKET_MIN_P95_HISTORY, 200);
  assert.equal(before.p95, null);
  assert.equal(before.reversalSide, null);
  assert.equal(before.continuationSide, null);
  assert.ok(ready.p95 != null);
  assert.equal(ready.continuationSide, "yes");
  assert.equal(ready.reversalSide, "no");
});

test("non-adjacent anchor gaps do not count toward the p95 history", () => {
  const rows = Array.from({ length: 202 }, (_, i) => anchor("BTC", i, 100 * Math.pow(1.001, i)));
  const gapPayload = JSON.parse(rows[101]!.payloadJson);
  gapPayload.openTimeMs += 60_000;
  rows[101] = { ...rows[101]!, payloadJson: JSON.stringify(gapPayload) };
  const returns = causalCompletedReturns(rows);
  assert.equal(returns.length, 199, "both returns touching the broken adjacency are excluded");
  const eligibility = classifyPriorWindowCandidateSides({ completedReturns: returns, comparisonOperator: ">=" });
  assert.equal(eligibility.p95, null);
});

test("frozen baseline is deterministic and moves with distance to target", () => {
  const history = Array.from({ length: 96 }, (_, i) => (i % 2 ? .005 : -.005));
  const at = frozenBaselineYesProbability({ referencePrice: 100, floorStrike: 100, comparisonOperator: ">=", completedReturns: history });
  const above = frozenBaselineYesProbability({ referencePrice: 101, floorStrike: 100, comparisonOperator: ">=", completedReturns: history });
  assert.ok(at != null && Math.abs(at - .5) < .001);
  assert.ok(above != null && above > at!);
});

test("checkpoint capture deduplicates and remains shadow-only", async () => {
  process.env["CROSS_MARKET_SHADOW_ENABLED"] = "true";
  const seed = Array.from({ length: 202 }, (_, i) => anchor("BTC", i, 100 + i * .01));
  const { store, observations } = memoryStore(seed);
  const openMs = 1_000_000 + 202 * 900_000;
  seed.push(anchor("BTC", 202, 102.02));
  const input = {
    ticker: "KXBTC15M-live", openTime: new Date(openMs).toISOString(), closeTime: new Date(openMs + 900_000).toISOString(),
    floorStrike: 102, comparisonOperator: ">=" as const, yesBid: 49, yesAsk: 51, noBid: 49, noAsk: 51,
    quoteUpdatedAtMs: openMs + 29_000, observedAtMs: openMs + 30_000,
  };
  const deps = {
    store,
    getReference: async () => ({ price: 102.1, sourceTimestampMs: openMs + 30_000 }),
    getVisibleDepth: async () => ({ bestAskCents: 51, depthContracts: 10 }),
  };
  await Promise.all([observeCrossMarketShadowStudy(deps, input), observeCrossMarketShadowStudy(deps, input)]);
  const captured = observations.filter((row) => row.id.includes(":cp:30"));
  assert.equal(captured.length, 1);
  const payload = JSON.parse(captured[0]!.payloadJson);
  assert.equal(payload.label, "SHADOW_ONLY_NOT_EXECUTED");
});

test("non-durable false insert releases checkpoint dedupe so a later observation can retry", async () => {
  process.env["CROSS_MARKET_SHADOW_ENABLED"] = "true";
  const openMs = 1_000_000;
  let insertAttempts = 0;
  const observations: ShadowObservationRow[] = [];
  const store: CrossMarketShadowStore = {
    insertEth30ShadowObservation: async (row) => {
      insertAttempts++;
      if (insertAttempts === 1) return false;
      observations.push(row);
      return true;
    },
    listEth30ShadowObservations: async () => observations,
    listCrossMarketShadowAnchors: async () => [],
    listEth30ShadowEvents: async () => [],
    upsertEth30ShadowEvent: async () => {},
  };
  const deps = {
    store,
    getReference: async () => ({ price: 100, sourceTimestampMs: openMs + 30_000 }),
    getVisibleDepth: async () => ({ bestAskCents: 50, depthContracts: 1 }),
  };
  const input = {
    ticker: "KXBTC15M-retry", openTime: new Date(openMs).toISOString(), closeTime: new Date(openMs + 900_000).toISOString(),
    floorStrike: 100, comparisonOperator: ">=" as const, yesBid: 49, yesAsk: 51, noBid: 49, noAsk: 51,
    quoteUpdatedAtMs: openMs + 30_000, observedAtMs: openMs + 30_000,
  };
  await observeCrossMarketShadowStudy(deps, input);
  await observeCrossMarketShadowStudy(deps, input);
  assert.equal(insertAttempts, 2);
  assert.equal(observations.length, 1);
});

test("settlement projection is appended only from authoritative result input", async () => {
  const ticker = "KXETH15M-settle";
  const checkpoint: ShadowObservationRow = {
    id: `${ticker}:cp`, ticker, observedAtMs: 100,
    payloadJson: JSON.stringify({
      studyVersion: CROSS_MARKET_SHADOW_STUDY_VERSION, observationKind: "checkpoint",
      candidateSides: { reversal_candidate: "yes", continuation_candidate: null, dislocation_candidate: null },
      modeledEntryPriceCents: { yes: 40, no: 60 },
    }),
  };
  const { store, observations } = memoryStore([checkpoint]);
  assert.equal(observations.some((row) => row.id.endsWith(":settlement")), false);
  await refreshCrossMarketShadowSettlement(store, ticker, "yes", 999);
  const projection = observations.find((row) => row.id.endsWith(":settlement"));
  assert.ok(projection);
  const payload = JSON.parse(projection!.payloadJson);
  assert.equal(payload.authoritativeSettlementResult, "yes");
  assert.equal(payload.observationKind, "settlement_projection");
  assert.ok(payload.modeledOneContractNetReturnCents.reversal_candidate > 0);
});

test("AutoTrader attaches the study at raw mergeState boundary, not evaluate cadence", () => {
  const source = readFileSync(`${process.cwd()}/src/lib/autoTrader.ts`, "utf8");
  const mergeStart = source.indexOf("function mergeState(");
  const evaluateStart = source.indexOf("async function evaluate(");
  const hook = source.indexOf("observeCrossMarketShadowStudy(", mergeStart);
  assert.ok(mergeStart >= 0 && hook > mergeStart);
  assert.ok(evaluateStart < 0 || hook < evaluateStart, "shadow hook must be registered in mergeState before evaluate");
});

test("module imports no execution, auth, claim, reservation, or order-placement dependencies", () => {
  const source = readFileSync(`${process.cwd()}/src/lib/crossMarketShadowStudy.ts`, "utf8");
  const importLines = source.split("\n").filter((line) => /^import\s/.test(line.trim())).join("\n");
  assert.doesNotMatch(importLines, /autoTrader|kalshiAuth|orderbookCapture|routes\/trade|protectiveExit|placeOrder|claim|reserve/i);
});
