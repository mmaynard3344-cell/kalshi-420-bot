/**
 * Server-side auto-trader for BTC and ETH 15-minute Kalshi markets.
 *
 * Architecture:
 *  - WebSocket (kalshiStream) is the PRIMARY trigger. Every incoming tick for
 *    a tracked market is merged into a local state cache and evaluated immediately.
 *  - REST is the FALLBACK + RECONCILIATION path:
 *      • Runs automatically when the WS has been silent for >30 s or is disconnected.
 *      • Also runs on a fixed 45-second reconciliation interval regardless of WS health.
 *  - Both paths funnel into a single shared `evaluate()` function, which logs
 *    the trigger source ("websocket" | "rest_fallback") on every in-window evaluation.
 *  - An ORDER_COOLDOWN_MS guard prevents rapid ticks from stacking duplicate orders
 *    for the same ticker+side.
 *  - WS deltas are merged into a full MarketState cache; fields absent from a delta
 *    are preserved from the last known value.
 *  - REST responses that arrive after a fresher WS update do not overwrite bid/ask
 *    fields (they still update close_time and fill any nulls).
 *  - All existing risk limits are preserved: dedup slot, daily notional cap,
 *    position guard, per-window spend tracker.
 *
 * Safety model (layered guards, outermost to innermost):
 *  1. HARD PRICE GUARD   — outcome-side price must be 70–95 ¢ (checked first,
 *                          before any state is claimed, so a mis-priced call
 *                          leaves no footprint in the cooldown/dedup/budget maps)
 *  2. Cooldown           — 3 s per ticker+side to absorb rapid WS ticks
 *  3. Window budget      — $betDollars total (spent + in-flight) per ticker per window
 *  4. Kill switch        — AUTO_TRADING_ENABLED=false or POST /trade/halt
 *  5. Dedup slot         — 20 min window, persisted to disk
 *  6. Daily notional cap — configurable via MAX_DAILY_NOTIONAL_CENTS
 *  7. Position guard     — blocks orders that would close an existing position
 *  8. In-flight lock     — only one Kalshi API call in-flight per ticker at a time
 */

import { randomUUID, createHash } from "crypto";
import { kalshiFetch, kalshiSeriesFetch, normalizeMarket } from "./kalshi";
import type { KalshiSeriesFetchOptions } from "./kalshi";
import { kalshiAuthFetch, startKalshiAuthTransportPrewarm } from "./kalshiAuth";
import { kalshiStream, TICKER_REFRESH_MS, type KalshiMarketLifecycleEvent } from "./kalshiStream";
import { logger } from "./logger";
import { envWorkspaceHaltActive } from "./tradingKillSwitch";
import {
  captureOrderbook,
  parseOrderbookResponse,
  computeSnapshotFields,
  type OrderbookSnapshot,
} from "./orderbookCapture";
import { parseKalshiOrderResponse } from "./orderResponseParser";
import { recordWindowTick }       from "./windowTickStore";
import { recordPreflightDecision } from "./preflightStore.js";
import { recordEvaluationEvent }   from "./evaluationEventStore.js";
import {
  ALERT_MIN, ALERT_MAX,
  MAX_BBO_L2_NEGATIVE_GAP_CENTS,
  LIMIT_PRICE_BUFFER_CENTS,
  MAX_DIRECT_DERIVED_BBO_GAP_CENTS,
  MAX_SPREAD_CENTS,
  computePreflightDecision,
  isCoherentBboQuote,
} from "./preflightGate.js";
import {
  claimOrderSlot,
  releaseOrderSlot,
  reserveNotional,
  releaseNotional,
  getSignedPosition,
  isTradingHalted,
} from "../routes/trade";
import {
  recordGuardOutcome,
  recordOrderAttempt,
  recordQualifyingEvaluation,
  recordZeroFill,
  recordFill,
  rollWindowAnalytics,
} from "./analytics";
import { reconcileOrder } from "./fillReconciler";
import * as tradeStore from "./tradeStore.js";
import { easternDay } from "./dailyBudget.js";
import { allowNewInvestment } from "./dailyProfitStop.js";
import {
  evaluateEthNoMartingale,
  reconcileEthMartingaleSettlements,
  hasUnsettledEthMartingaleExposure,
  getEthMartingalePriorOrderSideHints,
  isEthTicker,
} from "./strategies/ethOnlyMartingale.js";
import {
  armEthBoundarySettlementOrchestration,
  triggerEthBoundarySettlementOrchestration,
  _configureEthBoundarySettlementOrchestratorForTesting,
  _resetEthBoundarySettlementOrchestratorForTesting,
} from "./ethBoundarySettlementOrchestrator.js";
import {
  armEth420BoundarySettlementOrchestration,
  triggerEth420BoundarySettlementOrchestration,
  _configureEth420BoundarySettlementOrchestratorForTesting,
  _resetEth420BoundarySettlementOrchestratorForTesting,
} from "./eth420BoundarySettlementOrchestrator.js";
import {
  getEth420CandidatePriorOrderHints,
  reconcileEth420CandidateLiveSettlements,
} from "./strategies/eth420SixStepCandidate.js";
import { scheduleOutcomeReconciliation } from "./outcomeReconciler";
import {
  TIME_ALERT_SECONDS,
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  BTC_BET_DOLLARS,
  ETH_BET_DOLLARS,
  SERIES_ENTRY_POLICY,
  isEntryPriceInBandForSeries,
  entryPriceBandForSeries,
  type TrackedSeries,
  isPriceInBand,
  contractsForPrice,
  spendTracker,
  pendingNotionalByTicker,
  preflightInFlight,
  submissionInFlight,
  submissionOrderIds,
  orderCooldown,
  zeroFillSuppressionCache,
  runWithPreflightLock,
  ZERO_FILL_SUPPRESS_TTL_MS,
  ZERO_FILL_RETRY_DELAY_MS,
  MAX_ZERO_FILL_RETRIES,
  zeroFillRetryCount,
  scheduleZeroFillRetryPoll,
  cancelZeroFillRetryPolls,
  ZERO_FILL_RETRY_POLL_MARGIN_MS,
} from "./autoTraderGuards";
import {
  enqueuePhase4BPassiveCapture,
  isPhase4BPassiveCaptureEnabled,
} from "./phase4b/passiveCapture.js";
import type {
  Phase4BCaptureInput,
  Phase4BFinalDecisionClassification,
  Phase4BGuardOutcomes,
  Phase4BThresholdRuleSnapshot,
} from "./phase4b/types.js";
import {
  appendMandelbrotObservation,
  captureMandelbrotFromLiveObservation,
} from "./mandelbrotInstability.js";
import { noteConfirmedLocalEntry } from "./protectiveExit.js";
import { isRuntimeEntryHealthy } from "./runtimeHeartbeat.js";
import {
  recordCoverageObservation,
  recordCoverageEvaluation,
  runCoverageCheck,
  setCoverageWsConnectedProbe,
  setCoverageRecoveryHandler,
} from "./marketDataCoverage.js";
import { recordBoundaryDiscoveryAudit } from "./boundaryDiscoveryAudit.js";
import {
  isNewEntryPermitted,
  isWeek2ProductionNewEntryTicker,
  seriesTokenFromTicker,
  WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
  WEEK_2_PRODUCTION_NEW_ENTRY_SERIES,
  WEEK_2_RESEARCH_AND_TELEMETRY_SERIES,
  ACTIVE_ENTRY_SERIES_POLICY,
} from "./week2EntryPolicy.js";

// Re-export testable pure functions and state helpers so callers only need
// to import from autoTrader.ts (or autoTraderGuards.ts directly in tests).
export {
  TIME_ALERT_SECONDS,
  PRICE_FLOOR_CENTS,
  PRICE_CAP_CENTS,
  isPriceInBand,
  _resetAutoTraderStateForTesting,
  _isPreflightInFlightForTesting,
  _forcePreflightInFlightForTesting,
  _clearPreflightInFlightForTesting,
  _isSubmissionInFlightForTesting,
  _forceSubmissionInFlightForTesting,
  _getPendingNotionalForTesting,
  _setPendingNotionalForTesting,
  _getSpendTrackerForTesting,
  _setSpendTrackerForTesting,
  _computeRemainingBudgetForTesting,
  _getZeroFillSuppressionForTesting,
  _setZeroFillSuppressionForTesting,
  _getZeroFillRetryCountForTesting,
  _setZeroFillRetryCountForTesting,
} from "./autoTraderGuards";

// ── Integration test injection points ─────────────────────────────────────────
// All overrides are null by default — production code uses real implementations.
// Tests must call _clearAutoTraderTestOverrides() in afterEach to reset.

let _captureOrderbookImpl:  typeof captureOrderbook | null = null;
/** Separate final-gate override so existing preflight test doubles stay isolated. */
let _finalCaptureOrderbookImpl: typeof captureOrderbook | null = null;
let _reserveAndRecordImpl:  typeof tradeStore.reserveAndRecord | null = null;
let _isTradingHaltedImpl:   (() => boolean) | null = null;
let _claimOrderSlotImpl:    ((ticker: string, side: "yes" | "no") => boolean) | null = null;
let _getSignedPositionImpl: ((ticker: string) => Promise<number>) | null = null;
type StaleGapCaptureOverride = (input: import("./staleGapPassiveCapture.js").StaleGapPassiveCaptureInput) => void;
let _staleGapCaptureImpl: StaleGapCaptureOverride | null = null;

/** Captures structured log calls from placeOrder for terminal-outcome tests. */
type PlaceOrderLogSink = (msg: string, fields: Record<string, unknown>) => void;
let _placeOrderLogSink: PlaceOrderLogSink | null = null;

// Additional injection points for deeper path testing (fee flow, post-SQL path)

/** Override for kalshiAuthFetch — inject fake Kalshi order POST responses. */
type KalshiAuthFetchOverride = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<Record<string, unknown>>;
let _kalshiAuthFetchImpl: KalshiAuthFetchOverride | null = null;

/** Override for isWorkspaceEnvironment() — allows tests to bypass the workspace guard. */
let _isWorkspaceEnvironmentImpl: (() => boolean) | null = null;
/** Test-only seam: production always uses the fixed Week 2 exact-series policy. */
let _isWeek2ProductionNewEntryTickerImpl: ((ticker: string) => boolean) | null = null;

/** Override for tradeStore.markAttemptPostStarted — no-op in tests that bypass the real DB. */
let _markAttemptPostStartedImpl: ((clientOrderId: string) => Promise<void>) | null = null;

/**
 * Spy called (before the real recordFill) whenever placeOrder records a fill.
 * Tests use this to assert that feeDollars from parseFillActuals reaches analytics
 * with the correct dollar-decimal value.
 */
type RecordFillSpy = (attemptId: string, params: {
  orderId:         string | null;
  fillCount:       number;
  requestedCount:  number;
  contractsFilled: number;
  fillPriceCents:  number;
  notionalDollars: number;
  feeDollars:      number;
  pricesKnown:     boolean;
  roundTripMs:     number;
}) => void;
let _recordFillSpy: RecordFillSpy | null = null;

/**
 * Spy called synchronously immediately before reconcileOrder is dispatched as a
 * fire-and-forget background task.  Receives the same six arguments that are
 * passed to reconcileOrder so tests can assert both the compound analytics ID
 * (1st arg) and the SQL primary key (6th arg = sqlAttemptId) without waiting
 * for the async reconciliation to complete.
 */
type ReconcileOrderSpy = (
  attemptId:     string,
  orderId:       string,
  side:          "yes" | "no",
  limitCents:    number,
  ticker:        string,
  sqlAttemptId:  string,
) => void;
let _reconcileOrderSpy: ReconcileOrderSpy | null = null;

/**
 * Override for the restFetchAll call inside the zero-fill retry poll callback.
 * When set, replaces the real restFetchAll so tests can drive a controlled
 * evaluation without making live Kalshi REST calls.
 */
type RestFetchAllOverride = (source: TriggerSource) => Promise<void>;
let _restFetchAllImpl: RestFetchAllOverride | null = null;

/**
 * Override for kalshiStream.isConnected() used inside isWsStale().
 * When set, the override is invoked instead of the real kalshiStream.isConnected()
 * so tests can control WS-connected state without a live WebSocket connection.
 */
let _kalshiStreamIsConnectedImpl: (() => boolean) | null = null;
type ZeroFillRetrySchedulerOverride = (
  ticker: string,
  side: "yes" | "no",
  pollFn: () => void,
) => void;
let _zeroFillRetrySchedulerImpl: ZeroFillRetrySchedulerOverride | null = null;

/** Injectable seam for verifying exact ETH routing without invoking entry I/O. */
let _evaluateEthNoMartingaleImpl: typeof evaluateEthNoMartingale | null = null;

/** A single short retry bridges a transient ETH reconciliation delay at rollover. */
export const ETH_SETTLEMENT_RETRY_DELAY_MS = 5_000;
let ethSettlementRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Injectable override for the kalshiSeriesFetch(series) call inside
 * restFetchSeries() (BTC/ETH path). When set, the override is invoked instead
 * of the real Kalshi REST call so tests can spy on which series are fetched
 * without live network calls.
 */
type KalshiSeriesFetchOverride = (
  series: string,
  options?: KalshiSeriesFetchOptions,
) => Promise<Record<string, unknown> | null>;
let _kalshiSeriesFetchImpl: KalshiSeriesFetchOverride | null = null;
let boundaryDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;
let boundaryDiscoveryTarget: { ticker: string; openTimeMs: number } | null = null;
const lifecycleActivationInFlight = new Set<string>();
const BOUNDARY_PROBE_DELAY_MS = 350;
const BOUNDARY_PROBE_RETRY_DELAY_MS = 2_000;
const MAX_BOUNDARY_PROBE_RETRIES = 2;

/**
 * Injectable spy fired whenever the legacy BTC/ETH evaluate() is invoked from
 * onWsTick(). Tests use this to assert that a SOL tick never reaches the
 * legacy evaluator.
 */
type LegacyEvaluateSpy = (ticker: string) => void;
let _legacyEvaluateSpy: LegacyEvaluateSpy | null = null;
/**
 * Test-only harness for the retained legacy guard matrix. Production never
 * changes this value, so historical evaluator code remains unreachable from
 * WS/REST execution while its pure guard tests can still run in isolation.
 */

export function _setRestFetchAllForTesting(fn: RestFetchAllOverride | null): void {
  _restFetchAllImpl = fn;
}

export function _setKalshiStreamIsConnectedForTesting(fn: (() => boolean) | null): void {
  _kalshiStreamIsConnectedImpl = fn;
}
export function _setKalshiSeriesFetchForTesting(fn: KalshiSeriesFetchOverride | null): void {
  _kalshiSeriesFetchImpl = fn;
}
export function _setZeroFillRetrySchedulerForTesting(fn: ZeroFillRetrySchedulerOverride | null): void {
  _zeroFillRetrySchedulerImpl = fn;
}
export function _setLegacyEvaluateSpyForTesting(fn: LegacyEvaluateSpy | null): void {
  _legacyEvaluateSpy = fn;
}
export function _setEvaluateEthNoMartingaleForTesting(
  fn: typeof evaluateEthNoMartingale | null,
): void {
  _evaluateEthNoMartingaleImpl = fn;
}

export function _setCaptureOrderbookForTesting(fn: typeof captureOrderbook): void {
  _captureOrderbookImpl = fn;
}
export function _setFinalCaptureOrderbookForTesting(fn: typeof captureOrderbook): void {
  _finalCaptureOrderbookImpl = fn;
}
export function _setReserveAndRecordForTesting(fn: typeof tradeStore.reserveAndRecord): void {
  _reserveAndRecordImpl = fn;
}
export function _setIsTradingHaltedForTesting(fn: () => boolean): void {
  _isTradingHaltedImpl = fn;
}
export function _setClaimOrderSlotForTesting(fn: (ticker: string, side: "yes" | "no") => boolean): void {
  _claimOrderSlotImpl = fn;
}
export function _setSignedPositionForTesting(fn: ((ticker: string) => Promise<number>) | null): void {
  _getSignedPositionImpl = fn;
}
export function _setStaleGapCaptureForTesting(fn: StaleGapCaptureOverride | null): void {
  _staleGapCaptureImpl = fn;
}
export function _setPlaceOrderLogSinkForTesting(fn: PlaceOrderLogSink): void {
  _placeOrderLogSink = fn;
}
export function _setKalshiAuthFetchForTesting(fn: KalshiAuthFetchOverride): void {
  _kalshiAuthFetchImpl = fn;
}
export function _setIsWorkspaceEnvironmentForTesting(fn: () => boolean): void {
  _isWorkspaceEnvironmentImpl = fn;
}
export function _setWeek2ProductionNewEntryPolicyForTesting(
  fn: ((ticker: string) => boolean) | null,
): void {
  _isWeek2ProductionNewEntryTickerImpl = fn;
}
export function _setMarkAttemptPostStartedForTesting(fn: (id: string) => Promise<void>): void {
  _markAttemptPostStartedImpl = fn;
}
export function _setRecordFillSpyForTesting(fn: RecordFillSpy): void {
  _recordFillSpy = fn;
}
export function _setReconcileOrderSpyForTesting(fn: ReconcileOrderSpy | null): void {
  _reconcileOrderSpy = fn;
}
/**
 * Pre-populate the module-level marketState cache for a ticker.
 * Required by tests that bypass the workspace guard and reach the timing guard
 * inside placeOrder(), which reads marketState.get(ticker) — a field that is
 * only set by mergeState() in the production WS/REST paths.
 */
export function _setMarketStateForTesting(state: MarketState): void {
  marketState.set(state.ticker, state);
}
export function _clearAutoTraderTestOverrides(): void {
  _captureOrderbookImpl          = null;
  _finalCaptureOrderbookImpl     = null;
  _reserveAndRecordImpl          = null;
  _isTradingHaltedImpl           = null;
  _claimOrderSlotImpl            = null;
  _getSignedPositionImpl         = null;
  _staleGapCaptureImpl           = null;
  _placeOrderLogSink             = null;
  _kalshiAuthFetchImpl           = null;
  _isWorkspaceEnvironmentImpl    = null;
  _isWeek2ProductionNewEntryTickerImpl = null;
  _markAttemptPostStartedImpl    = null;
  _recordFillSpy                 = null;
  _reconcileOrderSpy             = null;
  _restFetchAllImpl              = null;
  _zeroFillRetrySchedulerImpl    = null;
  _evaluateEthNoMartingaleImpl   = null;
  _legacyEvaluateSpy             = null;
  _kalshiSeriesFetchImpl         = null;
  _kalshiStreamIsConnectedImpl   = null;
  if (ethSettlementRetryTimer != null) {
    clearTimeout(ethSettlementRetryTimer);
    ethSettlementRetryTimer = null;
  }
  if (boundaryDiscoveryTimer != null) {
    clearTimeout(boundaryDiscoveryTimer);
    boundaryDiscoveryTimer = null;
  }
  boundaryDiscoveryTarget = null;
  lifecycleActivationInFlight.clear();
  _resetEthBoundarySettlementOrchestratorForTesting();
  _resetEth420BoundarySettlementOrchestratorForTesting();
}

export type { MarketState };

/**
 * Expose evaluate() for integration testing only.
 * Tests can inject mock deps via _set*ForTesting() before calling this.
 */
export async function _evaluateForTesting(
  state:      MarketState,
  betDollars: number,
  source:     TriggerSource,
): Promise<void> {
  return evaluate(state, betDollars, source);
}

/**
 * Expose onWsTick() for regression testing of WS tick routing.
 * Tests inject _setEvaluateEthNoMartingaleForTesting / _setLegacyEvaluateSpyForTesting
 * to observe which evaluators receive each tick without live network calls.
 */
export function _onWsTickForTesting(raw: Record<string, unknown>): void {
  return onWsTick(raw);
}

/**
 * Expose restFetchAll() for integration testing of the Promise.all composition
 * and the ETH-only fetch boundary. Tests inject _setKalshiSeriesFetchForTesting
 * to drive controlled fetches without live Kalshi REST calls.
 */
export async function _restFetchAllForTesting(
  source: "websocket" | "rest_fallback" | "startup_prime",
): Promise<void> {
  return restFetchAll(source);
}

/** Test seam for boundary scheduling without starting the live stream. */
export function _scheduleEthBoundaryDiscoveryForTesting(raw: Record<string, unknown>): void {
  scheduleEthBoundaryDiscovery(raw);
}

/** Test seam for lifecycle events without opening a socket. */
export function _onEthMarketLifecycleForTesting(event: KalshiMarketLifecycleEvent): void {
  onEthMarketLifecycle(event);
}

/**
 * Exported for timer-wiring tests only.
 * Lets tests assert the 45-second reconcile cadence without starting the full
 * AutoTrader (which requires live DB + kalshiStream).
 *
 * Creates a setInterval(RECONCILE_INTERVAL_MS) whose callback uses
 * `getLastRefreshAtMs()` in place of `kalshiStream.lastRefreshAtMs`, so tests
 * can inject any refresh timestamp they need.  The interval calls
 * `_restFetchAllImpl ?? restFetchAll` — the same path the production timer uses
 * — so injecting _restFetchAllImpl via _setRestFetchAllForTesting() is
 * sufficient to spy on invocations.
 *
 * Callers are responsible for calling clearInterval() on the returned handle
 * (typically in afterEach) and for resetting mock.timers if used.
 */
export function _startReconcileTimerForTesting(
  getLastRefreshAtMs: () => number,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    _runReconcileTickCallback(Date.now(), getLastRefreshAtMs());
  }, RECONCILE_INTERVAL_MS);
}
const ORDER_COOLDOWN_MS     = 3_000;  // min ms between order attempts per key
const STALE_WS_MS           = 30_000; // WS considered stale if no tick for this long
const RECONCILE_INTERVAL_MS = 45_000; // periodic REST reconciliation interval
// Guard window around each KalshiStream ticker refresh.  Any reconcile tick
// that falls within this many ms BEFORE or AFTER a stream refresh is skipped
// (not deferred) so the two never fire concurrent Kalshi REST calls.
// 12 s satisfies the ">10 s apart" requirement with a 2 s safety margin.
const STREAM_GUARD_MS       = 12_000;
const FALLBACK_POLL_MS      = 5_000;  // how often to check whether fallback is needed
// Begin aggressive REST polling this many seconds before close so we have full
// market-status visibility starting 5 minutes out. Evaluation (order placement)
// still only fires inside TIME_ALERT_SECONDS (last 2 min).
const EVALUATION_BUFFER_SECS     = 300;  // start polling fast 5 min before close
// Pre-window market-status log throttle: emit once per minute during the 5→2 min buffer.
const PRE_WINDOW_LOG_INTERVAL_MS = 60_000;

/**
 * Captures an opt-in research observation from state already available to
 * evaluate(). It deliberately runs before all trading timing/guard returns:
 * the 30–120 second research window is independent from entry timing.
 *
 * This helper makes no network request and never touches trade state.
 */
function captureMandelbrotPassiveObservation(
  state: MarketState,
  secondsLeft: number,
): void {
  if (process.env["LEGACY_RAW_RESEARCH_CAPTURE_ENABLED"] !== "true"
    || process.env["MANDELBROT_INSTABILITY_CAPTURE_ENABLED"] !== "true") return;

  const yesDerivedAsk = state.noBid != null ? 100 - state.noBid : null;
  const noDerivedAsk = state.yesBid != null ? 100 - state.yesBid : null;
  const executablePriceCents = yesDerivedAsk ?? noDerivedAsk;
  if (executablePriceCents === null) return;

  const timestampMs = Date.now();
  const lastWs = lastWsTickMs.get(state.ticker) ?? 0;
  const isYesSide = yesDerivedAsk !== null;
  // Derive a BBO spread from available bid/ask fields. This is less precise than
  // an L2 snapshot but available without any additional network calls.
  // For YES side: spread = yesAsk - yesBid; for NO side: spread = noAsk - noBid.
  // Either field being null means we cannot compute spread — mark as unavailable.
  let bboDerivedSpread: number | null = null;
  let spreadQuality: "bbo_derived" | "unavailable" = "unavailable";
  if (isYesSide && state.yesAsk !== null && state.yesBid !== null) {
    bboDerivedSpread = state.yesAsk - state.yesBid;
    spreadQuality = "bbo_derived";
  } else if (!isYesSide && state.noAsk !== null && state.noBid !== null) {
    bboDerivedSpread = state.noAsk - state.noBid;
    spreadQuality = "bbo_derived";
  }
  void captureMandelbrotFromLiveObservation({
    enabled: true,
    ticker: state.ticker,
    timestampMs,
    secondsLeft,
    side: isYesSide ? "yes" : "no",
    executablePriceCents,
    spreadCents: bboDerivedSpread,
    spreadQuality,
    // Executable depth requires an L2 fetch; we do not make passive network calls
    // here. Mark explicitly as unavailable rather than zero.
    executableDepthContracts: null,
    depthQuality: "unavailable" as const,
    quoteAgeMs: timestampMs - state.bidUpdatedMs,
    wsStale: timestampMs - lastWs >= STALE_WS_MS,
  }, appendMandelbrotObservation).catch(() => { /* passive research never affects trading */ });
}

// ── Per-series configuration ──────────────────────────────────────────────────

// OWNER-LOCKED: per-series cash caps come from autoTraderGuards.ts (see the
// owner-lock banner there). Never replace them with numeric literals here.
export const SERIES_CONFIG = {
  KXBTC15M: { betDollars: BTC_BET_DOLLARS },
  KXETH15M: { betDollars: ETH_BET_DOLLARS },
} as const;

type SeriesKey = TrackedSeries;
/**
 * The live data and entry plane is ETH-only. Historical positions are handled
 * by the separate restored-position cleanup monitor, not by current-market
 * fetching.
 */
const ACTIVE_ENTRY_SERIES: SeriesKey[] = ["KXETH15M"];
/**
 * Runtime timers, stale-stream checks, snapshots, and status reporting must
 * use the same single-series boundary as entry routing. SERIES_CONFIG keeps
 * retired values only for read-only compatibility; it is not a live-work list.
 */
const TRACKED_SERIES: readonly SeriesKey[] = ACTIVE_ENTRY_SERIES;

/** Test-only visibility of the runtime work boundary. */
export function _getLiveTrackedSeriesForTesting(): readonly SeriesKey[] {
  return [...TRACKED_SERIES];
}

function seriesForTicker(ticker: string): SeriesKey | undefined {
  return ACTIVE_ENTRY_SERIES.find((s) => ticker.startsWith(s));
}

// ── Market state cache ────────────────────────────────────────────────────────

interface MarketState {
  ticker:         string;
  /** Exchange selected by Kalshi's market discovery response. */
  exchangeIndex?: number | null;
  closeTime:      string | null;
  openTime:       string | null;
  expirationTime: string | null;
  status:         string | null;
  lastPrice:      number | null;
  yesBid:         number | null;
  yesAsk:         number | null;
  noBid:          number | null;
  noAsk:          number | null;
  /** Kalshi market-rule fields observed from the REST snapshot and retained passively. */
  floorStrike?:   number | null;
  rulesPrimary?:  string | null;
  rulesSecondary?: string | null;
  rulesObservedAtMs?: number | null;
  /** Wall-clock ms when bid/ask fields were last updated (WS or REST). */
  bidUpdatedMs:   number;
}

function thresholdRuleFromState(state: MarketState, observedAtMs: number): Phase4BThresholdRuleSnapshot {
  const primary = state.rulesPrimary ?? null;
  const secondary = state.rulesSecondary ?? null;
  const rules = `${primary ?? ""}\n${secondary ?? ""}`;
  const operator = /\bat or above\b|\bgreater than or equal\b|>=/i.test(rules) ? ">="
    : /\bat or below\b|\bless than or equal\b|<=/i.test(rules) ? "<="
    : /\babove\b|\bgreater than\b/i.test(rules) ? ">"
    : /\bbelow\b|\bless than\b/i.test(rules) ? "<" : null;
  const hasMetadata = state.floorStrike != null && operator !== null && Boolean(primary || secondary);
  return {
    captureVersion: "distance-to-beat-prospective-v1",
    source: hasMetadata ? "kalshi_market_api_snapshot" : "unavailable",
    observedAtMs: state.rulesObservedAtMs ?? observedAtMs,
    floorStrike: state.floorStrike ?? null,
    comparisonOperator: operator,
    rulesPrimary: primary,
    rulesSecondary: secondary,
    rulesHash: primary || secondary ? createHash("sha256").update(rules).digest("hex") : null,
    unavailableReason: hasMetadata ? null : "authoritative_market_rule_missing_from_observed_kalshi_snapshot",
  };
}

/**
 * Final-three-minute passive baseline. It runs before the two-minute trading
 * timing return and only copies already-observed state into the Phase4B queue.
 */
function capturePhase4BProspectiveBaseline(
  state: MarketState,
  secondsLeft: number,
  source: TriggerSource,
  betDollars: number,
): void {
  if (!isPhase4BPassiveCaptureEnabled() || secondsLeft > 180 || secondsLeft < 1 || !state.closeTime) return;
  const now = Date.now();
  const yesDerivedAsk = state.noBid == null ? null : 100 - state.noBid;
  const noDerivedAsk = state.yesBid == null ? null : 100 - state.yesBid;
  const side = yesDerivedAsk != null ? "yes" : "no";
  const selectedSideReason = yesDerivedAsk != null
    ? "yes_derived_ask_available_preferred_for_passive_baseline"
    : noDerivedAsk != null
      ? "no_derived_ask_available_when_yes_unavailable"
      : "no_executable_derived_ask_available";
  const lastWs = lastWsTickMs.get(state.ticker) ?? 0;
  enqueuePhase4BPassiveCapture({
    timestampMs: now, ticker: state.ticker, series: seriesForTicker(state.ticker) ?? "", closeTime: state.closeTime,
    openTime: state.openTime ?? null, secondsLeft, side, selectedSideReason, source,
    wsConnected: kalshiStream.isConnected(), wsStale: now - lastWs >= STALE_WS_MS,
    lastWsMessageAgeMs: now - lastWs, bboAgeMs: now - state.bidUpdatedMs,
    yesBid: state.yesBid, yesAsk: state.yesAsk, noBid: state.noBid, noAsk: state.noAsk,
    displayedEntryPriceCents: side === "yes" ? yesDerivedAsk : noDerivedAsk,
    configuredLimitCents: null, bboDerivedLimitCents: side === "yes" ? yesDerivedAsk : noDerivedAsk,
    strategyVersion: null, betDollars, priceFloorCents: PRICE_FLOOR_CENTS, priceCapCents: PRICE_CAP_CENTS,
    limitBufferCents: null, staleGapThresholdCents: null, decisionClassification: "observed_pre_decision",
    skipReason: null, quotedBboAskCents: null, executableL2AskCents: null, bboToL2GapCents: null,
    preflightLatencyMs: null, thresholdRule: thresholdRuleFromState(state, now),
  });
}

/** Live merged state, keyed by ticker. */
const marketState = new Map<string, MarketState>();

/** Timestamp of the most recent WS tick for each tracked ticker. */
const lastWsTickMs = new Map<string, number>();

/** Current open ticker per series (e.g. KXBTC15M → KXBTC15M-26JUL290315-15). */
const currentTickerBySeries = new Map<string, string>();

// (orderCooldown, spendTracker, pendingNotionalByTicker, submissionInFlight are imported from autoTraderGuards)

// ── Window log (state lives in windowLog.ts to avoid circular deps) ───────────
import { wlOpen, wlSetCloseTime, wlTick, wlSkip, wlTrade, wlMarkZeroFillRetried } from "./windowLog";
import {
  evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled,
  isEth420CandidateExecutionPermitted,
  observeEth420Candidate,
} from "./strategies/eth420SixStepCandidate.js";
import { runEthJumpServiceWhenExplicitlyEnabled } from "./strategies/ethJumpLiveRunner.js";
import { runEthReversalServiceWhenExplicitlyEnabled } from "./strategies/ethReversalLiveRunner.js";
export type { WindowLogEntry } from "./windowLog";
export { getWindowLog } from "./windowLog";

import {
  logPassiveObservation,
  PASSIVE_OBS_MAX_SECS,
} from "./passiveObserver.js";
import { observeEth420BoundaryResearch } from "./eth420BoundaryResearch.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function secondsUntil(closeTime: string): number | null {
  const close = new Date(closeTime).getTime();
  if (isNaN(close)) return null;
  return Math.max(0, Math.floor((close - Date.now()) / 1000));
}

/**
 * Arm the one-shot zero-fill retry poll for a ticker+side.
 *
 * Called at both zero-fill sites (pre-flight no-submit and confirmed IOC
 * zero-fill) so a REST evaluation tick is GUARANTEED within
 * ZERO_FILL_RETRY_DELAY_MS + ZERO_FILL_RETRY_POLL_MARGIN_MS (≤ 32 s) of the
 * zero-fill — even when the WS is quiet and the 45 s reconcile tick is
 * skipped by the stream-refresh guard. Without this, a zero-fill at T−40 s
 * could reach window close with no retry evaluation despite budget remaining.
 *
 * The callback is skipped if the window has already closed by the time the
 * timer fires.
 */
function armZeroFillRetryPoll(ticker: string, side: "yes" | "no"): void {
  (_zeroFillRetrySchedulerImpl ?? scheduleZeroFillRetryPoll)(ticker, side, () => {
    const st   = marketState.get(ticker);
    const secs = st?.closeTime ? secondsUntil(st.closeTime) : null;
    if (secs !== null && secs <= 0) return; // window already closed
    logger.info(
      {
        ticker,
        side,
        seconds_left:   secs,
        poll_delay_ms:  ZERO_FILL_RETRY_DELAY_MS + ZERO_FILL_RETRY_POLL_MARGIN_MS,
      },
      "AutoTrader: zero-fill retry poll firing — forcing REST evaluation tick",
    );
    (_restFetchAllImpl ?? restFetchAll)("rest_fallback").catch(() => { /* logged inside */ });
  });
}
/**
 * Merge a (possibly partial) market update into the state cache.
 * Only overwrites bid/ask fields if allowBidOverwrite is true.
 * close_time is always taken from the newest non-null value.  Authoritative
 * REST snapshots clear an unavailable exchange index; partial WebSocket deltas
 * retain the last known index because they normally omit routing metadata.
 */
function mergeState(
  raw: Record<string, unknown>,
  incomingMs: number,
  allowBidOverwrite: boolean,
  isAuthoritativeSnapshot: boolean,
): MarketState {
  const ticker         = raw["ticker"]          as string;
  const rawExchangeIndex = raw["exchange_index"];
  const exchangeIndex  = typeof rawExchangeIndex === "number"
    && Number.isInteger(rawExchangeIndex)
    && rawExchangeIndex >= 0
    ? rawExchangeIndex
    : null;
  const closeTime      = raw["close_time"]       as string | null ?? null;
  const openTime       = raw["open_time"]        as string | null ?? null;
  const expirationTime = raw["expiration_time"]  as string | null ?? null;
  const status         = raw["status"]           as string | null ?? null;
  const lastPrice      = raw["last_price"]       as number | null ?? null;
  const yesBid         = raw["yes_bid"]          as number | null ?? null;
  const yesAsk         = raw["yes_ask"]          as number | null ?? null;
  const noBid          = raw["no_bid"]           as number | null ?? null;
  const noAsk          = raw["no_ask"]           as number | null ?? null;
  const floorStrike    = raw["floor_strike"]     as number | null ?? null;
  const rulesPrimary   = raw["rules_primary"]    as string | null ?? null;
  const rulesSecondary = raw["rules_secondary"]  as string | null ?? null;

  // Coverage telemetry from the RAW payload (never the merged state below —
  // merged state retains prior bids on partial updates, which would let a
  // stale quote mask the very data gap the coverage watchdog detects).
  {
    const covSeries = seriesForTicker(ticker);
    if (covSeries) {
      recordCoverageObservation({
        ticker, series: covSeries, closeTime,
        rawYesBid: yesBid, rawNoBid: noBid, nowMs: incomingMs,
      });
    }
  }

  const prev = marketState.get(ticker);

  const next: MarketState = {
    ticker,
    exchangeIndex:   isAuthoritativeSnapshot ? exchangeIndex : (exchangeIndex ?? prev?.exchangeIndex ?? null),
    closeTime:      closeTime      ?? prev?.closeTime      ?? null,
    openTime:       openTime       ?? prev?.openTime       ?? null,
    expirationTime: expirationTime ?? prev?.expirationTime ?? null,
    status:         status         ?? prev?.status         ?? null,
    lastPrice:      lastPrice      ?? prev?.lastPrice      ?? null,
    yesBid: (allowBidOverwrite || prev?.yesBid == null) ? (yesBid ?? prev?.yesBid ?? null) : prev.yesBid,
    yesAsk: (allowBidOverwrite || prev?.yesAsk == null) ? (yesAsk ?? prev?.yesAsk ?? null) : prev.yesAsk,
    noBid:  (allowBidOverwrite || prev?.noBid  == null) ? (noBid  ?? prev?.noBid  ?? null) : prev.noBid,
    noAsk:  (allowBidOverwrite || prev?.noAsk  == null) ? (noAsk  ?? prev?.noAsk  ?? null) : prev.noAsk,
    floorStrike: floorStrike ?? prev?.floorStrike ?? null,
    rulesPrimary: rulesPrimary ?? prev?.rulesPrimary ?? null,
    rulesSecondary: rulesSecondary ?? prev?.rulesSecondary ?? null,
    rulesObservedAtMs: (floorStrike != null || rulesPrimary != null || rulesSecondary != null)
      ? incomingMs : (prev?.rulesObservedAtMs ?? null),
    bidUpdatedMs: allowBidOverwrite ? incomingMs : (prev?.bidUpdatedMs ?? incomingMs),
  };

  marketState.set(ticker, next);
  // Append-only research timer registration. It has no path back into
  // evaluation, submission, cancellation, sizing, or strategy state.
  observeEth420BoundaryResearch(next, () => marketState.get(ticker));
  return next;
}

/** Roll over per-window state when a new ticker is detected for a series. */
function handleWindowRollover(series: SeriesKey, newTicker: string): void {
  const prev = currentTickerBySeries.get(series);
  if (newTicker === prev) return;

  // Capture close time before marketState is cleared (used by outcome reconciler)
  const prevCloseTime = prev ? (marketState.get(prev)?.closeTime ?? null) : null;

  // Clear stale entries from the previous window for this series
  if (prev) {
    spendTracker.delete(prev);
    pendingNotionalByTicker.delete(prev);
    submissionInFlight.delete(prev);
  }
  for (const k of [...orderCooldown.keys()]) {   // cooldown key = ticker-SIDE
    if (k.startsWith(prev ?? "\0")) orderCooldown.delete(k);
  }
  for (const k of [...zeroFillSuppressionCache.keys()]) { // suppression key = ticker-SIDE
    if (k.startsWith(prev ?? "\0")) zeroFillSuppressionCache.delete(k);
  }
  for (const k of [...zeroFillRetryCount.keys()]) { // retry counter key = ticker-SIDE
    if (k.startsWith(prev ?? "\0")) zeroFillRetryCount.delete(k);
  }
  if (prev) cancelZeroFillRetryPolls(prev); // pending retry polls die with the window
  if (prev) marketState.delete(prev);

  currentTickerBySeries.set(series, newTicker);
  if (series === "KXETH15M" && boundaryDiscoveryTarget?.ticker === newTicker) {
    recordBoundaryDiscoveryAudit({
      ticker: newTicker, openTimeMs: boundaryDiscoveryTarget.openTimeMs,
      atMs: Date.now(), stage: "rollover", reason: null,
    });
  }
  logger.info({ ticker: newTicker, series }, "AutoTrader: new window detected");

  // Re-subscribe the WS stream immediately so it tracks the new ticker.
  // Without this, the stream stays subscribed to the old ticker for up to
  // TICKER_REFRESH_MS (120 s), making isWsStale() return true for the
  // entire first two minutes of every new window.
  kalshiStream.refreshTickers().catch((err) =>
    logger.warn({ err, ticker: newTicker }, "AutoTrader: WS ticker refresh failed after rollover"),
  );

  wlOpen(series, newTicker); // seals previous entry, opens new one
  if (prev) {
    try { rollWindowAnalytics(series, prev); } catch {}
    // Schedule outcome reconciliation ~3 min after window close (fire-and-forget)
    try { scheduleOutcomeReconciliation(prev, prevCloseTime); } catch (error) {
      console.error("[outcome-reconciliation-schedule-failed]", {
        ticker: prev,
        closeTime: prevCloseTime,
        error,
      });
    }
  }
}

// ── Shared evaluation function ────────────────────────────────────────────────

type TriggerSource = "websocket" | "rest_fallback" | "startup_prime";

interface Phase4BFinalDecisionFields {
  finalDecisionClassification: Phase4BFinalDecisionClassification;
  finalOrderPathOutcome: string;
  guardOutcomes: Phase4BGuardOutcomes;
  allOtherGuardsPassed: boolean | null;
  executableL2DepthContracts?: number | null;
  intendedContractCount?: number | null;
  intendedNotionalCents?: number | null;
  availableExposureDollars?: number | null;
  estimatedFeesDollars?: number | null;
  clientOrderId?: string | null;
  kalshiOrderId?: string | null;
}

function unevaluatedPhase4BGuards(): Phase4BGuardOutcomes {
  const merged = {
    priceFloor: null, priceCap: null, staleBboGap: null, wideSpread: null,
    l2Available: null, executableDepth: null, budget: null, position: null,
    dedup: null, halted: null,
  };
  return {
    priceFloor: null, priceCap: null, staleBboGap: null, wideSpread: null,
    l2Available: null, executableDepth: null, budget: null, position: null,
    dedup: null, halted: null,
  };
}

/** Null means not evaluated; only evaluated non-price guards participate. */
function allEvaluatedNonPriceGuardsPassed(guards: Phase4BGuardOutcomes): boolean | null {
  const values = [
    guards.staleBboGap, guards.wideSpread, guards.l2Available, guards.executableDepth,
    guards.budget, guards.position, guards.dedup, guards.halted,
  ].filter((value): value is boolean => value !== null);
  return values.length === 0 ? null : values.every(Boolean);
}

function capturePhase4BFinalDecision(
  input: Phase4BCaptureInput,
  fields: Phase4BFinalDecisionFields,
): void {
  if (!isPhase4BPassiveCaptureEnabled()) return;
  enqueuePhase4BPassiveCapture({ ...input, ...fields },
    `final:${fields.finalDecisionClassification}:${fields.finalOrderPathOutcome}`);
}

/**
 * Mutable per-evaluation timing capture (epoch ms). Created at tick receipt
 * (WS message arrival or REST fetch start), threaded through evaluate() →
 * checkAndPlace() → placeOrder(), and persisted to order_attempts via
 * tradeStore.recordAttemptTimings() once the Kalshi ack arrives.
 */
interface EvalTiming {
  tickReceivedMs: number;        // WS msg received / REST fetch started
  evalStartMs?:   number | null; // evaluate() entry
  l2StartMs?:     number | null; // pre-flight L2 fetch start
  l2EndMs?:       number | null; // pre-flight L2 fetch end
  postStartMs?:   number | null; // Kalshi POST sent
  ackMs?:         number | null; // Kalshi response received
  l2BestAskCents?:   number | null; // preflight executable best ask (cents)
  l2DepthDollars?:   number | null; // preflight depth $ at verified limit
  l2DepthContracts?: number | null; // preflight depth contracts at verified limit
  /** Present only for the scheduled fresh boundary path's audit observer. */
  boundaryOpenTimeMs?: number;
}

/** Per-ticker timestamp of the last pre-window status log (throttle). */
const lastPreWindowLogMs = new Map<string, number>();

/** Per-ticker timestamp of the last "no close time" warning (throttle). */
const lastNoCloseTimeLogMs = new Map<string, number>();
async function evaluate(
  state:      MarketState,
  betDollars: number,
  source:     TriggerSource,
  timing?:    EvalTiming,
): Promise<void> {
  const _timing: EvalTiming = timing ?? { tickReceivedMs: Date.now() };
  _timing.evalStartMs = Date.now();
  // New ETH martingale positions are deliberately not routed through the
  // legacy 80¢ protective-exit path. Legacy cleanup runs only from the
  // restored-position monitor in index.ts and is never driven by this evaluator.
  if (isEthTicker(state.ticker)) {
    await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
      ticker: state.ticker,
      exchangeIndex: state.exchangeIndex ?? null,
      openTime: state.openTime,
      closeTime: state.closeTime,
      status: state.status,
    });
    await evaluateEth420Candidate(state, _timing);
  const jumpOpenTimeMs = state.openTime == null ? null : Date.parse(state.openTime);
  await runEthJumpServiceWhenExplicitlyEnabled({
    store: tradeStore,
    market: {
      ticker: state.ticker,
      easternDate: jumpOpenTimeMs != null && Number.isFinite(jumpOpenTimeMs)
        ? easternDay(new Date(jumpOpenTimeMs)) : easternDay(new Date()),
      observedAtMs: Date.now(),
      floorStrike: state.floorStrike ?? null,
      openTimeMs: jumpOpenTimeMs,
    },
    exchangeIndex: state.exchangeIndex ?? null,
    // Dormant wiring only. A later separately reviewed capital snapshot
    // provider is required before the hard B execution fence can change.
    capital: null,
  });
    // Dormant wiring only. C shares the same market identity but has its own
    // independent signal, ledger identity, and hard execution fence.
    await runEthReversalServiceWhenExplicitlyEnabled({
      store: tradeStore,
      market: {
        ticker: state.ticker,
        easternDate: jumpOpenTimeMs != null && Number.isFinite(jumpOpenTimeMs)
          ? easternDay(new Date(jumpOpenTimeMs)) : easternDay(new Date()),
        observedAtMs: Date.now(),
        floorStrike: state.floorStrike ?? null,
        openTimeMs: jumpOpenTimeMs,
      },
      exchangeIndex: state.exchangeIndex ?? null,
      // No capital provider is wired in this staging commit, so C remains
      // fail-closed even independently of its hard code approval fence.
      capital: null,
    });
  }
  // The retired BTC/SOL/DOGE entry evaluator below is intentionally kept only
  // as historical source material. This unconditional production fence has no
  // test override; new entries are exclusively owned by ethOnlyMartingale.ts.
  if (!state.closeTime || isLegacyEntryExecutionDisabled()) return;
  // Historical evaluator retained below for source compatibility only. It is
  // fenced here and again at placeOrder() as defense in depth.
  if (!state.closeTime) {
    // Throttle to once per minute per ticker so we don't flood logs, but still
    // produce a visible record whenever a window opens without close_time — the
    // most likely sign of a rate-limit gap at window rollover.
    const now     = Date.now();
    const lastLog = lastNoCloseTimeLogMs.get(state.ticker) ?? 0;
    if (now - lastLog >= 60_000) {
      lastNoCloseTimeLogMs.set(state.ticker, now);
      logger.warn(
        { ticker: state.ticker, source, market_status: state.status },
        "AutoTrader: evaluate called with no close_time — window state may be missing after rollover",
      );
    }
    return;
  }

  const secondsLeft = secondsUntil(state.closeTime);
  if (secondsLeft === null || secondsLeft <= 0) return;
  // ── Coverage telemetry (observability only — never affects trading) ───────
  // Evaluation evidence only. Window registration and usable-quote evidence
  // come from RAW observations (mergeState / kalshiStream.refreshTickers), so
  // a silent stream that prevents evaluate() from running is still visible.
  recordCoverageEvaluation(state.ticker);
  captureMandelbrotPassiveObservation(state, secondsLeft);
  capturePhase4BProspectiveBaseline(state, secondsLeft, source, betDollars);
  if (!isRuntimeEntryHealthy()) {
    return;
  }

  // ── Pre-window market-status log (5 min → 2 min before close) ────────────
  // Logs the full market snapshot once per minute so we can confirm the ticker
  // is open, has valid prices, and is tradable well before evaluation begins.
  if (secondsLeft > TIME_ALERT_SECONDS && secondsLeft <= EVALUATION_BUFFER_SECS) {
    // Persist close time to the window log as soon as we have it (so the UI
    // doesn't show "close:?" during the entire 5-minute pre-window period).
    const preSeries = seriesForTicker(state.ticker);
    if (preSeries && state.closeTime) wlSetCloseTime(preSeries, state.ticker, state.closeTime);

    const now = Date.now();
    const lastLog = lastPreWindowLogMs.get(state.ticker) ?? 0;
    if (now - lastLog >= PRE_WINDOW_LOG_INTERVAL_MS) {
      lastPreWindowLogMs.set(state.ticker, now);
      logger.info(
        {
          ticker:           state.ticker,
          market_status:    state.status,
          open_time:        state.openTime,
          close_time:       state.closeTime,
          expiration_time:  state.expirationTime,
          last_price_cents: state.lastPrice,
          yes_bid:          state.yesBid,
          yes_ask:          state.yesAsk,
          no_bid:           state.noBid,
          no_ask:           state.noAsk,
          secondsLeft,
          source,
        },
        "AutoTrader: pre-window market status",
      );
    }
    // ── Passive observation for the 61–120 s window ───────────────────────
    // Log tick data so a future replay can compare 2-minute vs 3-minute
    // windows. No order is placed, no dedup slot claimed, no budget reserved.
    // Fire-and-forget; errors are silently swallowed inside logPassiveObservation.
    if (secondsLeft <= PASSIVE_OBS_MAX_SECS) {
      const obsNow = Date.now();
      const lastWs = lastWsTickMs.get(state.ticker) ?? 0;
      logPassiveObservation({
        nowMs:       obsNow,
        ticker:      state.ticker,
        closeTime:   state.closeTime!,
        secondsLeft,
        yesBid:      state.yesBid,
        yesAsk:      state.yesAsk,
        noBid:       state.noBid,
        noAsk:       state.noAsk,
        source,
        wsConnected: kalshiStream.isConnected(),
        wsStale:     obsNow - lastWs >= STALE_WS_MS,
        betDollars,
      });
    }

    try {
      const evalSeries = seriesForTicker(state.ticker);
      if (evalSeries) recordGuardOutcome(evalSeries, "outside_time_window");
    } catch {}
    return;
  }

  if (secondsLeft > TIME_ALERT_SECONDS) {
    try {
      const evalSeries = seriesForTicker(state.ticker);
      if (evalSeries) recordGuardOutcome(evalSeries, "outside_time_window");
    } catch {}
    return;
  }

  // Derive the executable ask price for each side from the OTHER side's best bid.
  // In a binary market: YES ask ≈ 100 − NO bid, NO ask ≈ 100 − YES bid.
  // We trigger on what we would actually PAY, not what someone else bids.
  const yesDerivedAsk = state.noBid  != null ? 100 - state.noBid  : null;
  const noDerivedAsk  = state.yesBid != null ? 100 - state.yesBid : null;
  const wlSeries = seriesForTicker(state.ticker);
  // The live trader only supports explicit, owner-approved series policies.
  // Fail closed rather than allowing an unrecognized ticker to inherit BTC rules.
  if (!wlSeries) return;
  const phase4bBaseInput = (
    side: "yes" | "no",
    displayedEntryPriceCents: number | null,
    decisionClassification: string,
    skipReason: string | null,
    extra: Partial<Pick<Phase4BCaptureInput,
      "configuredLimitCents" | "bboDerivedLimitCents" | "quotedBboAskCents" |
      "executableL2AskCents" | "bboToL2GapCents" | "preflightLatencyMs">> = {},
  ): Phase4BCaptureInput => {
    const now = Date.now();
    const lastWs = lastWsTickMs.get(state.ticker) ?? 0;
    return {
      timestampMs: now, ticker: state.ticker, series: seriesForTicker(state.ticker) ?? "",
      closeTime: state.closeTime!, openTime: state.openTime ?? null, secondsLeft, side,
      selectedSideReason: "side_supplied_by_live_evaluation_path", source,
      wsConnected: kalshiStream.isConnected(), wsStale: now - lastWs >= STALE_WS_MS,
      lastWsMessageAgeMs: now - lastWs, bboAgeMs: now - state.bidUpdatedMs,
      yesBid: state.yesBid, yesAsk: state.yesAsk, noBid: state.noBid, noAsk: state.noAsk,
      displayedEntryPriceCents, configuredLimitCents: null, bboDerivedLimitCents: null,
      strategyVersion: null, betDollars, priceFloorCents: PRICE_FLOOR_CENTS, priceCapCents: PRICE_CAP_CENTS,
      limitBufferCents: LIMIT_PRICE_BUFFER_CENTS, staleGapThresholdCents: MAX_BBO_L2_NEGATIVE_GAP_CENTS,
      decisionClassification, skipReason, quotedBboAskCents: null, executableL2AskCents: null,
      bboToL2GapCents: null, preflightLatencyMs: null, ...extra,
       thresholdRule: thresholdRuleFromState(state, now),
    };
  };
  logger.info(
    {
      ticker:          state.ticker,
      market_status:   state.status,
      open_time:       state.openTime,
      close_time:      state.closeTime,
      expiration_time: state.expirationTime,
      last_price_cents: state.lastPrice,
      secondsLeft,
      yesBid:          state.yesBid,
      yesAsk:          state.yesAsk,
      noBid:           state.noBid,
      noAsk:           state.noAsk,
      derivedYesAsk:   yesDerivedAsk,
      derivedNoAsk:    noDerivedAsk,
      zone:            `${ALERT_MIN}–${ALERT_MAX}¢`,
      tick_received_ms: _timing.tickReceivedMs,
      eval_start_ms:    _timing.evalStartMs,
      tick_to_eval_ms:  (_timing.evalStartMs ?? 0) - _timing.tickReceivedMs,
      source,
    },
    "AutoTrader: tick in window",
  );

  // ── Window tick recording (for resting-order simulation) ─────────────────
  // Records every in-window tick to data/analytics/window-ticks-YYYY-MM-DD.ndjson
  // so the /api/trade/resting-order-sim endpoint can estimate whether a resting
  // GTC order placed at T−120 s and cancelled at T−10 s would have had
  // crossing opportunities. Fire-and-forget; never throws.
  recordWindowTick({
    ticker:        state.ticker,
    timestampMs:   Date.now(),
    secondsLeft,
    yesBid:        state.yesBid,
    yesAsk:        state.yesAsk,
    noBid:         state.noBid,
    noAsk:         state.noAsk,
    derivedYesAsk: yesDerivedAsk,
    derivedNoAsk:  noDerivedAsk,
    inZone: (
       (yesDerivedAsk != null && wlSeries != null && isEntryPriceInBandForSeries(wlSeries, yesDerivedAsk)) ||
       (noDerivedAsk  != null && wlSeries != null && isEntryPriceInBandForSeries(wlSeries, noDerivedAsk))
    ),
    source: String(source),
  });

  // ── Window log: mark entered and capture first in-zone prices ────────────
  {
    if (state.closeTime) wlSetCloseTime(wlSeries, state.ticker, state.closeTime);
    const inZone = (
       (yesDerivedAsk != null && isEntryPriceInBandForSeries(wlSeries, yesDerivedAsk)) ||
       (noDerivedAsk  != null && isEntryPriceInBandForSeries(wlSeries, noDerivedAsk))
    );
    wlTick(wlSeries, state.ticker, inZone, yesDerivedAsk, noDerivedAsk);
    // ── Analytics: record qualifying in-zone evals and outside-zone guard ────
    try {
      if (inZone) {
        recordQualifyingEvaluation({
          ticker:          state.ticker,
          series:          wlSeries,
          windowCloseTime: state.closeTime,
          timestampMs:     Date.now(),
           yesDerivedAsk:   yesDerivedAsk != null && isEntryPriceInBandForSeries(wlSeries, yesDerivedAsk) ? yesDerivedAsk : null,
           noDerivedAsk:    noDerivedAsk  != null && isEntryPriceInBandForSeries(wlSeries, noDerivedAsk) ? noDerivedAsk  : null,
        });
      } else {
        recordGuardOutcome(wlSeries, "outside_zone");
        // ── Durable per-tick evaluation event ─────────────────────────────────
        // Captures the server's state at this exact moment so a browser quote
        // alert at the same timestamp can be matched to a named server outcome.
        // "no_tick" means the server had BBO data but could not derive either
        // executable ask (both opposite bids were null).
        // "out_of_zone" means both derived asks existed but neither was in zone.
        recordEvaluationEvent({
          ticker: state.ticker, series: wlSeries,
          timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
          yesBid: state.yesBid, yesAsk: state.yesAsk,
          noBid: state.noBid, noAsk: state.noAsk,
          yesDerivedAsk, noDerivedAsk,
          side: null, limitCents: null,
          outcome: (yesDerivedAsk === null && noDerivedAsk === null) ? "no_tick" : "out_of_zone",
          preflightDecision: null,
        });
      }
    } catch {}
  }

  // ── Helper: zero-fill suppression + placeOrder ───────────────────────────────
  //
  // Policy: always allow the first IOC submission when price is in zone.
  // If that order zero-fills, placeOrder() records the snapshot in
  // zeroFillSuppressionCache.  On the next tick we check here — if the
  // snapshot is unchanged we skip (suppressed_retry_after_zero_fill) so the
  // 5-second REST fallback cannot hammer Kalshi with hopeless retries.
  //
  // Suppression is cleared when:
  //   (a) any of the 5 snapshot fields changes (prices shifted → retry)
  //   (b) a fill succeeds (placeOrder clears the entry on full/partial fill)
  //   (c) the window rolls over (handleWindowRollover clears by ticker prefix)
  //
  // This replaces the former BBO-derived executability pre-block which was
  // proven incorrect on 2026-07-30 13:28 UTC: both KXBTC15M and KXETH15M
  // -26JUL300930-30 had noAsk === 100 − yesBid yet fully filled in production.
  const checkAndPlace = async (
    side:          "yes" | "no",
    triggerCents:  number,
    limitPrice:    number,
  ): Promise<void> => {
    const cacheKey    = `${state.ticker}-${side.toUpperCase()}`;
    const currentSnap = {
      limitCents: limitPrice,
      yesAsk:     state.yesAsk,
      noAsk:      state.noAsk,
      yesBid:     state.yesBid,
      noBid:      state.noBid,
    };
    const cached = zeroFillSuppressionCache.get(cacheKey);

    // If the previous IOC zero-filled on this exact snapshot AND the entry is
    // still fresh, suppress the retry.  After ZERO_FILL_SUPPRESS_TTL_MS the
    // entry is treated as stale — the book may have refreshed even if quoted
    // prices haven't moved, so we allow one more attempt.
    if (cached) {
      const snapshotUnchanged =
        cached.limitCents === currentSnap.limitCents &&
        cached.yesAsk     === currentSnap.yesAsk &&
        cached.noAsk      === currentSnap.noAsk &&
        cached.yesBid     === currentSnap.yesBid &&
        cached.noBid      === currentSnap.noBid;
      const entryAgeMs = Date.now() - cached.cachedAt;
      const stillFresh = entryAgeMs < ZERO_FILL_SUPPRESS_TTL_MS;

      if (snapshotUnchanged && stillFresh) {
        // Distinguish real post-POST zero-fills from L2 preflight skips where
        // NO order was ever sent to Kalshi (misleading log fixed 2026-08-01).
        const isPreflightSkip = cached.origin === "preflight_skip";
        logger.info(
          {
            ticker:        state.ticker,
            side,
            limit_cents:   limitPrice,
            yes_ask:       state.yesAsk,
            no_ask:        state.noAsk,
            yes_bid:       state.yesBid,
            no_bid:        state.noBid,
            zone:          `${ALERT_MIN}–${ALERT_MAX}¢`,
            source,
            suppress_age_ms:    entryAgeMs,
            suppress_ttl_ms:    ZERO_FILL_SUPPRESS_TTL_MS,
            suppression_origin: cached.origin ?? "zero_fill",
          },
          isPreflightSkip
            ? "AutoTrader: suppressed re-evaluation after preflight skip — no order was submitted; identical snapshot, skipping"
            : "AutoTrader: suppressed retry after zero-fill — identical snapshot, skipping Kalshi submission",
        );
        const outcomeKey = isPreflightSkip
          ? "preflight_skip_suppressed" as const
          : "suppressed_retry_after_zero_fill" as const;
        if (wlSeries) wlSkip(wlSeries, state.ticker, outcomeKey);
        try { if (wlSeries) recordGuardOutcome(wlSeries, outcomeKey); } catch {}
        recordEvaluationEvent({
          ticker: state.ticker, series: wlSeries ?? "",
          timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
          yesBid: state.yesBid, yesAsk: state.yesAsk,
          noBid: state.noBid, noAsk: state.noAsk,
          yesDerivedAsk, noDerivedAsk,
          side, limitCents: limitPrice,
          outcome: "preflight_skip", preflightDecision: outcomeKey,
        });
        return;
      }

      if (snapshotUnchanged && !stillFresh) {
        // TTL elapsed with prices unchanged.  Check per-window retry budget.
        //
        // IMPORTANT: do NOT delete the cache entry before this check.
        // If the budget is exhausted we return without touching the cache so
        // that every subsequent tick with the same snapshot hits this path
        // again and stays blocked for the rest of the window.  The entry is
        // only cleared when a retry is actually granted (below), or when
        // prices change (else branch below).
        const retriesSoFar = zeroFillRetryCount.get(cacheKey) ?? 0;
        if (retriesSoFar >= MAX_ZERO_FILL_RETRIES) {
          logger.info(
            {
              ticker:          state.ticker,
              side,
              limit_cents:     limitPrice,
              retries_used:    retriesSoFar,
              max_retries:     MAX_ZERO_FILL_RETRIES,
              suppress_age_ms: entryAgeMs,
              source,
            },
            "AutoTrader: zero-fill retry budget exhausted — no more retries this window",
          );
          if (wlSeries) wlSkip(wlSeries, state.ticker, "zero_fill_retry_budget_exhausted");
          try { if (wlSeries) recordGuardOutcome(wlSeries, "zero_fill_retry_budget_exhausted"); } catch {}
          recordEvaluationEvent({
            ticker: state.ticker, series: wlSeries ?? "",
            timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
            yesBid: state.yesBid, yesAsk: state.yesAsk,
            noBid: state.noBid, noAsk: state.noAsk,
            yesDerivedAsk, noDerivedAsk,
            side, limitCents: limitPrice,
            outcome: "preflight_skip", preflightDecision: "zero_fill_retry_budget_exhausted",
          });
          return; // cache kept — next tick is still blocked
        }
        // Retry budget available — consume one slot, THEN clear the cache so
        // the order proceeds.  The new zero-fill (if any) will re-populate it.
        zeroFillRetryCount.set(cacheKey, retriesSoFar + 1);
        zeroFillSuppressionCache.delete(cacheKey);
        if (wlSeries) wlMarkZeroFillRetried(wlSeries, state.ticker);
        logger.info(
          {
            ticker:          state.ticker,
            side,
            limit_cents:     limitPrice,
            retry_attempt:   retriesSoFar + 1,
            max_retries:     MAX_ZERO_FILL_RETRIES,
            suppress_age_ms: entryAgeMs,
            retry_delay_ms:  ZERO_FILL_RETRY_DELAY_MS,
            source,
          },
          "AutoTrader: zero-fill suppression expired — retrying to capture available depth",
        );
      } else {
        // Snapshot changed — clear cache immediately and allow fresh attempt.
        zeroFillSuppressionCache.delete(cacheKey);
      }
    }

    // ── Combined in-flight guard via runWithPreflightLock ────────────────────
    // runWithPreflightLock checks preflightInFlight AND submissionInFlight
    // synchronously (no await before the .add()), acquires preflightInFlight,
    // runs the async body, and releases the lock in its own finally block.
    // This is the single shared implementation tested by
    // autoTrader.concurrency.test.ts — no lock logic is duplicated here.
    const _lockResult = await runWithPreflightLock(state.ticker, async () => {
      // ── Pre-flight L2 executability check (mandatory gate) ───────────────
      //
      // Capture the BBO snapshot BEFORE the async L2 fetch so the gap check
      // compares against the price that triggered this evaluation, not a
      // subsequent WS tick that may arrive while captureOrderbook is awaited.
      const _pfSnap     = marketState.get(state.ticker) ?? state;
      const _pfBboAgeMs = Date.now() - _pfSnap.bidUpdatedMs;

      // BBO reference for the gap check: use the DERIVED opposite-bid ask
      // (100 − noBid for YES, 100 − yesBid for NO) rather than the raw
      // side-own ask field from the WS stream.
      //
      // Rationale: evaluate() already computed limitPrice from the same
      // derived formula (noDerivedAsk = 100 − yesBid, etc.).  Using the raw
      // own-side ask (yesAsk / noAsk) would silently misfire whenever
      // Kalshi's WS publishes the own-side ask stale while the opposite bid
      // has moved — exactly the pattern seen in production (KXBTC15M
      // 2026-08-02 12:30 ET window: noAsk=86¢ stale, yesBid=27¢ current,
      // L2 correctly at 73¢ = 100−27).
      //
      // Invariant enforced: bboReferenceAsk ≡ bboDerivedLimitCents − 1
      //   (both equal 100 − oppBid, capped only at ALERT_MAX for limitCents)
      const _pfBboAsk: number | null =
        side === "yes"
          ? (_pfSnap.noBid  != null ? 100 - _pfSnap.noBid  : null)
          : (_pfSnap.yesBid != null ? 100 - _pfSnap.yesBid : null);

      _timing.l2StartMs = Date.now();
      const _pfBook = await (_captureOrderbookImpl ?? captureOrderbook)(state.ticker, side, limitPrice);
      _timing.l2EndMs = Date.now();

      // ── Fail closed on L2 fetch error ────────────────────────────────────
      if (_pfBook.error) {
        logger.info(
          {
            ticker:                  state.ticker,
            side,
            seconds_left:            secondsLeft,
            bbo_derived_limit_cents: limitPrice,
            bbo_age_ms:              _pfBboAgeMs,
            l2_fetch_latency_ms:     _pfBook.fetchLatencyMs,
            l2_fetch_error:          _pfBook.error,
            decision:                "skip_l2_unavailable",
            source,
          },
          "AutoTrader: pre-flight L2 check",
        );
        recordPreflightDecision({
          ticker: state.ticker, series: wlSeries ?? "", side,
          timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0,
          quotedBboAsk: null, bboAgeMs: _pfBboAgeMs,
          bboDerivedLimitCents: limitPrice, executableBestAskCents: null,
          bboToL2GapCents: null, verifiedLimitCents: null,
          depthAtLimitDollars: 0, depthAtLimitContracts: 0,
          intendedContracts: 0, intendedNotionalCents: 0,
          adjustedContracts: 0, fillFractionEstimate: 0,
          nearLimitLevels: [], l2FetchLatencyMs: _pfBook.fetchLatencyMs,
          decision: "skip_l2_unavailable", marketResult: null,
        });
        capturePhase4BFinalDecision(
          phase4bBaseInput(side, limitPrice, "skip_l2_unavailable", "skip_l2_unavailable", {
            bboDerivedLimitCents: limitPrice, quotedBboAskCents: _pfBboAsk,
            preflightLatencyMs: _pfBook.fetchLatencyMs,
          }),
          {
            finalDecisionClassification: "rejected_l2_unavailable",
            finalOrderPathOutcome: "skip_l2_unavailable",
            guardOutcomes: {
              ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, l2Available: false,
            },
            allOtherGuardsPassed: null,
            executableL2DepthContracts: 0,
          },
        );
        // Do NOT set suppression cache — allow retry when L2 comes back
        recordEvaluationEvent({
          ticker: state.ticker, series: wlSeries ?? "",
          timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
          yesBid: state.yesBid, yesAsk: state.yesAsk,
          noBid: state.noBid, noAsk: state.noAsk,
          yesDerivedAsk, noDerivedAsk,
          side, limitCents: limitPrice,
          outcome: "preflight_skip", preflightDecision: "skip_l2_unavailable",
        });
        return;
      }

      // ── Pure gate computation (no I/O, no logging) ───────────────────────
      // computePreflightDecision is the single source of truth for the gate
      // logic; this is the same function exercised by the preflight unit tests.
      const _pf = computePreflightDecision({
        series:               wlSeries,
        side,
        bboAsk:               _pfBboAsk,
        rawYesDollars:        _pfBook.rawYesDollars,
        rawNoDollars:         _pfBook.rawNoDollars,
        betDollars,
        bboDerivedLimitCents: limitPrice,
      });

      // Capture the L2 snapshot on the timing object so it is persisted to
      // order_attempts alongside the ms timeline (instrumentation only).
      _timing.l2BestAskCents   = _pf.executableBestAskCents;
      _timing.l2DepthDollars   = _pf.depthAtLimitDollars;
      _timing.l2DepthContracts = _pf.depthAtLimitContracts;

      // Derived logging/persistence fields computed from gate result
      const _pfIntendedContracts = _pf.verifiedLimitCents != null
        ? contractsForPrice(_pf.verifiedLimitCents, betDollars) : 0;
      const _pfIntendedNotional  = _pfIntendedContracts * (_pf.verifiedLimitCents ?? 0);
      const _pfFillFraction      = _pfIntendedContracts > 0
        ? Math.min(_pf.adjustedContracts / _pfIntendedContracts, 1) : 0;

      // ── Unified pre-flight log (all decisions, all fields) ────────────────
      logger.info(
        {
          ticker:                    state.ticker,
          side,
          seconds_left:              secondsLeft,
          bbo_derived_limit_cents:   limitPrice,
          quoted_bbo_yes_ask:        _pfSnap.yesAsk ?? null,
          quoted_bbo_no_ask:         _pfSnap.noAsk  ?? null,
           opposite_side_bid:          side === "yes" ? (_pfSnap.noBid ?? null) : (_pfSnap.yesBid ?? null),
           bbo_reference_formula:     "100 - opposite_side_bid",
          quoted_bbo_ask:            _pfBboAsk,
          bbo_age_ms:                _pfBboAgeMs,
          executable_best_ask_cents: _pf.executableBestAskCents,
          bbo_to_l2_gap_cents:       _pf.bboToL2GapCents,
          verified_limit_cents:      _pf.verifiedLimitCents,
          depth_at_limit_dollars:    _pf.depthAtLimitDollars,
          depth_at_limit_contracts:  _pf.depthAtLimitContracts,
          intended_contracts:        _pfIntendedContracts,
          intended_notional_cents:   _pfIntendedNotional,
          adjusted_contracts:        _pf.adjustedContracts,
          fill_fraction_estimate:    _pfFillFraction,
          near_limit_levels:         _pfBook.nearLimitLevels,
          l2_fetch_latency_ms:       _pfBook.fetchLatencyMs,
          decision:                  _pf.decision,
          source,
        },
        "AutoTrader: pre-flight L2 check",
      );

      // ── Persist decision ──────────────────────────────────────────────────
      recordPreflightDecision({
        ticker:                state.ticker,
        series:                wlSeries ?? "",
        side,
        timestampMs:           Date.now(),
        secondsLeft:           secondsLeft ?? 0,
        quotedBboAsk:          _pfBboAsk,
        bboAgeMs:              _pfBboAgeMs,
        bboDerivedLimitCents:  limitPrice,
        executableBestAskCents: _pf.executableBestAskCents,
        bboToL2GapCents:       _pf.bboToL2GapCents,
        verifiedLimitCents:    _pf.verifiedLimitCents,
        depthAtLimitDollars:   _pf.depthAtLimitDollars,
        depthAtLimitContracts: _pf.depthAtLimitContracts,
        intendedContracts:     _pfIntendedContracts,
        intendedNotionalCents: _pfIntendedNotional,
        adjustedContracts:     _pf.adjustedContracts,
        fillFractionEstimate:  _pfFillFraction,
        nearLimitLevels:       _pfBook.nearLimitLevels,
        l2FetchLatencyMs:      _pfBook.fetchLatencyMs,
        decision:              _pf.decision,
        marketResult:          null,
      });
      // Phase 4B is an opt-in, post-decision observer. Its dynamic import and
      // non-awaited enqueue are deliberately outside all decision and order work.
      if (isPhase4BPassiveCaptureEnabled() && secondsLeft <= 180) {
        const phase4bInput = {
          timestampMs: Date.now(), ticker: state.ticker, series: wlSeries ?? "", closeTime: state.closeTime!,
          openTime: state.openTime ?? null, secondsLeft, side, source,
          wsConnected: kalshiStream.isConnected(), wsStale: Date.now() - (lastWsTickMs.get(state.ticker) ?? 0) >= STALE_WS_MS,
          lastWsMessageAgeMs: Date.now() - (lastWsTickMs.get(state.ticker) ?? 0), bboAgeMs: _pfBboAgeMs,
          yesBid: _pfSnap.yesBid ?? null, yesAsk: _pfSnap.yesAsk ?? null, noBid: _pfSnap.noBid ?? null, noAsk: _pfSnap.noAsk ?? null,
          displayedEntryPriceCents: limitPrice, configuredLimitCents: _pf.verifiedLimitCents, bboDerivedLimitCents: limitPrice,
          strategyVersion: null, betDollars, priceFloorCents: PRICE_FLOOR_CENTS, priceCapCents: PRICE_CAP_CENTS,
          limitBufferCents: null, staleGapThresholdCents: null, decisionClassification: _pf.decision,
          skipReason: _pf.decision === "submit" ? null : _pf.decision, quotedBboAskCents: _pfBboAsk,
          executableL2AskCents: _pf.executableBestAskCents, bboToL2GapCents: _pf.bboToL2GapCents,
          preflightLatencyMs: _pfBook.fetchLatencyMs,
        } as const;
        enqueuePhase4BPassiveCapture(phase4bInput);
      }
        // Passive stale-gap capture is strictly opt-in. The dynamic import keeps
        // the module, queue, storage, and all capture work absent when disabled.
        // It is deliberately not awaited and cannot alter the final gate result.
        if (_pf.decision === "skip_stale_bbo_gap") {
          const _captureInput = {
            timestampMs: Date.now(), ticker: state.ticker, series: wlSeries ?? "", side,
            secondsLeft: secondsLeft ?? 0, bboDerivedLimitCents: limitPrice,
            quotedBboAsk: _pfBboAsk, bboAgeMs: _pfBboAgeMs,
            yesBid: _pfSnap.yesBid ?? null, yesAsk: _pfSnap.yesAsk ?? null,
            noBid: _pfSnap.noBid ?? null, noAsk: _pfSnap.noAsk ?? null,
            executableBestAskCents: _pf.executableBestAskCents,
            bboToL2GapCents: _pf.bboToL2GapCents,
            l2Levels: _pfBook.nearLimitLevels.map((level) => ({ ...level })),
            l2FetchLatencyMs: _pfBook.fetchLatencyMs, source,
            strategy: {
              betDollars,
              priceFloorCents: PRICE_FLOOR_CENTS,
              priceCapCents: PRICE_CAP_CENTS,
            },
            budget: {
              // These are observational reads after the final gate decision.
              // They are copied into the passive payload and never reserved here.
              windowRemainingDollars: Math.max(0, betDollars - (spendTracker.get(state.ticker) ?? 0)),
              dailyRemainingNotionalCents: Number.MAX_SAFE_INTEGER,
            },
            exposure: {
              // The calculator records the guard state supplied at capture time.
              // Position is intentionally not fetched here: doing so would add
              // asynchronous live-path work after a skip.
              signedContracts: 0,
              maxAbsoluteContracts: null,
            },
          } as const;
          try {
            if (_staleGapCaptureImpl) _staleGapCaptureImpl(_captureInput);
            else if (process.env["STALE_GAP_COUNTERFACTUAL_CAPTURE_ENABLED"] === "true") {
              void import("./staleGapPassiveCapture.js")
                .then(({ enqueueStaleGapPassiveCapture }) => enqueueStaleGapPassiveCapture(_captureInput))
                .catch(() => { /* passive analytics never affect trading */ });
            }
          } catch { /* passive analytics never affect trading */ }
        }

      // ── Handle non-submit decisions ───────────────────────────────────────
      if (_pf.decision !== "submit") {
        // No order was POSTed to Kalshi — record as a preflight skip, NOT a
        // zero_fill, so analytics and window logs never conflate the two.
        // The window-log skipReason carries the specific decision
        // (e.g. skip_ask_above_strategy_limit) for diagnosis.
        if (wlSeries) wlSkip(wlSeries, state.ticker, _pf.decision);
        try { if (wlSeries) recordGuardOutcome(wlSeries, "preflight_skip"); } catch {}
        // Populate suppression cache so identical next-tick retries are skipped.
        // Use verifiedLimitCents when available; fall back to BBO-derived limit.
        zeroFillSuppressionCache.set(cacheKey, {
          limitCents: _pf.verifiedLimitCents ?? limitPrice,
          yesAsk:     _pfSnap.yesAsk  ?? null,
          noAsk:      _pfSnap.noAsk   ?? null,
          yesBid:     _pfSnap.yesBid  ?? null,
          noBid:      _pfSnap.noBid   ?? null,
          cachedAt:   Date.now(),
          origin:     "preflight_skip",
        });
        // Guarantee a REST evaluation tick lands within 32 s so the retry can
        // fire before window close even if no WS/reconcile tick arrives.
        armZeroFillRetryPoll(state.ticker, side);
        const finalDecisionClassification: Phase4BFinalDecisionClassification =
          _pf.decision === "skip_stale_bbo_gap" ? "rejected_stale_bbo_gap"
            : _pf.decision === "skip_zero_depth" || _pf.decision === "skip_zero_contracts"
              ? "rejected_zero_depth"
              : _pf.decision === "skip_executable_price_outside_band" &&
                  (_pf.executableBestAskCents ?? limitPrice) < PRICE_FLOOR_CENTS
                ? "rejected_price_floor"
              : "rejected_price_cap";
        const failedGuard: Phase4BGuardOutcomes = {
          ...unevaluatedPhase4BGuards(),
          priceFloor: _pf.decision !== "skip_executable_price_outside_band" ||
            (_pf.executableBestAskCents ?? limitPrice) >= PRICE_FLOOR_CENTS,
          priceCap: _pf.decision !== "skip_ask_above_strategy_limit" &&
            (_pf.decision !== "skip_executable_price_outside_band" ||
              (_pf.executableBestAskCents ?? limitPrice) <= PRICE_CAP_CENTS),
          staleBboGap: _pf.decision !== "skip_stale_bbo_gap",
          l2Available: true,
          executableDepth: _pf.decision !== "skip_zero_depth" && _pf.decision !== "skip_zero_contracts",
        };
        capturePhase4BFinalDecision(
          phase4bBaseInput(side, limitPrice, _pf.decision, _pf.decision, {
            configuredLimitCents: _pf.verifiedLimitCents, bboDerivedLimitCents: limitPrice,
            quotedBboAskCents: _pfBboAsk, executableL2AskCents: _pf.executableBestAskCents,
            bboToL2GapCents: _pf.bboToL2GapCents, preflightLatencyMs: _pfBook.fetchLatencyMs,
          }),
          {
            finalDecisionClassification, finalOrderPathOutcome: _pf.decision, guardOutcomes: failedGuard,
            allOtherGuardsPassed: null, executableL2DepthContracts: _pf.depthAtLimitContracts,
            intendedContractCount: _pfIntendedContracts, intendedNotionalCents: _pfIntendedNotional,
            availableExposureDollars: Math.max(0, betDollars - (spendTracker.get(state.ticker) ?? 0)),
            estimatedFeesDollars: null,
          },
        );
        // ── Durable evaluation event (preflight gate rejected) ────────────────
        recordEvaluationEvent({
          ticker: state.ticker, series: wlSeries ?? "",
          timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
          yesBid: state.yesBid, yesAsk: state.yesAsk,
          noBid: state.noBid, noAsk: state.noAsk,
          yesDerivedAsk, noDerivedAsk,
          side, limitCents: limitPrice,
          outcome: "preflight_skip", preflightDecision: _pf.decision,
        });
        return;
      }

      // ── Durable evaluation event (order forwarded to placeOrder) ─────────────
      recordEvaluationEvent({
        ticker: state.ticker, series: wlSeries ?? "",
        timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
        yesBid: state.yesBid, yesAsk: state.yesAsk,
        noBid: state.noBid, noAsk: state.noAsk,
        yesDerivedAsk, noDerivedAsk,
        side, limitCents: _pf.verifiedLimitCents ?? limitPrice,
        // "forwarded" = the request was handed to placeOrder(); NOT a Kalshi confirmation.
      // placeOrder may still reject due to position limits, concurrency guards, or
      // a final L2 gate failure — check fill records to confirm actual acceptance.
      outcome: "forwarded", preflightDecision: null,
      });

      // ── All checks passed — submit at verified limit with depth-adjusted count
      await placeOrder(
        state.ticker, side, triggerCents, _pf.verifiedLimitCents!, betDollars,
        source, _pfBook, _pf.adjustedContracts, _timing,
      );
    });

    if (_lockResult.blocked) {
      logger.info(
        { ticker: state.ticker, side, source, lock: _lockResult.reason },
        "AutoTrader: pre-flight skipped — in-flight lock held for ticker",
      );
      if (wlSeries) wlSkip(wlSeries, state.ticker, "submission_in_flight");
      try { if (wlSeries) recordGuardOutcome(wlSeries, "submission_in_flight"); } catch {}
      recordEvaluationEvent({
        ticker: state.ticker, series: wlSeries ?? "",
        timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
        yesBid: state.yesBid, yesAsk: state.yesAsk,
        noBid: state.noBid, noAsk: state.noAsk,
        yesDerivedAsk, noDerivedAsk,
        side, limitCents: null,
        outcome: "preflight_skip", preflightDecision: "submission_in_flight",
      });
    }
  };

  /**
   * A derived signal uses an opposite-side bid while the dashboard displays the
   * direct-side BBO. Kalshi can publish these legs at different moments, so do
   * not elevate a mixed snapshot into an entry signal. Fresh L2 remains the
   * mandatory final execution authority after this signal-quality check.
   */
  const hasCoherentEntryQuote = (
    side: "yes" | "no",
    derivedAsk: number,
  ): boolean => {
    const directAsk = side === "yes" ? state.yesAsk : state.noAsk;
    if (isCoherentBboQuote(directAsk, derivedAsk)) return true;

    const gapCents = directAsk != null ? directAsk - derivedAsk : null;
    logger.info(
      {
        ticker: state.ticker,
        side,
        direct_side_ask_cents: directAsk,
        opposite_bid_derived_ask_cents: derivedAsk,
        direct_to_derived_gap_cents: gapCents,
        max_coherence_gap_cents: MAX_DIRECT_DERIVED_BBO_GAP_CENTS,
        seconds_left: secondsLeft,
        source,
        skip_reason: "incoherent_bbo_snapshot",
      },
      "AutoTrader: skipped entry — direct and derived BBO quotes describe an inconsistent snapshot",
    );
    if (wlSeries) wlSkip(wlSeries, state.ticker, "incoherent_bbo_snapshot");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "incoherent_bbo_snapshot"); } catch {}
    recordEvaluationEvent({
      ticker: state.ticker, series: wlSeries ?? "",
      timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
      yesBid: state.yesBid, yesAsk: state.yesAsk,
      noBid: state.noBid, noAsk: state.noAsk,
      yesDerivedAsk, noDerivedAsk,
      side, limitCents: null,
      outcome: "incoherent_bbo_snapshot", preflightDecision: null,
    });
    return false;
  };

  // YES block — trigger when derived YES ask (= 100 − NO bid) is in zone
  if (yesDerivedAsk != null && isEntryPriceInBandForSeries(wlSeries, yesDerivedAsk)) {
    if (!hasCoherentEntryQuote("yes", yesDerivedAsk)) return;
    // ── Wide-spread guard (YES side) ──────────────────────────────────────
    // Skip when the BBO bid–ask spread on the YES side exceeds MAX_SPREAD_CENTS.
    // A spread wider than 1¢ (≥ 2¢) is a knife-fall warning: market makers
    // stepping back before the L2 checks fire.  Checked at signal time.
    const yesSpread = (state.yesAsk != null && state.yesBid != null)
      ? state.yesAsk - state.yesBid : null;
    if (yesSpread != null && yesSpread > MAX_SPREAD_CENTS) {
      logger.info(
        {
          ticker:           state.ticker,
          side:             "yes",
          yes_bid:          state.yesBid,
          yes_ask:          state.yesAsk,
          spread_cents:     yesSpread,
          max_spread_cents: MAX_SPREAD_CENTS,
          derived_ask:      yesDerivedAsk,
          seconds_left:     secondsLeft,
          source,
          skip_reason:      "wide_spread",
        },
        "AutoTrader: wide-spread guard blocked YES entry — bid-ask spread exceeds threshold",
      );
      if (wlSeries) wlSkip(wlSeries, state.ticker, "wide_spread");
      try { if (wlSeries) recordGuardOutcome(wlSeries, "wide_spread"); } catch {}
      recordEvaluationEvent({
        ticker: state.ticker, series: wlSeries ?? "",
        timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
        yesBid: state.yesBid, yesAsk: state.yesAsk,
        noBid: state.noBid, noAsk: state.noAsk,
        yesDerivedAsk, noDerivedAsk,
        side: "yes", limitCents: null,
        outcome: "wide_spread", preflightDecision: null,
      });
      capturePhase4BFinalDecision(
        phase4bBaseInput("yes", yesDerivedAsk, "wide_spread", "wide_spread"),
        {
          finalDecisionClassification: "rejected_wide_spread",
          finalOrderPathOutcome: "wide_spread",
          guardOutcomes: {
            ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, wideSpread: false,
          },
          allOtherGuardsPassed: null,
        },
      );
    } else {
      const limitPrice = Math.min(
        yesDerivedAsk + LIMIT_PRICE_BUFFER_CENTS,
        SERIES_ENTRY_POLICY[wlSeries].entryCapCents,
        ALERT_MAX,
        99,
      );
      await checkAndPlace("yes", yesDerivedAsk, limitPrice);
    }
  }

  // NO block — trigger when derived NO ask (= 100 − YES bid) is in zone
  if (noDerivedAsk != null && isEntryPriceInBandForSeries(wlSeries, noDerivedAsk)) {
    if (!hasCoherentEntryQuote("no", noDerivedAsk)) return;
    // ── Wide-spread guard (NO side) ───────────────────────────────────────
    // Skip when the BBO bid–ask spread on the NO side exceeds MAX_SPREAD_CENTS.
    const noSpread = (state.noAsk != null && state.noBid != null)
      ? state.noAsk - state.noBid : null;
    if (noSpread != null && noSpread > MAX_SPREAD_CENTS) {
      logger.info(
        {
          ticker:           state.ticker,
          side:             "no",
          no_bid:           state.noBid,
          no_ask:           state.noAsk,
          spread_cents:     noSpread,
          max_spread_cents: MAX_SPREAD_CENTS,
          derived_ask:      noDerivedAsk,
          seconds_left:     secondsLeft,
          source,
          skip_reason:      "wide_spread",
        },
        "AutoTrader: wide-spread guard blocked NO entry — bid-ask spread exceeds threshold",
      );
      if (wlSeries) wlSkip(wlSeries, state.ticker, "wide_spread");
      try { if (wlSeries) recordGuardOutcome(wlSeries, "wide_spread"); } catch {}
      recordEvaluationEvent({
        ticker: state.ticker, series: wlSeries ?? "",
        timestampMs: Date.now(), secondsLeft: secondsLeft ?? 0, source,
        yesBid: state.yesBid, yesAsk: state.yesAsk,
        noBid: state.noBid, noAsk: state.noAsk,
        yesDerivedAsk, noDerivedAsk,
        side: "no", limitCents: null,
        outcome: "wide_spread", preflightDecision: null,
      });
      capturePhase4BFinalDecision(
        phase4bBaseInput("no", noDerivedAsk, "wide_spread", "wide_spread"),
        {
          finalDecisionClassification: "rejected_wide_spread",
          finalOrderPathOutcome: "wide_spread",
          guardOutcomes: {
            ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, wideSpread: false,
          },
          allOtherGuardsPassed: null,
        },
      );
    } else {
      const limitPrice = Math.min(
        noDerivedAsk + LIMIT_PRICE_BUFFER_CENTS,
        SERIES_ENTRY_POLICY[wlSeries].entryCapCents,
        ALERT_MAX,
        99,
      );
      await checkAndPlace("no", noDerivedAsk, limitPrice);
    }
  }
}

/** Candidate-only half of ETH evaluation. It retains the established
 * observation and explicitly-permitted executor, while avoiding main ETH
 * martingale evaluation for candidate settlement handoffs. */
async function evaluateEth420Candidate(state: MarketState, timing: EvalTiming): Promise<void> {
  const candidateOpenTimeMs = state.openTime == null ? null : Date.parse(state.openTime);
  const candidateMarket = {
    ticker: state.ticker,
    easternDate: candidateOpenTimeMs != null && Number.isFinite(candidateOpenTimeMs)
      ? easternDay(new Date(candidateOpenTimeMs)) : easternDay(new Date()),
    observedAtMs: Date.now(), floorStrike: state.floorStrike ?? null, openTimeMs: candidateOpenTimeMs,
  };
  observeEth420Candidate(tradeStore, candidateMarket)
    .catch((err) => logger.warn({ err, ticker: state.ticker }, "ETH 420 candidate observation failed"));
  if (isEth420CandidateExecutionPermitted() || timing.boundaryOpenTimeMs != null) {
    await evaluateAndSubmitEth420CandidateWhenExplicitlyEnabled(
      tradeStore,
      {
        ticker: state.ticker, exchangeIndex: state.exchangeIndex ?? null, openTime: state.openTime,
        closeTime: state.closeTime, status: state.status, yesBid: state.yesBid, noBid: state.noBid,
      },
      candidateMarket,
      timing.boundaryOpenTimeMs == null ? undefined : (stage, reason) => {
        recordBoundaryDiscoveryAudit({
          ticker: state.ticker, openTimeMs: timing.boundaryOpenTimeMs!, atMs: Date.now(), stage, reason,
        });
      },
    );
  }
}

/** A fresh candidate-only handoff: it updates the shared market snapshot but
 * never invokes the main ETH evaluator or its reconciliation path. */
async function restFetchEth420CandidateAfterSettlement(): Promise<void> {
  const fetchStartMs = Date.now();
  try {
    const raw = await (_kalshiSeriesFetchImpl
      ? _kalshiSeriesFetchImpl("KXETH15M", { forceFresh: true })
      : kalshiSeriesFetch("KXETH15M", { forceFresh: true }));
    if (!raw) return;
    const normalized = normalizeMarket(raw);
    if (typeof normalized["ticker"] !== "string") return;
    const ticker = normalized["ticker"];
    const state = mergeState(normalized, fetchStartMs, (lastWsTickMs.get(ticker) ?? 0) < fetchStartMs, true);
    await evaluateEth420Candidate(state, { tickReceivedMs: fetchStartMs, evalStartMs: Date.now() });
  } catch (err) {
    logger.warn({ err }, "AutoTrader: ETH 420 candidate settlement handoff fetch failed");
  }
}

// ── Fill price parser ─────────────────────────────────────────────────────────

interface FillActuals {
  contracts:   number;  // sum of contract counts across all fills
  dollarsCost: number;  // sum of (fill_count × outcome-side price) — what was actually paid
  feeDollars:  number;  // sum of fee_cost across fills
  pricesKnown: boolean; // false when fill price fields were absent — fell back to limit price
}

export type { FillActuals };

/**
 * Extracts the true economic cost from Kalshi fill records returned with the
 * order POST response.
 *
 * Kalshi returns per-fill `yes_price_dollars` and `no_price_dollars` alongside
 * the raw YES-leg `price` field. We use the outcome-side-specific dollar field
 * first (most precise), then fall back to deriving from the YES-leg price if
 * those fields are absent.
 *
 * Falls back to (limit price × fillCount) with pricesKnown=false when no
 * fill records are present — this is conservative (limit ≥ actual) and will
 * never undercount spend.
 */
function parseFillActuals(
  fills:                     Array<Record<string, unknown>>,
  side:                      "yes" | "no",
  fallbackOutcomePriceCents: number,
  fallbackFillCount:         number,
): FillActuals {
  if (fills.length === 0) {
    return {
      contracts:   fallbackFillCount,
      dollarsCost: (fallbackFillCount * fallbackOutcomePriceCents) / 100,
      feeDollars:  0,
      pricesKnown: false,
    };
  }

  let contracts   = 0;
  let dollarsCost = 0;
  let feeDollars  = 0;
  let pricesKnown = true;

  for (const fill of fills) {
    const count = parseFloat(String(fill["count_fp"] ?? fill["count"] ?? "0")) || 0;
    if (count === 0) continue;

    // Prefer the outcome-side-specific price field. Fall back to deriving
    // from the raw YES-leg `price` (always present, always YES-side).
    let outcomePriceDollars: number;
    if (side === "yes") {
      const yp = parseFloat(String(fill["yes_price_dollars"] ?? fill["yes_price"] ?? ""));
      const p  = parseFloat(String(fill["price"] ?? ""));
      outcomePriceDollars = !isNaN(yp) ? yp : !isNaN(p) ? p : NaN;
    } else {
      const np = parseFloat(String(fill["no_price_dollars"] ?? fill["no_price"] ?? ""));
      const p  = parseFloat(String(fill["price"] ?? ""));
      // Raw `price` is always YES-leg; complement converts to NO cost
      outcomePriceDollars = !isNaN(np) ? np : !isNaN(p) ? 1 - p : NaN;
    }

    if (isNaN(outcomePriceDollars)) {
      // Price unavailable for this fill — use limit price, flag degraded
      outcomePriceDollars = fallbackOutcomePriceCents / 100;
      pricesKnown = false;
    }

    const fee = parseFloat(String(fill["fee_cost"] ?? fill["fee"] ?? "0")) || 0;

    contracts   += count;
    dollarsCost += count * outcomePriceDollars;
    feeDollars  += fee;
  }

  return { contracts, dollarsCost, feeDollars, pricesKnown };
}

/** Exposed for unit testing only — not part of the production API. */
export function _parseFillActualsForTesting(
  fills:                     Array<Record<string, unknown>>,
  side:                      "yes" | "no",
  fallbackOutcomePriceCents: number,
  fallbackFillCount:         number,
): FillActuals {
  return parseFillActuals(fills, side, fallbackOutcomePriceCents, fallbackFillCount);
}

// ── Order placement ───────────────────────────────────────────────────────────

/** Kept as a function so TypeScript continues checking the retained historical
 * path; its runtime value is the unconditional single-strategy cutoff. */
function isLegacyEntryExecutionDisabled(): boolean {
  return true;
}

async function placeOrder(
  ticker:            string,
  side:              "yes" | "no",
  triggerBidCents:   number,
  outcomePriceCents: number,
  betDollars:        number,
  source:            TriggerSource,
  /** Pre-fetched L2 snapshot from checkAndPlace's pre-flight check. When
   *  provided the concurrent fetch is skipped — the snapshot was taken
   *  moments ago and already confirmed to have executable depth. */
  preflightSnapshot?: OrderbookSnapshot,
  /**
   * Hard cap on the contract count produced by contractsForPrice().
   * Set by the pre-flight check to the verified executable depth so the
   * order never requests more contracts than the book can fill.
   * Undefined = no cap (legacy callers, tests).
   */
  maxContracts?: number,
  /** Per-evaluation ms timeline (tick receipt → eval → L2). POST/ack stamps
   *  are added here and the full timeline is persisted after the Kalshi ack. */
  timing?: EvalTiming,
): Promise<void> {
  // Final legacy-entry fence. No code path using the historical evaluator may
  // proceed to reservation or POST; the dedicated ETH martingale has its own
  // independently guarded submission lifecycle.
  if (isLegacyEntryExecutionDisabled()) {
    logger.warn({ ticker, side, source }, "AutoTrader: legacy entry blocked by ETH-only mode");
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — legacy entry blocked by ETH-only mode",
      { ticker, side, source, outcome: "legacy_eth_only_fence" });
    return;
  }
  // ── Attempt telemetry ─────────────────────────────────────────────────────
  // Logged first — before any guard — so every placeOrder call has a log
  // entry even if the hard price guard or another early check blocks it.
  // clientOrderId is generated here so it correlates ALL log lines for this
  // attempt (entry, SQL, Kalshi POST, fill/error) regardless of where the
  // attempt terminates.
  const _t0   = Date.now();
  const _pid  = process.pid;
  const _cmt  = (process.env.COMMIT_SHA ?? process.env.REPL_COMMIT ?? "dev").slice(0, 8);
  const clientOrderId = randomUUID();
  const _entryFields = {
    ticker, side, source,
    outcome_price_cents: outcomePriceCents,
    client_order_id:     clientOrderId,
    pid:                 _pid,
    commit:              _cmt,
  };
  // Entry-only: deliberately before the final Kalshi POST and never shared with exits.
  const dailyProfitGuard = await allowNewInvestment(ticker);
  if (!dailyProfitGuard.allowed) {
    logger.warn({ ..._entryFields, dailyProfitStop: dailyProfitGuard.status, reason: "DAILY_PROFIT_STOP" },
      "AutoTrader: placeOrder blocked by DAILY_PROFIT_STOP");
    return;
  }
  logger.info(_entryFields, "AutoTrader: placeOrder entered");
  _placeOrderLogSink?.("AutoTrader: placeOrder entered", _entryFields);

  const key      = `${ticker}-${side.toUpperCase()}`;
  const wlSeries = seriesForTicker(ticker); // resolved once; used for all wlSkip/wlTrade calls
  const capturePhase4BPlaceOrderFinalDecision = (
    finalDecisionClassification: Phase4BFinalDecisionClassification,
    finalOrderPathOutcome: string,
    guardOutcomes: Phase4BGuardOutcomes,
    allOtherGuardsPassed: boolean | null,
    extra: Partial<Pick<Phase4BFinalDecisionFields,
      "intendedContractCount" | "intendedNotionalCents" | "availableExposureDollars" | "estimatedFeesDollars" | "executableL2DepthContracts" | "kalshiOrderId">> = {},
  ): void => {
    const state = marketState.get(ticker);
    if (!state?.closeTime) return;
    const now = Date.now();
    const lastWs = lastWsTickMs.get(ticker) ?? 0;
    capturePhase4BFinalDecision(
      {
        timestampMs: now, ticker, series: wlSeries ?? "", closeTime: state.closeTime,
        openTime: state.openTime ?? null, secondsLeft: secondsUntil(state.closeTime) ?? 0, side, source,
        wsConnected: kalshiStream.isConnected(), wsStale: now - lastWs >= STALE_WS_MS,
        lastWsMessageAgeMs: now - lastWs, bboAgeMs: now - state.bidUpdatedMs,
        yesBid: state.yesBid, yesAsk: state.yesAsk, noBid: state.noBid, noAsk: state.noAsk,
        displayedEntryPriceCents: outcomePriceCents, configuredLimitCents: null,
        bboDerivedLimitCents: null, strategyVersion: null, betDollars,
        priceFloorCents: PRICE_FLOOR_CENTS, priceCapCents: PRICE_CAP_CENTS,
        limitBufferCents: LIMIT_PRICE_BUFFER_CENTS, staleGapThresholdCents: MAX_BBO_L2_NEGATIVE_GAP_CENTS,
        decisionClassification: finalOrderPathOutcome, skipReason: finalOrderPathOutcome,
        quotedBboAskCents: null, executableL2AskCents: null, bboToL2GapCents: null,
        preflightLatencyMs: null,
      },
      {
        finalDecisionClassification, finalOrderPathOutcome, guardOutcomes,
        allOtherGuardsPassed: allOtherGuardsPassed ?? allEvaluatedNonPriceGuardsPassed(guardOutcomes),
        clientOrderId, ...extra,
      },
    );
  };

  /**
   * Fire-and-forget evaluation event for every placeOrder no-submit path.
   * Reads current BBO from marketState so the event reflects live conditions
   * even when the outer evaluate() closure's derived-ask locals are out of scope.
   */
  const recordPORejected = (reason: string): void => {
    try {
      const _st = marketState.get(ticker);
      recordEvaluationEvent({
        ticker, series: wlSeries ?? "",
        timestampMs: Date.now(),
        secondsLeft: _st?.closeTime != null ? (secondsUntil(_st.closeTime) ?? 0) : 0,
        source,
        yesBid: _st?.yesBid ?? null, yesAsk: _st?.yesAsk ?? null,
        noBid: _st?.noBid ?? null, noAsk: _st?.noAsk ?? null,
        yesDerivedAsk: _st?.noBid != null ? 100 - _st.noBid : null,
        noDerivedAsk:  _st?.yesBid != null ? 100 - _st.yesBid : null,
        side, limitCents: outcomePriceCents,
        outcome: "place_order_rejected", preflightDecision: reason,
      });
    } catch { /* never interrupt trading path */ }
  };

  /**
   * Fire-and-forget evaluation event for post-POST failure paths.
   * `exchange_rejected` = Kalshi definitively rejected (HTTP 4xx or rejectReason in 2xx).
   * `post_unknown`      = POST was sent but outcome is uncertain (network / timeout).
   * `reason` carries the HTTP status code (e.g. "http_422") or the rejectReason string.
   */
  const recordPostFailed = (
    outcome: "exchange_rejected" | "post_unknown",
    reason:  string,
  ): void => {
    try {
      const _st = marketState.get(ticker);
      recordEvaluationEvent({
        ticker, series: wlSeries ?? "",
        timestampMs: Date.now(),
        secondsLeft: _st?.closeTime != null ? (secondsUntil(_st.closeTime) ?? 0) : 0,
        source,
        yesBid: _st?.yesBid ?? null, yesAsk: _st?.yesAsk ?? null,
        noBid: _st?.noBid ?? null, noAsk: _st?.noAsk ?? null,
        yesDerivedAsk: _st?.noBid != null ? 100 - _st.noBid : null,
        noDerivedAsk:  _st?.yesBid != null ? 100 - _st.yesBid : null,
        side, limitCents: outcomePriceCents,
        outcome, preflightDecision: reason,
      });
    } catch { /* never interrupt trading path */ }
  };

  // ── HARD PRICE GUARD ─────────────────────────────────────────────────────
  //
  // This is the FIRST check, before any state is claimed (cooldown, dedup,
  // notional). An order outside 70–95 ¢ (outcome-side) is never submitted.
  //
  // For YES orders: outcomePriceCents IS the YES purchase price.
  // For NO orders:  outcomePriceCents IS the NO purchase price — it is NOT
  //                 the complementary YES price. The YES-leg translation
  //                 (100 − outcomePriceCents) happens later, only for the
  //                 Kalshi API body. Never apply that conversion here.
  if (!isEntryPriceInBandForSeries(wlSeries ?? "", outcomePriceCents)) {
    logger.error(
      {
        ticker,
        side,
        outcome_price_cents: outcomePriceCents,
        floor_cents:         PRICE_FLOOR_CENTS,
        cap_cents:           PRICE_CAP_CENTS,
        client_order_id:     clientOrderId,
        elapsed_ms:          Date.now() - _t0,
        pid:                 _pid,
        commit:              _cmt,
        source,
      },
       "AutoTrader: HARD PRICE GUARD blocked order — outcome price outside allowed series entry band",
    );
    if (wlSeries) wlSkip(wlSeries, ticker, "price_band_guard");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "price_band_guard"); } catch {}
    capturePhase4BPlaceOrderFinalDecision(
      outcomePriceCents < PRICE_FLOOR_CENTS ? "rejected_price_floor" : "rejected_price_cap",
      outcomePriceCents < PRICE_FLOOR_CENTS ? "price_below_floor" : "price_above_cap",
      {
        ...unevaluatedPhase4BGuards(),
        priceFloor: outcomePriceCents < PRICE_FLOOR_CENTS ? false : true,
        priceCap: outcomePriceCents > PRICE_CAP_CENTS ? false : true,
      },
      null,
    );
    recordPORejected("price_band_guard");
    return;
  }

  // ── Cooldown guard (prevents rapid-tick duplicate submissions) ────────────
  const lastAttempt = orderCooldown.get(key) ?? 0;
  if (Date.now() - lastAttempt < ORDER_COOLDOWN_MS) {
    logger.info(
      {
        ticker, side,
        client_order_id: clientOrderId,
        outcome:         "cooldown",
        cooldown_ms:     ORDER_COOLDOWN_MS,
        elapsed_ms:      Date.now() - _t0,
        pid:             _pid,
        commit:          _cmt,
        source,
      },
      "AutoTrader: placeOrder exit — cooldown",
    );
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — cooldown", { ticker, side, client_order_id: clientOrderId, outcome: "cooldown", source });
    if (wlSeries) wlSkip(wlSeries, ticker, "cooldown");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "cooldown"); } catch {}
    capturePhase4BPlaceOrderFinalDecision(
      "rejected_other",
      "cooldown",
      { ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true },
      null,
    );
    recordPORejected("cooldown");
    return;
  }
  orderCooldown.set(key, Date.now());

  // ── Spend tracker — shared per ticker window (YES + NO combined) ──────────
  // Counts both already-filled dollars AND in-flight pending notional so that
  // concurrent evaluate() calls (or a partial-fill retry) cannot overshoot the
  // per-window budget while the first API response is still in transit.
  const spendKey              = ticker; // intentionally excludes side: $100 total per window
  const alreadySpentDollars   = spendTracker.get(spendKey) ?? 0;
  const pendingCents          = pendingNotionalByTicker.get(ticker) ?? 0;
  const totalCommittedDollars = alreadySpentDollars + pendingCents / 100;
  const remainingDollars      = betDollars - totalCommittedDollars;
  if (remainingDollars <= 0) {
    logger.info(
      {
        ticker, side,
        client_order_id:         clientOrderId,
        outcome:                 "window_budget",
        already_spent_dollars:   alreadySpentDollars,
        pending_notional_cents:  pendingCents,
        total_committed_dollars: totalCommittedDollars,
        bet_dollars:             betDollars,
        elapsed_ms:              Date.now() - _t0,
        pid:                     _pid,
        commit:                  _cmt,
        source,
      },
      "AutoTrader: placeOrder exit — window budget exhausted",
    );
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — window budget exhausted", { ticker, side, client_order_id: clientOrderId, outcome: "window_budget", source });
    if (wlSeries) wlSkip(wlSeries, ticker, "window_budget");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "window_budget"); } catch {}
    capturePhase4BPlaceOrderFinalDecision(
      "rejected_budget",
      "window_budget",
      { ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: false },
      true,
      { availableExposureDollars: remainingDollars },
    );
    recordPORejected("window_budget");
    return;
  }

  const rawCount = contractsForPrice(outcomePriceCents, remainingDollars);
  // Apply pre-flight depth cap when provided so we never request more
  // contracts than the L2 book confirmed as executable.
  const count    = maxContracts != null ? Math.min(rawCount, maxContracts) : rawCount;
  if (count === 0) {
    logger.info(
      {
        ticker, side,
        client_order_id:        clientOrderId,
        outcome:                "zero_contracts",
        outcome_price_cents:    outcomePriceCents,
        remaining_dollars:      remainingDollars,
        raw_count:              rawCount,
        max_contracts_cap:      maxContracts ?? null,
        elapsed_ms:             Date.now() - _t0,
        pid:                    _pid,
        commit:                 _cmt,
        source,
      },
      "AutoTrader: placeOrder exit — zero contracts after sizing",
    );
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — zero contracts after sizing", { ticker, side, client_order_id: clientOrderId, outcome: "zero_contracts", source });
    if (wlSeries) wlSkip(wlSeries, ticker, "zero_contracts");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "zero_contracts"); } catch {}
    capturePhase4BPlaceOrderFinalDecision(
      "rejected_other",
      "zero_contracts",
      { ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true },
      null,
      {
        intendedContractCount: count,
        intendedNotionalCents: count * outcomePriceCents,
        availableExposureDollars: remainingDollars,
      },
    );
    recordPORejected("zero_contracts");
    return;
  }

  // ── Kill switch ───────────────────────────────────────────────────────────
  if ((_isTradingHaltedImpl ?? isTradingHalted)()) {
    const _haltedFields = {
      ticker, side,
      client_order_id: clientOrderId,
      outcome:         "halted",
      elapsed_ms:      Date.now() - _t0,
      pid:             _pid,
      commit:          _cmt,
      source,
    };
    logger.warn(_haltedFields, "AutoTrader: placeOrder exit — trading halted");
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — trading halted", _haltedFields);
    if (wlSeries) wlSkip(wlSeries, ticker, "halted");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "halted"); } catch {}
    capturePhase4BPlaceOrderFinalDecision("rejected_halted", "halted", {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, halted: false,
    }, null, { intendedContractCount: count, intendedNotionalCents: count * outcomePriceCents, availableExposureDollars: remainingDollars });
    recordPORejected("halted");
    return;
  }

  const notionalCents = count * outcomePriceCents;

  // ── Hard budget overrun guard ─────────────────────────────────────────────
  // Recompute contracts × limit price from the locked snapshot values and
  // abort if the total would exceed the configured per-series dollar budget.
  // This is a final safety net against any scenario where the BBO changes
  // between evaluation and submission, causing the sizing formula to produce
  // a count that overspends the budget (e.g. low YES price → large NO contract
  // count computed from an earlier BBO tick but submitted at a later price).
  const submittedCostDollars = notionalCents / 100;
  if (submittedCostDollars > betDollars) {
    logger.error(
      {
        ticker,
        side,
        client_order_id:         clientOrderId,
        outcome:                 "budget_overrun",
        budget_dollars:          betDollars,
        contracts:               count,
        limit_price_cents:       outcomePriceCents,
        calculated_cost_dollars: submittedCostDollars,
        overage_dollars:         +(submittedCostDollars - betDollars).toFixed(4),
        elapsed_ms:              Date.now() - _t0,
        pid:                     _pid,
        commit:                  _cmt,
        source,
      },
      "AutoTrader: order_blocked_budget_overrun — cost exceeds per-series budget",
    );
    if (wlSeries) wlSkip(wlSeries, ticker, "window_budget");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "window_budget"); } catch {}
    capturePhase4BPlaceOrderFinalDecision("rejected_budget", "budget_overrun", {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: false,
    }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
    recordPORejected("budget_overrun");
    return;
  }

  // ── Dedup slot ────────────────────────────────────────────────────────────
  if (!((_claimOrderSlotImpl ?? claimOrderSlot)(ticker, side))) {
    logger.info(
      {
        ticker, side,
        client_order_id: clientOrderId,
        outcome:         "dedup",
        elapsed_ms:      Date.now() - _t0,
        pid:             _pid,
        commit:          _cmt,
        source,
      },
      "AutoTrader: placeOrder exit — dedup slot already claimed",
    );
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — dedup slot already claimed", { ticker, side, client_order_id: clientOrderId, outcome: "dedup", source });
    if (wlSeries) wlSkip(wlSeries, ticker, "dedup");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "dedup"); } catch {}
    capturePhase4BPlaceOrderFinalDecision("rejected_dedup", "dedup", {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: false,
    }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
    recordPORejected("dedup");
    return;
  }

  // ── Daily notional cap ────────────────────────────────────────────────────
  if (!reserveNotional(notionalCents)) {
    releaseOrderSlot(ticker, side);
    logger.warn(
      {
        ticker, side,
        client_order_id: clientOrderId,
        outcome:         "daily_cap",
        notional_cents:  notionalCents,
        elapsed_ms:      Date.now() - _t0,
        pid:             _pid,
        commit:          _cmt,
        source,
      },
      "AutoTrader: placeOrder exit — daily cap reached",
    );
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — daily cap reached", { ticker, side, client_order_id: clientOrderId, outcome: "daily_cap", source });
    if (wlSeries) wlSkip(wlSeries, ticker, "daily_cap");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "daily_cap"); } catch {}
    capturePhase4BPlaceOrderFinalDecision("rejected_budget", "daily_cap", {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: false, dedup: true,
    }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
    recordPORejected("daily_cap");
    return;
  }

  const unwind = () => {
    releaseOrderSlot(ticker, side);
    releaseNotional(notionalCents);
  };

  // ── Position guard ────────────────────────────────────────────────────────
  let signedPosition = 0;
  try {
    signedPosition = await (_getSignedPositionImpl ?? getSignedPosition)(ticker);
    const wouldReduce =
      (side === "no" && signedPosition > 0) || (side === "yes" && signedPosition < 0);
    if (wouldReduce) {
      void tradeStore.recordSubmissionAudit(clientOrderId, {
        stage: "timing_guard",
        reason: "seconds_to_expiry_outside_allowed_window",
        recordedAtMs: Date.now(),
        postInitiated: false,
        responseReceived: false,
      });
      unwind();
      logger.warn(
        {
          ticker, side,
          client_order_id: clientOrderId,
          outcome:         "position_guard",
          signed_position: signedPosition,
          elapsed_ms:      Date.now() - _t0,
          pid:             _pid,
          commit:          _cmt,
          source,
        },
        "AutoTrader: placeOrder exit — position guard blocked order",
      );
      _placeOrderLogSink?.("AutoTrader: placeOrder exit — position guard blocked order", { ticker, side, client_order_id: clientOrderId, outcome: "position_guard", source });
      if (wlSeries) wlSkip(wlSeries, ticker, "position_guard");
      try { if (wlSeries) recordGuardOutcome(wlSeries, "position_guard"); } catch {}
      capturePhase4BPlaceOrderFinalDecision("rejected_position", "position_guard", {
        ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: false,
      }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
      recordPORejected("position_guard");
      return;
    }
  } catch (err) {
    void tradeStore.recordSubmissionAudit(clientOrderId, {
      stage: "workspace_guard",
      reason: "workspace_environment",
      recordedAtMs: Date.now(),
      postInitiated: false,
      responseReceived: false,
    });
    unwind();
    logger.error(
      {
        err,
        ticker, side,
        client_order_id: clientOrderId,
        outcome:         "position_error",
        elapsed_ms:      Date.now() - _t0,
        pid:             _pid,
        commit:          _cmt,
        source,
      },
      "AutoTrader: placeOrder exit — position check failed, order not submitted",
    );
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — position check failed, order not submitted", { ticker, side, client_order_id: clientOrderId, outcome: "position_error", source });
    if (wlSeries) wlSkip(wlSeries, ticker, "position_error");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "position_error"); } catch {}
    capturePhase4BPlaceOrderFinalDecision("rejected_position", "position_error", {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: false,
    }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
    recordPORejected("position_error");
    return;
  }

  // ── Per-ticker in-flight lock ─────────────────────────────────────────────
  // Prevents two concurrent Kalshi API calls for the same ticker (from near-
  // simultaneous WS ticks) from racing each other. The dedup slot covers the
  // 20-minute window perspective; this lock covers the ~100–500 ms round-trip.
  if (submissionInFlight.has(ticker)) {
    unwind();
    logger.warn(
      {
        ticker, side,
        client_order_id: clientOrderId,
        outcome:         "submission_in_flight",
        elapsed_ms:      Date.now() - _t0,
        pid:             _pid,
        commit:          _cmt,
        source,
      },
      "AutoTrader: placeOrder exit — concurrent submission in-flight for ticker",
    );
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — concurrent submission in-flight for ticker", { ticker, side, client_order_id: clientOrderId, outcome: "submission_in_flight", source });
    if (wlSeries) wlSkip(wlSeries, ticker, "submission_in_flight");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "submission_in_flight"); } catch {}
    capturePhase4BPlaceOrderFinalDecision("rejected_dedup", "submission_in_flight", {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: false, position: true,
    }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
    recordPORejected("submission_in_flight");
    return;
  }

  // ── Analytics: record order attempt just before submitting ────────────────
  const t0           = Date.now();
  const _analyticsId = (() => {
    try {
      return recordOrderAttempt({
        ticker, series: wlSeries ?? "",
        windowCloseTime: marketState.get(ticker)?.closeTime ?? null,
        side, source, triggerPriceCents: triggerBidCents,
        limitPriceCents: outcomePriceCents, requestedContracts: count,
        clientOrderId,
      });
    } catch { return ""; }
  })();

  // ── SQL pre-commit ─────────────────────────────────────────────────────────
  // Must be awaited BEFORE the Kalshi API call. If the write fails (SQL
  // unavailable) the order is aborted — no order reaches Kalshi without a
  // corresponding SQL record, preventing unrecorded live positions.
  const _sqlT0 = Date.now();
  logger.info(
    {
      ticker, side, client_order_id: clientOrderId,
      elapsed_ms: _sqlT0 - _t0,
    },
    "AutoTrader: SQL pre-commit starting",
  );
  let _sqlReserve: Awaited<ReturnType<typeof tradeStore.reserveAndRecord>>;
  try {
    _sqlReserve = await (_reserveAndRecordImpl ?? tradeStore.reserveAndRecord)({
      clientOrderId:          clientOrderId,
      ticker,
      series:                 wlSeries ?? "",
      windowCloseTime:        marketState.get(ticker)?.closeTime ?? null,
      side,
      source:                 String(source),
      triggerPriceCents:      triggerBidCents,
      limitPriceCents:        outcomePriceCents,
      requestedContracts:     count,
      requestedNotionalCents: notionalCents,
      easternDate:            easternDay(new Date()),
    });
  } catch (sqlErr: unknown) {
    unwind();
    logger.error(
      {
        err:             sqlErr,
        ticker, side,   client_order_id: clientOrderId,
        sql_elapsed_ms:  Date.now() - _sqlT0,
        total_elapsed_ms: Date.now() - _t0,
        pid:             _pid, commit: _cmt,
      },
      "AutoTrader: SQL pre-commit threw — order not submitted",
    );
    if (wlSeries) wlSkip(wlSeries, ticker, "sql_error");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "sql_reserve_failed"); } catch {}
    recordPORejected("sql_error");
    return;
  }
  if (!_sqlReserve.claimed) {
    unwind();
    logger.warn(
      {
        ticker, side, reason: _sqlReserve.reason, source,
        client_order_id: clientOrderId,
        sql_elapsed_ms:  Date.now() - _sqlT0,
        total_elapsed_ms: Date.now() - _t0,
      },
      `AutoTrader: SQL pre-commit rejected — ${_sqlReserve.reason ?? "error"} — order not submitted`,
    );
    if (wlSeries) wlSkip(wlSeries, ticker, `sql_${_sqlReserve.reason ?? "error"}`);
    try { if (wlSeries) recordGuardOutcome(wlSeries, "sql_reserve_failed"); } catch {}
    recordPORejected(_sqlReserve.reason != null ? `sql_${_sqlReserve.reason}` : "sql_reserve_failed");
    return;
  }
  logger.info(
    {
      ticker, side, client_order_id: clientOrderId,
      sql_elapsed_ms:  Date.now() - _sqlT0,
      total_elapsed_ms: Date.now() - _t0,
    },
    "AutoTrader: SQL pre-commit succeeded",
  );

  // ── Mark in-flight ────────────────────────────────────────────────────────
  submissionInFlight.add(ticker);
  // Register clientOrderId so the SIGTERM handler can log it for post-incident
  // SQL reconciliation of order_attempts rows left in "pending" state.
  submissionOrderIds.set(ticker, clientOrderId);
  pendingNotionalByTicker.set(
    ticker,
    (pendingNotionalByTicker.get(ticker) ?? 0) + notionalCents,
  );
  const releaseSubmissionState = () => {
    submissionInFlight.delete(ticker);
    submissionOrderIds.delete(ticker);
    const previousPending = pendingNotionalByTicker.get(ticker) ?? 0;
    const nextPending = previousPending - notionalCents;
    if (nextPending <= 0) pendingNotionalByTicker.delete(ticker);
    else pendingNotionalByTicker.set(ticker, nextPending);
  };

  // ── Hard workspace guard ──────────────────────────────────────────────────
  // Defense-in-depth: refuse the Kalshi HTTP call while the workspace lock is
  // active. isTradingHalted() should have already blocked earlier in
  // checkAndPlace(), but this guard ensures no live order reaches Kalshi even
  // if the halt-check code path has a bug. The workspace is locked by default;
  // an explicit WORKSPACE_TRADING_ENABLED=true owner override is required.
  // _isWorkspaceEnvironmentImpl is only set by integration tests that also inject
  // _kalshiAuthFetchImpl.
  if (_isWorkspaceEnvironmentImpl ? _isWorkspaceEnvironmentImpl() : envWorkspaceHaltActive()) {
    const _wsFields = {
      ticker, side,
      client_order_id: clientOrderId,
      outcome:         "workspace_guard",
      elapsed_ms:      Date.now() - _t0,
      pid:             _pid,
      commit:          _cmt,
      source,
    };
    logger.error(_wsFields, "AutoTrader: placeOrder exit — workspace environment, refusing live Kalshi submission");
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — workspace environment, refusing live Kalshi submission", _wsFields);
    unwind();
    // Release locks that were set before this guard (submissionInFlight was
    // added two lines above; the try/finally below is not entered on this path).
    releaseSubmissionState();
    capturePhase4BPlaceOrderFinalDecision("rejected_halted", "workspace_guard", {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: true, halted: false,
    }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
    recordPORejected("workspace_guard");
    return;
  }

  // ── Fail-closed timing guard ──────────────────────────────────────────────
  // Re-check secondsToExpiry at POST time using a live clock.
  //
  // The evaluate() gate checked this at trigger time; async operations between
  // evaluate() and here (L2 preflight fetch, SQL pre-commit, dedup, position
  // guard) consume real time.  A prior production deployment ran with a larger
  // TIME_ALERT_SECONDS value; orders from that period appear at 121–173 s in
  // the order_attempts table.  This guard is the single authoritative rejection
  // point and is checked regardless of trigger source (websocket or REST).
  //
  // Invariant enforced: 0 <= secondsToExpiry && secondsToExpiry <= TIME_ALERT_SECONDS
  // Violation → log error, unwind all locks, return without posting.
  {
    const _fgCloseTime     = marketState.get(ticker)?.closeTime ?? null;
    const _fgSecsToExpiry  = _fgCloseTime != null ? secondsUntil(_fgCloseTime) : null;
    const _fgOk =
      _fgSecsToExpiry !== null &&
      _fgSecsToExpiry >= 0 &&
      _fgSecsToExpiry <= TIME_ALERT_SECONDS;

    if (!_fgOk) {
      const _fgFields = {
        ticker, side,
        client_order_id:    clientOrderId,
        outcome:            "timing_guard",
        secs_to_expiry:     _fgSecsToExpiry,
        close_time:         _fgCloseTime,
        time_alert_seconds: TIME_ALERT_SECONDS,
        elapsed_ms:         Date.now() - _t0,
        pid:                _pid,
        commit:             _cmt,
        source,
      };
      logger.error(
        _fgFields,
        "AutoTrader: placeOrder exit — timing guard rejected POST (secondsToExpiry outside [0, TIME_ALERT_SECONDS])",
      );
      _placeOrderLogSink?.(
        "AutoTrader: placeOrder exit — timing guard rejected POST (secondsToExpiry outside [0, TIME_ALERT_SECONDS])",
        _fgFields,
      );
      unwind();
      releaseSubmissionState();
      capturePhase4BPlaceOrderFinalDecision("rejected_other", "timing_guard", {
        ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: true, halted: true,
      }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
      recordPORejected("timing_guard");
      return;
    }
  }

  // ── Final pre-submit L2 gate ───────────────────────────────────────────────
  // This MUST be a separate, awaited fetch: the original preflight snapshot
  // established eligibility, but cannot protect a quote that changed while the
  // SQL reservation was being committed.  The outcome-side cheapest level is
  // validated so YES and NO use the same economic price basis.
  // This is deliberately separate from the owner-locked entry band. It limits
  // only quote deterioration between the approved L2 preflight and the final
  // executable quote immediately before POST; a 3¢ rise is inclusive.
  const MAX_FINAL_EXECUTABLE_PRICE_RISE_CENTS = 3;
  const originalExecutablePriceCents = preflightSnapshot?.lowestLevelCents ?? outcomePriceCents;
  const finalCheckTimestampMs = Date.now();
  const finalBookSnapshot = await (_finalCaptureOrderbookImpl ?? captureOrderbook)(
    ticker,
    side,
    outcomePriceCents,
  );
  const finalQuoteAgeMs = Date.now() - finalBookSnapshot.capturedAtMs;
  const finalExecutablePriceCents = finalBookSnapshot.lowestLevelCents;
  const finalPriceDeltaCents = finalExecutablePriceCents == null
    ? null
    : finalExecutablePriceCents - originalExecutablePriceCents;
  const hasFinalExecutablePrice = finalExecutablePriceCents != null;
  const finalGateReason =
    finalBookSnapshot.error || !hasFinalExecutablePrice
      ? "skip_final_quote_stale"
      : finalQuoteAgeMs > 250
        ? "skip_final_quote_stale"
        : !isEntryPriceInBandForSeries(wlSeries ?? "", finalExecutablePriceCents)
          ? "skip_final_price_band"
          : finalPriceDeltaCents != null && finalPriceDeltaCents <= -2
            ? "skip_final_adverse_move"
            : finalPriceDeltaCents != null &&
                finalPriceDeltaCents > MAX_FINAL_EXECUTABLE_PRICE_RISE_CENTS
              ? "skip_final_excessive_price_rise"
              : null;

  if (finalGateReason) {
    const finalGateFields = {
      ticker, side, client_order_id: clientOrderId, source,
      outcome: finalGateReason,
      original_preflight_executable_price_cents: originalExecutablePriceCents,
      final_presubmit_executable_price_cents: finalExecutablePriceCents,
      final_price_delta_cents: finalPriceDeltaCents,
      final_quote_age_ms: finalQuoteAgeMs,
      final_check_timestamp_ms: finalCheckTimestampMs,
      final_l2_error: finalBookSnapshot.error,
      elapsed_ms: Date.now() - _t0,
    };
    logger.warn(finalGateFields, "AutoTrader: placeOrder exit — final pre-submit L2 gate rejected order");
    _placeOrderLogSink?.("AutoTrader: placeOrder exit — final pre-submit L2 gate rejected order", finalGateFields);
    unwind();
    releaseSubmissionState();
    void tradeStore.releaseRejectedAttempt({
      clientOrderId, ticker, side,
      easternDate: easternDay(new Date()),
      notionalCents,
      submissionAudit: {
        stage: "final_l2_gate",
        reason: finalGateReason,
        recordedAtMs: Date.now(),
        postInitiated: false,
        responseReceived: false,
        originalExecutablePriceCents,
        finalExecutablePriceCents,
        finalQuoteAgeMs,
        finalPriceDeltaCents,
        finalQuoteError: finalBookSnapshot.error,
      },
    });
    if (wlSeries) wlSkip(wlSeries, ticker, finalGateReason);
    try { if (wlSeries) recordGuardOutcome(wlSeries, "preflight_skip"); } catch {}
    capturePhase4BPlaceOrderFinalDecision(
      finalGateReason === "skip_final_price_band" &&
        (finalExecutablePriceCents ?? 0) < PRICE_FLOOR_CENTS
        ? "rejected_price_floor"
        : "rejected_other",
      finalGateReason,
      {
        ...unevaluatedPhase4BGuards(), priceFloor:
          finalGateReason !== "skip_final_price_band" ||
          (finalExecutablePriceCents ?? PRICE_FLOOR_CENTS) >= PRICE_FLOOR_CENTS,
        priceCap:
          finalGateReason !== "skip_final_price_band" ||
          (finalExecutablePriceCents ?? PRICE_CAP_CENTS) <= PRICE_CAP_CENTS,
        budget: true, dedup: true, position: true, halted: true,
      },
      null,
      { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars },
    );
    recordPORejected(finalGateReason);
    return;
  }

  // The passed final quote, not the earlier preflight limit, is the price placed
  // on the wire. Count/sizing remains unchanged by this final safety check.
  if (finalExecutablePriceCents == null || finalPriceDeltaCents == null) {
    throw new Error("Final pre-submit L2 gate passed without an executable outcome-side price");
  }
  const finalOutcomePriceCents = finalExecutablePriceCents;
  const bookPrice = side === "no" ? 100 - finalOutcomePriceCents : finalOutcomePriceCents;
  const priceDecimal = (bookPrice / 100).toFixed(4);
  const orderBody = {
    ticker,
    client_order_id: clientOrderId,
    side: side === "no" ? "ask" : "bid",
    count: `${count}.00`,
    price: priceDecimal,
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };

  // Week 2 is deliberately an entry-only boundary. This final exact-series
  // check sits immediately before the submission audit/persistence/POST
  // sequence, after all normal BTC observation, evaluation, and preflight
  // evidence was captured. It never applies to protective exits, which use
  // their own module/path.
  if (!(_isWeek2ProductionNewEntryTickerImpl ?? isNewEntryPermitted)(ticker)) {
    unwind();
    releaseSubmissionState();
    // The final policy boundary is intentionally after SQL pre-commit so it
    // proves the exact ticker immediately before submission. Compensate that
    // durable reservation exactly like the final L2 no-submit path: no BTC
    // policy block may survive as a pending order, dedup slot, or budget use.
    void tradeStore.releaseRejectedAttempt({
      clientOrderId, ticker, side,
      easternDate: easternDay(new Date()),
      notionalCents,
      submissionAudit: {
        stage: "week2_entry_policy",
        reason: WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
        recordedAtMs: Date.now(),
        postInitiated: false,
        responseReceived: false,
        originalExecutablePriceCents,
        finalExecutablePriceCents,
        finalQuoteAgeMs,
        finalPriceDeltaCents,
        finalQuoteError: finalBookSnapshot.error,
      },
    });
    logger.info(
      {
        ticker, side, client_order_id: clientOrderId,
        required_series: WEEK_2_PRODUCTION_NEW_ENTRY_SERIES,
        observed_series: seriesTokenFromTicker(ticker),
        reason: WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
      },
      "AutoTrader: Week 2 policy withheld new entry after completed evaluation",
    );
    if (wlSeries) wlSkip(wlSeries, ticker, WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON);
    try { if (wlSeries) recordGuardOutcome(wlSeries, WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON); } catch {}
    capturePhase4BPlaceOrderFinalDecision(
      "rejected_other",
      WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
      { ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: true, halted: true },
      null,
      { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars },
    );
    recordPORejected(WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON);
    _placeOrderLogSink?.("AutoTrader: placeOrder exit", {
      ..._entryFields, outcome: WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON, elapsed_ms: Date.now() - _t0,
    });
    return;
  }

  // ── Pre-submission audit log ──────────────────────────────────────────────
  const snap = marketState.get(ticker);
  const pendingContractsEstimate = outcomePriceCents > 0
    ? Math.round(pendingCents / outcomePriceCents)
    : 0;
  logger.info(
    {
      ticker, selected_side: side, yes_ask: snap?.yesAsk ?? null, no_ask: snap?.noAsk ?? null,
      original_preflight_executable_price_cents: originalExecutablePriceCents,
      final_presubmit_executable_price_cents: finalOutcomePriceCents,
      final_price_delta_cents: finalPriceDeltaCents,
      final_quote_age_ms: finalQuoteAgeMs,
      final_check_timestamp_ms: finalCheckTimestampMs,
      final_submitted_price_cents: finalOutcomePriceCents,
      book_price_decimal: priceDecimal,
      contracts_requested: count, contracts_approved: count,
      existing_filled_contracts: signedPosition, pending_open_contracts: pendingContractsEstimate,
      total_committed_cost_cents: notionalCents,
      price_band: entryPriceBandForSeries(wlSeries ?? ""),
      client_order_id: clientOrderId, source,
    },
    "AutoTrader: submitting order to Kalshi",
  );

  logger.info(
    {
      ticker, side, client_order_id: clientOrderId,
      elapsed_ms: Date.now() - _t0,
      pid: _pid, commit: _cmt,
    },
    "AutoTrader: Kalshi POST starting",
  );

  // _postStarted is set to true only after markAttemptPostStarted succeeds.
  // If markAttemptPostStarted throws (SQL unreachable, timeout, etc.) we must
  // NOT send the Kalshi POST; the catch block checks this flag to distinguish
  // a pre-POST persistence failure from a genuine Kalshi network error.
  let _postStarted = false;

  try {
    // Durably record that a POST is about to be sent.  This must complete
    // before the HTTP call so that a SIGTERM or crash can be classified as
    // post_unknown rather than reserved.  If this await throws, the catch
    // block emits post_start_persistence_failed and returns without posting.
    await (_markAttemptPostStartedImpl ?? tradeStore.markAttemptPostStarted)(clientOrderId);
    _postStarted = true;
    if (timing) timing.postStartMs = Date.now();

    const _kalshiFetch = (_kalshiAuthFetchImpl ?? kalshiAuthFetch) as typeof kalshiAuthFetch;
    const data = await _kalshiFetch<Record<string, unknown>>(
      "POST",
      "/portfolio/events/orders",
      orderBody,
    );
    const bookSnapshot = finalBookSnapshot;

    // ── Persist order timeline (fire-and-forget; off critical path) ─────────
    if (timing) {
      timing.ackMs = Date.now();
      const _tl = {
        ticker, side, client_order_id: clientOrderId, source,
        tick_received_ms: timing.tickReceivedMs,
        eval_start_ms:    timing.evalStartMs ?? null,
        l2_start_ms:      timing.l2StartMs   ?? null,
        l2_end_ms:        timing.l2EndMs     ?? null,
        post_start_ms:    timing.postStartMs ?? null,
        ack_ms:           timing.ackMs,
        tick_to_eval_ms:  (timing.evalStartMs ?? 0) - timing.tickReceivedMs,
        l2_ms:            timing.l2StartMs != null && timing.l2EndMs != null
                            ? timing.l2EndMs - timing.l2StartMs : null,
        post_to_ack_ms:   timing.postStartMs != null
                            ? timing.ackMs - timing.postStartMs : null,
        tick_to_ack_ms:   timing.ackMs - timing.tickReceivedMs,
      };
      logger.info(_tl, "AutoTrader: order timeline");
      void tradeStore.recordAttemptTimings(clientOrderId, timing);
    }

    // Parse order fields via the pure helper, which handles nested { order: {} }
    // vs flat response shapes and reads fp-suffixed numeric fields correctly.
    const {
      kalshiOrderId,
      orderStatus,
      fillCount,
      remainingCount,
      cancelReason,
      rejectReason,
    } = parseKalshiOrderResponse(data, count);

    const orderData = (data["order"] as Record<string, unknown> | undefined) ?? data;
    const fills     = (orderData["fills"] as Array<Record<string, unknown>> | undefined) ?? [];

    // outcome_side is the authoritative field — it records the economic side of
    // the position regardless of how the order was submitted (e.g. side:"ask"
    // for a NO buy still returns outcome_side:"no"). Fall back to fill-level
    // `side` only if outcome_side is absent, then to the order-level field as
    // a last resort.
    const purchasedSide =
      fills[0]?.["outcome_side"]   ??   // authoritative: per-fill economic side
      fills[0]?.["side"]           ??   // fallback: older API versions
      orderData["outcome_side"]    ??   // last resort: order-level field
      null;

    if (fillCount === 0) {
      unwind();

      // ── Pre-compute shared diagnostic values ──────────────────────────────
      // Computed once; used in both the log entry and the SQL persistence below.
      const _bboAgeMs = snap ? Date.now() - snap.bidUpdatedMs : null;

      // Did the BBO suggest our order should have crossed?
      const _bboShownCrossing = side === "no"
        ? (snap?.noAsk  != null && snap.noAsk  <= outcomePriceCents)
        : (snap?.yesAsk != null && snap.yesAsk <= outcomePriceCents);

      // Classification (based on corrected counterparty-side L2 depth):
      //   l2_fetch_error                  — L2 fetch failed; book data unavailable
      //   order_payload_issue             — Kalshi rejected the order (reject_reason present)
      //   l2_book_empty                   — No resting counterparty orders at all
      //   executable_depth_present_but_unfilled
      //                                   — Counterparty supply existed at our limit but IOC
      //                                     zero-filled; BBO may have been consumed between
      //                                     the L2 fetch and our order arrival
      //   stale_quote                     — No executable depth, BBO was stale (>2s) and
      //                                     showed a crossing price; likely consumed before
      //                                     our order arrived
      //   no_executable_depth             — No counterparty supply at or below our limit
      const _l2Hint = (() => {
        if (bookSnapshot.error)             return "l2_fetch_error";
        if (rejectReason)                   return "order_payload_issue";
        if (bookSnapshot.totalLevels === 0) return "l2_book_empty";
        if (bookSnapshot.depthAtOrBetterDollars > 0) return "executable_depth_present_but_unfilled";
        // Zero executable depth — check if BBO showed a crossing but was stale
        if (_bboShownCrossing && _bboAgeMs != null && _bboAgeMs > 2000) return "stale_quote";
        return "no_executable_depth";
      })();

      // ── Zero-fill diagnostic log (full L2 evidence) ──────────────────────
      logger.info(
        {
          ticker,
          selected_side:      side,
          client_order_id:    clientOrderId,
          kalshi_order_id:    kalshiOrderId,
          order_status:       orderStatus,
          time_in_force:      "immediate_or_cancel",
          fill_count:         0,
          requested_count:    count,
          remaining_count:    remainingCount,
          cancel_reason:      cancelReason,
          reject_reason:      rejectReason,
          // ── BBO at submission time ────────────────────────────────────────
          bbo_yes_bid:        snap?.yesBid ?? null,
          bbo_yes_ask:        snap?.yesAsk ?? null,
          bbo_no_bid:         snap?.noBid  ?? null,
          bbo_no_ask:         snap?.noAsk  ?? null,
          bbo_age_ms:         _bboAgeMs,
          // ── L2 orderbook snapshot at submission ───────────────────────────
          l2_fetch_latency_ms:             bookSnapshot.fetchLatencyMs,
          l2_fetch_error:                  bookSnapshot.error,
          l2_raw_entry_count:              bookSnapshot.rawEntryCount,
          l2_total_levels:                 bookSnapshot.totalLevels,
          l2_lowest_level_cents:           bookSnapshot.lowestLevelCents,
          l2_lowest_level_dollars:         bookSnapshot.lowestLevelDollars,
          l2_lowest_level_contracts:       bookSnapshot.lowestLevelContractsApprox,
          l2_highest_level_cents:          bookSnapshot.highestLevelCents,
          l2_depth_at_or_better_dollars:   bookSnapshot.depthAtOrBetterDollars,
          l2_depth_at_or_better_contracts: bookSnapshot.depthAtOrBetterContracts,
          l2_near_limit_levels:            bookSnapshot.nearLimitLevels,
          l2_miss_hint:                    _l2Hint,
          source,
        },
        "AutoTrader: order zero-fill with L2 snapshot",
      );
      if (wlSeries) wlTrade(wlSeries, ticker, side, outcomePriceCents, 0, 0, /* isZeroFill */ true);
      // ── SQL: finalise zero-fill (persist Kalshi UUID + diagnostic) ────────
      {
        const _diagParts: string[] = [];
        if (cancelReason) _diagParts.push(`cancel_reason:${cancelReason}`);
        if (rejectReason) _diagParts.push(`reject_reason:${rejectReason}`);
        if (orderStatus)  _diagParts.push(`status:${orderStatus}`);
        _diagParts.push(`l2_hint:${_l2Hint}`);
        if (_bboAgeMs != null) _diagParts.push(`bbo_age_ms:${_bboAgeMs}`);
        if (rejectReason) {
          // Kalshi definitively rejected the order (reject_reason present in 2xx body).
          // Release budget and dedup slot; transition outcome → post_rejected.
          void tradeStore.releaseRejectedAttempt({
            clientOrderId, ticker, side,
            easternDate:  easternDay(new Date()),
            notionalCents,
            submissionAudit: {
              stage: "kalshi_response",
              reason: "provider_reject_reason",
              recordedAtMs: Date.now(),
              postInitiated: true,
              responseReceived: true,
              originalExecutablePriceCents,
              finalExecutablePriceCents: finalOutcomePriceCents,
              finalQuoteAgeMs,
              finalPriceDeltaCents,
              providerMessage: String(rejectReason),
              postDurationMs: Date.now() - (timing?.postStartMs ?? t0),
            },
          });
        } else {
          // Unfilled but not definitively rejected: IOC expired or depth gone.
          // Outcome → zero_fill; release dedup slot + budget so next tick can retry.
          void tradeStore.finaliseOrderAttempt({
            clientOrderId,
            outcome:            "zero_fill",
            orderId:            kalshiOrderId,
            fillCount:          0,
            remainingCount,
            roundTripMs:        Date.now() - t0,
            zeroFillDiagnostic: _diagParts.join(";"),
            submissionAudit: {
              stage: "kalshi_accepted",
              reason: "accepted_zero_fill",
              recordedAtMs: Date.now(),
              postInitiated: true,
              responseReceived: true,
              originalExecutablePriceCents,
              finalExecutablePriceCents: finalOutcomePriceCents,
              finalQuoteAgeMs,
              finalPriceDeltaCents,
              postDurationMs: Date.now() - (timing?.postStartMs ?? t0),
            },
          });
          void tradeStore.releaseDedupSlotInSql(ticker, side);
          void tradeStore.releaseBudgetInSql(easternDay(new Date()), notionalCents);
        }
      }
      // ── Suppress identical retries after zero-fill ────────────────────────────
      // Record the full 5-field quote snapshot so checkAndPlace() can skip the
      // next tick if prices have not changed.  Cleared on fill or window rollover.
      {
        const snap0 = marketState.get(ticker);
        if (snap0) {
          zeroFillSuppressionCache.set(key, {
            limitCents: outcomePriceCents,
            yesAsk:     snap0.yesAsk  ?? null,
            noAsk:      snap0.noAsk   ?? null,
            yesBid:     snap0.yesBid  ?? null,
            noBid:      snap0.noBid   ?? null,
            cachedAt:   Date.now(),
            origin:     "zero_fill",
          });
        }
        // Guarantee a REST evaluation tick lands within 32 s so the retry can
        // fire before window close even if no WS/reconcile tick arrives.
        armZeroFillRetryPoll(ticker, side);
      }
      // ── Analytics: zero-fill diagnostic snapshot ─────────────────────────────
      try {
        const snap2 = marketState.get(ticker);
        recordZeroFill(_analyticsId, {
          requestedContracts: count,
          limitPriceCents:    outcomePriceCents,
          triggerPriceCents:  triggerBidCents,
          yesBid:             snap2?.yesBid  ?? null,
          noBid:              snap2?.noBid   ?? null,
          yesAsk:             snap2?.yesAsk  ?? null,
          noAsk:              snap2?.noAsk   ?? null,
          yesDerivedAsk:      snap2?.noBid  != null ? 100 - snap2.noBid  : null,
          noDerivedAsk:       snap2?.yesBid != null ? 100 - snap2.yesBid : null,
          snapshotAgeMs:      snap2 ? Date.now() - snap2.bidUpdatedMs : 0,
          snapshotSource:     source,
          roundTripMs:        Date.now() - t0,
        });
      } catch {}
        capturePhase4BPlaceOrderFinalDecision(rejectReason ? "rejected_other" : "submitted",
          rejectReason ? "post_rejected" : "zero_fill", {
            ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: true, halted: true,
          }, null, {
            intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars,
            executableL2DepthContracts: bookSnapshot.depthAtOrBetterContracts,
            estimatedFeesDollars: 0, kalshiOrderId,
          });
      // Kalshi definitively rejected this order via 2xx body rejectReason.
      if (rejectReason) recordPostFailed("exchange_rejected", String(rejectReason));
    } else {
      // ── Actual cost from per-fill prices ────────────────────────────────────
      // outcomePriceCents is only the LIMIT price. Fills may occur at price
      // improvement. parseFillActuals() sums fill_count × outcome-side price
      // across every fill record so actual_dollars_spent reflects what was
      // truly paid, not what was offered.
      const actuals = parseFillActuals(fills, side, outcomePriceCents, fillCount);

      if (!actuals.pricesKnown) {
        logger.warn(
          { ticker, side, source },
          "AutoTrader: fill price fields absent — actual_dollars_spent estimated from limit price (conservative)",
        );
      }

      // ── Successful fill clears zero-fill suppression ──────────────────────────
      // A fill (full or partial) proves real depth existed — suppress cache is no
      // longer relevant; clear it so future windows start fresh.
      zeroFillSuppressionCache.delete(key);

      // ── Release ALL unused reserved notional in one calculation ─────────────
      // Covers both: (a) price improvement on filled contracts,
      //              (b) unfilled contracts on partial fills.
      const actualNotionalCents  = Math.round(actuals.dollarsCost * 100);
      const unusedNotionalCents  = notionalCents - actualNotionalCents;
      if (unusedNotionalCents > 0) {
        releaseNotional(unusedNotionalCents);
      }

      // ── Record actual spend (not limit price × count) ────────────────────────
      spendTracker.set(spendKey, alreadySpentDollars + actuals.dollarsCost);
      const cumulativeWindowSpend = alreadySpentDollars + actuals.dollarsCost;

      // ── Analytics: record fill + fire background reconciliation ──────────────
      // kalshiOrderId is already extracted earlier from the parallel Promise.all result.
      try {
        const _fillPriceCents = actuals.pricesKnown && actuals.contracts > 0
          ? Math.round((actuals.dollarsCost / actuals.contracts) * 100)
          : outcomePriceCents;
        const _rfParams = {
          orderId:         kalshiOrderId,
          fillCount,
          requestedCount:  count,
          contractsFilled: actuals.contracts || fillCount,
          fillPriceCents:  _fillPriceCents,
          notionalDollars: actuals.dollarsCost,
          feeDollars:      actuals.feeDollars,
          pricesKnown:     actuals.pricesKnown,
          roundTripMs:     Date.now() - t0,
        };
        // Spy called BEFORE recordFill so integration tests can capture the params
        // that actually reach analytics (without depending on analytics internal state).
        _recordFillSpy?.(_analyticsId, _rfParams);
        recordFill(_analyticsId, _rfParams);
        // Register the confirmed fill with the protective-exit monitor so a
        // later exchange-lookup failure or zero reading for this position
        // produces durable verification-failure evidence (task: a confirmed
        // position must never silently lose protection).
        if (_rfParams.contractsFilled > 0) {
          noteConfirmedLocalEntry(ticker, side, _rfParams.contractsFilled);
        }
        // Fire reconciliation in the background — purely observational analytics.
        // reconcileOrder() fetches Kalshi's fills detail and calls recordReconciliation().
        // It NEVER creates, retries, or modifies an order — it only reads fill data
        // for analytics accuracy. A partial fill here does NOT cause a resubmission.
        //
        // Two IDs are passed:
        //  • _analyticsId  (compound "${clientOrderId}-${attemptNumber}") — used by
        //    recordReconciliation / recordReconciliationFailed to update in-memory analytics.
        //  • clientOrderId (raw UUID, = order_attempts.id SQL PK) — stored as
        //    order_fills.attempt_id so every fill row JOINs correctly to order_attempts.
        if (kalshiOrderId && _analyticsId) {
          if (_reconcileOrderSpy) {
            // In tests: spy captures args synchronously; suppress the real fire-and-
            // forget so no background retry timers or external HTTP calls are started.
            _reconcileOrderSpy(_analyticsId, kalshiOrderId, side, outcomePriceCents, ticker, clientOrderId);
          } else {
            reconcileOrder(_analyticsId, kalshiOrderId, side, outcomePriceCents, ticker, clientOrderId).catch(() => {});
          }
        }
      } catch {}

      // ── SQL: finalise fill ────────────────────────────────────────────────────
      {
        const _pricesKnown      = actuals.pricesKnown && actuals.contracts > 0;
        const _sqlFillPriceCents = _pricesKnown
          ? Math.round((actuals.dollarsCost / actuals.contracts) * 100)
          : outcomePriceCents;
        const _sqlOutcome = fillCount < count ? "partial_fill" : "full_fill";
        void tradeStore.finaliseOrderAttempt({
          clientOrderId,
          outcome:          _sqlOutcome,
          // Persist the Kalshi exchange order UUID so the fill reconciler and
          // backfill script can later retrieve individual fill chunks via
          // GET /portfolio/events/orders/{orderId}/fills.  Without this the row
          // has no orderId and neither tool can recover actual fill prices.
          orderId:          kalshiOrderId,
          fillCount,
          remainingCount,
          contracts:        actuals.contracts || fillCount,
          fillPriceCents:   _sqlFillPriceCents,
          notionalDollars:  actuals.dollarsCost,
          feeDollars:       actuals.feeDollars,
          roundTripMs:      Date.now() - t0,
          // Mark source so callers can distinguish confirmed-from-response fills from
          // limit-price fallbacks.  The fill reconciler will overwrite this to 'actual'
          // once it has confirmed data from the Kalshi fills API.
          fillPriceSource:  _pricesKnown ? "actual" : "limit_fallback",
        submissionAudit: {
          stage: "kalshi_accepted",
          reason: null,
          recordedAtMs: Date.now(),
          postInitiated: true,
          responseReceived: true,
          originalExecutablePriceCents,
          finalExecutablePriceCents: finalOutcomePriceCents,
          finalQuoteAgeMs,
          finalPriceDeltaCents,
          postDurationMs: Date.now() - (timing?.postStartMs ?? t0),
        },
        }).then(() => tradeStore.captureGreenZoneSnapshot(clientOrderId));
        if (fillCount < count) {
          void tradeStore.releaseDedupSlotInSql(ticker, side);
        }
        if (unusedNotionalCents > 0) {
          void tradeStore.releaseBudgetInSql(easternDay(new Date()), unusedNotionalCents);
        }
      }

      const fillLogFields = {
        ticker,
        selected_side:             side,
        purchased_side:            purchasedSide,
        // Kalshi order identifiers
        client_order_id:           clientOrderId,
        kalshi_order_id:           kalshiOrderId,
        order_status:              orderStatus,
        time_in_force:             "immediate_or_cancel",
        fill_count:                fillCount,
        requested_count:           count,
        remaining_count:           remainingCount,
        cancel_reason:             cancelReason,
        reject_reason:             rejectReason,
        // Limit price submitted to Kalshi (¢, outcome-side)
        limit_price_cents:         outcomePriceCents,
        contracts_requested:       count,
        contracts_filled:          actuals.contracts || fillCount,
        // True contract purchase cost derived from per-fill prices
        actual_dollars_spent:      actuals.dollarsCost.toFixed(4),
        // Fees are logged separately and are NOT counted against the $100
        // window budget. The window limit tracks contract cost only.
        fee_dollars:               actuals.feeDollars.toFixed(4),
        fee_note:                  "window_limit_is_contract_cost_only_fees_are_additional",
        reserved_notional_cents:   notionalCents,
        released_unused_cents:     Math.max(0, unusedNotionalCents),
        fill_prices_from_response: actuals.pricesKnown,
        cumulative_window_spend:   cumulativeWindowSpend.toFixed(4),
        // L2 book at time of fill (confirms depth existed)
        l2_depth_at_or_better_dollars:   bookSnapshot.depthAtOrBetterDollars,
        l2_depth_at_or_better_contracts: bookSnapshot.depthAtOrBetterContracts,
        l2_lowest_level_cents:           bookSnapshot.lowestLevelCents,
        l2_fetch_error:                  bookSnapshot.error,
        source,
      };

      if (wlSeries) wlTrade(
        wlSeries, ticker, side, outcomePriceCents,
        actuals.contracts || fillCount,
        actuals.dollarsCost,
        /* isZeroFill */ false,
      );

      if (fillCount < count) {
        // Partial fill: slot released so the next tick can attempt the remainder.
        //
        // IMPORTANT: This does NOT automatically resubmit. The slot release merely
        // allows the NEXT incoming tick to go through evaluate() again. That tick
        // will independently run all guards (price band, zone, cooldown, budget,
        // kill switch, position guard) before any new order is considered.
        // No order is created here. The fill reconciler (reconcileOrder above)
        // is also read-only analytics — it never creates orders.
        releaseOrderSlot(ticker, side);
        logger.info(fillLogFields, "Order partially filled — slot released for retry on next tick");
      } else {
        logger.info(fillLogFields, "Order fully filled");
      }
        capturePhase4BPlaceOrderFinalDecision("submitted", fillCount < count ? "partial_fill" : "full_fill", {
          ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: true, halted: true,
        }, null, {
          intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars,
          executableL2DepthContracts: bookSnapshot.depthAtOrBetterContracts,
          estimatedFeesDollars: actuals.feeDollars, kalshiOrderId,
        });
    }
  } catch (err: unknown) {
    if (!_postStarted) {
      // markAttemptPostStarted threw before the Kalshi POST was dispatched.
      // Release all reservations and emit the terminal outcome; the finally
      // block still runs to clear submissionInFlight and submissionOrderIds.
      unwind();
      const _psErrMsg = err instanceof Error ? err.message : String(err);
      // Best-effort: attempt to finalise the row as failed.
      // releaseBudgetInSql and releaseDedupSlotInSql may also fail if SQL is
      // unavailable; that is acceptable — the row remains in UNRESOLVED_OUTCOMES
      // ("reserved") and will be picked up by the reconciliation job.
      void tradeStore.finaliseOrderAttempt({
        clientOrderId,
        outcome:            "post_start_persistence_failed",
        roundTripMs:        0,
        zeroFillDiagnostic: _psErrMsg,
        submissionAudit: {
          stage: "post_start_persistence",
          reason: "storage_write_failed",
          recordedAtMs: Date.now(),
          postInitiated: false,
          responseReceived: false,
          originalExecutablePriceCents,
          finalExecutablePriceCents: finalOutcomePriceCents,
          finalQuoteAgeMs,
          finalPriceDeltaCents,
          providerMessage: _psErrMsg,
        },
      });
      // Persist whatever timeline we have (ack stays null — no POST was sent).
      if (timing) void tradeStore.recordAttemptTimings(clientOrderId, timing);
      void tradeStore.releaseDedupSlotInSql(ticker, side);
      void tradeStore.releaseBudgetInSql(easternDay(new Date()), notionalCents);
      const _psFields = {
        err:             _psErrMsg,
        ticker, side,
        client_order_id: clientOrderId,
        outcome:         "post_start_persistence_failed",
        pid:             _pid,
        commit:          _cmt,
        source,
      };
      logger.error(_psFields, "AutoTrader: markAttemptPostStarted failed — Kalshi POST aborted");
      _placeOrderLogSink?.("AutoTrader: markAttemptPostStarted failed — Kalshi POST aborted", _psFields);
      if (wlSeries) wlSkip(wlSeries, ticker, "api_error");
      try { if (wlSeries) recordGuardOutcome(wlSeries, "api_error"); } catch {}
      capturePhase4BPlaceOrderFinalDecision("rejected_other", "post_start_persistence_failed", {
        ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: true, halted: true,
      }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
      recordPORejected("post_start_persistence_failed");
      return;
    }

    unwind();
    // Persist whatever timeline we have. ackMs stays null on network errors —
    // for definitive HTTP rejects the error arrival is the closest ack analogue.
    if (timing) {
      if (timing.ackMs == null && (err as Record<string, unknown>)?.["status"] != null) {
        timing.ackMs = Date.now();
      }
      void tradeStore.recordAttemptTimings(clientOrderId, timing);
    }
    const _catchElapsedMs = Date.now() - t0;
    const _errMsg    = err instanceof Error ? err.message : String(err);
    // Attempt to extract HTTP status and body from fetch-style error objects.
    const _errStatus = (err as Record<string, unknown>)?.["status"]   ?? null;
    const _errBody   = (err as Record<string, unknown>)?.["body"]     ??
                       (err as Record<string, unknown>)?.["response"] ?? null;

    // Distinguish definitive HTTP rejections (400/404/422) from genuinely
    // uncertain outcomes (timeout, connection reset, malformed response, etc.).
    const _isDefinitiveHttpReject = typeof _errStatus === "number" &&
      (_errStatus === 400 || _errStatus === 404 || _errStatus === 422);
    const _catchOutcome = _isDefinitiveHttpReject ? "post_rejected" : "post_unknown";

    if (_isDefinitiveHttpReject) {
      // Kalshi confirmed it did not accept the order — safe to release resources.
      void tradeStore.releaseRejectedAttempt({
        clientOrderId, ticker, side,
        easternDate:  easternDay(new Date()),
        notionalCents,
        submissionAudit: {
          stage: "kalshi_post",
          reason: "definitive_http_rejection",
          recordedAtMs: Date.now(),
          postInitiated: true,
          responseReceived: true,
          originalExecutablePriceCents,
          finalExecutablePriceCents: finalOutcomePriceCents,
          finalQuoteAgeMs,
          finalPriceDeltaCents,
          httpStatus: _errStatus as number,
          providerMessage: _errMsg,
          postDurationMs: Date.now() - (timing?.postStartMs ?? t0),
        },
      });
    } else {
      // Uncertain: network timeout, connection reset, malformed response.
      // Transition to post_unknown so reconciliation can determine the true
      // outcome. Release dedup + budget conservatively so the next tick can retry;
      // the SQL row stays unresolved until the reconciliation job settles it.
      void tradeStore.markAttemptPostUnknown(clientOrderId);
      void tradeStore.recordSubmissionAudit(clientOrderId, {
        stage: "kalshi_post",
        reason: "uncertain_transport_or_provider_failure",
        recordedAtMs: Date.now(),
        postInitiated: true,
        responseReceived: _errStatus != null,
        originalExecutablePriceCents,
        finalExecutablePriceCents: finalOutcomePriceCents,
        finalQuoteAgeMs,
        finalPriceDeltaCents,
        httpStatus: typeof _errStatus === "number" ? _errStatus : null,
        providerMessage: _errMsg,
        postDurationMs: Date.now() - (timing?.postStartMs ?? t0),
      });
      void tradeStore.releaseDedupSlotInSql(ticker, side);
      void tradeStore.releaseBudgetInSql(easternDay(new Date()), notionalCents);
    }

    const _catchFields = {
      err:             _errMsg,
      err_body:        _errBody,
      http_status:     _errStatus,
      ticker, side,
      client_order_id: clientOrderId,
      outcome:         _catchOutcome,
      elapsed_ms:      _catchElapsedMs,
      pid:             _pid,
      commit:          _cmt,
      source,
    };
    logger.error(_catchFields, "AutoTrader: Kalshi order failed");
    _placeOrderLogSink?.("AutoTrader: Kalshi order failed", _catchFields);
    capturePhase4BPlaceOrderFinalDecision("rejected_other", _catchOutcome, {
      ...unevaluatedPhase4BGuards(), priceFloor: true, priceCap: true, budget: true, dedup: true, position: true, halted: true,
    }, null, { intendedContractCount: count, intendedNotionalCents: notionalCents, availableExposureDollars: remainingDollars });
    // Emit a terminal evaluation event so the Dashboard can explain post-POST failures.
    // `exchange_rejected` = Kalshi definitively refused (HTTP 4xx).
    // `post_unknown`      = network error, timeout, or malformed response.
    recordPostFailed(
      _isDefinitiveHttpReject ? "exchange_rejected" : "post_unknown",
      _isDefinitiveHttpReject ? `http_${String(_errStatus)}` : "transport_failure",
    );
    if (wlSeries) wlSkip(wlSeries, ticker, "api_error");
    try { if (wlSeries) recordGuardOutcome(wlSeries, "api_error"); } catch {}
  } finally {
    // Always release the in-flight lock and decrement pending notional,
    // regardless of fill outcome, partial fill, zero-fill, or error.
    submissionInFlight.delete(ticker);
    submissionOrderIds.delete(ticker);
    const prev = pendingNotionalByTicker.get(ticker) ?? 0;
    const next  = prev - notionalCents;
    if (next <= 0) {
      pendingNotionalByTicker.delete(ticker);
    } else {
      pendingNotionalByTicker.set(ticker, next);
    }
  }
}

// ── WebSocket path ────────────────────────────────────────────────────────────

function onWsTick(raw: Record<string, unknown>): void {
  const ticker = raw["ticker"] as string | undefined;
  if (!ticker) return;

  const series = seriesForTicker(ticker);
  const now = Date.now();

  // Only the immutable ETH entry series is accepted here. Retired series such
  // as SOL return before state merge or any evaluator can run.
  if (!series) {
    return;
  }

  lastWsTickMs.set(ticker, now);

  handleWindowRollover(series, ticker);

  const state      = mergeState(
    raw,
    now,
    /* allowBidOverwrite */ true,
    /* isAuthoritativeSnapshot */ false,
  );
  const betDollars = SERIES_CONFIG[series].betDollars;

  _legacyEvaluateSpy?.(state.ticker);
  evaluate(state, betDollars, "websocket", { tickReceivedMs: now }).catch((err) =>
    logger.warn({ err }, "AutoTrader: WS evaluate error"),
  );
}

// ── REST fetch + fallback ─────────────────────────────────────────────────────

/** Tracks in-flight REST fetches per series to prevent overlapping requests. */
const restFetchInFlight = new Set<string>();
type RestFetchResult = "usable" | "inactive" | "metadata_unusable" | "inflight" | "identity_mismatch" | "error";

async function restFetchSeries(
  series:   SeriesKey,
  source:   TriggerSource,
  fetchStartMs: number,
  options?: {
    forceFresh?: boolean;
    expectedTicker?: string;
    expectedOpenTimeMs?: number;
  },
): Promise<RestFetchResult> {
  // A boundary probe must not wait behind an ordinary cached lookup; it has its
  // own request lane but still coalesces with another boundary probe.
  const inFlightKey = options?.forceFresh ? `${series}:boundary` : series;
  if (restFetchInFlight.has(inFlightKey)) return "inflight";
  restFetchInFlight.add(inFlightKey);

  try {
    // Use the shared coalesced fetch — concurrent calls for the same series
    // (reconcile timer, fallback poller, WS ticker refresh, UI route) all share
    // one in-flight Kalshi request instead of each firing independently.
    // In tests, _kalshiSeriesFetchImpl replaces the real fetch so the test can
    // spy on which series were requested without making live network calls.
    const raw = await (_kalshiSeriesFetchImpl
      ? _kalshiSeriesFetchImpl(series, { forceFresh: options?.forceFresh })
      : kalshiSeriesFetch(series, { forceFresh: options?.forceFresh }));
    if (!raw) return "inactive";

    const normalized = normalizeMarket(raw);
    const ticker     = normalized["ticker"] as string | undefined;
    if (!ticker) return "inactive";
    const openTimeMs = typeof normalized["open_time"] === "string"
      ? Date.parse(normalized["open_time"]) : NaN;
    if (options?.expectedTicker && (
      ticker !== options.expectedTicker
      || openTimeMs !== options.expectedOpenTimeMs
    )) {
      return "identity_mismatch";
    }
    // A boundary probe only enters the established rollover/evaluate route once
    // the exchange identifies this exact market as active and provides the
    // metadata ETH 420 needs to make a truthful decision.
    if (options?.forceFresh) {
      if (normalized["status"] !== "open") return "inactive";
      recordBoundaryDiscoveryAudit({
        ticker, openTimeMs, atMs: Date.now(), stage: "active_response", reason: null,
      });
      if (!Number.isFinite(openTimeMs)
        || typeof normalized["close_time"] !== "string"
        || !Number.isInteger(normalized["exchange_index"])
        || typeof normalized["floor_strike"] !== "number") {
        return "metadata_unusable";
      }
      recordBoundaryDiscoveryAudit({
        ticker, openTimeMs, atMs: Date.now(), stage: "usable_metadata", reason: null,
      });
    }

    handleWindowRollover(series, ticker);

    // Only overwrite bid/ask fields if no fresher WS update arrived while
    // the REST request was in flight.
    const lastWs           = lastWsTickMs.get(ticker) ?? 0;
    const allowBidOverwrite = lastWs < fetchStartMs;

    if (!allowBidOverwrite) {
      logger.debug(
        { ticker, series, source },
        "AutoTrader: REST bid data discarded (WS update was fresher)",
      );
    }

    const state      = mergeState(
      normalized,
      fetchStartMs,
      allowBidOverwrite,
      /* isAuthoritativeSnapshot */ true,
    );
    const betDollars = SERIES_CONFIG[series].betDollars;

    if (options?.forceFresh) {
      recordBoundaryDiscoveryAudit({
        ticker, openTimeMs, atMs: Date.now(), stage: "evaluation_started", reason: null,
      });
    }
    await evaluate(state, betDollars, source, {
      tickReceivedMs: fetchStartMs,
      ...(options?.forceFresh ? { boundaryOpenTimeMs: options.expectedOpenTimeMs } : {}),
    });
    return "usable";
  } catch (err) {
    logger.warn({ err, series, source }, "AutoTrader: REST fetch failed");
    return "error";
  } finally {
    restFetchInFlight.delete(inFlightKey);
  }
}

async function restFetchAll(source: TriggerSource, isEthSettlementRetryPass = false): Promise<void> {
  const fetchStartMs = Date.now();
  await Promise.all(ACTIVE_ENTRY_SERIES.map((series) => restFetchSeries(series, source, fetchStartMs)));
  const ethSettlementComplete = await reconcileEthMartingaleSettlements();
  const ethExposure = await hasUnsettledEthMartingaleExposure();

  // A fetched next window may have been evaluated while the prior ETH GTC was
  // still unsettled. Revisit that exact in-memory market once reconciliation
  // completes so a durable settlement does not wait for another 45-second poll.
  // This intentionally goes through evaluate() rather than submitting directly:
  // the ETH evaluator rechecks eligibility, the durable unsettled-order fence,
  // and its per-ticker active lock, so incomplete settlement and duplicate ticks
  // remain fail-closed.
  const ethTicker = currentTickerBySeries.get("KXETH15M");
  const ethState = ethTicker ? marketState.get(ethTicker) : undefined;
  if (ethState) {
    await evaluate(ethState, SERIES_CONFIG.KXETH15M.betDollars, source, {
      tickReceivedMs: fetchStartMs,
    });
  }
  // The timer-driven retry itself consumes this handoff's retry budget. It may
  // remain correctly fenced by unresolved exposure, but must never turn into a
  // five-second polling loop; the normal reconciliation cadence can establish a
  // new one-shot retry later.
  if ((!ethSettlementComplete || ethExposure !== false) && !isEthSettlementRetryPass) {
    armEthSettlementRetry(source);
  }
}

/** Configure the orchestration-only boundary scheduler with existing authority. */
function configureEthBoundarySettlementOrchestration(): void {
  _configureEthBoundarySettlementOrchestratorForTesting({
    reconcile: reconcileEthMartingaleSettlements,
    hasUnsettledExposure: hasUnsettledEthMartingaleExposure,
    loadCandidateHints: getEthMartingalePriorOrderSideHints,
    // restFetchAll obtains current market data then calls the established
    // evaluate() route, which rereads durable state before any order POST.
    onDurablySettled: () => restFetchAll("rest_fallback", true),
  });
}

/** Candidate-only scheduler wiring. Its callback deliberately returns through
 * the established fresh REST/evaluate route rather than candidate submission. */
function configureEth420BoundarySettlementOrchestration(): void {
  _configureEth420BoundarySettlementOrchestratorForTesting({
    reconcile: () => reconcileEth420CandidateLiveSettlements(tradeStore),
    hasUnresolvedExposure: tradeStore.hasUnresolvedEth420CandidateLiveExposure,
    loadCandidateHints: () => getEth420CandidatePriorOrderHints(tradeStore),
    onDurablySettled: restFetchEth420CandidateAfterSettlement,
  });
}

/**
 * Learn a future ETH market from the stream's unopened-market refresh and
 * schedule exactly one fresh lookup after its official opening timestamp.
 * This timer only obtains market data: it cannot reserve or submit directly.
 */
function scheduleEthBoundaryDiscovery(raw: Record<string, unknown>): void {
  const ticker = raw["ticker"];
  const openTime = raw["open_time"];
  if (typeof ticker !== "string" || !isEthTicker(ticker) || typeof openTime !== "string") return;
  const openTimeMs = Date.parse(openTime);
  if (!Number.isFinite(openTimeMs)) return;
  configureEthBoundarySettlementOrchestration();
  configureEth420BoundarySettlementOrchestration();
  // The next market's opening is the current ETH market's close boundary.
  // This only arms reconciliation and a read-only candidate hint; it cannot
  // evaluate or submit before the existing post-boundary data path runs.
  armEthBoundarySettlementOrchestration(openTimeMs);
  armEth420BoundarySettlementOrchestration(openTimeMs);
  const existing = boundaryDiscoveryTarget;
  if (existing?.ticker === ticker && existing.openTimeMs === openTimeMs) return;
  if (boundaryDiscoveryTimer) clearTimeout(boundaryDiscoveryTimer);
  boundaryDiscoveryTarget = { ticker, openTimeMs };
  recordBoundaryDiscoveryAudit({ ticker, openTimeMs, atMs: Date.now(), stage: "upcoming_seen", reason: null });
  const delay = Math.max(0, openTimeMs + BOUNDARY_PROBE_DELAY_MS - Date.now());
  boundaryDiscoveryTimer = setTimeout(() => {
    void runEthBoundaryProbe(ticker, openTimeMs, 0);
  }, delay);
  boundaryDiscoveryTimer.unref?.();
}

/**
 * Lifecycle-created is pre-registration only. Lifecycle-activated is Kalshi's
 * authoritative open event, but still reaches the unchanged fresh REST identity
 * and tradability verification before any evaluator can observe it.
 */
function onEthMarketLifecycle(event: KalshiMarketLifecycleEvent): void {
  if (!isEthTicker(event.ticker)) return;
  const openTimeMs = Date.parse(event.openTime);
  if (!Number.isFinite(openTimeMs)) return;
  configureEthBoundarySettlementOrchestration();
  configureEth420BoundarySettlementOrchestration();
  if (event.eventType === "created") {
    scheduleEthBoundaryDiscovery({ ticker: event.ticker, open_time: event.openTime });
    return;
  }
  // Kalshi's next-market activation occurs at the prior market close. It only
  // accelerates the existing settlement sweep; market_lifecycle never declares
  // a result or releases a durable blocker by itself.
  triggerEthBoundarySettlementOrchestration(openTimeMs);
  triggerEth420BoundarySettlementOrchestration(openTimeMs);
  const key = `${event.ticker}:${openTimeMs}`;
  if (lifecycleActivationInFlight.has(key)) return;
  lifecycleActivationInFlight.add(key);
  // Ensure activation remains useful after a process restart that missed created.
  scheduleEthBoundaryDiscovery({ ticker: event.ticker, open_time: event.openTime });
  if (boundaryDiscoveryTimer != null) {
    clearTimeout(boundaryDiscoveryTimer);
    boundaryDiscoveryTimer = null;
  }
  void runEthBoundaryProbe(event.ticker, openTimeMs, 0, "websocket").finally(() => {
    lifecycleActivationInFlight.delete(key);
  });
}

async function runEthBoundaryProbe(
  ticker: string,
  openTimeMs: number,
  attempt: number,
  source: TriggerSource = "rest_fallback",
): Promise<void> {
  const ownsTarget = () => boundaryDiscoveryTarget?.ticker === ticker
    && boundaryDiscoveryTarget.openTimeMs === openTimeMs;
  if (!ownsTarget()) return;
  boundaryDiscoveryTimer = null;
  recordBoundaryDiscoveryAudit({ ticker, openTimeMs, atMs: Date.now(), stage: "probe_started", reason: `attempt_${attempt + 1}` });
  const outcome = await restFetchSeries("KXETH15M", source, Date.now(), {
    forceFresh: true, expectedTicker: ticker, expectedOpenTimeMs: openTimeMs,
  });
  // A later unopened market may have been discovered while this probe awaited
  // its evaluator. This older completion must never clear or replace that
  // later window's scheduled timer.
  if (!ownsTarget()) return;
  if (outcome === "usable") {
    boundaryDiscoveryTarget = null;
    return;
  }
  if (attempt < MAX_BOUNDARY_PROBE_RETRIES && ["inactive", "metadata_unusable", "inflight"].includes(outcome)) {
    recordBoundaryDiscoveryAudit({ ticker, openTimeMs, atMs: Date.now(), stage: "probe_deferred", reason: outcome });
    boundaryDiscoveryTimer = setTimeout(() => {
      void runEthBoundaryProbe(ticker, openTimeMs, attempt + 1, source);
    }, BOUNDARY_PROBE_RETRY_DELAY_MS);
    boundaryDiscoveryTimer.unref?.();
    return;
  }
  recordBoundaryDiscoveryAudit({ ticker, openTimeMs, atMs: Date.now(), stage: "probe_exhausted", reason: outcome });
  boundaryDiscoveryTarget = null;
}

/**
 * Reconciliation is normally revisited every 45 seconds. At a 15-minute
 * rollover that can be too late after a rate-limit or buffered durable write.
 * Arm exactly one short retry; it deliberately comes back through restFetchAll
 * so it refreshes the current ETH ticker and then invokes the same evaluator
 * (including market-close, exact-identity, terminal-count, fill-economics, and
 * durable-unsettled-order gates). A timer never releases or submits anything.
 */
function armEthSettlementRetry(source: TriggerSource): void {
  if (ethSettlementRetryTimer != null) return;
  ethSettlementRetryTimer = setTimeout(() => {
    ethSettlementRetryTimer = null;
    logger.info({ retry_delay_ms: ETH_SETTLEMENT_RETRY_DELAY_MS, source },
      "AutoTrader: retrying unresolved ETH settlement before the next reconciliation cadence");
    void restFetchAll("rest_fallback", true).catch((err) => {
      logger.warn({ err }, "AutoTrader: ETH settlement retry fetch failed");
    });
  }, ETH_SETTLEMENT_RETRY_DELAY_MS);
  ethSettlementRetryTimer.unref?.();
}

/** Returns true when the WS stream is considered stale for any tracked series. */
function isWsStale(): boolean {
  const connected = _kalshiStreamIsConnectedImpl
    ? _kalshiStreamIsConnectedImpl()
    : kalshiStream.isConnected();
  if (!connected) return true;
  const now = Date.now();
  for (const series of TRACKED_SERIES) {
    const ticker = currentTickerBySeries.get(series);
    if (!ticker) continue; // haven't seen this series yet — let WS do its thing
    const last = lastWsTickMs.get(ticker) ?? 0;
    if (now - last > STALE_WS_MS) return true;
  }
  return false;
}

/**
 * Build a diagnostic object for the current WS health state.
 * Included in every "WS stale" log so production logs distinguish
 * "truly dead" from "connected but no tickers" (e.g. field-name mismatch).
 */
function wsHealthDiag(): Record<string, unknown> {
  const now = Date.now();
  const anyMsgMs = kalshiStream.lastAnyMsgMs();
  const tickerAges: Record<string, number> = {};
  for (const series of TRACKED_SERIES) {
    const ticker = currentTickerBySeries.get(series);
    if (ticker) tickerAges[ticker] = now - (lastWsTickMs.get(ticker) ?? 0);
  }
  return {
    wsConnected:        kalshiStream.isConnected(),
    msSinceAnyWsMsg:    anyMsgMs > 0 ? now - anyMsgMs : null,
    msPerTickerSinceLastTick: tickerAges,
  };
}
/**
 * Returns true when any tracked series is within EVALUATION_BUFFER_SECS of its
 * close time — i.e. we're approaching the 2-minute evaluation window and need
 * aggressive REST polling. Returns true also when state is unknown (no close
 * time yet) so the first fetch always goes through.
 *
 * Outside this window the 45-second reconcile timer keeps state current without
 * hammering Kalshi and triggering rate limits.
 */
function isNearEvaluationWindow(): boolean {
  for (const series of TRACKED_SERIES) {
    const ticker = currentTickerBySeries.get(series);
    if (!ticker) return true; // no state yet — fetch eagerly to initialize
    const state = marketState.get(ticker);
    if (!state?.closeTime) return true; // unknown close time — fetch eagerly
    const secs = secondsUntil(state.closeTime);
    if (secs === null || secs <= TIME_ALERT_SECONDS + EVALUATION_BUFFER_SECS) return true;
  }
  return false;
}

export interface AutoTraderStatus {
  /** True when WS is connected AND we've received a tick within STALE_WS_MS. */
  wsLive:        boolean;
  /** Wall-clock ms of the most recent WS tick across all tracked series (0 if none). */
  lastTickMs:    number;
  /** Whether the last evaluation was driven by WS or REST. */
  source:        "websocket" | "rest_fallback";
  /** Current open ticker for the most recently active series, empty string if none. */
  currentTicker: string;
}
export function startAutoTrader(): void {
  logger.info(
    {
      series:                TRACKED_SERIES,
      alert_min:             ALERT_MIN,
      alert_max:             ALERT_MAX,
      price_floor_cents:     PRICE_FLOOR_CENTS,
      price_cap_cents:       PRICE_CAP_CENTS,
      time_alert_seconds:    TIME_ALERT_SECONDS,
      bet_dollars_eth:       SERIES_CONFIG.KXETH15M.betDollars,
      production_new_entry_series: [WEEK_2_PRODUCTION_NEW_ENTRY_SERIES],
      research_and_telemetry_series: "disabled_in_live_execution",
      entry_series_policy: ACTIVE_ENTRY_SERIES_POLICY,
      order_cooldown_ms:     ORDER_COOLDOWN_MS,
      stale_ws_ms:           STALE_WS_MS,
      reconcile_interval_ms: RECONCILE_INTERVAL_MS,
      driven_by:             "websocket+rest_fallback",
      safety_layers:         "price_band_guard, cooldown, window_budget, kill_switch, dedup, daily_cap, position_guard, submission_in_flight",
    },
    "AutoTrader: starting server-side trading loop",
  );

  configureEthBoundarySettlementOrchestration();
  configureEth420BoundarySettlementOrchestration();

  // PRIMARY: WebSocket ticker events
  kalshiStream.on("ticker", onWsTick);
  // Lifecycle activation is the primary rollover signal. The callback only
  // begins the existing identity-checked REST/evaluate path; it never submits.
  kalshiStream.on("market_lifecycle", onEthMarketLifecycle);
  // Pre-open announcements are data-plane hints only. The scheduled callback
  // still requires a fresh, post-boundary active-market response before it can
  // enter restFetchSeries() and the normal evaluator.
  kalshiStream.on("upcoming_market", scheduleEthBoundaryDiscovery);
  startKalshiAuthTransportPrewarm();

  // ── Final-window coverage watchdog (observability + data-plane recovery) ──
  // Detects a missing usable quote during the final 120 s, records one durable
  // incident per ticker/window, and triggers a bounded, rate-limited data-plane
  // recovery (refresh/resubscribe/reconnect only). It never invokes any order
  // path and never changes guards, candidates, sizing, or exits.
  setCoverageWsConnectedProbe(() => kalshiStream.isConnected());
  setCoverageRecoveryHandler(async ({ ticker, reason }) => {
    // Strictly data-plane only: reconnect/resubscribe must never enter the
    // merge/evaluate path. Recovered stream data is observed naturally by the
    // normal WS handler; the watchdog itself cannot create an extra evaluation
    // or order opportunity.
    void ticker; // ticker remains part of the auditable recovery request.
    return kalshiStream.recoverMarketData(reason);
  });
  const coverageTimer = setInterval(() => {
    try { runCoverageCheck(); } catch (err) {
      logger.warn({ err }, "AutoTrader: coverage check failed");
    }
  }, 5_000);
  if (coverageTimer.unref) coverageTimer.unref();

  // FALLBACK: fire REST when WS is disconnected or has gone silent.
  //
  // Only poll at the fast rate (every 5 s) when approaching the evaluation
  // window. Outside that buffer the 45-second reconcile timer keeps market
  // state current without hammering Kalshi and triggering 429 rate limits.
  // Log the "stale" notice at most once per minute to keep logs readable.
  let lastStaleLogMs = 0;
  const fallbackTimer = setInterval(() => {
    if (!isWsStale()) return;
    if (!isNearEvaluationWindow()) return; // quiet period — reconcile timer handles it
    const now = Date.now();
    if (now - lastStaleLogMs > 60_000) {
      logger.info(
        wsHealthDiag(),
        "AutoTrader: WS stale — using REST fallback (near evaluation window)",
      );
      lastStaleLogMs = now;
    }
    restFetchAll("rest_fallback").catch(() => { /* logged inside */ });
  }, FALLBACK_POLL_MS);

  // RECONCILIATION: periodic REST check regardless of WS health.
  //
  // Before each tick we check proximity to the KalshiStream ticker refresh
  // (which fires every TICKER_REFRESH_MS).  If the tick falls within
  // STREAM_GUARD_MS of the last refresh (or of the next expected one) we skip
  // it — this guarantees the two timers never submit concurrent Kalshi REST
  // requests regardless of startup phase or drift.
  const reconcileTimer = setInterval(
    () => _runReconcileTickCallback(Date.now(), kalshiStream.lastRefreshAtMs),
    RECONCILE_INTERVAL_MS,
  );

  if (fallbackTimer.unref)  fallbackTimer.unref();
  if (reconcileTimer.unref) reconcileTimer.unref();

  // TICK SNAPSHOT: 1-second high-resolution recorder for post-entry windows.
  //
  // During the last TIME_ALERT_SECONDS of each window we record a tick row at
  // most once per second from the cached market state.  recordWindowTick() has
  // built-in per-second dedup, so the WebSocket path (which also calls it)
  // never double-writes; this timer simply fills the gap when the WS is quiet
  // or the REST fallback fires only every ~5 s.
  //
  // No Kalshi API call is made — we read from the in-memory marketState cache.
  // Fire-and-forget; silently ignored when no state is cached for a series.
  const tickSnapshotTimer = setInterval(() => {
    const nowMs = Date.now();
    for (const series of TRACKED_SERIES) {
      const ticker = currentTickerBySeries.get(series);
      if (!ticker) continue;
      const state = marketState.get(ticker);
      if (!state?.closeTime) continue;
      const secondsLeft = secondsUntil(state.closeTime);
      if (secondsLeft === null || secondsLeft <= 0 || secondsLeft > TIME_ALERT_SECONDS) continue;

      // Derive ask prices (same logic as evaluate())
      const yesDerivedAsk = state.noBid  != null ? 100 - state.noBid  : null;
      const noDerivedAsk  = state.yesBid != null ? 100 - state.yesBid : null;

      recordWindowTick({
        ticker,
        timestampMs:   nowMs,
        secondsLeft,
        yesBid:        state.yesBid,
        yesAsk:        state.yesAsk,
        noBid:         state.noBid,
        noAsk:         state.noAsk,
        derivedYesAsk: yesDerivedAsk,
        derivedNoAsk:  noDerivedAsk,
        inZone: (
          (yesDerivedAsk != null && yesDerivedAsk >= ALERT_MIN && yesDerivedAsk <= ALERT_MAX) ||
          (noDerivedAsk  != null && noDerivedAsk  >= ALERT_MIN && noDerivedAsk  <= ALERT_MAX)
        ),
        source: "snapshot_timer",
      });
    }
  }, 1_000);

  if (tickSnapshotTimer.unref) tickSnapshotTimer.unref();

  // STARTUP PRIME: fetch market state immediately so closeTime is populated
  // before the first WS tick or reconcile interval fires.  Without this, a
  // restart during the last 2 minutes of a window would delay the first order
  // evaluation by up to 45 s (RECONCILE_INTERVAL_MS).
  restFetchAll("startup_prime").catch(() => { /* logged inside restFetchSeries */ });

  // Readiness banner: emitted once the WS listener, fallback timer, reconcile
  // timer, and startup prime are all armed.  Appears in fetchDeploymentLogs
  // immediately after the cold-start banner so both can be found together.
  logger.info(
    {
      series:            TRACKED_SERIES,
      fallback_poll_ms:  FALLBACK_POLL_MS,
      reconcile_ms:      RECONCILE_INTERVAL_MS,
      stream_guard_ms:   STREAM_GUARD_MS,
    },
    "AutoTrader: tick loop armed",
  );
}

export function getAutoTraderStatus(): AutoTraderStatus {
  const now     = Date.now();
  let lastTickMs = 0;
  let currentTicker = "";

  for (const series of TRACKED_SERIES) {
    const ticker = currentTickerBySeries.get(series);
    if (!ticker) continue;
    const t = lastWsTickMs.get(ticker) ?? 0;
    if (t > lastTickMs) {
      lastTickMs    = t;
      currentTicker = ticker;
    }
  }

  const wsLive = kalshiStream.isConnected() && lastTickMs > 0 && now - lastTickMs < STALE_WS_MS;

  return {
    wsLive,
    lastTickMs,
    source:        wsLive ? "websocket" : "rest_fallback",
    currentTicker,
  };
}

/** The exchange shard for the currently discovered KXETH15M market, if any. */
export function getCurrentEthExchangeIndex(): number | null {
  const ticker = currentTickerBySeries.get("KXETH15M");
  const exchangeIndex = ticker == null ? null : marketState.get(ticker)?.exchangeIndex;
  return typeof exchangeIndex === "number" && Number.isInteger(exchangeIndex) && exchangeIndex >= 0
    ? exchangeIndex
    : null;
}

/** Read-only copy of the currently discovered ETH 15-minute market cache. */
export interface CurrentEthMarketSnapshot {
  ticker: string;
  exchangeIndex: number | null;
  openTime: string | null;
  closeTime: string | null;
  status: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  floorStrike: number | null;
  quoteUpdatedAtMs: number | null;
  rulesObservedAtMs: number | null;
}

/**
 * Returns only the passive in-memory market observation. This function never
 * fetches, evaluates, reserves, or submits an order.
 */
export function getCurrentEthMarketSnapshot(): CurrentEthMarketSnapshot | null {
  const ticker = currentTickerBySeries.get("KXETH15M");
  const state = ticker == null ? undefined : marketState.get(ticker);
  if (!state) return null;
  return {
    ticker: state.ticker,
    exchangeIndex: typeof state.exchangeIndex === "number" && Number.isInteger(state.exchangeIndex)
      && state.exchangeIndex >= 0 ? state.exchangeIndex : null,
    openTime: state.openTime,
    closeTime: state.closeTime,
    status: state.status,
    yesBid: state.yesBid,
    yesAsk: state.yesAsk,
    noBid: state.noBid,
    noAsk: state.noAsk,
    floorStrike: state.floorStrike ?? null,
    quoteUpdatedAtMs: Number.isFinite(state.bidUpdatedMs) && state.bidUpdatedMs > 0 ? state.bidUpdatedMs : null,
    rulesObservedAtMs: state.rulesObservedAtMs ?? null,
  };
}

/**
 * Constant re-exports so tests can reference the production values without
 * hard-coding them.  Follows the _*ForTesting naming convention.
 */
export const STALE_WS_MS_FOR_TESTING      = STALE_WS_MS;

/** Exported constants so timer tests can reference canonical values without hard-coding. */
export function _getReconcileIntervalMsForTesting(): number { return RECONCILE_INTERVAL_MS; }

/**
 * The full body of the reconcile timer callback.  Called directly by the
 * production setInterval (startAutoTrader) and also exported so tests can:
 *   (a) call it directly to verify guard logic without fake timers, and
 *   (b) start it via _startReconcileTimerForTesting + mock.timers to prove
 *       the 45-second wiring — because production calls this same function,
 *       fake-timer tests of the helper are equivalent to fake-timer tests of
 *       the production timer.
 *
 * In tests, logger.info is a harmless no-op (handled by esbuild-plugin-pino).
 */
export function _runReconcileTickCallback(nowMs: number, lastRefreshAtMs: number): void {
  const msSinceRefresh = lastRefreshAtMs > 0 ? nowMs - lastRefreshAtMs : TICKER_REFRESH_MS;
  const msUntilRefresh = TICKER_REFRESH_MS - (msSinceRefresh % TICKER_REFRESH_MS);

  if (msSinceRefresh < STREAM_GUARD_MS || msUntilRefresh < STREAM_GUARD_MS) {
    logger.info(
      {
        ms_since_refresh: msSinceRefresh,
        ms_until_refresh: msUntilRefresh,
        stream_guard_ms:  STREAM_GUARD_MS,
      },
      "AutoTrader: reconcile tick skipped — within stream refresh guard window",
    );
    return;
  }

  (_restFetchAllImpl ?? restFetchAll)("rest_fallback").catch(() => { /* logged inside */ });
}

export function _getStreamGuardMsForTesting(): number       { return STREAM_GUARD_MS; }

export const FALLBACK_POLL_MS_FOR_TESTING = FALLBACK_POLL_MS;

/**
 * Directly register a series → ticker mapping in currentTickerBySeries.
 * Required by tests that need a known ticker present so isWsStale() can
 * compare lastWsTickMs against STALE_WS_MS (the loop skips series with
 * no registered ticker).
 */
export function _setCurrentTickerBySeriesForTesting(
  series: string,
  ticker: string,
): void {
  currentTickerBySeries.set(series, ticker);
}

/**
 * Execute the fallback poller body directly — equivalent to the setInterval
 * callback firing after FALLBACK_POLL_MS has elapsed.  Tests inject
 * _restFetchAllImpl before calling this to observe whether the fallback
 * fires without making live Kalshi REST calls.
 *
 * The per-minute log throttle (lastStaleLogMs) is omitted intentionally;
 * the test concern is whether restFetchAll is called, not the log line.
 */
export function _runFallbackPollForTesting(): void {
  if (!isWsStale()) return;
  if (!isNearEvaluationWindow()) return;
  (_restFetchAllImpl ?? restFetchAll)("rest_fallback").catch(() => { /* logged inside */ });
}

/**
 * Expose isWsStale() for tests that need to assert the staleness predicate
 * directly, without going through the fallback timer.
 */
export function _isWsStaleForTesting(): boolean {
  return isWsStale();
}

/**
 * Directly set lastWsTickMs for a ticker.  Lets tests inject a specific
 * timestamp without triggering the full onWsTick() / mergeState() cascade.
 */
export function _setLastWsTickMsForTesting(ticker: string, ms: number): void {
  lastWsTickMs.set(ticker, ms);
}
