/**
 * runtimeWatchdog.ts — Isolated server-side telemetry-only runtime watchdog.
 *
 * Periodically calls GET /api/trade/runtime-health (local HTTP, authenticated
 * via X-Trade-Token from server env) and classifies the response into a set of
 * named health dimensions.  It NEVER imports trading/order paths and NEVER
 * alters strategy.  All persistence is optional and injected via hooks.
 *
 * ── Classified failure dimensions ─────────────────────────────────────────────
 *   endpoint_failure      — HTTP error or network failure reaching the endpoint
 *   api_failure           — Non-200 HTTP status from the endpoint
 *   ws_disconnect         — kalshi_connection.websocket_connected === false
 *   stale_btc_quote       — usable_quotes.btc.age_ms > STALE_QUOTE_THRESHOLD_MS
 *   stale_eth_quote       — usable_quotes.eth.age_ms > STALE_QUOTE_THRESHOLD_MS
 *   stale_autotrader      — autotrader.wsLive === false
 *   overdue_reconciliation — reconciliation.last_discovery_sweep_at age > OVERDUE_RECONCILE_MS
 *   protective_exit_disabled — protective_exit_monitor.enabled === false
 *   daily_profit_unavailable — daily_profit_lockout.state === "unavailable"
 *   eth420_boundary_evidence_unavailable — passive ETH boundary evidence storage cannot be read
 *
 * ── Integration hooks (injectable) ───────────────────────────────────────────
 *   setWatchdogTransitionSink  — called on every dimension state transition
 *   setWatchdogHistorySink     — called on every poll result for durable history
 *   setWatchdogFetchOverride   — test seam: replace the HTTP fetch
 *
 * ── Public API ────────────────────────────────────────────────────────────────
 *   startWatchdog()            — begin polling loop (call once after server ready)
 *   stopWatchdog()             — cancel the poll timer
 *   getWatchdogStatus()        — current dimension states + last poll metadata
 *   getWatchdogHistory()       — in-process ring buffer of recent poll results
 *   isWatchdogDimensionHealthy(dim) — true if dimension has no active alert
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the watchdog polls the runtime-health endpoint (ms). */
export const WATCHDOG_POLL_INTERVAL_MS = 30_000;

/** Quotes older than this are considered stale (ms). */
export const STALE_QUOTE_THRESHOLD_MS = 60_000;

/** Reconciliation gap older than this is considered overdue (ms). */
export const OVERDUE_RECONCILE_MS = 15 * 60_000; // 15 minutes

/** Number of poll results to retain in the in-process ring buffer. */
export const WATCHDOG_HISTORY_CAPACITY = 120;

/** Boundary-evidence reads must fail this many consecutive polls before alerting. */
export const ETH420_BOUNDARY_EVIDENCE_ALERT_AFTER_POLLS = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

export type WatchdogDimension =
  | "endpoint_failure"
  | "api_failure"
  | "ws_disconnect"
  | "stale_btc_quote"
  | "stale_eth_quote"
  | "stale_autotrader"
  | "overdue_reconciliation"
  | "protective_exit_disabled"
  | "daily_profit_unavailable"
  | "eth420_boundary_evidence_unavailable";

export type DimensionState = "ok" | "alert";

export interface DimensionStatus {
  dimension: WatchdogDimension;
  state: DimensionState;
  /** ISO string of the most recent transition into this state (null if never polled). */
  since: string | null;
  /** Number of consecutive polls in current state. */
  consecutiveCount: number;
  /** Safe fixed diagnostic for the ETH boundary-evidence storage alert only. */
  diagnosticReason: "storage_unavailable" | "storage_read_failed" | null;
}

export interface WatchdogPollResult {
  polledAt: string;         // ISO
  durationMs: number;
  success: boolean;
  /** HTTP status (null on network error). */
  httpStatus: number | null;
  /** Parsed dimension states at poll time. */
  dimensions: Record<WatchdogDimension, DimensionState>;
  /** Raw error message if success=false */
  errorMessage?: string;
  /** Bounded diagnostics that are safe to show in operator health surfaces. */
  diagnosticReasons?: Partial<Record<WatchdogDimension, "storage_unavailable" | "storage_read_failed">>;
}

export interface WatchdogStatus {
  /** Wall-clock ISO of the most recent poll (null if never polled). */
  lastPolledAt: string | null;
  /** Duration of the most recent poll in ms. */
  lastDurationMs: number | null;
  /** Whether the most recent poll succeeded (reached the endpoint). */
  lastPollSuccess: boolean | null;
  /** Per-dimension current states. */
  dimensions: Record<WatchdogDimension, DimensionStatus>;
  /** Total polls performed since start. */
  totalPolls: number;
  /** Total alert transitions across all dimensions since start. */
  totalAlertTransitions: number;
}

/** Called whenever a dimension transitions between ok and alert. */
export type WatchdogTransitionSink = (event: {
  dimension: WatchdogDimension;
  previousState: DimensionState;
  newState: DimensionState;
  transitionAt: string;
  consecutiveCount: number;
  pollResult: WatchdogPollResult;
}) => void | Promise<void>;

/** Called after every completed poll. Suitable for durable append-only history. */
export type WatchdogHistorySink = (result: WatchdogPollResult) => void | Promise<void>;

/** Secondary outage-survival ledger; SQL remains the primary reader. */
export function appendWatchdogPollToFile(result: WatchdogPollResult): void {
  try {
    const dir = process.env["RUNTIME_WATCHDOG_DATA_DIR"] ?? join(process.cwd(), "data", "analytics");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `runtime-watchdog-${result.polledAt.slice(0, 10)}.ndjson`), `${JSON.stringify(result)}\n`, "utf8");
  } catch { /* telemetry persistence cannot affect runtime operation */ }
}

// ── Shape of GET /api/trade/runtime-health response ───────────────────────────
// (Typed loosely so we tolerate forward-compatible additions.)

interface RuntimeHealthResponse {
  generated_at?: string;
  autotrader?: {
    wsLive?: boolean;
    lastTickMs?: number;
  };
  kalshi_connection?: {
    websocket_connected?: boolean;
    last_ticker_refresh_at?: string | null;
  };
  usable_quotes?: {
    btc?: { age_ms?: number | null; coverage_state?: string };
    eth?: { age_ms?: number | null; coverage_state?: string };
  };
  reconciliation?: {
    last_discovery_sweep_at?: string | null;
  };
  daily_profit_lockout?: {
    state?: string;
  };
  protective_exit_monitor?: {
    enabled?: boolean;
  };
  eth420_boundary_evidence?: {
    availability?: string;
    diagnostic_reason?: "storage_unavailable" | "storage_read_failed" | null;
  };
}

// ── Module-level state ────────────────────────────────────────────────────────

const ALL_DIMENSIONS: WatchdogDimension[] = [
  "endpoint_failure",
  "api_failure",
  "ws_disconnect",
  "stale_btc_quote",
  "stale_eth_quote",
  "stale_autotrader",
  "overdue_reconciliation",
  "protective_exit_disabled",
  "daily_profit_unavailable",
  "eth420_boundary_evidence_unavailable",
];

function makeDimensionStatus(dim: WatchdogDimension): DimensionStatus {
  return { dimension: dim, state: "ok", since: null, consecutiveCount: 0, diagnosticReason: null };
}

let _dimensionStates: Record<WatchdogDimension, DimensionStatus> = (() => {
  const out = {} as Record<WatchdogDimension, DimensionStatus>;
  for (const d of ALL_DIMENSIONS) out[d] = makeDimensionStatus(d);
  return out;
})();

let _totalPolls = 0;
let _totalAlertTransitions = 0;
let _lastPolledAt: string | null = null;
let _lastDurationMs: number | null = null;
let _lastPollSuccess: boolean | null = null;
let _history: WatchdogPollResult[] = [];
let _eth420BoundaryEvidenceFailureCount = 0;

let _pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Injectable sinks ──────────────────────────────────────────────────────────

let _transitionSink: WatchdogTransitionSink | null = null;
let _historySink: WatchdogHistorySink | null = null;
let _fetchOverride: ((url: string, init: RequestInit) => Promise<Response>) | null = null;

export function setWatchdogTransitionSink(sink: WatchdogTransitionSink | null): void {
  _transitionSink = sink;
}

export function setWatchdogHistorySink(sink: WatchdogHistorySink | null): void {
  _historySink = sink;
}

/** Test seam: replace the fetch used by the watchdog. */
export function _setWatchdogFetchOverride(fn: ((url: string, init: RequestInit) => Promise<Response>) | null): void {
  _fetchOverride = fn;
}

// ── Dimension classification ──────────────────────────────────────────────────

/**
 * Given a parsed runtime-health response and the current wall-clock time,
 * return the alert/ok state for every dimension.
 * Only called on successful (HTTP 200) responses.
 */
export function classifyDimensions(
  payload: RuntimeHealthResponse,
  nowMs: number,
): Record<WatchdogDimension, DimensionState> {
  const out = {} as Record<WatchdogDimension, DimensionState>;

  // endpoint_failure / api_failure are set by the poll loop, not here.
  out["endpoint_failure"] = "ok";
  out["api_failure"] = "ok";

  // ws_disconnect
  out["ws_disconnect"] =
    payload.kalshi_connection?.websocket_connected === false ? "alert" : "ok";

  // stale_btc_quote
  const btcAge = payload.usable_quotes?.btc?.age_ms;
  out["stale_btc_quote"] =
    typeof btcAge === "number" && btcAge > STALE_QUOTE_THRESHOLD_MS ? "alert" : "ok";

  // stale_eth_quote
  const ethAge = payload.usable_quotes?.eth?.age_ms;
  out["stale_eth_quote"] =
    typeof ethAge === "number" && ethAge > STALE_QUOTE_THRESHOLD_MS ? "alert" : "ok";

  // stale_autotrader
  out["stale_autotrader"] =
    payload.autotrader?.wsLive === false ? "alert" : "ok";

  // overdue_reconciliation
  const lastSweepAt = payload.reconciliation?.last_discovery_sweep_at;
  if (lastSweepAt == null) {
    // No sweep has ever run; treat as overdue only if we have uptime > threshold
    out["overdue_reconciliation"] = "ok";
  } else {
    const ageMs = nowMs - new Date(lastSweepAt).getTime();
    out["overdue_reconciliation"] = ageMs > OVERDUE_RECONCILE_MS ? "alert" : "ok";
  }

  // protective_exit_disabled
  out["protective_exit_disabled"] =
    payload.protective_exit_monitor?.enabled === false ? "alert" : "ok";

  // daily_profit_unavailable
  out["daily_profit_unavailable"] =
    payload.daily_profit_lockout?.state === "unavailable" ? "alert" : "ok";

  // This is passive research evidence only. A missing field is treated as
  // backward-compatible healthy so rollout ordering cannot create a false alert.
  out["eth420_boundary_evidence_unavailable"] =
    payload.eth420_boundary_evidence?.availability === "unavailable" ? "alert" : "ok";

  return out;
}

// ── Poll logic ────────────────────────────────────────────────────────────────

function getEndpointUrl(): string {
  const port = process.env["PORT"] ?? "3000";
  return `http://127.0.0.1:${port}/api/trade/runtime-health`;
}

function getTradeToken(): string {
  return process.env["TRADE_API_TOKEN"] ?? process.env["VITE_TRADE_API_TOKEN"] ?? "";
}

async function executeFetch(url: string, init: RequestInit): Promise<Response> {
  if (_fetchOverride) return _fetchOverride(url, init);
  return fetch(url, init);
}

async function doPoll(nowMs: number): Promise<WatchdogPollResult> {
  const polledAt = new Date(nowMs).toISOString();
  const startMs = nowMs;

  try {
    const response = await executeFetch(getEndpointUrl(), {
      method: "GET",
      headers: {
        "X-Trade-Token": getTradeToken(),
        "Accept": "application/json",
      },
    });

    const durationMs = Date.now() - startMs;

    if (!response.ok) {
      const dims = {} as Record<WatchdogDimension, DimensionState>;
      for (const d of ALL_DIMENSIONS) dims[d] = "ok";
      dims["api_failure"] = "alert";
      return {
        polledAt,
        durationMs,
        success: false,
        httpStatus: response.status,
        dimensions: dims,
        errorMessage: `HTTP ${response.status}`,
      };
    }

    const payload = await response.json() as RuntimeHealthResponse;
    // The API snapshot timestamp is the authoritative clock for fields within
    // that snapshot; fall back to poll time for older endpoint versions.
    const snapshotMs = payload.generated_at ? Date.parse(payload.generated_at) : NaN;
    const dims = classifyDimensions(payload, Number.isFinite(snapshotMs) ? snapshotMs : nowMs);

    return {
      polledAt,
      durationMs,
      success: true,
      httpStatus: response.status,
      dimensions: dims,
      diagnosticReasons:
        payload.eth420_boundary_evidence?.availability === "unavailable"
          && (payload.eth420_boundary_evidence.diagnostic_reason === "storage_unavailable"
            || payload.eth420_boundary_evidence.diagnostic_reason === "storage_read_failed")
          ? { eth420_boundary_evidence_unavailable: payload.eth420_boundary_evidence.diagnostic_reason }
          : undefined,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const dims = {} as Record<WatchdogDimension, DimensionState>;
    for (const d of ALL_DIMENSIONS) dims[d] = "ok";
    dims["endpoint_failure"] = "alert";
    return {
      polledAt,
      durationMs,
      success: false,
      httpStatus: null,
      dimensions: dims,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function applyPollResult(result: WatchdogPollResult): void {
  const transitionAt = result.polledAt;

  for (const dim of ALL_DIMENSIONS) {
    const requestedState = result.dimensions[dim];
    const newState = dim === "eth420_boundary_evidence_unavailable"
      ? (() => {
        _eth420BoundaryEvidenceFailureCount = requestedState === "alert"
          ? _eth420BoundaryEvidenceFailureCount + 1
          : 0;
        return _eth420BoundaryEvidenceFailureCount >= ETH420_BOUNDARY_EVIDENCE_ALERT_AFTER_POLLS
          ? "alert"
          : "ok";
      })()
      : requestedState;
    const current = _dimensionStates[dim];
    const diagnosticReason = newState === "alert"
      ? result.diagnosticReasons?.[dim] ?? null
      : null;

    if (current.state === newState) {
      current.consecutiveCount += 1;
      current.diagnosticReason = diagnosticReason;
    } else {
      const previousState = current.state;
      current.state = newState;
      current.since = transitionAt;
      current.consecutiveCount = 1;
      current.diagnosticReason = diagnosticReason;

      if (newState === "alert") {
        _totalAlertTransitions += 1;
      }

      if (_transitionSink) {
        try {
          void Promise.resolve(_transitionSink({
            dimension: dim,
            previousState,
            newState,
            transitionAt,
            consecutiveCount: current.consecutiveCount,
            pollResult: result,
          })).catch(() => { /* async sink failures are telemetry-only */ });
        } catch {
          // sink errors must never crash the watchdog
        }
      }
    }
  }

  _totalPolls += 1;
  _lastPolledAt = result.polledAt;
  _lastDurationMs = result.durationMs;
  _lastPollSuccess = result.success;

  // Append to ring buffer
  _history.push(result);
  if (_history.length > WATCHDOG_HISTORY_CAPACITY) {
    _history = _history.slice(_history.length - WATCHDOG_HISTORY_CAPACITY);
  }

  if (_historySink) {
    try {
      void Promise.resolve(_historySink(result)).catch(() => { /* async sink failures are telemetry-only */ });
    } catch {
      // sink errors must never crash the watchdog
    }
  }
}

async function runOnePoll(): Promise<void> {
  const result = await doPoll(Date.now());
  applyPollResult(result);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the watchdog polling loop. Safe to call multiple times — subsequent
 * calls are no-ops if already running.
 */
export function startWatchdog(intervalMs = WATCHDOG_POLL_INTERVAL_MS): void {
  if (_pollTimer !== null) return;
  // Fire immediately on start, then on interval
  void runOnePoll();
  _pollTimer = setInterval(() => { void runOnePoll(); }, intervalMs);
}

/**
 * Stop the watchdog polling loop. Idempotent.
 */
export function stopWatchdog(): void {
  if (_pollTimer !== null) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

/**
 * Return a snapshot of the current watchdog status.
 */
export function getWatchdogStatus(): WatchdogStatus {
  const dims = {} as Record<WatchdogDimension, DimensionStatus>;
  for (const d of ALL_DIMENSIONS) {
    const s = _dimensionStates[d];
    dims[d] = { ...s };
  }
  return {
    lastPolledAt: _lastPolledAt,
    lastDurationMs: _lastDurationMs,
    lastPollSuccess: _lastPollSuccess,
    dimensions: dims,
    totalPolls: _totalPolls,
    totalAlertTransitions: _totalAlertTransitions,
  };
}

/**
 * Return a copy of the in-process ring buffer of recent poll results.
 * Ordered oldest-first.
 */
export function getWatchdogHistory(): WatchdogPollResult[] {
  return [..._history];
}

/**
 * Returns true when the given dimension has no active alert.
 */
export function isWatchdogDimensionHealthy(dim: WatchdogDimension): boolean {
  return _dimensionStates[dim].state === "ok";
}

/**
 * Returns true when all dimensions are healthy.
 */
export function isWatchdogFullyHealthy(): boolean {
  return ALL_DIMENSIONS.every((d) => _dimensionStates[d].state === "ok");
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Run a single poll immediately (bypasses the interval timer) and return the
 * poll result.  Intended for deterministic unit tests only.
 */
export async function _executePollForTesting(): Promise<WatchdogPollResult> {
  const result = await doPoll(Date.now());
  applyPollResult(result);
  return result;
}

export function _resetWatchdogForTesting(): void {
  stopWatchdog();
  _dimensionStates = (() => {
    const out = {} as Record<WatchdogDimension, DimensionStatus>;
    for (const d of ALL_DIMENSIONS) out[d] = makeDimensionStatus(d);
    return out;
  })();
  _totalPolls = 0;
  _totalAlertTransitions = 0;
  _lastPolledAt = null;
  _lastDurationMs = null;
  _lastPollSuccess = null;
  _history = [];
  _eth420BoundaryEvidenceFailureCount = 0;
  _transitionSink = null;
  _historySink = null;
  _fetchOverride = null;
}
