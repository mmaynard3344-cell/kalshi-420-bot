/**
 * Passive observation logger for the 61–120 second window.
 *
 * Records bid/ask data for ticks that arrive 61–120 seconds before window
 * close so that a future 2:00-vs-3:00-minute replay comparison can be run
 * with real market data.
 *
 * IMPORTANT: this module NEVER submits orders, claims dedup slots, reserves
 * daily budget, or modifies any trading state. It is append-only to disk.
 *
 * ── Design constraints ────────────────────────────────────────────────────
 *   • Logs at most one record per ticker per 5-second interval (debounce).
 *   • Preserves ALL ticks in range, not only qualifying ones.
 *   • Silently drops malformed prices to a separate file; never throws.
 *   • Daily-rotated using America/New_York date.
 *   • appendFileSync — restart-safe; partial writes are atomic at record level.
 *   • Validates prices as integers in [0, 100]; null is always valid.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join }                      from "node:path";
import { easternDay }                from "./dailyBudget.js";
import {
  contractsForPrice,
  isEntryPriceInBandForSeries,
  tierLabel,
} from "./autoTraderGuards.js";
import * as tradeStore               from "./tradeStore.js";

// ── Module-level constants (exported for tests) ───────────────────────────────

/** Inclusive lower bound of the passive observation window (seconds before close). */
export const PASSIVE_OBS_MIN_SECS    = 121;
/** Inclusive upper bound of the passive observation window (seconds before close). */
export const PASSIVE_OBS_MAX_SECS    = 180;
/** Minimum gap between records for the same ticker (milliseconds). */
export const PASSIVE_OBS_DEBOUNCE_MS = 5_000;

// ── Strategy constants mirrored from autoTraderGuards.ts ─────────────────────
// These must stay in sync with the live trading constants. They are local to
// this module so that the observer can compute hypothetical signals without
// importing from autoTrader (which would create a circular dependency).
//
// OWNER-LOCKED: do NOT change these here — or in autoTraderGuards.ts — without
// explicit owner approval and a STRATEGY_VERSION bump (see the owner-lock
// banner in autoTraderGuards.ts). strategyConstants.sync.test.ts fails if
// these drift from the canonical values.

const ALERT_MIN = 90;   // ¢ — inclusive price-zone floor
const ALERT_MAX = 95;   // ¢ — inclusive price-zone ceiling

// NOTE: hypotheticalEntryPrice is the raw derived ask (what the order book
// shows), NOT the limit-order price (derivedAsk + buffer). The +1 buffer is
// an order-placement implementation detail, not a market observable. Using
// the derived ask keeps replay analysis anchored to book prices.

// ── Data directory ────────────────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const LEGACY_RAW_RESEARCH_CAPTURE_ENABLED =
  process.env["LEGACY_RAW_RESEARCH_CAPTURE_ENABLED"] === "true";

// Ensure data directory exists at module load time (no-op when already present).
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

// ── Per-ticker debounce state ─────────────────────────────────────────────────

const lastObsMs = new Map<string, number>();

/** Reset all debounce state — for use in tests only. */
export function _resetDebounceForTesting(): void {
  lastObsMs.clear();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PassiveObsInput {
  /** Wall-clock time for this observation (ms). Defaults to Date.now(). */
  nowMs?:       number;
  ticker:       string;
  closeTime:    string;          // ISO-8601 window close time
  secondsLeft:  number;
  yesBid:       number | null;
  yesAsk:       number | null;
  noBid:        number | null;
  noAsk:        number | null;
  source:       "websocket" | "rest_fallback" | "startup_prime";
  wsConnected:  boolean;
  wsStale:      boolean;
  betDollars:   number;          // series bet size (for hypothetical contract count)
}

export interface PassiveObservation {
  // ── Identity ──────────────────────────────────────────────────────────────
  timestampMs:             number;
  isoTimestamp:            string;
  ticker:                  string;
  series:                  string;
  asset:                   "BTC" | "ETH" | "unknown";
  windowCloseTime:         string;
  windowId:                string;   // "${series}@${closeTime}"
  // ── Market data ───────────────────────────────────────────────────────────
  secondsLeft:             number;
  yesBid:                  number | null;
  yesAsk:                  number | null;
  noBid:                   number | null;
  noAsk:                   number | null;
  // ── Data-feed status ──────────────────────────────────────────────────────
  source:                  "websocket" | "rest_fallback" | "startup_prime";
  wsConnected:             boolean;
  wsStale:                 boolean;
  // ── Hypothetical signal (read-only; no order submitted) ───────────────────
  yesQualifies:            boolean;  // yesDerivedAsk in [72, 90]
  noQualifies:             boolean;  // noDerivedAsk  in [72, 90]
  hypotheticalSide:        "yes" | "no" | null;
  hypotheticalEntryPrice:  number | null;
  hypotheticalTier:        string | null;
  hypotheticalContracts:   number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function seriesFromTicker(ticker: string): string {
  const m = ticker.match(/^(KX[A-Z]+15M)/);
  return m ? m[1] : "";
}

function assetFromSeries(series: string): "BTC" | "ETH" | "unknown" {
  if (series.includes("BTC")) return "BTC";
  if (series.includes("ETH")) return "ETH";
  return "unknown";
}

/**
 * Returns v if it is an integer in [0, 100]; otherwise null.
 * A null input passes through as null (price not available).
 */
function validatePrice(v: number | null): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 0 || v > 100) return null;
  return v;
}

/** YES-derived ask = 100 − NO bid (what we would pay for YES). */
function yesDerivedAsk(noBid: number | null): number | null {
  return noBid !== null ? 100 - noBid : null;
}

/** NO-derived ask = 100 − YES bid (what we would pay for NO). */
function noDerivedAsk(yesBid: number | null): number | null {
  return yesBid !== null ? 100 - yesBid : null;
}
function obsFilePath(nowMs: number): string {
  return join(DATA_DIR, `three-minute-observations-${easternDay(new Date(nowMs))}.ndjson`);
}

function malformedFilePath(nowMs: number): string {
  return join(DATA_DIR, `three-minute-obs-malformed-${easternDay(new Date(nowMs))}.ndjson`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record one passive observation for a tick in the 61–120 second window.
 *
 * Silently returns (no write) when:
 *   • secondsLeft is outside [PASSIVE_OBS_MIN_SECS, PASSIVE_OBS_MAX_SECS]
 *   • fewer than PASSIVE_OBS_DEBOUNCE_MS ms have passed since the last record
 *     for this ticker
 *
 * On malformed prices: writes a compact error record to the malformed file
 * and returns without writing to the main observation file.
 *
 * Never throws; all file I/O errors are swallowed.
 */
export function logPassiveObservation(input: PassiveObsInput): void {
  // The former 3-minute raw observation stream is retired in favor of compact
  // derived checkpoints. This remains an explicit legacy-only opt-in so callers
  // cannot accidentally recreate a high-volume ledger.
  if (!LEGACY_RAW_RESEARCH_CAPTURE_ENABLED) return;
  const nowMs = input.nowMs ?? Date.now();

  // ── 1. Range guard ────────────────────────────────────────────────────────
  if (input.secondsLeft < PASSIVE_OBS_MIN_SECS || input.secondsLeft > PASSIVE_OBS_MAX_SECS) {
    return;
  }

  // ── 2. Debounce ───────────────────────────────────────────────────────────
  const last = lastObsMs.get(input.ticker) ?? 0;
  if (nowMs - last < PASSIVE_OBS_DEBOUNCE_MS) return;
  lastObsMs.set(input.ticker, nowMs);

  // ── 3. Price validation ───────────────────────────────────────────────────
  const yesBid = validatePrice(input.yesBid);
  const yesAsk = validatePrice(input.yesAsk);
  const noBid  = validatePrice(input.noBid);
  const noAsk  = validatePrice(input.noAsk);

  const hasMalformed =
    (input.yesBid !== null && yesBid === null) ||
    (input.yesAsk !== null && yesAsk === null) ||
    (input.noBid  !== null && noBid  === null) ||
    (input.noAsk  !== null && noAsk  === null);

  if (hasMalformed) {
    try {
      const rec = {
        timestampMs:  nowMs,
        isoTimestamp: new Date(nowMs).toISOString(),
        ticker:       input.ticker,
        secondsLeft:  input.secondsLeft,
        raw: {
          yesBid: input.yesBid,
          yesAsk: input.yesAsk,
          noBid:  input.noBid,
          noAsk:  input.noAsk,
        },
      };
      appendFileSync(malformedFilePath(nowMs), JSON.stringify(rec) + "\n");
      tradeStore.insertMalformedObsInSql({ timestampMs: nowMs, ticker: input.ticker, secondsLeft: input.secondsLeft, raw: rec });
    } catch { /* ignore */ }
    return;
  }

  // ── 4. Compute hypothetical signal ────────────────────────────────────────
  const yDerivedAsk = yesDerivedAsk(noBid);
  const nDerivedAsk = noDerivedAsk(yesBid);
  const series = seriesFromTicker(input.ticker);

  const yesQualifies = yDerivedAsk !== null && isEntryPriceInBandForSeries(series, yDerivedAsk);
  const noQualifies  = nDerivedAsk !== null && isEntryPriceInBandForSeries(series, nDerivedAsk);

  let hypotheticalSide:        "yes" | "no" | null = null;
  let hypotheticalEntryPrice:  number | null        = null;

  // Mirrors the priority in autoTrader.ts evaluate() — YES is checked first.
  // hypotheticalEntryPrice = derivedAsk directly (no +1 buffer).
  // The limit-order buffer is an execution detail; for observation/replay we
  // record the market price the signal is based on.
  if (yesQualifies && yDerivedAsk !== null) {
    hypotheticalSide       = "yes";
    hypotheticalEntryPrice = yDerivedAsk;   // 100 − noBid
  } else if (noQualifies && nDerivedAsk !== null) {
    hypotheticalSide       = "no";
    hypotheticalEntryPrice = nDerivedAsk;   // 100 − yesBid
  }

  const hypotheticalTier = hypotheticalEntryPrice !== null
    ? tierLabel(hypotheticalEntryPrice)
    : null;

  const hypotheticalContracts = hypotheticalEntryPrice !== null
    ? contractsForPrice(hypotheticalEntryPrice, input.betDollars)
    : null;

  // ── 5. Build and write record ──────────────────────────────────────────────

  const obs: PassiveObservation = {
    timestampMs:            nowMs,
    isoTimestamp:           new Date(nowMs).toISOString(),
    ticker:                 input.ticker,
    series,
    asset:                  assetFromSeries(series),
    windowCloseTime:        input.closeTime,
    windowId:               `${series}@${input.closeTime}`,
    secondsLeft:            input.secondsLeft,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    source:                 input.source,
    wsConnected:            input.wsConnected,
    wsStale:                input.wsStale,
    yesQualifies,
    noQualifies,
    hypotheticalSide,
    hypotheticalEntryPrice,
    hypotheticalTier,
    hypotheticalContracts,
  };

  try {
    appendFileSync(obsFilePath(nowMs), JSON.stringify(obs) + "\n");
    tradeStore.insertPassiveObsInSql(obs);
  } catch { /* ignore */ }
}
