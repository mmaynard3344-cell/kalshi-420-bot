import assert from "node:assert/strict";
import test from "node:test";
import {
  _setEth420BootstrapFactsForTesting,
  type Eth420CandidateMarket,
} from "./eth420SixStepCandidate.js";
import {
  _setEthJumpMarketFetcherForTesting,
  prepareEthJumpServiceIntent,
} from "./ethJumpServiceRuntime.js";

function historicalFacts(firstOpenMs: number) {
  const facts: Array<{ ticker: string; openTimeMs: number; floorStrike: number }> = [];
  let strike = 100;
  facts.push({ ticker: "KXETH15M-H0", openTimeMs: firstOpenMs, floorStrike: strike });
  for (let i = 1; i <= 50; i++) {
    strike *= 1 + i / 1000;
    facts.push({ ticker: `KXETH15M-H${i}`, openTimeMs: firstOpenMs + i * 900_000, floorStrike: strike });
  }
  return facts;
}

test("Service B reuses rolling evidence and A side read-only to emit its $420 intent", async () => {
  const firstOpenMs = 1_999_954_800_000;
  const facts = historicalFacts(firstOpenMs);
  _setEth420BootstrapFactsForTesting(facts as any);
  const prior = facts.at(-1)!;
  const currentOpenMs = prior.openTimeMs + 900_000;
  const market: Eth420CandidateMarket = {
    ticker: "KXETH15M-JUMP",
    easternDate: "2033-05-18",
    observedAtMs: currentOpenMs,
    openTimeMs: currentOpenMs,
    floorStrike: prior.floorStrike * 1.048,
  };
  const store: any = {
    getEth420CandidateState: async () => ({
      easternDate: market.easternDate,
      side: "yes",
      step: 4,
      realizedPnlCents: -12_345,
      lastBlockResetAtMs: null,
    }),
    listEth420CandidateTelemetry: async () => [],
  };
  try {
    const intent = await prepareEthJumpServiceIntent({ store, market, role: "jump" });
    assert.equal(intent?.strategy, "jump");
    assert.equal(intent?.side, "yes");
    assert.equal(intent?.wagerCents, 42_000);
    assert.equal(intent?.ticker, market.ticker);
  } finally {
    _setEth420BootstrapFactsForTesting(null);
    _setEthJumpMarketFetcherForTesting(null);
  }
});

test("Service B recovers a missing current move directly from exact adjacent Kalshi markets", async () => {
  const firstOpenMs = 1_999_954_800_000;
  const facts = historicalFacts(firstOpenMs);
  _setEth420BootstrapFactsForTesting(facts as any);
  const prior = facts.at(-1)!;
  const currentOpenMs = prior.openTimeMs + 900_000;
  const currentStrike = prior.floorStrike * 1.048;
  const market: Eth420CandidateMarket = {
    ticker: "KXETH15M-DIRECT-JUMP",
    easternDate: "2033-05-18",
    observedAtMs: currentOpenMs,
    openTimeMs: currentOpenMs,
    floorStrike: null,
  };
  const store: any = {
    getEth420CandidateState: async () => ({
      easternDate: market.easternDate,
      side: "no",
      step: 2,
      realizedPnlCents: 0,
      lastBlockResetAtMs: null,
    }),
    listEth420CandidateTelemetry: async () => [],
  };
  const calls: string[] = [];
  _setEthJumpMarketFetcherForTesting((async (path: string) => {
    calls.push(path);
    if (path === `/markets/${market.ticker}`) {
      return { market: {
        ticker: market.ticker,
        open_time: new Date(currentOpenMs).toISOString(),
        floor_strike: currentStrike,
      } };
    }
    if (path === "/markets") {
      return { markets: [{
        ticker: prior.ticker,
        open_time: new Date(prior.openTimeMs).toISOString(),
        floor_strike: prior.floorStrike,
        status: "finalized",
      }] };
    }
    throw new Error(`unexpected path ${path}`);
  }) as any);

  try {
    let observedMove: number | null = null;
    const intent = await prepareEthJumpServiceIntent({
      store,
      market,
      role: "jump",
      onEvaluation: (observation) => { observedMove = observation.currentMove; },
    });
    assert.equal(intent?.strategy, "jump");
    assert.equal(intent?.side, "no");
    assert.equal(intent?.wagerCents, 42_000);
    assert.ok(observedMove != null && Math.abs(observedMove - 0.048) < 1e-12);
    assert.deepEqual(calls, [`/markets/${market.ticker}`, "/markets"]);
  } finally {
    _setEth420BootstrapFactsForTesting(null);
    _setEthJumpMarketFetcherForTesting(null);
  }
});

test("a non-jump runtime cannot evaluate Service B and performs no evidence reads", async () => {
  let reads = 0;
  const store: any = {
    getEth420CandidateState: async () => { reads++; return null; },
    listEth420CandidateTelemetry: async () => { reads++; return []; },
  };
  const result = await prepareEthJumpServiceIntent({
    store,
    role: "martingale",
    market: {
      ticker: "KXETH15M-BLOCKED", easternDate: "2026-09-05", observedAtMs: 1_800_000,
      openTimeMs: 1_800_000, floorStrike: 100,
    },
  });
  assert.equal(result, null);
  assert.equal(reads, 0);
});
