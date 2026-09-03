/**
 * Evaluation event store — durable per-tick decision log.
 *
 * Every in-window server evaluation attempt writes one event per active
 * side so that operators can correlate browser quote alerts to the nearest
 * server decision after the window closes.
 *
 * ── File layout ───────────────────────────────────────────────────────────────
 *   data/analytics/evaluation-events-YYYY-MM-DD.ndjson
 *   (America/New_York calendar date, one JSON object per line)
 *
 * ── Outcome values ────────────────────────────────────────────────────────────
 *   no_tick                — server had no derivable executable ask
 *                           (yesBid and noBid were both null)
 *   out_of_zone            — derived asks exist but neither was in the 90–95¢ zone
 *   incoherent_bbo_snapshot — direct BBO ask and derived ask are too far apart
 *   wide_spread            — bid–ask spread on the triggering side exceeds threshold
 *   preflight_skip         — L2 pre-flight gate rejected the order
 *   submitted              — order was forwarded to placeOrder()
 *
 * ── Design constraints ───────────────────────────────────────────────────────
 *  • Fire-and-forget: never throws, never blocks evaluate().
 *  • Append-only, one record per event — restart-safe.
 *  • No pino import (keeps this module compatible with isolated esbuild tests).
 *  • loadRecentEvaluationEvents() is safe to call from Dashboard API routes.
 */

import { appendFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join }                                                  from "node:path";
import { easternDay }                                            from "./dailyBudget.js";

// ── Storage path ──────────────────────────────────────────────────────────────

/**
 * Compute DATA_DIR at call time so tests can redirect writes via process.chdir()
 * or the EVAL_EVENTS_DATA_DIR environment variable without re-importing the module.
 */
function getDataDir(): string {
  const base = process.env["EVAL_EVENTS_DATA_DIR"] ?? join(process.cwd(), "data", "analytics");
  try { mkdirSync(base, { recursive: true }); } catch { /* already exists */ }
  return base;
}

function eventPath(date: string): string {
  return join(getDataDir(), `evaluation-events-${date}.ndjson`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type EvaluationOutcome =
  | "no_tick"
  | "out_of_zone"
  | "incoherent_bbo_snapshot"
  | "wide_spread"
  | "preflight_skip"
  /**
   * The order was forwarded to placeOrder(). This does NOT confirm the order
   * was accepted by Kalshi — placeOrder may still reject due to position
   * limits, concurrency guards, or a final L2 gate failure. Look for the
   * corresponding fill record to confirm actual submission.
   */
  | "forwarded"
  /**
   * placeOrder() rejected the order before a Kalshi POST was attempted.
   * preflightDecision carries the specific guard that fired
   * (e.g. price_band_guard, cooldown, window_budget, zero_contracts,
   * halted, budget_overrun, dedup, daily_cap, position_guard,
   * position_error, submission_in_flight, sql_error, sql_reserve_failed,
   * workspace_guard, timing_guard, skip_final_quote_stale,
   * skip_final_price_band, skip_final_adverse_move,
   * skip_final_excessive_price_rise, post_start_persistence_failed).
   */
  | "place_order_rejected"
  /**
   * Kalshi definitively rejected the order after the POST was sent.
   * Covers: HTTP 400/404/422 responses AND a 2xx body carrying
   * `rejectReason`. In both cases Kalshi confirmed the order did not execute.
   * preflightDecision carries the specific reason (HTTP status code or
   * `reject_reason` value from the response body).
   */
  | "exchange_rejected"
  /**
   * The POST was dispatched but the outcome is uncertain — network timeout,
   * connection reset, or a malformed response. The SQL row stays in
   * UNRESOLVED_OUTCOMES until reconciliation settles it. An order may or may
   * not have been placed at the exchange.
   */
  | "post_unknown";

/**
 * One server evaluation decision captured at the point the outcome is known.
 * Multiple events may exist for the same ticker + timestampMs if both the YES
 * and NO side were active (e.g. wide_spread on YES while NO submitted).
 */
export interface EvaluationEvent {
  /** Market ticker (e.g. KXETH15M-26JUL301200-00). */
  ticker:             string;
  /** Series prefix (e.g. KXETH15M). */
  series:             string;
  /** Wall-clock ms at the moment the outcome was determined. */
  timestampMs:        number;
  /** Seconds until window close at the time of evaluation. */
  secondsLeft:        number;
  /** Trigger source for this evaluate() call. */
  source:             "websocket" | "rest_fallback" | "startup_prime";
  /** Direct BBO fields the server had at this moment. */
  yesBid:             number | null;
  yesAsk:             number | null;
  noBid:              number | null;
  noAsk:              number | null;
  /** Derived executable ask prices (100 − opposite bid). */
  yesDerivedAsk:      number | null;
  noDerivedAsk:       number | null;
  /**
   * The side this event is for.
   * null when no side reached per-side evaluation
   * (outcome = "no_tick" or "out_of_zone").
   */
  side:               "yes" | "no" | null;
  /**
   * Limit price computed for the attempted side.
   * null for outcomes that exit before the limit is calculated
   * (no_tick, out_of_zone, incoherent_bbo_snapshot, wide_spread).
   */
  limitCents:         number | null;
  /** Final outcome for this evaluation attempt. */
  outcome:            EvaluationOutcome;
  /**
   * For preflight_skip: the specific gate decision returned by
   * computePreflightDecision() (e.g. skip_zero_depth, skip_stale_bbo_gap).
   * null for all other outcomes.
   */
  preflightDecision:  string | null;
}

// ── SQL write hook ────────────────────────────────────────────────────────────
//
// Injected at server startup (index.ts → recordEvaluationEventToSql from
// tradeStore). Keeps this module pino-free and import-cycle-free so that
// isolated esbuild tests can run without the full server dependency graph.

let _sqlWriter: ((event: EvaluationEvent) => void) | null = null;

/**
 * Register the SQL write hook. Called once at server startup after
 * initTradeStore() completes. Must not be called from tests.
 */
export function setEvaluationEventSqlWriter(fn: (event: EvaluationEvent) => void): void {
  _sqlWriter = fn;
}

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Persist one EvaluationEvent. Fire-and-forget — never throws.
 *
 * Writes to SQL (primary, durable) when the hook is registered, then writes
 * the same record to the NDJSON file as a secondary backup. Both paths are
 * independent: a failure on either is silently swallowed so that trading is
 * never interrupted.
 */
export function recordEvaluationEvent(event: EvaluationEvent): void {
  // ── SQL primary write ──────────────────────────────────────────────────────
  if (_sqlWriter !== null) {
    try { _sqlWriter(event); } catch { /* never interrupt trading */ }
  }
  // ── NDJSON secondary backup ────────────────────────────────────────────────
  try {
    const date = easternDay(new Date(event.timestampMs));
    appendFileSync(eventPath(date), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Silently drop — disk errors must never interrupt trading
  }
}

// ── Read ───────────────────────────────────────────────────────────────────────

/** Load all EvaluationEvent records for a given YYYY-MM-DD date. */
export function loadEvaluationEvents(date: string): EvaluationEvent[] {
  try {
    const raw   = readFileSync(eventPath(date), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const out: EvaluationEvent[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line) as EvaluationEvent); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Load evaluation events from all Eastern-date files that fall within the
 * requested time horizon so that Dashboard can correlate browser alerts to
 * the nearest server decision without a full history scan.
 *
 * @param limitMs  Only return events from the last `limitMs` milliseconds
 *                 (default 24 h). Pass 0 to load ALL stored events with no
 *                 time filter (all date files).
 *
 * Implementation note: a 48-hour window can span THREE Eastern-calendar dates
 * (e.g. if now is 00:30 ET, the cutoff is 48:30 before that, touching
 * day-before-yesterday's file). We therefore include every date file whose
 * date string is >= the Eastern day of (now − limitMs) rather than hard-coding
 * a fixed file count.
 */
export function loadRecentEvaluationEvents(limitMs = 24 * 60 * 60 * 1_000): EvaluationEvent[] {
  try {
    const allDates = readdirSync(getDataDir())
      .filter((name) => name.startsWith("evaluation-events-") && name.endsWith(".ndjson"))
      .map((name) => name.slice("evaluation-events-".length, -".ndjson".length))
      .sort();

    // For limitMs=0: load every file (no cutoff). Otherwise: keep only date
    // files whose calendar date is on or after the Eastern date of the cutoff.
    const relevantDates = limitMs === 0
      ? allDates
      : (() => {
          const cutoffDate = easternDay(new Date(Date.now() - limitMs));
          return allDates.filter((d) => d >= cutoffDate);
        })();

    const cutoff = limitMs > 0 ? Date.now() - limitMs : 0;
    const all = relevantDates.flatMap(loadEvaluationEvents);
    return cutoff > 0 ? all.filter((e) => e.timestampMs >= cutoff) : all;
  } catch {
    return [];
  }
}

/**
 * Outcome priority for terminal-event preference.
 * Lower number = preferred. `forwarded` is an intermediate event that should
 * only be shown when no terminal outcome for the same evaluation is available.
 */
const OUTCOME_PRIORITY: Record<EvaluationOutcome, number> = {
  exchange_rejected:       0,   // most definitive: Kalshi confirmed it rejected the order
  place_order_rejected:    0,   // terminal — placeOrder exited before POST
  post_unknown:            1,   // uncertain but POST was sent — beats all pre-POST events
  preflight_skip:          1,   // terminal — checkAndPlace gate exit
  wide_spread:             1,   // terminal — spread guard exit
  incoherent_bbo_snapshot: 1,   // terminal — coherence guard exit
  no_tick:                 2,   // terminal — no derivable ask
  out_of_zone:             2,   // terminal — derived ask exists but out of zone
  forwarded:               10,  // intermediate — prefer any terminal over this
};

/**
 * Find the evaluation event that best explains a browser alert for a given
 * ticker at a given timestamp.
 *
 * Selection rules (in priority order):
 *  1. Events outside `windowMs` of `targetMs` are excluded.
 *  2. Events whose `side` conflicts with the requested `side` are deprioritised
 *     (side=null events and events where side matches are both preferred).
 *  3. Among remaining candidates, terminal outcomes (place_order_rejected,
 *     preflight_skip, wide_spread, incoherent_bbo_snapshot) are preferred over
 *     the intermediate `forwarded` event.
 *  4. Within the same priority tier, the event closest to `targetMs` wins.
 *
 * This ensures that when `forwarded` and a subsequent `place_order_rejected`
 * both fall within the window, the rejection is surfaced rather than the
 * intermediate handoff.
 *
 * @param events    Pre-loaded event list (call loadRecentEvaluationEvents once)
 * @param ticker    Market ticker to match
 * @param targetMs  Reference timestamp (e.g. browser alert time)
 * @param windowMs  Max abs(event.timestampMs − targetMs) to consider (default 60 s)
 * @param side      Alert side ("yes" | "no"); if provided, mismatched events are
 *                  deprioritised (but still returned when nothing else matches)
 */
export function findNearestEvaluationEvent(
  events:   EvaluationEvent[],
  ticker:   string,
  targetMs: number,
  windowMs: number = 60_000,
  side?:    "yes" | "no",
): EvaluationEvent | null {
  let best: EvaluationEvent | null = null;
  let bestScore = Infinity;

  for (const e of events) {
    if (e.ticker !== ticker) continue;
    const delta = Math.abs(e.timestampMs - targetMs);
    if (delta > windowMs) continue;

    // Side mismatch penalty: zero-side events (zone-level) and matching-side
    // events are always preferred; opposite-side events are heavily penalised.
    const sideMismatch = side != null && e.side != null && e.side !== side;
    const sidePenalty = sideMismatch ? 1e12 : 0;

    const outcomePriority = (OUTCOME_PRIORITY[e.outcome] ?? 99) * 1e9;
    const score = sidePenalty + outcomePriority + delta;

    if (score < bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}
