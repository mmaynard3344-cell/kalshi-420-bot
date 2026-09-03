/**
 * Daily report scheduler.
 *
 * Fires the daily trading report once at 07:00 Eastern time each day.
 * Uses a 60-second polling interval — lightweight and no cron dependency.
 *
 * Durability and retry contract:
 *   • Sent-state is persisted AFTER a successful send (not before), so a
 *     transient SMTP failure leaves the day's state as "failed" and the next
 *     poll retries automatically.
 *   • Up to MAX_SEND_ATTEMPTS retries are made throughout the day (one per
 *     poll cycle after a failure) so a brief outage doesn't permanently lose
 *     the report.
 *   • State is stored in data/report-scheduler-state.json so a production
 *     restart after a successful morning send does NOT re-send the report.
 *
 * Timezone correctness:
 *   Eastern time (including DST) is derived via the IANA "America/New_York"
 *   timezone using Intl.DateTimeFormat — never from manual UTC offsets.
 *
 * Production only:
 *   Scheduled sends are disabled in the workspace environment
 *   (REPLIT_DEPLOYMENT !== "1"). Use POST /api/report/daily in dev.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";
import { isProductionRuntime } from "./tradingKillSwitch.js";
import { sendDailyReport as _defaultSender } from "./dailyReport.js";
import type { SendDailyReportResult } from "./dailyReport.js";
import { completedEasternWeek, sendWeeklyReport as _defaultWeeklySender } from "./weeklyReport.js";
import type { SendWeeklyReportResult } from "./weeklyReport.js";
import { pruneEvaluationEvents, pruneCoverageIncidents } from "./tradeStore.js";

// Injected sender — overridable in tests; defaults to the real implementation.
type Sender = (date: string) => Promise<SendDailyReportResult>;
let _sender: Sender = _defaultSender;
type WeeklySender = (weekEndExclusive: string) => Promise<SendWeeklyReportResult>;
let _weeklySender: WeeklySender = _defaultWeeklySender;

// ── Config ────────────────────────────────────────────────────────────────────

const REPORT_HOUR_ET   = 7;       // 07:00 Eastern
const POLL_INTERVAL_MS = 60_000;  // check every minute
const MAX_SEND_ATTEMPTS = 5;      // max retries per day before giving up
let STATE_PATH = join(process.cwd(), "data", "report-scheduler-state.json");
let WEEKLY_STATE_PATH = join(process.cwd(), "data", "weekly-report-scheduler-state.json");

// ── State ─────────────────────────────────────────────────────────────────────

interface SchedulerState {
  date:          string;           // Eastern date of the last attempt
  status:        "sending" | "sent" | "failed";
  attempts:      number;           // total attempts for `date`
  lastAttemptAt: string;           // ISO timestamp
}

let _state: SchedulerState | null = null;
let _weeklyState: SchedulerState | null = null;
let _weeklySendInFlight = false;
let _weeklyStateUnresolved = false;
let _timer: ReturnType<typeof setInterval> | null = null;

// Tracks the Eastern date on which the evaluation_events prune last ran.
// In-memory only — a restart re-runs via the initTradeStore startup sweep.
let _lastPrunedDate: string | null = null;

// ── Timezone helpers ──────────────────────────────────────────────────────────

/**
 * Returns today's Eastern date (YYYY-MM-DD) and hour (0-23).
 * Uses IANA "America/New_York" — handles DST automatically.
 */
export function easternNow(now: Date): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
    hour:     "2-digit",
    hour12:   false,
  });

  const parts = fmt.formatToParts(now);
  const get   = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";

  // hour12:false may return "24" for midnight in some runtimes — normalise.
  const hour = parseInt(get("hour"), 10) % 24;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, hour };
}

// ── Durable state I/O ─────────────────────────────────────────────────────────

function _loadState(): void {
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    _state    = JSON.parse(raw) as SchedulerState;
    logger.info(
      { date: _state.date, status: _state.status, attempts: _state.attempts },
      "reportScheduler: loaded durable state",
    );
  } catch {
    _state = null; // first run or file absent — start fresh
  }
}

function _persistState(s: SchedulerState): void {
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), "utf8");
    _state = s;
  } catch (err) {
    logger.warn({ err }, "reportScheduler: failed to persist state");
  }
}

function _loadWeeklyState(): void {
  if (!existsSync(WEEKLY_STATE_PATH)) {
    _weeklyState = null;
    _weeklyStateUnresolved = false;
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(WEEKLY_STATE_PATH, "utf8")) as SchedulerState;
    if (!parsed.date || !parsed.lastAttemptAt || !Number.isInteger(parsed.attempts) ||
      !["sending", "sent", "failed"].includes(parsed.status)) {
      throw new Error("invalid weekly scheduler state");
    }
    _weeklyState = parsed;
    _weeklyStateUnresolved = false;
  } catch (err) {
    _weeklyState = null;
    _weeklyStateUnresolved = true;
    logger.error({ err }, "reportScheduler: weekly state is unreadable — automatic delivery locked to prevent duplicates");
  }
}

function _persistWeeklyState(s: SchedulerState): boolean {
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    const tempPath = `${WEEKLY_STATE_PATH}.tmp`;
    writeFileSync(tempPath, JSON.stringify(s, null, 2), "utf8");
    renameSync(tempPath, WEEKLY_STATE_PATH);
    _weeklyState = s;
    _weeklyStateUnresolved = false;
    return true;
  } catch (err) {
    logger.warn({ err }, "reportScheduler: failed to persist weekly state");
    return false;
  }
}

// ── Core poll logic ───────────────────────────────────────────────────────────

export async function _maybeSendReport(now: Date): Promise<void> {
  const { date: todayET, hour } = easternNow(now);

  // Not yet 07:00 ET — wait.
  if (hour < REPORT_HOUR_ET) return;

  // Already successfully sent today — skip.
  if (_state?.date === todayET && _state.status === "sent") return;

  // Already exhausted retries for today — give up until tomorrow.
  const attempts = (_state?.date === todayET ? _state.attempts : 0);
  if (attempts >= MAX_SEND_ATTEMPTS) {
    if (attempts === MAX_SEND_ATTEMPTS) {
      // Log once when we hit the cap (attempts will equal cap on every poll, so
      // we distinguish by checking _state.status to avoid log spam).
      if (_state?.status === "failed") {
        logger.error(
          { date: todayET, attempts },
          "reportScheduler: max send attempts reached — giving up until tomorrow",
        );
        // Bump attempts by 1 so this log only fires once.
        _persistState({ ..._state!, attempts: attempts + 1 });
      }
    }
    return;
  }

  // Compute yesterday's Eastern date for the report content.
  const { date: reportDate } = easternNow(new Date(now.getTime() - 86_400_000));

  logger.info(
    { reportDate, todayET, attempt: attempts + 1, triggeredAt: now.toISOString() },
    "reportScheduler: firing daily report",
  );

  let sendOk = false;
  try {
    const { reportData, sendResult } = await _sender(reportDate);
    // Only treat an actual delivery as success. `skipped` means the transport
    // is not configured — this is not a successful send and should retry so
    // the report goes out if credentials are added mid-day.
    sendOk = sendResult.ok === true;

    logger.info(
      {
        reportDate,
        fills:     reportData.combined.fills,
        netPnl:    reportData.combined.netPnl,
        sendOk,
        skipped:   sendResult.skipped ?? false,
        sendError: sendResult.error ?? null,
        attempt:   attempts + 1,
      },
      "reportScheduler: daily report attempt complete",
    );
  } catch (err) {
    logger.error({ err, reportDate, attempt: attempts + 1 }, "reportScheduler: unexpected error");
  }

  // Persist state AFTER the send attempt so we know the true outcome.
  _persistState({
    date:          todayET,
    status:        sendOk ? "sent" : "failed",
    attempts:      attempts + 1,
    lastAttemptAt: now.toISOString(),
  });

  // Daily retention prune — runs once per Eastern day regardless of whether
  // the report itself succeeded.  A restart is covered by the startup sweep
  // in initTradeStore; this guarantees pruning on long-running production
  // instances that never restart.
  if (_lastPrunedDate !== todayET) {
    _lastPrunedDate = todayET;
    void pruneEvaluationEvents().catch((err) => {
      logger.warn({ err }, "reportScheduler: pruneEvaluationEvents threw unexpectedly");
    });
    void pruneCoverageIncidents().catch((err) => {
      logger.warn({ err }, "reportScheduler: pruneCoverageIncidents threw unexpectedly");
    });
  }
}

/** Run the weekly sender once on Saturday after 07:00 Eastern, with durable retries. */
export async function _maybeSendWeeklyReport(now: Date): Promise<void> {
  const { date: todayET, hour } = easternNow(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  if (weekday !== "Sat" || hour < REPORT_HOUR_ET) return;
  if (_weeklyStateUnresolved) {
    logger.error("reportScheduler: weekly state unresolved — automatic delivery remains locked pending operator review");
    return;
  }
  if (_weeklySendInFlight) return;
  if (_weeklyState?.date === todayET && _weeklyState.status === "sent") return;
  // A process restart after provider submission but before the confirmation write
  // must not blindly re-send the investor report. It remains visibly "sending"
  // for operator review rather than duplicating a potentially delivered email.
  if (_weeklyState?.date === todayET && _weeklyState.status === "sending") {
    logger.warn({ date: todayET }, "reportScheduler: weekly report has unresolved sending state — not retrying automatically");
    return;
  }
  const attempts = _weeklyState?.date === todayET ? _weeklyState.attempts : 0;
  if (attempts >= MAX_SEND_ATTEMPTS) return;

  const { weekEndExclusive } = completedEasternWeek(now);
  _weeklySendInFlight = true;
  const claimed = _persistWeeklyState({
    date: todayET, status: "sending", attempts: attempts + 1, lastAttemptAt: now.toISOString(),
  });
  if (!claimed) {
    _weeklySendInFlight = false;
    logger.error({ weekEndExclusive }, "reportScheduler: weekly delivery claim could not be persisted — refusing to send");
    return;
  }
  let sendOk = false;
  let deliveryUnknown = false;
  try {
    const { reportData, sendResult } = await _weeklySender(weekEndExclusive);
    sendOk = sendResult.ok === true;
    // A provider-side exception can occur after it has accepted the message.
    // Treat that handoff as unknown, not retryable, to avoid duplicate investor
    // reports. A missing transport/recipient is explicitly skipped and safe to retry.
    deliveryUnknown = !sendOk && !sendResult.skipped;
    logger.info({
      weekStart: reportData.weekStart, weekEndExclusive, sendOk,
      skipped: sendResult.skipped ?? false, sendError: sendResult.error ?? null, attempt: attempts + 1,
    }, "reportScheduler: weekly report attempt complete");
  } catch (err) {
    deliveryUnknown = true;
    logger.error({ err, weekEndExclusive, attempt: attempts + 1 }, "reportScheduler: weekly report attempt failed");
  } finally {
    _persistWeeklyState({
      date: todayET, status: sendOk ? "sent" : deliveryUnknown ? "sending" : "failed",
      attempts: attempts + 1, lastAttemptAt: now.toISOString(),
    });
    _weeklySendInFlight = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function isProduction(): boolean {
  return isProductionRuntime();
}

/**
 * Start the daily report scheduler.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startReportScheduler(): void {
  if (_timer) return;

  if (!isProduction()) {
    logger.info(
      "reportScheduler: workspace environment — scheduled sends disabled " +
      "(use POST /api/report/daily to trigger manually)",
    );
    return;
  }

  // Restore durable state BEFORE first poll to prevent restart duplicates.
  _loadState();
  _loadWeeklyState();

  logger.info(
    {
      reportHourET:  REPORT_HOUR_ET,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxAttempts:   MAX_SEND_ATTEMPTS,
      lastState:     _state,
    },
    "reportScheduler: started — daily and Saturday weekly reports fire at 07:00 ET",
  );

  // Fire immediately: catches a missed run if the server restarted after 7 AM
  // on a day we haven't successfully sent for yet.
  void _maybeSendReport(new Date());
  void _maybeSendWeeklyReport(new Date());

  _timer = setInterval(() => {
    const now = new Date();
    void _maybeSendReport(now);
    void _maybeSendWeeklyReport(now);
  }, POLL_INTERVAL_MS);
  _timer.unref();
}

/** Stop the scheduler. */
export function stopReportScheduler(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

export function _resetStateForTesting(): void {
  _state = null; _weeklyState = null; _weeklySendInFlight = false; _weeklyStateUnresolved = false;
}

export function _injectStateForTesting(s: SchedulerState | null): void {
  _state = s;
}

export function _getStateForTesting(): SchedulerState | null {
  return _state;
}

/** Override the sender for deterministic unit tests. */
export function _setSenderForTesting(fn: Sender): void {
  _sender = fn;
}

/** Restore the real sender after tests. */
export function _resetSenderForTesting(): void {
  _sender = _defaultSender;
}

export function _setWeeklySenderForTesting(fn: WeeklySender): void { _weeklySender = fn; }
export function _resetWeeklySenderForTesting(): void { _weeklySender = _defaultWeeklySender; }
export function _getWeeklyStateForTesting(): SchedulerState | null { return _weeklyState; }

/** Override the state file path (tests should use a tmp path). */
export function _setStatePathForTesting(p: string): void {
  STATE_PATH = p;
}

/** Restore the default state file path. */
export function _resetStatePathForTesting(): void {
  STATE_PATH = join(process.cwd(), "data", "report-scheduler-state.json");
}

/** Expose _loadState for disk-durability tests. */
export function _loadStateForTesting(): void {
  _loadState();
}
