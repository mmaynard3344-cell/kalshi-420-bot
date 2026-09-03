import assert from "node:assert/strict";
import test from "node:test";
import { computeSol30Report } from "./sol30Report.js";
import type {
  Sol30TickerClaim,
  Sol30StrategyOrder,
  Sol30DecisionEventParams,
} from "./sol30Report.js";
import type { Sol30PositionEventParams } from "./sol30FillSync.js";

function claim(ticker: string, over: Partial<Sol30TickerClaim> = {}): Sol30TickerClaim {
  return { ticker, easternDate: "2026-08-16", claimedAtMs: 1_000, entryClientOrderId: `coid-${ticker}`, ...over };
}
function entryOrder(ticker: string, side: "yes" | "no" = "yes"): Sol30StrategyOrder {
  return {
    id: `entry:${ticker}`, ticker, easternDate: "2026-08-16", role: "entry", sequenceNumber: 0,
    clientOrderId: `coid-${ticker}`, kalshiOrderId: "k1", side, limitPriceCents: 28,
    requestedContracts: 10, outcome: "full_fill", filledContracts: 10, averageFillPriceCents: 28, updatedAtMs: 2_000,
  };
}
function ev(ticker: string, over: Partial<Sol30PositionEventParams> & Pick<Sol30PositionEventParams, "id" | "eventType" | "contractsDelta" | "contractsAfter">): Sol30PositionEventParams {
  return {
    ticker, easternDate: "2026-08-16", strategyOrderId: null, fillPriceCents: null,
    feeCents: null, settlementResult: null, note: null, occurredAtMs: 3_000, ...over,
  };
}

test("SOL_30_50 report ignores everything not covered by a durable SOL_30_50 claim (legacy isolation)", () => {
  // Events exist for a legacy SOL ticker that was never claimed by the
  // strategy — the report must not include or count them.
  const claimed = "KXSOL15M-26AUG161200-15";
  const legacy  = "KXSOL15M-26AUG160000-99";
  const events = new Map<string, Sol30PositionEventParams[]>([
    [claimed, [ev(claimed, { id: "a", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30 })]],
    [legacy,  [ev(legacy,  { id: "b", eventType: "entry_fill", contractsDelta: 99, contractsAfter: 99, fillPriceCents: 80 })]],
  ]);
  const report = computeSol30Report({
    claims: [claim(claimed)],
    ordersByTicker: new Map([[claimed, [entryOrder(claimed)]]]),
    eventsByTicker: events,
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  assert.equal(report.strategy, "SOL_30_50");
  assert.equal(report.source, "sol30_owned_ledgers_only");
  assert.equal(report.tickers.length, 1);
  assert.equal(report.tickers[0].ticker, claimed);
  assert.equal(report.summary.entryContracts, 5);
  assert.equal(report.summary.entryCostCents, 150); // 5 × 30¢
});

test("SOL_30_50 split-fill settlement arithmetic is exact per owned chunk", () => {
  // Entry split across two chunks (5 @ 30¢, 3 @ 28¢), exit split across two
  // 50¢ chunks (2 + 4), remaining 2 contracts settle as a win.
  const t = "KXSOL15M-26AUG161215-20";
  const events: Sol30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, occurredAtMs: 2 }),
    ev(t, { id: "x1", eventType: "exit_fill", contractsDelta: -2, contractsAfter: 6, fillPriceCents: 50, occurredAtMs: 3 }),
    ev(t, { id: "x2", eventType: "exit_fill", contractsDelta: -4, contractsAfter: 2, fillPriceCents: 50, occurredAtMs: 4 }),
    ev(t, { id: "s", eventType: "settlement", contractsDelta: -2, contractsAfter: 0, settlementResult: "yes", occurredAtMs: 5 }),
  ];
  const report = computeSol30Report({
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
  assert.equal(row.realizedPnlCents, 300 + 200 - 234); // 266
  assert.equal(row.openContracts, 0);
  assert.equal(row.status, "settled");
  assert.equal(report.summary.realizedPnlCents, 266);
  assert.equal(report.summary.wins, 1);
  assert.equal(report.summary.losses, 0);
  assert.equal(report.feesIncluded, false); // all feeCents are null
});

test("SOL_30_50 losing settlement pays zero and P&L nets exits against entry cost", () => {
  const t = "KXSOL15M-26AUG161230-25";
  const events: Sol30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 10, contractsAfter: 10, fillPriceCents: 25, occurredAtMs: 1 }),
    ev(t, { id: "x1", eventType: "exit_fill", contractsDelta: -4, contractsAfter: 6, fillPriceCents: 50, occurredAtMs: 2 }),
    ev(t, { id: "s", eventType: "settlement", contractsDelta: -6, contractsAfter: 0, settlementResult: "no", occurredAtMs: 3 }),
  ];
  const report = computeSol30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  const row = report.tickers[0];
  assert.equal(row.settlementPayoutCents, 0); // held yes, settled no → no payout
  assert.equal(row.realizedPnlCents, 200 + 0 - 250); // = -50
  assert.equal(row.status, "settled");
  assert.equal(report.summary.losses, 1);
});

test("SOL_30_50 open positions and no-fill claims are classified without settlement", () => {
  const open = "KXSOL15M-26AUG161245-30";
  const none = "KXSOL15M-26AUG161300-35";
  const report = computeSol30Report({
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
  assert.equal(byTicker[none].realizedPnlCents, 0);
  assert.equal(report.summary.tickersWithFills, 1);
  assert.equal(report.summary.realizedPnlCents, -140);
  assert.equal(report.summary.openContracts, 7);
});

test("SOL_30_50 first-executable-50 timing surfaces from the decision ledger", () => {
  const t = "KXSOL15M-26AUG161315-40";
  const decisions: Sol30DecisionEventParams[] = [
    { id: `${t}:entry_outcome`, ticker: t, easternDate: "2026-08-16", decision: "entry_placed",
      side: "yes", priceCents: 28, contracts: 5, note: null, occurredAtMs: 100 },
    { id: `${t}:target_first_executable`, ticker: t, easternDate: "2026-08-16",
      decision: "target_first_executable", side: "yes", priceCents: 51, contracts: null,
      note: null, occurredAtMs: 4_567 },
  ];
  const report = computeSol30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t)]]]),
    eventsByTicker: new Map([[t, [ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 28 })]]]),
    decisionsByTicker: new Map([[t, decisions]]),
    nowMs: 10_000,
  });
  assert.equal(report.tickers[0].firstExecutable50AtMs, 4_567);
  assert.equal(report.tickers[0].decisions.length, 2);
});

test("SOL_30_50 fee capture: net P&L deducts exchange fees and flips feesIncluded when all fills carry fee data", () => {
  // Entry: 8 contracts (5 @ 30¢ + 3 @ 28¢). Exit: 6 @ 50¢. Settlement: 2 @ 100¢ (win).
  // Fees: entry chunk 1 = 2¢, entry chunk 2 = 1¢, exit chunk = 3¢ → total 6¢.
  const t = "KXSOL15M-26AUG161330-45";
  const events: Sol30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, feeCents: 1, occurredAtMs: 2 }),
    ev(t, { id: "x1", eventType: "exit_fill", contractsDelta: -6, contractsAfter: 2, fillPriceCents: 50, feeCents: 3, occurredAtMs: 3 }),
    ev(t, { id: "s",  eventType: "settlement", contractsDelta: -2, contractsAfter: 0, settlementResult: "yes", occurredAtMs: 4 }),
  ];
  const report = computeSol30Report({
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

test("SOL_30_50 fee capture: feesIncluded stays false when any fill is missing fee data", () => {
  const t = "KXSOL15M-26AUG161345-50";
  const events: Sol30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    // This chunk has no fee data yet (legacy row or failed fetch)
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, feeCents: null, occurredAtMs: 2 }),
  ];
  const report = computeSol30Report({
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

test("SOL_30_50 bi-directional isolation: shared ticker shows disjoint fills and P&L", () => {
  const sharedTicker     = "KXSOL15M-26AUG161200-15";
  const legacyOnlyTicker = "KXSOL15M-26AUG160000-99";

  const eth30EntryContracts = 8;
  const eth30EntryPriceCents = 27;
  const eth30ExitContracts  = 8;
  const eth30ExitPriceCents  = 50;
  const legacyEntryContracts = 5;
  const legacyEntryPriceCents = 73;

  const sharedTickerEvents: Sol30PositionEventParams[] = [
    ev(sharedTicker, { id: "sol30-e1", eventType: "entry_fill", contractsDelta: eth30EntryContracts, contractsAfter: eth30EntryContracts, fillPriceCents: eth30EntryPriceCents, occurredAtMs: 1_000 }),
    ev(sharedTicker, { id: "sol30-x1", eventType: "exit_fill",  contractsDelta: -eth30ExitContracts, contractsAfter: 0, fillPriceCents: eth30ExitPriceCents, occurredAtMs: 2_000 }),
  ];

  const sol30Report = computeSol30Report({
    claims: [claim(sharedTicker)],
    ordersByTicker: new Map([[sharedTicker, [entryOrder(sharedTicker)]]]),
    eventsByTicker: new Map([[sharedTicker, sharedTickerEvents]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });

  assert.equal(sol30Report.tickers.length, 1);
  assert.equal(sol30Report.tickers[0].ticker, sharedTicker);

  const expectedEntryCost = eth30EntryContracts * eth30EntryPriceCents; // 216¢
  const legacyEntryCost   = legacyEntryContracts * legacyEntryPriceCents; // 365¢
  assert.equal(sol30Report.tickers[0].entryContracts, eth30EntryContracts);
  assert.equal(sol30Report.tickers[0].entryCostCents, expectedEntryCost);
  assert.notEqual(sol30Report.tickers[0].entryCostCents, expectedEntryCost + legacyEntryCost);

  const expectedExitProceeds = eth30ExitContracts * eth30ExitPriceCents; // 400¢
  assert.equal(sol30Report.tickers[0].exitProceedsCents, expectedExitProceeds);
  assert.equal(sol30Report.tickers[0].realizedPnlCents, expectedExitProceeds - expectedEntryCost); // 184¢

  const allTickerNames = sol30Report.tickers.map((t) => t.ticker);
  assert.ok(!allTickerNames.includes(legacyOnlyTicker));

  assert.equal(legacyEntryContracts * legacyEntryPriceCents, 365);
});

test("SOL_30_50 net P&L deducts fees (open position, no settlement)", () => {
  // Entry: 5 contracts @ 30¢ (fee 2¢) + 3 contracts @ 28¢ (fee 1¢).
  // Exit: 8 contracts @ 50¢ (fee 3¢).
  // Gross P&L = exits − entries = 400 − 234 = 166¢
  // Total fees = 2 + 1 + 3 = 6¢
  // Net P&L = 166 − 6 = 160¢
  const t = "KXSOL15M-26AUG161400-45";
  const events: Sol30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, feeCents: 1, occurredAtMs: 2 }),
    ev(t, { id: "x1", eventType: "exit_fill",  contractsDelta: -8, contractsAfter: 0, fillPriceCents: 50, feeCents: 3, occurredAtMs: 3 }),
  ];
  const report = computeSol30Report({
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
  assert.equal(row.fills[0].feeCents, 2);
  assert.equal(row.fills[1].feeCents, 1);
  assert.equal(row.fills[2].feeCents, 3);
});

test("SOL_30_50 feesIncluded stays false when any fill is missing fee data; totalFeeCents and netPnlCents are null", () => {
  const t = "KXSOL15M-26AUG161415-46";
  const events: Sol30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 5, contractsAfter: 5, fillPriceCents: 30, feeCents: 2, occurredAtMs: 1 }),
    ev(t, { id: "e2", eventType: "entry_fill", contractsDelta: 3, contractsAfter: 8, fillPriceCents: 28, occurredAtMs: 2 }),
  ];
  const report = computeSol30Report({
    claims: [claim(t)],
    ordersByTicker: new Map([[t, [entryOrder(t, "yes")]]]),
    eventsByTicker: new Map([[t, events]]),
    decisionsByTicker: new Map(),
    nowMs: 10_000,
  });
  assert.equal(report.feesIncluded, false);
  assert.equal(report.tickers[0].totalFeeCents, null);
  assert.equal(report.tickers[0].netPnlCents, null);
  assert.equal(report.summary.totalFeeCents, null);
  assert.equal(report.summary.netPnlCents, null);
});

test("SOL_30_50 wins/losses classify on net P&L (after fees)", () => {
  const t = "KXSOL15M-26AUG161430-47";
  const events: Sol30PositionEventParams[] = [
    ev(t, { id: "e1", eventType: "entry_fill", contractsDelta: 10, contractsAfter: 10, fillPriceCents: 48, feeCents: 5, occurredAtMs: 1 }),
    ev(t, { id: "s",  eventType: "settlement", contractsDelta: -10, contractsAfter: 0, settlementResult: "yes", occurredAtMs: 2 }),
  ];
  const report = computeSol30Report({
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
