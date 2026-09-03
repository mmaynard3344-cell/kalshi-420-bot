/**
 * Circular-dependency-free window activity log.
 *
 * autoTrader.ts writes to it via the wl* helpers.
 * trade.ts reads from it via getWindowLog().
 * Neither file imports the other through this module.
 *
 * Entries are persisted to data/window-log.json so history survives restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import * as tradeStore from "./tradeStore.js";

export interface WindowLogEntry {
  ticker:          string;
  series:          string;
  /** ISO close time of the window; filled in on the first evaluate() tick. */
  closeTime:       string | null;
  firstSeenMs:     number;
  /** Did any REST/WS tick pass the TIME_ALERT_SECONDS gate? */
  entered:         boolean;
  /** Was any derived ask in the 70–93¢ zone during the alert window? */
  inZone:          boolean;
  /** Derived YES ask (¢) at the first in-zone tick (null if never in zone). */
  yesDerivedAsk:   number | null;
  /** Derived NO ask (¢) at the first in-zone tick (null if never in zone). */
  noDerivedAsk:    number | null;
  /**
   * Final outcome for this window:
   *  pending            — window is still open
   *  out_of_zone        — closed; prices never reached 70–93¢
   *  skipped            — prices were in zone but every order attempt was blocked
   *  zero_fill          — order(s) submitted, all zero-filled, retry budget exhausted
   *  zero_fill_retried  — order zero-filled but a thin-book retry was allowed
   *  traded             — at least one contract was filled
   */
  outcome: "pending" | "out_of_zone" | "skipped" | "zero_fill" | "zero_fill_retried" | "traded";
  side:            "yes" | "no" | null;
  priceCents:      number | null;
  contractsFilled: number | null;
  spentDollars:    number | null;
  /** First reason an order was blocked; null when traded or never attempted. */
  skipReason:      string | null;
  /**
   * Kalshi market settlement result ("yes" | "no") — populated ~3 min after
   * window close by the outcome reconciler. Null until the market settles.
   */
  settlementResult?: "yes" | "no" | null;
}

const MAX_WINDOW_LOG  = 200;
const WINDOW_LOG_FILE = "data/window-log.json";

const _log: WindowLogEntry[] = [];
/** Pointer to the live (unsealed) entry per series. */
const _current = new Map<string, WindowLogEntry>();

// ── Disk persistence ──────────────────────────────────────────────────────────

const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1_000; // prune entries older than 24 h on load

/** Load persisted window log from disk. Call once at startup before any wl* writes. */
export function wlLoad(): void {
  try {
    const raw = readFileSync(WINDOW_LOG_FILE, "utf8");
    const loaded = JSON.parse(raw) as WindowLogEntry[];
    if (!Array.isArray(loaded)) return;
    // Drop entries older than 24 h, then keep up to MAX_WINDOW_LOG most-recent
    const cutoffMs = Date.now() - MAX_ENTRY_AGE_MS;
    const entries = loaded
      .filter((e) => typeof e.firstSeenMs === "number" && e.firstSeenMs >= cutoffMs)
      .slice(-MAX_WINDOW_LOG);
    _log.push(...entries);
    // Rebuild _current: last "pending" entry per series (may be sealed below)
    for (const e of _log) {
      if (e.outcome === "pending") _current.set(e.series, e);
      else _current.delete(e.series);
    }
    const loaded_count = _log.length;
    // Suppress import-time side effects — logger not available here; use console
    console.log(`[windowLog] restored ${loaded_count} entries from disk`);
  } catch {
    // No file or bad JSON — start fresh, not an error
  }
}

/**
 * Populate the window log from SQL when the file restore produced no entries
 * (first run on a new deployment, or data/ directory was lost).
 * Called asynchronously from index.ts after initTradeStore().
 */
export async function wlRestoreFromSqlIfEmpty(): Promise<void> {
  if (_log.length > 0) return; // file restore succeeded — SQL not needed
  try {
    const all = await tradeStore.restoreWindowLogFromSql(MAX_WINDOW_LOG);
    const cutoffMs = Date.now() - MAX_ENTRY_AGE_MS;
    const entries = all.filter((e) => e.firstSeenMs >= cutoffMs);
    if (entries.length === 0) return;
    for (const e of entries.slice(-MAX_WINDOW_LOG)) {
      _log.push(e);
      if (e.outcome === "pending") _current.set(e.series, e);
    }
    console.log(`[windowLog] restored ${_log.length} entries from SQL`);
  } catch {
    // Non-fatal — window log is best-effort
  }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write: flushes within 1 s of the last mutation. */
function scheduleSave(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      mkdirSync("data", { recursive: true });
      writeFileSync(WINDOW_LOG_FILE, JSON.stringify(_log, null, 2));
    } catch {
      // Non-fatal — window log is best-effort; trading is unaffected
    }
  }, 1_000);
}

// ── Write helpers (called by autoTrader.ts) ───────────────────────────────────

/**
 * Seal the previous window entry (if still pending) and open a new one.
 * Called from handleWindowRollover when a new ticker is detected.
 */
export function wlOpen(series: string, ticker: string): void {
  const prev = _current.get(series);
  // If the restored entry from disk is already for this exact ticker (mid-window
  // restart), reuse it — don't create a duplicate entry for the same window.
  if (prev && prev.ticker === ticker) return;
  if (prev && prev.outcome === "pending") {
    prev.outcome = prev.inZone ? "skipped" : "out_of_zone";
  }
  const entry: WindowLogEntry = {
    ticker,
    series,
    closeTime:       null,
    firstSeenMs:     Date.now(),
    entered:         false,
    inZone:          false,
    yesDerivedAsk:   null,
    noDerivedAsk:    null,
    outcome:         "pending",
    side:            null,
    priceCents:      null,
    contractsFilled: null,
    spentDollars:    null,
    skipReason:      null,
  };
  _current.set(series, entry);
  _log.push(entry);
  while (_log.length > MAX_WINDOW_LOG) _log.shift();
  scheduleSave();
  tradeStore.upsertWindowLogEntryInSql(entry);
}

/** Backfill the close time once we learn it from the first evaluate() tick. */
export function wlSetCloseTime(series: string, ticker: string, closeTime: string): void {
  const e = _current.get(series);
  if (e && e.ticker === ticker && !e.closeTime) {
    e.closeTime = closeTime;
    scheduleSave();
    tradeStore.upsertWindowLogEntryInSql(e);
  }
}

/**
 * Record a tick that passed the TIME_ALERT_SECONDS gate.
 * inZone=true means at least one derived ask was in the 70–93¢ zone this tick.
 */
export function wlTick(
  series:       string,
  ticker:       string,
  inZone:       boolean,
  yesDerivedAsk: number | null,
  noDerivedAsk:  number | null,
): void {
  const e = _current.get(series);
  if (!e || e.ticker !== ticker) return;
  e.entered = true;
  if (inZone && !e.inZone) {
    e.inZone        = true;
    e.yesDerivedAsk = yesDerivedAsk;
    e.noDerivedAsk  = noDerivedAsk;
    scheduleSave();
    tradeStore.upsertWindowLogEntryInSql(e);
  }
}

/**
 * Record the first reason an order was blocked for this window.
 * Ignored once the window has been marked "traded".
 */
export function wlSkip(series: string, ticker: string, reason: string): void {
  const e = _current.get(series);
  if (!e || e.ticker !== ticker || e.outcome === "traded") return;
  if (!e.skipReason) {
    e.skipReason = reason;
    scheduleSave();
    tradeStore.upsertWindowLogEntryInSql(e);
  }
}

/**
 * Upgrade the outcome from "zero_fill" → "zero_fill_retried" when a thin-book
 * retry is about to fire.  Idempotent: only transitions from "zero_fill";
 * has no effect on any other outcome (traded, skipped, etc.).
 */
export function wlMarkZeroFillRetried(series: string, ticker: string): void {
  const e = _current.get(series);
  if (!e || e.ticker !== ticker) return;
  if (e.outcome === "zero_fill") {
    e.outcome = "zero_fill_retried";
    scheduleSave();
    tradeStore.upsertWindowLogEntryInSql(e);
  }
}
/**
 * Record a trade outcome.
 * isZeroFill=true → order submitted but 0 contracts filled (IOC expired).
 * isZeroFill=false → at least one contract filled; overrides any prior outcome.
 */
export function wlTrade(
  series:          string,
  ticker:          string,
  side:            "yes" | "no",
  priceCents:      number,
  contractsFilled: number,
  spentDollars:    number,
  isZeroFill:      boolean,
): void {
  const e = _current.get(series);
  if (!e || e.ticker !== ticker) return;
  if (isZeroFill) {
    if (e.outcome === "pending") e.outcome = "zero_fill";
  } else {
    e.outcome        = "traded";
    e.side           = side;
    e.priceCents     = priceCents;
    e.contractsFilled = contractsFilled;
    e.spentDollars   = spentDollars;
    e.skipReason     = null;
  }
  scheduleSave();
  if (e) tradeStore.upsertWindowLogEntryInSql(e);
}

/**
 * Record the Kalshi market settlement result for a closed window.
 * Called by outcomeReconciler ~3 min after window close once the market settles.
 * Idempotent: safe to call multiple times for the same ticker.
 */
export function wlSetSettlementResult(ticker: string, result: "yes" | "no"): void {
  // Find the entry by ticker (may be any entry in the log, not just _current)
  const e = _log.find((entry) => entry.ticker === ticker);
  if (!e) return;
  if (e.settlementResult === result) return; // already set — no-op
  e.settlementResult = result;
  scheduleSave();
  tradeStore.upsertWindowLogEntryInSql(e);
}

// ── Read helper (called by trade.ts route) ────────────────────────────────────

/** Returns all logged windows, newest first. */
export function getWindowLog(): readonly WindowLogEntry[] {
  return [..._log].reverse();
}
