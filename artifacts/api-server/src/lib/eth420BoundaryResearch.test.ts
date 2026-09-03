import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  initTradeStore,
  recordEth420BoundaryResearchSnapshot,
} from "./tradeStore.js";
import {
  ETH420_BOUNDARY_ANCHORS,
  _resetEth420BoundaryResearchForTesting,
  _setEth420BoundaryResearchDependenciesForTesting,
  buildEth420BoundaryResearchResponse,
  buildEth420BoundaryReplay,
  observeEth420BoundaryResearch,
  type BoundaryMarket,
} from "./eth420BoundaryResearch.js";

const now = 1_800_000_000_000;
const ticker = "KXETH15M-27JAN010000-00";
const market: BoundaryMarket = {
  ticker, openTime: new Date(now + 60_000).toISOString(), closeTime: new Date(now + 960_000).toISOString(),
  exchangeIndex: 4, yesBid: 50, yesAsk: 52, noBid: 48, noAsk: 50, bidUpdatedMs: now,
};
const goodBook = (side: "yes" | "no") => ({
  ticker, capturedAtMs: now, side, limitCents: 99, rawEntryCount: 1, totalLevels: 1,
  lowestLevelCents: 50, lowestLevelDollars: 1, lowestLevelContractsApprox: 2,
  highestLevelCents: 50, highestLevelDollars: 1, nearLimitLevels: [], depthAtOrBetterDollars: 1,
  depthAtOrBetterContracts: 2, fetchLatencyMs: 1, error: null,
  rawYesDollars: [["0.50", "1"] as [string, string]],
  rawNoDollars: [["0.50", "1"] as [string, string]],
});
const candidate = { id: "candidate-1", kalshiOrderId: "kalshi-1", side: "yes", requestedContracts: 30, limitPriceCents: 50, status: "resting", filledContracts: 0 };
const storageTicker = `${ticker}-BOUNDARY-RESEARCH-TEST`;

before(async () => {
  await initTradeStore();
  await db.execute(sql`DELETE FROM eth420_boundary_research_snapshots WHERE ticker=${storageTicker}`);
});
after(async () => {
  await db.execute(sql`DELETE FROM eth420_boundary_research_snapshots WHERE ticker=${storageTicker}`);
  await pool.end().catch(() => {});
});

function completeRows(): Array<Record<string, unknown>> {
  const open = now;
  return ETH420_BOUNDARY_ANCHORS.map(([anchor], index) => ({
    ticker, anchor, market_open_ms: open, prior_market_open_ms: open - 900_000, quality: "complete",
    candidate_order_id: "candidate-1", selected_side: "yes", yes_ask: 54 + index, no_ask: 46,
  }));
}

test("passive research storage is idempotent at the durable ticker-anchor boundary", async () => {
  const snapshot = {
    id: `${storageTicker}:boundary_open:${now}`, ticker: storageTicker, anchor: "boundary_open",
    marketOpenMs: now, marketCloseMs: now + 900_000, priorMarketOpenMs: now - 900_000,
    scheduledAtMs: now, actualAtMs: now, latenessMs: 0, exchangeIndex: 4,
    yesBid: 50, yesAsk: 52, noBid: 48, noAsk: 50, yesSpreadCents: 2, noSpreadCents: 2,
    l2Json: "{}", spotMidpoint: 3_000, spotProvider: "kraken", spotSourceTimestampMs: now,
    spotReceiptTimestampMs: now, spotAgeMs: 0, spotIsProxy: false, candidateOrderId: "candidate-1",
    kalshiOrderId: "kalshi-1", selectedSide: "yes", requestedContracts: 30, primaryLimitCents: 50,
    orderStatus: "resting", filledContracts: 0, quality: "complete",
  };
  assert.equal(await recordEth420BoundaryResearchSnapshot(snapshot), true);
  assert.equal(await recordEth420BoundaryResearchSnapshot({ ...snapshot, id: `${snapshot.id}:retry` }), false);
  const result = await db.execute(sql`SELECT count(*)::int AS count FROM eth420_boundary_research_snapshots
    WHERE ticker=${storageTicker} AND anchor='boundary_open' AND scheduled_at_ms=${now}`);
  assert.equal((result as unknown as { rows: Array<{ count: number }> }).rows[0]!.count, 1);
});

test("passive collector writes a scheduled snapshot once and preserves newer rollover timers", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const writes: Array<Record<string, unknown>> = [];
  let active = market;
  _setEth420BoundaryResearchDependenciesForTesting({
    now: () => now,
    schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return {}; },
    captureOrderbook: async (sideTicker, side) => ({ ...goodBook(side), ticker: sideTicker }),
    getKrakenPrices: async () => ({ btc: 1, eth: 3_000, sol: 1, sourceTimestampMs: now, retrievedAtMs: now, cacheAgeMs: 0, cached: false }),
    getFreshMarket: async () => null,
    findCandidate: async () => candidate as any,
    recordSnapshot: async (snapshot) => { writes.push(snapshot); return writes.filter((row) => row.id === snapshot.id).length === 1; },
  });
  try {
    observeEth420BoundaryResearch(market, () => active);
    observeEth420BoundaryResearch(market, () => active);
    assert.equal(scheduled.length, ETH420_BOUNDARY_ANCHORS.length, "duplicate observers must not schedule duplicate writes");
    const rollover = { ...market, ticker: "KXETH15M-27JAN011500-15", openTime: new Date(now + 960_000).toISOString(), closeTime: new Date(now + 1_860_000).toISOString() };
    active = rollover;
    observeEth420BoundaryResearch(rollover, () => active);
    assert.equal(scheduled.length, ETH420_BOUNDARY_ANCHORS.length * 2, "a new market owns independent timers");
    scheduled[0]!.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1);
    assert.match(String(writes[0]!.quality), /market_state_missing/, "a timer from the old market cannot claim new-market BBO");
    scheduled[ETH420_BOUNDARY_ANCHORS.length]!.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 2, "old completion does not cancel the new rollover timer");
    _resetEth420BoundaryResearchForTesting();
    const afterRestart: Array<() => void> = [];
    _setEth420BoundaryResearchDependenciesForTesting({
      now: () => now,
      schedule: (callback) => { afterRestart.push(callback); return {}; },
    });
    observeEth420BoundaryResearch(market, () => market);
    assert.equal(afterRestart.length, ETH420_BOUNDARY_ANCHORS.length,
      "a process restart may reschedule every anchor; durable writes fence duplicate snapshots");
  } finally {
    _resetEth420BoundaryResearchForTesting();
  }
});

test("collector labels malformed or stale BBO, L2, spot, and candidate links incomplete", async () => {
  const scheduled: Array<() => void> = [];
  const writes: Array<Record<string, unknown>> = [];
  _setEth420BoundaryResearchDependenciesForTesting({
    now: () => now,
    schedule: (callback) => { scheduled.push(callback); return {}; },
    captureOrderbook: async (side) => ({ ...goodBook("yes"), ticker: side, rawYesDollars: [["bad", "1"]] } as any),
    getKrakenPrices: async () => ({ btc: 1, eth: Number.NaN, sol: 1, sourceTimestampMs: now, retrievedAtMs: now, cacheAgeMs: 30_000, cached: false }),
    getFreshMarket: async () => null,
    findCandidate: async () => ({ ...candidate, side: null }) as any,
    recordSnapshot: async (snapshot) => { writes.push(snapshot); return true; },
  });
  try {
    observeEth420BoundaryResearch({ ...market, bidUpdatedMs: now - 30_000 }, () => ({ ...market, bidUpdatedMs: now - 30_000 }));
    scheduled[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    const quality = String(writes[0]!.quality);
    for (const reason of ["bbo_unavailable_or_stale", "l2_unavailable_or_malformed", "spot_unavailable_or_stale", "candidate_link_ambiguous"]) {
      assert.match(quality, new RegExp(reason));
    }
  } finally {
    _resetEth420BoundaryResearchForTesting();
  }
});

test("arms next-window opening anchors in advance and uses a fresh public BBO at the exact capture time", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const writes: Array<Record<string, unknown>> = [];
  let clock = now;
  const nextOpenMs = new Date(market.closeTime!).getTime();
  const nextMarket: BoundaryMarket = {
    ...market,
    ticker: "KXETH15M-27JAN011500-15",
    openTime: new Date(nextOpenMs).toISOString(),
    closeTime: new Date(nextOpenMs + 900_000).toISOString(),
    yesBid: 51, yesAsk: 53, noBid: 47, noAsk: 49,
    bidUpdatedMs: nextOpenMs,
  };
  _setEth420BoundaryResearchDependenciesForTesting({
    now: () => clock,
    schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return {}; },
    captureOrderbook: async (sideTicker, side) => ({ ...goodBook(side), ticker: sideTicker }),
    getKrakenPrices: async () => ({ btc: 1, eth: 3_000, sol: 1, sourceTimestampMs: clock, retrievedAtMs: clock, cacheAgeMs: 0, cached: false }),
    discoverMarketAtOpen: async (openMs) => openMs === nextOpenMs ? nextMarket : null,
    // Simulate a stale/missing stream BBO: the fresh public market BBO must win.
    getFreshMarket: async (requestedTicker) => requestedTicker === nextMarket.ticker
      ? { ...nextMarket, bidUpdatedMs: clock } : null,
    findCandidate: async () => candidate as any,
    recordSnapshot: async (snapshot) => { writes.push(snapshot); return true; },
  });
  try {
    observeEth420BoundaryResearch(market, () => ({ ...market, yesBid: null, yesAsk: null, noBid: null, noAsk: null, bidUpdatedMs: now - 60_000 }));
    assert.equal(scheduled.length, ETH420_BOUNDARY_ANCHORS.length);
    // Four close-side anchors belong to the known market; five opening anchors
    // are armed prospectively for the following market.
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), [
      950_000, 955_000, 958_000, 960_000, 960_000, 961_000, 962_000, 965_000, 970_000,
    ]);
    clock = nextOpenMs + 10_000;
    scheduled[8]!.callback();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.anchor, "open_plus_10s");
    assert.equal(writes[0]!.ticker, nextMarket.ticker);
    assert.equal(writes[0]!.actualAtMs, writes[0]!.scheduledAtMs, "exact anchor execution must not be backfilled late");
    assert.deepEqual(
      [writes[0]!.yesBid, writes[0]!.yesAsk, writes[0]!.noBid, writes[0]!.noAsk],
      [51, 53, 47, 49],
      "fresh public BBO must be persisted instead of a missing stream snapshot",
    );
    assert.equal(writes[0]!.quality, "complete");
  } finally {
    _resetEth420BoundaryResearchForTesting();
  }
});

test("replay excludes missing, duplicate, non-adjacent, and ambiguous evidence before conclusions", () => {
  const valid = buildEth420BoundaryReplay({ availability: "available", rows: completeRows() }) as any;
  assert.equal(valid.sufficientEvidence, true);
  for (const mutate of [
    (rows: Array<Record<string, unknown>>) => rows.slice(1),
    (rows: Array<Record<string, unknown>>) => [...rows, { ...rows[0], quality: "complete", yes_ask: 1 }],
    (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ ...row, prior_market_open_ms: now - 1_800_000 })),
    (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ ...row, quality: "candidate_link_ambiguous" })),
  ]) {
    const replay = buildEth420BoundaryReplay({ availability: "available", rows: mutate(completeRows()) }) as any;
    assert.equal(replay.sufficientEvidence, false);
    assert.equal(replay.completeWindows, 0);
    assert.ok(replay.excludedWindows > 0);
  }
});

test("reports storage failures as unavailable rather than evidence-free", () => {
  const emptyRead = buildEth420BoundaryReplay({ availability: "available", rows: [] }) as any;
  assert.equal(emptyRead.evidenceAvailability, "available");
  assert.equal(emptyRead.conclusionsAvailable, true);
  assert.equal(emptyRead.diagnosticReason, null);
  assert.equal(emptyRead.sufficientEvidence, false);

  const failedRead = {
    availability: "unavailable" as const,
    rows: [] as [],
    diagnosticReason: "storage_read_failed" as const,
  };
  const research = buildEth420BoundaryResearchResponse(failedRead);
  assert.deepEqual(research, {
    researchOnly: true,
    evidenceAvailability: "unavailable",
    diagnosticReason: "storage_read_failed",
    rows: [],
    summary: {
      rowCount: 0,
      completeRowCount: 0,
      requiredAnchors: ETH420_BOUNDARY_ANCHORS.map(([anchor]) => anchor),
    },
  });

  const replay = buildEth420BoundaryReplay(failedRead) as any;
  assert.equal(replay.evidenceAvailability, "unavailable");
  assert.equal(replay.conclusionsAvailable, false);
  assert.equal(replay.diagnosticReason, "storage_read_failed");
  assert.equal(replay.sufficientEvidence, false);
  assert.deepEqual(replay.rows, []);
});

test("boundary research has no execution-side imports", async () => {
  const sourcePath = process.env["ETH420_BOUNDARY_RESEARCH_SOURCE"]
    ?? fileURLToPath(new URL("./eth420BoundaryResearch.ts", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  assert.doesNotMatch(source, /from ["']\.\/(?:autoTrader|strategies\/|trade(?:Store)?Execution|kalshiAuth)/);
});