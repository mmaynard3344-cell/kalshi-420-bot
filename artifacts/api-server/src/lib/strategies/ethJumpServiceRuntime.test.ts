import assert from "node:assert/strict";
import test from "node:test";
import {
  _setEth420BootstrapFactsForTesting,
  type Eth420CandidateMarket,
} from "./eth420SixStepCandidate.js";
import { ETH_JUMP_WAGER_CENTS } from "./ethJumpSignal.js";
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

function qualifyingFixture(candidateSide: "yes" | "no" = "yes") {
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
      side: candidateSide,
      step: 4,
      realizedPnlCents: -12_345,
      lastBlockResetAtMs: null,
    }),
    listEth420CandidateTelemetry: async () => [],
  };
  return { facts, prior, currentOpenMs, market, store };
}

function aStateFor(market: Eth420CandidateMarket, side: "yes" | "no") {
  return {
    easternDate: market.easternDate,
    side,
    martingaleStep: 0,
    spentCents: 0,
    realizedPnlCents: 0,
  };
}

function cleanup(): void {
  _setEth420BootstrapFactsForTesting(null);
  _setEthJumpMarketFetcherForTesting(null);
}

test("Service B qualifying Jump follows a fresh authoritative A YES side", async () => {
  const { market, store } = qualifyingFixture("yes");
  try {
    let reads = 0;
    const intent = await prepareEthJumpServiceIntent({
      store,
      market,
      role: "jump",
      readMartingaleState: async () => { reads++; return aStateFor(market, "yes"); },
    });
    assert.equal(reads, 1);
    assert.equal(intent?.strategy, "jump");
    assert.equal(intent?.side, "yes");
    assert.equal(intent?.wagerCents, ETH_JUMP_WAGER_CENTS);
    assert.equal(intent?.ticker, market.ticker);
  } finally {
    cleanup();
  }
});

test("Service B qualifying Jump follows a fresh authoritative A NO side", async () => {
  const { market, store } = qualifyingFixture("yes");
  try {
    const intent = await prepareEthJumpServiceIntent({
      store,
      market,
      role: "jump",
      readMartingaleState: async () => aStateFor(market, "no"),
    });
    assert.equal(intent?.strategy, "jump");
    assert.equal(intent?.side, "no");
    assert.equal(intent?.wagerCents, ETH_JUMP_WAGER_CENTS);
  } finally {
    cleanup();
  }
});

test("Service B fails closed when authoritative A state is missing", async () => {
  const { market, store } = qualifyingFixture("yes");
  try {
    let rejectionReason: string | null = null;
    const intent = await prepareEthJumpServiceIntent({
      store,
      market,
      role: "jump",
      readMartingaleState: async () => null,
      onEvaluation: (observation) => { rejectionReason = observation.rejectionReason; },
    });
    assert.equal(intent, null);
    assert.equal(rejectionReason, "martingale_side_unavailable");
  } finally {
    cleanup();
  }
});

test("Service B fails closed when authoritative A state read throws", async () => {
  const { market, store } = qualifyingFixture("yes");
  try {
    let rejectionReason: string | null = null;
    const intent = await prepareEthJumpServiceIntent({
      store,
      market,
      role: "jump",
      readMartingaleState: async () => { throw new Error("durable read unavailable"); },
      onEvaluation: (observation) => { rejectionReason = observation.rejectionReason; },
    });
    assert.equal(intent, null);
    assert.equal(rejectionReason, "martingale_side_unavailable");
  } finally {
    cleanup();
  }
});

test("regression: candidate NO cannot override authoritative A YES", async () => {
  const { market, store } = qualifyingFixture("no");
  try {
    const intent = await prepareEthJumpServiceIntent({
      store,
      market,
      role: "jump",
      readMartingaleState: async () => aStateFor(market, "yes"),
    });
    assert.equal(intent?.strategy, "jump");
    assert.equal(intent?.side, "yes");
    assert.equal(intent?.wagerCents, ETH_JUMP_WAGER_CENTS);
  } finally {
    cleanup();
  }
});

test("Service B rejects wrong-day or malformed authoritative A state", async () => {
  const { market, store } = qualifyingFixture("yes");
  try {
    const cases = [
      {
        name: "wrong eastern day",
        read: async () => ({ ...aStateFor(market, "yes"), easternDate: "2033-05-17" }),
      },
      {
        name: "malformed side",
        read: async () => ({ ...aStateFor(market, "yes"), side: "maybe" as any }),
      },
    ];
    for (const scenario of cases) {
      let rejectionReason: string | null = null;
      const intent = await prepareEthJumpServiceIntent({
        store,
        market,
        role: "jump",
        readMartingaleState: scenario.read,
        onEvaluation: (observation) => { rejectionReason = observation.rejectionReason; },
      });
      assert.equal(intent, null, scenario.name);
      assert.equal(rejectionReason, "martingale_side_unavailable", scenario.name);
    }
  } finally {
    cleanup();
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
      readMartingaleState: async () => aStateFor(market, "no"),
      onEvaluation: (observation) => { observedMove = observation.currentMove; },
    });
    assert.equal(intent?.strategy, "jump");
    assert.equal(intent?.side, "no");
    assert.equal(intent?.wagerCents, ETH_JUMP_WAGER_CENTS);
    assert.ok(observedMove != null && Math.abs(observedMove - 0.048) < 1e-12);
    assert.deepEqual(calls, [`/markets/${market.ticker}`, "/markets"]);
  } finally {
    cleanup();
  }
});

test("a non-jump runtime cannot evaluate Service B and performs no evidence or A-state reads", async () => {
  let reads = 0;
  let aReads = 0;
  const store: any = {
    getEth420CandidateState: async () => { reads++; return null; },
    listEth420CandidateTelemetry: async () => { reads++; return []; },
  };
  const result = await prepareEthJumpServiceIntent({
    store,
    role: "martingale",
    readMartingaleState: async () => { aReads++; return null; },
    market: {
      ticker: "KXETH15M-BLOCKED", easternDate: "2026-09-05", observedAtMs: 1_800_000,
      openTimeMs: 1_800_000, floorStrike: 100,
    },
  });
  assert.equal(result, null);
  assert.equal(reads, 0);
  assert.equal(aReads, 0);
});
