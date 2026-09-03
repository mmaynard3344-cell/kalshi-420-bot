/**
 * Standalone replay report.
 * Build + run via: pnpm --filter @workspace/api-server replay-report [date]
 */

import { readFileSync } from "node:fs";
import { join }         from "node:path";
import { runReplay }    from "../strategy/replayRunner.js";
import type { ReplayTick, TimeBucket, BucketSeriesBreakdown, PriceBandBreakdown } from "../strategy/types.js";

const DATA_DIR = join(process.cwd(), "data");

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11,
};

function reconstructCloseTime(ticker: string): string | null {
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})(\d{4})-\d+$/);
  if (!m) return null;
  const yr = m[1], mon = m[2], day = m[3], hhmm = m[4];
  const year  = 2000 + parseInt(yr, 10);
  const month = MONTHS[mon];
  const hh    = parseInt(hhmm.slice(0, 2), 10);
  const mm    = parseInt(hhmm.slice(2),    10);
  // Eastern in July = UTC−4
  return new Date(Date.UTC(year, month, parseInt(day, 10), hh + 4, mm, 0)).toISOString();
}

function loadTicks(date: string): ReplayTick[] {
  const path = join(DATA_DIR, "analytics", `window-ticks-${date}.ndjson`);
  const closeCache = new Map<string, string | null>();
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try {
        const t = JSON.parse(line) as {
          ticker: string; timestampMs: number;
          yesBid: number | null; yesAsk: number | null;
          noBid: number | null;  noAsk: number | null;
        };
        if (!closeCache.has(t.ticker)) closeCache.set(t.ticker, reconstructCloseTime(t.ticker));
        const ct = closeCache.get(t.ticker);
        if (!ct) return [] as ReplayTick[];
        return [{
          ticker:      t.ticker,
          closeTime:   ct,
          yesBid:      t.yesBid ?? null,
          yesAsk:      t.yesAsk ?? null,
          noBid:       t.noBid  ?? null,
          noAsk:       t.noAsk  ?? null,
          timestampMs: t.timestampMs,
        }] as ReplayTick[];
      } catch { return [] as ReplayTick[]; }
    });
  } catch { return []; }
}

function loadMarketResults(dates: string[]): Map<string, "yes" | "no"> {
  const out = new Map<string, "yes" | "no">();

  // 1. Orders NDJSON (per-day, only windows we actually traded)
  for (const date of dates) {
    const path = join(DATA_DIR, "analytics", `orders-${date}.ndjson`);
    try {
      readFileSync(path, "utf8").split("\n").filter(Boolean).forEach(line => {
        try {
          const rec = JSON.parse(line) as { ticker?: string; marketResult?: string };
          if (rec.ticker && (rec.marketResult === "yes" || rec.marketResult === "no")) {
            out.set(rec.ticker, rec.marketResult);
          }
        } catch {}
      });
    } catch {}
  }

  // 2. Market result cache (broader — covers all resolved tickers the bot has seen)
  try {
    const cache = JSON.parse(readFileSync(join(DATA_DIR, "market-result-cache.json"), "utf8")) as
      Record<string, string>;
    for (const [ticker, result] of Object.entries(cache)) {
      if (result === "yes" || result === "no") out.set(ticker, result);
    }
  } catch {}

  // 3. Window log (per-window outcomes including non-traded windows)
  try {
    const entries = JSON.parse(readFileSync(join(DATA_DIR, "window-log.json"), "utf8")) as
      Array<{ ticker?: string; marketResult?: string }>;
    for (const e of entries) {
      if (e.ticker && (e.marketResult === "yes" || e.marketResult === "no")) {
        out.set(e.ticker, e.marketResult);
      }
    }
  } catch {}

  return out;
}

// ── Formatting ────────────────────────────────────────────────────────────────

const pct    = (v: number | null): string => v === null ? "  n/a " : `${(v*100).toFixed(1).padStart(5)}%`;
const dollar = (v: number):        string => `${v >= 0 ? " " : "-"}$${Math.abs(v).toFixed(2)}`.padStart(8);
const num    = (v: number, w = 4): string => String(v).padStart(w);
const cents  = (v: number | null): string => v === null ? "  n/a " : `${v.toFixed(1)}c`.padStart(7);
const ev     = (v: number | null): string =>
  v === null ? "   n/a    " : `${v >= 0 ? " " : "-"}$${Math.abs(v).toFixed(3)}`.padStart(10);

const DIV = "─".repeat(115);

function printBuckets(
  buckets: TimeBucket[],
  title:   string,
  pick:    (b: TimeBucket) => Pick<BucketSeriesBreakdown, keyof BucketSeriesBreakdown> & { avgEntryPriceCents?: number | null } =
    (b) => b as unknown as BucketSeriesBreakdown,
): void {
  console.log(`\n${DIV}\n${title}\n${DIV}`);
  console.log("Bucket     │Cand│Fill│ Win│Loss│WinRate│  P&L   │  Cost  │  ROI  │AvgEntry│  EV/Ct   │Cts");
  console.log(DIV);
  for (const b of buckets) {
    const s = pick(b) as BucketSeriesBreakdown & { avgEntryPriceCents?: number | null };
    console.log([
      b.label.padEnd(10),
      num(s.candidateTrades),
      num(s.executableCandidates),
      num(s.wins),
      num(s.losses),
      pct(s.winRate),
      dollar(s.totalPnlDollars),
      dollar(s.totalCostDollars),
      pct(s.roi),
      cents("avgEntryPriceCents" in s ? (s.avgEntryPriceCents as number | null) : null),
      ev(s.evPerContract),
      num(s.totalContracts),
    ].join(" │"));
  }
}

function printPriceBands(bands: PriceBandBreakdown[]): void {
  console.log(`\n${DIV}\nPrice-band breakdown (fill price in outcome-side ¢)\n${DIV}`);
  console.log("Band    │Fill│ Win│Loss│WinRate│  P&L   │  Cost  │  ROI  │  EV/Ct   │Cts");
  console.log("─".repeat(90));
  for (const b of bands) {
    console.log([
      b.label.padEnd(7),
      num(b.executableCandidates),
      num(b.wins),
      num(b.losses),
      pct(b.winRate),
      dollar(b.totalPnlDollars),
      dollar(b.totalCostDollars),
      pct(b.roi),
      ev(b.evPerContract),
      num(b.totalContracts),
    ].join(" │"));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dates = args.length > 0 ? args : [today];

const LINE = "═".repeat(115);
console.log(`\n${LINE}\n  Replay report — ${dates.join(", ")}\n${LINE}`);

const ticks = dates.flatMap(d => loadTicks(d)).sort((a, b) => a.timestampMs - b.timestampMs);
console.log(`  Ticks loaded : ${ticks.length}`);

const marketResults = loadMarketResults(dates);
console.log(`  Mkt results  : ${marketResults.size} tickers`);
if (marketResults.size > 0) {
  const sample = [...marketResults.entries()].slice(0, 3).map(([t, r]) => `${t}→${r}`).join(", ");
  console.log(`  Sample       : ${sample}`);
}

if (ticks.length === 0) {
  console.log("\nNo tick data — pass a date: node .replay-report.mjs 2026-07-30");
  process.exit(0);
}

const result = runReplay(ticks, {
  persist:       true,
  marketResults,
  config: {
    betDollarsByTicker: { KXBTC15M: 500, KXETH15M: 500 },
  },
});

const s = result.summary;
console.log(`\n  Replay ID    : ${result.replayId}`);
console.log(`  Ticks eval   : ${s.ticksEvaluated}`);
console.log(`  Windows      : ${s.windowsEntered}`);
console.log(`  Sim trades   : ${s.tradeCount}`);
console.log(`  Zero-fills   : ${s.zeroFillCount}`);
console.log(`  Guard-skipped: ${s.skippedByGuard}`);
console.log(`  OOZ-skipped  : ${s.skippedOutOfZone}`);
console.log(`  Sim spend    : $${s.totalSpentDollars.toFixed(2)}`);
console.log(`  Mkt results  : ${marketResults.size} tickers`);

if (result.timeBuckets) {
  printBuckets(result.timeBuckets, "Time-bucket breakdown — ALL series");
  printBuckets(result.timeBuckets, "Time-bucket breakdown — BTC (KXBTC15M)", b => b.btc);
  printBuckets(result.timeBuckets, "Time-bucket breakdown — ETH (KXETH15M)", b => b.eth);
}

if (result.priceBands) {
  printPriceBands(result.priceBands);
}

console.log(`\n  ✓ Saved: data/replays/${result.replayId}.json`);
console.log(`${LINE}\n`);
