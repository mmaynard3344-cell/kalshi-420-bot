/**
 * Chronological holdout validation for pre-declared replay candidates.
 *
 * Discovery:  2026-07-30 through 2026-08-04 (Eastern ticker-close date)
 * Holdout:    2026-08-05 through 2026-08-07 (Eastern ticker-close date)
 *
 * This script only reads the saved replay and settlement audits, then writes a
 * JSON analysis artifact. It never invokes the live strategy or writes to SQL.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const data = join(root, "data");
const replay = JSON.parse(readFileSync(join(data, "replays", "3c74e738-ae65-4f44-ba40-c2ae1a9ad9ba.json"), "utf8"));
const outcomes = JSON.parse(readFileSync(join(data, "analysis", "replay-3c74e738-analysis-result-map.json"), "utf8"));
const backfill = JSON.parse(readFileSync(join(data, "analysis", "replay-3c74e738-kalshi-market-results-backfill-audit.json"), "utf8"));
const output = join(data, "analysis", "replay-3c74e738-chronological-holdout-validation.json");

for (const row of backfill.rows ?? []) {
  if ((row.action === "inserted_kalshi_verified" || row.action === "unchanged_existing")
    && (row.result === "yes" || row.result === "no")) outcomes[row.ticker] = row.result;
}

const z = 1.959963984540054;
const round = (n, d = 4) => Number(n.toFixed(d));
const pct = (n) => n === null ? null : round(n * 100, 2);
function interval(wins, total) {
  if (!total) return null;
  const p = wins / total;
  const denom = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denom;
  return { lowPct: pct(center - margin), highPct: pct(center + margin) };
}
function sampleStatus(n) {
  return n < 10 ? "very_small" : n < 30 ? "small" : n < 100 ? "preliminary" : "meaningful";
}
function fee(price, contracts) {
  const p = price / 100;
  return Math.ceil(0.07 * contracts * p * (1 - p) * 100) / 100;
}
function tickerDate(ticker) {
  const match = ticker.match(/-\d{2}[A-Z]{3}\d{2}\d{4}-\d+$/);
  if (!match) return null;
  const part = match[0].slice(1, 8);
  const year = `20${part.slice(0, 2)}`;
  const months = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
  return `${year}-${months[part.slice(2, 5)]}-${part.slice(5, 7)}`;
}
function latestPrior(history, target) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].tickMs <= target) return history[i];
  return null;
}

const history = new Map();
const fills = [];
for (const record of replay.records) {
  const list = history.get(record.ticker) ?? [];
  list.push(record);
  history.set(record.ticker, list);
  for (const sim of record.simResults ?? []) {
    if (!sim.fill || !["buy_yes", "buy_no"].includes(sim.decision?.action)) continue;
    const side = sim.decision.action === "buy_yes" ? "yes" : "no";
    const outcome = outcomes[record.ticker];
    if (outcome !== "yes" && outcome !== "no") continue;
    const price = sim.fill.priceCents;
    const contracts = sim.fill.contracts;
    const won = outcome === side;
    const cost = sim.fill.dollarsCost;
    fills.push({
      ticker: record.ticker,
      date: tickerDate(record.ticker),
      asset: record.series === "KXBTC15M" ? "BTC" : "ETH",
      side, won, price, contracts, cost,
      fee: fee(price, contracts),
      gross: won ? contracts - cost : -cost,
      gap: side === "yes" ? price - record.yesBid : price - record.noBid,
      tickMs: record.tickMs,
      yesBid: record.yesBid,
      noBid: record.noBid,
    });
  }
}
for (const row of fills) {
  const prior = latestPrior(history.get(row.ticker) ?? [], row.tickMs - 10_000);
  const current = row.side === "yes" ? row.yesBid : row.noBid;
  const previous = prior ? (row.side === "yes" ? prior.yesBid : prior.noBid) : null;
  row.change10 = current !== null && previous !== null ? current - previous : null;
}
if (fills.length !== 144) throw new Error(`Expected 144 settled fills; got ${fills.length}.`);

function metric(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.won).length;
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const fees = rows.reduce((s, r) => s + r.fee, 0);
  const net = rows.reduce((s, r) => s + r.gross, 0) - fees;
  return {
    settled: n, wins, losses: n - wins,
    winRatePct: n ? pct(wins / n) : null,
    winRateCi95: interval(wins, n),
    sampleStatus: sampleStatus(n),
    modeledNetPnlAfterFees: round(net, 2),
    modeledRoiAfterFeesPct: cost ? pct(net / cost) : null,
  };
}

const discovery = fills.filter((r) => r.date >= "2026-07-30" && r.date <= "2026-08-04");
const holdout = fills.filter((r) => r.date >= "2026-08-05" && r.date <= "2026-08-07");
if (discovery.length + holdout.length !== 144) throw new Error("Date split did not partition all fills.");

const candidates = [
  { id: "price_80_84", label: "Entry price 80–84¢", test: (r) => r.price >= 80 && r.price <= 84 },
  { id: "yes_side", label: "YES-side entry", test: (r) => r.side === "yes" },
  { id: "avoid_gap_3_plus", label: "Avoid 3¢+ executable gap (retain <3¢)", test: (r) => r.gap < 3 },
  { id: "rising_10s", label: "Rising same-side bid ≥2¢ over prior 10 seconds", test: (r) => r.change10 !== null && r.change10 >= 2 },
];

const report = {
  study: "Chronological holdout validation of pre-declared replay candidates",
  generatedAt: new Date().toISOString(),
  readonly: true,
  replayId: replay.replayId,
  split: {
    discovery: { dates: "2026-07-30 through 2026-08-04", ...metric(discovery) },
    holdout: { dates: "2026-08-05 through 2026-08-07", ...metric(holdout) },
    rule: "Candidates were specified before evaluating the holdout. Results remain observational: both segments come from the same saved replay run and share its simulated full-fill assumption.",
  },
  definitions: {
    feeModel: "Estimated Kalshi taker fee: ceil(0.07 × contracts × p × (1 − p) × 100) / 100.",
    gap: "Simulated fill price minus same-side best bid; retained <3¢.",
    path: "Same-side best-bid difference versus latest tick at or before 10 seconds before entry.",
  },
  candidates: candidates.map((candidate) => {
    const developmentRows = discovery.filter(candidate.test);
    const holdoutRows = holdout.filter(candidate.test);
    return {
      id: candidate.id,
      label: candidate.label,
      discovery: { ...metric(developmentRows), retainedTradesPct: pct(developmentRows.length / discovery.length) },
      holdout: { ...metric(holdoutRows), retainedTradesPct: pct(holdoutRows.length / holdout.length) },
      holdoutComparison: {
        baselineWinRatePct: metric(holdout).winRatePct,
        winRateDeltaPoints: holdoutRows.length ? round(metric(holdoutRows).winRatePct - metric(holdout).winRatePct, 2) : null,
        baselineModeledRoiAfterFeesPct: metric(holdout).modeledRoiAfterFeesPct,
        roiDeltaPoints: holdoutRows.length ? round(metric(holdoutRows).modeledRoiAfterFeesPct - metric(holdout).modeledRoiAfterFeesPct, 2) : null,
      },
    };
  }),
  conclusion: "No candidate is validation-ready from this holdout alone: the holdout is small and derived from the same replay capture. Use the figures only to decide which hypotheses merit a future independent capture-period replay.",
};

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${output}`);
console.log(JSON.stringify({ split: report.split, candidates: report.candidates }, null, 2));