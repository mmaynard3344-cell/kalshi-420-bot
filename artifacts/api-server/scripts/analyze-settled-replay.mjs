/**
 * Read-only settled replay cohort study.
 *
 * Uses the persisted replay output and its separately audited outcome map.
 * It does not invoke the strategy, contact Kalshi, write to SQL, or alter any
 * live-trading setting. The report is an observational screen, not a strategy
 * recommendation.
 *
 * Usage:
 *   cd artifacts/api-server && node scripts/analyze-settled-replay.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const replayPath = join(root, "data", "replays", "3c74e738-ae65-4f44-ba40-c2ae1a9ad9ba.json");
const outcomesPath = join(root, "data", "analysis", "replay-3c74e738-analysis-result-map.json");
const backfillAuditPath = join(root, "data", "analysis", "replay-3c74e738-kalshi-market-results-backfill-audit.json");
const outputPath = join(root, "data", "analysis", "replay-3c74e738-settled-cohort-study.json");

const replay = JSON.parse(readFileSync(replayPath, "utf8"));
const outcomes = JSON.parse(readFileSync(outcomesPath, "utf8"));
const backfillAudit = JSON.parse(readFileSync(backfillAuditPath, "utf8"));
for (const row of backfillAudit.rows ?? []) {
  if ((row.action === "inserted_kalshi_verified" || row.action === "unchanged_existing")
    && (row.result === "yes" || row.result === "no")) {
    outcomes[row.ticker] = row.result;
  }
}

const WILSON_Z = 1.959963984540054;
const round = (value, digits = 4) => Number(value.toFixed(digits));
const pct = (value) => value === null ? null : round(value * 100, 2);

function wilsonInterval(wins, total) {
  if (total === 0) return null;
  const p = wins / total;
  const denom = 1 + (WILSON_Z ** 2 / total);
  const center = (p + WILSON_Z ** 2 / (2 * total)) / denom;
  const margin = WILSON_Z * Math.sqrt((p * (1 - p) + WILSON_Z ** 2 / (4 * total)) / total) / denom;
  return { low: round(center - margin), high: round(center + margin) };
}

function sampleStatus(total) {
  if (total < 10) return "very_small";
  if (total < 30) return "small";
  if (total < 100) return "preliminary";
  return "meaningful";
}

function feeDollars(priceCents, contracts) {
  // Kalshi taker fee approximation: ceil(0.07 * C * p * (1-p)), p in dollars.
  // The replay has no recorded fee field, so this is explicitly modelled.
  const p = priceCents / 100;
  return Math.ceil(0.07 * contracts * p * (1 - p) * 100) / 100;
}

function priorAtOrBefore(history, targetMs) {
  let best = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].tickMs <= targetMs) {
      best = history[i];
      break;
    }
  }
  return best;
}

function addCohort(rows, label, predicate) {
  const selected = rows.filter(predicate);
  const total = selected.length;
  const wins = selected.filter((row) => row.won).length;
  const contracts = selected.reduce((sum, row) => sum + row.contracts, 0);
  const cost = selected.reduce((sum, row) => sum + row.costDollars, 0);
  const fees = selected.reduce((sum, row) => sum + row.feeDollars, 0);
  const grossPnl = selected.reduce((sum, row) => sum + row.grossPnlDollars, 0);
  const netPnl = grossPnl - fees;
  const ci = wilsonInterval(wins, total);
  return {
    label,
    settled: total,
    wins,
    losses: total - wins,
    winRate: total ? round(wins / total) : null,
    winRatePct: total ? pct(wins / total) : null,
    winRateCi95: ci && { lowPct: pct(ci.low), highPct: pct(ci.high) },
    sampleStatus: sampleStatus(total),
    retainedTradesPct: rows.length ? pct(total / rows.length) : null,
    contracts,
    costDollars: round(cost, 2),
    estimatedFeesDollars: round(fees, 2),
    grossPnlDollars: round(grossPnl, 2),
    netPnlAfterEstimatedFeesDollars: round(netPnl, 2),
    roiAfterEstimatedFees: cost ? round(netPnl / cost) : null,
    roiAfterEstimatedFeesPct: cost ? pct(netPnl / cost) : null,
    netEvPerContractDollars: contracts ? round(netPnl / contracts, 4) : null,
  };
}

const historyByTicker = new Map();
const fills = [];

for (const record of replay.records) {
  let history = historyByTicker.get(record.ticker);
  if (!history) {
    history = [];
    historyByTicker.set(record.ticker, history);
  }
  history.push(record);
  for (const result of record.simResults ?? []) {
    if (!result.fill || !["buy_yes", "buy_no"].includes(result.decision?.action)) continue;
    const side = result.decision.action === "buy_yes" ? "yes" : "no";
    const outcome = outcomes[record.ticker];
    if (outcome !== "yes" && outcome !== "no") continue;
    const priceCents = result.fill.priceCents;
    const contracts = result.fill.contracts;
    const won = outcome === side;
    const costDollars = result.fill.dollarsCost;
    const fee = feeDollars(priceCents, contracts);
    fills.push({
      ticker: record.ticker,
      asset: record.series === "KXBTC15M" ? "BTC" : record.series === "KXETH15M" ? "ETH" : record.series,
      side,
      outcome,
      won,
      tickMs: record.tickMs,
      secondsLeft: result.decision.secondsLeft ?? record.secondsLeft,
      priceCents,
      yesBid: record.yesBid,
      noBid: record.noBid,
      contracts,
      costDollars,
      feeDollars: fee,
      grossPnlDollars: won ? contracts - costDollars : -costDollars,
      spreadCents: side === "yes" && record.yesBid !== null ? priceCents - record.yesBid
        : side === "no" && record.noBid !== null ? priceCents - record.noBid
          : null,
    });
  }
}

for (const row of fills) {
  const history = historyByTicker.get(row.ticker) ?? [];
  const prior10 = priorAtOrBefore(history, row.tickMs - 10_000);
  const prior30 = priorAtOrBefore(history, row.tickMs - 30_000);
  const bidForSide = (record) => row.side === "yes" ? record?.yesBid : record?.noBid;
  const currentBid = row.side === "yes" ? row.yesBid : row.noBid;
  row.change10Cents = currentBid !== null && bidForSide(prior10) !== null && prior10 ? currentBid - bidForSide(prior10) : null;
  row.change30Cents = currentBid !== null && bidForSide(prior30) !== null && prior30 ? currentBid - bidForSide(prior30) : null;
  row.path10Available = row.change10Cents !== null;
  row.path30Available = row.change30Cents !== null;
}

if (fills.length !== 144) {
  throw new Error(`Expected 144 settled simulated fills; extracted ${fills.length}.`);
}

const base = addCohort(fills, "Baseline — all settled simulated fills", () => true);
const groups = {
  priceBands: [
    ["70–74¢", (row) => row.priceCents >= 70 && row.priceCents <= 74],
    ["75–79¢", (row) => row.priceCents >= 75 && row.priceCents <= 79],
    ["80–84¢", (row) => row.priceCents >= 80 && row.priceCents <= 84],
    ["85–89¢", (row) => row.priceCents >= 85 && row.priceCents <= 89],
  ],
  timeToClose: [
    ["≤60 seconds", (row) => row.secondsLeft <= 60],
    ["61–90 seconds", (row) => row.secondsLeft >= 61 && row.secondsLeft <= 90],
    ["91–120 seconds", (row) => row.secondsLeft >= 91 && row.secondsLeft <= 120],
    ["121–150 seconds", (row) => row.secondsLeft >= 121 && row.secondsLeft <= 150],
  ],
  asset: [["BTC", (row) => row.asset === "BTC"], ["ETH", (row) => row.asset === "ETH"]],
  side: [["YES", (row) => row.side === "yes"], ["NO", (row) => row.side === "no"]],
  executableSpread: [
    ["1¢ gap", (row) => row.spreadCents === 1],
    ["2¢ gap", (row) => row.spreadCents === 2],
    ["3¢+ gap", (row) => row.spreadCents !== null && row.spreadCents >= 3],
    ["Unavailable", (row) => row.spreadCents === null],
  ],
  gapFromTrigger: [
    ["0¢ (filled at trigger)", (row) => row.spreadCents === 0],
    ["1¢ (limit buffer)", (row) => row.spreadCents === 1],
    ["2¢+", (row) => row.spreadCents !== null && row.spreadCents >= 2],
  ],
  path10Seconds: [
    ["Falling ≥2¢", (row) => row.change10Cents !== null && row.change10Cents <= -2],
    ["Flat / ±1¢", (row) => row.change10Cents !== null && row.change10Cents >= -1 && row.change10Cents <= 1],
    ["Rising ≥2¢", (row) => row.change10Cents !== null && row.change10Cents >= 2],
    ["Unavailable", (row) => row.change10Cents === null],
  ],
  path30Seconds: [
    ["Falling ≥3¢", (row) => row.change30Cents !== null && row.change30Cents <= -3],
    ["Flat / ±2¢", (row) => row.change30Cents !== null && row.change30Cents >= -2 && row.change30Cents <= 2],
    ["Rising ≥3¢", (row) => row.change30Cents !== null && row.change30Cents >= 3],
    ["Unavailable", (row) => row.change30Cents === null],
  ],
};

const studyGroups = Object.fromEntries(
  Object.entries(groups).map(([name, definitions]) => [
    name,
    definitions.map(([label, predicate]) => addCohort(fills, label, predicate)),
  ]),
);

const intersections = [
  ["BTC · YES · 75–79¢", (row) => row.asset === "BTC" && row.side === "yes" && row.priceCents >= 75 && row.priceCents <= 79],
  ["ETH · YES · 75–79¢", (row) => row.asset === "ETH" && row.side === "yes" && row.priceCents >= 75 && row.priceCents <= 79],
  ["BTC · 91–120s · flat 10s", (row) => row.asset === "BTC" && row.secondsLeft >= 91 && row.secondsLeft <= 120 && row.change10Cents !== null && Math.abs(row.change10Cents) <= 1],
  ["ETH · 91–120s · flat 10s", (row) => row.asset === "ETH" && row.secondsLeft >= 91 && row.secondsLeft <= 120 && row.change10Cents !== null && Math.abs(row.change10Cents) <= 1],
].map(([label, predicate]) => addCohort(fills, label, predicate));

const report = {
  study: "Settled replay cohort screen",
  generatedAt: new Date().toISOString(),
  readonly: true,
  inputs: {
    replayId: replay.replayId,
    replayPath,
    settlementMapPath: outcomesPath,
    auditedBackfillPath: backfillAuditPath,
    replayConfig: replay.config,
    settledSimulatedFills: fills.length,
    settlementLabels: Object.keys(outcomes).length,
  },
  methodology: {
    outcomes: "Verified market-result map; a YES simulated entry wins only when the market result is yes, and vice versa for NO.",
    feeModel: "Estimated Kalshi taker fee = ceil(0.07 × contracts × p × (1 − p) × 100) / 100. Replay records do not contain actual fee rows.",
    executableSpread: "Derived executable ask (simulated fill price) minus same-side top bid. The source replay has no ask or L2 depth snapshots.",
    path: "Same-side top-bid change from the latest prior tick at or before 10 or 30 seconds before the simulated fill.",
    confidenceInterval: "Two-sided 95% Wilson binomial interval.",
    sampleGuidance: "very_small <10, small 10–29, preliminary 30–99, meaningful ≥100 settled trades. Cohorts are descriptive and were screened on the same dataset; none are out-of-sample validation.",
  },
  coverage: {
    depthAvailable: false,
    path10Available: fills.filter((row) => row.path10Available).length,
    path30Available: fills.filter((row) => row.path30Available).length,
  },
  baseline: base,
  cohorts: studyGroups,
  predeclaredIntersections: intersections,
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Wrote ${outputPath}`);
console.log(JSON.stringify({
  baseline: report.baseline,
  coverage: report.coverage,
  priceBands: report.cohorts.priceBands,
  timeToClose: report.cohorts.timeToClose,
  asset: report.cohorts.asset,
  side: report.cohorts.side,
  path10Seconds: report.cohorts.path10Seconds,
}, null, 2));