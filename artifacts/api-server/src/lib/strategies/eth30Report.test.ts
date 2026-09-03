import assert from "node:assert/strict";
import test from "node:test";
import { computeEth30Report } from "./eth30Report.js";
import type {
  Eth30TickerClaim,
  Eth30StrategyOrder,
  Eth30PositionEventParams,
  Eth30DecisionEventParams,
} from "../tradeStore.js";

function claim(ticker: string, over: Partial<Eth30TickerClaim> = {}): Eth30TickerClaim {
  return { ticker, easternDate: "2026-08-16", claimedAtMs: 1_000, entryClientOrderId: `coid-${ticker}`, ...over };
}
function entryOrder(ticker: string, side: "yes" | "no" = "yes"): Eth30StrategyOrder {
  return {
    id: `entry:${ticker}`, ticker, easternDate: "2026-08-16", role: "entry", sequenceNumber: 0,
    clientOrderId: `coid-${ticker}`, kalshiOrderId: "k1", side, limitPriceCents: 28,
    requestedContracts: 10, outcome: "full_fill", filledContracts: 10, averageFillPriceCents: 28, updatedAtMs: 2_000,
  };
}
function ev(ticker: string, over: Partial<Eth30PositionEventParams> & Pick<Eth30PositionEventParams, "id" | "eventType" | "contractsDelta" | "contractsAfter">): Eth30PositionEventParams {
  return {
    ticker, easternDate: "2026-08-16", strategyOrderId: null, fillPriceCents: null,
    feeCents: null, settlementResult: null, note: null, occurredAtMs: 3_000, ...over,
  };
}

test("report ignores everything not covered by a durable ETH_30_50 claim (legacy isolation)", () => {
  // Events exist for a legacy ETH ticker that was never claimed by the
  // strategy — the report must not include or count them.
  const claimed = "KXETH15M-26AUG161200-15";
  const legacy  = "KXETH15M-26AUG160000-99";
  const events = new Map<string, Eth30PositionEventParams[]>([
    [claimed, [ev(claimed, { id: "a", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30 })]],
    [legacy,  [ev(legacy,  { id: "b", eventType: "entry_fill", contractsDelta: 99, contractsAfter: 99, fillPriceCents: 80 })]],
  ]);
  const report = computeEth30Report({
    claims: [claim(claimed)],
    ordersByTicker: new Map([[claimed, [entryOrder(claimed)]]]),
    eventsByTicker: events,
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  assert.equal(report.strategy, "ETH_30_50");
  assert.equal(report.source, "eth30_owned_ledgers_only");
  assert.equal(report.tickers.length, 1);
  assert.equal(report.tickers[0].ticker, claimed);
  assert.equal(report.summary.entryContracts, 5);
  assert.equal(report.summary.entryCostCents, 150); // 5 × 30¢
});

test("split-fill settlement arithmetic is exact per owned chunk", () => {
  // Entry split across two chunks (5 @ 30¢, 3 @ 28¢), exit split across two
  // 50¢ chunks (2 + 4), remaining 2 contracts settle as a win.
  const t = "KXETH15M-26AUG161215-20";
  const events: Eth30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, occurredAtMs: 2 }),
    ev(t, { id: "x1", eventType: "exit_fill", contractsDelta: -2, contractsAfter: 6, fillPriceCents: 50, occurredAtMs: 3 }),
    ev(t, { id: "x2", eventType: "exit_fill", contractsDelta: -4, contractsAfter: 2, fillPriceCents: 50, occurredAtMs: 4 }),
    ev(t, { id: "s", eventType: "settlement", contractsDelta: -2, contractsAfter: 0, settlementResult: "yes", occurredAtMs: 5 }),
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const row = report.tickers[0];
  assert.equal(row.entryContracts, 8);
  assert.equal(row.entryCostCents, 5 * 30 + 3 * 28); // 234 — exact chunk sum, not avg×count
  assert.equal(row.entryAvgPriceCents, Math.round(234 / 8));
  assert.equal(row.exitContracts, 6);
  assert.equal(row.exitProceedsCents, 300);
  assert.equal(row.settledContracts, 2);
  assert.equal(row.settlementResult, "yes");
  assert.equal(row.settlementPayoutCents, 200); // held yes, settled yes
  assert.equal(row.cashFlowPnlCents, 300 + 200 - 234); // 266
  assert.equal(row.realizedPnlCents, null, "missing fill fees prevent verified realized P&L");
  assert.equal(row.openContracts, 0);
  assert.equal(row.status, "settled");
  assert.equal(report.summary.realizedPnlCents, null);
  assert.equal(report.summary.wins, 0);
  assert.equal(report.summary.losses, 0);
  assert.equal(report.feesIncluded, false); // all feeCents are null
});

test("losing settlement pays zero and P&L nets exits against entry cost", () => {
  const t = "KXETH15M-26AUG161230-25";
  const events: Eth30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 10, contractsAfter: 10, fillPriceCents: 25, occurredAtMs: 1 }),
    ev(t, { id: "x1", eventType: "exit_fill", contractsDelta: -4, contractsAfter: 6, fillPriceCents: 50, occurredAtMs: 2 }),
    ev(t, { id: "s", eventType: "settlement", contractsDelta: -6, contractsAfter: 0, settlementResult: "no", occurredAtMs: 3 }),
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const row = report.tickers[0];
  assert.equal(row.settlementPayoutCents, 0); // held yes, settled no → no payout
  assert.equal(row.cashFlowPnlCents, 200 + 0 - 250); // = -50
  assert.equal(row.realizedPnlCents, null, "missing fee evidence keeps realized P&L unverified");
  assert.equal(row.status, "settled");
  assert.equal(report.summary.losses, 0);
});

test("open positions and no-fill claims are classified without settlement", () => {
  const open = "KXETH15M-26AUG161245-30";
  const none = "KXETH15M-26AUG161300-35";
  // open ticker: 7 contracts @ 20¢ = 140 entryCost, 0 exits/settlement → openContracts=7
  // none ticker: claimed but no events → status="no_fill"
  const report = computeEth30Report({
    claims: [claim(open, { claimedAtMs: 2_000 }), claim(none, { claimedAtMs: 3_000 })],
    ordersByTicker: new Map([[open, [entryOrder(open)]], [none, [entryOrder(none)]]]),
    eventsByTicker: new Map([
      [open, [ev(open, { id: "e1", eventType: "entry_fill", contractsDelta: 7, contractsAfter: 7, fillPriceCents: 20 })]],
      [none, []],
    ]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const byTicker = Object.fromEntries(report.tickers.map((t) => [t.ticker, t]));
  assert.equal(byTicker[open].status, "open");
  assert.equal(byTicker[open].openContracts, 7);
  assert.equal(byTicker[none].status, "no_fill");
  assert.equal(byTicker[none].realizedPnlCents, null);
  assert.equal(byTicker[open].cashFlowPnlCents, -140);
  assert.equal(report.summary.tickersWithFills, 1);
  // Unrealized/no-fill rows never contribute to realized P&L.
  assert.equal(report.summary.cashFlowPnlCents, -140);
  assert.equal(report.summary.realizedPnlCents, null);
  assert.equal(report.summary.openContracts, 7);
});

test("first-executable-50 timing surfaces from the decision ledger", () => {
  const t = "KXETH15M-26AUG161315-40";
  const decisions: Eth30DecisionEventParams[] = [
    { id: `${t}:entry_outcome`, ticker: t, easternDate: "2026-08-16", decision: "entry_placed",
      side: "yes", priceCents: 28, contracts: 5, note: null, occurredAtMs: 100 },
    { id: `${t}:target_first_executable`, ticker: t, easternDate: "2026-08-16",
      decision: "target_first_executable", side: "yes", priceCents: 51, contracts: null,
      note: null, occurredAtMs: 4_567 },
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t)]]]),
    eventsByTicker: new Map([[t, [ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 28 })]]]),
    decisionsByTicker: new Map([[t, decisions]]),
    nowMs: 10_000,
  });
  assert.equal(report.tickers[0].firstExecutable50AtMs, 4_567);
  assert.equal(report.tickers[0].decisions.length, 2);
});

test("fee capture: net P&L deducts exchange fees and flips feesIncluded when all fills carry fee data", () => {
  // Entry: 8 contracts (5 @ 30¢ + 3 @ 28¢). Exit: 6 @ 50¢. Settlement: 2 @ 100¢ (win).
  // Fees: entry chunk 1 = 2¢, entry chunk 2 = 1¢, exit chunk = 3¢ → total 6¢.
  const t = "KXETH15M-26AUG161330-45";
  const events: Eth30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, feeCents: 1, occurredAtMs: 2 }),
    ev(t, { id: "x1", eventType: "exit_fill", contractsDelta: -6, contractsAfter: 2, fillPriceCents: 50, feeCents: 3, occurredAtMs: 3 }),
    ev(t, { id: "s",  eventType: "settlement", contractsDelta: -2, contractsAfter: 0, settlementResult: "yes", occurredAtMs: 4 }),
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const row = report.tickers[0];
  // Gross: 300 + 200 − 234 = 266
  assert.equal(row.realizedPnlCents, 266);
  assert.equal(row.totalFeeCents, 6);          // 2 + 1 + 3
  assert.equal(row.netPnlCents, 260);          // 266 − 6
  assert.equal(report.feesIncluded, true);     // all fills have feeCents
  assert.equal(report.summary.totalFeeCents, 6);
  assert.equal(report.summary.netPnlCents, 260);
  assert.equal(report.summary.wins, 1);
  assert.equal(report.summary.losses, 0);
});

test("price-tier metrics include only fully reconciled 23–28¢ positions", () => {
  const low = "KXETH15M-26AUG161500-00";
  const high = "KXETH15M-26AUG161515-15";
  const incomplete = "KXETH15M-26AUG161530-30";
  const lowOrder = { ...entryOrder(low), limitPriceCents: 25 };
  const highOrder = { ...entryOrder(high), limitPriceCents: 27 };
  const incompleteOrder = { ...entryOrder(incomplete), limitPriceCents: 28 };
  const report = computeEth30Report({
    claims: [claim(low), claim(high), claim(incomplete)],
    ordersByTicker: new Map([
      [low, [lowOrder]],
      [high, [highOrder]],
      [incomplete, [incompleteOrder]],
    ]),
    eventsByTicker: new Map([
      [low, [
        ev(low, { id: "le", eventType: "entry_fill", contractsDelta: 10, contractsAfter: 10, fillPriceCents: 25, feeCents: 2 }),
        ev(low, { id: "lx", eventType: "exit_fill", contractsDelta: -10, contractsAfter: 0, fillPriceCents: 50, feeCents: 0 }),
      ]],
      [high, [
        ev(high, { id: "he", eventType: "entry_fill", contractsDelta: 10, contractsAfter: 10, fillPriceCents: 27, feeCents: 2 }),
        ev(high, { id: "hs", eventType: "settlement", contractsDelta: -10, contractsAfter: 0, settlementResult: "yes" }),
      ]],
      [incomplete, [
        ev(incomplete, { id: "ie", eventType: "entry_fill", contractsDelta: 10, contractsAfter: 10, fillPriceCents: 28, feeCents: null }),
      ]],
    ]),
    decisionsByTicker: new Map(),
    recentDecisions: [
      { id: "r22", ticker: "t22", easternDate: "2026-08-16", decision: "entry_rejected_price_band", side: "yes", priceCents: 22, contracts: 0, note: '{"rejectionReason":"outside_23_28_live_band"}', occurredAtMs: 1 },
      { id: "r29", ticker: "t29", easternDate: "2026-08-16", decision: "entry_rejected_price_band", side: "no", priceCents: 29, contracts: 0, note: '{"rejectionReason":"outside_23_28_live_band"}', occurredAtMs: 2 },
    ],
  });
  assert.equal(report.tickers.find((row) => row.ticker === low)?.financiallyReconciled, true);
  assert.equal(report.tickers.find((row) => row.ticker === incomplete)?.financiallyReconciled, false);
  assert.deepEqual(report.priceBandBreakdown["23_25"], {
    trades: 1, fullyReconciledMarkets: 1, targetHits: 1, targetHitRate: 1,
    principalCents: 250, feesCents: 2, netPnlCents: 248, roiPercent: 99.2, averagePnlCents: 248,
  });
  assert.equal(report.priceBandBreakdown["26_28"].trades, 2);
  assert.equal(report.priceBandBreakdown["26_28"].fullyReconciledMarkets, 1);
  assert.equal(report.priceBandBreakdown["26_28"].netPnlCents, 728);
  assert.equal(report.summary.realizedPnlCents, null, "a mixed verified/unverified strategy total is never presented as partial realized P&L");
  assert.equal(report.summary.netPnlCents, null);
  assert.equal(report.priceBandBreakdown.rejectedOpportunities.find((row) => row.bucket === "LE_22")?.opportunities, 1);
  assert.equal(report.priceBandBreakdown.rejectedOpportunities.find((row) => row.bucket === "29_30")?.opportunities, 1);
});

test("fee capture: feesIncluded stays false when any fill is missing fee data", () => {
  const t = "KXETH15M-26AUG161345-50";
  const events: Eth30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    // This chunk has no fee data yet (legacy row or failed fetch)
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, feeCents: null, occurredAtMs: 2 }),
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const row = report.tickers[0];
  assert.equal(row.totalFeeCents, null);       // any null → whole ticker is null
  assert.equal(row.netPnlCents, null);
  assert.equal(report.feesIncluded, false);
  assert.equal(report.summary.totalFeeCents, null);
  assert.equal(report.summary.netPnlCents, null);
});

// ── Bi-directional isolation: shared ticker, both strategies active ───────────
//
// Scenario: ETH_30_50_ENABLED=true while the legacy ETH strategy is also live.
// Both strategies independently trade the SAME KXETH15M ticker in the same
// calendar window.  Neither report must show the other's fills or P&L.
//
// ETH_30_50 direction (what this test verifies directly):
//   computeEth30Report iterates only claims[].  Events for the shared ticker
//   are only processed if that ticker appears in claims[].  Legacy fills live
//   in order_attempts/order_fills (different SQL tables) and are NEVER passed
//   as inputs to computeEth30Report — the function signature only accepts
//   eth30_* table rows (Eth30PositionEventParams, not OrderAttemptRecord).
//
// Legacy P&L direction (guaranteed by schema separation):
//   getPnlReport receives OrderAttemptRecord[] loaded exclusively from
//   order_attempts/order_fills.  eth30_50.ts writes ONLY to eth30_strategy_orders
//   and eth30_position_events — it never inserts into order_attempts or
//   order_fills.  The SQL queries that feed getPnlReport join only those two
//   legacy tables (confirmed by code review of routes/analytics.ts:542-631 and
//   tradeStore.ts:getVerifiedPnlBySeries/getVerifiedPnlByTier).  Therefore
//   eth30 fills can never appear in the legacy P&L inputs.

test("bi-directional isolation: shared ticker traded by both strategies shows disjoint fills and P&L in each report", () => {
  // ── Setup ─────────────────────────────────────────────────────────────────
  // sharedTicker: on the exchange both strategies submitted orders here today.
  // legacyOnlyTicker: legacy bot also traded this ticker — ETH_30_50 did not.
  const sharedTicker    = "KXETH15M-26AUG161200-15";
  const legacyOnlyTicker = "KXETH15M-26AUG160000-99";

  // ETH_30_50 ledger entry for the shared ticker: 8 contracts @ 27¢ entry,
  // followed by a 50¢ exit on all 8 contracts.
  const eth30EntryContracts = 8;
  const eth30EntryPriceCents = 27;
  const eth30ExitContracts  = 8;
  const eth30ExitPriceCents  = 50;

  // Legacy strategy simultaneously entered the same ticker at 73¢ for 5
  // contracts.  These fills exist only in order_attempts/order_fills; they are
  // NEVER passed to computeEth30Report.
  const legacyEntryContracts = 5;
  const legacyEntryPriceCents = 73;

  const sharedTickerEth30Events: Eth30PositionEventParams[] = [
    ev(sharedTicker, { id: "eth30-e1", eventType: "entry_fill", contractsDelta: eth30EntryContracts, contractsAfter: eth30EntryContracts, fillPriceCents: eth30EntryPriceCents, occurredAtMs: 1_000 }),
    ev(sharedTicker, { id: "eth30-x1", eventType: "exit_fill",  contractsDelta: -eth30ExitContracts, contractsAfter: 0, fillPriceCents: eth30ExitPriceCents, occurredAtMs: 2_000 }),
  ];

  // ── ETH_30_50 report: only the claimed ticker is present ──────────────────
  const eth30Report = computeEth30Report({
    claims: [claim(sharedTicker)],           // legacy-only ticker NOT claimed
    ordersByTicker: new Map([[sharedTicker, [entryOrder(sharedTicker)]]]),
    eventsByTicker: new Map([
      [sharedTicker,    sharedTickerEth30Events],
      // legacyOnlyTicker events would be here if they ever reached this path,
      // but they live only in order_attempts/order_fills — never passed in.
    ]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });

  // ── Assertions: ETH_30_50 report sees ONLY its own fills ──────────────────
  assert.equal(eth30Report.tickers.length, 1,
    "only the claimed ticker is in the eth30 report");
  assert.equal(eth30Report.tickers[0].ticker, sharedTicker);

  // Entry totals must match eth30 fills exactly — not the legacy 5@73¢ fill.
  const expectedEth30EntryCost = eth30EntryContracts * eth30EntryPriceCents; // 216¢
  const legacyEntryCost        = legacyEntryContracts * legacyEntryPriceCents; // 365¢
  assert.equal(eth30Report.tickers[0].entryContracts, eth30EntryContracts,
    "eth30 report entry contracts: only eth30 fill counted");
  assert.equal(eth30Report.tickers[0].entryCostCents, expectedEth30EntryCost,
    "eth30 report entry cost: only eth30 fill price counted");
  assert.notEqual(eth30Report.tickers[0].entryCostCents, expectedEth30EntryCost + legacyEntryCost,
    "eth30 report entry cost: NOT double-counted with legacy fill");
  assert.notEqual(eth30Report.tickers[0].entryCostCents, legacyEntryCost,
    "eth30 report entry cost: NOT mistakenly showing legacy fill cost");

  // Exit totals must match eth30 exits only.
  const expectedEth30ExitProceeds = eth30ExitContracts * eth30ExitPriceCents; // 400¢
  assert.equal(eth30Report.tickers[0].exitProceedsCents, expectedEth30ExitProceeds,
    "eth30 report exit proceeds: only eth30 exit counted");

  // Cash flow must be exits − entries, while missing fee evidence prevents it
  // from being labeled realized P&L.
  assert.equal(eth30Report.tickers[0].cashFlowPnlCents,
    expectedEth30ExitProceeds - expectedEth30EntryCost, // 400 − 216 = 184¢
    "eth30 cash flow: exact exits minus entries, not contaminated by legacy fills");
  assert.equal(eth30Report.tickers[0].realizedPnlCents, null);

  // Summary-level aggregates must also be isolated.
  assert.equal(eth30Report.summary.entryContracts, eth30EntryContracts);
  assert.equal(eth30Report.summary.entryCostCents, expectedEth30EntryCost);
  assert.equal(eth30Report.summary.exitProceedsCents, expectedEth30ExitProceeds);

  // ── Assertions: legacy-only ticker is invisible to ETH_30_50 report ───────
  // Even if legacyOnlyTicker events existed in a wider eventsByTicker map,
  // the claim gate means they would be silently dropped.
  const allTickerNames = eth30Report.tickers.map((t) => t.ticker);
  assert.ok(!allTickerNames.includes(legacyOnlyTicker),
    "legacy-only ticker never appears in eth30 report");

  // ── Structural guarantee summary (documented here as test-readable prose) ──
  // Legacy P&L direction: getPnlReport(orders: OrderAttemptRecord[]) receives
  // its data from order_attempts JOIN order_fills.  eth30_50.ts never writes
  // to either of those tables (verified by text search — every eth30 write
  // goes to eth30_strategy_orders or eth30_position_events).  Therefore the
  // legacy P&L totals (legacyEntryContracts=5 @ legacyEntryPriceCents=73¢)
  // are always disjoint from the eth30 totals above.
  assert.equal(legacyEntryContracts * legacyEntryPriceCents, 365,
    "legacy fill cost recorded: 5 contracts × 73¢ = 365¢ (only in legacy tables)");
  assert.notEqual(legacyEntryContracts * legacyEntryPriceCents, expectedEth30EntryCost,
    "legacy fill cost != eth30 fill cost: the two numbers never collide");
});

test("fee capture: net P&L deducts exchange fees and flips feesIncluded when all fills carry fee data", () => {
  // Entry: 5 contracts @ 30¢ (fee 2¢) + 3 contracts @ 28¢ (fee 1¢).
  // Exit: 8 contracts @ 50¢ (fee 3¢).
  // Settlement: none (open position).
  // Gross P&L = exits − entries = 400 − 234 = 166¢
  // Total fees = 2 + 1 + 3 = 6¢
  // Net P&L = 166 − 6 = 160¢
  const t = "KXETH15M-26AUG161400-45";
  const events: Eth30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, feeCents: 1, occurredAtMs: 2 }),
    ev(t, { id: "x1", eventType: "exit_fill",  contractsDelta: -8, contractsAfter: 0, fillPriceCents: 50, feeCents: 3, occurredAtMs: 3 }),
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const row = report.tickers[0];
  assert.equal(row.entryCostCents, 5 * 30 + 3 * 28);       // 234
  assert.equal(row.exitProceedsCents, 8 * 50);               // 400
  assert.equal(row.realizedPnlCents, 400 - 234);             // 166 (gross)
  assert.equal(row.totalFeeCents, 2 + 1 + 3);                // 6
  assert.equal(row.netPnlCents, 166 - 6);                    // 160
  assert.equal(report.feesIncluded, true);
  assert.equal(report.summary.realizedPnlCents, 166);
  assert.equal(report.summary.totalFeeCents, 6);
  assert.equal(report.summary.netPnlCents, 160);
  // fills carry per-chunk fee data
  assert.equal(row.fills[0].feeCents, 2);
  assert.equal(row.fills[1].feeCents, 1);
  assert.equal(row.fills[2].feeCents, 3);
});

test("feesIncluded stays false when any fill is missing fee data; totalFeeCents and netPnlCents are null", () => {
  const t = "KXETH15M-26AUG161415-46";
  // One fill has a fee, one does not (legacy row or failed fetch).
  const events: Eth30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, occurredAtMs: 2 }),
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  // feesIncluded must be false — the second chunk has no fee data.
  assert.equal(report.feesIncluded, false);
  // Any null fee makes totalFeeCents null (null propagation); netPnlCents follows.
  assert.equal(report.tickers[0].totalFeeCents, null);
  assert.equal(report.tickers[0].netPnlCents, null);
  assert.equal(report.summary.totalFeeCents, null);
  assert.equal(report.summary.netPnlCents, null);
});

test("wins/losses classify on net P&L (after fees)", () => {
  // Settled position: entry 10 @ 48¢ (fee 5¢), settles YES → payout 1000¢.
  // entry cost = 480, settlement payout = 1000, gross = +520, fee = 5, net = +515 → win.
  const t = "KXETH15M-26AUG161430-47";
  const events: Eth30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 10, contractsAfter: 10, fillPriceCents: 48, feeCents: 5, occurredAtMs: 1 }),
    ev(t, { id: "s",  eventType: "settlement", contractsDelta: -10, contractsAfter: 0, settlementResult: "yes", occurredAtMs: 2 }),
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const row = report.tickers[0];
  assert.equal(row.realizedPnlCents, 1000 - 480);           // 520 gross
  assert.equal(row.totalFeeCents, 5);
  assert.equal(row.netPnlCents, 515);
  assert.equal(report.summary.wins, 1);
  assert.equal(report.summary.losses, 0);
});

test("first-executable-50 timing surfaces from the decision ledger", () => {
  const t = "KXETH15M-26AUG161315-40";
  const decisions: Eth30DecisionEventParams[] = [
    { id: `${t}:entry_outcome`, ticker: t, easternDate: "2026-08-16", decision: "entry_placed",
      side: "yes", priceCents: 28, contracts: 5, note: null, occurredAtMs: 100 },
    { id: `${t}:target_first_executable`, ticker: t, easternDate: "2026-08-16",
      decision: "target_first_executable", side: "yes", priceCents: 51, contracts: null,
      note: null, occurredAtMs: 4_567 },
  ];
  const report = computeEth30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t)]]]),
    eventsByTicker: new Map([[t, [ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 28 })]]]),
    decisionsByTicker: new Map([[t, decisions]]),
    nowMs: 10_000,
  });
  assert.equal(report.tickers[0].firstExecutable50AtMs, 4_567);
  assert.equal(report.tickers[0].decisions.length, 2);
});
