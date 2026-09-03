/**
 * Pre-flight L2 decision store.
 *
 * Persists every pre-flight gate decision (submit / skip_*) for replay
 * analysis.  Uses the same fire-and-forget NDJSON append pattern as
 * windowTickStore.ts — disk errors never interrupt trading.
 *
 * ── File layout ───────────────────────────────────────────────────────────────
 *   data/analytics/preflight-decisions-YYYY-MM-DD.ndjson
 *   (America/New_York calendar date, one JSON object per line)
 *
 * ── Decision values ───────────────────────────────────────────────────────────
 *   submit              — all checks passed; order was forwarded to placeOrder
 *   skip_l2_unavailable — L2 fetch failed (fail closed; no dedup/budget claimed)
 *   skip_zero_depth     — book empty or no executable contracts at verified limit
 *   skip_stale_bbo_gap  — executable L2 ask is at least 10¢ below the
 *                         BBO-derived trigger/reference (falling-knife guard)
 *   skip_price_band     — verified limit outside [PRICE_FLOOR, PRICE_CAP]
 */

import { appendFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join }                                     from "node:path";
import { easternDay }                               from "./dailyBudget.js";
import type { L2Level }                             from "./orderbookParsing.js";

// ── SQL sink (registered by tradeStore at module load) ────────────────────────
// Injected rather than imported so this module stays pino-free: tradeStore pulls
// in the logger, which breaks esbuild test bundles that include this file
// (performanceReports.test.ts). tradeStore calls setPreflightSqlSink() with
// insertPreflightDecisionSql; when unset (isolated tests), SQL writes are skipped.
let _sqlSink: ((d: PreflightDecision) => void) | null = null;
export function setPreflightSqlSink(fn: ((d: PreflightDecision) => void) | null): void {
  _sqlSink = fn;
}

const DATA_DIR = join(process.cwd(), "data", "analytics");
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }

function preflightPath(date: string): string {
  return join(DATA_DIR, `preflight-decisions-${date}.ndjson`);
}

// ── Type ──────────────────────────────────────────────────────────────────────

export interface PreflightDecision {
  /** Full market ticker (e.g. KXETH15M-26JUL301745-45). */
  ticker:                  string;
  /** Series prefix (e.g. KXETH15M). */
  series:                  string;
  /** Order side being evaluated. */
  side:                    "yes" | "no";
  /** Wall-clock ms at decision time. */
  timestampMs:             number;
  /** Seconds until window close at the time of evaluation. */
  secondsLeft:             number;
  /**
   * BBO ask for our side (yesAsk for YES, noAsk for NO) from the cached
   * market state. Null if the quote was not available.
   */
  quotedBboAsk:            number | null;
  /** Age of the BBO quote in milliseconds. */
  bboAgeMs:                number | null;
  /** BBO-derived limit price that triggered this evaluation (before L2 check). */
  bboDerivedLimitCents:    number;
  /** Cheapest resting offer in the L2 book (outcome-side ¢). Null = book empty. */
  executableBestAskCents:  number | null;
  /** executableBestAskCents − quotedBboAsk. Null when quotedBboAsk is null. */
  bboToL2GapCents:         number | null;
  /** Verified limit price computed from executableBestAskCents (+ buffer, capped). */
  verifiedLimitCents:      number | null;
  /** Executable notional in dollars at verified limit (0 when book is empty). */
  depthAtLimitDollars:     number;
  /** Executable contracts at verified limit. */
  depthAtLimitContracts:   number;
  /** Contracts we intended to buy at verified limit using the full betDollars. */
  intendedContracts:       number;
  /** intendedContracts × verifiedLimitCents (whole cents). */
  intendedNotionalCents:   number;
  /**
   * Contracts actually submitted (= min(intendedContracts, depthAtLimitContracts)).
   * 0 on any skip decision.
   */
  adjustedContracts:       number;
  /**
   * depthAtLimitContracts / intendedContracts, floored at 0, capped at 1.
   * 0 when intendedContracts === 0.
   */
  fillFractionEstimate:    number;
  /** Up to 10 near-limit L2 levels (5 at-or-below + 5 above). */
  nearLimitLevels:         L2Level[];
  /** L2 fetch latency in milliseconds. */
  l2FetchLatencyMs:        number;
  /**
   * Gate outcome.
   * "submit" | "skip_l2_unavailable" | "skip_zero_depth" |
   * "skip_stale_bbo_gap" | "skip_price_band"
   */
  decision:                string;
  /**
   * Market settlement result, populated after the window closes by the
   * outcome reconciler.  Null at recording time.
   */
  marketResult:            string | null;
}

// ── Write ──────────────────────────────────────────────────────────────────────

/** Persist one PreflightDecision (SQL — durable — plus NDJSON fallback). Never throws. */
export function recordPreflightDecision(d: PreflightDecision): void {
  // ── SQL (durable — survives production redeploys, exportable via executeSql) ─
  // Fire-and-forget; the sink (tradeStore.insertPreflightDecisionSql) never throws.
  try { _sqlSink?.(d); } catch { /* never interrupt trading */ }

  // ── NDJSON (local dev / fast inspection fallback) ──────────────────────────
  try {
    const date = easternDay(new Date(d.timestampMs));
    appendFileSync(preflightPath(date), JSON.stringify(d) + "\n", "utf8");
  } catch {
    // Silently drop — disk errors must never interrupt trading
  }
}

// ── Read ───────────────────────────────────────────────────────────────────────

/** Load all PreflightDecision records for a given YYYY-MM-DD date.
 *
 * Uses last-write-wins dedup keyed on `ticker:side:timestampMs`.  This ensures
 * that settlement-patched records appended by runPreflightSettlementBackfill()
 * override the original null-marketResult entries without inflating counts.
 */
export function loadPreflightDecisions(date: string): PreflightDecision[] {
  try {
    const raw   = readFileSync(preflightPath(date), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    // Pass 1: deduplicate by composite key (last-write-wins)
    const seen = new Map<string, PreflightDecision>();
    for (const line of lines) {
      try {
        const d = JSON.parse(line) as PreflightDecision;
        const key = `${d.ticker}:${d.side}:${d.timestampMs}`;
        seen.set(key, d); // later entries overwrite earlier ones
      } catch { /* skip malformed */ }
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}

/** Prefer the local mirror for duplicates while filling any missing decisions
 * from durable SQL. Kept pure so report tests can verify restart behavior. */
export function mergePreflightDecisionRecords(
  fromDisk: PreflightDecision[],
  fromSql: PreflightDecision[],
): PreflightDecision[] {
  const byId = new Map<string, PreflightDecision>();
  for (const decision of fromDisk) {
    byId.set(`${decision.ticker}:${decision.side}:${decision.timestampMs}`, decision);
  }
  for (const decision of fromSql) {
    const id = `${decision.ticker}:${decision.side}:${decision.timestampMs}`;
    if (!byId.has(id)) byId.set(id, decision);
  }
  return [...byId.values()];
}

/** Load the local preflight mirror for a report period without touching trading state. */
export function loadPreflightDecisionsFromDateRange(days: number): PreflightDecision[] {
  try {
    const dates = readdirSync(DATA_DIR)
      .filter((name) => name.startsWith("preflight-decisions-") && name.endsWith(".ndjson"))
      .map((name) => name.slice("preflight-decisions-".length, -".ndjson".length))
      .sort();
    const selected = days <= 0
      ? dates
      : dates.filter((date) => {
          const cutoff = new Date();
          cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
          return date >= easternDay(cutoff);
        });
    return selected.flatMap(loadPreflightDecisions);
  } catch {
    return [];
  }
}
