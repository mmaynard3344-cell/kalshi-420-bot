import assert from "node:assert/strict";
import test from "node:test";
import { advanceEth420State, applyEth420ConfirmedSettlement, estimateEth420FullLossFeeCents, eth420BackFlipIocContracts, eth420CandidateLiveOrderTerms, ETH_420_BACK_FLIP_FLIP_WAGER_CENTS, ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS, ETH_420_DAILY_LOSS_LIMIT_CENTS, ETH_420_PRINCIPALS_CENTS, evaluateEth420Candidate, evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled, isEth420CandidateExecutionPermitted, observeEth420Candidate, prepareEth420CandidateDecision, mergeEth420HistoryFacts, eth420MovesFromFacts, selectEth420BackFlipSide, _setEth420BootstrapFactsForTesting, _setEth420CandidateAuthFetchForTesting, _setEth420CandidateBalanceReadForTesting, _setEth420CandidateOrderbookCaptureForTesting } from "./eth420SixStepCandidate.js";

const state = (overrides = {}) => ({ easternDate: "2026-08-29", side: "no" as const, step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null, ...overrides });
const input = (overrides = {}) => ({ ticker: "KXETH15M-test", easternDate: "2026-08-29", observedAtMs: 1_800_000, floorStrike: 110, openTimeMs: 1_800_000, priorMarket: { ticker: "KXETH15M-prior", easternDate: "2026-08-29", observedAtMs: 900_000, floorStrike: 100, openTimeMs: 900_000 }, trailingMoves: Array.from({ length: 50 }, (_, i) => i / 1000), state: state(), estimatedFeeCents: 53, ...overrides });

test("candidate has the specified six-step ladder and lifecycle transitions", () => {
  assert.deepEqual(ETH_420_PRINCIPALS_CENTS, [1500, 3000, 6000, 12000, 24000, 32000]);
  assert.equal(estimateEth420FullLossFeeCents(42000), 1470);
  assert.deepEqual(advanceEth420State(state({ step: 4 }), "no", 30), state({ side: "yes", step: 0 }));
  assert.equal(advanceEth420State(state({ step: 4 }), "yes", 30).step, 5);
  assert.equal(advanceEth420State(state({ step: 5 }), "yes", 30).step, 0);
  assert.deepEqual(advanceEth420State(state({ step: 3 }), "yes", 0), state({ step: 4 }));
});

test("candidate execution requires the live environment opt-in after code approval", () => {
  const previous = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  try {
    delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
    assert.equal(isEth420CandidateExecutionPermitted(), false);
    process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
    assert.equal(isEth420CandidateExecutionPermitted(), true);
  } finally {
    if (previous == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
    else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = previous;
  }
});
test("live candidate order terms always use 50 cents", () => {
  assert.deepEqual(eth420CandidateLiveOrderTerms(1500), { limitPriceCents: 50, contracts: 30 });
  assert.deepEqual(eth420CandidateLiveOrderTerms(42_000), { limitPriceCents: 50, contracts: 840 });
});
test("Back Flip uses only the missed-side first post-settlement bid with an inclusive 50-cent split", () => {
  assert.equal(selectEth420BackFlipSide("no", 50), "no");
  assert.equal(selectEth420BackFlipSide("no", 49), "yes");
  assert.equal(selectEth420BackFlipSide("yes", 50), "yes");
  assert.equal(selectEth420BackFlipSide("yes", 49), "no");
  assert.equal(selectEth420BackFlipSide("yes", Number.NaN), null);
  assert.equal(selectEth420BackFlipSide("no", 101), null);
});
test("Back Flip retained-side IOC quantity stays within the $420 cap at representative chosen-side asks", () => {
  assert.equal(eth420BackFlipIocContracts(50), 840);
  assert.equal(eth420BackFlipIocContracts(55), 763);
  assert.equal(eth420BackFlipIocContracts(80), 525);
  assert.equal(eth420BackFlipIocContracts(99), 424);
  assert.equal(eth420BackFlipIocContracts(0), null);
});
test("Back Flip owns B over the normal ladder and rests a $25 opposite-side 50-cent GTC", async () => {
  const priorLive = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  const openTimeMs = Date.now() - 2_000;
  const reserved: any[] = [];
  const posts: any[] = [];
  const liveState = state({ side: "no", step: 3 });
  const store: any = {
    getEth420CandidateBackFlipArm: async () => ({
      sourceCandidateOrderId: "A:eth420-live-v1", sourceTicker: "A", sourceOpenTimeMs: openTimeMs - 900_000,
      missedSide: "no", targetOpenTimeMs: openTimeMs, armedAtMs: Date.now() - 5_000,
    }),
    fallbackEth420CandidateBackFlip: async () => true,
    getEth420CandidateState: async () => liveState,
    listEth420CandidateTelemetry: async () => [],
    reserveEth420CandidateLiveOrderIfStateMatches: async (params: any) => { reserved.push(params); return true; },
    recordEth420CandidateExecutionSnapshot: async () => true,
    getEth420CandidateLiveOrder: async () => null,
    acknowledgeEth420CandidateLiveOrder: async () => true,
  };
  process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
  _setEth420CandidateOrderbookCaptureForTesting((async (ticker: string, side: string) => ({
    ticker, side, capturedAtMs: Date.now(), error: null, rawYesDollars: [], rawNoDollars: [["0.4900", "10.00"]],
  })) as any);
  _setEth420CandidateBalanceReadForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEth420CandidateAuthFetchForTesting((async (_method: string, path: string, body: any) => {
    if (path === "/portfolio/events/orders") {
      posts.push(body);
      return { order: { order_id: "back-flip-order", client_order_id: body.client_order_id } };
    }
    throw new Error(`unexpected path ${path}`);
  }) as any);
  try {
    assert.equal(await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(store, {
      ticker: "KXETH15M-B", exchangeIndex: 1, openTime: new Date(openTimeMs).toISOString(),
      closeTime: null, status: "open", yesBid: null, noBid: null,
    }, { ticker: "KXETH15M-B", easternDate: "2026-09-01", observedAtMs: Date.now(), floorStrike: null, openTimeMs }), true);
  } finally {
    _setEth420CandidateOrderbookCaptureForTesting(null);
    _setEth420CandidateBalanceReadForTesting(null);
    _setEth420CandidateAuthFetchForTesting(null);
    if (priorLive == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
    else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = priorLive;
  }
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].side, "yes");
  assert.equal(reserved[0].effectiveWagerCents, ETH_420_BACK_FLIP_FLIP_WAGER_CENTS);
  assert.equal(reserved[0].requestedContracts, 50);
  assert.equal(reserved[0].backFlip.missedSideBidCents, 49);
  assert.equal(reserved[0].backFlip.executionMode, "resting_gtc");
  assert.equal(reserved[0].backFlip.limitPriceCents, 50);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].side, "bid");
  assert.equal(posts[0].count, "50.00");
  assert.equal(posts[0].price, "0.5000");
  assert.equal(posts[0].time_in_force, "good_till_canceled");
});
test("Back Flip at the inclusive 50-cent bid crosses the chosen-side ask IOC at up to $420", async () => {
  const priorLive = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  const openTimeMs = Date.now() - 2_000;
  const reserved: any[] = [];
  const posts: any[] = [];
  const liveState = state({ side: "no", step: 3 });
  const store: any = {
    getEth420CandidateBackFlipArm: async () => ({
      sourceCandidateOrderId: "A:eth420-live-v1", sourceTicker: "A", sourceOpenTimeMs: openTimeMs - 900_000,
      missedSide: "no", targetOpenTimeMs: openTimeMs, armedAtMs: Date.now() - 5_000,
    }),
    fallbackEth420CandidateBackFlip: async () => true, getEth420CandidateState: async () => liveState,
    listEth420CandidateTelemetry: async () => [], reserveEth420CandidateLiveOrderIfStateMatches: async (p: any) => { reserved.push(p); return true; },
    recordEth420CandidateExecutionSnapshot: async () => true, getEth420CandidateLiveOrder: async () => null,
    acknowledgeEth420CandidateLiveOrder: async () => true,
  };
  process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
  _setEth420CandidateOrderbookCaptureForTesting((async (ticker: string, side: string) => ({
    ticker, side, capturedAtMs: Date.now(), error: null,
    // NO bid=50; a NO buy's chosen-side ask is derived from yes_dollars: 45¢ YES = 55¢ NO.
    rawYesDollars: [["0.4500", "10.00"]], rawNoDollars: [["0.5000", "10.00"]],
  })) as any);
  _setEth420CandidateBalanceReadForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEth420CandidateAuthFetchForTesting((async (_method: string, path: string, body: any) => {
    if (path === "/portfolio/events/orders") { posts.push(body); return { order: { order_id: "back-flip-cross", client_order_id: body.client_order_id } }; }
    throw new Error(`unexpected path ${path}`);
  }) as any);
  try {
    assert.equal(await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(store, {
      ticker: "KXETH15M-B", exchangeIndex: 1, openTime: new Date(openTimeMs).toISOString(),
      closeTime: null, status: "open", yesBid: null, noBid: null,
    }, { ticker: "KXETH15M-B", easternDate: "2026-09-01", observedAtMs: Date.now(), floorStrike: null, openTimeMs }), true);
  } finally {
    _setEth420CandidateOrderbookCaptureForTesting(null); _setEth420CandidateBalanceReadForTesting(null); _setEth420CandidateAuthFetchForTesting(null);
    if (priorLive == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = priorLive;
  }
  assert.equal(reserved[0].side, "no");
  assert.equal(reserved[0].effectiveWagerCents, ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS);
  assert.equal(reserved[0].requestedContracts, 763);
  assert.equal(reserved[0].backFlip.intendedWagerCents, ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS);
  assert.equal(reserved[0].backFlip.executionMode, "cross_ioc");
  assert.equal(reserved[0].backFlip.limitPriceCents, 55);
  assert.equal(posts[0].count, "763.00");
  assert.equal(posts[0].price, "0.5500");
  assert.equal(posts[0].time_in_force, "immediate_or_cancel");
});
test("invalid first post-settlement B evidence is durably marked fallback before normal candidate submission", async () => {
  const priorLive = process.env["ETH_420_CANDIDATE_LIVE_ENABLED"];
  const openTimeMs = Date.now() - 2_000;
  const fallbacks: any[] = []; const reserved: any[] = [];
  const liveState = state({ side: "no", step: 3 });
  const store: any = {
    getEth420CandidateBackFlipArm: async () => ({
      sourceCandidateOrderId: "A:eth420-live-v1", sourceTicker: "A", sourceOpenTimeMs: openTimeMs - 900_000,
      missedSide: "no", targetOpenTimeMs: openTimeMs, armedAtMs: Date.now() - 5_000,
    }),
    fallbackEth420CandidateBackFlip: async (p: any) => { fallbacks.push(p); return true; },
    getEth420CandidateState: async () => liveState, listEth420CandidateTelemetry: async () => [],
    reserveEth420CandidateLiveOrderIfStateMatches: async (p: any) => { reserved.push(p); return true; },
    recordEth420CandidateExecutionSnapshot: async () => true, getEth420CandidateLiveOrder: async () => null,
    acknowledgeEth420CandidateLiveOrder: async () => true,
  };
  process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = "true";
  _setEth420CandidateOrderbookCaptureForTesting((async (ticker: string, side: string) => ({
    ticker, side, capturedAtMs: Date.now(), error: "unavailable", rawYesDollars: [], rawNoDollars: [],
  })) as any);
  _setEth420CandidateBalanceReadForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEth420CandidateAuthFetchForTesting((async () => ({ order: { order_id: "normal-after-fallback" } })) as any);
  try {
    assert.equal(await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(store, {
      ticker: "KXETH15M-B", exchangeIndex: 1, openTime: new Date(openTimeMs).toISOString(),
      closeTime: null, status: "open", yesBid: null, noBid: null,
    }, { ticker: "KXETH15M-B", easternDate: "2026-09-01", observedAtMs: Date.now(), floorStrike: null, openTimeMs }), true);
  } finally {
    _setEth420CandidateOrderbookCaptureForTesting(null); _setEth420CandidateBalanceReadForTesting(null); _setEth420CandidateAuthFetchForTesting(null);
    if (priorLive == null) delete process.env["ETH_420_CANDIDATE_LIVE_ENABLED"]; else process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] = priorLive;
  }
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].reason, "orderbook_unavailable");
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].backFlip, null);
  assert.equal(reserved[0].side, liveState.side);
});
test("sweet spot includes p95, excludes p99, filters NaN, and leaves Service A on its normal wager", () => {
  const pool = [...Array.from({ length: 49 }, (_, i) => i / 1000), Number.NaN, .05];
  const atP95 = evaluateEth420Candidate(input({ trailingMoves: pool, floorStrike: 104.9 }));
  assert.equal(atP95.validObservationCount, 50); assert.equal(atP95.sweetSpotTell, true);
  assert.equal(atP95.side, "no"); assert.equal(atP95.effectiveWagerCents, atP95.normalWagerCents); assert.equal(atP95.overrideIncreasedWager, false);
  const downJump = evaluateEth420Candidate(input({
    state: state({ side: "yes", step: 3 }), trailingMoves: pool, floorStrike: 95.1,
  }));
  assert.equal(downJump.sweetSpotTell, true);
  assert.equal(downJump.side, "yes"); assert.equal(downJump.effectiveWagerCents, downJump.normalWagerCents); assert.equal(downJump.overrideIncreasedWager, false);
  const atP99 = evaluateEth420Candidate(input({ trailingMoves: pool, floorStrike: 105 }));
  assert.equal(atP99.sweetSpotTell, false); assert.equal(atP99.finalReason, "top_1_percent_excluded");
  assert.equal(evaluateEth420Candidate(input({ state: state({ step: 5 }) })).effectiveWagerCents, 32000);
});
test("non-qualifying windows retain the carried sequence side and normal ladder wager", () => {
  const decision = evaluateEth420Candidate(input({
    state: state({ side: "yes", step: 3 }),
    trailingMoves: [...Array.from({ length: 49 }, (_, i) => i / 1000), .05],
    floorStrike: 103,
  }));
  assert.equal(decision.sweetSpotTell, false);
  assert.equal(decision.side, "yes");
  assert.equal(decision.effectiveWagerCents, 12000);
});
test("qualifying jump keeps the step-0 carried side while Service A remains on its normal rung", () => {
  const qualifyingPool = [...Array.from({ length: 46 }, () => .001), .005, .0055, .006, .006];
  const decision = evaluateEth420Candidate(input({
    ticker: "KXETH15M-26SEP011230-30",
    state: state({ side: "yes", step: 0 }),
    floorStrike: 2435.48,
    priorMarket: {
      ticker: "KXETH15M-26SEP011215-15", easternDate: "2026-09-01",
      observedAtMs: Date.parse("2026-09-01T16:00:00.000Z"), floorStrike: 2448.8,
      openTimeMs: Date.parse("2026-09-01T16:00:00.000Z"),
    },
    openTimeMs: Date.parse("2026-09-01T16:15:00.000Z"),
    trailingMoves: qualifyingPool,
  }));
  assert.equal(decision.sweetSpotTell, true);
  assert.equal(decision.side, "yes");
  assert.equal(decision.effectiveWagerCents, decision.normalWagerCents);
  assert.equal(decision.overrideIncreasedWager, false);
});
test("insufficient and non-adjacent strike evidence fail closed to no jump", () => {
  assert.equal(evaluateEth420Candidate(input({ trailingMoves: [0.1], floorStrike: null })).effectiveWagerCents, 1500);
  assert.equal(evaluateEth420Candidate(input({ priorMarket: { ...input().priorMarket!, openTimeMs: 99_999 } })).sweetSpotTell, false);
  assert.equal(evaluateEth420Candidate(input({ openTimeMs: 1_812_345, priorMarket: { ...input().priorMarket!, openTimeMs: 912_345 } })).sweetSpotTell, false);
});

test("49 moves remain inactive, 50 moves preserve p95-inclusive and p99-exclusive bands", () => {
  const fortyNine = Array.from({ length: 49 }, (_, i) => i / 1_000);
  const inactive = evaluateEth420Candidate(input({ trailingMoves: fortyNine, floorStrike: 104.8 }));
  assert.equal(inactive.p95, null);
  assert.equal(inactive.resultingBand, "unavailable");
  const fifty = [...fortyNine, .05];
  assert.equal(evaluateEth420Candidate(input({ trailingMoves: fifty, floorStrike: 104.9 })).resultingBand, "p95_to_p99");
  assert.equal(evaluateEth420Candidate(input({ trailingMoves: fifty, floorStrike: 105 })).resultingBand, "at_or_above_p99");
});

test("bootstrap facts never bridge gaps and validated live facts replace matching bootstrap facts", () => {
  const start = 1_800_000;
  const facts = mergeEth420HistoryFacts([
    { ticker: "KXETH15M-a", openTimeMs: start, floorStrike: 100 },
    { ticker: "KXETH15M-b", openTimeMs: start + 900_000, floorStrike: 101 },
    { ticker: "KXETH15M-gap", openTimeMs: start + 2_700_000, floorStrike: 103 },
  ], [{
    ticker: "KXETH15M-b", floorStrike: 101,
    payloadJson: JSON.stringify({
      schemaVersion: 2, openTimeMs: start + 900_000, priorFloorStrike: 100,
      priorOpenTimeMs: start, currentMove: .01, validAdjacentMove: true,
    }),
  }]);
  assert.deepEqual(facts.map((fact) => fact.source), ["bootstrap", "live", "bootstrap"]);
  assert.equal(eth420MovesFromFacts(facts).length, 1);
});

test("conflicting bootstrap/live facts are excluded fail closed", () => {
  const start = 1_800_000;
  const facts = mergeEth420HistoryFacts([{ ticker: "KXETH15M-a", openTimeMs: start, floorStrike: 100 }], [{
    ticker: "KXETH15M-a", floorStrike: 101,
    payloadJson: JSON.stringify({
      schemaVersion: 2, openTimeMs: start, priorFloorStrike: null,
      priorOpenTimeMs: null, currentMove: null, validAdjacentMove: false,
    }),
  }]);
  assert.deepEqual(facts, []);
});

test("prepared decision attributes bootstrap and live moves without double counting", async () => {
  const start = 9_000_000;
  _setEth420BootstrapFactsForTesting(Array.from({ length: 50 }, (_, index) => ({
    ticker: `KXETH15M-bootstrap-${index}`, openTimeMs: start + index * 900_000, floorStrike: 100 + index,
  })));
  try {
    const prepared = await prepareEth420CandidateDecision({
      getEth420CandidateState: async () => state(),
      listEth420CandidateTelemetry: async () => [{
        ticker: "KXETH15M-bootstrap-49", easternDate: "2026-08-29", observedAtMs: 1,
        floorStrike: 149, payloadJson: JSON.stringify({
          schemaVersion: 2, openTimeMs: start + 49 * 900_000, priorFloorStrike: 148,
          priorOpenTimeMs: start + 48 * 900_000, currentMove: 1 / 148, validAdjacentMove: true,
        }),
      }],
    }, {
      ticker: "KXETH15M-current", easternDate: "2026-08-29", observedAtMs: 2,
      floorStrike: 151, openTimeMs: start + 50 * 900_000,
    });
    assert.ok(prepared);
    assert.equal(prepared.decision.validObservationCount, 49);
    assert.equal(prepared.decision.bootstrapObservationCount, 48);
    assert.equal(prepared.decision.liveTelemetryObservationCount, 1);
  } finally {
    _setEth420BootstrapFactsForTesting(null);
  }
});

test("bootstrap history rolls forward and never keeps moves older than the candidate window", async () => {
  const currentOpenMs = Date.parse("2026-08-30T13:00:00.000Z");
  const old = currentOpenMs - 28 * 86_400_000 - 2 * 900_000;
  _setEth420BootstrapFactsForTesting([
    { ticker: "KXETH15M-old-1", openTimeMs: old, floorStrike: 100 },
    { ticker: "KXETH15M-old-2", openTimeMs: old + 900_000, floorStrike: 101 },
    { ticker: "KXETH15M-window-start", openTimeMs: currentOpenMs - 28 * 86_400_000, floorStrike: 102 },
    { ticker: "KXETH15M-current-prior", openTimeMs: currentOpenMs - 900_000, floorStrike: 102 },
  ]);
  try {
    const prepared = await prepareEth420CandidateDecision({
      getEth420CandidateState: async () => state(),
      listEth420CandidateTelemetry: async () => [],
    }, {
      ticker: "KXETH15M-current", easternDate: "2026-08-30", observedAtMs: 1,
      floorStrike: 103, openTimeMs: currentOpenMs,
    });
    assert.ok(prepared);
    assert.equal(prepared.decision.validObservationCount, 1);
    assert.equal(prepared.decision.bootstrapObservationCount, 1);
  } finally {
    _setEth420BootstrapFactsForTesting(null);
  }
});
test("prospective loss allows exactly -1200 and block resets only the step", () => {
  const allowed = evaluateEth420Candidate(input({ state: state({ realizedPnlCents: ETH_420_DAILY_LOSS_LIMIT_CENTS + 1553 }) }));
  assert.equal(allowed.prospectiveLossAllowed, true);
  const blocked = evaluateEth420Candidate(input({ state: state({ side: "yes", step: 4, realizedPnlCents: -119000 }) }));
  assert.equal(blocked.prospectiveLossAllowed, false); assert.equal(blocked.nextState.step, 0);
  assert.equal(blocked.nextState.side, "yes"); assert.equal(blocked.blockResetApplied, true);
});

test("candidate preparation bootstraps the documented default state when its ET-date row is absent", async () => {
  const market = { ticker: "KXETH15M-cold-start", easternDate: "2026-08-30", observedAtMs: 1_000_000, floorStrike: 100, openTimeMs: 1_000_000 };
  const prepared = await prepareEth420CandidateDecision({
    getEth420CandidateState: async () => null,
    listEth420CandidateTelemetry: async () => [],
  }, market);
  assert.ok(prepared);
  assert.deepEqual(prepared.state, {
    easternDate: "2026-08-30",
    side: "no",
    step: 0,
    realizedPnlCents: 0,
    lastBlockResetAtMs: null,
  });
  assert.equal(prepared.decision.side, "no");
  assert.equal(prepared.decision.underlyingStep, 0);
});

test("candidate settlement transitions are durable, idempotent, and advance verified zero fills without P&L", async () => {
  let current = state({ step: 2, realizedPnlCents: -4500 });
  const eventIds = new Set<string>();
  const store = {
    getEth420CandidateState: async () => current,
    applyEth420CandidateConfirmedSettlement: async (params: any) => {
      if (eventIds.has(params.id)) return true;
      eventIds.add(params.id); current = params.nextState; return true;
    },
  };
  assert.equal(await applyEth420ConfirmedSettlement(store, {
    id: "settled-1", easternDate: current.easternDate, result: "yes", filledContracts: 30, realizedPnlDeltaCents: -1553,
  }), true);
  assert.deepEqual(current, state({ step: 3, realizedPnlCents: -6053 }));
  assert.equal(await applyEth420ConfirmedSettlement(store, {
    id: "settled-1", easternDate: current.easternDate, result: "yes", filledContracts: 30, realizedPnlDeltaCents: -1553,
  }), true);
  assert.deepEqual(current, state({ step: 3, realizedPnlCents: -6053 }));
  assert.equal(await applyEth420ConfirmedSettlement(store, {
    id: "settled-zero", easternDate: current.easternDate, result: "no", filledContracts: 0, realizedPnlDeltaCents: -999,
  }), true);
  assert.deepEqual(current, state({ side: "yes", step: 0, realizedPnlCents: -6053 }));
});

test("shadow observation reads durable candidate state and persists only a prospective-loss reset", async () => {
  const previous = process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
  let saved: any = null;
  try {
    process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"] = "true";
    await observeEth420Candidate({
      getEth420CandidateState: async () => state({ side: "yes", step: 4, realizedPnlCents: -119000 }),
      saveEth420CandidateState: async (next) => { saved = next; return true; },
      applyEth420CandidateConfirmedSettlement: async () => true,
       recordEth420CounterfactualEntry: async () => true,
      listEth420CandidateTelemetry: async () => Array.from({ length: 50 }, (_, index) => ({
        ticker: `KXETH15M-${index}`, easternDate: "2026-08-29", observedAtMs: index,
        floorStrike: 100, payloadJson: JSON.stringify({ openTimeMs: index * 900_000, currentMove: index / 1000 }),
      })),
      recordEth420CandidateTelemetry: async () => true,
    }, { ticker: "KXETH15M-test", easternDate: "2026-08-29", observedAtMs: 100, floorStrike: 110, openTimeMs: 50 * 900_000 });
    assert.deepEqual(saved, state({ side: "yes", step: 0, realizedPnlCents: -119000, lastBlockResetAtMs: 100 }));
  } finally {
    if (previous == null) delete process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
    else process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"] = previous;
  }
});

test("shadow recorder is inert while disabled and stores one counterfactual entry without an order path", async () => {
  const previous = process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
  const entries: any[] = [];
  let telemetry = 0;
  const store = {
    getEth420CandidateState: async () => state(),
    saveEth420CandidateState: async () => true,
    applyEth420CandidateConfirmedSettlement: async () => true,
    listEth420CandidateTelemetry: async () => Array.from({ length: 50 }, (_, index) => ({
      ticker: `KXETH15M-${index}`, easternDate: "2026-08-29", observedAtMs: index,
      floorStrike: 100, payloadJson: JSON.stringify({ openTimeMs: index * 900_000, currentMove: index / 1000 }),
    })),
    recordEth420CandidateTelemetry: async () => { telemetry++; return true; },
    recordEth420CounterfactualEntry: async (entry: any) => { entries.push(entry); return true; },
  };
  const market = { ticker: "KXETH15M-shadow-entry", easternDate: "2026-08-29", observedAtMs: 100, floorStrike: 110, openTimeMs: 50 * 900_000 };
  try {
    delete process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
    await observeEth420Candidate(store, market);
    assert.equal(entries.length, 0);
    assert.equal(telemetry, 0);
    process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"] = "true";
    await observeEth420Candidate(store, market);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "KXETH15M-shadow-entry:eth420-counterfactual-v1");
    assert.equal(entries[0].side, "no");
    assert.equal(entries[0].step, 0);
    assert.equal(entries[0].effectiveWagerCents, 1500);
    assert.match(entries[0].decisionPayloadJson, /COUNTERFACTUAL_NO_ORDER_NO_FILL_ASSUMPTION/);
    assert.deepEqual(JSON.parse(entries[0].stateBeforeJson), state());
  } finally {
    if (previous == null) delete process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"];
    else process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"] = previous;
  }
});