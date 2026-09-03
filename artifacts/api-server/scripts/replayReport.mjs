/**
 * Replay report generator.
 *
 * Loads today's window-tick NDJSON + durable market results (with the legacy
 * analytics orders and local cache as fallbacks),
 * runs the offline replay engine, and prints the time-bucket and price-band
 * breakdown tables to stdout.
 *
 * Usage:
 *   node artifacts/api-server/scripts/replayReport.mjs [YYYY-MM-DD] [YYYY-MM-DD]
 *
 * Arguments are Eastern-time dates.  Defaults to today.
 * Pass two dates to aggregate across a range.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname }              from "node:path";
import { fileURLToPath }              from "node:url";
import pg                             from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, "..", "data");
const DIST_DIR  = join(__dirname, "..", "dist");

// replayRunner persists relative to process.cwd(). Anchor it to the API
// artifact so this script behaves the same whether launched from the workspace
// root or from artifacts/api-server.
process.chdir(join(__dirname, ".."));

// ── Load window ticks ─────────────────────────────────────────────────────────

function loadTicks(date) {
  const path = join(DATA_DIR, "analytics", `window-ticks-${date}.ndjson`);
  try {
    const raw   = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const ticks = [];
    for (const line of lines) {
      try {
        const t = JSON.parse(line);
        ticks.push({
          ticker:      t.ticker,
          closeTime:   null,          // not stored in window ticks; reconstructed from ticker
          yesBid:      t.yesBid      ?? null,
          yesAsk:      t.yesAsk      ?? null,
          noBid:       t.noBid       ?? null,
          noAsk:       t.noAsk       ?? null,
          timestampMs: t.timestampMs,
        });
      } catch {}
    }
    return ticks;
  } catch (e) {
    console.error(`No tick file for ${date}: ${e.message}`);
    return [];
  }
}

// ── Load market results: SQL first, legacy disk fallbacks second ───────────────

function loadMarketResultsFromOrders(dates) {
  const results = new Map();
  for (const date of dates) {
    const path = join(DATA_DIR, "analytics", `orders-${date}.ndjson`);
    try {
      const raw   = readFileSync(path, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec.ticker && rec.marketResult && rec.marketResult !== "pending") {
            results.set(rec.ticker, rec.marketResult);
          }
        } catch {}
      }
    } catch {}
  }
  return results;
}

function loadMarketResultsFromCache() {
  try {
    const cache = JSON.parse(readFileSync(join(DATA_DIR, "market-result-cache.json"), "utf8"));
    return new Map(Object.entries(cache).filter(([, result]) => result === "yes" || result === "no"));
  } catch {
    return new Map();
  }
}

async function loadMarketResultsFromSql(tickers) {
  if (!process.env.DATABASE_URL || tickers.length === 0) return new Map();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query(
      "SELECT ticker, result FROM market_results WHERE ticker = ANY($1::text[]) AND result IN ('yes', 'no')",
      [tickers],
    );
    return new Map(rows.map(({ ticker, result }) => [ticker, result]));
  } catch (error) {
    console.error(`  Durable market-results lookup unavailable: ${error.message}`);
    return new Map();
  } finally {
    await pool.end();
  }
}

// ── Reconstruct closeTime from ticker ─────────────────────────────────────────
// Ticker format: KXBTC15M-26JUL301915-15 → close time is 19:15 Eastern on 2026-07-30.
// The encoded date is YYMONDD (not DDMONYY).

function reconstructCloseTime(ticker) {
  // e.g. KXBTC15M-26JUL301915-15
  // date part: 26JUL30 → 2026-07-30
  // time part: 1915 → 19:15 Eastern
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})(\d{4})-\d+$/);
  if (!m) return null;
  const [, yr, mon, day, hhmm] = m;
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const year = 2000 + parseInt(yr, 10);
  const month = MONTHS[mon];
  if (month === undefined) return null;
  const hh = parseInt(hhmm.slice(0, 2), 10);
  const mm = parseInt(hhmm.slice(2),    10);

  // Convert the ticker's America/New_York wall time to UTC with the real
  // seasonal offset rather than assuming EDT. A second pass settles the
  // offset after the initial estimate crosses a DST boundary.
  const desiredWallMs = Date.UTC(year, month, parseInt(day, 10), hh, mm, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const easternOffsetMs = (utcMs) => {
    const values = Object.fromEntries(
      formatter.formatToParts(new Date(utcMs))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const easternWallMs = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    return easternWallMs - utcMs;
  };
  let utcMs = desiredWallMs - easternOffsetMs(desiredWallMs);
  utcMs = desiredWallMs - easternOffsetMs(utcMs);
  return new Date(utcMs).toISOString();
}

// ── Enrich ticks with closeTime ───────────────────────────────────────────────

function enrichTicks(ticks) {
  const closeTimeCache = new Map();
  return ticks.map(t => {
    if (!closeTimeCache.has(t.ticker)) {
      closeTimeCache.set(t.ticker, reconstructCloseTime(t.ticker));
    }
    return { ...t, closeTime: closeTimeCache.get(t.ticker) };
  });
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const pct  = (v) => v === null ? "  n/a  " : `${(v * 100).toFixed(1).padStart(5)}%`;
const $    = (v) => v === null ? "   n/a  " : `$${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(2)}`.padStart(8);
const num  = (v, w=5)  => String(v).padStart(w);
const cents = (v) => v === null ? "  n/a" : `${v.toFixed(1)}¢`.padStart(7);
const ev   = (v) => v === null ? "    n/a   " : `$${(v >= 0 ? "" : "-")}${Math.abs(v).toFixed(3)}`.padStart(10);

function printBuckets(timeBuckets, label) {
  const HDR = `\n${"─".repeat(120)}\n${label}\n${"─".repeat(120)}`;
  console.log(HDR);
  console.log(
    "Bucket     │ Cand │ Fill │ Win  │ Loss │WinRate│  P&L    │  Cost   │  ROI   │AvgEntry│ EV/Ct    │ Conts"
  );
  console.log("─".repeat(120));
  for (const b of timeBuckets) {
    const row = [
      b.label.padEnd(10),
      num(b.candidateTrades),
      num(b.executableCandidates),
      num(b.wins),
      num(b.losses),
      pct(b.winRate),
      $(b.totalPnlDollars),
      $(b.totalCostDollars),
      pct(b.roi),
      cents(b.avgEntryPriceCents),
      ev(b.evPerContract),
      num(b.totalContracts),
    ].join(" │ ");
    console.log(row);
  }
}

function printBucketSeries(timeBuckets, seriesKey, seriesLabel) {
  console.log(`\n  ── ${seriesLabel} ──`);
  console.log(
    "  Bucket     │ Cand │ Fill │ Win  │ Loss │WinRate│  P&L    │  Cost   │  ROI   │ EV/Ct"
  );
  console.log("  " + "─".repeat(90));
  for (const b of timeBuckets) {
    const s = b[seriesKey];
    const row = [
      "  " + b.label.padEnd(10),
      num(s.candidateTrades),
      num(s.executableCandidates),
      num(s.wins),
      num(s.losses),
      pct(s.winRate),
      $(s.totalPnlDollars),
      $(s.totalCostDollars),
      pct(s.roi),
      ev(s.evPerContract),
    ].join(" │ ");
    console.log(row);
  }
}

function printPriceBands(priceBands) {
  console.log(`\n${"─".repeat(100)}\nPrice-band breakdown\n${"─".repeat(100)}`);
  console.log(
    "Band     │ Fill │ Win  │ Loss │WinRate│  P&L    │  Cost   │  ROI   │ EV/Ct    │ Conts"
  );
  console.log("─".repeat(100));
  for (const b of priceBands) {
    const row = [
      b.label.padEnd(8),
      num(b.executableCandidates),
      num(b.wins),
      num(b.losses),
      pct(b.winRate),
      $(b.totalPnlDollars),
      $(b.totalCostDollars),
      pct(b.roi),
      ev(b.evPerContract),
      num(b.totalContracts),
    ].join(" │ ");
    console.log(row);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function datesInclusive(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end   = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error("Dates must be YYYY-MM-DD, with the start date on or before the end date.");
  }
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

const dates = args.length === 0 ? [today]
  : args.length === 1 ? args
  : datesInclusive(args[0], args[1]);

console.log(`\nReplay report — dates: ${dates.join(", ")}`);
console.log(`Loading ticks…`);

const rawTicks = dates.flatMap(d => loadTicks(d));
const ticks    = enrichTicks(rawTicks);

console.log(`  Loaded ${ticks.length} ticks`);

if (ticks.length === 0) {
  console.log("No tick data found. Try: node scripts/replayReport.mjs 2026-07-30");
  process.exit(0);
}

const orderResults = loadMarketResultsFromOrders(dates);
const cacheResults = loadMarketResultsFromCache();
const replayTickers = [...new Set(ticks.map((tick) => tick.ticker).filter(Boolean))];
const durableResults = await loadMarketResultsFromSql(replayTickers);
const marketResults = new Map([...cacheResults, ...orderResults, ...durableResults]);
console.log(
  `  Market results: ${marketResults.size} tickers ` +
  `(${durableResults.size} durable, ${orderResults.size} order-file, ${cacheResults.size} cache)`,
);

// Sort ascending by timestamp
ticks.sort((a, b) => a.timestampMs - b.timestampMs);

// ── Import replay runner from compiled bundle ─────────────────────────────────
let runReplayFn;
try {
  // The strategy modules are bundled into the main index.mjs.
  // We import the bundle and the runReplay function must be re-exported
  // from the routes layer.  If it is not, compile the strategy directly.
  const bundle = await import(join(DIST_DIR, "index.mjs") + `?t=${Date.now()}`);
  // index.mjs doesn't export runReplay — it's an Express app.
  // Build the strategy dir standalone.
  throw new Error("not exported from bundle");
} catch {
  // Compile the strategy module standalone using tsc or esbuild
  const { execSync } = await import("node:child_process");
  const stratDir     = join(__dirname, "..", "src", "strategy");
  const outDir       = join(__dirname, "..", ".strategy-tmp");
  try {
    execSync(
        `./node_modules/.bin/esbuild ${join(stratDir, "replayRunner.ts")} ` +
      `--bundle --format=esm --platform=node --outfile=${join(outDir, "replayRunner.mjs")} ` +
      `--external:crypto --external:fs --external:path`,
      { cwd: join(__dirname, ".."), stdio: "pipe" }
    );
    const mod = await import(join(outDir, "replayRunner.mjs") + `?t=${Date.now()}`);
    runReplayFn = mod.runReplay;
  } catch (e) {
    console.error("Failed to compile replay runner:", e.message);
    process.exit(1);
  }
}

// ── Run replay ────────────────────────────────────────────────────────────────
console.log(`\nRunning replay (timeAlertSeconds=150, fillAssumption=full)…`);

const result = runReplayFn(ticks, {
  persist: true,
  config: {
    timeAlertSeconds:   150,
    betDollarsByTicker: { KXBTC15M: 400, KXETH15M: 400 },
  },
  marketResults,
});

const s = result.summary;
console.log(`\nReplay ID  : ${result.replayId}`);
console.log(`Ticks eval : ${s.ticksEvaluated}`);
console.log(`Windows    : ${s.windowsEntered}`);
console.log(`Trades     : ${s.tradeCount}`);
console.log(`Zero-fills : ${s.zeroFillCount}`);
console.log(`Guard skips: ${s.skippedByGuard}`);
console.log(`OOZ skips  : ${s.skippedOutOfZone}`);
console.log(`Total spent: $${s.totalSpentDollars.toFixed(2)}`);
console.log(`Market results available: ${marketResults.size}`);

if (result.timeBuckets) {
  printBuckets(result.timeBuckets, "Time-bucket breakdown — ALL series combined");
  printBucketSeries(result.timeBuckets, "btc", "BTC (KXBTC15M)");
  printBucketSeries(result.timeBuckets, "eth", "ETH (KXETH15M)");
}

if (result.priceBands) {
  printPriceBands(result.priceBands);
}

console.log(`\n✓ Replay saved to data/replays/${result.replayId}.json\n`);
