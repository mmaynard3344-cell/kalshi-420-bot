/**
 * Market-data coverage tracker — final-window data-gap detection + safe recovery.
 *
 * Task: a recent ETH window had no server-side evaluation evidence during part
 * of the final minute. This module makes per-ticker market-data coverage
 * visible, detects a bounded usable-quote gap ONLY during the existing final
 * 120-second window, creates one durable diagnostic incident per ticker/window,
 * and triggers bounded, rate-limited data-plane recovery.
 *
 * ── Safety constraints (enforced by design) ──────────────────────────────────
 *  • This module imports NOTHING from any trading path: no order placement,
 *    no guards, no candidate/sizing/preflight/protective-exit code.
 *  • Recovery is an injected callback (set at startup to a data-plane-only
 *    refresh/resubscribe). The module itself can only observe and persist.
 *  • Rate limits: at most MAX_RECOVERY_ATTEMPTS_PER_WINDOW attempts per
 *    ticker/window, spaced ≥ MIN_RECOVERY_INTERVAL_MS apart.
 *
 * ── Durability ────────────────────────────────────────────────────────────────
 *  Incidents are appended to data/analytics/coverage-incidents-YYYY-MM-DD.ndjson
 *  (America/New_York calendar date). Every state change appends the FULL
 *  incident record; readers dedupe by incidentId keeping the latest line, so a
 *  crash between writes can never lose an already-recorded state.
 *
 *  No pino import — safe for isolated esbuild tests.
 */

import { appendFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join }                                                  from "node:path";
import { easternDay }                                            from "./dailyBudget.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Final trading window in seconds — matches TIME_ALERT_SECONDS. Never widened. */
export const FINAL_WINDOW_SECONDS = 120;
/** A usable quote older than this during the final window counts as a gap. */
export const COVERAGE_GAP_MS = 20_000;
/** Minimum spacing between recovery attempts for the same ticker/window. */
export const MIN_RECOVERY_INTERVAL_MS = 30_000;
/** Maximum recovery attempts per ticker/window. */
export const MAX_RECOVERY_ATTEMPTS_PER_WINDOW = 3;
/** How long a resolved/expired window stays visible in status output. */
const TRACK_RETENTION_MS = 30 * 60_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type WsMessageKind = "data" | "heartbeat" | "ack" | "other";

export interface RecoveryAttempt {
  attemptedAtMs: number;
  /** Free-form outcome from the recovery handler (e.g. "resubscribed", "reconnect_initiated", "handler_error"). */
  outcome:       string;
}

export interface CoverageIncident {
  /** Stable id: `${ticker}@${closeTime}` — one incident per ticker/window. */
  incidentId:          string;
  ticker:              string;
  series:              string;
  closeTime:           string;
  detectedAtMs:        number;
  secondsLeftAtDetect: number;
  /** Connection/telemetry context captured at detection time. */
  lastUsableQuoteMs:   number | null;
  lastEvaluationMs:    number | null;
  lastWsDataMsgMs:     number | null;
  lastWsAnyMsgMs:      number | null;
  wsConnected:         boolean;
  recoveryAttempts:    RecoveryAttempt[];
  /**
   * unresolved              — gap detected, no usable quote since
   * recovered               — a usable quote arrived after detection, window still open
   * unrecovered_window_closed — window closed without a usable quote after detection
   */
  status: "unresolved" | "recovered" | "unrecovered_window_closed";
  /** Wall-clock ms when a usable quote first arrived after detection (recovered only). */
  recoveredAtMs:       number | null;
}

export interface TickerCoverageStatus {
  ticker:                    string;
  series:                    string;
  closeTime:                 string;
  secondsLeft:               number;
  /**
   * pre_window — more than FINAL_WINDOW_SECONDS to close
   * healthy    — inside final window with a fresh usable quote
   * gap        — inside final window, usable quote older than COVERAGE_GAP_MS
   * closed     — window closed
   */
  state:                     "pre_window" | "healthy" | "gap" | "closed";
  lastUsableQuoteAgeMs:      number | null;
  lastEvaluationAgeMs:       number | null;
  finalWindowUsableQuotes:   number;
  finalWindowEvaluations:    number;
  wsConnected:               boolean;
  wsLastDataAgeMs:           number | null;
  incident:                  CoverageIncident | null;
}

export type FinalCoverageStatus = "HEALTHY" | "DEGRADED_RECOVERED" | "DEGRADED_UNRECOVERED";

export interface CoverageAuditTransition {
  atMs:   number;
  state:  string;
  reason: string;
}

/** Durable audit record for every discovered BTC/ETH ticker window. */
export interface CoverageWindowAudit {
  auditId:                 string;
  ticker:                  string;
  series:                  string;
  closeTime:               string;
  discoveredAtMs:          number;
  eligibleStartMs:         number;
  finalWindowStartedAtMs:  number | null;
  finalWindowClosedAtMs:   number | null;
  firstUsableQuoteMs:      number | null;
  lastUsableQuoteMs:       number | null;
  firstEvaluationMs:       number | null;
  lastEvaluationMs:        number | null;
  finalWindowUsableQuotes: number;
  finalWindowEvaluations:  number;
  status:                  "OBSERVING" | FinalCoverageStatus;
  incidentId:              string | null;
  transitions:             CoverageAuditTransition[];
  recoveryAttempts:        RecoveryAttempt[];
  /** Explicitly reports whether the audit has enough durable evidence for review. */
  evidenceCompleteness:    "complete" | "restart_continuity_unknown";
  /** True only when this active window crossed a process restart before sealing. */
  restartEvidenceUncertain: boolean;
}

/** Data-plane-only recovery callback. MUST NOT touch any order path. */
export type RecoveryHandler = (input: {
  ticker:  string;
  reason:  string;
}) => Promise<string>;

// ── SQL write hook ─────────────────────────────────────────────────────────────
//
// Injected at server startup from the durable storage adapter. Keeps this module
// pino-free and import-cycle-free so that
// isolated esbuild tests can run without the full server dependency graph.

let _sqlWriter: ((incident: CoverageIncident) => void) | null = null;
let _auditSqlWriter: ((audit: CoverageWindowAudit) => void) | null = null;

/**
 * Register the SQL write hook. Called once at server startup after
 * initTradeStore() completes. Must not be called from tests.
 */
export function setCoverageIncidentSqlWriter(fn: (incident: CoverageIncident) => void): void {
  _sqlWriter = fn;
}

/** Register the permanent final-window audit writer at server startup. */
export function setCoverageAuditSqlWriter(fn: (audit: CoverageWindowAudit) => void): void {
  _auditSqlWriter = fn;
}

// ── Internal state ────────────────────────────────────────────────────────────

interface TrackedWindow {
  ticker:                  string;
  series:                  string;
  closeTime:               string;
  closeMs:                 number;
  lastUsableQuoteMs:       number | null;
  lastEvaluationMs:        number | null;
  finalWindowUsableQuotes: number;
  finalWindowEvaluations:  number;
  incident:                CoverageIncident | null;
  lastRecoveryAttemptMs:   number;
  recoveryAttemptCount:    number;
  recoveryInFlight:        boolean;
  sealed:                  boolean;
  audit:                   CoverageWindowAudit;
  lastAuditPersistMs:      number;
  /** A process restart cannot prove the pre-restart stream stayed continuous. */
  restartEvidenceUncertain: boolean;
}

const tracked = new Map<string, TrackedWindow>(); // key = incidentId (ticker@closeTime)

let _wsConnectedProbe: () => boolean = () => false;
let _lastWsDataMsgMs = 0;
let _lastWsAnyMsgMs  = 0;
let _recoveryHandler: RecoveryHandler | null = null;

// ── Storage ───────────────────────────────────────────────────────────────────

function getDataDir(): string {
  const base = process.env["COVERAGE_DATA_DIR"] ?? join(process.cwd(), "data", "analytics");
  try { mkdirSync(base, { recursive: true }); } catch { /* exists */ }
  return base;
}

function incidentPath(date: string): string {
  return join(getDataDir(), `coverage-incidents-${date}.ndjson`);
}

function auditPath(date: string): string {
  return join(getDataDir(), `coverage-window-audits-${date}.ndjson`);
}

/**
 * Persist an incident to SQL (primary, durable) and NDJSON (secondary backup).
 * Both writes are fire-and-forget — never throws, never blocks trading.
 */
function persistIncident(incident: CoverageIncident): void {
  // ── SQL primary write ──────────────────────────────────────────────────────
  if (_sqlWriter !== null) {
    try { _sqlWriter(incident); } catch { /* never interrupt trading */ }
  }
  // ── NDJSON secondary backup ────────────────────────────────────────────────
  try {
    const date = easternDay(new Date(incident.detectedAtMs));
    appendFileSync(incidentPath(date), JSON.stringify(incident) + "\n", "utf8");
  } catch { /* disk errors must never interrupt trading */ }
}

/** Best-effort observability persistence; never interrupts trading. */
function persistAudit(audit: CoverageWindowAudit): void {
  if (_auditSqlWriter !== null) {
    try { _auditSqlWriter(audit); } catch { /* telemetry must not block trading */ }
  }
  try {
    // Telemetry persistence must not synchronously stall quote/evaluation work.
    // SQL uses its own buffered writer; this secondary NDJSON backup is async.
    void appendFile(
      auditPath(easternDay(new Date(audit.discoveredAtMs))),
      JSON.stringify(audit) + "\n",
      "utf8",
    ).catch(() => { /* secondary telemetry storage must not interrupt trading */ });
  } catch { /* disk errors are visible through storage health, never trading */ }
}

function auditTransition(w: TrackedWindow, atMs: number, state: string, reason: string): void {
  w.audit.transitions.push({ atMs, state, reason });
}

// ── Wiring (called once at startup) ──────────────────────────────────────────

export function setCoverageWsConnectedProbe(fn: () => boolean): void {
  _wsConnectedProbe = fn;
}

export function setCoverageRecoveryHandler(fn: RecoveryHandler | null): void {
  _recoveryHandler = fn;
}

// ── Recorders (called from stream / trader observation points) ───────────────

/** Track receipt of any WS message, classified by kind. */
export function recordCoverageWsMessage(kind: WsMessageKind, nowMs: number = Date.now()): void {
  _lastWsAnyMsgMs = nowMs;
  if (kind === "data") _lastWsDataMsgMs = nowMs;
}

/** Register/refresh the active window for a ticker once close time is known. */
export function trackCoverageWindow(
  ticker:    string,
  series:    string,
  closeTime: string,
  nowMs:     number = Date.now(),
): void {
  const closeMs = new Date(closeTime).getTime();
  if (!Number.isFinite(closeMs)) return;
  const key = `${ticker}@${closeTime}`;
  if (tracked.has(key)) return;
  const audit: CoverageWindowAudit = {
    auditId: key, ticker, series, closeTime, discoveredAtMs: nowMs,
    eligibleStartMs: closeMs - FINAL_WINDOW_SECONDS * 1000,
    finalWindowStartedAtMs: null, finalWindowClosedAtMs: null,
    firstUsableQuoteMs: null, lastUsableQuoteMs: null,
    firstEvaluationMs: null, lastEvaluationMs: null,
    finalWindowUsableQuotes: 0, finalWindowEvaluations: 0,
    status: "OBSERVING", incidentId: null,
    transitions: [{ atMs: nowMs, state: "OBSERVING", reason: "window_discovered" }],
    recoveryAttempts: [],
    evidenceCompleteness: "complete",
    restartEvidenceUncertain: false,
  };
  const window: TrackedWindow = {
    ticker, series, closeTime, closeMs,
    lastUsableQuoteMs: null, lastEvaluationMs: null,
    finalWindowUsableQuotes: 0, finalWindowEvaluations: 0,
    incident: null, lastRecoveryAttemptMs: 0, recoveryAttemptCount: 0,
    recoveryInFlight: false, sealed: false, audit, lastAuditPersistMs: nowMs,
    restartEvidenceUncertain: false,
  };
  tracked.set(key, window);
  persistAudit(audit);
}

function windowsForTicker(ticker: string): TrackedWindow[] {
  const out: TrackedWindow[] = [];
  for (const w of tracked.values()) if (w.ticker === ticker) out.push(w);
  return out;
}

function inFinalWindow(w: TrackedWindow, nowMs: number): boolean {
  const secsLeft = (w.closeMs - nowMs) / 1000;
  return secsLeft > 0 && secsLeft <= FINAL_WINDOW_SECONDS;
}

/**
 * Record a usable quote for a ticker (at least one derivable executable ask —
 * yesBid or noBid present). Resolves an open incident if one exists.
 */
export function recordCoverageUsableQuote(ticker: string, nowMs: number = Date.now()): void {
  for (const w of windowsForTicker(ticker)) {
    w.lastUsableQuoteMs = nowMs;
    if (inFinalWindow(w, nowMs)) {
      w.finalWindowUsableQuotes++;
      if (w.audit.firstUsableQuoteMs === null) w.audit.firstUsableQuoteMs = nowMs;
      w.audit.lastUsableQuoteMs = nowMs;
      w.audit.finalWindowUsableQuotes = w.finalWindowUsableQuotes;
      if (nowMs - w.lastAuditPersistMs >= COVERAGE_GAP_MS) {
        w.lastAuditPersistMs = nowMs;
        persistAudit(w.audit);
      }
    }
    if (w.incident && w.incident.status === "unresolved" && nowMs >= w.incident.detectedAtMs && nowMs < w.closeMs) {
      w.incident.status = "recovered";
      w.incident.recoveredAtMs = nowMs;
      persistIncident(w.incident);
      auditTransition(w, nowMs, "GAP_RECOVERED", "usable_quote_received_after_gap");
      persistAudit(w.audit);
    }
  }
}

/**
 * Record a RAW market observation (WS tick or REST snapshot).
 *
 * Registers the window as soon as a close time is discovered — independently
 * of any successful evaluation — so a silent stream after restart/rollover
 * still yields a tracked window that runCoverageCheck can inspect.
 *
 * Records a usable quote ONLY when the raw observation itself carries a bid.
 * Merged/cached state must never be used here: mergeState retains prior bids
 * when a partial update omits BBO fields, and counting those would let stale
 * quotes mask exactly the data gap this module exists to detect.
 */
export function recordCoverageObservation(input: {
  ticker:     string;
  series:     string;
  closeTime?: string | null;
  /** Bid values from the RAW payload only — never from merged/cached state. */
  rawYesBid?: number | null;
  rawNoBid?:  number | null;
  nowMs?:     number;
}): void {
  const now = input.nowMs ?? Date.now();
  if (input.closeTime) trackCoverageWindow(input.ticker, input.series, input.closeTime, now);
  if (input.rawYesBid != null || input.rawNoBid != null) {
    recordCoverageUsableQuote(input.ticker, now);
  }
}

/** Record that an evaluation ran for a ticker inside the final window. */
export function recordCoverageEvaluation(ticker: string, nowMs: number = Date.now()): void {
  for (const w of windowsForTicker(ticker)) {
    w.lastEvaluationMs = nowMs;
    if (inFinalWindow(w, nowMs)) {
      w.finalWindowEvaluations++;
      if (w.audit.firstEvaluationMs === null) w.audit.firstEvaluationMs = nowMs;
      w.audit.lastEvaluationMs = nowMs;
      w.audit.finalWindowEvaluations = w.finalWindowEvaluations;
    }
  }
}

// ── Detection + recovery ──────────────────────────────────────────────────────

/**
 * Periodic coverage check. Detects final-window usable-quote gaps, creates one
 * durable incident per ticker/window, triggers rate-limited recovery, and
 * seals incidents when the window closes. Safe to call every few seconds.
 */
export function runCoverageCheck(nowMs: number = Date.now()): void {
  for (const [key, w] of tracked) {
    // Prune long-closed windows.
    if (nowMs - w.closeMs > TRACK_RETENTION_MS) { tracked.delete(key); continue; }

    // Seal: window closed with an unresolved incident.
    if (nowMs >= w.closeMs) {
      if (!w.sealed) {
        w.sealed = true;
        if (w.incident && w.incident.status === "unresolved") {
          w.incident.status = "unrecovered_window_closed";
          persistIncident(w.incident);
        }
        w.audit.finalWindowClosedAtMs = nowMs;
        w.audit.finalWindowUsableQuotes = w.finalWindowUsableQuotes;
        w.audit.finalWindowEvaluations = w.finalWindowEvaluations;
        w.audit.status = w.incident?.status === "recovered"
          ? "DEGRADED_RECOVERED"
          : w.restartEvidenceUncertain || w.incident !== null || w.finalWindowUsableQuotes === 0
            ? "DEGRADED_UNRECOVERED"
            : "HEALTHY";
        w.audit.restartEvidenceUncertain = w.restartEvidenceUncertain;
        w.audit.evidenceCompleteness = w.restartEvidenceUncertain
          ? "restart_continuity_unknown"
          : "complete";
        auditTransition(
          w,
          nowMs,
          w.audit.status,
          w.audit.status === "HEALTHY"
            ? "final_window_closed_with_positive_usable_quote_evidence"
            : w.incident?.status === "recovered"
              ? "final_window_closed_after_data_gap_recovered"
              : "final_window_closed_without_complete_usable_quote_coverage",
        );
        persistAudit(w.audit);
      }
      continue;
    }

    if (!inFinalWindow(w, nowMs)) continue;
    if (w.audit.finalWindowStartedAtMs === null) {
      w.audit.finalWindowStartedAtMs = nowMs;
      auditTransition(w, nowMs, "OBSERVING", "eligible_final_window_started");
      persistAudit(w.audit);
    }

    const quoteAge = w.lastUsableQuoteMs === null ? Infinity : nowMs - w.lastUsableQuoteMs;
    const hasGap = quoteAge > COVERAGE_GAP_MS;

    // One ticker/window keeps one incident object, but a later quote gap after
    // an earlier recovery is still a new degraded period. Preserve the attempt
    // history and reopen the same incident so close-time status is truthful.
    if (hasGap && w.incident?.status === "recovered") {
      w.incident.status = "unresolved";
      auditTransition(w, nowMs, "GAP_DETECTED", "usable_quote_gap_recurred_after_recovery");
      persistIncident(w.incident);
      persistAudit(w.audit);
    }

    if (hasGap && !w.incident) {
      w.incident = {
        incidentId:          key,
        ticker:              w.ticker,
        series:              w.series,
        closeTime:           w.closeTime,
        detectedAtMs:        nowMs,
        secondsLeftAtDetect: Math.floor((w.closeMs - nowMs) / 1000),
        lastUsableQuoteMs:   w.lastUsableQuoteMs,
        lastEvaluationMs:    w.lastEvaluationMs,
        lastWsDataMsgMs:     _lastWsDataMsgMs || null,
        lastWsAnyMsgMs:      _lastWsAnyMsgMs || null,
        wsConnected:         safeWsConnected(),
        recoveryAttempts:    [],
        status:              "unresolved",
        recoveredAtMs:       null,
      };
      w.audit.incidentId = key;
      auditTransition(w, nowMs, "GAP_DETECTED", "usable_quote_gap_exceeded_threshold");
      persistIncident(w.incident);
      persistAudit(w.audit);
    }

    // Rate-limited recovery while the gap persists.
    if (hasGap && w.incident && w.incident.status === "unresolved") {
      const spacedOk  = nowMs - w.lastRecoveryAttemptMs >= MIN_RECOVERY_INTERVAL_MS;
      const budgetOk  = w.recoveryAttemptCount < MAX_RECOVERY_ATTEMPTS_PER_WINDOW;
      // Locking is scoped PER ticker/window — a hung recovery for one ticker
      // must never suppress recovery for another simultaneous window.
      if (spacedOk && budgetOk && _recoveryHandler && !w.recoveryInFlight) {
        w.lastRecoveryAttemptMs = nowMs;
        w.recoveryAttemptCount++;
        const incident = w.incident;
        const attempt: RecoveryAttempt = { attemptedAtMs: nowMs, outcome: "in_flight" };
        incident.recoveryAttempts.push(attempt);
        w.audit.recoveryAttempts.push({ ...attempt });
        auditTransition(w, nowMs, "RECOVERY_ATTEMPTED", "data_plane_recovery_scheduled");
        // Persist before calling the handler so a crash cannot erase the
        // attempt timestamp from the permanent audit trail.
        persistIncident(incident);
        persistAudit(w.audit);
        w.recoveryInFlight = true;
        _recoveryHandler({ ticker: w.ticker, reason: `final_window_quote_gap_${Math.round(quoteAge / 1000)}s` })
          .then((outcome) => {
            attempt.outcome = outcome;
            const auditAttempt = w.audit.recoveryAttempts.find((a) => a.attemptedAtMs === nowMs && a.outcome === "in_flight");
            if (auditAttempt) auditAttempt.outcome = outcome;
          })
          .catch((err)    => {
            const outcome = `handler_error: ${err instanceof Error ? err.message : String(err)}`;
            attempt.outcome = outcome;
            const auditAttempt = w.audit.recoveryAttempts.find((a) => a.attemptedAtMs === nowMs && a.outcome === "in_flight");
            if (auditAttempt) auditAttempt.outcome = outcome;
          })
          .finally(() => {
            w.recoveryInFlight = false;
            persistIncident(incident);
            persistAudit(w.audit);
          });
      }
    }
  }
}

function safeWsConnected(): boolean {
  try { return _wsConnectedProbe(); } catch { return false; }
}

// ── Status + read API ────────────────────────────────────────────────────────

export function getCoverageStatus(nowMs: number = Date.now()): TickerCoverageStatus[] {
  const out: TickerCoverageStatus[] = [];
  for (const w of tracked.values()) {
    const secondsLeft = Math.floor((w.closeMs - nowMs) / 1000);
    let state: TickerCoverageStatus["state"];
    if (secondsLeft <= 0) state = "closed";
    else if (secondsLeft > FINAL_WINDOW_SECONDS) state = "pre_window";
    else {
      const quoteAge = w.lastUsableQuoteMs === null ? Infinity : nowMs - w.lastUsableQuoteMs;
      state = quoteAge > COVERAGE_GAP_MS ? "gap" : "healthy";
    }
    out.push({
      ticker:                  w.ticker,
      series:                  w.series,
      closeTime:               w.closeTime,
      secondsLeft:             Math.max(0, secondsLeft),
      state,
      lastUsableQuoteAgeMs:    w.lastUsableQuoteMs === null ? null : nowMs - w.lastUsableQuoteMs,
      lastEvaluationAgeMs:     w.lastEvaluationMs === null ? null : nowMs - w.lastEvaluationMs,
      finalWindowUsableQuotes: w.finalWindowUsableQuotes,
      finalWindowEvaluations:  w.finalWindowEvaluations,
      wsConnected:             safeWsConnected(),
      wsLastDataAgeMs:         _lastWsDataMsgMs === 0 ? null : nowMs - _lastWsDataMsgMs,
      incident:                w.incident,
    });
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Read-only live + sealed permanent data-health audit rows. */
export function getCoverageWindowAudits(): CoverageWindowAudit[] {
  return [...tracked.values()]
    .map((w) => structuredClone(w.audit))
    .sort((a, b) => b.closeTime.localeCompare(a.closeTime));
}

/**
 * Restore only unfinished audit rows after a restart. Previous in-process
 * continuity cannot be reconstructed from a snapshot, so these windows are
 * explicitly fail-degraded at close rather than being allowed to become healthy.
 */
export function hydrateUnfinishedCoverageAudits(audits: CoverageWindowAudit[], nowMs = Date.now()): void {
  for (const audit of audits) {
    if (audit.status !== "OBSERVING" || audit.finalWindowClosedAtMs !== null) continue;
    const closeMs = new Date(audit.closeTime).getTime();
    if (!Number.isFinite(closeMs) || tracked.has(audit.auditId)) continue;
    const w: TrackedWindow = {
      ticker: audit.ticker, series: audit.series, closeTime: audit.closeTime, closeMs,
      lastUsableQuoteMs: audit.lastUsableQuoteMs, lastEvaluationMs: audit.lastEvaluationMs,
      finalWindowUsableQuotes: audit.finalWindowUsableQuotes,
      finalWindowEvaluations: audit.finalWindowEvaluations,
      incident: null, lastRecoveryAttemptMs: 0,
      recoveryAttemptCount: audit.recoveryAttempts.length,
      recoveryInFlight: false, sealed: false, audit: structuredClone(audit),
      lastAuditPersistMs: nowMs, restartEvidenceUncertain: true,
    };
    w.audit.restartEvidenceUncertain = true;
    w.audit.evidenceCompleteness = "restart_continuity_unknown";
    auditTransition(w, nowMs, "RESTART_EVIDENCE_UNCERTAIN", "unfinished_window_restored_without_live_stream_continuity");
    tracked.set(audit.auditId, w);
  }
}

/**
 * Load recent incidents from disk (survives restarts). Dedupes by incidentId,
 * keeping the LAST record written (latest state). Throws never — returns [].
 */
export function loadRecentCoverageIncidents(limitMs = 24 * 60 * 60 * 1_000): CoverageIncident[] {
  try {
    const allDates = readdirSync(getDataDir())
      .filter((n) => n.startsWith("coverage-incidents-") && n.endsWith(".ndjson"))
      .map((n) => n.slice("coverage-incidents-".length, -".ndjson".length))
      .sort();
    const relevant = limitMs === 0
      ? allDates
      : allDates.filter((d) => d >= easternDay(new Date(Date.now() - limitMs)));

    const byId = new Map<string, CoverageIncident>();
    for (const date of relevant) {
      let raw: string;
      try { raw = readFileSync(incidentPath(date), "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const inc = JSON.parse(line) as CoverageIncident;
          if (inc && typeof inc.incidentId === "string") byId.set(inc.incidentId, inc);
        } catch { /* skip malformed line */ }
      }
    }
    const cutoff = limitMs > 0 ? Date.now() - limitMs : 0;
    return [...byId.values()]
      .filter((i) => cutoff === 0 || i.detectedAtMs >= cutoff)
      .sort((a, b) => b.detectedAtMs - a.detectedAtMs);
  } catch {
    return [];
  }
}

/** Read permanent audit records from NDJSON, keeping the latest state per window. */
export function loadCoverageWindowAudits(limitMs = 0): CoverageWindowAudit[] {
  try {
    const cutoff = limitMs > 0 ? Date.now() - limitMs : 0;
    const byId = new Map<string, CoverageWindowAudit>();
    for (const name of readdirSync(getDataDir()).filter((n) => n.startsWith("coverage-window-audits-") && n.endsWith(".ndjson"))) {
      let raw: string;
      try { raw = readFileSync(join(getDataDir(), name), "utf8"); } catch { continue; }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const audit = JSON.parse(line) as CoverageWindowAudit;
          if (audit?.auditId && (cutoff === 0 || audit.discoveredAtMs >= cutoff)) {
            const prior = byId.get(audit.auditId);
            // Async appends may finish out of order. A sealed close is
            // authoritative and must never be displaced by an earlier
            // observing/gap snapshot just because it appears later in a file.
            if (
              !prior ||
              (audit.finalWindowClosedAtMs !== null &&
                (prior.finalWindowClosedAtMs === null || audit.finalWindowClosedAtMs >= prior.finalWindowClosedAtMs)) ||
              (audit.finalWindowClosedAtMs === null && prior.finalWindowClosedAtMs === null)
            ) byId.set(audit.auditId, audit);
          }
        } catch { /* salvage other audit lines after corruption */ }
      }
    }
    return [...byId.values()].sort((a, b) => b.closeTime.localeCompare(a.closeTime));
  } catch {
    return [];
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

export function _resetCoverageForTesting(): void {
  tracked.clear();
  _lastWsDataMsgMs = 0;
  _lastWsAnyMsgMs = 0;
  _recoveryHandler = null;
  _wsConnectedProbe = () => false;
}

export function _getTrackedWindowCountForTesting(): number {
  return tracked.size;
}
