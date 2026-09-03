/**
 * Window tick recorder — stores every in-window BBO tick for resting-order
 * simulation analysis.
 *
 * Appends one JSON line per tick to
 *   data/analytics/window-ticks-YYYY-MM-DD.ndjson
 * (America/New_York calendar date, same convention as all other daily files).
 *
 * ── Design constraints ────────────────────────────────────────────────────────
 *  • Fire-and-forget: never throws, never blocks evaluate().
 *  • Append-only, one record per tick — restart-safe.
 *  • Silently swallows disk errors so trading is never interrupted.
 *  • loadWindowTicks() is read-only and safe to call from simulation routes.
 */

import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join }                                     from "node:path";
import { easternDay }                               from "./dailyBudget.js";
import { insertWindowTickSql }                      from "./tradeStore.js";

// ── Storage path ──────────────────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data", "analytics");
const LEGACY_RAW_RESEARCH_CAPTURE_ENABLED =
  process.env["LEGACY_RAW_RESEARCH_CAPTURE_ENABLED"] === "true";

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }

function tickPath(date: string): string {
  return join(DATA_DIR, `window-ticks-${date}.ndjson`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** One in-window BBO tick recorded by the autoTrader evaluate() loop. */
export interface WindowTick {
  /** Market ticker (e.g. KXETH15M-26JUL301200-00). */
  ticker:        string;
  /** Wall-clock time of the tick in ms since epoch. */
  timestampMs:   number;
  /** Seconds remaining until window close at the time of this tick. */
  secondsLeft:   number;
  /** Raw BBO fields from Kalshi (null = not available). */
  yesBid:        number | null;
  yesAsk:        number | null;
  noBid:         number | null;
  noAsk:         number | null;
  /** Derived executable ask prices used for zone evaluation. */
  derivedYesAsk: number | null;   // 100 − noBid
  derivedNoAsk:  number | null;   // 100 − yesBid
  /** Whether derivedNoAsk or derivedYesAsk was in the 70–93¢ zone. */
  inZone:        boolean;
  /** Data source for this tick. */
  source:        string;
}

// ── Per-second deduplication ──────────────────────────────────────────────────

/**
 * Tracks the last recorded second (floor(ms/1000)) per ticker so that the
 * 1-second snapshot timer and the WebSocket evaluate() path don't produce
 * duplicate rows within the same wall-clock second.
 *
 * Rule: the first caller wins; subsequent callers in the same second are
 * silently dropped.  The map is never cleared — old tickers just become stale
 * entries that cost one Map lookup and are reused on the next window with the
 * same ticker (which is fine because the second value will always advance).
 */
const lastTickSecond = new Map<string, number>();

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Append one WindowTick to today's NDJSON file.
 * Never throws — any I/O error is silently swallowed.
 *
 * At most one row is written per ticker per wall-clock second.  If two calls
 * arrive for the same ticker in the same second the second one is silently
 * discarded.  This prevents WS bursts (multiple ticks/s) from producing
 * duplicate rows while still allowing the 1-second snapshot timer to fill in
 * gaps when REST is the only data source (which normally fires every ~5 s).
 */
export function recordWindowTick(tick: WindowTick): void {
  // Historical BBO paths are research-only and are deliberately off by default.
  // This guard lives at the writer boundary so every existing evaluator/timer
  // caller remains execution-identical while producing no new raw tick records.
  if (!LEGACY_RAW_RESEARCH_CAPTURE_ENABLED) return;
  // ── Per-second dedup ───────────────────────────────────────────────────────
  const currentSec = Math.floor(tick.timestampMs / 1000);
  const lastSec    = lastTickSecond.get(tick.ticker);
  if (lastSec === currentSec) return; // already wrote a row for this second
  lastTickSecond.set(tick.ticker, currentSec);
  // ── SQL (durable — survives production redeploys) ──────────────────────────
  // Fire-and-forget; insertWindowTickSql never throws.
  insertWindowTickSql(tick);

  // ── NDJSON (local dev / fast inspection fallback) ──────────────────────────
  try {
    const date = easternDay(new Date(tick.timestampMs));
    appendFileSync(tickPath(date), JSON.stringify(tick) + "\n", "utf8");
  } catch {
    // Silently drop — disk errors must never interrupt trading
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Load all WindowTick records for a given YYYY-MM-DD date string.
 * Returns an empty array on any error (file missing, parse failure, etc.).
 */
export function loadWindowTicks(date: string): WindowTick[] {
  try {
    const raw   = readFileSync(tickPath(date), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const ticks: WindowTick[] = [];
    for (const line of lines) {
      try { ticks.push(JSON.parse(line) as WindowTick); } catch { /* skip malformed */ }
    }
    return ticks;
  } catch {
    return [];
  }
}

/**
 * Load all WindowTick records for a given ticker across one or more dates.
 * Useful for per-window simulation lookups.
 */
export function loadWindowTicksForTicker(
  ticker: string,
  dates:  string[],
): WindowTick[] {
  return dates.flatMap((d) => loadWindowTicks(d)).filter((t) => t.ticker === ticker);
}
