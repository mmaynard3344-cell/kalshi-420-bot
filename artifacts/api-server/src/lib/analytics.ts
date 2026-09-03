/**
 * Passive production analytics — pure in-memory service.
 *
 * Measures live bot behaviour without affecting trading decisions.
 * All public functions are wrapped in try/catch; exceptions are logged to
 * "analytics_error" and swallowed so calling code is never interrupted.
 *
 * Design constraints:
 *  - No imports from autoTrader.ts, trade.ts, or any replay file.
 *  - No disk I/O — persistence handled by analyticsStore.ts.
 *  - All state mutations are synchronous (Node.js single-threaded).
 *  - setStoreHook() lets tests inject a failing writer to verify error isolation.
 *  - setRecordUpdateHook() lets analyticsStore.ts persist records on final state.
 */

import { easternDay } from "./dailyBudget.js";

// ── Types (exported for consumers) ────────────────────────────────────────────

export type FillValueSource =
  | "estimated"
  | "confirmed_from_response"
  | "confirmed_from_fills_api";

export interface TrackedValue<T> {
  value:  T;
  source: FillValueSource;
}

export type GuardOutcomeName =
  | "outside_zone"
  | "outside_time_window"
  | "cooldown"
  | "window_budget"
  | "zero_contracts"
  | "halted"
  | "dedup"
  | "daily_cap"
  | "position_guard"
  | "position_error"
  | "price_band_guard"
  | "submission_in_flight"
  | "submitted"
  | "zero_fill"
  | "partial_fill"
  | "full_fill"
  | "rejected"
  | "ambiguous_response"
  | "api_error"
  | "network_error"
  | "sql_reserve_failed"
  | "suppressed_retry_after_zero_fill"
  | "zero_fill_retry_budget_exhausted"
  | "preflight_skip"
  | "preflight_skip_suppressed"
  | "incoherent_bbo_snapshot"
  | "wide_spread"
  /** Week 2 control: fully observed non-ETH entry intentionally withheld. */
  | "week2_eth_only_new_entries";

export interface ZeroFillDiagnostic {
  requestedContracts: number;
  limitPriceCents:    number;
  triggerPriceCents:  number;
  yesBid:             number | null;
  noBid:              number | null;
  yesDerivedAsk:      number | null;
  noDerivedAsk:       number | null;
  yesAsk:             number | null;
  noAsk:              number | null;
  snapshotAgeMs:      number;
  snapshotSource:     "websocket" | "rest_fallback" | "startup_prime";
  roundTripMs:        number;
}

export type OrderOutcome =
  | "full_fill"
  | "partial_fill"
  | "zero_fill"
  | "rejected"
  | "ambiguous"
  | "error";

/**
 * Safe, bounded evidence for why an order attempt did or did not reach Kalshi.
 * This is deliberately free of request signatures, authorization headers, and
 * full provider payloads so it can safely be returned by the dashboard API.
 */
export interface SubmissionAudit {
  stage: string;
  reason: string | null;
  recordedAtMs: number;
  postInitiated: boolean;
  responseReceived: boolean;
  originalExecutablePriceCents?: number | null;
  finalExecutablePriceCents?: number | null;
  finalQuoteAgeMs?: number | null;
  finalPriceDeltaCents?: number | null;
  finalQuoteError?: string | null;
  httpStatus?: number | null;
  providerMessage?: string | null;
  postDurationMs?: number | null;
}

export interface OrderAttemptRecord {
  id:                     string;
  timestampMs:            number;
  ticker:                 string;
  series:                 string;
  windowCloseTime:        string | null;
  side:                   "yes" | "no";
  attemptNumber:          number;
  source:                 "websocket" | "rest_fallback" | "startup_prime";
  triggerPriceCents:      number;
  limitPriceCents:        number;
  requestedContracts:     number;
  requestedNotionalCents: number;
  clientOrderId:          string;
  orderId:                string | null;
  fillCount:              number;
  remainingCount:         number;
  contracts:              TrackedValue<number>;
  fillPriceCents:         TrackedValue<number | null>;
  notionalDollars:        TrackedValue<number>;
  feeDollars:             TrackedValue<number>;
  outcome:                OrderOutcome;
  submissionAudit?:       SubmissionAudit | null;
  zeroFillDiagnostic?:    ZeroFillDiagnostic;
  roundTripMs:            number | null;
  // ── Order timeline instrumentation (epoch ms, nullable) ─────────────────
  tickReceivedMs?:        number | null;
  evalStartMs?:           number | null;
  l2StartMs?:             number | null;
  l2EndMs?:               number | null;
  postStartMs?:           number | null;
  ackMs?:                 number | null;
  // ── Pre-flight L2 snapshot at decision time ──────────────────────────────
  l2BestAskCents?:        number | null;
  l2DepthDollars?:        number | null;
  l2DepthContracts?:      number | null;
  reconciled:             boolean;
  reconcile_failed?:      boolean;
  fill_price_source?:     "actual" | "limit_fallback" | null;
  discrepancies?: {
    contracts?:       { estimated: number; confirmed: number };
    fillPriceCents?:  { estimated: number; confirmed: number };
    notionalDollars?: { estimated: number; confirmed: number };
    feeDollars?:      { estimated: number; confirmed: number };
  };
  // ── Market outcome fields (set by outcomeReconciler after market settles) ──
  marketResult?:        "yes" | "no" | null;   // Kalshi market resolution
  win?:                 boolean | null;          // true if our side === marketResult
  grossPnlDollars?:     number | null;          // (100-fill)*cts/100 win; -fill*cts/100 loss
  netPnlDollars?:       number | null;          // grossPnlDollars - feeDollars
  roi?:                 number | null;          // grossPnlDollars / notionalDollars
  outcomeReconciledAt?: number | null;          // ms timestamp of reconciliation
  windowClosedAtMs?:    number | null;          // ms timestamp of window close
  holdMs?:              number | null;          // windowClosedAtMs - timestampMs
}

export interface WindowAttemptDetail {
  attemptNumber:      number;
  side:               "yes" | "no";
  triggerPriceCents:  number;
  limitPriceCents:    number;
  requestedContracts: number;
}

export type WindowResult =
  | "outside_zone"
  | "no_submission"
  | "zero_fill_only"
  | "partial_fill"
  | "filled"
  | "blocked"
  | "pending";

export interface WindowAnalytics {
  ticker:                  string;
  series:                  string;
  windowStartMs:           number;
  windowClose:             string | null;
  yesEnteredZone:          boolean;
  noEnteredZone:           boolean;
  firstInZoneMs:           number | null;
  lastInZoneMs:            number | null;
  qualifyingEvaluations:   number;
  submittedOrders:         number;
  zeroFills:               number;
  partialFills:            number;
  fullFills:               number;
  attemptNumberThatFilled: number | null;
  attempts:                WindowAttemptDetail[];
  actualFilledContracts:   number;
  actualFillPriceCents:    number | null;
  totalSpendDollars:       number;
  totalFeesDollars:        number;
  result:                  WindowResult;
}

export interface GuardOutcomeCounts {
  outside_zone:        number;
  outside_time_window: number;
  cooldown:            number;
  window_budget:       number;
  zero_contracts:      number;
  halted:              number;
  dedup:               number;
  daily_cap:           number;
  position_guard:      number;
  position_error:      number;
  price_band_guard:    number;
  submission_in_flight: number;
  submitted:           number;
  zero_fill:           number;
  partial_fill:        number;
  full_fill:           number;
  rejected:            number;
  ambiguous_response:  number;
  api_error:              number;
  network_error:          number;
  sql_reserve_failed:                number;
  suppressed_retry_after_zero_fill:  number;
  zero_fill_retry_budget_exhausted:  number;
  preflight_skip:                    number;
  preflight_skip_suppressed:         number;
  incoherent_bbo_snapshot:           number;
  wide_spread:                       number;
  week2_eth_only_new_entries:        number;
}

export interface SeriesSummary {
  series:                        string;
  windowsObserved:               number;
  windowsEnteringZone:           number;
  orderSubmissions:              number;
  successfulFills:               number;
  partialFills:                  number;
  zeroFills:                     number;
  rejections:                    number;
  ambiguousResponses:            number;
  fillRateByOrderAttempt:        number | null;
  fillRateByQualifyingWindow:    number | null;
  avgAttemptsPerFilledTicker:    number | null;
  medianAttemptsPerFilledTicker: number | null;
  maxAttemptsOnOneTicker:        number;
  avgRequestedContracts:         number | null;
  avgFilledContracts:            number | null;
  submittedNotionalDollars:      number;
  reservedNotionalDollars:       number;
  filledNotionalDollars:         number;
  feesDollars:                   number;
  avgLimitPriceCents:            number | null;
  avgActualFillPriceCents:       number | null;
  avgPriceImprovementCents:      number | null;
  guardOutcomeCounts:            Partial<GuardOutcomeCounts>;
  restTriggeredOrders:           number;
  websocketTriggeredOrders:      number;
  // P&L fields — populated only for records with resolved market outcomes
  netPnlDollars:                 number;
  winsCount:                     number;
  lossesCount:                   number;
  winRate:                       number | null;
}

export interface DailySummary {
  date:     string;
  btc:      SeriesSummary;
  eth:      SeriesSummary;
  combined: SeriesSummary;
}

// ── Internal state ────────────────────────────────────────────────────────────

const MAX_ORDERS = 1_000;

const _orders: OrderAttemptRecord[] = [];           // newest first
const _ordersById = new Map<string, OrderAttemptRecord>();
const _attemptCounter = new Map<string, number>();  // "${ticker}-${side}" → count
const _retrySeqs = new Map<string, {
  ticker:                    string;
  side:                      "yes" | "no";
  totalSubmissions:          number;
  zeroFillsBeforeFirstFill:  number;
  attemptNumberThatFilled:   number | null;
  everFilled:                boolean;
  firstSignalMs:             number | null;
  firstFillMs:               number | null;
  timeToFirstFillMs:         number | null;
  attemptTimestampsMs:       number[];
  timeBetweenAttemptsMs:     number[];
  finalContracts:            number;
  finalActualSpendDollars:   number;
  finalFeesDollars:          number;
}>();
const _windows = new Map<string, WindowAnalytics>(); // ticker → analytics
const _guardCounts = new Map<string, GuardOutcomeCounts>(); // series → counts

let _dailyDate = "";

/** Optional store hook — called after every state change. Tests inject a throwing fn here. */
let _storeHook: (() => void) | null = null;

/** Called with the final record state when a record reaches zero_fill or fill status. */
let _recordUpdateHook: ((record: OrderAttemptRecord) => void) | null = null;

export function setStoreHook(fn: (() => void) | null): void {
  _storeHook = fn;
}

/**
 * Register a callback called whenever a record reaches its final state (zero-fill or fill).
 * Used by analyticsStore.ts to persist records to disk without coupling this module to I/O.
 */
export function setRecordUpdateHook(fn: ((record: OrderAttemptRecord) => void) | null): void {
  _recordUpdateHook = fn;
}

/** Look up a single order record by its attempt ID. */
export function getOrderAttemptById(id: string): OrderAttemptRecord | undefined {
  try { return _ordersById.get(id); } catch { return undefined; }
}

/** Test-only: reset all in-memory state. */
export function _resetStateForTesting(): void {
  _orders.length = 0;
  _ordersById.clear();
  _attemptCounter.clear();
  _retrySeqs.clear();
  _windows.clear();
  _guardCounts.clear();
  _dailyDate = "";
  _storeHook = null;
  _recordUpdateHook = null;
}

/** Test-only: backdate the current day so the next maybeRollDay() triggers a reset. */
export function _setDayForTesting(day: string): void {
  _dailyDate = day;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshGuardCounts(): GuardOutcomeCounts {
  return {
    outside_zone: 0, outside_time_window: 0, cooldown: 0, window_budget: 0,
    zero_contracts: 0, halted: 0, dedup: 0, daily_cap: 0, position_guard: 0,
    position_error: 0, price_band_guard: 0, submission_in_flight: 0,
    submitted: 0, zero_fill: 0, partial_fill: 0, full_fill: 0,
    rejected: 0, ambiguous_response: 0, api_error: 0, network_error: 0,
    sql_reserve_failed: 0, suppressed_retry_after_zero_fill: 0,
    zero_fill_retry_budget_exhausted: 0, wide_spread: 0,
    preflight_skip: 0, preflight_skip_suppressed: 0,
    incoherent_bbo_snapshot: 0, week2_eth_only_new_entries: 0,
  };
}

function countsFor(series: string): GuardOutcomeCounts {
  if (!_guardCounts.has(series)) _guardCounts.set(series, freshGuardCounts());
  return _guardCounts.get(series)!;
}

function bumpCount(series: string, outcome: GuardOutcomeName): void {
  countsFor(series)[outcome]++;
  if (series !== "combined") countsFor("combined")[outcome]++;
}

function notifyStore(): void {
  try { _storeHook?.(); } catch { /* hook failures must never propagate */ }
}

function maybeRollDay(): void {
  const today = easternDay(new Date());
  if (_dailyDate === today) return;
  // New Eastern day — reset per-day counters
  _dailyDate = today;
  _guardCounts.clear();
  _attemptCounter.clear();
  _retrySeqs.clear();
  // Keep windows — they roll via rollWindowAnalytics()
  // Keep orders — historical record
}

function avgOrNull(arr: number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function medianOrNull(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m]! : ((s[m - 1]! + s[m]!) / 2);
}

// ── Guard outcome recording ───────────────────────────────────────────────────

/** Record a guard decision that blocked an order (or was an out-of-zone/time evaluation). */
export function recordGuardOutcome(series: string, outcome: GuardOutcomeName): void {
  try {
    maybeRollDay();
    bumpCount(series, outcome);
    notifyStore();
  } catch (err) {
    console.warn("analytics: recordGuardOutcome failed", { err, series, outcome, analytics_error: true });
  }
}

// ── Order attempt recording ───────────────────────────────────────────────────

export interface RecordOrderAttemptParams {
  ticker:             string;
  series:             string;
  windowCloseTime:    string | null;
  side:               "yes" | "no";
  source:             "websocket" | "rest_fallback" | "startup_prime";
  triggerPriceCents:  number;
  limitPriceCents:    number;
  requestedContracts: number;
  clientOrderId:      string;
  timestampMs?:       number;  // defaults to Date.now()
}

/**
 * Record a submitted order attempt. Returns the attempt ID for subsequent
 * zero-fill / fill / reconciliation calls. Returns "" on error.
 */
export function recordOrderAttempt(params: RecordOrderAttemptParams): string {
  try {
    maybeRollDay();
    const now = params.timestampMs ?? Date.now();
    const key = `${params.ticker}-${params.side}`;

    // Increment attempt counter for this ticker+side
    const attemptNumber = (_attemptCounter.get(key) ?? 0) + 1;
    _attemptCounter.set(key, attemptNumber);

    // Ensure retry sequence exists
    if (!_retrySeqs.has(key)) {
      _retrySeqs.set(key, {
        ticker: params.ticker, side: params.side,
        totalSubmissions: 0, zeroFillsBeforeFirstFill: 0,
        attemptNumberThatFilled: null, everFilled: false,
        firstSignalMs: now, firstFillMs: null, timeToFirstFillMs: null,
        attemptTimestampsMs: [], timeBetweenAttemptsMs: [],
        finalContracts: 0, finalActualSpendDollars: 0, finalFeesDollars: 0,
      });
    }
    const seq = _retrySeqs.get(key)!;
    if (seq.firstSignalMs === null) seq.firstSignalMs = now;
    if (seq.attemptTimestampsMs.length > 0) {
      const prev = seq.attemptTimestampsMs[seq.attemptTimestampsMs.length - 1]!;
      seq.timeBetweenAttemptsMs.push(now - prev);
    }
    seq.attemptTimestampsMs.push(now);
    seq.totalSubmissions++;

    // Ensure window analytics entry
    if (!_windows.has(params.ticker)) {
      _windows.set(params.ticker, {
        ticker: params.ticker, series: params.series,
        windowStartMs: now, windowClose: params.windowCloseTime,
        yesEnteredZone: false, noEnteredZone: false,
        firstInZoneMs: null, lastInZoneMs: null,
        qualifyingEvaluations: 0, submittedOrders: 0,
        zeroFills: 0, partialFills: 0, fullFills: 0,
        attemptNumberThatFilled: null, attempts: [],
        actualFilledContracts: 0, actualFillPriceCents: null,
        totalSpendDollars: 0, totalFeesDollars: 0, result: "pending",
      });
    }
    const win = _windows.get(params.ticker)!;
    if (params.windowCloseTime && !win.windowClose) win.windowClose = params.windowCloseTime;
    win.submittedOrders++;
    win.attempts.push({
      attemptNumber, side: params.side,
      triggerPriceCents: params.triggerPriceCents,
      limitPriceCents:   params.limitPriceCents,
      requestedContracts: params.requestedContracts,
    });

    bumpCount(params.series, "submitted");

    const id = `${params.clientOrderId}-${attemptNumber}`;
    const record: OrderAttemptRecord = {
      id,
      timestampMs:            now,
      ticker:                 params.ticker,
      series:                 params.series,
      windowCloseTime:        params.windowCloseTime,
      side:                   params.side,
      attemptNumber,
      source:                 params.source,
      triggerPriceCents:      params.triggerPriceCents,
      limitPriceCents:        params.limitPriceCents,
      requestedContracts:     params.requestedContracts,
      requestedNotionalCents: params.requestedContracts * params.limitPriceCents,
      clientOrderId:          params.clientOrderId,
      orderId:                null,
      fillCount:              0,
      remainingCount:         params.requestedContracts,
      contracts:              { value: 0,    source: "estimated" },
      fillPriceCents:         { value: null, source: "estimated" },
      notionalDollars:        { value: 0,    source: "estimated" },
      feeDollars:             { value: 0,    source: "estimated" },
      outcome:                "zero_fill",   // updated by recordZeroFill / recordFill
      roundTripMs:            null,
      reconciled:             false,
    };

    _orders.unshift(record);
    if (_orders.length > MAX_ORDERS) _orders.pop();
    _ordersById.set(id, record);

    // Write to NDJSON immediately at submission time so the record is durable
    // even if the server restarts before recordZeroFill / recordFill is called.
    // The later fill/zero-fill hook call will append a second line with updated
    // state; last-write-wins loading ensures the final state wins on next load.
    try { _recordUpdateHook?.(record); } catch {}

    notifyStore();
    return id;
  } catch (err) {
    console.warn("analytics: recordOrderAttempt failed", { err, analytics_error: true, ticker: params.ticker });
    return "";
  }
}

// ── Zero-fill recording ───────────────────────────────────────────────────────

export function recordZeroFill(attemptId: string, diagnostic: ZeroFillDiagnostic): void {
  try {
    const record = _ordersById.get(attemptId);
    if (record) {
      record.outcome            = "zero_fill";
      record.roundTripMs        = diagnostic.roundTripMs;
      record.fillCount          = 0;
      record.remainingCount     = record.requestedContracts;
      record.zeroFillDiagnostic = diagnostic;
      record.contracts          = { value: 0, source: "estimated" };
      record.notionalDollars    = { value: 0, source: "estimated" };
      // Notify persistence with the finalized record
      try { _recordUpdateHook?.(record); } catch {}
    }

    const key = record ? `${record.ticker}-${record.side}` : "";
    const seq = key ? _retrySeqs.get(key) : undefined;
    if (seq && !seq.everFilled) seq.zeroFillsBeforeFirstFill++;

    const win = record ? _windows.get(record.ticker) : undefined;
    if (win) {
      win.zeroFills++;
      if (win.result === "pending") win.result = "zero_fill_only";
    }

    bumpCount(record?.series ?? "", "zero_fill");
    notifyStore();
  } catch (err) {
    console.warn("analytics: recordZeroFill failed", { err, attemptId, analytics_error: true });
  }
}

// ── Fill recording ────────────────────────────────────────────────────────────

export interface RecordFillParams {
  orderId:          string | null;
  fillCount:        number;
  requestedCount:   number;
  contractsFilled:  number;
  fillPriceCents:   number;   // limit price or actual (depends on pricesKnown)
  notionalDollars:  number;
  feeDollars:       number;
  pricesKnown:      boolean;  // true = confirmed_from_response; false = estimated
  roundTripMs:      number;
}

export function recordFill(attemptId: string, params: RecordFillParams): void {
  try {
    const record = _ordersById.get(attemptId);
    if (record) {
      const isPartial = params.fillCount < params.requestedCount;
      const src: FillValueSource = params.pricesKnown
        ? "confirmed_from_response"
        : "estimated";

      record.orderId         = params.orderId;
      record.fillCount       = params.fillCount;
      record.remainingCount  = Math.max(0, params.requestedCount - params.fillCount);
      record.roundTripMs     = params.roundTripMs;
      record.outcome         = isPartial ? "partial_fill" : "full_fill";
      record.contracts       = { value: params.contractsFilled, source: src };
      record.fillPriceCents  = { value: params.fillPriceCents,  source: src };
      record.notionalDollars = { value: params.notionalDollars,  source: src };
      record.feeDollars      = { value: params.feeDollars,       source: src };
      // Notify persistence with the finalized record
      try { _recordUpdateHook?.(record); } catch {}
    }

    const key = record ? `${record.ticker}-${record.side}` : "";
    const seq = key ? _retrySeqs.get(key) : undefined;
    if (seq && !seq.everFilled) {
      seq.everFilled              = true;
      seq.attemptNumberThatFilled = record?.attemptNumber ?? null;
      seq.firstFillMs             = Date.now();
      seq.timeToFirstFillMs       = seq.firstSignalMs !== null
        ? seq.firstFillMs - seq.firstSignalMs : null;
    }
    if (seq) {
      seq.finalContracts          += params.contractsFilled;
      seq.finalActualSpendDollars += params.notionalDollars;
      seq.finalFeesDollars        += params.feeDollars;
    }

    const win = record ? _windows.get(record.ticker) : undefined;
    if (win) {
      const isPartial = params.fillCount < params.requestedCount;
      if (isPartial) {
        win.partialFills++;
        if (win.result !== "filled") win.result = "partial_fill";
      } else {
        win.fullFills++;
        win.result = "filled";
        if (win.attemptNumberThatFilled === null) {
          win.attemptNumberThatFilled = record?.attemptNumber ?? null;
        }
      }
      win.actualFilledContracts += params.contractsFilled;
      win.totalSpendDollars     += params.notionalDollars;
      win.totalFeesDollars      += params.feeDollars;
      if (win.actualFillPriceCents === null) {
        win.actualFillPriceCents = params.fillPriceCents;
      }
    }

    const outcome: GuardOutcomeName = params.fillCount < params.requestedCount
      ? "partial_fill" : "full_fill";
    bumpCount(record?.series ?? "", outcome);
    notifyStore();
  } catch (err) {
    console.warn("analytics: recordFill failed", { err, attemptId, analytics_error: true });
  }
}

// ── Fill reconciliation (async, from fills API) ───────────────────────────────

export interface ReconciliationParams {
  contracts:       number;
  fillPriceCents:  number;
  notionalDollars: number;
  feeDollars:      number;
}

export function recordReconciliation(attemptId: string, params: ReconciliationParams): void {
  try {
    const record = _ordersById.get(attemptId);
    if (!record) return;

    const prior = {
      contracts:       record.contracts.value,
      fillPriceCents:  record.fillPriceCents.value,
      notionalDollars: record.notionalDollars.value,
      feeDollars:      record.feeDollars.value,
    };

    record.contracts       = { value: params.contracts,        source: "confirmed_from_fills_api" };
    record.fillPriceCents  = { value: params.fillPriceCents,   source: "confirmed_from_fills_api" };
    record.notionalDollars = { value: params.notionalDollars,  source: "confirmed_from_fills_api" };
    record.feeDollars      = { value: params.feeDollars,       source: "confirmed_from_fills_api" };
    record.reconciled      = true;

    const disc: NonNullable<OrderAttemptRecord["discrepancies"]> = {};
    if ((prior.contracts ?? 0) !== params.contracts) {
      disc.contracts = { estimated: prior.contracts ?? 0, confirmed: params.contracts };
    }
    if (prior.fillPriceCents !== null && prior.fillPriceCents !== params.fillPriceCents) {
      disc.fillPriceCents = { estimated: prior.fillPriceCents, confirmed: params.fillPriceCents };
    }
    const eps = 0.001;
    if (Math.abs((prior.notionalDollars ?? 0) - params.notionalDollars) > eps) {
      disc.notionalDollars = { estimated: prior.notionalDollars ?? 0, confirmed: params.notionalDollars };
    }
    if (Math.abs((prior.feeDollars ?? 0) - params.feeDollars) > eps) {
      disc.feeDollars = { estimated: prior.feeDollars ?? 0, confirmed: params.feeDollars };
    }
    if (Object.keys(disc).length > 0) {
      record.discrepancies = disc;
      console.info("analytics: fill reconciliation discrepancy", { attemptId, discrepancies: disc });
    }

    notifyStore();
  } catch (err) {
    console.warn("analytics: recordReconciliation failed", { err, attemptId, analytics_error: true });
  }
}

/**
 * Mark an order attempt as permanently failed to reconcile (all retries exhausted).
 * Leaves the fill values as estimated; sets reconcile_failed = true.
 */
export function recordReconciliationFailed(attemptId: string): void {
  try {
    const record = _ordersById.get(attemptId);
    if (!record) return;
    record.reconcile_failed = true;
    notifyStore();
  } catch (err) {
    console.warn("analytics: recordReconciliationFailed failed", { err, attemptId, analytics_error: true });
  }
}
export interface RecordQualifyingEvalParams {
  ticker:          string;
  series:          string;
  windowCloseTime: string | null;
  timestampMs:     number;
  yesDerivedAsk:   number | null;
  noDerivedAsk:    number | null;
}

/** Record an in-zone evaluation tick. Called from evaluate() for each qualifying tick. */
export function recordQualifyingEvaluation(params: RecordQualifyingEvalParams): void {
  try {
    maybeRollDay();
    const { ticker, series, windowCloseTime, timestampMs, yesDerivedAsk, noDerivedAsk } = params;

    if (!_windows.has(ticker)) {
      _windows.set(ticker, {
        ticker, series, windowStartMs: timestampMs,
        windowClose: windowCloseTime,
        yesEnteredZone: false, noEnteredZone: false,
        firstInZoneMs: null, lastInZoneMs: null,
        qualifyingEvaluations: 0, submittedOrders: 0,
        zeroFills: 0, partialFills: 0, fullFills: 0,
        attemptNumberThatFilled: null, attempts: [],
        actualFilledContracts: 0, actualFillPriceCents: null,
        totalSpendDollars: 0, totalFeesDollars: 0, result: "pending",
      });
    }
    const win = _windows.get(ticker)!;
    if (windowCloseTime && !win.windowClose) win.windowClose = windowCloseTime;
    win.qualifyingEvaluations++;
    if (win.firstInZoneMs === null) win.firstInZoneMs = timestampMs;
    win.lastInZoneMs = timestampMs;
    if (yesDerivedAsk !== null) win.yesEnteredZone = true;
    if (noDerivedAsk  !== null) win.noEnteredZone  = true;
  } catch (err) {
    console.warn("analytics: recordQualifyingEvaluation failed", { err, analytics_error: true, ticker: params.ticker });
  }
}

// ── Window rollover ───────────────────────────────────────────────────────────

/** Seal the previous window's result when a new ticker is detected. */
export function rollWindowAnalytics(series: string, prevTicker: string): void {
  try {
    const win = _windows.get(prevTicker);
    if (!win || win.result !== "pending") return;
    // Determine final result for the closed window
    if (win.fullFills > 0 || win.partialFills > 0) {
      win.result = win.partialFills > 0 && win.fullFills === 0 ? "partial_fill" : "filled";
    } else if (win.zeroFills > 0) {
      win.result = "zero_fill_only";
    } else if (win.qualifyingEvaluations > 0) {
      win.result = "no_submission";
    } else {
      win.result = "outside_zone";
    }
    notifyStore();
  } catch (err) {
    console.warn("analytics: rollWindowAnalytics failed", { err, analytics_error: true, series, prevTicker });
  }
}

// ── Read-only getters ─────────────────────────────────────────────────────────

export function getOrderAttempts(ticker?: string, limit = 100): OrderAttemptRecord[] {
  try {
    const filtered = ticker ? _orders.filter((o) => o.ticker === ticker) : _orders;
    return filtered.slice(0, limit);
  } catch { return []; }
}

export function getWindowAnalytics(series?: string): WindowAnalytics[] {
  try {
    const all = [..._windows.values()];
    const filtered = series ? all.filter((w) => w.series === series) : all;
    return filtered.sort((a, b) => b.windowStartMs - a.windowStartMs);
  } catch { return []; }
}

/**
 * Get all filled/partial-fill orders for a specific ticker.
 * Used by outcomeReconciler to find orders needing outcome reconciliation.
 */
export function getFilledAttemptsByTicker(ticker: string): OrderAttemptRecord[] {
  try {
    return _orders.filter(
      (o) => o.ticker === ticker &&
             (o.outcome === "full_fill" || o.outcome === "partial_fill"),
    );
  } catch { return []; }
}

// ── Market outcome recording (from outcomeReconciler after market settles) ─────

export interface OutcomeResultParams {
  marketResult:     "yes" | "no";
  win:              boolean;
  grossPnlDollars:  number;
  netPnlDollars:    number;
  roi:              number;
  windowClosedAtMs: number;
  holdMs:           number;
  reconciledAtMs:   number;
}

/**
 * Record market outcome fields on a specific filled order.
 * Called by outcomeReconciler ~3 minutes after the window closes.
 * Fires _recordUpdateHook so the updated record is persisted to disk.
 * Wrapped in try/catch — errors here must never affect live trading.
 */
export function recordOutcomeResult(attemptId: string, params: OutcomeResultParams): void {
  try {
    const record = _ordersById.get(attemptId);
    if (!record) return;
    record.marketResult        = params.marketResult;
    record.win                 = params.win;
    record.grossPnlDollars     = params.grossPnlDollars;
    record.netPnlDollars       = params.netPnlDollars;
    record.roi                 = params.roi;
    record.windowClosedAtMs    = params.windowClosedAtMs;
    record.holdMs              = params.holdMs;
    record.outcomeReconciledAt = params.reconciledAtMs;
    try { _recordUpdateHook?.(record); } catch {}
    notifyStore();
  } catch (err) {
    console.warn("analytics: recordOutcomeResult failed", { err, attemptId, analytics_error: true });
  }
}

// ── Daily summary (derived on read) ──────────────────────────────────────────

function buildSeries(seriesKey: string): SeriesSummary {
  const orders   = _orders.filter((o) => o.series === seriesKey);
  const windows  = [..._windows.values()].filter((w) => w.series === seriesKey);
  const filled   = orders.filter((o) => o.outcome === "full_fill" || o.outcome === "partial_fill");
  const partial  = orders.filter((o) => o.outcome === "partial_fill");
  const full     = orders.filter((o) => o.outcome === "full_fill");
  const zeros    = orders.filter((o) => o.outcome === "zero_fill");

  const filledNotional    = filled.reduce((s, o) => s + o.notionalDollars.value, 0);
  const fees              = filled.reduce((s, o) => s + o.feeDollars.value, 0);
  const submittedNotional = orders.reduce((s, o) => s + o.requestedNotionalCents / 100, 0);

  const seqsForSeries = [..._retrySeqs.values()].filter((s) => s.ticker.startsWith(seriesKey));
  const attemptsPerFill = seqsForSeries.filter((s) => s.everFilled)
    .map((s) => s.attemptNumberThatFilled ?? s.totalSubmissions);

  const limitPrices      = orders.map((o) => o.limitPriceCents);
  const confirmedPrices  = filled
    .filter((o) => o.fillPriceCents.value !== null)
    .map((o) => o.fillPriceCents.value as number);
  const avgLimit         = avgOrNull(limitPrices);
  const avgFill          = avgOrNull(confirmedPrices);

  const zoneWindows    = windows.filter((w) => w.qualifyingEvaluations > 0).length;
  const filledWindows  = windows.filter((w) => w.result === "filled" || w.result === "partial_fill").length;

  const counts = _guardCounts.get(seriesKey) ?? freshGuardCounts();

  return {
    series:                        seriesKey,
    windowsObserved:               windows.length,
    windowsEnteringZone:           zoneWindows,
    orderSubmissions:              orders.length,
    successfulFills:               full.length,
    partialFills:                  partial.length,
    zeroFills:                     zeros.length,
    rejections:                    orders.filter((o) => o.outcome === "rejected").length,
    ambiguousResponses:            orders.filter((o) => o.outcome === "ambiguous").length,
    fillRateByOrderAttempt:        orders.length > 0 ? filled.length / orders.length : null,
    fillRateByQualifyingWindow:    zoneWindows > 0 ? filledWindows / zoneWindows : null,
    avgAttemptsPerFilledTicker:    avgOrNull(attemptsPerFill),
    medianAttemptsPerFilledTicker: medianOrNull(attemptsPerFill),
    maxAttemptsOnOneTicker:        attemptsPerFill.length > 0 ? Math.max(...attemptsPerFill) : 0,
    avgRequestedContracts:         avgOrNull(orders.map((o) => o.requestedContracts)),
    avgFilledContracts:            avgOrNull(filled.map((o) => o.contracts.value)),
    submittedNotionalDollars:      submittedNotional,
    reservedNotionalDollars:       submittedNotional,
    filledNotionalDollars:         filledNotional,
    feesDollars:                   fees,
    avgLimitPriceCents:            avgLimit,
    avgActualFillPriceCents:       avgFill,
    avgPriceImprovementCents:      (avgLimit !== null && avgFill !== null) ? avgLimit - avgFill : null,
    guardOutcomeCounts:            { ...counts },
    restTriggeredOrders:           orders.filter((o) => o.source === "rest_fallback").length,
    websocketTriggeredOrders:      orders.filter((o) => o.source === "websocket").length,
    // P&L — aggregate only records that have a resolved outcome (netPnlDollars set)
    netPnlDollars: filled
      .filter((o) => typeof o.netPnlDollars === "number" && o.netPnlDollars !== null)
      .reduce((s, o) => s + (o.netPnlDollars as number), 0),
    winsCount: filled
      .filter((o) => typeof o.netPnlDollars === "number" && o.netPnlDollars !== null && (o.netPnlDollars as number) > 0)
      .length,
    lossesCount: filled
      .filter((o) => typeof o.netPnlDollars === "number" && o.netPnlDollars !== null && (o.netPnlDollars as number) <= 0)
      .length,
    get winRate(): number | null {
      const resolved = filled.filter((o) => typeof o.netPnlDollars === "number" && o.netPnlDollars !== null);
      if (resolved.length === 0) return null;
      const wins = resolved.filter((o) => (o.netPnlDollars as number) > 0).length;
      return wins / resolved.length;
    },
  };
}

export function getDailySummary(): DailySummary {
  try {
    maybeRollDay();
    const btc = buildSeries("KXBTC15M");
    const eth = buildSeries("KXETH15M");

    const allFilled = btc.successfulFills + btc.partialFills + eth.successfulFills + eth.partialFills;
    const allSubs   = btc.orderSubmissions + eth.orderSubmissions;
    const allZone   = btc.windowsEnteringZone + eth.windowsEnteringZone;
    const allFilledW = [..._windows.values()]
      .filter((w) => w.result === "filled" || w.result === "partial_fill").length;
    const combined  = _guardCounts.get("combined") ?? freshGuardCounts();

    const avgA = (a: number | null, b: number | null): number | null => {
      const v = [a, b].filter((x): x is number => x !== null);
      return v.length > 0 ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };

    const combinedSummary: SeriesSummary = {
      series:                        "combined",
      windowsObserved:               btc.windowsObserved + eth.windowsObserved,
      windowsEnteringZone:           allZone,
      orderSubmissions:              allSubs,
      successfulFills:               btc.successfulFills + eth.successfulFills,
      partialFills:                  btc.partialFills + eth.partialFills,
      zeroFills:                     btc.zeroFills + eth.zeroFills,
      rejections:                    btc.rejections + eth.rejections,
      ambiguousResponses:            btc.ambiguousResponses + eth.ambiguousResponses,
      fillRateByOrderAttempt:        allSubs > 0 ? allFilled / allSubs : null,
      fillRateByQualifyingWindow:    allZone > 0 ? allFilledW / allZone : null,
      avgAttemptsPerFilledTicker:    avgA(btc.avgAttemptsPerFilledTicker, eth.avgAttemptsPerFilledTicker),
      medianAttemptsPerFilledTicker: avgA(btc.medianAttemptsPerFilledTicker, eth.medianAttemptsPerFilledTicker),
      maxAttemptsOnOneTicker:        Math.max(btc.maxAttemptsOnOneTicker, eth.maxAttemptsOnOneTicker),
      avgRequestedContracts:         avgA(btc.avgRequestedContracts, eth.avgRequestedContracts),
      avgFilledContracts:            avgA(btc.avgFilledContracts, eth.avgFilledContracts),
      submittedNotionalDollars:      btc.submittedNotionalDollars + eth.submittedNotionalDollars,
      reservedNotionalDollars:       btc.reservedNotionalDollars + eth.reservedNotionalDollars,
      filledNotionalDollars:         btc.filledNotionalDollars + eth.filledNotionalDollars,
      feesDollars:                   btc.feesDollars + eth.feesDollars,
      avgLimitPriceCents:            avgA(btc.avgLimitPriceCents, eth.avgLimitPriceCents),
      avgActualFillPriceCents:       avgA(btc.avgActualFillPriceCents, eth.avgActualFillPriceCents),
      avgPriceImprovementCents:      avgA(btc.avgPriceImprovementCents, eth.avgPriceImprovementCents),
      guardOutcomeCounts:            { ...combined },
      restTriggeredOrders:           btc.restTriggeredOrders + eth.restTriggeredOrders,
      websocketTriggeredOrders:      btc.websocketTriggeredOrders + eth.websocketTriggeredOrders,
      netPnlDollars:                 btc.netPnlDollars + eth.netPnlDollars,
      winsCount:                     btc.winsCount + eth.winsCount,
      lossesCount:                   btc.lossesCount + eth.lossesCount,
      winRate: (() => {
        const total = btc.winsCount + eth.winsCount + btc.lossesCount + eth.lossesCount;
        if (total === 0) return null;
        return (btc.winsCount + eth.winsCount) / total;
      })(),
    };

    return { date: _dailyDate, btc, eth, combined: combinedSummary };
  } catch (err) {
    console.warn("analytics: getDailySummary failed", { err, analytics_error: true });
    const empty = buildSeries("KXBTC15M");
    return {
      date:     easternDay(new Date()),
      btc:      { ...empty, series: "KXBTC15M" },
      eth:      { ...empty, series: "KXETH15M" },
      combined: { ...empty, series: "combined" },
    };
  }
}

// ── Guard-count accessors (for SQL persistence) ───────────────────────────────

/**
 * Return a deep snapshot of the current guard-count map.
 * Keys are series strings ("KXBTC15M", "KXETH15M", "combined").
 * Called by analyticsStore.ts for the debounced SQL flush.
 */
export function getGuardCounts(): Map<string, GuardOutcomeCounts> {
  const snapshot = new Map<string, GuardOutcomeCounts>();
  for (const [series, counts] of _guardCounts) {
    snapshot.set(series, { ...counts });
  }
  return snapshot;
}

/**
 * Overwrite in-memory guard counts from a previously persisted map.
 * Called by analyticsStore.ts during startup hydration when SQL has data
 * but the NDJSON file is absent (e.g. after a mid-day redeploy).
 * Only restores series that actually have rows; existing in-memory series
 * are left untouched so order-hydration counts (submitted/zero_fill/…) that
 * were already bumped by hydrateOrderAttempt() are not clobbered.
 */
export function hydrateGuardCounts(countsMap: Map<string, Partial<GuardOutcomeCounts>>): void {
  try {
    for (const [series, incoming] of countsMap) {
      const existing = countsFor(series);
      for (const key of Object.keys(incoming) as GuardOutcomeName[]) {
        const v = incoming[key];
        if (typeof v === "number" && v > existing[key]) {
          existing[key] = v;
        }
      }
    }
  } catch (err) {
    console.warn("analytics: hydrateGuardCounts failed", { err, analytics_error: true });
  }
}

// ── Hydration (startup restore from disk) ─────────────────────────────────────

/**
 * Restore a previously persisted order attempt into in-memory state.
 * Called by analyticsStore.ts on startup for each NDJSON line.
 * For duplicate IDs, the later entry (more up-to-date) wins.
 */
export function hydrateOrderAttempt(record: OrderAttemptRecord): void {
  try {
    // If already present, allow overwrite for more up-to-date state (e.g. reconciled)
    const existing = _ordersById.get(record.id);
    if (existing) {
      // Only overwrite if the incoming record is more complete
      if (record.reconciled && !existing.reconciled) {
        Object.assign(existing, record);
      }
      return;
    }

    _orders.push(record);
    if (_orders.length > MAX_ORDERS) _orders.shift();
    _ordersById.set(record.id, record);

    // Restore attempt counter
    const key = `${record.ticker}-${record.side}`;
    const cur = _attemptCounter.get(key) ?? 0;
    if (record.attemptNumber > cur) _attemptCounter.set(key, record.attemptNumber);

    // Restore guard counts
    bumpCount(record.series, "submitted");
    if (record.outcome === "full_fill")         bumpCount(record.series, "full_fill");
    else if (record.outcome === "partial_fill") bumpCount(record.series, "partial_fill");
    else if (record.outcome === "zero_fill")    bumpCount(record.series, "zero_fill");

    // Restore retry sequence
    if (!_retrySeqs.has(key)) {
      _retrySeqs.set(key, {
        ticker: record.ticker, side: record.side,
        totalSubmissions: 0, zeroFillsBeforeFirstFill: 0,
        attemptNumberThatFilled: null, everFilled: false,
        firstSignalMs: record.timestampMs, firstFillMs: null, timeToFirstFillMs: null,
        attemptTimestampsMs: [], timeBetweenAttemptsMs: [],
        finalContracts: 0, finalActualSpendDollars: 0, finalFeesDollars: 0,
      });
    }
    const seq = _retrySeqs.get(key)!;
    seq.totalSubmissions++;
    seq.attemptTimestampsMs.push(record.timestampMs);
    if (record.outcome === "zero_fill" && !seq.everFilled) seq.zeroFillsBeforeFirstFill++;
    if ((record.outcome === "full_fill" || record.outcome === "partial_fill") && !seq.everFilled) {
      seq.everFilled              = true;
      seq.attemptNumberThatFilled = record.attemptNumber;
      seq.finalContracts         += record.contracts.value;
      seq.finalActualSpendDollars += record.notionalDollars.value;
      seq.finalFeesDollars       += record.feeDollars.value;
    }

    // Restore window analytics
    if (!_windows.has(record.ticker)) {
      _windows.set(record.ticker, {
        ticker: record.ticker, series: record.series,
        windowStartMs: record.timestampMs, windowClose: record.windowCloseTime,
        yesEnteredZone: false, noEnteredZone: false,
        firstInZoneMs: null, lastInZoneMs: null,
        qualifyingEvaluations: 0, submittedOrders: 0,
        zeroFills: 0, partialFills: 0, fullFills: 0,
        attemptNumberThatFilled: null, attempts: [],
        actualFilledContracts: 0, actualFillPriceCents: null,
        totalSpendDollars: 0, totalFeesDollars: 0, result: "pending",
      });
    }
    const win = _windows.get(record.ticker)!;
    win.submittedOrders++;
    win.attempts.push({
      attemptNumber:      record.attemptNumber,
      side:               record.side,
      triggerPriceCents:  record.triggerPriceCents,
      limitPriceCents:    record.limitPriceCents,
      requestedContracts: record.requestedContracts,
    });
    if (record.outcome === "zero_fill") {
      win.zeroFills++;
      if (win.result === "pending") win.result = "zero_fill_only";
    } else if (record.outcome === "partial_fill") {
      win.partialFills++;
      win.actualFilledContracts += record.contracts.value;
      win.totalSpendDollars     += record.notionalDollars.value;
      win.totalFeesDollars      += record.feeDollars.value;
      if (win.result !== "filled") win.result = "partial_fill";
    } else if (record.outcome === "full_fill") {
      win.fullFills++;
      win.result = "filled";
      win.actualFilledContracts += record.contracts.value;
      win.totalSpendDollars     += record.notionalDollars.value;
      win.totalFeesDollars      += record.feeDollars.value;
      if (win.attemptNumberThatFilled === null) win.attemptNumberThatFilled = record.attemptNumber;
    }
  } catch (err) {
    console.warn("analytics: hydrateOrderAttempt failed", { err, recordId: record.id, analytics_error: true });
  }
}
