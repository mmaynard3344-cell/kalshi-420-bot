/**
 * Durable SQL storage wrapper for all production trading state.
 *
 * This module is the single integration point between the trading path and the
 * PostgreSQL database. All SQL reads and writes go through here. Trading modules
 * (trade.ts, autoTrader.ts, passiveObserver.ts, windowLog.ts) import from this
 * module — this module never imports from them.
 *
 * Safety contract:
 *   • isStorageHealthy() === false → claimOrderSlot in trade.ts returns false
 *     → no order is placed until storage recovers.
 *   • reserveAndRecord() fails → caller must abort the Kalshi API call.
 *   • All non-critical writes (observations, window log, market results) are
 *     fire-and-forget; failures are logged but never block trading.
 *
 * Startup sequence (index.ts):
 *   await initTradeStore()               — connect, verify schema
 *   const state = await restoreState()   — read SQL budget + dedup
 *   applyRestoredBudget(state)           — update in-memory budget (trade.ts)
 *   applyRestoredDedup(state)            — update in-memory dedup (trade.ts)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join }                     from "node:path";
import { createHash, randomUUID }   from "node:crypto";
import { sql, eq, ne, not, gt, lt, and, gte, lte, inArray, asc, desc, isNull, isNotNull, or } from "drizzle-orm";
import type { OrderAttemptRecord, ReconciliationParams, SubmissionAudit } from "./analytics.js";
import type { L2Level } from "./orderbookParsing.js";
import type { PreflightDecision } from "./preflightStore.js";
import type { NodePgDatabase }  from "drizzle-orm/node-postgres";
import type { PassiveObservation } from "./passiveObserver.js";
import type { WindowLogEntry }      from "./windowLog.js";
import { logger }                   from "./logger.js";
import { easternDay }               from "./dailyBudget.js";
import { advanceEth420CandidateSequence } from "./strategies/eth420CandidateState.js";

const ETH420_CANDIDATE_STATE_KEY = "eth420_6_step_reset_shadow_only";
const ETH420_SECONDARY_ACTIVATION_CUTOVER_KEY = "eth420_secondary_activation_cutover_v1";
const ETH420_SECONDARY_RESERVATION_SEQUENCE_KEY = "eth420_secondary_reservation_sequence_v1";
import { PRICE_TIERS, buildTierSqlCaseString } from "./autoTraderGuards.js";

// ── Schema imports ────────────────────────────────────────────────────────────
// Imported from the main @workspace/db entry point (which re-exports schema).
// Using dynamic import for the `db` instance (see initTradeStore) keeps startup
// from crashing when DATABASE_URL is absent; these table-definition imports are
// pure compile-time references with no connection side-effects.
import {
  orderAttempts,
  orderFills,
  dailyBudget as dailyBudgetTable,
  orderDedup,
  marketResults,
  passiveObservations,
  malformedObservations,
  windowLogTable,
  strategyVersion,
  windowTicks,
  dailyGuardCounts,
  preflightDecisions,
  recoverabilitySpotTicks,
  recoverabilityObservations,
  recoverabilityMarketOutcomes,
  recoverabilityLabels,
  staleGapCounterfactualCaptures,
  phase4bMarketIntervals,
  phase4bDecisionSnapshots,
  phase4bBookSnapshots,
  phase4bReferenceObservations,
  phase4bMarketOutcomes,
  phase4bProspectiveSimulations,
  phase4bCompactLedgerCheckpoints,
  passiveExperimentRegistry,
  passiveExperimentCaptures,
  passiveExperimentSettlements,
  protectiveExitAttempts,
  exchangeSweepLog,
  evaluationEvents,
  coverageIncidents,
  coverageWindowAudits,
  greenZoneSnapshots,
  eth30TickerClaims,
  eth30StrategyOrders,
  eth30PositionEvents,
  eth30DecisionEvents,
  eth30ShadowObservations,
  eth30ShadowEvents,
  eth2125ProspectiveCohort,
  targetLiquiditySnapshots,
  sol30TickerClaims,
  sol30StrategyOrders,
  sol30PositionEvents,
  sol30DecisionEvents,
} from "@workspace/db";
import type { EvaluationEvent } from "./evaluationEventStore.js";
import { loadCoverageWindowAudits } from "./marketDataCoverage.js";
import type { CoverageIncident, CoverageWindowAudit } from "./marketDataCoverage.js";
// WindowTick inline type (avoids circular import — windowTickStore imports from this module)
interface WindowTick {
  ticker:        string;
  timestampMs:   number;
  secondsLeft:   number;
  yesBid:        number | null;
  yesAsk:        number | null;
  noBid:         number | null;
  noAsk:         number | null;
  derivedYesAsk: number | null;
  derivedNoAsk:  number | null;
  inZone:        boolean;
  source:        string;
}

// ── Order dedup window (must match trade.ts / autoTrader.ts) ──────────────────
const ORDER_DEDUP_WINDOW_MS = 20 * 60_000; // 20 minutes
// Keep the report boundary aligned with the immutable prospective-cohort
// contract in compactShadowWorker. This must be the 2026 freeze, not the
// similarly dated 2025 epoch.
const COMPACT_NORMALIZED_DISTANCE_EXPERIMENT_START_MS = Date.parse("2026-08-21T23:00:24.446Z");

/** Production readers always exclude persisted fixtures. Test runners can opt
 * in only to inspect their own explicitly marked rows. */
function realOrderPredicate() {
  return process.env["TRADE_STORE_INCLUDE_SYNTHETIC_FOR_TESTS"] === "true"
    ? undefined
    : eq(orderAttempts.isSynthetic, false);
}

/** The immutable identity required before a generic reconciliation may mutate. */
export interface ReconciliationOwnershipIdentity {
  attemptId: string;
  orderId: string;
  ticker: string;
}

/**
 * Read-only preflight for reconciliation callers. The corresponding mutation
 * transactions repeat this exact predicate so a concurrent change cannot turn
 * a successful preflight into an unbound write.
 */
export async function verifyReconciliationOwnership(
  identity: ReconciliationOwnershipIdentity,
): Promise<boolean> {
  if (!_db || !_healthy || !identity.attemptId || !identity.orderId || !identity.ticker) return false;
  try {
    const rows = await _db
      .select({ id: orderAttempts.id })
      .from(orderAttempts)
      .where(and(
        eq(orderAttempts.id, identity.attemptId),
        eq(orderAttempts.orderId, identity.orderId),
        eq(orderAttempts.ticker, identity.ticker),
        realOrderPredicate(),
      ));
    return rows.length === 1;
  } catch (err) {
    logger.warn({ err, identity }, "tradeStore: reconciliation ownership verification failed");
    return false;
  }
}

// ── Reconnect retry schedule ───────────────────────────────────────────────────
// Delays (ms) for successive reconnect attempts: 1s, 3s, 10s, 30s, then 60s cap.
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000];
const ETH_MARTINGALE_LEDGER_READ_TIMEOUT_MS = 4_000;

// ── Module state ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: NodePgDatabase<any> | null = null;
type BoundedReadClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};
let _withBoundedReadOnlyClient: (<T>(
  timeoutMs: number,
  operation: (client: BoundedReadClient) => Promise<T>,
) => Promise<T>) | null = null;
type BoundedReadOnlyStatus = {
  activeReadCount: number;
  queueDepth: number;
  maxConcurrentReads: number;
  reservedSafetyClients: number;
};
let _getBoundedReadOnlyStatus: (() => BoundedReadOnlyStatus) | null = null;
let _ethMartingaleLedgerReadTimeoutMs = ETH_MARTINGALE_LEDGER_READ_TIMEOUT_MS;
let _healthy         = false;
let _degradedReason  = "";
let _lastWriteMs:     number | null = null;

// Emergency reduction is an operator-only, single-runner capability. Keep its
// durable state out of the latency-sensitive entry transaction: on startup the
// fence is hydrated from SQL, a committed emergency reservation closes it, and
// normal entry only reads this in-process value.
//
// A false value is assigned only after an authenticated startup read proves no
// emergency lifecycle exists. Any unavailable/ambiguous startup read remains
// closed, so a restart cannot accidentally admit new candidate exposure.
let _eth420CandidateEmergencyFenceActive = true;
let _eth420CandidateEmergencyLifecycleDurable = true;

function beginEth420CandidateEntryReservation(): boolean {
  return !_eth420CandidateEmergencyFenceActive;
}

async function hydrateEth420CandidateEmergencyFence(): Promise<void> {
  _eth420CandidateEmergencyFenceActive = true;
  _eth420CandidateEmergencyLifecycleDurable = true;
  if (!_db || !_healthy) return;
  try {
    const result = await _db.execute(sql`
      SELECT 1 FROM eth420_candidate_emergency_reductions LIMIT 1`);
    _eth420CandidateEmergencyLifecycleDurable =
      (result as unknown as { rows: unknown[] }).rows.length > 0;
    _eth420CandidateEmergencyFenceActive = _eth420CandidateEmergencyLifecycleDurable;
  } catch (err) {
    logger.warn({ err }, "ETH420 emergency fence hydration unavailable; new candidate entries remain blocked");
  }
}

/** Test seam only. Production state is established by startup hydration and
 * never reopened after an emergency lifecycle has been durably recorded. */
export function _setEth420CandidateEmergencyFenceForTesting(active: boolean): void {
  _eth420CandidateEmergencyFenceActive = active;
  _eth420CandidateEmergencyLifecycleDurable = active;
}

// Connection health tracking (exported for /trade/status)
let _lastErrorMsg:    string        = "";
let _lastSuccessAt:   number | null = null;
let _retryCount:      number        = 0;
let _lastAttemptAt:   number | null = null;
let _retryTimer:      ReturnType<typeof setTimeout> | null = null;
let _retryScheduled:  boolean       = false;
let _dbOutage: {
  id: string; startedAtMs: number; reconnectAttempts: number;
  entryBlocked: boolean; reconciliationBlocked: boolean; protectiveExitBlocked: boolean;
} | null = null;

// ── Pool recreation on persistent connect failure ─────────────────────────────
// A provider-side endpoint move (or half-dead keepalive sockets) can leave the
// original pg Pool permanently unable to connect — every ping times out even
// after the database itself has recovered (observed live 2026-08-15: 16+
// consecutive "timeout exceeded when trying to connect" reconnect failures
// over 45+ minutes against the same pool).  After this many consecutive ping
// failures, the reconnect loop tears down the pool and builds a fresh one
// (new sockets, fresh DNS) before the next ping.
const POOL_RESET_AFTER_FAILURES = 3;
let _consecutivePingFailures = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _poolResetHook: (() => Promise<NodePgDatabase<any>>) | null = null;

/** Test-only: inject a fake pool-reset implementation (null to disable). */
export function _setPoolResetHookForTesting(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hook: (() => Promise<NodePgDatabase<any>>) | null,
): void {
  _poolResetHook = hook;
  _consecutivePingFailures = 0;
}

/** Test-only: current consecutive-ping-failure count. */
export function _getConsecutivePingFailuresForTesting(): number {
  return _consecutivePingFailures;
}

/**
 * If pings have failed persistently, recreate the pg Pool via the configured
 * hook so the next ping runs against fresh sockets.  Never throws — a failed
 * reset leaves the old pool in place and the normal retry loop continues.
 */
async function _maybeResetPool(): Promise<void> {
  if (_consecutivePingFailures < POOL_RESET_AFTER_FAILURES || !_poolResetHook) return;
  try {
    logger.warn(
      { consecutivePingFailures: _consecutivePingFailures },
      "tradeStore: persistent connect failures — recreating database pool (fresh sockets/DNS)",
    );
    _db = await _poolResetHook();
    _consecutivePingFailures = 0;
  } catch (err) {
    logger.error({ err }, "tradeStore: database pool recreation failed — keeping existing pool");
  }
}

// Snapshot captured during the last restoreState() call (for /storage/status)
let _restoredSpentCents  = 0;
let _restoredDedupSlots  = 0;


// ── Pending-finalisation queue ────────────────────────────────────────────────
// Operations that arrive while the DB is unhealthy (or that throw during an
// attempted write) are buffered here and replayed as soon as the connection
// recovers.  Without this, a brief DB outage after reserveAndRecord() leaves
// rows permanently stuck in UNRESOLVED_OUTCOMES (reserved / post_started),
// making them invisible to the dashboard and analytics.
//
// Two operation kinds are supported:
//   "finalise"        — UPDATE order_attempts only (fill, zero-fill, etc.)
//   "release_rejected"— UPDATE order_attempts + budget decrement + dedup
//                       delete, all in a single transaction.

interface PendingFinalise {
  kind:   "finalise";
  params: FinaliseParams;
}
interface PendingReleaseRejected {
  kind:   "release_rejected";
  params: {
    clientOrderId: string;
    ticker:        string;
    side:          "yes" | "no";
    easternDate:   string;
    notionalCents: number;
  };
}
type PendingOperation = PendingFinalise | PendingReleaseRejected;

const _pendingFinalisations = new Map<string, PendingOperation>();

/** Number of operations waiting for DB recovery (exposed via storage status). */
export function getPendingFinalisationCount(): number {
  return _pendingFinalisations.size;
}

/**
 * For integration tests only: explicitly invoke the drain without waiting for
 * the reconnect timer.  Production code must not call this.
 */
export async function _drainPendingFinalisationsForTesting(): Promise<void> {
  return _drainPendingFinalisations();
}

/**
 * Replay all queued operations.  Called immediately after _attemptPing()
 * succeeds so that rows stuck in UNRESOLVED_OUTCOMES are resolved as quickly
 * as possible without blocking the reconnect path.
 */
async function _drainPendingFinalisations(): Promise<void> {
  if (_pendingFinalisations.size === 0) return;
  logger.info(
    { count: _pendingFinalisations.size },
    "tradeStore: draining pending finalisations after DB recovery",
  );
  // Snapshot keys so new entries arriving during the drain are not processed
  // out-of-order; they will be picked up on the next drain cycle.
  const entries = [..._pendingFinalisations.entries()];
  for (const [clientOrderId, op] of entries) {
    try {
      if (op.kind === "finalise") {
        const p = op.params;
        await _db!
          .update(orderAttempts)
          .set({
            outcome:            p.outcome,
            orderId:            p.orderId           ?? null,
            fillCount:          p.fillCount         ?? null,
            remainingCount:     p.remainingCount    ?? null,
            contracts:          p.contracts         ?? null,
            fillPriceCents:     p.fillPriceCents    ?? null,
            notionalDollars:    p.notionalDollars   ?? null,
            feeDollars:         p.feeDollars        ?? null,
            roundTripMs:        p.roundTripMs       ?? null,
            zeroFillDiagnostic: p.zeroFillDiagnostic ?? null,
            fillPriceSource:    p.fillPriceSource   ?? null,
            updatedAt:          new Date(),
          })
          .where(eq(orderAttempts.id, clientOrderId));
      } else {
        // "release_rejected": full three-step transaction (idempotent via
        // GREATEST(0, …) on budget and onConflictDoNothing on dedup delete).
        const rp = op.params;
        await _db!.transaction(async (tx) => {
          await tx.update(orderAttempts)
            .set({ outcome: "post_rejected", updatedAt: new Date() })
            .where(eq(orderAttempts.id, rp.clientOrderId));
          await tx.update(dailyBudgetTable)
            .set({
              spentCents: sql`GREATEST(0, ${dailyBudgetTable.spentCents} - ${rp.notionalCents})`,
              updatedAt:  new Date(),
            })
            .where(eq(dailyBudgetTable.easternDate, rp.easternDate));
          await tx.delete(orderDedup)
            .where(eq(orderDedup.tickerKey, `${rp.ticker}-${rp.side}`));
        });
      }
      _pendingFinalisations.delete(clientOrderId);
      _lastWriteMs = Date.now();
      logger.info(
        { clientOrderId, kind: op.kind },
        "tradeStore: drained pending finalisation — row now visible in dashboard",
      );
    } catch (err) {
      // Leave in queue; the next reconnect will retry.
      logger.warn(
        { err, clientOrderId, kind: op.kind },
        "tradeStore: drain failed for pending finalisation — will retry on next recovery",
      );
    }
  }
}

type PendingDurableWrite =
  | { kind: "window_log";          entry: WindowLogEntry }
  | { kind: "window_tick";         tick: WindowTick }
  | { kind: "guard_counts";        easternDate: string; countsMap: Map<string, Record<string, number>> }
  | { kind: "settlement";          ticker: string; result: "yes" | "no" }
  | { kind: "eval_event";          id: string; event: EvaluationEvent }
  | { kind: "coverage_incident";   incident: CoverageIncident }
  | { kind: "coverage_window_audit"; audit: CoverageWindowAudit }
  | { kind: "kalshi_read_network"; event: KalshiReadNetworkAuditInput }
  | { kind: "pe_monitor_incident"; incident: ProtectiveExitMonitorIncident };

/**
 * High-severity protective-exit monitor incident: a locally confirmed entry
 * could not be verified against the exchange while the market was (or may
 * have been) at/below the protective floor.
 */
export interface ProtectiveExitMonitorIncident {
  id: string;
  ticker: string;
  detectedAtMs: number;
  kind: string;
  severity: "high";
  localSide: "yes" | "no" | null;
  localQuantity: number | null;
  executableBidCents: number | null;
  details: string;
  /** Null = unacknowledged; epoch ms when an operator marked it reviewed. */
  acknowledgedAt: number | null;
}

/** Fire-and-forget durable incident write with buffer replay on DB failure. */
export function recordProtectiveExitMonitorIncident(incident: ProtectiveExitMonitorIncident): void {
  _fireDurableWrite(`pemi:${incident.id}`, { kind: "pe_monitor_incident", incident }, "recordProtectiveExitMonitorIncident");
  // Notify SSE clients immediately (import is deferred to avoid circular deps
  // between tradeStore and routes/stream at module-load time).
  import("./tradeEvents").then(({ emitPeMonitorIncident }) => {
    emitPeMonitorIncident(incident);
  }).catch(() => { /* non-critical */ });
}

/** Read-only loader for analytics/health surfaces. Newest first.
 *  @param limit     Maximum rows to return (1–500).
 *  @param onlyUnacknowledged  When true, only rows with acknowledged_at IS NULL are returned.
 */
export async function loadProtectiveExitMonitorIncidents(
  limit = 100,
  onlyUnacknowledged = false,
): Promise<ProtectiveExitMonitorIncident[]> {
  if (!_db || !_healthy) return [];
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const result = onlyUnacknowledged
    ? await _db.execute(sql`
        SELECT id, ticker, detected_at_ms, kind, severity, local_side, local_quantity,
               executable_bid_cents, details, acknowledged_at
        FROM protective_exit_monitor_incidents
        WHERE acknowledged_at IS NULL
        ORDER BY detected_at_ms DESC
        LIMIT ${safeLimit}
      `)
    : await _db.execute(sql`
        SELECT id, ticker, detected_at_ms, kind, severity, local_side, local_quantity,
               executable_bid_cents, details, acknowledged_at
        FROM protective_exit_monitor_incidents
        ORDER BY detected_at_ms DESC
        LIMIT ${safeLimit}
      `);
  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  return rows.map((row) => ({
    id: String(row["id"]),
    ticker: String(row["ticker"]),
    detectedAtMs: Number(row["detected_at_ms"]),
    kind: String(row["kind"]),
    severity: "high" as const,
    localSide: (row["local_side"] === "yes" || row["local_side"] === "no") ? row["local_side"] : null,
    localQuantity: row["local_quantity"] == null ? null : Number(row["local_quantity"]),
    executableBidCents: row["executable_bid_cents"] == null ? null : Number(row["executable_bid_cents"]),
    details: String(row["details"] ?? ""),
    acknowledgedAt: row["acknowledged_at"] == null ? null : Number(row["acknowledged_at"]),
  }));
}

/**
 * Mark a protective-exit monitor incident as acknowledged by an operator.
 * The row is retained for audit purposes; only `acknowledged_at` is set.
 * Returns true if the row was updated, false if not found or already acknowledged.
 */
export async function acknowledgeProtectiveExitMonitorIncident(id: string): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    const nowMs = Date.now();
    const result = await _db.execute(sql`
      UPDATE protective_exit_monitor_incidents
      SET acknowledged_at = ${nowMs}
      WHERE id = ${id} AND acknowledged_at IS NULL
    `);
    const affected = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    return affected > 0;
  } catch (err) {
    logger?.warn({ err, id }, "acknowledgeProtectiveExitMonitorIncident failed");
    return false;
  }
}
export interface KalshiReadNetworkAuditInput {
  endpointCategory: string;
  errorClass: string | null;
  elapsedMs: number;
  retryCount: number;
  recoveryOutcome: "recovered" | "failed";
}

/** Safe, redacted GET-network telemetry. It contains no URL query, body, or credentials. */
export function recordKalshiReadNetworkEvent(event: KalshiReadNetworkAuditInput): void {
  const id = `kalshi-read:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  _fireDurableWrite(`krn:${id}`, { kind: "kalshi_read_network", event: { ...event } }, "recordKalshiReadNetworkEvent");
}
class DedupConflictError extends Error {
  constructor() { super("DEDUP_CONFLICT"); }
}

// ── Internal: connection helpers ──────────────────────────────────────────────

/**
 * Fire a lightweight SELECT 1 to confirm the pool can reach the database.
 * Updates _healthy, _lastSuccessAt, and _lastErrorMsg.
 * Throws on failure so callers can handle and schedule retries.
 */
async function _attemptPing(): Promise<void> {
  _lastAttemptAt = Date.now();
  try {
    await _db!.execute(sql`SELECT 1`);
  } catch (err) {
    _consecutivePingFailures++;
    throw err;
  }
  _consecutivePingFailures = 0;
  _healthy        = true;
  _degradedReason = "";
  _lastErrorMsg   = "";
  _lastSuccessAt  = Date.now();
}

function _beginDbOutage(): void {
  if (_dbOutage) return;
  _dbOutage = {
    id: `db-outage:${Date.now()}`, startedAtMs: Date.now(), reconnectAttempts: _retryCount,
    entryBlocked: false, reconciliationBlocked: false, protectiveExitBlocked: false,
  };
}

/** Records impact only; it deliberately does not change fail-closed behavior. */
export function recordDbBlockedOperation(kind: "entry" | "reconciliation" | "protective_exit"): void {
  _beginDbOutage();
  if (!_dbOutage) return;
  if (kind === "entry") _dbOutage.entryBlocked = true;
  else if (kind === "reconciliation") _dbOutage.reconciliationBlocked = true;
  else _dbOutage.protectiveExitBlocked = true;
}

async function _persistDbRecoveryAudit(recoveryOutcome: "recovered" | "failed"): Promise<void> {
  const outage = _dbOutage;
  if (!outage || !_db) return;
  try {
    await _db.execute(sql`
      INSERT INTO infrastructure_incidents
        (id, kind, started_at_ms, ended_at_ms, reconnect_attempts, pending_finalisations,
         pending_durable_writes, entry_blocked, reconciliation_blocked, protective_exit_blocked, recovery_outcome)
      VALUES (${outage.id}, 'database', ${outage.startedAtMs}, ${Date.now()}, ${outage.reconnectAttempts},
        ${_pendingFinalisations.size}, ${_pendingDurableWrites.size}, ${outage.entryBlocked},
        ${outage.reconciliationBlocked}, ${outage.protectiveExitBlocked}, ${recoveryOutcome})
      ON CONFLICT (id) DO UPDATE SET
        ended_at_ms             = EXCLUDED.ended_at_ms,
        reconnect_attempts      = EXCLUDED.reconnect_attempts,
        pending_finalisations   = EXCLUDED.pending_finalisations,
        pending_durable_writes  = EXCLUDED.pending_durable_writes,
        entry_blocked           = EXCLUDED.entry_blocked,
        reconciliation_blocked  = EXCLUDED.reconciliation_blocked,
        protective_exit_blocked = EXCLUDED.protective_exit_blocked,
        recovery_outcome        = EXCLUDED.recovery_outcome
    `);
    if (recoveryOutcome === "recovered") _dbOutage = null;
  } catch (err) {
    logger.warn({ err, incidentId: outage.id }, "tradeStore: unable to persist database recovery audit");
  }
}

/**
 * Schedule an exponential-backoff reconnect attempt.
 * Safe to call multiple times; only one timer is active at a time.
 * Keeps retrying until the connection is restored.
 */
function _scheduleRetry(): void {
  _beginDbOutage();
  if (_retryScheduled) return; // guard against double-scheduling
  if (!_db)            return; // no pool (DATABASE_URL missing) — restart required
  _retryScheduled = true;
  const delayMs = RETRY_DELAYS_MS[Math.min(_retryCount, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
  logger.info(
    { retryCount: _retryCount, delayMs },
    "tradeStore: scheduling database reconnect attempt",
  );
  _retryTimer = setTimeout(() => { void _executeRetryAttempt(); }, delayMs);
}

/** One reconnect attempt: optional pool rebuild, ping, audit, drain-on-success. */
async function _executeRetryAttempt(): Promise<void> {
  _retryScheduled = false;
  _retryTimer     = null;
  _retryCount++;
  if (_dbOutage) _dbOutage.reconnectAttempts = _retryCount;
  logger.info({ retryCount: _retryCount }, "tradeStore: retrying database connection");
  try {
    await _maybeResetPool();
    await _attemptPing();
    await _persistDbRecoveryAudit("recovered");
    logger.info(
      { retryCount: _retryCount, lastSuccessAt: new Date(_lastSuccessAt!).toISOString() },
      "tradeStore: storage recovered — trading unblocked",
    );
    void _drainPendingFinalisations();
    void _drainPendingDurableWrites();
  } catch (err) {
    _lastErrorMsg   = String(err);
    _degradedReason = `DB reconnect failed (attempt ${_retryCount}): ${_lastErrorMsg}`;
    void _persistDbRecoveryAudit("failed");
    logger.error(
      { err, retryCount: _retryCount },
      "tradeStore: database reconnect failed — will retry",
    );
    _scheduleRetry(); // keep retrying until healthy
  }
}

/**
 * Test-only: cancel any pending retry timer and run one reconnect attempt
 * immediately (same code path the timer runs), so controlled-outage tests
 * don't wait out real backoff delays.
 */
export async function _runRetryAttemptNowForTesting(): Promise<void> {
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  _retryScheduled = false;
  return _executeRetryAttempt();
}

// ── Public: lifecycle ─────────────────────────────────────────────────────────

/**
 * Initialise the DB connection. Must be awaited before any order can be placed.
 * Accepts an optional override (used in tests to inject a mock DB).
 *
 * On transient connectivity failure, schedules exponential-backoff retries so
 * the process heals automatically without a restart.  DATABASE_URL missing is a
 * permanent misconfiguration — no retry is scheduled for that case.
 */
export async function initTradeStore(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOverride?: NodePgDatabase<any>,
): Promise<void> {
  // ── Test injection path (unit tests) ──────────────────────────────────────
  if (dbOverride !== undefined) {
    _db            = dbOverride;
    _withBoundedReadOnlyClient = null;
    _getBoundedReadOnlyStatus = null;
    _lastAttemptAt = Date.now();
    // Tests inject their own reset hook via _setPoolResetHookForTesting.
    _poolResetHook           = null;
    _consecutivePingFailures = 0;
    // Cancel any pending retry timer from a previous degraded state so the
    // retry loop doesn't fire against a stale _db reference.
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    _retryScheduled = false;
    _retryCount     = 0;
    // Always probe the override — ensures a broken DB sets _healthy=false
    // immediately (test 5 "outage" relies on this).  Do NOT schedule a retry
    // on failure: the test restores health by calling initTradeStore() again.
    try {
      await _attemptPing();
      // Test overrides commonly model only the callers under test. Do not add
      // emergency-ledger traffic to those injected database contracts.
      _eth420CandidateEmergencyFenceActive = false;
      logger.info("tradeStore: SQL storage initialised (test override) and healthy");
    } catch (err) {
      _healthy        = false;
      _lastErrorMsg   = String(err);
      _degradedReason = `DB override failed connectivity check: ${_lastErrorMsg}`;
      logger.warn({ err }, "tradeStore: test-override DB failed ping — degraded (no retry scheduled)");
    }
    return;
  }

  // ── Production path ───────────────────────────────────────────────────────
  logger.info("tradeStore: connecting to database");

  // Step 1: import the db module — throws immediately if DATABASE_URL is unset.
  // Dynamic import avoids crashing at module-load time; module cache means this
  // runs at most once.
  try {
    const mod = await import("@workspace/db");
    _db = mod.db;
    _withBoundedReadOnlyClient = mod.withBoundedReadOnlyClient;
    _getBoundedReadOnlyStatus = mod.getBoundedReadOnlyStatus;
    // Persistent connect failures trigger a full pool rebuild (fresh sockets)
    // via the reconnect loop — see _maybeResetPool().
    _poolResetHook = async () => (await import("@workspace/db")).resetDatabasePool();
  } catch (err) {
    // DATABASE_URL absent or module broken — permanent misconfiguration.
    // No retry: the process must be restarted with a valid DATABASE_URL.
    _db             = null;
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _lastAttemptAt  = Date.now();
    _degradedReason = `DB module unavailable (DATABASE_URL missing?): ${_lastErrorMsg}`;
    logger.error({ err }, "tradeStore: DB init FAILED — DATABASE_URL missing or module error, trading blocked");
    return;
  }

  // Step 2: probe connectivity with a lightweight query.
  // Failure here is likely transient (DB not yet ready, TCP reset, etc.).
  try {
    await _attemptPing();
    logger.info("tradeStore: database connected — storage healthy, trading permitted");
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `DB connectivity check failed at startup: ${_lastErrorMsg}`;
    logger.error(
      { err },
      "tradeStore: DB connectivity check FAILED — storage degraded, scheduling reconnect",
    );
    _scheduleRetry();
    return;
  }

  // Step 3: apply additive schema migrations (idempotent — safe to re-run).
  // These columns were added after initial table creation; IF NOT EXISTS guards
  // ensure existing production DBs are upgraded automatically on first startup.
  try {
    await _db!.execute(sql`
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS won boolean;
      ALTER TABLE window_log     ADD COLUMN IF NOT EXISTS settlement_result text;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS tick_received_ms bigint;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS eval_start_ms bigint;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS l2_start_ms bigint;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS l2_end_ms bigint;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS post_start_ms bigint;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS ack_ms bigint;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS l2_best_ask_cents integer;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS l2_depth_dollars double precision;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS l2_depth_contracts integer;
      CREATE TABLE IF NOT EXISTS preflight_decisions (
        id                        text PRIMARY KEY,
        timestamp_ms              bigint NOT NULL,
        eastern_date              text NOT NULL,
        ticker                    text NOT NULL,
        series                    text NOT NULL DEFAULT \'\',
        side                      text NOT NULL,
        seconds_left              integer NOT NULL,
        quoted_bbo_ask            integer,
        bbo_age_ms                integer,
        bbo_derived_limit_cents   integer NOT NULL,
        executable_best_ask_cents integer,
        bbo_to_l2_gap_cents       integer,
        verified_limit_cents      integer,
        depth_at_limit_dollars    double precision NOT NULL DEFAULT 0,
        depth_at_limit_contracts  integer NOT NULL DEFAULT 0,
        intended_contracts        integer NOT NULL DEFAULT 0,
        intended_notional_cents   integer NOT NULL DEFAULT 0,
        adjusted_contracts        integer NOT NULL DEFAULT 0,
        fill_fraction_estimate    double precision NOT NULL DEFAULT 0,
        near_limit_levels         text NOT NULL DEFAULT \'[]\',
        l2_fetch_latency_ms       integer,
        decision                  text NOT NULL,
        market_result             text,
        created_at                timestamp DEFAULT now()
      );
       CREATE TABLE IF NOT EXISTS green_zone_snapshots (
         id                            text PRIMARY KEY,
         attempt_id                    text NOT NULL UNIQUE,
         ticker                        text NOT NULL,
         asset                         text NOT NULL,
         side                          text NOT NULL,
         submission_timestamp_ms       bigint NOT NULL,
         executable_entry_price_cents  integer,
         seconds_left                  integer,
         quoted_bbo_ask_cents          integer,
         executable_l2_ask_cents       integer,
         signed_l2_to_bbo_cents        integer,
         bbo_age_ms                    integer,
         l2_depth_dollars              double precision,
         l2_depth_contracts            integer,
         preflight_timestamp_ms        bigint,
         unavailable_reason            text,
         schema_version                text NOT NULL DEFAULT 'green-zone-v1',
         created_at                    timestamp DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS green_zone_snapshots_ticker_idx ON green_zone_snapshots (ticker);
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS fill_price_source text;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS settlement_result text;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS settled_at_ms bigint;
       -- Kalshi supports fixed-point contract quantities (for example 0.01).
       -- Preserve quantities as decimals; prices and budget cents remain integers.
       ALTER TABLE order_attempts ALTER COLUMN fill_count TYPE double precision USING fill_count::double precision;
       ALTER TABLE order_attempts ALTER COLUMN remaining_count TYPE double precision USING remaining_count::double precision;
       ALTER TABLE order_attempts ALTER COLUMN contracts TYPE double precision USING contracts::double precision;
       ALTER TABLE order_fills ALTER COLUMN contracts TYPE double precision USING contracts::double precision;
       ALTER TABLE window_log ALTER COLUMN contracts_filled TYPE double precision USING contracts_filled::double precision;
      CREATE TABLE IF NOT EXISTS order_fills (
        id               text PRIMARY KEY,
        order_id         text NOT NULL,
        attempt_id       text,
        ticker           text NOT NULL,
        side             text NOT NULL,
        fill_price_cents integer NOT NULL,
         contracts        double precision NOT NULL,
        cost_dollars     double precision NOT NULL,
        fee_dollars      double precision NOT NULL,
        fill_timestamp   text,
        created_at       timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS order_fills_order_id_idx ON order_fills (order_id);
      ALTER TABLE order_fills ADD COLUMN IF NOT EXISTS fill_id text;
      ALTER TABLE order_fills ADD COLUMN IF NOT EXISTS exact_price_dollars numeric;
      ALTER TABLE order_fills ADD COLUMN IF NOT EXISTS exact_cost_dollars numeric;
      ALTER TABLE order_fills ADD COLUMN IF NOT EXISTS exact_fee_dollars numeric;
      ALTER TABLE order_fills ADD COLUMN IF NOT EXISTS canonical_economics boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS order_fills_fill_id_idx ON order_fills (fill_id);
      CREATE TABLE IF NOT EXISTS protective_exit_attempts (
        id text PRIMARY KEY, timestamp_ms bigint NOT NULL, ticker text NOT NULL,
        asset text NOT NULL, held_side text NOT NULL, linked_entry_id text,
        original_entry_price_cents integer, original_fill_quantity integer,
        confirmed_position_before integer NOT NULL, trigger_cents integer NOT NULL,
        executable_bid_cents integer, bid_depth_contracts integer,
        quote_timestamp_ms bigint, quote_age_ms integer, requested_contracts integer,
        limit_price_cents integer NOT NULL, time_in_force text NOT NULL,
        post_initiated boolean NOT NULL DEFAULT false, response_received boolean NOT NULL DEFAULT false,
        kalshi_order_id text, fill_quantity integer, average_exit_price_cents integer,
        remaining_position integer, outcome text NOT NULL, reason text, raw_book text,
        created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS protective_exit_attempts_ticker_idx ON protective_exit_attempts (ticker);
      CREATE INDEX IF NOT EXISTS protective_exit_attempts_timestamp_idx ON protective_exit_attempts (timestamp_ms);
      -- High-severity monitor incidents: confirmed local entry that the exit
      -- monitor could not verify while at/below (or unable to rule out) the
      -- protective floor. Append-only evidence, insert-once per id.
      CREATE TABLE IF NOT EXISTS protective_exit_monitor_incidents (
        id                   text PRIMARY KEY,
        ticker               text NOT NULL,
        detected_at_ms       bigint NOT NULL,
        kind                 text NOT NULL,
        severity             text NOT NULL DEFAULT 'high',
        local_side           text,
        local_quantity       integer,
        executable_bid_cents integer,
        details              text NOT NULL DEFAULT '',
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS pe_monitor_incidents_ticker_idx ON protective_exit_monitor_incidents (ticker);
      CREATE INDEX IF NOT EXISTS pe_monitor_incidents_detected_idx ON protective_exit_monitor_incidents (detected_at_ms);
       -- Records that the short post-order reconciliation window failed. The
       -- periodic recovery sweep retries these rows; daily P&L stays unavailable
       -- until a verified fill ledger has been persisted.
      -- Operator acknowledge flow for PE monitor incidents (added 2026-08-16).
      ALTER TABLE protective_exit_monitor_incidents ADD COLUMN IF NOT EXISTS acknowledged_at bigint;
      CREATE INDEX IF NOT EXISTS pe_monitor_incidents_unacked_idx
        ON protective_exit_monitor_incidents (detected_at_ms)
        WHERE acknowledged_at IS NULL;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS reconcile_failed boolean;
      -- Explicit fixture provenance is the only live-runtime exclusion rule.
      -- Existing rows retain the false default; no historical rows are inferred
      -- or rewritten from ticker names, dates, order IDs, or source strings.
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;
      ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS fixture_namespace text;
      CREATE INDEX IF NOT EXISTS order_attempts_real_orders_idx
        ON order_attempts (eastern_date, timestamp_ms)
        WHERE is_synthetic = false;
      -- Append-only, safe reconciliation failure evidence. Raw provider bodies
      -- and credentials are intentionally never stored here.
      CREATE TABLE IF NOT EXISTS reconciliation_failure_audits (
        id text PRIMARY KEY,
        order_id text NOT NULL,
        attempt_id text,
        ticker text,
        reason text NOT NULL,
        http_status integer,
        retry_attempt integer NOT NULL CHECK (retry_attempt >= 1),
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS reconciliation_failure_audits_order_idx
        ON reconciliation_failure_audits (order_id, occurred_at DESC);
       CREATE TABLE IF NOT EXISTS infrastructure_incidents (
         id text PRIMARY KEY, kind text NOT NULL, started_at_ms bigint NOT NULL,
         ended_at_ms bigint, reconnect_attempts integer NOT NULL DEFAULT 0,
         pending_finalisations integer NOT NULL DEFAULT 0, pending_durable_writes integer NOT NULL DEFAULT 0,
         entry_blocked boolean NOT NULL DEFAULT false, reconciliation_blocked boolean NOT NULL DEFAULT false,
         protective_exit_blocked boolean NOT NULL DEFAULT false, recovery_outcome text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS infrastructure_incidents_kind_started_idx
         ON infrastructure_incidents (kind, started_at_ms DESC);
       CREATE TABLE IF NOT EXISTS kalshi_read_network_events (
         id text PRIMARY KEY, endpoint_category text NOT NULL, error_class text,
         elapsed_ms integer NOT NULL, retry_count integer NOT NULL,
         recovery_outcome text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS kalshi_read_network_events_occurred_idx
         ON kalshi_read_network_events (occurred_at DESC);
       -- Durable watermark for the exchange-history discovery sweep. One row per
       -- Eastern day that has been fully swept. Prevents re-scanning the full
       -- exchange history on every server restart.
       CREATE TABLE IF NOT EXISTS exchange_sweep_log (
         eastern_date     TEXT PRIMARY KEY,
         completed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         discovered_count INTEGER NOT NULL DEFAULT 0
       );
       -- Evaluation events: durable per-tick decision log (replaces NDJSON files).
       -- One row per recordEvaluationEvent() call. Natural PK is idempotent on replay.
       CREATE TABLE IF NOT EXISTS evaluation_events (
         id                 TEXT PRIMARY KEY,
         timestamp_ms       BIGINT NOT NULL,
         eastern_date       TEXT NOT NULL,
         ticker             TEXT NOT NULL,
         series             TEXT NOT NULL DEFAULT \'\',
         seconds_left       INTEGER NOT NULL,
         source             TEXT NOT NULL,
         yes_bid            INTEGER,
         yes_ask            INTEGER,
         no_bid             INTEGER,
         no_ask             INTEGER,
         yes_derived_ask    INTEGER,
         no_derived_ask     INTEGER,
         side               TEXT,
         limit_cents        INTEGER,
         outcome            TEXT NOT NULL,
         preflight_decision TEXT,
         created_at         TIMESTAMP DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS evaluation_events_ticker_idx        ON evaluation_events (ticker);
       CREATE INDEX IF NOT EXISTS evaluation_events_timestamp_ms_idx  ON evaluation_events (timestamp_ms);
       CREATE INDEX IF NOT EXISTS evaluation_events_eastern_date_idx  ON evaluation_events (eastern_date);
       -- Generic key-value store for server-side operational metadata.
       -- Used to record one-time migration completions, feature flags, and
       -- similar durable boolean states that don't belong in a domain table.
       CREATE TABLE IF NOT EXISTS server_metadata (
         key        TEXT PRIMARY KEY,
         value      TEXT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
       -- Coverage-gap incidents: one row per ticker/window, upserted on every
       -- state change (last-state-wins).  Survives production redeploys.
       CREATE TABLE IF NOT EXISTS coverage_incidents (
         incident_id            TEXT PRIMARY KEY,
         ticker                 TEXT NOT NULL,
         series                 TEXT NOT NULL DEFAULT '',
         close_time             TEXT NOT NULL,
         detected_at_ms         BIGINT NOT NULL,
         seconds_left_at_detect INTEGER NOT NULL,
         last_usable_quote_ms   BIGINT,
         last_evaluation_ms     BIGINT,
         last_ws_data_msg_ms    BIGINT,
         last_ws_any_msg_ms     BIGINT,
         ws_connected           BOOLEAN NOT NULL DEFAULT false,
         recovery_attempts      TEXT NOT NULL DEFAULT '[]',
         status                 TEXT NOT NULL,
         recovered_at_ms        BIGINT,
         eastern_date           TEXT NOT NULL,
         updated_at             TIMESTAMP DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS coverage_incidents_eastern_date_idx ON coverage_incidents (eastern_date);
       CREATE INDEX IF NOT EXISTS coverage_incidents_detected_at_ms_idx ON coverage_incidents (detected_at_ms);
        -- Permanent, per-ticker final-window data-health audit. This table is
        -- deliberately NOT part of the 30-day incident retention sweep.
        CREATE TABLE IF NOT EXISTS coverage_window_audits (
          audit_id                    TEXT PRIMARY KEY,
          ticker                      TEXT NOT NULL,
          series                      TEXT NOT NULL,
          close_time                  TEXT NOT NULL,
          discovered_at_ms            BIGINT NOT NULL,
          eligible_start_ms           BIGINT NOT NULL,
          final_window_started_at_ms  BIGINT,
          final_window_closed_at_ms   BIGINT,
          first_usable_quote_ms       BIGINT,
          last_usable_quote_ms        BIGINT,
          first_evaluation_ms         BIGINT,
          last_evaluation_ms          BIGINT,
          final_window_usable_quotes  INTEGER NOT NULL DEFAULT 0,
          final_window_evaluations    INTEGER NOT NULL DEFAULT 0,
          status                      TEXT NOT NULL,
          incident_id                 TEXT,
          transitions                 TEXT NOT NULL DEFAULT '[]',
          recovery_attempts           TEXT NOT NULL DEFAULT '[]',
           evidence_completeness       TEXT NOT NULL DEFAULT 'complete',
           restart_evidence_uncertain  BOOLEAN NOT NULL DEFAULT false,
          eastern_date                TEXT NOT NULL,
          updated_at                  TIMESTAMP DEFAULT now()
        );
        ALTER TABLE coverage_window_audits ADD COLUMN IF NOT EXISTS evidence_completeness TEXT NOT NULL DEFAULT 'complete';
        ALTER TABLE coverage_window_audits ADD COLUMN IF NOT EXISTS restart_evidence_uncertain BOOLEAN NOT NULL DEFAULT false;
       CREATE TABLE IF NOT EXISTS daily_profit_stop_audit (
         id bigserial PRIMARY KEY,
         eastern_date text NOT NULL,
         kind text NOT NULL,
         ticker text,
         realized_pnl_dollars double precision,
         source text NOT NULL,
         source_status text NOT NULL,
         retrieved_at timestamp,
         created_at timestamp NOT NULL DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS daily_profit_stop_audit_date_idx
         ON daily_profit_stop_audit (eastern_date, created_at DESC);
       ALTER TABLE daily_profit_stop_audit ADD COLUMN IF NOT EXISTS reason text;
        CREATE INDEX IF NOT EXISTS coverage_window_audits_close_time_idx ON coverage_window_audits (close_time);
        CREATE INDEX IF NOT EXISTS coverage_window_audits_eastern_date_idx ON coverage_window_audits (eastern_date);
       CREATE TABLE IF NOT EXISTS runtime_watchdog_history (
         id text PRIMARY KEY, polled_at_ms bigint NOT NULL, payload text NOT NULL,
         created_at timestamp NOT NULL DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS runtime_watchdog_history_polled_idx ON runtime_watchdog_history (polled_at_ms DESC);
        -- Append-only operational evidence. These rows prove the server process
        -- lifecycle without treating missing periods as market observations.
        CREATE TABLE IF NOT EXISTS runtime_lifecycle_events (
          id text PRIMARY KEY, run_id text NOT NULL, event_type text NOT NULL,
          occurred_at_ms bigint NOT NULL, occurred_at_utc text NOT NULL,
          occurred_at_et text NOT NULL, pid integer NOT NULL, environment text NOT NULL,
          reason text, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS runtime_lifecycle_events_run_idx ON runtime_lifecycle_events (run_id, occurred_at_ms DESC);
        CREATE TABLE IF NOT EXISTS runtime_heartbeats (
          id text PRIMARY KEY, run_id text NOT NULL, occurred_at_ms bigint NOT NULL,
          occurred_at_utc text NOT NULL, occurred_at_et text NOT NULL, pid integer NOT NULL,
          environment text NOT NULL, components text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS runtime_heartbeats_occurred_idx ON runtime_heartbeats (occurred_at_ms DESC);
        CREATE TABLE IF NOT EXISTS runtime_offline_periods (
          id text PRIMARY KEY, detected_at_ms bigint NOT NULL, started_at_ms bigint NOT NULL,
          ended_at_ms bigint NOT NULL, duration_ms bigint NOT NULL, state text NOT NULL,
          prior_run_id text, recovered_by_run_id text, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS runtime_offline_periods_started_idx ON runtime_offline_periods (started_at_ms DESC);
        -- ── ETH_30_50 isolated strategy tables (additive, idempotent) ──────────
        -- Permanent ticker claims for the ETH_30_50 strategy (never expire unlike
        -- order_dedup). One row per market ticker — atomically insert-once.
        CREATE TABLE IF NOT EXISTS eth30_ticker_claims (
          ticker                text PRIMARY KEY,
          eastern_date          text NOT NULL,
          claimed_at_ms         bigint NOT NULL,
          entry_client_order_id text NOT NULL,
          created_at            timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth30_ticker_claims_eastern_date_idx ON eth30_ticker_claims (eastern_date);
        CREATE INDEX IF NOT EXISTS eth30_ticker_claims_claimed_at_ms_idx ON eth30_ticker_claims (claimed_at_ms);
        -- ETH_30_50 strategy order links: entry + exit orders per ticker.
        CREATE TABLE IF NOT EXISTS eth30_strategy_orders (
          id                       text PRIMARY KEY,
          ticker                   text NOT NULL,
          eastern_date             text NOT NULL,
          role                     text NOT NULL,
          sequence_number          integer NOT NULL DEFAULT 1,
          client_order_id          text NOT NULL,
          kalshi_order_id          text,
          side                     text NOT NULL,
          limit_price_cents        integer NOT NULL,
          requested_contracts      integer NOT NULL,
          outcome                  text NOT NULL DEFAULT 'pending',
          filled_contracts         double precision,
          average_fill_price_cents integer,
          updated_at_ms            bigint NOT NULL,
          created_at               timestamp DEFAULT now(),
          updated_at               timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth30_strategy_orders_ticker_idx          ON eth30_strategy_orders (ticker);
        CREATE INDEX IF NOT EXISTS eth30_strategy_orders_eastern_date_idx    ON eth30_strategy_orders (eastern_date);
        CREATE INDEX IF NOT EXISTS eth30_strategy_orders_client_order_id_idx ON eth30_strategy_orders (client_order_id);
        -- ETH_30_50 append-only position event ledger.
        CREATE TABLE IF NOT EXISTS eth30_position_events (
          id                text PRIMARY KEY,
          ticker            text NOT NULL,
          eastern_date      text NOT NULL,
          event_type        text NOT NULL,
          contracts_delta   double precision NOT NULL,
          contracts_after   double precision NOT NULL,
          strategy_order_id text,
          fill_price_cents  integer,
          fee_cents         integer,
          settlement_result text,
          note              text,
          occurred_at_ms    bigint NOT NULL,
          created_at        timestamp DEFAULT now()
        );
        ALTER TABLE eth30_position_events ADD COLUMN IF NOT EXISTS fee_cents integer;
        CREATE INDEX IF NOT EXISTS eth30_position_events_ticker_idx          ON eth30_position_events (ticker);
        CREATE INDEX IF NOT EXISTS eth30_position_events_eastern_date_idx    ON eth30_position_events (eastern_date);
        CREATE INDEX IF NOT EXISTS eth30_position_events_occurred_at_ms_idx  ON eth30_position_events (occurred_at_ms);
        -- ETH_30_50 append-only decision/skip evidence ledger (audit only).
        CREATE TABLE IF NOT EXISTS eth30_decision_events (
          id             text PRIMARY KEY,
          ticker         text NOT NULL,
          eastern_date   text NOT NULL,
          decision       text NOT NULL,
          side           text,
          price_cents    integer,
          contracts      integer,
          note           text,
          occurred_at_ms bigint NOT NULL,
          created_at     timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth30_decision_events_ticker_idx         ON eth30_decision_events (ticker);
        CREATE INDEX IF NOT EXISTS eth30_decision_events_eastern_date_idx   ON eth30_decision_events (eastern_date);
        CREATE INDEX IF NOT EXISTS eth30_decision_events_occurred_at_ms_idx ON eth30_decision_events (occurred_at_ms);
        -- ETH_30_50 passive research only. These rows are not consumed by
        -- claims, order submission, target management, or reconciliation.
        CREATE TABLE IF NOT EXISTS eth30_shadow_observations (
          id text PRIMARY KEY, ticker text NOT NULL, observed_at_ms bigint NOT NULL,
          payload_json text NOT NULL, created_at timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth30_shadow_observations_ticker_time_idx
          ON eth30_shadow_observations (ticker, observed_at_ms);
        CREATE TABLE IF NOT EXISTS eth30_shadow_events (
          id text PRIMARY KEY, ticker text NOT NULL, signal text NOT NULL,
          triggered_at_ms bigint NOT NULL, payload_json text NOT NULL,
          created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth30_shadow_events_ticker_time_idx
          ON eth30_shadow_events (ticker, triggered_at_ms);
        -- ETH 420 six-step candidate telemetry. This is deliberately isolated
        -- from executable martingale state and can never represent an order.
        CREATE TABLE IF NOT EXISTS eth420_candidate_telemetry (
          id text PRIMARY KEY, ticker text NOT NULL, eastern_date text NOT NULL,
          observed_at_ms bigint NOT NULL, floor_strike double precision,
          payload_json text NOT NULL, created_at timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth420_candidate_telemetry_time_idx
          ON eth420_candidate_telemetry (observed_at_ms DESC);
        -- ETH 420 candidate state is deliberately independent of the live ETH
        -- martingale. It is safe to populate from passive observation but is
        -- never read by the executable live three-step strategy.
        CREATE TABLE IF NOT EXISTS eth420_candidate_state (
          strategy_key text PRIMARY KEY, eastern_date text NOT NULL,
          side text NOT NULL, martingale_step integer NOT NULL,
          realized_pnl_cents integer NOT NULL DEFAULT 0,
          last_block_reset_at_ms bigint, updated_at_ms bigint NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eth420_candidate_settlement_events (
          id text PRIMARY KEY, eastern_date text NOT NULL,
          realized_pnl_delta_cents integer NOT NULL, applied_at_ms bigint NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eth420_candidate_daily_state (
          eastern_date text PRIMARY KEY, side text NOT NULL, martingale_step integer NOT NULL,
          realized_pnl_cents integer NOT NULL DEFAULT 0, last_block_reset_at_ms bigint,
          updated_at_ms bigint NOT NULL
        );
        -- Counterfactual rehearsal state must never share the live-candidate
        -- state or its settlement event ledger.
        CREATE TABLE IF NOT EXISTS eth420_counterfactual_daily_state (
          eastern_date text PRIMARY KEY, side text NOT NULL, martingale_step integer NOT NULL,
          realized_pnl_cents integer NOT NULL DEFAULT 0, last_block_reset_at_ms bigint,
          updated_at_ms bigint NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eth420_counterfactual_settlement_events (
          id text PRIMARY KEY, eastern_date text NOT NULL,
          realized_pnl_delta_cents integer NOT NULL, applied_at_ms bigint NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eth420_candidate_entries (
          id text PRIMARY KEY, ticker text NOT NULL, eastern_date text NOT NULL,
          observed_at_ms bigint NOT NULL, side text NOT NULL, martingale_step integer NOT NULL,
          effective_wager_cents integer NOT NULL, decision_payload_json text NOT NULL,
          state_before_json text NOT NULL, settlement_result text,
          filled_contracts integer, realized_pnl_delta_cents integer,
          settled_at_ms bigint, state_after_json text, created_at timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth420_candidate_entries_pending_idx
          ON eth420_candidate_entries (settlement_result, observed_at_ms ASC);
        ALTER TABLE eth420_candidate_entries DROP CONSTRAINT IF EXISTS eth420_candidate_entries_ticker_key;
        -- Executable ETH420 candidate orders are deliberately a different
        -- ledger from both the counterfactual entries and legacy martingale.
        CREATE TABLE IF NOT EXISTS eth420_candidate_live_orders (
          id text PRIMARY KEY, ticker text NOT NULL UNIQUE, eastern_date text NOT NULL,
          market_open_time_ms bigint,
          side text NOT NULL, martingale_step integer NOT NULL, requested_contracts numeric NOT NULL,
          limit_price_cents integer NOT NULL, effective_wager_cents integer NOT NULL,
          state_before_json text NOT NULL, kalshi_order_id text, original_primary_kalshi_order_id text, secondary_client_order_id text,
          primary_cancel_confirmed_at_ms bigint, secondary_submission_started_at_ms bigint, secondary_bound_at_ms bigint, status text NOT NULL,
          filled_contracts numeric, realized_pnl_delta_cents integer, settlement_result text,
           actual_notional_dollars text, actual_fee_dollars text, fill_price_cents integer,
            settled_at_ms bigint, finalized_at_ms bigint, state_after_json text, created_at_ms bigint NOT NULL, secondary_activation_sequence bigint NOT NULL DEFAULT 0, updated_at_ms bigint NOT NULL
        );
        ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS market_open_time_ms bigint;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS actual_notional_dollars text;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS actual_fee_dollars text;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS fill_price_cents integer;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS finalized_at_ms bigint;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS recovery_attempt_count integer NOT NULL DEFAULT 0;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS last_recovery_attempt_at_ms bigint;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS last_recovery_outcome text;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS last_recovery_error_class text;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS rejection_reason text;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS rejection_confirmed_at_ms bigint;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS original_primary_kalshi_order_id text;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS secondary_client_order_id text;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS primary_cancel_confirmed_at_ms bigint;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS secondary_submission_started_at_ms bigint;
         ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS secondary_bound_at_ms bigint;
          ALTER TABLE eth420_candidate_live_orders ADD COLUMN IF NOT EXISTS secondary_activation_sequence bigint NOT NULL DEFAULT 0;
         -- Kalshi reports contract quantities as fixed-point values. Candidate
         -- entries are still sized in whole contracts, but terminal partial
         -- fills must retain their exact authenticated decimal quantity.
         ALTER TABLE eth420_candidate_live_orders
           ALTER COLUMN requested_contracts TYPE numeric USING requested_contracts::numeric;
         ALTER TABLE eth420_candidate_live_orders
           ALTER COLUMN filled_contracts TYPE numeric USING filled_contracts::numeric;
        CREATE INDEX IF NOT EXISTS eth420_candidate_live_orders_pending_idx
          ON eth420_candidate_live_orders (status, created_at_ms ASC);
        -- A candidate-only, one-window execution override. It is armed solely
        -- by the verified zero-fill settlement transaction and claimed by the
        -- target window's primary reservation transaction.
        CREATE TABLE IF NOT EXISTS eth420_candidate_back_flip_overrides (
          source_candidate_order_id text PRIMARY KEY, source_ticker text NOT NULL,
          source_open_time_ms bigint NOT NULL, missed_side text NOT NULL,
          target_open_time_ms bigint NOT NULL, target_ticker text,
          status text NOT NULL, armed_at_ms bigint NOT NULL,
          scheduled_at_ms bigint, observed_at_ms bigint, missed_side_bid_cents integer,
          threshold_cents integer NOT NULL DEFAULT 50, selected_side text,
          intended_wager_cents integer, requested_contracts integer,
          execution_mode text, execution_limit_price_cents integer,
          candidate_order_id text, fallback_reason text, resolved_at_ms bigint
        );
        ALTER TABLE eth420_candidate_back_flip_overrides ADD COLUMN IF NOT EXISTS execution_mode text;
        ALTER TABLE eth420_candidate_back_flip_overrides ADD COLUMN IF NOT EXISTS execution_limit_price_cents integer;
        CREATE UNIQUE INDEX IF NOT EXISTS eth420_candidate_back_flip_target_unique
          ON eth420_candidate_back_flip_overrides (target_open_time_ms);
        -- Emergency reductions are candidate-only.  A row is inserted before
        -- the exchange POST so a lost acknowledgement can never cause a retry.
        CREATE TABLE IF NOT EXISTS eth420_candidate_emergency_reductions (
          idempotency_key text PRIMARY KEY, candidate_order_id text NOT NULL,
          ticker text NOT NULL, candidate_kalshi_order_id text NOT NULL,
          held_side text NOT NULL, requested_contracts integer NOT NULL,
          client_order_id text NOT NULL, operator_reason text NOT NULL, confirmation text NOT NULL,
          expected_exit_side text NOT NULL,
          submitted_limit_price_cents integer, exchange_index integer, acknowledged_at_ms bigint,
          reconciled_at_ms bigint, reconciliation_result text, reconciled_fill_contracts integer,
          reconciled_fee_dollars text, reconciled_residual_position integer,
          status text NOT NULL, exit_kalshi_order_id text,
          failure_reason text, created_at_ms bigint NOT NULL, updated_at_ms bigint NOT NULL
        );
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS client_order_id text;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS operator_reason text;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS confirmation text;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS expected_exit_side text;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS submitted_limit_price_cents integer;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS exchange_index integer;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS acknowledged_at_ms bigint;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS reconciled_at_ms bigint;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS reconciliation_result text;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS reconciled_fill_contracts integer;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS reconciled_fee_dollars text;
        ALTER TABLE eth420_candidate_emergency_reductions ADD COLUMN IF NOT EXISTS reconciled_residual_position integer;
        CREATE INDEX IF NOT EXISTS eth420_candidate_emergency_reductions_open_idx
          ON eth420_candidate_emergency_reductions (candidate_order_id, status, created_at_ms);
        -- One candidate position can have exactly one operator emergency
        -- lifecycle, even after that lifecycle has reached a terminal audit
        -- result. The preceding global advisory fence handles races; this
        -- index is the durable last line of defence.
        CREATE UNIQUE INDEX IF NOT EXISTS eth420_candidate_emergency_reductions_candidate_order_unique
          ON eth420_candidate_emergency_reductions (candidate_order_id);
        -- Seven bounded, scalar-only post-reservation observations. This table
        -- is diagnostic-only and is intentionally not read by trading logic.
        CREATE TABLE IF NOT EXISTS eth420_candidate_execution_snapshots (
          snapshot_id text PRIMARY KEY, candidate_order_id text NOT NULL,
          ticker text NOT NULL, scheduled_offset_ms integer NOT NULL,
          scheduled_at_ms bigint NOT NULL, observed_at_ms bigint NOT NULL,
          selected_side text NOT NULL, requested_contracts numeric NOT NULL,
          kalshi_order_id text, order_status text NOT NULL, filled_contracts numeric,
          selected_best_bid_cents integer, selected_best_ask_cents integer,
          depth_at_50_contracts integer, full_size_executable_price_cents integer,
          quote_age_ms integer, quote_freshness text NOT NULL, observation_state text NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS eth420_candidate_execution_snapshots_order_offset_idx
          ON eth420_candidate_execution_snapshots (candidate_order_id, scheduled_offset_ms);
        ALTER TABLE eth420_candidate_execution_snapshots
          ALTER COLUMN requested_contracts TYPE numeric USING requested_contracts::numeric;
        ALTER TABLE eth420_candidate_execution_snapshots
          ALTER COLUMN filled_contracts TYPE numeric USING filled_contracts::numeric;
        CREATE INDEX IF NOT EXISTS eth420_candidate_execution_snapshots_observed_idx
          ON eth420_candidate_execution_snapshots (observed_at_ms ASC);
        -- Passive classifier output derived solely from retained snapshots.
        -- It is never read by live entry, recovery, settlement, or state code.
        CREATE TABLE IF NOT EXISTS eth420_candidate_runaway_research (
          candidate_order_id text PRIMARY KEY, ticker text NOT NULL, selected_side text NOT NULL,
          requested_contracts integer NOT NULL, classifier_version text NOT NULL,
          already_gone_fired boolean NOT NULL, accelerating_runaway_fired boolean NOT NULL,
          quiet_runaway_fired boolean NOT NULL, fired_regimes_json text NOT NULL,
          decision_point_offset_ms integer, hypothetical_full_size_entry_price_cents integer,
          source_snapshots_json text NOT NULL, settlement_result text,
          hypothetical_entry_cost_cents integer, hypothetical_fee_cents integer,
          hypothetical_gross_pnl_cents integer, hypothetical_net_pnl_cents integer,
          source_updated_at_ms bigint NOT NULL, classified_at_ms bigint NOT NULL
        );
        CREATE INDEX IF NOT EXISTS eth420_candidate_runaway_research_ticker_idx
          ON eth420_candidate_runaway_research (ticker);
        CREATE TABLE IF NOT EXISTS eth420_boundary_research_snapshots (
          id text PRIMARY KEY, ticker text NOT NULL, anchor text NOT NULL,
          market_open_ms bigint, market_close_ms bigint, prior_market_open_ms bigint,
          scheduled_at_ms bigint NOT NULL, actual_at_ms bigint NOT NULL, lateness_ms integer NOT NULL,
          exchange_index integer, yes_bid integer, yes_ask integer, no_bid integer, no_ask integer,
          yes_spread_cents integer, no_spread_cents integer, l2_json text NOT NULL,
          spot_midpoint double precision, spot_provider text, spot_source_timestamp_ms bigint,
          spot_receipt_timestamp_ms bigint, spot_age_ms bigint, spot_is_proxy boolean,
          candidate_order_id text, kalshi_order_id text, selected_side text, requested_contracts integer,
          primary_limit_cents integer, order_status text, filled_contracts integer, quality text NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS eth420_boundary_research_ticker_anchor_idx
          ON eth420_boundary_research_snapshots (ticker, anchor, scheduled_at_ms);
        CREATE INDEX IF NOT EXISTS eth420_boundary_research_time_idx
          ON eth420_boundary_research_snapshots (actual_at_ms ASC);
        CREATE TABLE IF NOT EXISTS eth420_candidate_step_reset_audits (
          reset_id text PRIMARY KEY, eastern_date text NOT NULL, reset_at_ms bigint NOT NULL,
          prior_side text NOT NULL, prior_step integer NOT NULL, prior_realized_pnl_cents integer NOT NULL,
          prior_last_block_reset_at_ms bigint,
          next_side text NOT NULL, next_step integer NOT NULL, next_realized_pnl_cents integer NOT NULL,
          next_last_block_reset_at_ms bigint
        );
        CREATE INDEX IF NOT EXISTS eth420_candidate_step_reset_audits_date_idx
          ON eth420_candidate_step_reset_audits (eastern_date, reset_at_ms DESC);
        -- Passive prospective ETH 21–25¢ → 50¢ research cohort. Never linked
        -- to live strategy claims/orders and never read by trading logic.
        CREATE TABLE IF NOT EXISTS eth2125_prospective_cohort (
          ticker text PRIMARY KEY, cohort_start_ms bigint NOT NULL, eastern_date text NOT NULL,
          observed_at_ms bigint NOT NULL, side text NOT NULL, entry_price_cents integer NOT NULL,
          contracts integer NOT NULL, entry_cost_cents integer NOT NULL,
          estimated_entry_fee_cents integer NOT NULL, first_target_at_ms bigint,
          first_target_bid_cents integer, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS eth2125_prospective_observed_idx ON eth2125_prospective_cohort (observed_at_ms);
        CREATE INDEX IF NOT EXISTS eth2125_prospective_date_idx ON eth2125_prospective_cohort (eastern_date);
        -- Additive migration: add fee_cents to eth30_position_events for per-chunk
        -- exchange fee capture. Legacy rows will have NULL; new chunk events will carry
        -- the actual fee from the Kalshi fills API.
        ALTER TABLE eth30_position_events ADD COLUMN IF NOT EXISTS fee_cents integer;
        -- ── SOL_30_50 isolated strategy tables (additive, idempotent) ──────────
        -- Mirror of the ETH_30_50 tables for the SOL_30_50 strategy.
        -- SOL is disabled by configuration; these tables are schema-only.
        CREATE TABLE IF NOT EXISTS sol30_ticker_claims (
          ticker                text PRIMARY KEY,
          eastern_date          text NOT NULL,
          claimed_at_ms         bigint NOT NULL,
          entry_client_order_id text NOT NULL,
          created_at            timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS sol30_ticker_claims_eastern_date_idx ON sol30_ticker_claims (eastern_date);
        CREATE INDEX IF NOT EXISTS sol30_ticker_claims_claimed_at_ms_idx ON sol30_ticker_claims (claimed_at_ms);
        -- SOL_30_50 strategy order links: entry + exit orders per ticker.
        CREATE TABLE IF NOT EXISTS sol30_strategy_orders (
          id                       text PRIMARY KEY,
          ticker                   text NOT NULL,
          eastern_date             text NOT NULL,
          role                     text NOT NULL,
          sequence_number          integer NOT NULL DEFAULT 1,
          client_order_id          text NOT NULL,
          kalshi_order_id          text,
          side                     text NOT NULL,
          limit_price_cents        integer NOT NULL,
          requested_contracts      double precision NOT NULL,
          outcome                  text NOT NULL DEFAULT 'pending',
          filled_contracts         double precision,
          average_fill_price_cents integer,
          updated_at_ms            bigint NOT NULL,
          created_at               timestamp DEFAULT now(),
          updated_at               timestamp DEFAULT now()
        );
        -- Existing deployments created this field as integer. SOL exchange
        -- fills can be fixed-point quantities, so replacement target sizes
        -- must retain their fractional remainder rather than truncate it.
        ALTER TABLE sol30_strategy_orders
          ALTER COLUMN requested_contracts TYPE double precision
          USING requested_contracts::double precision;
        CREATE INDEX IF NOT EXISTS sol30_strategy_orders_ticker_idx          ON sol30_strategy_orders (ticker);
        CREATE INDEX IF NOT EXISTS sol30_strategy_orders_eastern_date_idx    ON sol30_strategy_orders (eastern_date);
        CREATE INDEX IF NOT EXISTS sol30_strategy_orders_client_order_id_idx ON sol30_strategy_orders (client_order_id);
        -- SOL_30_50 append-only position event ledger.
        CREATE TABLE IF NOT EXISTS sol30_position_events (
          id                text PRIMARY KEY,
          ticker            text NOT NULL,
          eastern_date      text NOT NULL,
          event_type        text NOT NULL,
          contracts_delta   double precision NOT NULL,
          contracts_after   double precision NOT NULL,
          strategy_order_id text,
          fill_price_cents  integer,
          fee_cents         integer,
          settlement_result text,
          note              text,
          occurred_at_ms    bigint NOT NULL,
          created_at        timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS sol30_position_events_ticker_idx          ON sol30_position_events (ticker);
        CREATE INDEX IF NOT EXISTS sol30_position_events_eastern_date_idx    ON sol30_position_events (eastern_date);
        CREATE INDEX IF NOT EXISTS sol30_position_events_occurred_at_ms_idx  ON sol30_position_events (occurred_at_ms);
        -- SOL_30_50 append-only decision/skip evidence ledger (audit only).
        CREATE TABLE IF NOT EXISTS sol30_decision_events (
          id             text PRIMARY KEY,
          ticker         text NOT NULL,
          eastern_date   text NOT NULL,
          decision       text NOT NULL,
          side           text,
          price_cents    integer,
          contracts      integer,
          note           text,
          occurred_at_ms bigint NOT NULL,
          created_at     timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS sol30_decision_events_ticker_idx         ON sol30_decision_events (ticker);
        CREATE INDEX IF NOT EXISTS sol30_decision_events_eastern_date_idx   ON sol30_decision_events (eastern_date);
        CREATE INDEX IF NOT EXISTS sol30_decision_events_occurred_at_ms_idx ON sol30_decision_events (occurred_at_ms);
        -- ── DOGE NO martingale (isolated, execution-only; no research tables) ──
        CREATE TABLE IF NOT EXISTS doge_martingale_claims (
          ticker text PRIMARY KEY, eastern_date text NOT NULL, claimed_at_ms bigint NOT NULL,
          client_order_id text NOT NULL
        );
        CREATE TABLE IF NOT EXISTS doge_martingale_orders (
          id text PRIMARY KEY, ticker text UNIQUE NOT NULL, eastern_date text NOT NULL,
          martingale_step integer NOT NULL, client_order_id text NOT NULL, kalshi_order_id text,
          no_price_cents integer NOT NULL, requested_contracts integer NOT NULL,
          reserved_fee_cents integer NOT NULL DEFAULT 0, filled_fee_cents integer,
          filled_contracts integer, outcome text NOT NULL DEFAULT 'pending',
          actual_fill_price_cents integer, actual_notional_dollars numeric,
          actual_fee_dollars numeric, fill_economics_verified_at_ms bigint,
          settlement_result text, settled_at_ms bigint, created_at_ms bigint NOT NULL,
          updated_at_ms bigint NOT NULL, submission_version integer NOT NULL DEFAULT 0
        );
        -- Previous releases POSTed while the row was still "pending". Mark
        -- those rows ambiguous exactly once: they may have reached Kalshi
        -- before a response or process crash, so never expire/release them.
        ALTER TABLE doge_martingale_orders
          ADD COLUMN IF NOT EXISTS submission_version integer NOT NULL DEFAULT 0;
        ALTER TABLE doge_martingale_orders
          ADD COLUMN IF NOT EXISTS reserved_fee_cents integer NOT NULL DEFAULT 0;
        ALTER TABLE doge_martingale_orders
          ADD COLUMN IF NOT EXISTS filled_fee_cents integer;
        UPDATE doge_martingale_orders
          SET outcome = 'post_started', submission_version = 1,
              updated_at_ms = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
          WHERE submission_version = 0 AND outcome = 'pending';
        CREATE INDEX IF NOT EXISTS doge_martingale_orders_unsettled_idx
          ON doge_martingale_orders (settlement_result, eastern_date, created_at_ms);
        CREATE TABLE IF NOT EXISTS doge_martingale_state (
          strategy_key text PRIMARY KEY, eastern_date text NOT NULL, martingale_step integer NOT NULL,
          spent_cents integer NOT NULL, recovery_loss_cents integer NOT NULL DEFAULT 0,
          sequence_reset_at_ms bigint NOT NULL DEFAULT 0, updated_at_ms bigint NOT NULL
        );
        ALTER TABLE doge_martingale_state
          ADD COLUMN IF NOT EXISTS recovery_loss_cents integer NOT NULL DEFAULT 0;
        ALTER TABLE doge_martingale_state
          ADD COLUMN IF NOT EXISTS sequence_reset_at_ms bigint NOT NULL DEFAULT 0;
        INSERT INTO doge_martingale_state (strategy_key, eastern_date, martingale_step, spent_cents, updated_at_ms)
          VALUES ('DOGE_NO_MARTINGALE', '1970-01-01', 0, 0, 0)
          ON CONFLICT (strategy_key) DO NOTHING;
        CREATE TABLE IF NOT EXISTS doge_martingale_decisions (
          id text PRIMARY KEY, ticker text NOT NULL, eastern_date text NOT NULL, decision text NOT NULL,
          no_price_cents integer, contracts integer, note text, occurred_at_ms bigint NOT NULL
        );
        CREATE INDEX IF NOT EXISTS doge_martingale_decisions_ticker_idx
          ON doge_martingale_decisions (ticker, occurred_at_ms);

        CREATE TABLE IF NOT EXISTS target_liquidity_snapshots (
          id                            text PRIMARY KEY,
          strategy                      text NOT NULL,
          ticker                        text NOT NULL,
          eastern_date                  text NOT NULL,
          side                          text NOT NULL,
          target_order_db_id            text,
          target_kalshi_order_id        text,
          target_placed_at_ms           bigint,
          order_status                  text,
          resting_contracts             integer,
          observed_bid_cents            integer,
          bid_levels_json               text NOT NULL DEFAULT '[]',
          contracts_at_or_above_target  integer NOT NULL DEFAULT 0,
          book_error                    text,
          captured_at_ms                bigint NOT NULL,
          created_at                    timestamp DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS target_liquidity_snapshots_ticker_idx         ON target_liquidity_snapshots (ticker);
        CREATE INDEX IF NOT EXISTS target_liquidity_snapshots_strategy_idx       ON target_liquidity_snapshots (strategy);
        CREATE INDEX IF NOT EXISTS target_liquidity_snapshots_captured_at_ms_idx ON target_liquidity_snapshots (captured_at_ms);

        CREATE TABLE IF NOT EXISTS passive_experiment_registry (
          experiment_version text PRIMARY KEY,
          program text NOT NULL,
          name text NOT NULL,
          config jsonb NOT NULL,
          schema_version text NOT NULL,
          created_at timestamp with time zone NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS passive_experiment_captures (
          capture_id text PRIMARY KEY,
          experiment_version text NOT NULL,
          snapshot_id text NOT NULL,
          market_id text NOT NULL,
          ticker text NOT NULL,
          asset text NOT NULL,
          captured_at_ms bigint NOT NULL,
          qualification text NOT NULL,
          payload jsonb NOT NULL,
          schema_version text NOT NULL,
          created_at timestamp with time zone NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS passive_experiment_captures_market_idx
          ON passive_experiment_captures (market_id, captured_at_ms);
        CREATE INDEX IF NOT EXISTS passive_experiment_captures_experiment_idx
          ON passive_experiment_captures (experiment_version, captured_at_ms);
        CREATE TABLE IF NOT EXISTS passive_experiment_settlements (
          experiment_version text NOT NULL,
          market_id text NOT NULL,
          result text,
          settlement_timestamp_ms bigint,
          reconciled_at_ms bigint NOT NULL,
          settlement_status text NOT NULL,
          schema_version text NOT NULL,
          created_at timestamp with time zone NOT NULL DEFAULT now(),
          PRIMARY KEY (experiment_version, market_id)
        );

        -- ── ETH NO martingale (isolated, execution-only; KXETH15M series) ──
        CREATE TABLE IF NOT EXISTS eth_martingale_claims (
          ticker text PRIMARY KEY, eastern_date text NOT NULL, claimed_at_ms bigint NOT NULL,
          client_order_id text NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eth_martingale_orders (
          id text PRIMARY KEY, ticker text UNIQUE NOT NULL, eastern_date text NOT NULL,
          martingale_step integer NOT NULL, client_order_id text NOT NULL, kalshi_order_id text,
          side text NOT NULL DEFAULT 'no',
          no_price_cents integer NOT NULL, requested_contracts integer NOT NULL,
          reserved_fee_cents integer NOT NULL DEFAULT 0, filled_fee_cents integer,
          filled_contracts numeric, outcome text NOT NULL DEFAULT 'pending',
          rejection_reason text,
          actual_fill_price_cents integer, actual_notional_dollars numeric,
          actual_fee_dollars numeric, fill_economics_verified_at_ms bigint,
          fill_economics_verified_contracts numeric,
          settlement_result text, settled_at_ms bigint, created_at_ms bigint NOT NULL,
          updated_at_ms bigint NOT NULL, submission_version integer NOT NULL DEFAULT 1
        );
        -- Additive migration: add side column to any pre-existing eth_martingale_orders table.
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'no';
        -- A definitive Kalshi POST rejection is terminal evidence, distinct
        -- from a transport-ambiguous unresolved submission.
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS rejection_reason text;
        -- Exchange order summaries report quantity but not necessarily the price
        -- improvement or exact fee. These columns are populated only from the
        -- immutable /portfolio/fills evidence and are the accounting source.
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS actual_fill_price_cents integer;
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS actual_notional_dollars numeric;
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS actual_fee_dollars numeric;
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS fill_economics_verified_at_ms bigint;
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS fill_economics_verified_contracts numeric;
        -- Kalshi's fixed-point contract counts can be fractional. Preserve
        -- those values instead of silently truncating partial exposure.
        ALTER TABLE eth_martingale_orders
          ALTER COLUMN filled_contracts TYPE numeric USING filled_contracts::numeric;
        ALTER TABLE eth_martingale_orders
          ALTER COLUMN fill_economics_verified_contracts TYPE numeric
          USING fill_economics_verified_contracts::numeric;
        CREATE INDEX IF NOT EXISTS eth_martingale_orders_unsettled_idx
          ON eth_martingale_orders (settlement_result, eastern_date, created_at_ms);
        CREATE TABLE IF NOT EXISTS eth_martingale_state (
          strategy_key text PRIMARY KEY, eastern_date text NOT NULL,
          side text NOT NULL DEFAULT 'no',
          martingale_step integer NOT NULL DEFAULT 0,
          spent_cents integer NOT NULL DEFAULT 0,
          realized_pnl_cents integer NOT NULL DEFAULT 0,
          updated_at_ms bigint NOT NULL
        );
        INSERT INTO eth_martingale_state (strategy_key, eastern_date, side, martingale_step, spent_cents, realized_pnl_cents, updated_at_ms)
          VALUES ('ETH_NO_MARTINGALE', '1970-01-01', 'no', 0, 0, 0, 0)
          ON CONFLICT (strategy_key) DO NOTHING;
        INSERT INTO eth_martingale_state (strategy_key, eastern_date, side, martingale_step, spent_cents, realized_pnl_cents, updated_at_ms)
          VALUES ('ETH_NO_MARTINGALE_V2', '1970-01-01', 'no', 0, 0, 0, 0)
          ON CONFLICT (strategy_key) DO NOTHING;
        ALTER TABLE eth_martingale_state
          ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'no';
        ALTER TABLE eth_martingale_state
          ADD COLUMN IF NOT EXISTS realized_pnl_cents integer NOT NULL DEFAULT 0;
        -- A clean operational generation must not inherit a pre-cutover claim,
        -- order, or sequence. Existing rows remain historical evidence.
        ALTER TABLE eth_martingale_claims
          ADD COLUMN IF NOT EXISTS generation text NOT NULL DEFAULT 'legacy';
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS generation text NOT NULL DEFAULT 'legacy';
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS manual_settlement_override boolean NOT NULL DEFAULT false;
        ALTER TABLE eth_martingale_orders
          ADD COLUMN IF NOT EXISTS manual_recovery_id text;
        ALTER TABLE eth_martingale_claims
          DROP CONSTRAINT IF EXISTS eth_martingale_claims_pkey;
        ALTER TABLE eth_martingale_orders
          DROP CONSTRAINT IF EXISTS eth_martingale_orders_ticker_key;
        CREATE UNIQUE INDEX IF NOT EXISTS eth_martingale_claims_generation_ticker_idx
          ON eth_martingale_claims (generation, ticker);
        CREATE UNIQUE INDEX IF NOT EXISTS eth_martingale_orders_generation_ticker_idx
          ON eth_martingale_orders (generation, ticker);
        CREATE TABLE IF NOT EXISTS eth_martingale_proof_fences (
          generation text PRIMARY KEY,
          claimed_at_ms bigint NOT NULL,
          ticker text NOT NULL,
          client_order_id text NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eth_martingale_recovery_audit (
          id text PRIMARY KEY,
          target_order_id text NOT NULL UNIQUE,
          strategy_key text NOT NULL,
          ticker text NOT NULL,
          eastern_date text NOT NULL,
          declared_result text NOT NULL,
          reason text NOT NULL,
          acknowledgement text NOT NULL,
          exchange_status text NOT NULL,
          exchange_result text,
          prior_state jsonb NOT NULL,
          resulting_state jsonb NOT NULL,
          created_at_ms bigint NOT NULL
        );
    `);
    await migrateEth420LegacyStateToDailyState();
    logger.info("tradeStore: schema migration check complete (including coverage incidents, permanent window audits, ETH_30_50 and SOL_30_50 tables, ETH martingale)");
  } catch (err) {
    // Non-fatal: columns may already exist or DB may lack ALTER privileges.
    // Trading is permitted — degraded migration is preferable to a startup crash.
    logger.warn({ err }, "tradeStore: schema migration warning — won/settlement_result columns may be missing");
  }

  await hydrateEth420CandidateEmergencyFence();

  // Step 4: one-time data patch — correct historical fee_dollars rows written by the
  // pre-fix fill reconciler and backfill script, which accidentally divided fee_cost
  // by 100 before storing (treating a dollar-decimal field as cents).  The result was
  // fee_dollars values that are 100× too small.
  //
  // Idempotent: the WHERE clause `fee_dollars < 0.001 AND contracts > 0 AND
  // fill_price_cents > 0` only matches the under-scaled rows.  After the patch those
  // rows will carry corrected values ≥ 0.001 and will never be touched again.
  // New rows written by the fixed reconciler already store the correct value.
  // canonical_economics IS NOT TRUE excludes forward-ledger rows written by this
  // task's exact-accounting path, which may legitimately have sub-mill fees.
  //
  // This block can be removed once all production rows have been patched (i.e. after
  // the first server start that reaches this code with real order_fills data).
  try {
    const patchResult = await _db!.execute(sql`
      UPDATE order_fills
      SET    fee_dollars = fee_dollars * 100
      WHERE  fee_dollars < 0.001
        AND  contracts > 0
        AND  fill_price_cents > 0
        AND  (canonical_economics IS NOT TRUE)
    `);
    const rowsPatched = (patchResult as { rowCount?: number }).rowCount ?? 0;
    if (rowsPatched > 0) {
      logger.info(
        { rowsPatched },
        "tradeStore: fee_dollars patch applied — corrected historical order_fills rows (fee was 100× too small)",
      );
    } else {
      logger.debug("tradeStore: fee_dollars patch — no rows matched (already correct or table empty)");
    }
  } catch (err) {
    // Non-fatal: log and continue — fills data is read-only history, not live trading state.
    logger.warn({ err }, "tradeStore: fee_dollars patch failed — historical fee totals may still be 100× too small");
  }

  // Step 5: startup integrity check — warn if any order_fills rows still have an
  // attempt_id that cannot be resolved in order_attempts.  This catches any new
  // source of orphaned links before they accumulate silently.
  try {
    const orphanResult = await _db!.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM   order_fills f
      WHERE  f.attempt_id IS NOT NULL
        AND  NOT EXISTS (
               SELECT 1 FROM order_attempts a WHERE a.id = f.attempt_id
             )
    `);
    const rows = orphanResult as unknown as { rows?: Array<Record<string, unknown>> };
    const orphanCount = Number((rows.rows?.[0] as Record<string, unknown> | undefined)?.["cnt"] ?? 0);
    _orphanedFillLinkCount     = orphanCount;
    _orphanedFillLinkCheckedAt = new Date().toISOString();
    if (orphanCount > 0) {
      logger.warn(
        { orphanCount },
        "tradeStore: integrity check — order_fills rows with attempt_id that does not match any " +
        "order_attempts.id (JOIN will return empty for these rows); manual repair may be required",
      );
    } else {
      logger.info("tradeStore: integrity check — all order_fills.attempt_id values resolve correctly to order_attempts.id");
    }
  } catch (err) {
    logger.warn({ err }, "tradeStore: integrity check for orphaned attempt_id values failed — skipping");
  }

  // Step 6: startup retention sweep — prune evaluation_events rows older than
  // the default retention window.  Fire-and-forget; a failure here is logged
  // but never blocks startup or trading.
  void pruneEvaluationEvents().catch((err) => {
    logger.warn({ err }, "tradeStore: startup pruneEvaluationEvents threw unexpectedly");
  });

  // Step 7: startup retention sweep — prune coverage_incidents rows older than
  // the default retention window.  Mirrors Step 6; fire-and-forget.
  void pruneCoverageIncidents().catch((err) => {
    logger.warn({ err }, "tradeStore: startup pruneCoverageIncidents threw unexpectedly");
  });
}

// ── Orphaned fill-link integrity cache ───────────────────────────────────────
// Populated once during initTradeStore (Step 6) and read by /trade/status.
let _orphanedFillLinkCount: number = 0;
let _orphanedFillLinkCheckedAt: string | null = null;

/** Returns the orphaned fill-link count and timestamp cached at startup. */
export function getOrphanedFillLinkStatus(): { count: number; checkedAt: string | null } {
  return { count: _orphanedFillLinkCount, checkedAt: _orphanedFillLinkCheckedAt };
}

/** Returns true when the DB is connected and schema is reachable. */
export function isStorageHealthy(): boolean { return _healthy; }

export interface ProtectiveExitAttemptRecord {
  id: string; timestampMs: number; ticker: string; asset: "BTC" | "ETH" | "SOL" | "DOGE";
  heldSide: "yes" | "no"; linkedEntryId?: string | null;
  originalEntryPriceCents?: number | null; originalFillQuantity?: number | null;
  confirmedPositionBefore: number; triggerCents: number; executableBidCents?: number | null;
  bidDepthContracts?: number | null; quoteTimestampMs?: number | null; quoteAgeMs?: number | null;
  requestedContracts?: number | null; limitPriceCents: number; timeInForce: "immediate_or_cancel";
  postInitiated: boolean; responseReceived: boolean; kalshiOrderId?: string | null;
  fillQuantity?: number | null; averageExitPriceCents?: number | null; remainingPosition?: number | null;
  outcome: string; reason?: string | null; rawBook?: string | null;
}

/** Durable protective-exit audit write. This is deliberately strict: callers use
 * false as a pre-POST hard stop rather than buffering an unrecorded exit. */
export async function createProtectiveExitAttempt(record: ProtectiveExitAttemptRecord): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    await _db.insert(protectiveExitAttempts).values({
      ...record,
      linkedEntryId: record.linkedEntryId ?? null,
      originalEntryPriceCents: record.originalEntryPriceCents ?? null,
      originalFillQuantity: record.originalFillQuantity ?? null,
      executableBidCents: record.executableBidCents ?? null,
      bidDepthContracts: record.bidDepthContracts ?? null,
      quoteTimestampMs: record.quoteTimestampMs ?? null,
      quoteAgeMs: record.quoteAgeMs ?? null,
      requestedContracts: record.requestedContracts ?? null,
      kalshiOrderId: record.kalshiOrderId ?? null,
      fillQuantity: record.fillQuantity ?? null,
      averageExitPriceCents: record.averageExitPriceCents ?? null,
      remainingPosition: record.remainingPosition ?? null,
      reason: record.reason ?? null,
      rawBook: record.rawBook ?? null,
    }).onConflictDoNothing();
    _lastWriteMs = Date.now();
    return true;
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err);
    _degradedReason = `createProtectiveExitAttempt failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("protective_exit");
    _scheduleRetry();
    logger.error({ err, id: record.id }, "tradeStore: protective exit audit write failed");
    return false;
  }
}

export async function updateProtectiveExitAttempt(
  id: string,
  patch: Partial<Pick<ProtectiveExitAttemptRecord,
    "postInitiated" | "responseReceived" | "kalshiOrderId" | "fillQuantity" |
    "averageExitPriceCents" | "remainingPosition" | "outcome" | "reason">>,
): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    await _db.update(protectiveExitAttempts).set({ ...patch, updatedAt: new Date() }).where(eq(protectiveExitAttempts.id, id));
    _lastWriteMs = Date.now();
    return true;
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err);
    _degradedReason = `updateProtectiveExitAttempt failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("protective_exit");
    _scheduleRetry();
    logger.error({ err, id }, "tradeStore: protective exit audit update failed");
    return false;
  }
}

export async function loadProtectiveExitAttempts(limit = 100): Promise<ProtectiveExitAttemptRecord[]> {
  if (!_db || !_healthy) return [];
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await _db.select().from(protectiveExitAttempts)
    .orderBy(desc(protectiveExitAttempts.timestampMs)).limit(safeLimit);
  return rows.map((row) => ({
    ...row,
    asset: row.asset as "BTC" | "ETH" | "SOL" | "DOGE",
    heldSide: row.heldSide as "yes" | "no",
    timeInForce: "immediate_or_cancel" as const,
  }));
}

/** Read-only weekly reporting summary from the durable child-fill ledger. */
export interface WeeklyExecutionEvidence {
  available: boolean;
  filledOrderCount: number;
  ledgerBackedOrderCount: number;
  ledgerFillCount: number;
  filledContracts: number | null;
  filledNotionalDollars: number | null;
  feeDollars: number | null;
  preliminaryOrderCount: number;
  preliminaryNotionalDollars: number | null;
  preliminaryFeeDollars: number | null;
}

/**
 * Returns entry-week execution exposure. Canonical child fills are authoritative
 * for money values; parent-only fills remain explicitly preliminary and are not
 * folded into the verified totals.
 */
export async function getWeeklyExecutionEvidence(
  fromEasternDate: string,
  toEasternDateInclusive: string,
): Promise<WeeklyExecutionEvidence> {
  const unavailable: WeeklyExecutionEvidence = {
    available: false, filledOrderCount: 0, ledgerBackedOrderCount: 0, ledgerFillCount: 0,
    filledContracts: null, filledNotionalDollars: null, feeDollars: null,
    preliminaryOrderCount: 0, preliminaryNotionalDollars: null, preliminaryFeeDollars: null,
  };
  if (!_db || !_healthy) return unavailable;
  try {
    const result = await _db.execute<{
      filled_order_count: string | number; ledger_backed_order_count: string | number;
      ledger_fill_count: string | number; filled_contracts: string | number | null;
      filled_notional_dollars: string | number | null; fee_dollars: string | number | null;
      preliminary_order_count: string | number; preliminary_notional_dollars: string | number | null;
      preliminary_fee_dollars: string | number | null;
    }>(sql`
      WITH canonical_attempts AS (
        SELECT DISTINCT ON (COALESCE(order_id, id))
          id, order_id, notional_dollars, fee_dollars
        FROM order_attempts
        WHERE eastern_date >= ${fromEasternDate} AND eastern_date <= ${toEasternDateInclusive}
          AND outcome IN ('full_fill', 'partial_fill', 'filled', 'partially_filled')
          AND is_synthetic = false
        ORDER BY COALESCE(order_id, id), reconciled DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      ),
      ledger AS (
        SELECT f.order_id, COUNT(*) AS fill_count, SUM(f.contracts) AS contracts,
          SUM(COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric)) AS cost,
          SUM(COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric)) AS fees
        FROM order_fills f
        INNER JOIN canonical_attempts a ON a.order_id = f.order_id
        WHERE f.canonical_economics IS TRUE
        GROUP BY f.order_id
      )
      SELECT
        COUNT(*) AS filled_order_count,
        COUNT(ledger.order_id) AS ledger_backed_order_count,
        COALESCE(SUM(ledger.fill_count), 0) AS ledger_fill_count,
        SUM(ledger.contracts) AS filled_contracts,
        SUM(ledger.cost) AS filled_notional_dollars,
        SUM(ledger.fees) AS fee_dollars,
        COUNT(*) FILTER (WHERE ledger.order_id IS NULL) AS preliminary_order_count,
        SUM(a.notional_dollars) FILTER (WHERE ledger.order_id IS NULL) AS preliminary_notional_dollars,
        SUM(a.fee_dollars) FILTER (WHERE ledger.order_id IS NULL) AS preliminary_fee_dollars
      FROM canonical_attempts a
      LEFT JOIN ledger ON ledger.order_id = a.order_id
    `);
    const row = result.rows?.[0];
    const numeric = (value: unknown): number | null => value == null ? null : Number(value);
    const values = [
      Number(row?.filled_order_count ?? 0), Number(row?.ledger_backed_order_count ?? 0),
      Number(row?.ledger_fill_count ?? 0), numeric(row?.filled_contracts),
      numeric(row?.filled_notional_dollars), numeric(row?.fee_dollars),
      Number(row?.preliminary_order_count ?? 0), numeric(row?.preliminary_notional_dollars),
      numeric(row?.preliminary_fee_dollars),
    ];
    if (!values.every((value) => value === null || Number.isFinite(value))) throw new Error("weekly execution query returned non-numeric values");
    return {
      available: true,
      filledOrderCount: Number(row?.filled_order_count ?? 0),
      ledgerBackedOrderCount: Number(row?.ledger_backed_order_count ?? 0),
      ledgerFillCount: Number(row?.ledger_fill_count ?? 0),
      filledContracts: numeric(row?.filled_contracts),
      filledNotionalDollars: numeric(row?.filled_notional_dollars),
      feeDollars: numeric(row?.fee_dollars),
      preliminaryOrderCount: Number(row?.preliminary_order_count ?? 0),
      preliminaryNotionalDollars: numeric(row?.preliminary_notional_dollars),
      preliminaryFeeDollars: numeric(row?.preliminary_fee_dollars),
    };
  } catch (err) {
    logger.warn({ err, fromEasternDate, toEasternDateInclusive }, "tradeStore: weekly execution evidence query failed");
    return unavailable;
  }
}

/** Read protective-exit audit rows in an explicit entry-week range. */
export async function loadProtectiveExitAttemptsForRange(
  fromMs: number,
  toMsExclusive: number,
): Promise<ProtectiveExitAttemptRecord[] | null> {
  if (!_db || !_healthy) return null;
  try {
    const rows = await _db.select().from(protectiveExitAttempts)
      .where(and(
        gte(protectiveExitAttempts.timestampMs, fromMs),
        sql`${protectiveExitAttempts.timestampMs} < ${toMsExclusive}`,
      ))
      .orderBy(desc(protectiveExitAttempts.timestampMs));
    return rows.map((row) => ({ ...row, asset: row.asset as "BTC" | "ETH" | "SOL" | "DOGE", heldSide: row.heldSide as "yes" | "no", timeInForce: "immediate_or_cancel" as const }));
  } catch (err) {
    logger.warn({ err, fromMs, toMsExclusive }, "tradeStore: weekly protective exit query failed");
    return null;
  }
}

// ── Public: outcome state types ───────────────────────────────────────────────

/**
 * All valid values for the `order_attempts.outcome` column.
 * The column is TEXT in SQL (no CHECK constraint), so this is a TypeScript-level
 * exhaustive union. Legacy values (pending, zero_fill, etc.) remain valid for
 * rows written before the state-machine migration was introduced.
 */
export type AttemptOutcome =
  // State machine states (preferred for new code)
  | "reserved"                      // SQL row inserted, budget reserved — no POST yet
  | "post_started"                  // POST to Kalshi initiated (in-flight)
  | "post_start_persistence_failed" // SQL transition to post_started threw — POST was aborted
  | "post_confirmed"                // POST accepted by Kalshi (order created)
  | "post_rejected"                 // POST definitively rejected by Kalshi
  | "post_unknown"                  // POST timed out / network error — outcome unknown
  | "partially_filled"              // Kalshi reports partial fill
  | "filled"                        // Kalshi reports full fill
  | "cancelled"                     // Order cancelled before fill
  | "reconciled_not_found"          // Kalshi could not find the order on reconciliation
  | "interrupted_shutdown"          // SIGTERM fired while POST was in-flight
  // Legacy values (backward compat with rows written before migration)
  | "pending"                       // pre-rename alias for "reserved"
  | "zero_fill"                     // IOC returned 0 fills
  | "partial_fill"                  // IOC returned partial fill
  | "full_fill";                    // IOC returned full fill

/**
 * Outcomes that are NOT yet finalised — row retains its budget reservation.
 * Used to exclude unresolved rows from analytics load queries.
 */
export const UNRESOLVED_OUTCOMES: string[] = [
  "pending", "reserved", "post_started", "post_unknown", "interrupted_shutdown",
];

/** Human-readable reason for degraded status (empty when healthy). */
export function getStorageDegradedReason(): string { return _degradedReason; }

/** Last error string from a failed connection attempt, or "" when healthy. */
export function getLastDatabaseError(): string { return _lastErrorMsg; }

/** Unix-ms timestamp of the last successful SELECT 1, or null if never succeeded. */
export function getLastDatabaseSuccessAt(): number | null { return _lastSuccessAt; }

/** Total number of reconnect attempts made since process start. */
export function getDatabaseRetryCount(): number { return _retryCount; }

/** Durable audit for the account-history daily-profit entry gate. */
export async function recordDailyProfitStopAuditToSql(record: {
  easternDate: string; kind: "triggered" | "rejected"; ticker?: string | null;
  realizedPnlDollars: number | null; source: string; sourceStatus: string; retrievedAt: string | null;
  reason?: string | null;
}): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db.execute(sql`
      INSERT INTO daily_profit_stop_audit
        (eastern_date, kind, ticker, realized_pnl_dollars, source, source_status, retrieved_at, reason)
      VALUES (${record.easternDate}, ${record.kind}, ${record.ticker ?? null},
        ${record.realizedPnlDollars}, ${record.source}, ${record.sourceStatus}, ${record.retrievedAt},
        ${record.reason ?? null})
    `);
  } catch (err) {
    logger.warn({ err, record }, "tradeStore: daily profit-stop audit SQL write failed");
  }
}

/** Recent daily-profit audit history for authenticated operational review. */
export async function loadDailyProfitStopAuditsFromSql(limit = 100): Promise<Array<Record<string, unknown>>> {
  if (!_db || !_healthy) return [];
  try {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const result = await _db.execute(sql`
      SELECT eastern_date, kind, ticker, realized_pnl_dollars, source, source_status, retrieved_at, reason, created_at
      FROM daily_profit_stop_audit
      ORDER BY created_at DESC
      LIMIT ${safeLimit}
    `);
    return (result.rows ?? []) as Array<Record<string, unknown>>;
  } catch (err) {
    logger.warn({ err }, "tradeStore: daily profit-stop audit SQL read failed");
    return [];
  }
}

/**
 * Trigger an immediate reconnect attempt, cancelling any pending timer.
 * No-op when already healthy or when DATABASE_URL is missing (_db is null).
 * Used by the /trade/storage/retry endpoint.
 */
export function retryDatabaseConnectionNow(): void {
  if (_healthy) return;
  if (!_db)    return; // config error — restart required
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  _retryScheduled = false;
  _retryCount++;
  logger.info({ retryCount: _retryCount }, "tradeStore: on-demand database reconnect triggered");
  void _maybeResetPool().then(() => _attemptPing()).then(() => {
    logger.info(
      { retryCount: _retryCount, lastSuccessAt: new Date(_lastSuccessAt!).toISOString() },
      "tradeStore: storage recovered (on-demand) — trading unblocked",
    );
    void _drainPendingFinalisations();
    void _drainPendingDurableWrites();
  }).catch((err: unknown) => {
    _lastErrorMsg   = String(err);
    _degradedReason = `DB reconnect failed (on-demand, attempt ${_retryCount}): ${_lastErrorMsg}`;
    logger.error({ err, retryCount: _retryCount }, "tradeStore: on-demand reconnect failed — scheduling retry");
    _scheduleRetry();
  });
}

// ── Public: startup restore ───────────────────────────────────────────────────

export interface RestoreResult {
  /** spentCents for today's Eastern date from SQL (0 if not found). */
  spentCents:  number;
  /** Non-expired dedup slots: key → claimedAtMs */
  dedupSlots:  Map<string, number>;
}

/**
 * Read today's budget and all non-expired dedup slots from SQL.
 * Called once at startup (after initTradeStore) to seed in-memory state.
 */
export async function restoreState(easternDate: string): Promise<RestoreResult> {
  const empty: RestoreResult = { spentCents: 0, dedupSlots: new Map() };
  if (!_db || !_healthy) return empty;

  try {
    const now = Date.now();

    const [budgetRows, dedupRows] = await Promise.all([
      _db.select({ spentCents: dailyBudgetTable.spentCents })
         .from(dailyBudgetTable)
         .where(eq(dailyBudgetTable.easternDate, easternDate))
         .limit(1),
      _db.select({ tickerKey: orderDedup.tickerKey, claimedAtMs: orderDedup.claimedAtMs })
         .from(orderDedup)
         .where(gt(orderDedup.expiresAtMs, now)),
    ]);

    const spentCents = budgetRows[0]?.spentCents ?? 0;
    const dedupSlots = new Map<string, number>();
    for (const row of dedupRows) {
      dedupSlots.set(row.tickerKey, row.claimedAtMs);
    }

    _restoredSpentCents = spentCents;
    _restoredDedupSlots = dedupSlots.size;

    logger.info(
      { easternDate, spentCents, dedupSlots: dedupSlots.size },
      "tradeStore: restored state from SQL",
    );

    return { spentCents, dedupSlots };
  } catch (err) {
    logger.error({ err }, "tradeStore: restoreState failed");
    return empty;
  }
}

/**
 * Return the distinct set of tickers that have at least one confirmed filled
 * order that has not yet settled (won IS NULL).  Used at startup to log which
 * tickers the protective exit will watch on the first price tick.
 *
 * This is indicative, not authoritative: a filled entry with won=null remains
 * in the result even after its contracts were sold by a protective exit, because
 * the market has not yet settled.  The evaluator re-verifies position via the
 * Kalshi API before any exit order is submitted, so no false exits can occur.
 *
 * Returns null when storage is unhealthy or the query fails, so callers can
 * distinguish a genuine empty result from a failed lookup.
 */
export async function getOpenConfirmedPositionTickers(): Promise<string[] | null> {
  if (!_db || !_healthy) return null;
  try {
    const rows = await _db
      .selectDistinct({ ticker: orderAttempts.ticker })
      .from(orderAttempts)
      .where(
        and(
          inArray(orderAttempts.outcome, [
            "full_fill", "partial_fill", "filled", "partially_filled",
          ]),
          isNull(orderAttempts.won),
          realOrderPredicate(),
        ),
      );
    return rows.map((r) => r.ticker);
  } catch (err) {
    logger.warn({ err }, "tradeStore: getOpenConfirmedPositionTickers failed");
    return null;
  }
}

export interface OpenConfirmedPosition {
  ticker: string;
  side: "yes" | "no";
  quantity: number;
}

/**
 * Startup restore query with signed detail: filled, unsettled real orders
 * aggregated to per-ticker side + total filled quantity. Null on DB failure.
 * When a ticker somehow has fills on both sides, the larger side wins (the
 * protective-exit monitor treats it as best-effort local knowledge only).
 */
export async function getOpenConfirmedPositions(): Promise<OpenConfirmedPosition[] | null> {
  if (!_db || !_healthy) return null;
  try {
    const rows = await _db
      .select({
        ticker: orderAttempts.ticker,
        side: orderAttempts.side,
        fillCount: orderAttempts.fillCount,
        contracts: orderAttempts.contracts,
      })
      .from(orderAttempts)
      .where(
        and(
          inArray(orderAttempts.outcome, [
            "full_fill", "partial_fill", "filled", "partially_filled",
          ]),
          isNull(orderAttempts.won),
          realOrderPredicate(),
        ),
      );
    const byKey = new Map<string, OpenConfirmedPosition>();
    for (const row of rows) {
      const side = row.side === "no" ? "no" : "yes";
      const quantity = Math.max(0, Math.trunc(Number(row.contracts ?? row.fillCount ?? 0)));
      const key = `${row.ticker}:${side}`;
      const existing = byKey.get(key);
      if (existing) existing.quantity += quantity;
      else byKey.set(key, { ticker: row.ticker, side, quantity });
    }
    // Larger side wins per ticker.
    const byTicker = new Map<string, OpenConfirmedPosition>();
    for (const pos of byKey.values()) {
      const existing = byTicker.get(pos.ticker);
      if (!existing || pos.quantity > existing.quantity) byTicker.set(pos.ticker, pos);
    }
    return [...byTicker.values()];
  } catch (err) {
    logger.warn({ err }, "tradeStore: getOpenConfirmedPositions failed");
    return null;
  }
}

/** Retired-strategy ledgers that can still represent exchange exposure. */
export async function getOpenLegacyPositionTickers(): Promise<string[] | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`
      SELECT DISTINCT ticker FROM (
        SELECT ticker FROM doge_martingale_orders
          WHERE settlement_result IS NULL AND outcome IN ('full_fill', 'partial_fill')
        UNION
        SELECT ticker FROM eth30_position_events
          WHERE settlement_result IS NULL AND contracts_after > 0
        UNION
        SELECT ticker FROM sol30_position_events
          WHERE settlement_result IS NULL AND contracts_after > 0
      ) open_legacy_positions`);
    return (result as unknown as { rows: Array<{ ticker: string }> }).rows
      .map((row) => row.ticker)
      .filter((ticker) => typeof ticker === "string" && ticker !== "");
  } catch (err) {
    logger.warn({ err }, "tradeStore: getOpenLegacyPositionTickers failed");
    return null;
  }
}

// ── Public: atomic reserve-and-record ────────────────────────────────────────

export interface ReserveAndRecordParams {
  clientOrderId:          string;
  ticker:                 string;
  series:                 string;
  windowCloseTime:        string | null;
  side:                   "yes" | "no";
  source:                 string;
  triggerPriceCents:      number;
  limitPriceCents:        number;
  requestedContracts:     number;
  requestedNotionalCents: number;
  attemptNumber?:         number;
  easternDate:            string;
  /** Test-only explicit provenance; production callers must leave this unset. */
  syntheticFixture?:      boolean;
  fixtureNamespace?:      string;
}

export interface ReserveResult {
  claimed: boolean;
  reason?: "storage_degraded" | "dedup_conflict" | "sql_error";
}

export interface DailyRealizedPnl {
  easternDate: string;
  /** Settled, fee-reconciled net bot P&L only. Null means it is not safe to use. */
  realizedNetPnlDollars: number | null;
  settledFillCount: number;
  /** Settled orders still awaiting verified Kalshi fill chunks. */
  pendingVerificationCount: number;
  /**
   * Number of settled orders whose short reconciliation retry window failed.
   * They have no trustworthy fee/fill evidence and make realizedNetPnlDollars
   * unavailable until a later recovery sweep verifies their ledger.
   */
  unverifiedFillCount: number;
}

export interface VerifiedPnlBySeriesRow {
  series: string;
  /** Null when a settled order in this series lacks its authoritative fill chunks. */
  realizedNetPnlDollars: number | null;
  settledFillCount: number;
  pendingVerificationCount: number;
  unverifiedFillCount: number;
}

export interface VerifiedPnlBySeries {
  bySeries: VerifiedPnlBySeriesRow[];
  combined: Omit<VerifiedPnlBySeriesRow, "series">;
}

export interface VerifiedPnlByTierRow {
  tierLabel: string;
  /** Lower bound of the tier (cents, inclusive). */
  minCents: number;
  /** Upper bound of the tier (cents, inclusive). */
  maxCents: number;
  /** Null when a settled order in this tier lacks its authoritative fill chunks. */
  realizedNetPnlDollars: number | null;
  settledFillCount: number;
  pendingVerificationCount: number;
  unverifiedFillCount: number;
}

export interface VerifiedPnlByTier {
  byTier: VerifiedPnlByTierRow[];
  combined: Omit<VerifiedPnlByTierRow, "tierLabel" | "minCents" | "maxCents">;
}

/**
 * Return verified Kalshi fill-ledger P&L grouped by series for an optional
 * inclusive Eastern-date range. Exact child fills and the Kalshi market-result
 * cache are the accounting authority; the local `won` flag is only a cached
 * convenience and must never make a settled exchange result disappear.
 *
 * A group becomes unavailable when even one settled parent has no fill chunks.
 * Returning a partial dollar value in that case would make a missing exchange
 * order look like a real loss or profit.
 */
export async function getVerifiedPnlBySeries(
  fromEasternDate?: string,
  toEasternDate?: string,
): Promise<VerifiedPnlBySeries> {
  const unavailable: VerifiedPnlBySeries = {
    bySeries: [],
    combined: {
      realizedNetPnlDollars: null,
      settledFillCount: 0,
      pendingVerificationCount: 0,
      unverifiedFillCount: 0,
    },
  };
  if (!_db || !_healthy) return unavailable;

  try {
    const result = await _db.execute<{
      series: string;
      realized_net_pnl_dollars: string | number | null;
      settled_fill_count: string | number;
      pending_verification_count: string | number;
      unverified_fill_count: string | number;
    }>(sql`
      WITH canonical_attempts AS (
        SELECT DISTINCT ON (COALESCE(order_id, id))
          id, order_id, ticker, series, side, reconciled, reconcile_failed, won
        FROM order_attempts
        WHERE outcome IN ('full_fill', 'partial_fill', 'filled', 'partially_filled')
          AND (${process.env["TRADE_STORE_INCLUDE_SYNTHETIC_FOR_TESTS"] === "true"} OR is_synthetic = false)
          AND (${fromEasternDate ?? null}::text IS NULL OR eastern_date >= ${fromEasternDate ?? null})
          AND (${toEasternDate ?? null}::text IS NULL OR eastern_date <= ${toEasternDate ?? null})
        ORDER BY COALESCE(order_id, id), reconciled DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      ),
      verification AS (
        SELECT
          canonical_attempts.*,
          market_results.result AS market_result,
          EXISTS (
            SELECT 1 FROM order_fills f
            WHERE f.order_id = canonical_attempts.order_id
              AND f.canonical_economics IS TRUE
          ) AS has_fill_ledger
        FROM canonical_attempts
        LEFT JOIN market_results ON market_results.ticker = canonical_attempts.ticker
      )
      SELECT
        series,
        COALESCE(SUM(
          CASE
            -- Uses market_result when available; falls back to the cached won column so
            -- that orders settled via recoverForwardSettlementsFromSql() (which writes won
            -- directly on order_attempts without always having a matching market_results
            -- row) are included in the P&L computation.
            WHEN verification.reconciled IS TRUE AND (
              verification.market_result = verification.side
              OR (verification.market_result IS NULL AND verification.won IS TRUE)
            )
              THEN f.contracts - COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric)
                   - COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric)
            WHEN verification.reconciled IS TRUE AND (
              verification.market_result IN ('yes', 'no')
              OR (verification.market_result IS NULL AND verification.won IS FALSE)
            )
              THEN -COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric)
                   - COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric)
            ELSE 0
          END
        ), 0) AS realized_net_pnl_dollars,
        -- Count an order as "settled" when we have a confirmed market result from
        -- the exchange (market_results table) OR the cached won column is populated,
        -- which happens after recoverForwardSettlementsFromSql() runs.
        COUNT(DISTINCT verification.id) FILTER (
          WHERE verification.market_result IN ('yes', 'no')
            OR verification.won IS NOT NULL
        ) AS settled_fill_count,
        -- An order is "pending verification" if: (a) settlement outcome is
        -- unknown (no market_result AND won IS NULL), OR (b) the fill ledger
        -- hasn't been reconciled yet (reconciled IS NOT TRUE), OR (c) there are
        -- no verified fill chunks (has_fill_ledger IS NOT TRUE).  When won IS
        -- NOT NULL, settlement outcome is known even without a market_results
        -- row, so condition (a) is satisfied and the row is not pending for that
        -- reason — it may still be pending for (b) or (c).
        COUNT(DISTINCT verification.id) FILTER (
          WHERE (
            (verification.market_result IS NULL OR verification.market_result NOT IN ('yes', 'no'))
            AND verification.won IS NULL
          )
            OR COALESCE(verification.reconciled, FALSE) IS NOT TRUE
            OR verification.has_fill_ledger IS NOT TRUE
        ) AS pending_verification_count,
        COUNT(DISTINCT verification.id) FILTER (
          WHERE COALESCE(verification.reconcile_failed, FALSE) IS TRUE
            AND verification.has_fill_ledger IS NOT TRUE
        ) AS unverified_fill_count
      FROM verification
      LEFT JOIN order_fills f ON f.order_id = verification.order_id AND f.canonical_economics IS TRUE
      GROUP BY series
      ORDER BY series
    `);

    const bySeries = (result.rows ?? []).map((row): VerifiedPnlBySeriesRow => {
      const settledFillCount = Number(row.settled_fill_count);
      const pendingVerificationCount = Number(row.pending_verification_count);
      const unverifiedFillCount = Number(row.unverified_fill_count);
      const pnl = Number(row.realized_net_pnl_dollars ?? 0);
      if (![settledFillCount, pendingVerificationCount, unverifiedFillCount, pnl].every(Number.isFinite)) {
        throw new Error("verified per-series P&L query returned non-numeric values");
      }
      return {
        series: row.series || "unknown",
        realizedNetPnlDollars: pendingVerificationCount > 0 ? null : pnl,
        settledFillCount,
        pendingVerificationCount,
        unverifiedFillCount,
      };
    });

    const combined = {
      settledFillCount: bySeries.reduce((total, row) => total + row.settledFillCount, 0),
      pendingVerificationCount: bySeries.reduce((total, row) => total + row.pendingVerificationCount, 0),
      unverifiedFillCount: bySeries.reduce((total, row) => total + row.unverifiedFillCount, 0),
      realizedNetPnlDollars: bySeries.some((row) => row.realizedNetPnlDollars === null)
        ? null
        : bySeries.reduce((total, row) => total + (row.realizedNetPnlDollars ?? 0), 0),
    };
    return { bySeries, combined };
  } catch (err) {
    logger.warn({ err, fromEasternDate, toEasternDate }, "tradeStore: verified per-series P&L query failed");
    return unavailable;
  }
}

/**
 * Return verified Kalshi fill-ledger P&L grouped by price tier for an optional
 * inclusive Eastern-date range.  Tier labels are derived from
 * `trigger_price_cents` using the current PRICE_TIERS boundaries.
 *
 * The won-fallback ensures that orders settled via recoverForwardSettlementsFromSql()
 * — which writes `won` directly on order_attempts without always having a
 * matching market_results row — are counted correctly in every tier bucket.
 *
 * A group becomes unavailable when even one settled parent has no fill chunks.
 */
export async function getVerifiedPnlByTier(
  fromEasternDate?: string,
  toEasternDate?: string,
): Promise<VerifiedPnlByTier> {
  const unavailable: VerifiedPnlByTier = {
    byTier: [],
    combined: {
      realizedNetPnlDollars: null,
      settledFillCount: 0,
      pendingVerificationCount: 0,
      unverifiedFillCount: 0,
    },
  };
  if (!_db || !_healthy) return unavailable;

  // Build SQL CASE expressions that map trigger_price_cents to tier metadata.
  // tierLabelExpr uses buildTierSqlCaseString() — the single exported source of
  // truth shared with tierLabel() — so any boundary change in PRICE_TIERS is
  // reflected in both the observation stamp and this query automatically.
  const tierLabelExpr    = sql.raw(buildTierSqlCaseString());
  const tierMinCentsExpr = sql.raw(
    `CASE ${PRICE_TIERS.map((t) => `WHEN trigger_price_cents >= ${t.min} AND trigger_price_cents <= ${t.max} THEN ${t.min}`).join(" ")} ELSE NULL END`,
  );
  const tierMaxCentsExpr = sql.raw(
    `CASE ${PRICE_TIERS.map((t) => `WHEN trigger_price_cents >= ${t.min} AND trigger_price_cents <= ${t.max} THEN ${t.max}`).join(" ")} ELSE NULL END`,
  );

  try {
    const result = await _db.execute<{
      tier_label: string;
      min_cents: string | number | null;
      max_cents: string | number | null;
      realized_net_pnl_dollars: string | number | null;
      settled_fill_count: string | number;
      pending_verification_count: string | number;
      unverified_fill_count: string | number;
    }>(sql`
      WITH canonical_attempts AS (
        SELECT DISTINCT ON (COALESCE(order_id, id))
          id, order_id, ticker, trigger_price_cents, side, reconciled, reconcile_failed, won
        FROM order_attempts
        WHERE outcome IN ('full_fill', 'partial_fill', 'filled', 'partially_filled')
          AND (${process.env["TRADE_STORE_INCLUDE_SYNTHETIC_FOR_TESTS"] === "true"} OR is_synthetic = false)
          AND (${fromEasternDate ?? null}::text IS NULL OR eastern_date >= ${fromEasternDate ?? null})
          AND (${toEasternDate ?? null}::text IS NULL OR eastern_date <= ${toEasternDate ?? null})
        ORDER BY COALESCE(order_id, id), reconciled DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      ),
      verification AS (
        SELECT
          canonical_attempts.*,
          ${tierLabelExpr}    AS tier_label,
          ${tierMinCentsExpr} AS min_cents,
          ${tierMaxCentsExpr} AS max_cents,
          market_results.result AS market_result,
          EXISTS (
            SELECT 1 FROM order_fills f
            WHERE f.order_id = canonical_attempts.order_id
              AND f.canonical_economics IS TRUE
          ) AS has_fill_ledger
        FROM canonical_attempts
        LEFT JOIN market_results ON market_results.ticker = canonical_attempts.ticker
      )
      SELECT
        tier_label,
        MIN(min_cents)::integer AS min_cents,
        MAX(max_cents)::integer AS max_cents,
        COALESCE(SUM(
          CASE
            -- Uses market_result when available; falls back to the cached won column so
            -- that orders settled via recoverForwardSettlementsFromSql() (which writes won
            -- directly on order_attempts without always having a matching market_results
            -- row) are included in the P&L computation.
            WHEN verification.reconciled IS TRUE AND (
              verification.market_result = verification.side
              OR (verification.market_result IS NULL AND verification.won IS TRUE)
            )
              THEN f.contracts - COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric)
                   - COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric)
            WHEN verification.reconciled IS TRUE AND (
              verification.market_result IN ('yes', 'no')
              OR (verification.market_result IS NULL AND verification.won IS FALSE)
            )
              THEN -COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric)
                   - COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric)
            ELSE 0
          END
        ), 0) AS realized_net_pnl_dollars,
        -- Count an order as "settled" when we have a confirmed market result from
        -- the exchange (market_results table) OR the cached won column is populated,
        -- which happens after recoverForwardSettlementsFromSql() runs.
        COUNT(DISTINCT verification.id) FILTER (
          WHERE verification.market_result IN ('yes', 'no')
            OR verification.won IS NOT NULL
        ) AS settled_fill_count,
        COUNT(DISTINCT verification.id) FILTER (
          WHERE (
            (verification.market_result IS NULL OR verification.market_result NOT IN ('yes', 'no'))
            AND verification.won IS NULL
          )
            OR COALESCE(verification.reconciled, FALSE) IS NOT TRUE
            OR verification.has_fill_ledger IS NOT TRUE
        ) AS pending_verification_count,
        COUNT(DISTINCT verification.id) FILTER (
          WHERE COALESCE(verification.reconcile_failed, FALSE) IS TRUE
            AND verification.has_fill_ledger IS NOT TRUE
        ) AS unverified_fill_count
      FROM verification
      LEFT JOIN order_fills f ON f.order_id = verification.order_id AND f.canonical_economics IS TRUE
      GROUP BY tier_label
      ORDER BY MIN(COALESCE(min_cents, 0)) DESC
    `);

    const byTier = (result.rows ?? []).map((row): VerifiedPnlByTierRow => {
      const settledFillCount          = Number(row.settled_fill_count);
      const pendingVerificationCount  = Number(row.pending_verification_count);
      const unverifiedFillCount       = Number(row.unverified_fill_count);
      const pnl                       = Number(row.realized_net_pnl_dollars ?? 0);
      if (![settledFillCount, pendingVerificationCount, unverifiedFillCount, pnl].every(Number.isFinite)) {
        throw new Error("verified per-tier P&L query returned non-numeric values");
      }
      return {
        tierLabel:                row.tier_label || "other",
        minCents:                 row.min_cents == null ? 0 : Number(row.min_cents),
        maxCents:                 row.max_cents == null ? 0 : Number(row.max_cents),
        realizedNetPnlDollars:    pendingVerificationCount > 0 ? null : pnl,
        settledFillCount,
        pendingVerificationCount,
        unverifiedFillCount,
      };
    });

    const combined = {
      settledFillCount:         byTier.reduce((t, r) => t + r.settledFillCount, 0),
      pendingVerificationCount: byTier.reduce((t, r) => t + r.pendingVerificationCount, 0),
      unverifiedFillCount:      byTier.reduce((t, r) => t + r.unverifiedFillCount, 0),
      realizedNetPnlDollars:    byTier.some((r) => r.realizedNetPnlDollars === null)
        ? null
        : byTier.reduce((t, r) => t + (r.realizedNetPnlDollars ?? 0), 0),
    };
    return { byTier, combined };
  } catch (err) {
    logger.warn({ err, fromEasternDate, toEasternDate }, "tradeStore: verified per-tier P&L query failed");
    return unavailable;
  }
}

/**
 * Returns the current Eastern day's realized bot P&L from verified fill chunks.
 *
 * A Kalshi order may have duplicate local attempt rows after a restart, so the
 * query first reduces attempts to one canonical row per order ID. The P&L then
 * combines Kalshi's market result with its durable exact child fill chunks,
 * never an estimated parent total or a stale local outcome cache. If a settled
 * order lacks a verified child ledger, return null rather than showing a
 * partial daily figure.
 */
export async function getDailyRealizedPnl(
  easternDate = easternDay(new Date()),
): Promise<DailyRealizedPnl> {
  if (!_db || !_healthy) {
    return {
      easternDate, realizedNetPnlDollars: null, settledFillCount: 0,
      pendingVerificationCount: 0, unverifiedFillCount: 0,
    };
  }

  try {
    const result = await _db.execute<{
      realized_net_pnl_dollars: string | number | null;
      settled_fill_count: string | number;
      pending_verification_count: string | number;
      unverified_fill_count: string | number;
    }>(sql`
      WITH canonical_attempts AS (
        SELECT DISTINCT ON (COALESCE(order_id, id))
          id, order_id, ticker, side, reconciled, reconcile_failed, won
        FROM order_attempts
        WHERE eastern_date = ${easternDate}
          AND outcome IN ('full_fill', 'partial_fill', 'filled', 'partially_filled')
          AND (${process.env["TRADE_STORE_INCLUDE_SYNTHETIC_FOR_TESTS"] === "true"} OR is_synthetic = false)
        -- Prefer the verified duplicate when one local retry recorded the same
        -- exchange order ID; otherwise the latest durable row wins.
        ORDER BY COALESCE(order_id, id), reconciled DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      ),
      verification AS (
        SELECT
          canonical_attempts.*,
          market_results.result AS market_result,
          EXISTS (
            SELECT 1 FROM order_fills f
            WHERE f.order_id = canonical_attempts.order_id
          ) AS has_fill_ledger
        FROM canonical_attempts
        LEFT JOIN market_results ON market_results.ticker = canonical_attempts.ticker
      ),
      verified_ledger_pnl AS (
        -- Uses market_result when available; falls back to the cached won column so
        -- that orders settled via recoverForwardSettlementsFromSql() (which writes won
        -- directly on order_attempts without always having a matching market_results
        -- row) are included in the P&L computation.
        SELECT COALESCE(SUM(
          CASE
            WHEN verification.market_result = verification.side
              OR (verification.market_result IS NULL AND verification.won IS TRUE)
              THEN f.contracts - COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric)
                 - COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric)
            WHEN verification.market_result IN ('yes', 'no')
              OR (verification.market_result IS NULL AND verification.won IS FALSE)
              THEN -COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric)
                 - COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric)
            ELSE 0
          END
        ), 0) AS realized_net_pnl_dollars
        FROM verification
        INNER JOIN order_fills f ON f.order_id = verification.order_id
        WHERE COALESCE(verification.reconciled, FALSE) IS TRUE
      )
      SELECT
        (SELECT realized_net_pnl_dollars FROM verified_ledger_pnl) AS realized_net_pnl_dollars,
        -- Count an order as "settled" when we have a confirmed market result from
        -- the exchange (market_results table) OR the cached won column is populated,
        -- which happens after recoverForwardSettlementsFromSql() runs.
        COUNT(*) FILTER (
          WHERE verification.market_result IN ('yes', 'no')
            OR verification.won IS NOT NULL
        ) AS settled_fill_count,
        -- An order is "pending verification" if: (a) settlement outcome is
        -- unknown (no market_result AND won IS NULL), OR (b) the fill ledger
        -- hasn't been reconciled yet (reconciled IS NOT TRUE), OR (c) there are
        -- no verified fill chunks (has_fill_ledger IS NOT TRUE).  When won IS
        -- NOT NULL, settlement outcome is known even without a market_results
        -- row, so condition (a) is satisfied and the row is not pending for that
        -- reason — it may still be pending for (b) or (c).
        COUNT(*) FILTER (
          WHERE (
            (verification.market_result IS NULL OR verification.market_result NOT IN ('yes', 'no'))
            AND verification.won IS NULL
          )
            OR COALESCE(verification.reconciled, FALSE) IS NOT TRUE
            OR verification.has_fill_ledger IS NOT TRUE
        ) AS pending_verification_count,
        COUNT(*) FILTER (
          WHERE COALESCE(verification.reconcile_failed, FALSE) IS TRUE
            AND verification.has_fill_ledger IS NOT TRUE
        ) AS unverified_fill_count
      FROM verification
    `);
    const row = result.rows?.[0];
    const pnl = Number(row?.realized_net_pnl_dollars ?? 0);
    const fills = Number(row?.settled_fill_count ?? 0);
    const pendingVerification = Number(row?.pending_verification_count ?? 0);
    const unverifiedFills = Number(row?.unverified_fill_count ?? 0);
    if (!Number.isFinite(pnl) || !Number.isFinite(fills) || !Number.isFinite(pendingVerification) || !Number.isFinite(unverifiedFills)) {
      throw new Error("daily realized P&L query returned non-numeric values");
    }
    if (pendingVerification > 0) {
      logger.warn(
        { easternDate, settledFillCount: fills, pendingVerificationCount: pendingVerification, unverifiedFillCount: unverifiedFills },
        "tradeStore: daily realized P&L unavailable — settled orders lack verified fill-ledger evidence",
      );
      return {
        easternDate, realizedNetPnlDollars: null, settledFillCount: fills,
        pendingVerificationCount: pendingVerification, unverifiedFillCount: unverifiedFills,
      };
    }
    return {
      easternDate, realizedNetPnlDollars: pnl, settledFillCount: fills,
      pendingVerificationCount: 0, unverifiedFillCount: unverifiedFills,
    };
  } catch (err) {
    logger.warn({ err, easternDate }, "tradeStore: daily realized P&L query failed");
    return {
      easternDate, realizedNetPnlDollars: null, settledFillCount: 0,
      pendingVerificationCount: 0, unverifiedFillCount: 0,
    };
  }
}

/**
 * Atomically in a single SQL transaction:
 *   1. Insert dedup slot (conflict → order blocked)
 *   2. Upsert daily_budget (spent += requestedNotionalCents)
 *   3. Insert pending order_attempt row
 *
 * Must be awaited BEFORE calling the Kalshi API. If it returns
 * claimed=false, the caller MUST NOT call the Kalshi API.
 */
export async function reserveAndRecord(
  params: ReserveAndRecordParams,
): Promise<ReserveResult> {
  if (!_db || !_healthy) {
    return { claimed: false, reason: "storage_degraded" };
  }

  const dedupKey  = `${params.ticker}-${params.side}`;
  const now       = Date.now();
  const expiresMs = now + ORDER_DEDUP_WINDOW_MS;

  try {
    await _db.transaction(async (tx) => {
      // 1. Claim dedup slot
      const inserted = await tx
        .insert(orderDedup)
        .values({ tickerKey: dedupKey, claimedAtMs: now, expiresAtMs: expiresMs })
        .onConflictDoNothing()
        .returning({ tickerKey: orderDedup.tickerKey });

      if (inserted.length === 0) throw new DedupConflictError();

      // 2. Increment daily budget
      await tx
        .insert(dailyBudgetTable)
        .values({
          easternDate: params.easternDate,
          spentCents:  params.requestedNotionalCents,
          updatedAt:   new Date(),
        })
        .onConflictDoUpdate({
          target: dailyBudgetTable.easternDate,
          set: {
            spentCents: sql`${dailyBudgetTable.spentCents} + ${params.requestedNotionalCents}`,
            updatedAt:  new Date(),
          },
        });

      // 3. Insert pending order attempt
      await tx
        .insert(orderAttempts)
        .values({
          id:                     params.clientOrderId,
          timestampMs:            now,
          easternDate:            params.easternDate,
          ticker:                 params.ticker,
          series:                 params.series,
          windowCloseTime:        params.windowCloseTime,
          side:                   params.side,
          attemptNumber:          params.attemptNumber ?? null,
          source:                 params.source,
          triggerPriceCents:      params.triggerPriceCents,
          limitPriceCents:        params.limitPriceCents,
          requestedContracts:     params.requestedContracts,
          requestedNotionalCents: params.requestedNotionalCents,
          clientOrderId:          params.clientOrderId,
          outcome:                "reserved",
          isSynthetic:            params.syntheticFixture === true || process.env["TRADE_STORE_TEST_FIXTURES"] === "true",
          fixtureNamespace:       (params.syntheticFixture === true || process.env["TRADE_STORE_TEST_FIXTURES"] === "true")
            ? (params.fixtureNamespace?.slice(0, 120) || "test-fixture")
            : null,
        })
        .onConflictDoNothing();
    });

    _lastWriteMs = Date.now();
    return { claimed: true };
  } catch (err) {
    if (err instanceof DedupConflictError) {
      return { claimed: false, reason: "dedup_conflict" };
    }
    // Connection error (e.g. "Authentication timed out" 08P01, stale idle pool
    // connection dropped by the server) — mark storage degraded so the order is
    // blocked (fail-closed), then schedule an automatic reconnect so future
    // windows are not permanently locked out.
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `reserveAndRecord failed: ${_lastErrorMsg}`;
    logger.error({ err, ticker: params.ticker }, "tradeStore: reserveAndRecord FAILED — storage degraded, scheduling reconnect");
    recordDbBlockedOperation("entry");
    _scheduleRetry();
    return { claimed: false, reason: "sql_error" };
  }
}

// ── Public: order timeline instrumentation ──────────────────────────────────

export interface AttemptTimings {
  tickReceivedMs?: number | null;
  evalStartMs?:    number | null;
  l2StartMs?:      number | null;
  l2EndMs?:        number | null;
  postStartMs?:    number | null;
  ackMs?:          number | null;
  /** Pre-flight L2 snapshot: executable best ask (cents) at decision time. */
  l2BestAskCents?:   number | null;
  /** Pre-flight L2 snapshot: depth in dollars at the verified limit. */
  l2DepthDollars?:   number | null;
  /** Pre-flight L2 snapshot: depth in contracts at the verified limit. */
  l2DepthContracts?: number | null;
}

/** Persist the ms timeline for an order attempt. Fire-and-forget safe. */
export async function recordAttemptTimings(
  clientOrderId: string,
  t: AttemptTimings,
): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db
      .update(orderAttempts)
      .set({
        tickReceivedMs: t.tickReceivedMs ?? null,
        evalStartMs:    t.evalStartMs    ?? null,
        l2StartMs:      t.l2StartMs      ?? null,
        l2EndMs:        t.l2EndMs        ?? null,
        postStartMs:    t.postStartMs    ?? null,
        ackMs:          t.ackMs          ?? null,
        l2BestAskCents:   t.l2BestAskCents   ?? null,
        l2DepthDollars:   t.l2DepthDollars   ?? null,
        l2DepthContracts: t.l2DepthContracts ?? null,
        updatedAt:      new Date(),
      })
      .where(eq(orderAttempts.id, clientOrderId));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, clientOrderId }, "tradeStore: recordAttemptTimings failed");
  }
}

// ── Public: finalise order attempt ───────────────────────────────────────────

export interface FinaliseParams {
  clientOrderId:     string;
  outcome:           AttemptOutcome;
  orderId?:          string | null;
  fillCount?:        number | null;
  remainingCount?:   number | null;
  contracts?:        number | null;
  fillPriceCents?:   number | null;
  notionalDollars?:  number | null;
  feeDollars?:       number | null;
  roundTripMs?:      number | null;
  zeroFillDiagnostic?: string | null;
  /** 'actual' when fill price came from Kalshi response/fills API; 'limit_fallback' when unavailable. */
  fillPriceSource?:  "actual" | "limit_fallback" | null;
  submissionAudit?:  SubmissionAudit | null;
}

/** Update the order_attempt row with the fill result from Kalshi. Fire-and-forget safe. */
export async function finaliseOrderAttempt(p: FinaliseParams): Promise<void> {
  if (!_db || !_healthy) {
    // Queue for retry when DB recovers.  Without this, the row stays in
    // UNRESOLVED_OUTCOMES (reserved / post_started) and is permanently invisible
    // to the dashboard and analytics.
    _pendingFinalisations.set(p.clientOrderId, { kind: "finalise", params: p });
    logger.error(
      { clientOrderId: p.clientOrderId, outcome: p.outcome, pendingCount: _pendingFinalisations.size },
      "tradeStore: finaliseOrderAttempt skipped — DB unhealthy; queued for retry on recovery",
    );
    return;
  }
  try {
    await _db
      .update(orderAttempts)
      .set({
        outcome:           p.outcome,
        orderId:           p.orderId    ?? null,
        fillCount:         p.fillCount  ?? null,
        remainingCount:    p.remainingCount ?? null,
        contracts:         p.contracts  ?? null,
        fillPriceCents:    p.fillPriceCents ?? null,
        notionalDollars:   p.notionalDollars ?? null,
        feeDollars:        p.feeDollars ?? null,
        roundTripMs:       p.roundTripMs ?? null,
        zeroFillDiagnostic: p.zeroFillDiagnostic ?? null,
        fillPriceSource:   p.fillPriceSource ?? null,
        submissionAudit:   p.submissionAudit ? JSON.stringify(p.submissionAudit) : null,
        updatedAt:         new Date(),
      })
      .where(eq(orderAttempts.id, p.clientOrderId));
    // If this id was previously queued (e.g. first attempt was during an outage
    // and this call came via a successful retry path), clear it from the queue.
    _pendingFinalisations.delete(p.clientOrderId);
    _lastWriteMs = Date.now();
  } catch (err) {
    // The write threw even though _healthy was true — the DB dropped mid-call.
    // Enqueue for retry and mark storage degraded so trading is halted until
    // the connection recovers, preventing further unrecorded attempts.
    _pendingFinalisations.set(p.clientOrderId, { kind: "finalise", params: p });
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `finaliseOrderAttempt failed: ${_lastErrorMsg}`;
    logger.error(
      { err, clientOrderId: p.clientOrderId, outcome: p.outcome, pendingCount: _pendingFinalisations.size },
      "tradeStore: finaliseOrderAttempt failed — storage marked degraded, queued for retry on recovery",
    );
    _scheduleRetry();
  }
}

/**
 * Freeze Green Zone entry evidence after a confirmed fill. This is deliberately
 * non-critical research telemetry: it never reads settlement fields, never
 * retries an order, and a failure cannot affect order execution or storage
 * health. The reporting phase joins outcomes separately.
 */
export async function captureGreenZoneSnapshot(clientOrderId: string): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    const [attempt] = await _db.select().from(orderAttempts)
      .where(eq(orderAttempts.id, clientOrderId)).limit(1);
    if (!attempt || (attempt.fillCount ?? 0) <= 0) return;
    const asset = attempt.ticker.includes("BTC") ? "BTC" : attempt.ticker.includes("ETH") ? "ETH" : null;
    if (!asset) return;
    // Do not reconstruct a "final" preflight from a same-ticker historical
    // lookup: retries can make that association ambiguous. Until the execution
    // path carries an immutable preflight ID, preserve only values already bound
    // to this attempt and explicitly mark the unmatched fields unavailable.
    const unavailableReason = "final_preflight_not_bound_to_attempt";
    await _db.insert(greenZoneSnapshots).values({
      id: `green-zone:${clientOrderId}`,
      attemptId: clientOrderId,
      ticker: attempt.ticker,
      asset,
      side: attempt.side,
      submissionTimestampMs: Number(attempt.timestampMs),
      // The authorized submitted limit is entry-time evidence. Actual fill price
      // is intentionally retained only in the order/fill ledger for later P&L.
      executableEntryPriceCents: attempt.limitPriceCents ?? null,
      secondsLeft: null,
      quotedBboAskCents: null,
      executableL2AskCents: attempt.l2BestAskCents ?? null,
      signedL2ToBboCents: null,
      bboAgeMs: null,
      l2DepthDollars: attempt.l2DepthDollars ?? null,
      l2DepthContracts: attempt.l2DepthContracts ?? null,
      preflightTimestampMs: attempt.l2EndMs ?? null,
      unavailableReason,
    }).onConflictDoNothing();
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, clientOrderId }, "tradeStore: Green Zone snapshot skipped");
  }
}

// ── Public: state-machine transitions ─────────────────────────────────────────

/**
 * Transition outcome → "post_started" immediately before initiating the Kalshi POST.
 * Fire-and-forget safe. The row retains its budget reservation.
 */
export async function markAttemptPostStarted(clientOrderId: string): Promise<void> {
  if (!_db || !_healthy) {
    const err = new Error("tradeStore unavailable before Kalshi POST");
    logger.error({ clientOrderId }, "tradeStore: markAttemptPostStarted refused — DB unhealthy");
    throw err;
  }
  try {
    await _db.update(orderAttempts)
      .set({ outcome: "post_started", updatedAt: new Date() })
      .where(eq(orderAttempts.id, clientOrderId));
    _lastWriteMs = Date.now();
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `markAttemptPostStarted failed: ${_lastErrorMsg}`;
    _scheduleRetry();
    logger.error({ err, clientOrderId }, "tradeStore: markAttemptPostStarted failed — POST refused");
    throw err;
  }
}

function boundedSubmissionAudit(audit: SubmissionAudit): SubmissionAudit {
  const truncate = (value: string | null | undefined, max = 500) =>
    value == null ? null : value.slice(0, max);
  return {
    ...audit,
    reason: truncate(audit.reason, 160),
    finalQuoteError: truncate(audit.finalQuoteError, 300),
    providerMessage: truncate(audit.providerMessage, 500),
  };
}

function parseSubmissionAudit(value: string | null | undefined): SubmissionAudit | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as SubmissionAudit;
    return typeof parsed.stage === "string" && typeof parsed.recordedAtMs === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist a safe, structured terminal submission audit record. */
export async function recordSubmissionAudit(
  clientOrderId: string,
  audit: SubmissionAudit,
): Promise<void> {
  const safeAudit = boundedSubmissionAudit(audit);
  if (!_db || !_healthy) {
    logger.error({ clientOrderId, stage: safeAudit.stage }, "tradeStore: submission audit skipped — DB unhealthy");
    return;
  }
  try {
    await _db.update(orderAttempts)
      .set({ submissionAudit: JSON.stringify(safeAudit), updatedAt: new Date() })
      .where(eq(orderAttempts.id, clientOrderId));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, clientOrderId, stage: safeAudit.stage }, "tradeStore: recordSubmissionAudit failed");
  }
}

/**
 * Transition outcome → "post_unknown" when the Kalshi POST times out or throws a
 * network error. The row retains its budget reservation — we don't know if the
 * order was accepted. The dedup slot is NOT released; a new clientOrderId for the
 * same ticker/side is blocked until the outcome is confirmed (fail-safe).
 */
export async function markAttemptPostUnknown(clientOrderId: string): Promise<void> {
  if (!_db || !_healthy) {
    logger.error(
      { clientOrderId },
      "tradeStore: markAttemptPostUnknown skipped — DB unhealthy; outcome remains unresolved",
    );
    return;
  }
  try {
    await _db.update(orderAttempts)
      .set({ outcome: "post_unknown", updatedAt: new Date() })
      .where(eq(orderAttempts.id, clientOrderId));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, clientOrderId }, "tradeStore: markAttemptPostUnknown failed");
  }
}

/**
 * Transition outcome → "interrupted_shutdown" for each clientOrderId that was
 * in-flight when SIGTERM fired. Budget reservation is retained — post-restart
 * reconciliation is required to determine the true outcome.
 */
export async function markAttemptInterruptedShutdown(clientOrderId: string): Promise<void> {
  if (!_db || !_healthy) {
    logger.error(
      { clientOrderId },
      "tradeStore: markAttemptInterruptedShutdown skipped — DB unhealthy; row stays unresolved",
    );
    return;
  }
  try {
    await _db.update(orderAttempts)
      .set({ outcome: "interrupted_shutdown", updatedAt: new Date() })
      .where(eq(orderAttempts.id, clientOrderId));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, clientOrderId }, "tradeStore: markAttemptInterruptedShutdown failed");
  }
}

/**
 * Definitively reject an order: sets outcome to "post_rejected", decrements the
 * daily budget, and deletes the dedup slot so the position can be re-attempted.
 *
 * Only call this when Kalshi has returned a definitive rejection (HTTP 4xx with a
 * clear rejection code). For uncertain outcomes (timeout / network error), use
 * markAttemptPostUnknown() instead — do NOT release the reservation then.
 */
export async function releaseRejectedAttempt(params: {
  clientOrderId:  string;
  ticker:         string;
  side:           "yes" | "no";
  easternDate:    string;
  notionalCents:  number;
  submissionAudit?: SubmissionAudit;
}): Promise<void> {
  if (!_db || !_healthy) {
    // Queue the full release_rejected operation so the drain can run the
    // complete transaction (outcome + budget decrement + dedup delete) on
    // recovery — not just the outcome update.
    _pendingFinalisations.set(params.clientOrderId, { kind: "release_rejected", params });
    logger.error(
      { clientOrderId: params.clientOrderId, ticker: params.ticker, pendingCount: _pendingFinalisations.size },
      "tradeStore: releaseRejectedAttempt skipped — DB unhealthy; full release queued for recovery",
    );
    return;
  }
  try {
    await _db.transaction(async (tx) => {
      await tx.update(orderAttempts)
        .set({
          outcome: "post_rejected",
          submissionAudit: params.submissionAudit
            ? JSON.stringify(boundedSubmissionAudit(params.submissionAudit))
            : null,
          updatedAt: new Date(),
        })
        .where(eq(orderAttempts.id, params.clientOrderId));
      await tx.update(dailyBudgetTable)
        .set({
          spentCents: sql`GREATEST(0, ${dailyBudgetTable.spentCents} - ${params.notionalCents})`,
          updatedAt:  new Date(),
        })
        .where(eq(dailyBudgetTable.easternDate, params.easternDate));
      await tx.delete(orderDedup)
        .where(eq(orderDedup.tickerKey, `${params.ticker}-${params.side}`));
    });
    _pendingFinalisations.delete(params.clientOrderId);
    _lastWriteMs = Date.now();
  } catch (err) {
    // Transaction threw even though _healthy was true — DB dropped mid-call.
    // Queue for retry and mark storage degraded.
    _pendingFinalisations.set(params.clientOrderId, { kind: "release_rejected", params });
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `releaseRejectedAttempt failed: ${_lastErrorMsg}`;
    logger.error(
      { err, clientOrderId: params.clientOrderId, ticker: params.ticker, pendingCount: _pendingFinalisations.size },
      "tradeStore: releaseRejectedAttempt failed — storage marked degraded, queued for retry on recovery",
    );
    _scheduleRetry();
  }
}

// ── Public: order fills persistence ──────────────────────────────────────────

export interface OrderFillRow {
  /** Legacy response index retained for diagnostics only; never used as identity. */
  seqIndex:       number;

  fillId?:        string | null;

  orderId:        string;
  /** client_order_id from order_attempts (null when called from backfill without a match). */

  attemptId:      string | null;

  ticker:         string;

  side:           "yes" | "no";

  fillPriceCents: number;

  contracts:      number;
  /** Exact cost: exactPriceDollars × contracts — never rounded-cents-derived. */

  costDollars:    number;

  feeDollars:     number;

  exactPriceDollars?: string | null;

  exactCostDollars?: string | null;

  exactFeeDollars?: string | null;

  fillTimestamp:  string | null;
}

/**
 * Persist the authoritative Kalshi fill chunks and their aggregate totals together.
 *
 * The daily realized-profit guard reads order_attempts, so recording child fill
 * rows without updating the parent would leave P&L understated. This transaction
 * makes the parent totals and the audit rows advance as one unit.
 */
export async function persistVerifiedFillReconciliation(
  fills: OrderFillRow[],
  params: ReconciliationParams,
): Promise<void> {
  const orderId = fills[0]?.orderId;
  const attemptId = fills[0]?.attemptId;
  const ticker = fills[0]?.ticker;
  if (!orderId) throw new Error("Cannot persist fill reconciliation without an order ID");
  if (!attemptId || !ticker) throw new Error("Cannot persist fill reconciliation without a persisted attempt ID and ticker");
  if (fills.some((fill) => fill.orderId !== orderId || fill.attemptId !== attemptId || fill.ticker !== ticker)) {
    throw new Error("Cannot persist fill reconciliation with mixed ownership identities");
  }
  if (fills.some((fill) => !fill.fillId || !fill.exactPriceDollars || !fill.exactCostDollars || !fill.exactFeeDollars)) {
    throw new Error("Cannot persist forward fill reconciliation without exact Kalshi fill identity and economics");
  }
  if (!_db || !_healthy) throw new Error("storage unavailable for fill reconciliation");

  const rows = fills.map((f) => ({
    id:             `fill:${f.fillId}`,
    fillId:         f.fillId,
    orderId:        f.orderId,
    attemptId:      f.attemptId ?? null,
    ticker:         f.ticker,
    side:           f.side,
    fillPriceCents: f.fillPriceCents,
    contracts:      f.contracts,
    costDollars:    f.costDollars,
    feeDollars:     f.feeDollars,
    exactPriceDollars: f.exactPriceDollars,
    exactCostDollars:  f.exactCostDollars,
    exactFeeDollars:   f.exactFeeDollars,
    canonicalEconomics: true,
    fillTimestamp:  f.fillTimestamp ?? null,
  }));

  try {
    await _db.transaction(async (tx) => {
      // Bind every reconciliation mutation to precisely one persisted, real
      // parent. A caller-provided attempt ID, Kalshi order ID, and ticker must
      // all describe this same row before child fills or parent totals can move.
      const owned = await tx
        .select({ id: orderAttempts.id })
        .from(orderAttempts)
        .where(and(
          eq(orderAttempts.id, attemptId),
          eq(orderAttempts.orderId, orderId),
          eq(orderAttempts.ticker, ticker),
          realOrderPredicate(),
        ));
      if (owned.length !== 1) {
        throw new Error("Reconciliation ownership tuple is not a persisted real order");
      }
      if (rows.length > 0) {
        await tx.insert(orderFills).values(rows).onConflictDoNothing({ target: orderFills.fillId });
      }

      const updated = await tx
        .update(orderAttempts)
        .set({
          fillPriceCents:  params.fillPriceCents,
          contracts:       params.contracts,
          notionalDollars: params.notionalDollars,
          feeDollars:      params.feeDollars,
          fillPriceSource: "actual",
          reconciled:      true,
          reconcileFailed: false,
          updatedAt:       new Date(),
        })
          .where(and(
            eq(orderAttempts.id, attemptId),
            eq(orderAttempts.orderId, orderId),
            eq(orderAttempts.ticker, ticker),
            realOrderPredicate(),
          ))
        .returning({ id: orderAttempts.id });

      if (updated.length === 0) {
        throw new Error(`No order_attempts row found for reconciled order ${orderId}`);
      }
    });
    _lastWriteMs = Date.now();
  } catch (err) {
    recordDbBlockedOperation("reconciliation");
    logger.warn({ err, orderId }, "tradeStore: persistVerifiedFillReconciliation failed");
    throw err;
  }
}

/**
 * Mark a filled order's short reconciliation retry window as failed in SQL.
 *
 * Sets reconcile_failed=true on the order_attempts row identified by orderId.
 * The row remains in the recovery backlog. Its fee/fill evidence is not safe
 * to estimate, so getDailyRealizedPnl() stays unavailable until a later sweep
 * fetches and persists authoritative Kalshi fill chunks.
 *
 * Fire-and-forget safe — never throws into its caller.
 */
export async function persistReconcileFailedToDb(orderId: string): Promise<void> {
  if (!_db || !_healthy || !orderId) return;
  try {
    await _db
      .update(orderAttempts)
      .set({ reconcileFailed: true, updatedAt: new Date() })
      .where(eq(orderAttempts.orderId, orderId));
    _lastWriteMs = Date.now();
    logger.info({ orderId }, "tradeStore: persistReconcileFailedToDb — reconcile_failed=true persisted");
  } catch (err) {
    logger.warn({ err, orderId }, "tradeStore: persistReconcileFailedToDb failed — row may still block daily P&L");
  }
}

export interface ReconciliationFailureAuditInput {
  orderId: string;
  attemptId?: string;
  ticker?: string;
  reason: "empty_fills" | "request_error";
  httpStatus?: number;
  retryAttempt: number;
}

export interface ReconciliationFailureAudit extends ReconciliationFailureAuditInput {
  id: string;
  occurredAt: Date;
}

/**
 * Atomically preserve the compatibility flag and append safe failure evidence.
 * A deterministic key makes a re-run of the same terminal retry idempotent.
 */
export async function persistReconciliationFailureAudit(
  input: ReconciliationFailureAuditInput,
): Promise<void> {
  if (!_db || !_healthy) return;
  const attemptId = input.attemptId;
  const ticker = input.ticker;
  if (!input.orderId || !attemptId || !ticker
    || !Number.isInteger(input.retryAttempt) || input.retryAttempt < 1) {
    throw new Error("invalid reconciliation failure audit");
  }
  if (input.reason !== "empty_fills" && input.reason !== "request_error") {
    throw new Error("invalid reconciliation failure reason");
  }
  if (input.httpStatus != null && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) {
    throw new Error("invalid reconciliation failure HTTP status");
  }
  const id = `reconcile-failure:${input.orderId}:${input.retryAttempt}:${input.reason}`;
  try {
    await _db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: orderAttempts.id })
        .from(orderAttempts)
        .where(and(
          eq(orderAttempts.id, attemptId),
          eq(orderAttempts.orderId, input.orderId),
          eq(orderAttempts.ticker, ticker),
          realOrderPredicate(),
        ));
      if (owned.length !== 1) {
        throw new Error("Reconciliation failure ownership tuple is not a persisted real order");
      }
      await tx.execute(sql`
        INSERT INTO reconciliation_failure_audits
          (id, order_id, attempt_id, ticker, reason, http_status, retry_attempt)
        VALUES
          (${id}, ${input.orderId}, ${attemptId.slice(0, 200)},
           ${ticker.slice(0, 500)}, ${input.reason},
           ${input.httpStatus ?? null}, ${input.retryAttempt})
        ON CONFLICT (id) DO NOTHING
      `);
      await tx.update(orderAttempts)
        .set({ reconcileFailed: true, updatedAt: new Date() })
        .where(and(
          eq(orderAttempts.id, attemptId),
          eq(orderAttempts.orderId, input.orderId),
          eq(orderAttempts.ticker, ticker),
          realOrderPredicate(),
        ));
    });
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, orderId: input.orderId }, "tradeStore: persistReconciliationFailureAudit failed");
    throw err;
  }
}

export async function loadReconciliationFailureAudits(limit = 100): Promise<ReconciliationFailureAudit[]> {
  if (!_db || !_healthy) return [];
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  try {
    const rows = await _db.execute<{
      id: string; order_id: string; attempt_id: string | null; ticker: string | null;
      reason: "empty_fills" | "request_error"; http_status: number | null;
      retry_attempt: number; occurred_at: Date;
    }>(sql`
      SELECT r.id, r.order_id, r.attempt_id, r.ticker, r.reason, r.http_status,
             r.retry_attempt, r.occurred_at
      FROM reconciliation_failure_audits r
      JOIN order_attempts oa ON oa.order_id = r.order_id
      WHERE oa.is_synthetic = false
      ORDER BY r.occurred_at DESC
      LIMIT ${bounded}
    `);
    return rows.rows.map((row) => ({
      id: row.id, orderId: row.order_id, attemptId: row.attempt_id ?? undefined,
      ticker: row.ticker ?? undefined, reason: row.reason, httpStatus: row.http_status ?? undefined,
      retryAttempt: row.retry_attempt, occurredAt: row.occurred_at,
    }));
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadReconciliationFailureAudits failed");
    return [];
  }
}

/**
 * Record that the exchange-history discovery sweep has completed for
 * `easternDate`.  Idempotent: a second call for the same date is a no-op.
 * Fire-and-forget safe — never throws; storage failures are logged as warnings.
 */
/**
 * Writes the durable sweep watermark for `easternDate`.
 *
 * FAIL-CLOSED: throws on storage unavailability or DB failure.  The caller
 * must only set the in-memory sweep status to `complete: true` AFTER this
 * function resolves without throwing.
 */
export async function persistSweepCompletion(
  easternDate:     string,
  discoveredCount: number,
): Promise<void> {
  if (!_db || !_healthy) {
    throw new Error("tradeStore: persistSweepCompletion — storage unavailable; watermark not written");
  }
  await _db
    .insert(exchangeSweepLog)
    .values({ easternDate, completedAt: new Date(), discoveredCount })
    .onConflictDoNothing();
  _lastWriteMs = Date.now();
  logger.info({ easternDate, discoveredCount }, "tradeStore: persistSweepCompletion — sweep watermark stored");
}
/**
 * Returns the earliest Eastern date (YYYY-MM-DD) present in `order_attempts`,
 * or null when the table is empty or storage is unavailable.  Used by the
 * startup exchange-history discovery sweep to determine how far back to search
 * for locally missing fills without relying on a hard-coded lookback window.
 */
export async function loadEarliestAttemptDate(): Promise<string | null> {
  if (!_db || !_healthy) return null;
  try {
    const [row] = await _db
      .select({ earliest: sql<string | null>`MIN(eastern_date)` })
      .from(orderAttempts);
    return (typeof row?.earliest === "string" && row.earliest.length > 0)
      ? row.earliest
      : null;
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadEarliestAttemptDate failed");
    return null;
  }
}
/**
 * Returns the set of Kalshi order IDs already tracked by a durable local
 * ledger for the given Eastern date. Used by the exchange-history discovery
 * sweep to determine which exchange fills have no corresponding local record.
 */
export async function loadKalshiOrderIdsForDate(easternDate: string): Promise<Set<string>> {
  if (!_db || !_healthy) return new Set();
  try {
    const [legacyRows, ethRows] = await Promise.all([
      _db
        .select({ orderId: orderAttempts.orderId })
        .from(orderAttempts)
        .where(and(
          eq(orderAttempts.easternDate, easternDate),
          isNotNull(orderAttempts.orderId),
          realOrderPredicate(),
        )),
      _db.execute(sql`
        SELECT DISTINCT kalshi_order_id AS order_id
        FROM eth_martingale_orders
        WHERE eastern_date = ${easternDate}
          AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND kalshi_order_id IS NOT NULL
      `),
    ]);
    const ownedIds = new Set(
      legacyRows.map((row) => row.orderId).filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    for (const row of (ethRows as unknown as { rows: Array<Record<string, unknown>> }).rows) {
      const orderId = row["order_id"];
      if (typeof orderId === "string" && orderId.length > 0) ownedIds.add(orderId);
    }
    return ownedIds;
  } catch (err) {
    logger.warn({ err, easternDate }, "tradeStore: loadKalshiOrderIdsForDate failed");
    return new Set();
  }
}
/**
 * Bulk-insert individual fill rows for one Kalshi order.
 * Uses onConflictDoNothing so this is safe to call multiple times for the same
 * orderId (e.g. retry reconciliation runs, backfill script).
 * Fire-and-forget safe — never blocks trading.
 */
export async function persistOrderFills(fills: OrderFillRow[]): Promise<void> {
  if (!_db || !_healthy || fills.length === 0) return;
  if (fills.some((fill) => !fill.fillId || !fill.exactPriceDollars || !fill.exactCostDollars || !fill.exactFeeDollars)) {
    logger.warn({ orderId: fills[0]?.orderId }, "tradeStore: refusing legacy fill write without exact Kalshi identity");
    return;
  }
  try {
    const rows = fills.map((f) => ({
      id:             `fill:${f.fillId}`,
      fillId:         f.fillId,
      orderId:        f.orderId,
      attemptId:      f.attemptId ?? null,
      ticker:         f.ticker,
      side:           f.side,
      fillPriceCents: f.fillPriceCents,
      contracts:      f.contracts,
      costDollars:    f.costDollars,
      feeDollars:     f.feeDollars,
      exactPriceDollars: f.exactPriceDollars,
      exactCostDollars:  f.exactCostDollars,
      exactFeeDollars:   f.exactFeeDollars,
      canonicalEconomics: true,
      fillTimestamp:  f.fillTimestamp ?? null,
    }));
    await _db.insert(orderFills).values(rows).onConflictDoNothing();
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, orderId: fills[0]?.orderId }, "tradeStore: persistOrderFills failed");
  }
}

/**
 * Update fill_price_source on an order_attempts row.
 * Called by fillReconciler after confirmed fill data is written to order_fills.
 * Fire-and-forget; never blocks trading.
 */
export async function updateFillPriceSourceInSql(
  clientOrderId: string,
  source: "actual" | "limit_fallback",
): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db
      .update(orderAttempts)
      .set({ fillPriceSource: source, updatedAt: new Date() })
      .where(eq(orderAttempts.id, clientOrderId));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, clientOrderId }, "tradeStore: updateFillPriceSourceInSql failed");
  }
}

/**
 * Load all order_fills rows for a given Kalshi order_id.
 * Returns an empty array when storage is unavailable or the query fails.
 */
export async function loadOrderFillsByOrderId(orderId: string): Promise<OrderFillRow[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(orderFills)
      .where(eq(orderFills.orderId, orderId))
      .orderBy(orderFills.id);
    return rows.map((r, i) => ({
      seqIndex:       i,
      fillId:         r.fillId ?? `${r.orderId}:${i}`,
      orderId:        r.orderId,
      attemptId:      r.attemptId ?? null,
      ticker:         r.ticker,
      side:           r.side as "yes" | "no",
      fillPriceCents: r.fillPriceCents,
      contracts:      r.contracts,
      costDollars:    r.costDollars,
      feeDollars:     r.feeDollars,
      exactPriceDollars: r.exactPriceDollars ?? String(r.fillPriceCents / 100),
      exactCostDollars: r.exactCostDollars ?? String(r.costDollars),
      exactFeeDollars: r.exactFeeDollars ?? String(r.feeDollars),
      fillTimestamp:  r.fillTimestamp ?? null,
    }));
  } catch (err) {
    logger.warn({ err, orderId }, "tradeStore: loadOrderFillsByOrderId failed");
    return [];
  }
}

// ── Public: budget adjustment ─────────────────────────────────────────────────

/**
 * Decrement the daily budget in SQL by `cents`. Called when notional is
 * released (zero-fill, partial-fill, price improvement).
 * Fire-and-forget; never throws.
 */
export async function releaseBudgetInSql(easternDate: string, cents: number): Promise<void> {
  if (!_db || !_healthy || cents <= 0) return;
  try {
    await _db
      .update(dailyBudgetTable)
      .set({
        spentCents: sql`GREATEST(0, ${dailyBudgetTable.spentCents} - ${cents})`,
        updatedAt:  new Date(),
      })
      .where(eq(dailyBudgetTable.easternDate, easternDate));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err }, "tradeStore: releaseBudgetInSql failed");
  }
}

/**
 * Read the spent-cents value for a specific Eastern date from SQL.
 * Returns 0 when the date has no row (e.g. a day with no trading).
 * Never throws.
 */
export async function getBudgetForDate(easternDate: string): Promise<number> {
  if (!_db || !_healthy) return 0;
  try {
    const rows = await _db
      .select({ spentCents: dailyBudgetTable.spentCents })
      .from(dailyBudgetTable)
      .where(eq(dailyBudgetTable.easternDate, easternDate))
      .limit(1);
    return rows[0]?.spentCents ?? 0;
  } catch (err) {
    logger.warn({ err, easternDate }, "tradeStore: getBudgetForDate failed");
    return 0;
  }
}
/** Upsert the full budget value (called by the debounced persist path). */
export async function persistBudgetToSql(easternDate: string, spentCents: number): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db
      .insert(dailyBudgetTable)
      .values({ easternDate, spentCents, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: dailyBudgetTable.easternDate,
        set:    { spentCents, updatedAt: new Date() },
      });
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err }, "tradeStore: persistBudgetToSql failed");
  }
}

// ── Public: dedup slot management ────────────────────────────────────────────

/** Delete a dedup slot (called on zero-fill / partial-fill release). */
export async function releaseDedupSlotInSql(ticker: string, side: string): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db
      .delete(orderDedup)
      .where(eq(orderDedup.tickerKey, `${ticker}-${side}`));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, ticker, side }, "tradeStore: releaseDedupSlotInSql failed");
  }
}

/**
 * Write the `won` boolean to an order_attempts row once the market settles.
 * Fire-and-forget; never blocks trading or reconciliation.
 */
export function recordOrderWonInSql(clientOrderId: string, won: boolean): void {
  if (!_db || !_healthy) return;
  _db
    .update(orderAttempts)
    .set({ won, updatedAt: new Date() })
    .where(eq(orderAttempts.clientOrderId, clientOrderId))
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err: unknown) =>
      logger.warn({ err, clientOrderId }, "tradeStore: recordOrderWonInSql failed"),
    );
}

/**
 * Startup settlement recovery: for every filled, reconciled order whose `won`
 * column is still NULL, check the durable market_results table and write `won`
 * when the result is already known.
 *
 * This covers the common restart-after-settlement gap: the market resolved while
 * the server was offline, so outcomeReconciler never fired, but the exchange
 * result was already persisted by a prior upsertMarketResultInSql call.
 *
 * Idempotent: a second call finds `won IS NOT NULL` on every patched row and
 * skips them. Safe to call from index.ts after reconcileUnreconciledFilledOrders.
 * Never throws; always fire-and-forget from the caller's perspective.
 */
export async function reconcileSettlementForReconciledOrders(): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    // Load reconciled filled orders that are still missing their settlement outcome.
    // Forward-only guard: only patch orders that have at least one child fill
    // row with canonical_economics = true. This prevents legacy rows (reconciled
    // before the exact forward ledger was deployed) from being mutated here.
    const rows = await _db
      .select({
        id:            orderAttempts.id,
        clientOrderId: orderAttempts.clientOrderId,
        ticker:        orderAttempts.ticker,
        side:          orderAttempts.side,
      })
      .from(orderAttempts)
      .where(
        and(
          eq(orderAttempts.reconciled, true),
          isNull(orderAttempts.won),
          realOrderPredicate(),
          inArray(orderAttempts.outcome, ["full_fill", "partial_fill", "filled", "partially_filled"]),
          sql`EXISTS (
            SELECT 1 FROM order_fills f
            WHERE f.order_id = order_attempts.order_id
              AND f.canonical_economics IS TRUE
          )`,
        ),
      );

    if (rows.length === 0) {
      logger.debug("tradeStore: reconcileSettlementForReconciledOrders — no unsettled reconciled orders");
      return;
    }

    // Bulk-load market results for the distinct tickers we need.
    const tickers = [...new Set(rows.map((r) => r.ticker))];
    const results = await _db
      .select({ ticker: marketResults.ticker, result: marketResults.result })
      .from(marketResults)
      .where(inArray(marketResults.ticker, tickers));

    const resultMap = new Map(results.map((r) => [r.ticker, r.result]));

    let patched = 0;
    for (const row of rows) {
      const result = resultMap.get(row.ticker);
      if (result !== "yes" && result !== "no") continue; // not yet settled or unresolvable
      const side = row.side as "yes" | "no";
      const won  = side === result;
      const coid = row.clientOrderId ?? row.id;
      try {
        await _db
          .update(orderAttempts)
          .set({ won, updatedAt: new Date() })
          .where(eq(orderAttempts.clientOrderId, coid));
        _lastWriteMs = Date.now();
        patched++;
      } catch (err) {
        logger.warn({ err, ticker: row.ticker, clientOrderId: coid }, "tradeStore: reconcileSettlementForReconciledOrders — row patch failed");
      }
    }

    if (patched > 0) {
      logger.info(
        { patched, total: rows.length },
        "tradeStore: reconcileSettlementForReconciledOrders — settlement patched from market_results",
      );
    } else {
      logger.debug({ checked: rows.length }, "tradeStore: reconcileSettlementForReconciledOrders — no market results available yet for unsettled orders");
    }
  } catch (err) {
    logger.warn({ err }, "tradeStore: reconcileSettlementForReconciledOrders failed — will retry on next startup");
  }
}
/**
 * Persist a live forward-ledger settlement. Historical rows are deliberately
 * excluded: startup recovery may only settle parents with canonical fill rows.
 */
export function recordForwardOrderSettlementInSql(
  clientOrderId: string,
  result: "yes" | "no",
  settledAtMs: number,
): void {
  if (!_db || !_healthy) return;
  _db
    .update(orderAttempts)
    .set({
      won: sql`${orderAttempts.side} = ${result}`,
      settlementResult: result,
      settledAtMs,
      updatedAt: new Date(),
    })
    .where(and(
      eq(orderAttempts.clientOrderId, clientOrderId),
      sql`EXISTS (
        SELECT 1 FROM order_fills f
        WHERE f.order_id = ${orderAttempts.orderId}
          AND f.canonical_economics IS TRUE
      )`,
    ))
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err: unknown) =>
      logger.warn({ err, clientOrderId }, "tradeStore: recordForwardOrderSettlementInSql failed"),
    );
}

/**
 * Restart-safe settlement recovery for rows written by the forward exact ledger.
 * It joins only the bot's durable parents to already-recorded market results; it
 * never queries/imports unmatched exchange orders and never mutates legacy fills.
 */
export async function recoverForwardSettlementsFromSql(): Promise<number> {
  if (!_db || !_healthy) return 0;
  try {
    const result = await _db.execute(sql`
      UPDATE order_attempts AS attempt
      SET won = (attempt.side = market.result),
          settlement_result = market.result,
          settled_at_ms = market.resolved_at_ms,
          updated_at = now()
      FROM market_results AS market
      WHERE attempt.ticker = market.ticker
        AND attempt.won IS NULL
        AND attempt.reconciled IS TRUE
        AND attempt.outcome IN ('full_fill', 'partial_fill', 'filled', 'partially_filled')
        AND EXISTS (
          SELECT 1 FROM order_fills AS fill
          WHERE fill.order_id = attempt.order_id
            AND fill.canonical_economics IS TRUE
        )
      RETURNING attempt.id
    `);
    const recovered = result.rows?.length ?? 0;
    if (recovered > 0) {
      _lastWriteMs = Date.now();
      logger.info({ recovered }, "tradeStore: forward settlement recovery completed");
    }
    return recovered;
  } catch (err) {
    logger.warn({ err }, "tradeStore: forward settlement recovery failed");
    return 0;
  }
}
/** Upsert a resolved market result. Fire-and-forget. */
export function upsertMarketResultInSql(ticker: string, result: string): void {
  if (!_db || !_healthy) return;
  _db
    .insert(marketResults)
    .values({ ticker, result, resolvedAtMs: Date.now(), createdAt: new Date() })
    .onConflictDoUpdate({
      target: marketResults.ticker,
      set:    { result, resolvedAtMs: Date.now() },
    })
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err: unknown) => logger.warn({ err, ticker }, "tradeStore: upsertMarketResultInSql failed"));
}

/**
 * Awaited, fail-closed variant of `upsertMarketResultInSql`.  Throws on
 * storage unavailability or DB error so the discovery sweep can treat a
 * failed settlement write as "not durably persisted" and leave the date
 * unwatermarked.
 */
export async function persistMarketResultAwaited(ticker: string, result: string): Promise<void> {
  if (!_db || !_healthy) {
    throw new Error("tradeStore: persistMarketResultAwaited — storage unavailable");
  }
  await _db
    .insert(marketResults)
    .values({ ticker, result, resolvedAtMs: Date.now(), createdAt: new Date() })
    .onConflictDoUpdate({
      target: marketResults.ticker,
      set:    { result, resolvedAtMs: Date.now() },
    });
  _lastWriteMs = Date.now();
}
/** Insert one passive observation. Fire-and-forget; never blocks trading. */
export function insertPassiveObsInSql(obs: PassiveObservation): void {
  if (!_db || !_healthy) return;
  const id = `${obs.ticker}@${obs.timestampMs}`;
  _db
    .insert(passiveObservations)
    .values({
      id,
      timestampMs:            obs.timestampMs,
      isoTimestamp:           obs.isoTimestamp,
      ticker:                 obs.ticker,
      series:                 obs.series,
      asset:                  obs.asset,
      windowCloseTime:        obs.windowCloseTime,
      windowId:               obs.windowId,
      secondsLeft:            obs.secondsLeft,
      yesBid:                 obs.yesBid,
      yesAsk:                 obs.yesAsk,
      noBid:                  obs.noBid,
      noAsk:                  obs.noAsk,
      source:                 obs.source,
      wsConnected:            obs.wsConnected,
      wsStale:                obs.wsStale,
      yesQualifies:           obs.yesQualifies,
      noQualifies:            obs.noQualifies,
      hypotheticalSide:       obs.hypotheticalSide,
      hypotheticalEntryPrice: obs.hypotheticalEntryPrice,
      hypotheticalTier:       obs.hypotheticalTier,
      hypotheticalContracts:  obs.hypotheticalContracts,
      easternDate:            easternDay(new Date(obs.timestampMs)),
    })
    .onConflictDoNothing()
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err: unknown) => logger.warn({ err, ticker: obs.ticker }, "tradeStore: insertPassiveObsInSql failed"));
}

/** Insert one malformed observation record. Fire-and-forget. */
export function insertMalformedObsInSql(rec: {
  timestampMs: number;
  ticker:      string;
  secondsLeft: number;
  raw:         unknown;
}): void {
  if (!_db || !_healthy) return;
  const id = `${rec.ticker}@${rec.timestampMs}`;
  _db
    .insert(malformedObservations)
    .values({
      id,
      timestampMs: rec.timestampMs,
      ticker:      rec.ticker,
      secondsLeft: rec.secondsLeft,
      rawJson:     JSON.stringify(rec.raw),
      easternDate: easternDay(new Date(rec.timestampMs)),
    })
    .onConflictDoNothing()
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err: unknown) => logger.warn({ err, ticker: rec.ticker }, "tradeStore: insertMalformedObsInSql failed"));
}

// ── Public: recoverability study (passive worker only) ────────────────────────
// These helpers intentionally use direct SQL rather than the trading tables.
// They are called only by recoverabilityCapture's background worker, never by
// evaluate(), preflight, or order submission.
function _recoverabilityWrite(write: () => Promise<unknown>): void {
  if (!_db || !_healthy) return;
  write().then(() => { _lastWriteMs = Date.now(); }).catch((err: unknown) =>
    logger.warn({ err }, "tradeStore: recoverability passive write failed"));
}
export function insertRecoverabilitySpotTickInSql(t: Record<string, unknown>): void {
  _recoverabilityWrite(() => _db!.insert(recoverabilitySpotTicks).values({
    id: String(t.id), timestampMs: Number(t.timestampMs), asset: String(t.asset), provider: String(t.provider),
    rawSymbol: String(t.rawSymbol), bid: t.bid as number | null, ask: t.ask as number | null,
    midpoint: t.midpoint as number | null, receiptMs: Number(t.receiptMs), isProxy: Boolean(t.isProxy),
    methodology: String(t.methodology), easternDate: easternDay(new Date(Number(t.timestampMs))),
  }).onConflictDoNothing());
}
export function insertRecoverabilityObservationInSql(o: Record<string, unknown>): void {
  const spot = o.spot as Record<string, unknown> | null;
  _recoverabilityWrite(() => _db!.insert(recoverabilityObservations).values({
    id: String(o.id), timestampMs: Number(o.timestampMs), ticker: String(o.ticker), series: String(o.series),
    asset: String(o.asset), windowId: String(o.windowId), observationNumberInWindow: Number(o.observationNumberInWindow),
    secondsLeft: o.secondsLeft as number | null, yesBid: o.yesBid as number | null, yesAsk: o.yesAsk as number | null,
    noBid: o.noBid as number | null, noAsk: o.noAsk as number | null, selectedSide: o.selectedSide as string | null,
    selectedPriceCents: o.selectedPriceCents as number | null, selectedImplied: o.selectedImplied as number | null,
    floorStrike: o.floorStrike as number | null, rulesPrimary: o.rulesPrimary as string | null,
    rulesSecondary: o.rulesSecondary as string | null, rulesHash: String(o.rulesHash),
    comparisonOperator: o.comparisonOperator as string | null, settlementSource: o.settlementSource as string | null,
    spotMidpoint: spot?.midpoint as number | null, spotAgeMs: o.spotAgeMs as number | null,
    spotProvider: spot?.provider as string | null, spotRawSymbol: spot?.rawSymbol as string | null,
    spotIsProxy: spot?.isProxy as boolean | null, qualityFlags: JSON.stringify(o.qualityFlags ?? []),
    easternDate: easternDay(new Date(Number(o.timestampMs))),
  }).onConflictDoNothing());
}
export function insertRecoverabilityOutcomeInSql(o: Record<string, unknown>): void {
  _recoverabilityWrite(() => _db!.insert(recoverabilityMarketOutcomes).values({
    ticker: String(o.ticker), result: String(o.result), finalizedAtMs: Number(o.finalizedAtMs),
    reportedSettlementValue: o.reportedSettlementValue as number | null, rawJson: JSON.stringify(o),
    easternDate: easternDay(new Date(Number(o.finalizedAtMs))),
  }).onConflictDoNothing());
}
export function insertRecoverabilityLabelInSql(l: Record<string, unknown>): void {
  _recoverabilityWrite(() => _db!.insert(recoverabilityLabels).values({
    id: String(l.id), observationId: String(l.observationId), ticker: String(l.ticker),
    generatedAtMs: Number(l.generatedAtMs), labelVersion: String(l.labelVersion),
    proxyTouchedOrCrossedStrikeAfter: l.proxyTouchedOrCrossedStrikeAfter as boolean | null,
    proxyFinishedOppositeSideAtClose: l.proxyFinishedOppositeSideAtClose as boolean | null,
    estimated60SecondProxyAverage: l.estimated60SecondProxyAverage as number | null,
    officialSettlementResult: String(l.officialSettlementResult),
    easternDate: easternDay(new Date(Number(l.generatedAtMs))),
  }).onConflictDoNothing());
}

/** Passive stale-gap research write. This is never used by the order path. */
export async function insertStaleGapCounterfactualCaptureInSql(record: {
  captureId: string;
  timestampMs: number;
  ticker: string;
  series: string;
  side: "yes" | "no";
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!_db || !_healthy) throw new Error("SQL storage unavailable");
  await _db.insert(staleGapCounterfactualCaptures).values({
    captureId: record.captureId,
    timestampMs: record.timestampMs,
    easternDate: easternDay(new Date(record.timestampMs)),
    ticker: record.ticker,
    series: record.series,
    side: record.side,
    payload: record.payload,
  }).onConflictDoNothing();
  _lastWriteMs = Date.now();
}

/** Phase 4B raw passive write. It is called only by the isolated observer queue. */
export async function insertPhase4BDecisionCaptureInSql(record: {
  market: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  books?: readonly Record<string, unknown>[];
  reference?: Record<string, unknown>;
  prospective?: readonly Record<string, unknown>[];
  registry?: readonly Record<string, unknown>[];
}): Promise<void> {
  if (!_db || !_healthy) throw new Error("SQL storage unavailable");
  await _db!.insert(phase4bMarketIntervals).values({
    marketId: String(record.market.marketId), ticker: String(record.market.ticker), series: String(record.market.series),
    asset: String(record.market.asset), intervalStartMs: record.market.intervalStartMs as number | null,
    intervalEndMs: record.market.intervalEndMs as number | null, windowCloseMs: Number(record.market.windowCloseMs),
    metadataCapturedAtMs: Number(record.market.metadataCapturedAtMs), schemaVersion: String(record.market.schemaVersion),
    metadataVersion: String(record.market.metadataVersion),
  }).onConflictDoNothing();
  await _db!.insert(phase4bDecisionSnapshots).values({
    snapshotId: String(record.snapshot.snapshotId), marketId: String(record.snapshot.marketId),
    capturedAtMs: Number(record.snapshot.capturedAtMs), secondsLeft: Number(record.snapshot.secondsLeft),
    candidateSide: String(record.snapshot.candidateSide), source: String(record.snapshot.source),
    payload: record.snapshot, schemaVersion: String(record.snapshot.schemaVersion),
  }).onConflictDoNothing();
  for (const book of record.books ?? []) {
    await _db!.insert(phase4bBookSnapshots).values({
      id: `${String(book.snapshotId)}:${String(book.side)}`, snapshotId: String(book.snapshotId),
      marketId: String(record.market.marketId), capturedAtMs: Number(record.snapshot.capturedAtMs),
      side: String(book.side), payload: book, schemaVersion: String(book.schemaVersion),
    }).onConflictDoNothing();
  }
  if (record.reference) {
    await _db!.insert(phase4bReferenceObservations).values({
      id: `${String(record.reference.snapshotId)}:${String(record.reference.source)}`,
      snapshotId: String(record.reference.snapshotId), marketId: String(record.market.marketId),
      capturedAtMs: Number(record.reference.capturedAtMs), asset: String(record.reference.asset),
      source: String(record.reference.source), payload: record.reference,
      schemaVersion: String(record.reference.schemaVersion),
    }).onConflictDoNothing();
  }
  for (const prospective of record.prospective ?? []) {
    await _db!.insert(phase4bProspectiveSimulations).values({
      id: String(prospective.id), snapshotId: String(prospective.snapshotId),
      hypothesisVersion: String(prospective.hypothesisVersion),
      qualification: String(prospective.qualification), ticker: String(prospective.ticker),
      capturedAtMs: Number(prospective.capturedAtMs), payload: prospective,
      schemaVersion: String(prospective.schemaVersion),
    }).onConflictDoNothing();
  }
  for (const capture of record.registry ?? []) {
    const experimentVersion = String(capture.experimentVersion);
    const definition = (await import("./phase4b/passiveExperimentRegistry.js")).PASSIVE_EXPERIMENTS
      .find((item) => item.experimentVersion === experimentVersion);
    if (!definition) continue;
    await _db!.transaction(async (tx) => {
      // Serialize capture/outcome label fan-out for this market. Without this,
      // concurrent replay and reconciliation transactions could each miss the
      // other's uncommitted row and leave a capture permanently unlabeled.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${String(capture.marketId)}))`);
      await tx.insert(passiveExperimentRegistry).values({
        experimentVersion, program: definition.program, name: definition.name, config: definition.config,
        schemaVersion: "passive-experiment-registry-v1",
      }).onConflictDoNothing();
      await tx.insert(passiveExperimentCaptures).values({
        captureId: String(capture.captureId), experimentVersion, snapshotId: String(capture.snapshotId),
        marketId: String(capture.marketId), ticker: String(capture.ticker), asset: String(capture.asset),
        capturedAtMs: Number(capture.capturedAtMs), qualification: String(capture.qualification),
        payload: capture, schemaVersion: String(capture.schemaVersion),
      }).onConflictDoNothing();
      // Captures can replay after their outcome was persisted during an outage.
      // Attach that existing label here so write order cannot leave a permanent
      // unlabeled research cohort.
      const [outcome] = await tx.select().from(phase4bMarketOutcomes)
        .where(eq(phase4bMarketOutcomes.marketId, String(capture.marketId))).limit(1);
      if (outcome) {
        await tx.insert(passiveExperimentSettlements).values({
          experimentVersion, marketId: String(capture.marketId), result: outcome.result,
          settlementTimestampMs: outcome.settlementTimestampMs, reconciledAtMs: outcome.reconciledAtMs,
          settlementStatus: outcome.settlementStatus, schemaVersion: outcome.schemaVersion,
        }).onConflictDoNothing();
      }
    });
  }
  _lastWriteMs = Date.now();
}

/** Phase 4B read-only prospective-record query for research reports. */
export async function listPhase4BProspectiveRecordsByHypothesisInSql(
  hypothesisVersion: string,
  limit = 2_000,
): Promise<Record<string, unknown>[]> {
  if (!_db || !_healthy) throw new Error("SQL storage unavailable");
  const rows = await _db.select({ payload: phase4bProspectiveSimulations.payload })
    .from(phase4bProspectiveSimulations)
    .where(eq(phase4bProspectiveSimulations.hypothesisVersion, hypothesisVersion))
    .orderBy(desc(phase4bProspectiveSimulations.capturedAtMs))
    .limit(limit);
  return rows.map((row) => row.payload as Record<string, unknown>);
}

/** Read-only registry evidence joined only to its authoritative settlement and
 * original decision snapshot. The snapshot contributes the frozen candidate
 * side only; this query never fetches market, book, or live-trading state. */
export async function listPassiveExperimentSettledCapturesInSql(
  limit = 10_000,
): Promise<Array<{
  experimentVersion: string; captureId: string; marketId: string; ticker: string; asset: string;
  capturedAtMs: number; qualification: string; payload: Record<string, unknown>;
  result: "yes" | "no" | null; settlementStatus: string | null;
}>> {
  if (!_db || !_healthy) throw new Error("SQL storage unavailable");
  const rows = await _db.select({
    experimentVersion: passiveExperimentCaptures.experimentVersion,
    captureId: passiveExperimentCaptures.captureId, marketId: passiveExperimentCaptures.marketId,
    ticker: passiveExperimentCaptures.ticker, asset: passiveExperimentCaptures.asset,
    capturedAtMs: passiveExperimentCaptures.capturedAtMs, qualification: passiveExperimentCaptures.qualification,
    payload: passiveExperimentCaptures.payload, result: passiveExperimentSettlements.result,
    settlementStatus: passiveExperimentSettlements.settlementStatus,
    candidateSide: phase4bDecisionSnapshots.candidateSide,
  }).from(passiveExperimentCaptures)
    .innerJoin(
      passiveExperimentSettlements,
      and(
        eq(passiveExperimentCaptures.experimentVersion, passiveExperimentSettlements.experimentVersion),
        eq(passiveExperimentCaptures.marketId, passiveExperimentSettlements.marketId),
      ),
    )
    .innerJoin(phase4bDecisionSnapshots, eq(passiveExperimentCaptures.snapshotId, phase4bDecisionSnapshots.snapshotId))
    .where(inArray(passiveExperimentSettlements.result, ["yes", "no"]))
    .orderBy(desc(passiveExperimentCaptures.capturedAtMs)).limit(Math.min(Math.max(1, limit), 10_000));
  return rows.map((row) => ({
    ...row, result: row.result as "yes" | "no" | null, settlementStatus: row.settlementStatus,
    payload: { ...(row.payload as Record<string, unknown>), candidateSide: row.candidateSide },
  }));
}

/** Aggregate availability only; no market fetches and no execution-state joins. */
export async function listPassiveExperimentStatusRowsInSql(): Promise<Array<{
  experimentVersion: string; capturedCount: number; eligibleCount: number; unavailableCount: number; settledCount: number;
  firstCapturedAtMs: number | null; lastCapturedAtMs: number | null; staleReferenceCount: number; referenceErrorCount: number;
}>> {
  if (!_db || !_healthy) throw new Error("SQL storage unavailable");
  const result = await _db.execute(sql`
    SELECT c.experiment_version AS "experimentVersion", COUNT(*)::int AS "capturedCount",
      COUNT(*) FILTER (WHERE c.qualification = 'eligible')::int AS "eligibleCount",
      COUNT(*) FILTER (WHERE c.qualification = 'unavailable')::int AS "unavailableCount",
      COUNT(*) FILTER (WHERE s.result IN ('yes','no'))::int AS "settledCount",
      MIN(c.captured_at_ms)::bigint AS "firstCapturedAtMs", MAX(c.captured_at_ms)::bigint AS "lastCapturedAtMs",
      COUNT(*) FILTER (WHERE c.payload->>'referenceStale' = 'true')::int AS "staleReferenceCount",
      COUNT(*) FILTER (WHERE COALESCE(c.payload->>'referenceError', '') <> '')::int AS "referenceErrorCount"
    FROM passive_experiment_captures c
    LEFT JOIN passive_experiment_settlements s ON s.experiment_version = c.experiment_version AND s.market_id = c.market_id
    GROUP BY c.experiment_version
  `);
  return result.rows.map((row) => ({
    experimentVersion: String(row["experimentVersion"]), capturedCount: Number(row["capturedCount"]), eligibleCount: Number(row["eligibleCount"]),
    unavailableCount: Number(row["unavailableCount"]), settledCount: Number(row["settledCount"]),
    firstCapturedAtMs: row["firstCapturedAtMs"] == null ? null : Number(row["firstCapturedAtMs"]),
    lastCapturedAtMs: row["lastCapturedAtMs"] == null ? null : Number(row["lastCapturedAtMs"]),
    staleReferenceCount: Number(row["staleReferenceCount"]), referenceErrorCount: Number(row["referenceErrorCount"]),
  }));
}

/**
 * Phase 4B backfill: returns all BTC decision snapshots that have a persisted
 * reference observation but no entry-gap-90-95-v1 prospective record. Each row
 * carries both payloads so the caller can reconstruct causal gap values from
 * fields that were computed at capture time. Read-only — never writes.
 */
export async function listPhase4BHistoricalSnapshotsForBackfillInSql(
  limit = 500,
): Promise<Array<{ referencePayload: Record<string, unknown>; snapshotPayload: Record<string, unknown> }>> {
  if (!_db || !_healthy) throw new Error("SQL storage unavailable");
  const rows = await _db
    .select({
      referencePayload: phase4bReferenceObservations.payload,
      snapshotPayload: phase4bDecisionSnapshots.payload,
    })
    .from(phase4bReferenceObservations)
    .innerJoin(
      phase4bDecisionSnapshots,
      eq(phase4bReferenceObservations.snapshotId, phase4bDecisionSnapshots.snapshotId),
    )
    .where(
      and(
        eq(phase4bReferenceObservations.asset, "BTC"),
        sql`NOT EXISTS (
          SELECT 1 FROM phase4b_prospective_simulations
          WHERE snapshot_id = ${phase4bReferenceObservations.snapshotId}
          AND hypothesis_version = 'entry-gap-90-95-v1'
        )`,
      ),
    )
    .orderBy(asc(phase4bReferenceObservations.capturedAtMs))
    .limit(limit);
  return rows.map((row) => ({
    referencePayload: row.referencePayload as Record<string, unknown>,
    snapshotPayload: row.snapshotPayload as Record<string, unknown>,
  }));
}

/** Phase 4B settlement record. This passive fact never touches an order or fill. */
export function upsertPhase4BMarketOutcomeInSql(record: {
  marketId: string; result: "yes" | "no" | null; settlementTimestampMs: number | null;
  reconciledAtMs: number; settlementStatus: string; schemaVersion: string;
}): void {
  _recoverabilityWrite(() => _db!.transaction(async (tx) => {
    // Uses the same transaction-scoped market lock as late/replayed captures.
    // This makes outcome-label convergence independent of arrival order.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.marketId}))`);
    await tx.insert(phase4bMarketOutcomes).values(record).onConflictDoUpdate({
      target: phase4bMarketOutcomes.marketId,
      set: record.result == null ? {
        reconciledAtMs: phase4bMarketOutcomes.reconciledAtMs,
        settlementStatus: phase4bMarketOutcomes.settlementStatus,
        schemaVersion: phase4bMarketOutcomes.schemaVersion,
      } : {
        result: sql`COALESCE(${phase4bMarketOutcomes.result}, ${record.result})`,
        settlementTimestampMs: sql`COALESCE(${phase4bMarketOutcomes.settlementTimestampMs}, ${record.settlementTimestampMs})`,
        reconciledAtMs: record.reconciledAtMs, settlementStatus: record.settlementStatus, schemaVersion: record.schemaVersion,
      },
    });
    // Label only experiment versions that actually captured this market. The
    // transaction makes the raw outcome and its passive labels all-or-nothing.
    const captures = await tx.select({ experimentVersion: passiveExperimentCaptures.experimentVersion })
      .from(passiveExperimentCaptures)
      .where(eq(passiveExperimentCaptures.marketId, record.marketId));
    for (const { experimentVersion } of new Map(captures.map((row) => [row.experimentVersion, row])).values()) {
      await tx.insert(passiveExperimentSettlements).values({
        experimentVersion, marketId: record.marketId, result: record.result,
        settlementTimestampMs: record.settlementTimestampMs, reconciledAtMs: record.reconciledAtMs,
        settlementStatus: record.settlementStatus, schemaVersion: record.schemaVersion,
      }).onConflictDoUpdate({
        target: [passiveExperimentSettlements.experimentVersion, passiveExperimentSettlements.marketId],
        set: record.result == null ? { reconciledAtMs: passiveExperimentSettlements.reconciledAtMs } : {
          result: sql`COALESCE(${passiveExperimentSettlements.result}, ${record.result})`,
          settlementTimestampMs: sql`COALESCE(${passiveExperimentSettlements.settlementTimestampMs}, ${record.settlementTimestampMs})`,
          reconciledAtMs: record.reconciledAtMs, settlementStatus: record.settlementStatus, schemaVersion: record.schemaVersion,
        },
      });
    }
  }));
}

/** Compact shadow-collector writes reuse the isolated Phase 4B research tables.
 * They are intentionally not part of the durable trading-write buffer. */
export async function insertCompactShadowSnapshotInSql(record: {
  asset: "BTC" | "ETH" | "SOL";
  ticker: string;
  windowOpenMs: number | null;
  windowCloseMs: number;
  capturedAtMs: number;
  secondsLeft: number;
  snapshotId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await insertPhase4BDecisionCaptureInSql({
    market: {
      marketId: record.ticker, ticker: record.ticker, series: `KX${record.asset}15M`, asset: record.asset,
      intervalStartMs: record.windowOpenMs, intervalEndMs: record.windowCloseMs, windowCloseMs: record.windowCloseMs,
      metadataCapturedAtMs: record.capturedAtMs, schemaVersion: "compact-shadow-v1", metadataVersion: "public-kalshi-window-v1",
    },
    snapshot: {
      snapshotId: record.snapshotId, marketId: record.ticker, capturedAtMs: record.capturedAtMs,
      secondsLeft: Math.max(0, Math.round(record.secondsLeft)), candidateSide: "none",
      source: "compact-coinbase-shadow", schemaVersion: "compact-shadow-v1", ...record.payload,
    },
    reference: {
      snapshotId: record.snapshotId, marketId: record.ticker, capturedAtMs: record.capturedAtMs,
      asset: record.asset, source: "coinbase_public_ticker_batch", schemaVersion: "compact-shadow-v1",
      ...record.payload,
    },
  });
}

/** Health is append-only research metadata, stored without public tick payloads. */
export async function insertCompactShadowHealthInSql(record: {
  asset: "BTC" | "ETH" | "SOL"; id: string; capturedAtMs: number; ticker: string | null; payload: Record<string, unknown>;
}): Promise<void> {
  if (!_db || !_healthy) throw new Error("SQL storage unavailable");
  await _db.insert(phase4bProspectiveSimulations).values({
    id: `compact-health:${record.id}`, snapshotId: `compact-health:${record.id}`,
    hypothesisVersion: "compact-shadow-feed-health-v1", qualification: String(record.payload.status ?? "unknown"),
    ticker: record.ticker ?? `KX${record.asset}15M-health`, capturedAtMs: record.capturedAtMs,
    payload: { asset: record.asset, ...record.payload, raw_ticks_persisted: false },
    schemaVersion: "compact-shadow-v1",
  }).onConflictDoNothing();
  _lastWriteMs = Date.now();
}

export async function getCompactShadowStatusInSql(): Promise<Record<string, unknown>> {
  if (!_db || !_healthy) return { storage: "unavailable", assets: [] };
  // This table belongs exclusively to passive research. Initialize it lazily
  // from the status path so a cold sidecar never leaves the read-only report
  // unhealthy, without coupling research DDL to execution-critical startup.
  try {
    await _db.execute(sql`
      CREATE TABLE IF NOT EXISTS phase4b_compact_ledger_checkpoints (
        ledger_path text PRIMARY KEY, device text, inode text, byte_offset bigint NOT NULL DEFAULT 0,
        last_record_id text, last_record_at_ms bigint, status text NOT NULL DEFAULT 'new',
        last_reason text, rejected_count bigint NOT NULL DEFAULT 0, malformed_count bigint NOT NULL DEFAULT 0,
        write_failure_count bigint NOT NULL DEFAULT 0, lost_record_count bigint NOT NULL DEFAULT 0,
        rotation_count bigint NOT NULL DEFAULT 0, truncation_count bigint NOT NULL DEFAULT 0,
        updated_at_ms bigint NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS phase4b_compact_ledger_checkpoints_updated_idx
        ON phase4b_compact_ledger_checkpoints (updated_at_ms DESC);
    `);
  } catch (err) {
    logger.warn({ err }, "compact-shadow checkpoint schema initialization failed");
  }
  const result = await _db.execute(sql`
    WITH snapshots AS (
      SELECT mi.asset, ds.market_id, ds.captured_at_ms, ds.payload
      FROM phase4b_decision_snapshots ds
      JOIN phase4b_market_intervals mi ON mi.market_id = ds.market_id
      WHERE ds.source = 'compact-coinbase-shadow'
    ), health AS (
      SELECT payload->>'asset' AS asset, captured_at_ms, payload
      FROM phase4b_prospective_simulations
      WHERE hypothesis_version = 'compact-shadow-feed-health-v1'
    ), lifecycle AS (
      SELECT ticker, captured_at_ms, qualification
      FROM phase4b_prospective_simulations
      WHERE hypothesis_version = 'compact-shadow-lifecycle-v1'
    ), lifecycle_eligible_markets AS (
      SELECT mi.asset, mi.market_id
      FROM phase4b_market_intervals mi
      INNER JOIN phase4b_market_outcomes mo ON mo.market_id = mi.market_id
      WHERE mi.metadata_version = 'public-kalshi-window-v1'
        AND mi.asset IN ('BTC', 'ETH')
        AND mo.result IN ('yes', 'no')
        AND EXISTS (
          SELECT 1
          FROM phase4b_decision_snapshots ds
          WHERE ds.market_id = mi.market_id
            AND ds.source = 'compact-coinbase-shadow'
            AND ds.captured_at_ms <= mi.window_close_ms
        )
    )
    SELECT a.asset,
      COUNT(s.*)::int AS snapshot_count,
      COUNT(DISTINCT s.market_id)::int AS market_count,
      MAX(s.captured_at_ms) AS last_snapshot_ms,
      COUNT(DISTINCT s.market_id) FILTER (WHERE o.result IN ('yes','no'))::int AS resolved_outcome_count,
      COUNT(DISTINCT s.market_id) FILTER (WHERE o.result IS NULL)::int AS pending_outcome_market_count,
       COUNT(s.*)::int AS feature_coverage_denominator,
       COALESCE(ROUND(100.0 * COUNT(s.*) FILTER (WHERE s.payload ? 'kalshi_yes_weighted_executable_price_cents' AND s.payload->>'kalshi_yes_weighted_executable_price_cents' <> 'null') / NULLIF(COUNT(s.*), 0), 1), 0) AS executable_price_coverage_pct,
       COALESCE(ROUND(100.0 * COUNT(s.*) FILTER (WHERE s.payload ? 'coinbase_microprice' AND s.payload->>'coinbase_microprice' <> 'null' AND s.payload ? 'coinbase_trade_flow_imbalance_60s' AND s.payload->>'coinbase_trade_flow_imbalance_60s' <> 'null') / NULLIF(COUNT(s.*), 0), 1), 0) AS coinbase_microstructure_coverage_pct,
       COALESCE(ROUND(100.0 * COUNT(s.*) FILTER (WHERE s.payload ? 'kalshi_yes_weighted_executable_price_cents' AND s.payload->>'kalshi_yes_weighted_executable_price_cents' <> 'null' AND s.payload ? 'coinbase_microprice' AND s.payload->>'coinbase_microprice' <> 'null') / NULLIF(COUNT(s.*), 0), 1), 0) AS full_feature_coverage_pct,
       -- path coverage: snapshots with at least one path field populated
       COALESCE(ROUND(100.0 * COUNT(s.*) FILTER (WHERE s.payload ? 'path_mfe_dollars' AND s.payload->>'path_mfe_dollars' <> 'null') / NULLIF(COUNT(s.*), 0), 1), 0) AS path_coverage_pct,
       -- regime coverage: snapshots with regime field populated
       COALESCE(ROUND(100.0 * COUNT(s.*) FILTER (WHERE s.payload ? 'regime' AND s.payload->>'regime' <> 'null') / NULLIF(COUNT(s.*), 0), 1), 0) AS regime_coverage_pct,
       -- latency coverage: snapshots with latency_ms or snapshot_latency_ms populated
       COALESCE(ROUND(100.0 * COUNT(s.*) FILTER (WHERE (s.payload ? 'latency_ms' AND s.payload->>'latency_ms' <> 'null') OR (s.payload ? 'snapshot_latency_ms' AND s.payload->>'snapshot_latency_ms' <> 'null')) / NULLIF(COUNT(s.*), 0), 1), 0) AS latency_coverage_pct,
       -- opportunity coverage: snapshots with accumulator peak edge populated
       COALESCE(ROUND(100.0 * COUNT(s.*) FILTER (WHERE s.payload ? 'acc_peak_edge_cents' AND s.payload->>'acc_peak_edge_cents' <> 'null') / NULLIF(COUNT(s.*), 0), 1), 0) AS opportunity_coverage_pct,
        -- Lifecycle eligibility requires both the exact stored outcome and
        -- final pre-settlement compact evidence. This matches recovery writes.
        (SELECT COUNT(*)::int FROM lifecycle lc JOIN lifecycle_eligible_markets em ON em.market_id = lc.ticker WHERE em.asset = a.asset) AS lifecycle_count,
        (SELECT COUNT(*)::int FROM lifecycle_eligible_markets em WHERE em.asset = a.asset) AS lifecycle_eligible_market_count,
        COALESCE(ROUND(100.0 * (SELECT COUNT(*)::int FROM lifecycle lc JOIN lifecycle_eligible_markets em ON em.market_id = lc.ticker WHERE em.asset = a.asset) / NULLIF((SELECT COUNT(*) FROM lifecycle_eligible_markets em WHERE em.asset = a.asset), 0), 1), 0) AS lifecycle_coverage_pct,
      (SELECT h.payload FROM health h WHERE h.asset = a.asset ORDER BY h.captured_at_ms DESC LIMIT 1) AS latest_health
    FROM (VALUES ('BTC'), ('ETH')) AS a(asset)
    LEFT JOIN snapshots s ON s.asset = a.asset
    LEFT JOIN phase4b_market_outcomes o ON o.market_id = s.market_id
    GROUP BY a.asset
    ORDER BY a.asset
  `);
  const [scoreResult, workerResult, backlogResult, normalizedExperimentResult, unavailableExperimentResult, compactStudiesResult, checkpointResult] = await Promise.all([
    _db.execute(sql`
      SELECT payload->>'asset' AS asset, COUNT(*)::int AS score_count,
        MAX(captured_at_ms) AS last_score_ms,
        COUNT(*) FILTER (WHERE qualification = 'WOULD_BUY')::int AS would_buy_count,
        COUNT(*) FILTER (WHERE qualification = 'SKIP')::int AS skip_count,
        COUNT(*) FILTER (WHERE qualification = 'HOLD')::int AS hold_count,
        COUNT(*) FILTER (WHERE qualification = 'WOULD_EXIT')::int AS would_exit_count
      FROM phase4b_prospective_simulations
      WHERE hypothesis_version = 'compact-shadow-probability-edge-v1'
      GROUP BY payload->>'asset'
    `),
    _db.execute(sql`
      SELECT qualification, captured_at_ms, payload
      FROM phase4b_prospective_simulations
      WHERE hypothesis_version = 'compact-shadow-worker-health-v1'
      ORDER BY captured_at_ms DESC LIMIT 1
    `),
    _db.execute(sql`
      SELECT COUNT(*)::int AS pending_outcome_backlog
      FROM phase4b_market_intervals mi
      LEFT JOIN phase4b_market_outcomes mo ON mo.market_id = mi.market_id
      WHERE mi.metadata_version = 'public-kalshi-window-v1'
        AND mi.window_close_ms <= ${Date.now() - 180_000}
        AND mo.result IS NULL
        AND COALESCE(mo.settlement_status, '') <> 'unavailable_http_404'
    `),
    _db.execute(sql`
      WITH enrollment AS (
        SELECT
          payload->>'asset' AS asset,
          qualification AS directional_call,
          ticker,
          outcome.result
        FROM phase4b_prospective_simulations
        LEFT JOIN phase4b_market_outcomes outcome ON outcome.market_id = phase4b_prospective_simulations.ticker
        WHERE hypothesis_version = 'compact-normalized-distance-prospective-v2'
          AND captured_at_ms >= ${COMPACT_NORMALIZED_DISTANCE_EXPERIMENT_START_MS}
      ), per_asset AS (
        SELECT assets.asset, false AS combined,
          COUNT(enrollment.ticker)::int AS enrolled_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.result IN ('yes','no'))::int AS settled_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.result IS NULL)::int AS pending_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.directional_call = 'neutral')::int AS neutral_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.directional_call IN ('yes','no') AND enrollment.result IN ('yes','no'))::int AS directional_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.directional_call = enrollment.result AND enrollment.directional_call IN ('yes','no'))::int AS correct_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.directional_call = 'yes' AND enrollment.result IN ('yes','no'))::int AS yes_call_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.directional_call = 'yes' AND enrollment.result = 'yes')::int AS yes_correct_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.directional_call = 'no' AND enrollment.result IN ('yes','no'))::int AS no_call_count,
          COUNT(enrollment.ticker) FILTER (WHERE enrollment.directional_call = 'no' AND enrollment.result = 'no')::int AS no_correct_count
        FROM (VALUES ('BTC'), ('ETH')) AS assets(asset)
        LEFT JOIN enrollment ON enrollment.asset = assets.asset
        GROUP BY assets.asset
        UNION ALL
        SELECT 'combined', true,
          COUNT(*)::int, COUNT(*) FILTER (WHERE result IN ('yes','no'))::int,
          COUNT(*) FILTER (WHERE result IS NULL)::int, COUNT(*) FILTER (WHERE directional_call = 'neutral')::int,
          COUNT(*) FILTER (WHERE directional_call IN ('yes','no') AND result IN ('yes','no'))::int,
          COUNT(*) FILTER (WHERE directional_call = result AND directional_call IN ('yes','no'))::int,
          COUNT(*) FILTER (WHERE directional_call = 'yes' AND result IN ('yes','no'))::int,
          COUNT(*) FILTER (WHERE directional_call = 'yes' AND result = 'yes')::int,
          COUNT(*) FILTER (WHERE directional_call = 'no' AND result IN ('yes','no'))::int,
          COUNT(*) FILTER (WHERE directional_call = 'no' AND result = 'no')::int
        FROM enrollment
      )
      SELECT * FROM per_asset ORDER BY combined, asset
    `),
    _db.execute(sql`
      SELECT
        payload->>'asset' AS asset,
        qualification AS unavailable_reason,
        COUNT(*)::int AS unavailable_count
      FROM phase4b_prospective_simulations
      WHERE hypothesis_version = 'compact-normalized-distance-prospective-v2-unavailable'
      GROUP BY payload->>'asset', qualification
    `),
    _db.execute(sql`
      WITH records AS (
        SELECT payload->>'asset' AS asset, hypothesis_version, qualification, ticker
        FROM phase4b_prospective_simulations
        WHERE hypothesis_version IN (
          'compact-normalized-distance-checkpoints-v1',
          'compact-normalized-distance-persistence-v1',
          'compact-coinbase-shock-kalshi-lag-v1',
          'compact-coinbase-shock-kalshi-lag-v1-horizon',
          'compact-shadow-studies-v1-unavailable'
        )
      ), summary AS (
        SELECT asset, hypothesis_version, COUNT(*)::int AS record_count,
          COUNT(DISTINCT ticker)::int AS market_count,
          COUNT(*) FILTER (WHERE hypothesis_version = 'compact-coinbase-shock-kalshi-lag-v1-horizon')::int AS horizon_count
        FROM records
        GROUP BY asset, hypothesis_version
      ), unavailable_counts AS (
        SELECT asset, qualification, COUNT(*)::int AS count
        FROM records
        WHERE hypothesis_version = 'compact-shadow-studies-v1-unavailable'
        GROUP BY asset, qualification
      ), unavailable AS (
        SELECT asset, jsonb_object_agg(qualification, count) AS unavailable_reasons
        FROM unavailable_counts GROUP BY asset
      )
      SELECT summary.*, COALESCE(unavailable.unavailable_reasons, '{}'::jsonb) AS unavailable_reasons
      FROM summary LEFT JOIN unavailable ON unavailable.asset = summary.asset
      ORDER BY summary.asset, summary.hypothesis_version
    `),
    (async () => {
      try {
        return await _db.execute(sql`
          SELECT ledger_path, device, inode, byte_offset, last_record_id, last_record_at_ms,
            status, last_reason, rejected_count, malformed_count, write_failure_count,
            lost_record_count, rotation_count, truncation_count, updated_at_ms,
            GREATEST(0, ${Date.now()} - updated_at_ms) AS checkpoint_age_ms
          FROM phase4b_compact_ledger_checkpoints
          ORDER BY ledger_path ASC
        `);
      } catch (err) {
        // The sidecar applies this research-only schema. A cold-start race or
        // sidecar schema failure must make prospective research unavailable,
        // never make the trading API's storage health appear unavailable.
        logger.warn({ err }, "compact-shadow checkpoint schema unavailable");
        return { rows: [], checkpointSchemaUnavailable: true };
      }
    })(),
  ]);
  const scoreRows = (scoreResult as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  const scoresByAsset = new Map(scoreRows.map((row) => [String(row.asset), row]));
  const assets = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((asset) => ({
    ...asset,
    scores: scoresByAsset.get(String(asset.asset)) ?? {
      score_count: 0, would_buy_count: 0, skip_count: 0, hold_count: 0, would_exit_count: 0, last_score_ms: null,
    },
  }));
  const worker = ((workerResult as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0] ?? null;
  const checkpointQuery = checkpointResult as unknown as {
    rows: Record<string, unknown>[];
    checkpointSchemaUnavailable?: boolean;
  };
  const checkpoints = checkpointQuery.rows ?? [];
  const checkpointSchemaAvailable = checkpointQuery.checkpointSchemaUnavailable !== true;
  const collectorHealthy = assets.length === 2 && assets.every((asset) => {
    const health = (asset as Record<string, unknown>)["latest_health"] as Record<string, unknown> | null;
    return health?.status === "fresh";
  });
  const checkpointProgressing = checkpointSchemaAvailable && checkpoints.length > 0 && checkpoints.every((checkpoint) =>
    checkpoint.status === "healthy"
      && typeof checkpoint.last_record_id === "string"
      && Number(checkpoint.byte_offset ?? 0) > 0,
  );
  const workerHealthy = worker?.qualification === "healthy";
  const experimentRows = (normalizedExperimentResult as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  const unavailableRows = (unavailableExperimentResult as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  const compactStudyRows = (compactStudiesResult as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  const compactStudyCombined = [...new Set(compactStudyRows.map((row) => String(row.hypothesis_version)))].map((version) => {
    const rows = compactStudyRows.filter((row) => String(row.hypothesis_version) === version);
    const unavailableReasons: Record<string, number> = {};
    for (const row of rows) for (const [reason, count] of Object.entries((row.unavailable_reasons ?? {}) as Record<string, unknown>)) {
      unavailableReasons[reason] = (unavailableReasons[reason] ?? 0) + Number(count ?? 0);
    }
    return { asset: "combined", descriptiveOnly: true, hypothesis_version: version,
      record_count: rows.reduce((sum, row) => sum + Number(row.record_count ?? 0), 0),
      market_count: rows.reduce((sum, row) => sum + Number(row.market_count ?? 0), 0),
      horizon_count: rows.reduce((sum, row) => sum + Number(row.horizon_count ?? 0), 0),
      unavailable_reasons: unavailableReasons };
  });
  const unavailableByAsset = new Map<string, Record<string, number>>();
  for (const row of unavailableRows) {
    const asset = String(row.asset);
    const reasons = unavailableByAsset.get(asset) ?? {};
    reasons[String(row.unavailable_reason)] = Number(row.unavailable_count ?? 0);
    unavailableByAsset.set(asset, reasons);
  }
  const experiment = experimentRows.map((row) => {
    const directionalCount = Number(row.directional_count ?? 0);
    const correctCount = Number(row.correct_count ?? 0);
    const yesCount = Number(row.yes_call_count ?? 0);
    const yesCorrect = Number(row.yes_correct_count ?? 0);
    const noCount = Number(row.no_call_count ?? 0);
    const noCorrect = Number(row.no_correct_count ?? 0);
    const wilson = (successes: number, trials: number) => {
      if (!trials) return { low: null, high: null };
      const z = 1.959963984540054, p = successes / trials, denominator = 1 + (z * z) / trials;
      const center = (p + (z * z) / (2 * trials)) / denominator;
      const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials) / denominator;
      return { low: center - margin, high: center + margin };
    };
    const asset = String(row.asset);
    return {
      ...row,
      directional_accuracy: directionalCount ? correctCount / directionalCount : null,
      directional_wilson_95: wilson(correctCount, directionalCount),
      yes_accuracy: yesCount ? yesCorrect / yesCount : null,
      yes_wilson_95: wilson(yesCorrect, yesCount),
      no_accuracy: noCount ? noCorrect / noCount : null,
      no_wilson_95: wilson(noCorrect, noCount),
      source_unavailable_reasons: asset === "combined"
        ? ["missing_source_observation", "source_before_window", "source_after_capture"].reduce<Record<string, number>>((totals, reason) => {
            totals[reason] = (unavailableByAsset.get("BTC")?.[reason] ?? 0) + (unavailableByAsset.get("ETH")?.[reason] ?? 0);
            return totals;
          }, {})
        : unavailableByAsset.get(asset) ?? {},
    };
  });
  return {
    storage: "healthy",
    assets,
    worker,
    ingestion: {
      researchOnly: true,
      checkpoints,
      readiness: {
        ready: collectorHealthy && workerHealthy && checkpointProgressing,
        checkpointSchemaAvailable,
        collectorHealthy,
        workerHealthy,
        checkpointProgressing,
        reason: !checkpointSchemaAvailable
          ? "Compact research checkpoint schema is unavailable; prospective enrollment is not ready."
          : collectorHealthy && workerHealthy && checkpointProgressing
          ? null
          : "Do not rely on prospective enrollment until the collector, worker, and every ledger checkpoint are healthy and progressing.",
      },
    },
    pendingOutcomeBacklog: ((backlogResult as unknown as { rows: Array<{ pending_outcome_backlog: number }> }).rows ?? [])[0]?.pending_outcome_backlog ?? 0,
    normalizedDistanceExperiment: {
      version: "compact-normalized-distance-prospective-v2",
      startMs: COMPACT_NORMALIZED_DISTANCE_EXPERIMENT_START_MS,
      thresholds: { yesAtOrAbove: 0.25, noAtOrBelow: -0.25 },
      researchOnly: true,
      executionGate: false,
      unavailableReasons: ["missing_source_observation", "source_before_window", "source_after_capture"],
      cohorts: experiment,
    },
    compactStudies: {
      researchOnly: true,
      executionGate: false,
      checkpointSecondsRemaining: [600, 450, 300, 180, 120, 60],
      persistenceSeconds: [60, 120],
      shockRule: { absVelocity30sAtOrAbove: 0.25, absTradeFlowImbalance60sAtOrAbove: 0.50 },
      shockHorizonSeconds: [5, 15, 30, 60],
      byAsset: [...compactStudyRows, ...compactStudyCombined],
    },
  };
}

export async function listCompactShadowOutcomeCandidatesInSql(nowMs: number, limit = 100): Promise<Array<{ ticker: string; closeMs: number }>> {
  if (!_db || !_healthy) return [];
  const result = await _db.execute(sql`
    SELECT mi.market_id AS ticker, mi.window_close_ms AS close_ms
    FROM phase4b_market_intervals mi
    LEFT JOIN phase4b_market_outcomes mo ON mo.market_id = mi.market_id
    WHERE mi.metadata_version = 'public-kalshi-window-v1'
      AND mi.window_close_ms <= ${nowMs - 180_000}
      AND (mo.result IS NULL)
      AND COALESCE(mo.settlement_status, '') <> 'unavailable_http_404'
    ORDER BY mi.window_close_ms ASC LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `);
  return ((result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? []).map((row) => ({
    ticker: String(row.ticker), closeMs: Number(row.close_ms),
  }));
}

// ── Public: window log ────────────────────────────────────────────────────────

/** Upsert a window log entry (called after every mutation in windowLog.ts). Fire-and-forget with buffered replay on DB failure. */
export function upsertWindowLogEntryInSql(entry: WindowLogEntry): void {
  _fireDurableWrite(`wl:${entry.ticker}`, { kind: "window_log", entry }, "upsertWindowLogEntryInSql");
}

async function _sqlUpsertWindowLog(entry: WindowLogEntry): Promise<void> {
  await _db!
    .insert(windowLogTable)
    .values({
      ticker:           entry.ticker,
      series:           entry.series,
      closeTime:        entry.closeTime,
      firstSeenMs:      entry.firstSeenMs,
      entered:          entry.entered,
      inZone:           entry.inZone,
      yesDerivedAsk:    entry.yesDerivedAsk,
      noDerivedAsk:     entry.noDerivedAsk,
      outcome:          entry.outcome,
      side:             entry.side,
      priceCents:       entry.priceCents,
      contractsFilled:  entry.contractsFilled,
      spentDollars:     entry.spentDollars,
      skipReason:       entry.skipReason,
      settlementResult: entry.settlementResult ?? null,
      updatedAt:        new Date(),
    })
    .onConflictDoUpdate({
      target: windowLogTable.ticker,
      set: {
        series:           entry.series,
        closeTime:        entry.closeTime,
        entered:          entry.entered,
        inZone:           entry.inZone,
        yesDerivedAsk:    entry.yesDerivedAsk,
        noDerivedAsk:     entry.noDerivedAsk,
        outcome:          entry.outcome,
        side:             entry.side,
        priceCents:       entry.priceCents,
        contractsFilled:  entry.contractsFilled,
        spentDollars:     entry.spentDollars,
        skipReason:       entry.skipReason,
        settlementResult: entry.settlementResult ?? null,
        updatedAt:        new Date(),
      },
    });
}
/** Restore window log entries from SQL (called at startup if local file is empty). */
export async function restoreWindowLogFromSql(limit = 200): Promise<WindowLogEntry[]> {
  if (!_db || !_healthy) return [];
  try {
    // Fetch the most-recent `limit` rows (newest first), then reverse so the
    // caller receives them in ascending (chronological) order for in-memory use.
    const rows = await _db
      .select()
      .from(windowLogTable)
      .orderBy(desc(windowLogTable.firstSeenMs))
      .limit(limit);
    rows.reverse();
    return rows.map((r) => ({
      ticker:           r.ticker,
      series:           r.series,
      closeTime:        r.closeTime,
      firstSeenMs:      r.firstSeenMs,
      entered:          r.entered,
      inZone:           r.inZone,
      yesDerivedAsk:    r.yesDerivedAsk,
      noDerivedAsk:     r.noDerivedAsk,
      outcome:          r.outcome as WindowLogEntry["outcome"],
      side:             r.side as "yes" | "no" | null,
      priceCents:       r.priceCents,
      contractsFilled:  r.contractsFilled,
      spentDollars:     r.spentDollars,
      skipReason:       r.skipReason,
      settlementResult: (r.settlementResult as "yes" | "no" | null | undefined) ?? null,
    }));
  } catch (err) {
    logger.warn({ err }, "tradeStore: restoreWindowLogFromSql failed");
    return [];
  }
}

// ── Public: strategy version ──────────────────────────────────────────────────

/** Record the deployed strategy version. Fire-and-forget. */
export function upsertStrategyVersionInSql(version: string): void {
  if (!_db || !_healthy) return;
  _db
    .insert(strategyVersion)
    .values({ id: 1, version, deployedAt: new Date() })
    .onConflictDoUpdate({
      target: strategyVersion.id,
      set:    { version, deployedAt: new Date() },
    })
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err: unknown) => logger.warn({ err }, "tradeStore: upsertStrategyVersionInSql failed"));
}

interface PreflightDecisionRow {
  ticker:                 string;
  series:                 string;
  side:                   "yes" | "no";
  timestampMs:            number;
  secondsLeft:            number;
  quotedBboAsk:           number | null;
  bboAgeMs:               number | null;
  bboDerivedLimitCents:   number;
  executableBestAskCents: number | null;
  bboToL2GapCents:        number | null;
  verifiedLimitCents:     number | null;
  depthAtLimitDollars:    number;
  depthAtLimitContracts:  number;
  intendedContracts:      number;
  intendedNotionalCents:  number;
  adjustedContracts:      number;
  fillFractionEstimate:   number;
  nearLimitLevels:        unknown[];
  l2FetchLatencyMs:       number;
  decision:               string;
  marketResult:           string | null;
}
/**
 * Insert one in-window BBO tick. Fire-and-forget — never blocks evaluate().
 * Duplicate (ticker, timestampMs) pairs are silently ignored via onConflictDoNothing.
 */
export function insertWindowTickSql(tick: WindowTick): void {
  _fireDurableWrite(`tick:${tick.ticker}@${tick.timestampMs}`, { kind: "window_tick", tick }, "insertWindowTickSql");
}

async function _sqlInsertWindowTick(tick: WindowTick): Promise<void> {
  const id = `${tick.ticker}@${tick.timestampMs}`;
  await _db!
    .insert(windowTicks)
    .values({
      id,
      timestampMs:   tick.timestampMs,
      easternDate:   easternDay(new Date(tick.timestampMs)),
      ticker:        tick.ticker,
      secondsLeft:   tick.secondsLeft,
      yesBid:        tick.yesBid    ?? null,
      yesAsk:        tick.yesAsk    ?? null,
      noBid:         tick.noBid     ?? null,
      noAsk:         tick.noAsk     ?? null,
      derivedYesAsk: tick.derivedYesAsk ?? null,
      derivedNoAsk:  tick.derivedNoAsk  ?? null,
      inZone:        tick.inZone,
      source:        tick.source,
    })
    .onConflictDoNothing();
}
/**
 * Load window ticks for a given ticker across one or more Eastern dates.
 * Returns an empty array if storage is unavailable or the query fails.
 */
export async function loadWindowTicksSqlForTicker(
  ticker: string,
  dates:  string[],
): Promise<WindowTick[]> {
  if (!_db || !_healthy || dates.length === 0) return [];
  try {
    const rows = await _db
      .select()
      .from(windowTicks)
      .where(
        and(
          eq(windowTicks.ticker, ticker),
          inArray(windowTicks.easternDate, dates),
        ),
      )
      .orderBy(windowTicks.timestampMs);
    return rows.map((r) => ({
      ticker:        r.ticker,
      timestampMs:   r.timestampMs,
      secondsLeft:   r.secondsLeft,
      yesBid:        r.yesBid       ?? null,
      yesAsk:        r.yesAsk       ?? null,
      noBid:         r.noBid        ?? null,
      noAsk:         r.noAsk        ?? null,
      derivedYesAsk: r.derivedYesAsk ?? null,
      derivedNoAsk:  r.derivedNoAsk  ?? null,
      inZone:        r.inZone,
      source:        r.source,
    }));
  } catch (err) {
    logger.warn({ err, ticker }, "tradeStore: loadWindowTicksSqlForTicker failed");
    return [];
  }
}

// ── Public: storage status endpoint data ─────────────────────────────────────

export interface StorageStatus {
  storageBackend:            string;
  databaseConnected:         boolean;
  migrationVersion:          string;
  orderAttemptCount:         number;
  fillCount:                 number;
  passiveObservationCount:   number;
  currentEasternDate:        string;
  restoredSpentCents:        number;
  restoredDedupSlots:        number;
  lastSuccessfulDurableWrite: string | null;
  /** Number of finaliseOrderAttempt calls queued for replay after DB recovery. */
  pendingFinalisationCount:  number;
  /** Number of buffered fire-and-forget writes (window_log, ticks, guard counts) awaiting replay. */
  pendingDurableWriteCount:  number;
  /** Live, query-free telemetry for the lane that reserves a client for durable safety writes. */
  dashboardReadProtection:  DashboardReadProtection;
  status:                    "healthy" | "degraded";
  degradedReason?:           string;
}

export interface DashboardReadProtection {
  activeReadCount: number;
  queueDepth: number;
  maxConcurrentReads: number;
  reservedSafetyClients: number;
  dashboardTrafficThrottled: boolean;
  message: string | null;
}

/**
 * Explain dashboard read throttling without revealing queries, callers, or
 * changing the trading path. A queue means the reserved pool client remains
 * available for heartbeats and settlement reconciliation.
 */
export function getDashboardReadProtection(): DashboardReadProtection {
  const status = _getBoundedReadOnlyStatus?.();
  const queueDepth = status?.queueDepth ?? 0;
  return {
    activeReadCount: status?.activeReadCount ?? 0,
    queueDepth,
    maxConcurrentReads: status?.maxConcurrentReads ?? 0,
    reservedSafetyClients: status?.reservedSafetyClients ?? 0,
    dashboardTrafficThrottled: queueDepth > 0,
    message: queueDepth > 0
      ? "Dashboard reads are waiting to keep a database client available for trading heartbeats and settlement reconciliation."
      : null,
  };
}

export type EvidenceSourceState = "sql_authoritative" | "environment_local_fallback";

export interface EvidenceStorageTableHealth {
  table: string;
  source: EvidenceSourceState;
  rowCount: number | null;
  retainedBytes: number | null;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  queryLatencyMs: number | null;
  state: "ok" | "unavailable";
}

export interface EvidenceStorageHealth {
  source: "sql_authoritative" | "environment_local_fallback";
  databaseFingerprint: string | null;
  generatedAt: string;
  tables: EvidenceStorageTableHealth[];
  totalRetainedBytes: number;
  estimatedDailyGrowthBytes: number;
  estimatedEightDayBytes: number;
  queryLatencyMs: number | null;
  warnings: Array<"sql_unavailable" | "growth_abnormal" | "retention_projection_abnormal" | "query_latency_abnormal" | "environment_local_fallback">;
  localFallbacks: string[];
}

const STORAGE_GROWTH_WARNING_BYTES_PER_DAY = 12 * 1024 * 1024;
const STORAGE_EIGHT_DAY_WARNING_BYTES = 100 * 1024 * 1024;
const STORAGE_QUERY_WARNING_MS = 1_000;

function safeRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []);
}

export function deriveEvidenceStorageOutcome(
  tables: EvidenceStorageTableHealth[],
  estimatedDailyGrowthBytes: number,
  estimatedEightDayBytes: number,
  queryLatencyMs: number | null,
): Pick<EvidenceStorageHealth, "source" | "warnings"> {
  const readableTables = tables.filter((table) => table.state === "ok").length;
  const warnings: EvidenceStorageHealth["warnings"] = [];
  if (readableTables < tables.length) warnings.push("sql_unavailable");
  if (estimatedDailyGrowthBytes > STORAGE_GROWTH_WARNING_BYTES_PER_DAY) warnings.push("growth_abnormal");
  if (estimatedEightDayBytes > STORAGE_EIGHT_DAY_WARNING_BYTES) warnings.push("retention_projection_abnormal");
  if (queryLatencyMs !== null && (queryLatencyMs > STORAGE_QUERY_WARNING_MS || tables.some((table) => (table.queryLatencyMs ?? 0) > STORAGE_QUERY_WARNING_MS))) {
    warnings.push("query_latency_abnormal");
  }
  if (readableTables < tables.length) {
    warnings.push("environment_local_fallback");
    return { source: "environment_local_fallback", warnings };
  }
  return { source: "sql_authoritative", warnings };
}

/**
 * Read-only SQL evidence inventory. It intentionally has no write or trading
 * dependency: callers can safely expose it to authenticated observability UI.
 * Filesystem mirrors are listed as fallbacks rather than merged into the counts.
 */
export async function getEvidenceStorageHealth(): Promise<EvidenceStorageHealth> {
  const generatedAt = new Date().toISOString();
  const localFallbacks = [
    "analytics NDJSON order mirrors",
    "preflight decision NDJSON",
    "window tick NDJSON",
    "coverage audit and incident NDJSON",
    "window-log.json",
  ];
  if (!_db || !_healthy) {
    return {
      source: "environment_local_fallback", databaseFingerprint: null, generatedAt, tables: [],
      totalRetainedBytes: 0, estimatedDailyGrowthBytes: 0, estimatedEightDayBytes: 0,
      queryLatencyMs: null, warnings: ["sql_unavailable", "environment_local_fallback"], localFallbacks,
    };
  }

  const startedAt = Date.now();
  const queries: Array<{ table: string; statement: ReturnType<typeof sql> }> = [
    { table: "order_attempts", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.order_attempts')::bigint AS retained_bytes, MIN(created_at)::text AS first_at, MAX(created_at)::text AS last_at FROM order_attempts` },
    { table: "order_fills", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.order_fills')::bigint AS retained_bytes, MIN(created_at)::text AS first_at, MAX(created_at)::text AS last_at FROM order_fills` },
    { table: "preflight_decisions", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.preflight_decisions')::bigint AS retained_bytes, MIN(created_at)::text AS first_at, MAX(created_at)::text AS last_at FROM preflight_decisions` },
    { table: "window_ticks", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.window_ticks')::bigint AS retained_bytes, to_timestamp(MIN(timestamp_ms) / 1000.0)::text AS first_at, to_timestamp(MAX(timestamp_ms) / 1000.0)::text AS last_at FROM window_ticks` },
    { table: "evaluation_events", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.evaluation_events')::bigint AS retained_bytes, to_timestamp(MIN(timestamp_ms) / 1000.0)::text AS first_at, to_timestamp(MAX(timestamp_ms) / 1000.0)::text AS last_at FROM evaluation_events` },
    { table: "coverage_incidents", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.coverage_incidents')::bigint AS retained_bytes, to_timestamp(MIN(detected_at_ms) / 1000.0)::text AS first_at, to_timestamp(MAX(detected_at_ms) / 1000.0)::text AS last_at FROM coverage_incidents` },
    { table: "coverage_window_audits", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.coverage_window_audits')::bigint AS retained_bytes, to_timestamp(MIN(discovered_at_ms) / 1000.0)::text AS first_at, to_timestamp(MAX(discovered_at_ms) / 1000.0)::text AS last_at FROM coverage_window_audits` },
    { table: "runtime_watchdog_history", statement: sql`SELECT COUNT(*)::int AS row_count, pg_total_relation_size('public.runtime_watchdog_history')::bigint AS retained_bytes, to_timestamp(MIN(polled_at_ms) / 1000.0)::text AS first_at, to_timestamp(MAX(polled_at_ms) / 1000.0)::text AS last_at FROM runtime_watchdog_history` },
  ];
  const tables = await Promise.all(queries.map(async ({ table, statement }) => {
    const queryStartedAt = Date.now();
    try {
      const row = safeRows<{ row_count: number | string; retained_bytes: number | string; first_at: string | null; last_at: string | null }>(
        await _db!.execute(statement),
      )[0];
      return {
        table, source: "sql_authoritative" as const, state: "ok" as const,
        rowCount: Number(row?.row_count ?? 0), retainedBytes: Number(row?.retained_bytes ?? 0),
        firstRecordedAt: row?.first_at ?? null, lastRecordedAt: row?.last_at ?? null,
        queryLatencyMs: Date.now() - queryStartedAt,
      };
    } catch {
      return { table, source: "sql_authoritative" as const, state: "unavailable" as const,
        rowCount: null, retainedBytes: null, firstRecordedAt: null, lastRecordedAt: null,
        queryLatencyMs: Date.now() - queryStartedAt };
    }
  }));
  const totalRetainedBytes = tables.reduce((sum, table) => sum + (table.retainedBytes ?? 0), 0);
  const firstMs = Math.min(...tables.map((table) => table.firstRecordedAt ? Date.parse(table.firstRecordedAt) : NaN).filter(Number.isFinite));
  const observedDays = Number.isFinite(firstMs) ? Math.max(1, (Date.now() - firstMs) / 86_400_000) : 1;
  const estimatedDailyGrowthBytes = Math.ceil(totalRetainedBytes / observedDays);
  const estimatedEightDayBytes = estimatedDailyGrowthBytes * 8;
  const queryLatencyMs = Date.now() - startedAt;
  const outcome = deriveEvidenceStorageOutcome(tables, estimatedDailyGrowthBytes, estimatedEightDayBytes, queryLatencyMs);
  return {
    source: outcome.source,
    databaseFingerprint: safeRows<{ fingerprint: string }>(await _db.execute(sql`SELECT md5(current_database() || ':' || current_user || ':' || coalesce(inet_server_addr()::text, 'local')) AS fingerprint`))[0]?.fingerprint ?? null,
    generatedAt, tables, totalRetainedBytes, estimatedDailyGrowthBytes, estimatedEightDayBytes,
    queryLatencyMs, warnings: outcome.warnings, localFallbacks,
  };
}

// ── Analytics hydration from SQL ─────────────────────────────────────────────

/**
 * Map the SQL `outcome` column to the `OrderOutcome` union used by analytics.ts.
 * Returns null for unresolved states and any unknown value.
 */
function sqlOutcomeToAnalytics(
  outcome: string | null,
): OrderAttemptRecord["outcome"] | null {
  switch (outcome) {
    // Full fill (new + legacy)
    case "full_fill":
    case "filled":
    case "post_confirmed":    return "full_fill";
    // Partial fill (new + legacy)
    case "partial_fill":
    case "partially_filled":  return "partial_fill";
    // Zero/no fill (new + legacy)
    case "zero_fill":
    case "post_rejected":
    case "cancelled":
    case "reconciled_not_found": return "zero_fill";
    // Legacy analytics values (kept for backward compat)
    case "rejected":          return "rejected";
    case "ambiguous":         return "ambiguous";
    // Unresolved states — excluded from analytics
    default:                  return null;
  }
}

/**
 * Derive settlement fields (win, P&L, ROI, outcomeReconciledAt) for a hydrated
 * record when the SQL row has a non-null `won` column. Mirrors the formulas in
 * outcomeReconciler.ts so hydrated records match live-reconciled ones — without
 * this, a redeploy that wipes the NDJSON files drops every settled fill back to
 * "pending" in the P&L report even though `won` is persisted in SQL.
 */
export function deriveSettlementFields(row: {
  won: boolean | null;
  side: string;
  fillPriceCents: number | null;
  limitPriceCents: number | null;
  contracts: number | null;
  fillCount: number | null;
  notionalDollars: number | null;
  feeDollars: number | null;
  updatedAt: Date | null;
  timestampMs: number | string | bigint;
}): Partial<OrderAttemptRecord> {
  if (row.won == null) return { win: null };

  const fillPrice = row.fillPriceCents ?? row.limitPriceCents ?? 0;
  const contracts = (row.contracts ?? 0) > 0 ? (row.contracts ?? 0) : (row.fillCount ?? 0);
  const notional  = (row.notionalDollars ?? 0) > 0
    ? (row.notionalDollars ?? 0)
    : (fillPrice * contracts) / 100;
  const fees = row.feeDollars ?? 0;

  const grossPnlDollars = row.won
    ? ((100 - fillPrice) * contracts) / 100
    : -((fillPrice * contracts) / 100);
  const netPnlDollars = grossPnlDollars - fees;
  const roi           = notional > 0 ? grossPnlDollars / notional : 0;

  // Market result: we won iff our side matched the settlement result.
  const side = row.side as "yes" | "no";
  const marketResult: "yes" | "no" = row.won ? side : (side === "yes" ? "no" : "yes");

  return {
    win:                 row.won,
    marketResult,
    grossPnlDollars,
    netPnlDollars,
    roi,
    outcomeReconciledAt: row.updatedAt ? row.updatedAt.getTime() : Number(row.timestampMs),
  };
}

/**
 * Load all finalized order attempt rows for a given Eastern date from SQL and
 * return them as `OrderAttemptRecord` objects suitable for analytics hydration.
 *
 * Only rows with a final outcome (filled, partial_fill, zero_fill, rejected,
 * ambiguous) are returned; pending rows are excluded.
 */
export async function loadOrderAttemptsFromSql(
  date: string,
): Promise<OrderAttemptRecord[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.select().from(orderAttempts).where(
      and(
        eq(orderAttempts.easternDate, date),
        not(inArray(orderAttempts.outcome, UNRESOLVED_OUTCOMES)),
        realOrderPredicate(),
      ),
    );
    return rows.flatMap((row) => {
      const outcome = sqlOutcomeToAnalytics(row.outcome ?? null);
      if (!outcome) return [];
      const clientOrderId  = row.clientOrderId ?? row.id;
      const attemptNumber  = row.attemptNumber ?? 1;
      // Use the same compound ID format as recordOrderAttempt() in analytics.ts so
      // records from any SQL hydration path are found by getOrderAttemptById().
      const analyticsId    = `${clientOrderId}-${attemptNumber}`;
      const record: OrderAttemptRecord = {
        id:                     analyticsId,
        timestampMs:            Number(row.timestampMs),
        ticker:                 row.ticker,
        series:                 row.series,
        windowCloseTime:        row.windowCloseTime ?? null,
        side:                   (row.side as "yes" | "no"),
        attemptNumber,
        source:                 ((row.source ?? "rest_fallback") as "websocket" | "rest_fallback"),
        triggerPriceCents:      row.triggerPriceCents ?? 0,
        limitPriceCents:        row.limitPriceCents   ?? 0,
        requestedContracts:     row.requestedContracts ?? 0,
        requestedNotionalCents: row.requestedNotionalCents ?? 0,
        clientOrderId,
        orderId:                row.orderId || null,
        fillCount:              row.fillCount      ?? 0,
        remainingCount:         row.remainingCount ?? 0,
        contracts:    { value: row.contracts          ?? 0,    source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        fillPriceCents: { value: row.fillPriceCents   ?? null, source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        notionalDollars:{ value: row.notionalDollars  ?? 0,    source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        feeDollars:    { value: row.feeDollars         ?? 0,    source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        outcome,
        submissionAudit: parseSubmissionAudit(row.submissionAudit),
        roundTripMs:   row.roundTripMs  ?? null,
        tickReceivedMs:   row.tickReceivedMs   ?? null,
        evalStartMs:      row.evalStartMs      ?? null,
        l2StartMs:        row.l2StartMs        ?? null,
        l2EndMs:          row.l2EndMs          ?? null,
        postStartMs:      row.postStartMs      ?? null,
        ackMs:            row.ackMs            ?? null,
        l2BestAskCents:   row.l2BestAskCents   ?? null,
        l2DepthDollars:   row.l2DepthDollars   ?? null,
        l2DepthContracts: row.l2DepthContracts ?? null,
        reconciled:        row.reconciled   ?? false,
        reconcile_failed:  row.reconcileFailed ?? false,
        fill_price_source: (row.fillPriceSource as "actual" | "limit_fallback" | null) ?? null,
        // Settlement outcome — win/P&L/outcomeReconciledAt derived from `won` column
        ...deriveSettlementFields(row),
      };
      return [record];
    });
  } catch (err) {
    logger.warn({ err, date }, "tradeStore: loadOrderAttemptsFromSql failed");
    return [];
  }
}

/**
 * Minimal row shape returned by loadAllOrderRowsForBackfill.
 * Contains only the fields needed to build a placeholder OrderAttemptRecord.
 */
export interface BackfillOrderRow {
  id:                     string;
  timestampMs:            number;
  ticker:                 string;
  series:                 string;
  windowCloseTime:        string | null;
  side:                   "yes" | "no";
  attemptNumber:          number;
  source:                 string;
  triggerPriceCents:      number;
  limitPriceCents:        number;
  requestedContracts:     number;
  requestedNotionalCents: number;
  clientOrderId:          string;
  orderId:                string | null;
  outcome:                string;
  fillCount:              number;
  remainingCount:         number;
  contracts:              number;
  fillPriceCents:         number | null;
  notionalDollars:        number;
  feeDollars:             number;
  roundTripMs:            number | null;
  reconciled:             boolean;
  reconcile_failed:       boolean;
  fill_price_source:      "actual" | "limit_fallback" | null;
  won:                    boolean | null;
  updatedAt:              Date | null;
}

/**
 * Load ALL order attempt rows for a given Eastern date from SQL — including rows
 * with unresolved outcomes (post_started, post_unknown, interrupted_shutdown, etc.).
 *
 * Used by the startup analytics backfill so no submitted order is invisible in
 * analytics just because the server restarted before fill reconciliation ran.
 */
export async function loadAllOrderRowsForBackfill(
  date: string,
): Promise<BackfillOrderRow[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.select().from(orderAttempts).where(
      and(eq(orderAttempts.easternDate, date), realOrderPredicate()),
    );
    return rows.map((row): BackfillOrderRow => ({
      id:                     row.id,
      timestampMs:            Number(row.timestampMs),
      ticker:                 row.ticker,
      series:                 row.series,
      windowCloseTime:        row.windowCloseTime ?? null,
      side:                   (row.side as "yes" | "no"),
      attemptNumber:          row.attemptNumber ?? 1,
      source:                 row.source ?? "rest_fallback",
      triggerPriceCents:      row.triggerPriceCents ?? 0,
      limitPriceCents:        row.limitPriceCents   ?? 0,
      requestedContracts:     row.requestedContracts ?? 0,
      requestedNotionalCents: row.requestedNotionalCents ?? 0,
      clientOrderId:          row.clientOrderId ?? row.id,
      orderId:                row.orderId || null,
      outcome:                row.outcome ?? "reserved",
      fillCount:              row.fillCount      ?? 0,
      remainingCount:         row.remainingCount ?? 0,
      contracts:              row.contracts      ?? 0,
      fillPriceCents:         row.fillPriceCents ?? null,
      notionalDollars:        row.notionalDollars ?? 0,
      feeDollars:             row.feeDollars     ?? 0,
      roundTripMs:            row.roundTripMs    ?? null,
      reconciled:             row.reconciled     ?? false,
      reconcile_failed:       row.reconcileFailed ?? false,
      fill_price_source:      (row.fillPriceSource as "actual" | "limit_fallback" | null) ?? null,
      won:                    row.won            ?? null,
      updatedAt:              row.updatedAt      ?? null,
    }));
  } catch (err) {
    logger.warn({ err, date }, "tradeStore: loadAllOrderRowsForBackfill failed");
    return [];
  }
}

/**
 * Load finalized order attempt rows across a rolling date range.
 * `days = 1` → today only, `days = 7` → past 7 days, `days = 0` → all time.
 */
export async function loadOrdersFromSqlForRange(
  days: number,
): Promise<OrderAttemptRecord[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows =
      days <= 0
        ? await _db.select().from(orderAttempts).where(and(
            not(inArray(orderAttempts.outcome, UNRESOLVED_OUTCOMES)),
            realOrderPredicate(),
          ))
        : await (() => {
            // Build earliest Eastern date string (YYYY-MM-DD)
            const now   = new Date();
            const start = new Date(now);
            start.setUTCDate(start.getUTCDate() - (days - 1));
            const fromDate = easternDay(start);
            return _db!.select().from(orderAttempts).where(
              and(
                gte(orderAttempts.easternDate, fromDate),
                not(inArray(orderAttempts.outcome, UNRESOLVED_OUTCOMES)),
                realOrderPredicate(),
              ),
            );
          })();

    return rows.flatMap((row) => {
      const outcome = sqlOutcomeToAnalytics(row.outcome ?? null);
      if (!outcome) return [];
      const clientOrderId  = row.clientOrderId ?? row.id;
      const attemptNumber  = row.attemptNumber ?? 1;
      const analyticsId    = `${clientOrderId}-${attemptNumber}`;
      const record: OrderAttemptRecord = {
        id:                     analyticsId,
        timestampMs:            Number(row.timestampMs),
        ticker:                 row.ticker,
        series:                 row.series,
        windowCloseTime:        row.windowCloseTime ?? null,
        side:                   (row.side as "yes" | "no"),
        attemptNumber,
        source:                 ((row.source ?? "rest_fallback") as "websocket" | "rest_fallback"),
        triggerPriceCents:      row.triggerPriceCents ?? 0,
        limitPriceCents:        row.limitPriceCents   ?? 0,
        requestedContracts:     row.requestedContracts ?? 0,
        requestedNotionalCents: row.requestedNotionalCents ?? 0,
        clientOrderId,
        orderId:                row.orderId || null,
        fillCount:              row.fillCount      ?? 0,
        remainingCount:         row.remainingCount ?? 0,
        contracts:    { value: row.contracts          ?? 0,    source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        fillPriceCents: { value: row.fillPriceCents   ?? null, source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        notionalDollars:{ value: row.notionalDollars  ?? 0,    source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        feeDollars:    { value: row.feeDollars         ?? 0,    source: row.reconciled ? "confirmed_from_fills_api" : "confirmed_from_response" },
        outcome,
        submissionAudit: parseSubmissionAudit(row.submissionAudit),
        roundTripMs:   row.roundTripMs  ?? null,
        tickReceivedMs:   row.tickReceivedMs   ?? null,
        evalStartMs:      row.evalStartMs      ?? null,
        l2StartMs:        row.l2StartMs        ?? null,
        l2EndMs:          row.l2EndMs          ?? null,
        postStartMs:      row.postStartMs      ?? null,
        ackMs:            row.ackMs            ?? null,
        l2BestAskCents:   row.l2BestAskCents   ?? null,
        l2DepthDollars:   row.l2DepthDollars   ?? null,
        l2DepthContracts: row.l2DepthContracts ?? null,
        reconciled:        row.reconciled   ?? false,
        reconcile_failed:  row.reconcileFailed ?? false,
        fill_price_source: (row.fillPriceSource as "actual" | "limit_fallback" | null) ?? null,
        // Settlement outcome — win/P&L/outcomeReconciledAt derived from `won` column
        ...deriveSettlementFields(row),
      };
      return [record];
    });
  } catch (err) {
    logger.warn({ err, days }, "tradeStore: loadOrdersFromSqlForRange failed");
    return [];
  }
}

// ── Public: daily guard-outcome counts ───────────────────────────────────────

/**
 * Upsert all guard-outcome count rows for a given Eastern date.
 * Each row: (easternDate, series, outcomeKey, count).
 * Fire-and-forget — never blocks analytics or trading.
 */
export function persistGuardCountsToSql(
  easternDate: string,
  countsMap: Map<string, Record<string, number>>,
): void {
  _fireDurableWrite(`gc:${easternDate}`, { kind: "guard_counts", easternDate, countsMap }, "persistGuardCountsToSql");
}

async function _sqlPersistGuardCounts(
  easternDate: string,
  countsMap: Map<string, Record<string, number>>,
): Promise<void> {
  const rows: { id: string; easternDate: string; series: string; outcomeKey: string; count: number; updatedAt: Date }[] = [];
  for (const [series, counts] of countsMap) {
    for (const [outcomeKey, count] of Object.entries(counts)) {
      if (count > 0) {
        rows.push({
          id:          `${easternDate}:${series}:${outcomeKey}`,
          easternDate,
          series,
          outcomeKey,
          count,
          updatedAt:   new Date(),
        });
      }
    }
  }
  if (rows.length === 0) return;
  await _db!
    .insert(dailyGuardCounts)
    .values(rows)
    .onConflictDoUpdate({
      target: dailyGuardCounts.id,
      set: {
        count:     sql`GREATEST(excluded.count, ${dailyGuardCounts.count})`,
        updatedAt: new Date(),
      },
    });
}
/**
 * Load all guard-outcome rows for an Eastern date from SQL.
 * Returns a Map<series, Record<outcomeKey, count>>.
 */
export async function loadGuardCountsFromSql(
  easternDate: string,
): Promise<Map<string, Record<string, number>>> {
  const result = new Map<string, Record<string, number>>();
  if (!_db || !_healthy) return result;
  try {
    const rows = await _db
      .select()
      .from(dailyGuardCounts)
      .where(eq(dailyGuardCounts.easternDate, easternDate));
    for (const row of rows) {
      if (!result.has(row.series)) result.set(row.series, {});
      result.get(row.series)![row.outcomeKey] = row.count;
    }
  } catch (err) {
    logger.warn({ err, easternDate }, "tradeStore: loadGuardCountsFromSql failed");
  }
  return result;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const today = easternDay(new Date());
  const base: StorageStatus = {
    storageBackend:            "postgresql",
    databaseConnected:         _healthy,
    migrationVersion:          "1.0.0",
    orderAttemptCount:         0,
    fillCount:                 0,
    passiveObservationCount:   0,
    currentEasternDate:        today,
    restoredSpentCents:        _restoredSpentCents,
    restoredDedupSlots:        _restoredDedupSlots,
    lastSuccessfulDurableWrite: _lastWriteMs ? new Date(_lastWriteMs).toISOString() : null,
    pendingFinalisationCount:  _pendingFinalisations.size,
    pendingDurableWriteCount:  _pendingDurableWrites.size,
    dashboardReadProtection:  getDashboardReadProtection(),
    status:                    _healthy ? "healthy" : "degraded",
  };

  if (!_healthy) {
    return { ...base, degradedReason: _degradedReason };
  }

  try {
    const [attemptRows, obsRows] = await Promise.all([
      _db!.execute<{ total: number; fills: number }>(sql`
        SELECT
          COUNT(*)::int                                              AS total,
          COUNT(*) FILTER (WHERE outcome IN ('partial_fill','full_fill'))::int AS fills
        FROM order_attempts
      `),
      _db!.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS total FROM passive_observations
      `),
    ]);

    const att  = (attemptRows.rows?.[0] ?? (attemptRows as unknown as { rows: unknown[] }).rows?.[0]) as { total: number; fills: number } | undefined;
    const obs  = (obsRows.rows?.[0]     ?? (obsRows     as unknown as { rows: unknown[] }).rows?.[0]) as { total: number } | undefined;

    return {
      ...base,
      orderAttemptCount:       att?.total ?? 0,
      fillCount:               att?.fills ?? 0,
      passiveObservationCount: obs?.total ?? 0,
    };
  } catch (err) {
    logger.warn({ err }, "tradeStore: getStorageStatus count query failed");
    return base;
  }
}

/**
 * Write the settlement_result to the window_log row for a settled ticker.
 * Fire-and-forget; never blocks trading or reconciliation.
 */
export function recordWindowSettlementInSql(ticker: string, result: "yes" | "no"): void {
  _fireDurableWrite(`st:${ticker}`, { kind: "settlement", ticker, result }, "recordWindowSettlementInSql");
}

/**
 * Insert one pre-flight gate decision. Fire-and-forget — never blocks the
 * trading path. Duplicate (ticker, timestampMs, side) triples are ignored.
 */
export function insertPreflightDecisionSql(d: PreflightDecisionRow): void {
  if (!_db || !_healthy) return;
  const id = `${d.ticker}@${d.timestampMs}:${d.side}`;
  let levelsJson = "[]";
  try { levelsJson = JSON.stringify(d.nearLimitLevels ?? []); } catch { /* keep "[]" */ }
  _db
    .insert(preflightDecisions)
    .values({
      id,
      timestampMs:            d.timestampMs,
      easternDate:            easternDay(new Date(d.timestampMs)),
      ticker:                 d.ticker,
      series:                 d.series,
      side:                   d.side,
      secondsLeft:            Math.round(d.secondsLeft),
      quotedBboAsk:           d.quotedBboAsk           ?? null,
      bboAgeMs:               d.bboAgeMs != null ? Math.round(d.bboAgeMs) : null,
      bboDerivedLimitCents:   d.bboDerivedLimitCents,
      executableBestAskCents: d.executableBestAskCents ?? null,
      bboToL2GapCents:        d.bboToL2GapCents        ?? null,
      verifiedLimitCents:     d.verifiedLimitCents     ?? null,
      depthAtLimitDollars:    d.depthAtLimitDollars,
      depthAtLimitContracts:  d.depthAtLimitContracts,
      intendedContracts:      d.intendedContracts,
      intendedNotionalCents:  d.intendedNotionalCents,
      adjustedContracts:      d.adjustedContracts,
      fillFractionEstimate:   d.fillFractionEstimate,
      nearLimitLevels:        levelsJson,
      l2FetchLatencyMs:       d.l2FetchLatencyMs != null ? Math.round(d.l2FetchLatencyMs) : null,
      decision:               d.decision,
      marketResult:           d.marketResult ?? null,
    })
    .onConflictDoNothing()
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err: unknown) => logger.warn({ err, ticker: d.ticker }, "tradeStore: insertPreflightDecisionSql failed"));
}

// Register as the preflightStore SQL sink at module load (see setPreflightSqlSink
// docs — the hook keeps preflightStore pino-free for isolated test bundles).
import { setPreflightSqlSink } from "./preflightStore.js";
setPreflightSqlSink(insertPreflightDecisionSql);

/**
 * Bulk-update market_result on preflight_decisions rows that are still null.
 *
 * Called by runPreflightSettlementBackfill() at startup so the SQL table
 * reflects settled outcomes without waiting for live reconciliation.
 * Fire-and-forget; never throws into the caller.
 */
export function updatePreflightMarketResultsInSql(
  resultMap: Record<string, string>,
): void {
  if (!_db || !_healthy) return;
  const tickers = Object.keys(resultMap).filter(
    (t) => resultMap[t] === "yes" || resultMap[t] === "no",
  );
  if (tickers.length === 0) return;
  // Issue one UPDATE per ticker (small batch — market-result-cache is bounded to
  // MAX_CACHE_SIZE=1000 entries; this runs once at startup, not in the hot path).
  for (const ticker of tickers) {
    const result = resultMap[ticker];
    _db
      .update(preflightDecisions)
      .set({ marketResult: result })
      .where(and(eq(preflightDecisions.ticker, ticker), isNull(preflightDecisions.marketResult)))
      .then(() => { _lastWriteMs = Date.now(); })
      .catch((err: unknown) =>
        logger.warn({ err, ticker }, "tradeStore: updatePreflightMarketResultsInSql failed"),
      );
  }
}

/**
 * Read preflight decisions from durable storage for a report lookback.
 * This is deliberately read-only and complements the deployment-local NDJSON
 * mirror, which may be absent after a restart or deployment.
 */
export async function loadPreflightDecisionsFromSqlForRange(
  days: number,
): Promise<PreflightDecision[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = days <= 0
      ? await _db.select().from(preflightDecisions)
      : await (() => {
          const start = new Date();
          start.setUTCDate(start.getUTCDate() - (days - 1));
          return _db!.select().from(preflightDecisions).where(
            gte(preflightDecisions.easternDate, easternDay(start)),
          );
        })();
    return rows.map((row) => ({
      ticker: row.ticker,
      series: row.series,
      side: row.side as "yes" | "no",
      timestampMs: Number(row.timestampMs),
      secondsLeft: row.secondsLeft,
      quotedBboAsk: row.quotedBboAsk ?? null,
      bboAgeMs: row.bboAgeMs ?? null,
      bboDerivedLimitCents: row.bboDerivedLimitCents,
      executableBestAskCents: row.executableBestAskCents ?? null,
      bboToL2GapCents: row.bboToL2GapCents ?? null,
      verifiedLimitCents: row.verifiedLimitCents ?? null,
      depthAtLimitDollars: row.depthAtLimitDollars,
      depthAtLimitContracts: row.depthAtLimitContracts,
      intendedContracts: row.intendedContracts,
      intendedNotionalCents: row.intendedNotionalCents,
      adjustedContracts: row.adjustedContracts,
      fillFractionEstimate: row.fillFractionEstimate,
      nearLimitLevels: [] as L2Level[],
      l2FetchLatencyMs: row.l2FetchLatencyMs ?? 0,
      decision: row.decision,
      marketResult: row.marketResult ?? null,
    }));
  } catch (err) {
    logger.warn({ err, days }, "tradeStore: loadPreflightDecisionsFromSqlForRange failed");
    return [];
  }
}

async function _sqlRecordWindowSettlement(ticker: string, result: "yes" | "no"): Promise<void> {
  await _db!
    .update(windowLogTable)
    .set({ settlementResult: result, updatedAt: new Date() } as Record<string, unknown>)
    .where(eq(windowLogTable.ticker, ticker));
}

/**
 * Replay all buffered fire-and-forget writes. Called right after a successful
 * ping, alongside _drainPendingFinalisations(). Stops early on the first
 * failure (the pool likely dropped again); remaining entries stay buffered.
 */
async function _drainPendingDurableWrites(): Promise<void> {
  if (_durableWriteDrainInFlight) return;
  if (_pendingDurableWrites.size === 0) return;
  _durableWriteDrainInFlight = true;
  const total = _pendingDurableWrites.size;
  logger.info(
    { count: total },
    "tradeStore: replaying buffered durable writes after DB recovery",
  );
  let replayed = 0;
  try {
    while (_pendingDurableWrites.size > 0 && _healthy) {
      const next = _nextPendingDurableWrite();
      if (!next) break;
      const [key, w] = next;
      try {
        await _executeDurableWrite(w);
        // A newer latest-wins update may have arrived while this write was
        // awaiting SQL. Only remove the exact object we persisted; leaving a
        // replacement queued prevents silently losing the newer state.
        if (_pendingDurableWrites.get(key) === w) {
          _pendingDurableWrites.delete(key);
        }
        _lastWriteMs = Date.now();
        replayed++;
      } catch (err) {
        logger.warn(
          { err, key, replayed, remaining: _pendingDurableWrites.size },
          "tradeStore: durable-write replay failed — remaining writes stay buffered",
        );
        _scheduleRetry();
        break;
      }
    }
    if (replayed > 0) {
      logger.info(
        { replayed, remaining: _pendingDurableWrites.size },
        "tradeStore: durable-write replay complete — buffered writes persisted to SQL",
      );
    }
  } finally {
    _durableWriteDrainInFlight = false;
  }
}

/**
 * For integration tests only: explicitly invoke the durable-write drain
 * without waiting for the reconnect timer.
 *
 * When the DB is healthy, _fireDurableWrite fires writes immediately as
 * fire-and-forget Promises (not buffered).  This helper awaits those in-flight
 * Promises first so tests that call recordEvaluationEventToSql() and then
 * immediately query see a consistent DB state.
 */
export async function _drainPendingDurableWritesForTesting(): Promise<void> {
  if (_inFlightDurableWrites.size > 0) {
    await Promise.allSettled([..._inFlightDurableWrites]);
  }
  return _drainPendingDurableWrites();
}

/** Number of fire-and-forget writes buffered awaiting DB recovery. */
export function getPendingDurableWriteCount(): number {
  return _pendingDurableWrites.size;
}

const _pendingDurableWrites = new Map<string, PendingDurableWrite>();
let _durableWriteDrainInFlight = false;

/**
 * Tracks Promises for fire-and-forget writes that are currently in-flight
 * against a healthy DB.  Populated by _fireDurableWrite and cleared when each
 * write settles.  _drainPendingDurableWritesForTesting awaits these before
 * draining the buffer so integration tests see a consistent DB state.
 */
const _inFlightDurableWrites = new Set<Promise<void>>();
/** Per-kind caps on high-volume buffered writes so a multi-hour outage cannot
 * grow the in-memory buffer without bound (observed live 2026-08-15: 500+
 * buffered writes within one hour of outage).  Uncapped kinds (window_log,
 * guard_counts, settlement, coverage_*) are low-volume, latest-wins rows. */
const BUFFER_CAPS: Partial<Record<PendingDurableWrite["kind"], number>> = {
  window_tick:         600,  // ~10 min of 1s ticks — least critical
  eval_event:          2000, // one per evaluation tick during active windows
  kalshi_read_network: 200,  // telemetry only
};

/**
 * Priority is deliberately limited to durability/operational impact, never
 * trading strategy.  A single telemetry flood must not consume the shared
 * PostgreSQL pool ahead of settlement or protective-monitor evidence.
 */
function _durableWritePriority(w: PendingDurableWrite): number {
  switch (w.kind) {
    case "settlement":
    case "pe_monitor_incident":
      return 0;
    case "coverage_incident":
    case "coverage_window_audit":
    case "guard_counts":
      return 1;
    case "window_log":
      return 2;
    case "eval_event":
      return 3;
    case "kalshi_read_network":
    case "window_tick":
      return 4;
  }
}

/** Oldest entry wins within a durability priority. */
function _nextPendingDurableWrite(): [string, PendingDurableWrite] | null {
  let selected: [string, PendingDurableWrite] | null = null;
  let selectedPriority = Number.POSITIVE_INFINITY;
  for (const entry of _pendingDurableWrites) {
    const priority = _durableWritePriority(entry[1]);
    if (priority < selectedPriority) {
      selected = entry;
      selectedPriority = priority;
    }
  }
  return selected;
}

function _bufferDurableWrite(key: string, w: PendingDurableWrite): void {
  const cap = BUFFER_CAPS[w.kind];
  if (cap !== undefined && !_pendingDurableWrites.has(key)) {
    // Enforce the cap by evicting the oldest buffered entry of the same kind.
    let count = 0;
    let oldestKey: string | null = null;
    for (const [k, v] of _pendingDurableWrites) {
      if (v.kind === w.kind) { count++; if (oldestKey === null) oldestKey = k; }
    }
    if (count >= cap && oldestKey !== null) {
      _pendingDurableWrites.delete(oldestKey);
    }
  }
  _pendingDurableWrites.set(key, w);
}

/**
 * Route a fire-and-forget durable write. If the pool is known-unhealthy, buffer
 * immediately. Otherwise attempt the write; on failure, buffer it and schedule
 * a reconnect probe so the buffer drains as soon as the pool recovers.
 */
function _fireDurableWrite(key: string, w: PendingDurableWrite, label: string): void {
  if (!_db) return; // permanent misconfiguration — nothing to buffer against
  _bufferDurableWrite(key, w);
  if (!_healthy) {
    _scheduleRetry();
    return;
  }
  const p = _drainPendingDurableWrites()
    .catch((err: unknown) => {
      logger.warn(
        { err, key, pendingDurableWrites: _pendingDurableWrites.size },
        `tradeStore: ${label} dispatch failed — buffered for replay after DB recovery`,
      );
      _scheduleRetry();
    })
    .finally(() => { _inFlightDurableWrites.delete(p); });
  _inFlightDurableWrites.add(p);
}

/** Execute one buffered write against the live pool. Throws on failure. */
async function _executeDurableWrite(w: PendingDurableWrite): Promise<void> {
  switch (w.kind) {
    case "window_log":        await _sqlUpsertWindowLog(w.entry); break;
    case "window_tick":       await _sqlInsertWindowTick(w.tick); break;
    case "guard_counts":      await _sqlPersistGuardCounts(w.easternDate, w.countsMap); break;
    case "settlement":        await _sqlRecordWindowSettlement(w.ticker, w.result); break;
    case "eval_event":        await _sqlInsertEvaluationEvent(w.id, w.event); break;
    case "coverage_incident": await _sqlUpsertCoverageIncident(w.incident); break;
    case "coverage_window_audit": await _sqlUpsertCoverageWindowAudit(w.audit); break;
    case "kalshi_read_network": await _sqlInsertKalshiReadNetworkEvent(w.event); break;
    case "pe_monitor_incident": await _sqlInsertPeMonitorIncident(w.incident); break;
  }
}

async function _sqlInsertPeMonitorIncident(incident: ProtectiveExitMonitorIncident): Promise<void> {
  await _db!.execute(sql`
    INSERT INTO protective_exit_monitor_incidents
      (id, ticker, detected_at_ms, kind, severity, local_side, local_quantity, executable_bid_cents, details)
    VALUES (${incident.id}, ${incident.ticker}, ${incident.detectedAtMs}, ${incident.kind},
      ${incident.severity}, ${incident.localSide}, ${incident.localQuantity},
      ${incident.executableBidCents}, ${incident.details.slice(0, 500)})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function _sqlInsertKalshiReadNetworkEvent(event: KalshiReadNetworkAuditInput): Promise<void> {
  await _db!.execute(sql`
    INSERT INTO kalshi_read_network_events
      (id, endpoint_category, error_class, elapsed_ms, retry_count, recovery_outcome)
    VALUES (
      ${`kalshi-read:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`},
      ${event.endpointCategory.slice(0, 80)}, ${event.errorClass?.slice(0, 120) ?? null},
      ${Math.max(0, Math.round(event.elapsedMs))}, ${Math.max(0, event.retryCount)}, ${event.recoveryOutcome}
    )
  `);
}

async function _sqlUpsertCoverageIncident(incident: CoverageIncident): Promise<void> {
  await _db!
    .insert(coverageIncidents)
    .values({
      incidentId:          incident.incidentId,
      ticker:              incident.ticker,
      series:              incident.series,
      closeTime:           incident.closeTime,
      detectedAtMs:        incident.detectedAtMs,
      secondsLeftAtDetect: incident.secondsLeftAtDetect,
      lastUsableQuoteMs:   incident.lastUsableQuoteMs ?? null,
      lastEvaluationMs:    incident.lastEvaluationMs  ?? null,
      lastWsDataMsgMs:     incident.lastWsDataMsgMs   ?? null,
      lastWsAnyMsgMs:      incident.lastWsAnyMsgMs    ?? null,
      wsConnected:         incident.wsConnected,
      recoveryAttempts:    JSON.stringify(incident.recoveryAttempts),
      status:              incident.status,
      recoveredAtMs:       incident.recoveredAtMs ?? null,
      easternDate:         easternDay(new Date(incident.detectedAtMs)),
    })
    .onConflictDoUpdate({
      target: coverageIncidents.incidentId,
      set: {
        recoveryAttempts: JSON.stringify(incident.recoveryAttempts),
        status:           incident.status,
        recoveredAtMs:    incident.recoveredAtMs ?? null,
        updatedAt:        new Date(),
      },
    });
}

async function _sqlUpsertCoverageWindowAudit(audit: CoverageWindowAudit): Promise<void> {
  await _db!
    .insert(coverageWindowAudits)
    .values({
      auditId: audit.auditId, ticker: audit.ticker, series: audit.series, closeTime: audit.closeTime,
      discoveredAtMs: audit.discoveredAtMs, eligibleStartMs: audit.eligibleStartMs,
      finalWindowStartedAtMs: audit.finalWindowStartedAtMs, finalWindowClosedAtMs: audit.finalWindowClosedAtMs,
      firstUsableQuoteMs: audit.firstUsableQuoteMs, lastUsableQuoteMs: audit.lastUsableQuoteMs,
      firstEvaluationMs: audit.firstEvaluationMs, lastEvaluationMs: audit.lastEvaluationMs,
      finalWindowUsableQuotes: audit.finalWindowUsableQuotes,
      finalWindowEvaluations: audit.finalWindowEvaluations,
      status: audit.status, incidentId: audit.incidentId,
      transitions: JSON.stringify(audit.transitions), recoveryAttempts: JSON.stringify(audit.recoveryAttempts),
       evidenceCompleteness: audit.evidenceCompleteness,
       restartEvidenceUncertain: audit.restartEvidenceUncertain,
      easternDate: easternDay(new Date(audit.discoveredAtMs)),
    })
    .onConflictDoUpdate({
      target: coverageWindowAudits.auditId,
      set: {
        finalWindowStartedAtMs: audit.finalWindowStartedAtMs,
        finalWindowClosedAtMs: audit.finalWindowClosedAtMs,
        firstUsableQuoteMs: audit.firstUsableQuoteMs,
        lastUsableQuoteMs: audit.lastUsableQuoteMs,
        firstEvaluationMs: audit.firstEvaluationMs,
        lastEvaluationMs: audit.lastEvaluationMs,
        finalWindowUsableQuotes: audit.finalWindowUsableQuotes,
        finalWindowEvaluations: audit.finalWindowEvaluations,
        status: audit.status,
        incidentId: audit.incidentId,
        transitions: JSON.stringify(audit.transitions),
        recoveryAttempts: JSON.stringify(audit.recoveryAttempts),
        evidenceCompleteness: audit.evidenceCompleteness,
        restartEvidenceUncertain: audit.restartEvidenceUncertain,
        updatedAt: new Date(),
      },
      // A delayed pre-close write must never replace a sealed classification.
      // All normal post-close writes are also sealed, so they remain allowed.
      where: sql`${coverageWindowAudits.finalWindowClosedAtMs} IS NULL OR excluded.final_window_closed_at_ms IS NOT NULL`,
    });
}

async function _sqlInsertEvaluationEvent(id: string, event: EvaluationEvent): Promise<void> {
  await _db!
    .insert(evaluationEvents)
    .values({
      id,
      timestampMs:       event.timestampMs,
      easternDate:       easternDay(new Date(event.timestampMs)),
      ticker:            event.ticker,
      series:            event.series,
      secondsLeft:       event.secondsLeft,
      source:            event.source,
      yesBid:            event.yesBid    ?? null,
      yesAsk:            event.yesAsk    ?? null,
      noBid:             event.noBid     ?? null,
      noAsk:             event.noAsk     ?? null,
      yesDerivedAsk:     event.yesDerivedAsk ?? null,
      noDerivedAsk:      event.noDerivedAsk  ?? null,
      side:              event.side          ?? null,
      limitCents:        event.limitCents    ?? null,
      outcome:           event.outcome,
      preflightDecision: event.preflightDecision ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Persist one EvaluationEvent to SQL. Fire-and-forget with durable-write
 * buffer replay on DB failure. Called via the hook injected at startup.
 *
 * A UUID is generated once per call and used as both the SQL primary key
 * and the durable-write buffer key so that:
 *  - Distinct events with identical (ticker, timestampMs, side, outcome)
 *    are never conflated — each gets its own row.
 *  - Buffer replay on DB recovery is idempotent — the same content-hash maps
 *    to the same SQL row via onConflictDoNothing().
 *
 * ID scheme: ev:<first 16 hex chars of SHA-256(JSON.stringify(event))>.
 * The NDJSON writer stores exactly JSON.stringify(event) per line, so the
 * backfill produces the same PK from the raw NDJSON line.  This shared
 * identity means onConflictDoNothing handles duplicates regardless of whether
 * a row was inserted by the live writer or the startup backfill — a server_metadata
 * recovery that reruns the backfill never double-counts live events.
 */
export function recordEvaluationEventToSql(event: EvaluationEvent): void {
  const canonical = JSON.stringify(event);
  const id  = `ev:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
  const key = `ee:${id}`;
  _fireDurableWrite(key, { kind: "eval_event", id, event }, "recordEvaluationEventToSql");
}

/** server_metadata key that marks a successful evaluation-event NDJSON backfill. */
const EVAL_BACKFILL_META_KEY = "eval_events_backfill_complete";

/**
 * One-time startup backfill: scan NDJSON files under data/analytics/ and
 * INSERT each evaluation event within the active retention window into the SQL
 * table with onConflictDoNothing() so that pre-deployment history is
 * immediately queryable without data loss.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * Only events within EVAL_EVENTS_RETENTION_DAYS_DEFAULT days are imported.
 * The startup prune (Step 6 of initTradeStore) enforces the same ceiling, so
 * importing older events would be contradictory — they would be pruned on this
 * or the next restart.  This is consistent behaviour, not data loss.
 *
 * ── Completion tracking ───────────────────────────────────────────────────────
 * Completion is recorded in the dedicated `server_metadata` table
 * (key = "eval_events_backfill_complete").  This is authoritative: the check
 * always queries SQL, so a fresh or restored database correctly retriggers the
 * import regardless of any local filesystem state.
 *
 * ── Shared event identity ────────────────────────────────────────────────────
 * Both this backfill and the live recordEvaluationEventToSql() writer derive
 * the SQL row PK using the same formula:
 *   ev:<first 16 hex chars of SHA-256(JSON.stringify(event))>
 * The NDJSON file stores exactly JSON.stringify(event) per line, so hashing
 * the raw line produces the same PK as the live writer for the same event.
 * onConflictDoNothing therefore deduplicates correctly whether a row was first
 * written by the live writer or the backfill — including during a
 * server_metadata recovery retry where live ev: rows are already present.
 *
 * ── Retry safety ──────────────────────────────────────────────────────────────
 * If a chunk fails, hadChunkFailure prevents writing the metadata row.  The
 * next restart retries the full scan.  Already-inserted ev: rows are silently
 * skipped via onConflictDoNothing.
 */
export async function backfillEvaluationEventsFromFiles(): Promise<void> {
  if (!_db || !_healthy) {
    // The only safe time to run the backfill is before the live SQL writer is
    // registered (startup ordering guarantee in index.ts).  If the DB is not
    // available at that point, skip silently: the next restart will pick it up
    // once the DB is healthy.  A deferred-retry approach would race the live
    // writer (which is registered immediately after this call returns) and
    // produce duplicate rows for events that occurred during the outage.
    logger.warn(
      "tradeStore: evaluation event backfill skipped — DB not available at startup; will attempt on next restart",
    );
    return;
  }

  // ── Authoritative completion check (server_metadata table) ─────────────────
  // Always queries SQL so a database reset or restore correctly retriggers the
  // import — there is no local file state to trust.
  try {
    const done = await _db.execute(
      sql`SELECT 1 FROM server_metadata WHERE key = ${EVAL_BACKFILL_META_KEY} LIMIT 1`,
    );
    if ((done as { rows?: unknown[] }).rows?.length) {
      logger.info(
        "tradeStore: evaluation event backfill already completed (server_metadata) — skipping",
      );
      return;
    }
  } catch (checkErr) {
    // server_metadata table may not exist yet on an older schema — proceed and
    // let the final INSERT catch its own error so we don't lose data silently.
    logger.warn({ checkErr }, "tradeStore: backfill completion check failed — proceeding with import");
  }

  // ── Strict file scan ─────────────────────────────────────────────────────────
  // Neither readdirSync nor readFileSync are wrapped in try/catch here.  Any
  // filesystem error (EACCES, EIO, etc.) propagates to the outer catch below,
  // which returns without writing the completion record.  This guarantees that
  // a transient mount or permissions failure does not permanently suppress the
  // historical import — the next startup retries automatically.
  //
  // An empty directory listing is a verified empty state (not a read error) and
  // is safe to mark complete with 0 events.
  //
  // ID scheme: bf:<first 16 hex chars of SHA-256(raw NDJSON line)>.
  // Content-addressed IDs are:
  //   • Stable across retention-boundary shifts (not positional).
  //   • Idempotent on retry via onConflictDoNothing.
  //   • Distinct from live UUID-keyed rows, so live events written before
  //     the live writer is activated are not double-counted.
  try {
    const dataDir     = process.env["EVAL_EVENTS_DATA_DIR"]
      ?? join(process.cwd(), "data", "analytics");
    const retentionMs = EVAL_EVENTS_RETENTION_DAYS_DEFAULT * 86_400_000;
    const cutoffMs    = retentionMs > 0 ? Date.now() - retentionMs : 0;

    // readdirSync: propagates directory-level I/O errors.
    const ndjsonFiles = readdirSync(dataDir)
      .filter((name) => name.startsWith("evaluation-events-") && name.endsWith(".ndjson"))
      .sort(); // chronological order

    if (ndjsonFiles.length === 0) {
      logger.info(
        { retentionDays: EVAL_EVENTS_RETENTION_DAYS_DEFAULT },
        "tradeStore: evaluation event backfill — no NDJSON files found, nothing to import",
      );
    }

    // ── Parse all files into (id, record) pairs ───────────────────────────────
    // Each readFileSync call propagates file-level I/O errors, aborting the
    // entire backfill without writing the completion record.  Individual JSON
    // parse failures are logged and skipped (an unreadable line is not worth
    // aborting the whole import).
    type BackfillRow = {
      id: string;
      timestampMs: number;
      easternDate: string;
      ticker: string;
      series: string;
      secondsLeft: number;
      source: string;
      yesBid: number | null;
      yesAsk: number | null;
      noBid: number | null;
      noAsk: number | null;
      yesDerivedAsk: number | null;
      noDerivedAsk: number | null;
      side: string | null;
      limitCents: number | null;
      outcome: string;
      preflightDecision: string | null;
    };

    const rows: BackfillRow[] = [];
    let parseErrors = 0;
    for (const filename of ndjsonFiles) {
      // readFileSync: propagates file-level I/O errors (no try/catch).
      const raw   = readFileSync(join(dataDir, filename), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      for (const rawLine of lines) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
          parseErrors++;
          logger.debug({ filename, rawLine: rawLine.slice(0, 80) }, "tradeStore: backfill skipping malformed NDJSON line");
          continue;
        }
        const tsMs = typeof parsed["timestampMs"] === "number" ? parsed["timestampMs"] : 0;
        if (cutoffMs > 0 && tsMs < cutoffMs) continue; // outside retention window
        // Same formula as recordEvaluationEventToSql: ev:<sha256(rawLine).hex16>.
        // The NDJSON file stores JSON.stringify(event) per line, which is the
        // same bytes the live writer hashes.  Shared PK ensures onConflictDoNothing
        // handles duplicates regardless of which path wrote the row first.
        const id = `ev:${createHash("sha256").update(rawLine).digest("hex").slice(0, 16)}`;
        rows.push({
          id,
          timestampMs:       tsMs,
          easternDate:       easternDay(new Date(tsMs)),
          ticker:            String(parsed["ticker"] ?? ""),
          series:            String(parsed["series"] ?? ""),
          secondsLeft:       Number(parsed["secondsLeft"] ?? 0),
          source:            String(parsed["source"]   ?? "ndjson_backfill"),
          yesBid:            parsed["yesBid"]           != null ? Number(parsed["yesBid"])           : null,
          yesAsk:            parsed["yesAsk"]            != null ? Number(parsed["yesAsk"])            : null,
          noBid:             parsed["noBid"]             != null ? Number(parsed["noBid"])             : null,
          noAsk:             parsed["noAsk"]             != null ? Number(parsed["noAsk"])             : null,
          yesDerivedAsk:     parsed["yesDerivedAsk"]     != null ? Number(parsed["yesDerivedAsk"])     : null,
          noDerivedAsk:      parsed["noDerivedAsk"]      != null ? Number(parsed["noDerivedAsk"])      : null,
          side:              parsed["side"]              != null ? String(parsed["side"])              : null,
          limitCents:        parsed["limitCents"]        != null ? Number(parsed["limitCents"])        : null,
          outcome:           String(parsed["outcome"]    ?? "no_tick"),
          preflightDecision: parsed["preflightDecision"] != null ? String(parsed["preflightDecision"]) : null,
        });
      }
    }

    logger.info(
      { count: rows.length, files: ndjsonFiles.length, parseErrors, retentionDays: EVAL_EVENTS_RETENTION_DAYS_DEFAULT },
      "tradeStore: evaluation event backfill starting",
    );

    // ── Insert in chunks ──────────────────────────────────────────────────────
    let inserted        = 0;
    let skipped         = 0;
    let hadChunkFailure = false;
    const CHUNK         = 100;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        const result = await _db
          .insert(evaluationEvents)
          .values(chunk)
          .onConflictDoNothing();
        const rowsInserted = (result as { rowCount?: number }).rowCount ?? 0;
        inserted += rowsInserted;
        skipped  += chunk.length - rowsInserted;
      } catch (chunkErr) {
        hadChunkFailure = true;
        logger.warn(
          { chunkErr, chunkStart: i, chunkSize: chunk.length },
          "tradeStore: evaluation event backfill chunk failed — will retry on next startup",
        );
        skipped += chunk.length;
      }
    }

    if (hadChunkFailure) {
      logger.warn(
        { total: rows.length, inserted, skipped },
        "tradeStore: evaluation event backfill incomplete — completion NOT recorded, will retry",
      );
      return;
    }

    // ── Record durable completion in server_metadata ───────────────────────────
    // Authoritative: a fresh/restored DB will not find this row and will
    // re-run the import correctly.  onConflictDoNothing makes this idempotent.
    try {
      await _db.execute(
        sql`INSERT INTO server_metadata (key, value, updated_at)
            VALUES (${EVAL_BACKFILL_META_KEY}, ${new Date().toISOString()}, NOW())
            ON CONFLICT (key) DO NOTHING`,
      );
    } catch (metaErr) {
      // Non-fatal: the next restart will retry; bf: rows are already safe via
      // onConflictDoNothing so no data is lost.
      logger.warn(
        { metaErr },
        "tradeStore: evaluation event backfill — metadata write failed; will retry on next startup",
      );
      return; // Do not log "complete" until the record is committed
    }

    logger.info(
      { total: rows.length, inserted, skipped, parseErrors },
      "tradeStore: evaluation event backfill complete",
    );
  } catch (err) {
    // Typically a filesystem I/O error from readdirSync or readFileSync.
    // Completion is NOT recorded — the next startup retries the full import.
    logger.warn(
      { err },
      "tradeStore: evaluation event backfill failed — history remains in NDJSON files only",
    );
  }
}
/**
 * Query evaluation events from SQL within the given time horizon.
 *
 * @param limitMs  Only return events from the last `limitMs` milliseconds
 *                 (default 24 h). Pass 0 to load ALL stored events.
 */
export async function loadRecentEvaluationEventsFromSql(
  limitMs = 24 * 60 * 60 * 1_000,
): Promise<EvaluationEvent[]> {
  if (!_db || !_healthy) return [];
  try {
    const cutoff = limitMs > 0 ? Date.now() - limitMs : 0;
    const rows = await _db
      .select()
      .from(evaluationEvents)
      .where(cutoff > 0 ? gte(evaluationEvents.timestampMs, cutoff) : sql`TRUE`)
      .orderBy(asc(evaluationEvents.timestampMs));
    return rows.map((r) => ({
      ticker:            r.ticker,
      series:            r.series,
      timestampMs:       r.timestampMs,
      secondsLeft:       r.secondsLeft,
      source:            r.source as EvaluationEvent["source"],
      yesBid:            r.yesBid    ?? null,
      yesAsk:            r.yesAsk    ?? null,
      noBid:             r.noBid     ?? null,
      noAsk:             r.noAsk     ?? null,
      yesDerivedAsk:     r.yesDerivedAsk ?? null,
      noDerivedAsk:      r.noDerivedAsk  ?? null,
      side:              r.side as "yes" | "no" | null,
      limitCents:        r.limitCents    ?? null,
      outcome:           r.outcome as EvaluationEvent["outcome"],
      preflightDecision: r.preflightDecision ?? null,
    }));
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadRecentEvaluationEventsFromSql failed");
    return [];
  }
}

/**
 * Bounded, newest-first evaluation evidence for the liveness endpoint. Unlike
 * the analytics reader above, this never materializes an entire trading day.
 * `available` preserves a read failure so callers cannot mistake it for quiet.
 */
export async function loadEvaluationActivityForRuntimeHealth(
  limit = 300,
): Promise<{ events: EvaluationEvent[]; available: boolean }> {
  if (!_db || !_healthy) return { events: [], available: false };
  try {
    const rows = await _db
      .select()
      .from(evaluationEvents)
      .orderBy(desc(evaluationEvents.timestampMs))
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
    return {
      available: true,
      events: rows.map((r) => ({
        ticker: r.ticker, series: r.series, timestampMs: r.timestampMs,
        secondsLeft: r.secondsLeft, source: r.source as EvaluationEvent["source"],
        yesBid: r.yesBid ?? null, yesAsk: r.yesAsk ?? null,
        noBid: r.noBid ?? null, noAsk: r.noAsk ?? null,
        yesDerivedAsk: r.yesDerivedAsk ?? null, noDerivedAsk: r.noDerivedAsk ?? null,
        side: r.side as "yes" | "no" | null, limitCents: r.limitCents ?? null,
        outcome: r.outcome as EvaluationEvent["outcome"],
        preflightDecision: r.preflightDecision ?? null,
      })),
    };
  } catch (err) {
    logger.warn({ err }, "tradeStore: runtime legacy activity read failed");
    return { events: [], available: false };
  }
}

/**
 * Update the order_attempts row with verified fill data from Kalshi's fills API.
 * Called after fillReconciler successfully fetches individual fills. Sets
 * reconciled=true so SQL loaders return "confirmed_from_fills_api" source,
 * ensuring analytics remain accurate after a server restart.
 *
 * Best-effort: logs a warning on failure but never throws.
 */
export async function persistReconciliation(
  orderId: string,
  params:  ReconciliationParams,
): Promise<void> {
  if (!orderId || !_db || !_healthy) return;
  try {
    await _db
      .update(orderAttempts)
      .set({
        fillPriceCents:  params.fillPriceCents,
        contracts:       params.contracts,
        notionalDollars: params.notionalDollars,
        feeDollars:      params.feeDollars,
        reconciled:      true,
        updatedAt:       new Date(),
      })
      .where(eq(orderAttempts.orderId, orderId));
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, orderId }, "tradeStore: persistReconciliation failed");
  }
}

export interface UnreconciledFilledOrder {
  attemptId: string;
  orderId:   string;
  side:      "yes" | "no";
  ticker:    string;
}

/** Filled orders whose durable totals have not yet been confirmed by Kalshi's fills API. */
export async function loadUnreconciledFilledOrders(limit = 50): Promise<UnreconciledFilledOrder[]> {
  if (!_db || !_healthy) return [];
  try {
    // Deduplicate in SQL before the batch cap. A newest-first raw row cap lets
    // duplicate local attempts crowd out older Kalshi orders forever.
    const canonical = _db
      .selectDistinctOn([orderAttempts.orderId], {
        attemptId: orderAttempts.id,
        orderId: orderAttempts.orderId,
        side: orderAttempts.side,
        ticker: orderAttempts.ticker,
        timestampMs: orderAttempts.timestampMs,
      })
      .from(orderAttempts)
      .where(and(
        inArray(orderAttempts.outcome, ["full_fill", "partial_fill", "filled", "partially_filled"]),
        isNotNull(orderAttempts.orderId),
        or(eq(orderAttempts.reconciled, false), isNull(orderAttempts.reconciled)),
        realOrderPredicate(),
      ))
      .orderBy(orderAttempts.orderId, orderAttempts.timestampMs, orderAttempts.id)
      .as("canonical_unreconciled_orders");

    const rows = await _db
      .select({
        attemptId: canonical.attemptId,
        orderId: canonical.orderId,
        side: canonical.side,
        ticker: canonical.ticker,
      })
      .from(canonical)
      .orderBy(asc(canonical.timestampMs), asc(canonical.attemptId))
      .limit(Math.max(1, Math.min(limit, 100)));

    const seenOrderIds = new Set<string>();
    return rows.flatMap((row) => {
      if (!row.orderId || seenOrderIds.has(row.orderId) || (row.side !== "yes" && row.side !== "no")) return [];
      seenOrderIds.add(row.orderId);
      return [{ attemptId: row.attemptId, orderId: row.orderId, side: row.side, ticker: row.ticker }];
    });
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadUnreconciledFilledOrders failed");
    return [];
  }
}

/**
 * Returns exchange order IDs with durable local ownership for an Eastern date.
 * This includes legacy order-attempt parents and the independent ETH martingale
 * ledger. Exchange-history coverage uses this to identify fills that must be
 * reviewed instead of silently folding potentially manual activity into bot P&L.
 */
export async function loadKnownOrderIdsForEasternDate(easternDate: string): Promise<Set<string>> {
  if (!_db || !_healthy) return new Set();
  try {
    const [legacyRows, ethRows] = await Promise.all([
      _db
        .selectDistinct({ orderId: orderAttempts.orderId })
        .from(orderAttempts)
        .where(and(eq(orderAttempts.easternDate, easternDate), isNotNull(orderAttempts.orderId))),
      _db.execute(sql`
        SELECT DISTINCT kalshi_order_id AS order_id
        FROM eth_martingale_orders
        WHERE eastern_date = ${easternDate}
          AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND kalshi_order_id IS NOT NULL
      `),
    ]);
    const ownedIds = new Set(legacyRows.flatMap((row) => row.orderId ? [row.orderId] : []));
    for (const row of (ethRows as unknown as { rows: Array<Record<string, unknown>> }).rows) {
      const orderId = row["order_id"];
      if (typeof orderId === "string" && orderId.length > 0) ownedIds.add(orderId);
    }
    return ownedIds;
  } catch (err) {
    logger.warn({ err, easternDate }, "tradeStore: loadKnownOrderIdsForEasternDate failed");
    return new Set();
  }
}

export interface LossTimelineRow {
  order_id:               string | null;
  ticker:                 string;
  series:                 string;
  eastern_date:           string;
  timestamp_ms:           number;
  side:                   string;
  trigger_price_cents:    number | null;
  limit_price_cents:      number | null;
  stored_contracts:       number;
  stored_fill_price_cents: number | null;
  notional_dollars:       number;
  reconciled:             boolean;
  reconcile_failed:       boolean | null;
  fill_price_source:      string | null;
  won:                    boolean | null;
  tick_received_ms:       number | null;
  eval_start_ms:          number | null;
  l2_start_ms:            number | null;
  l2_end_ms:              number | null;
  post_start_ms:          number | null;
  ack_ms:                 number | null;
  l2_best_ask_cents:      number | null;
  l2_depth_dollars:       number | null;
  fills: Array<{
    fill_price_cents: number;
    contracts:        number;
    fee_dollars:      number;
    fill_timestamp:   string | null;
  }> | null;
}

/**
 * Detailed order timeline for filled orders on a given series + Eastern date.
 * Includes all timing instrumentation fields and aggregated individual fill chunks.
 * Used for "falling knife" audits — reveals how long the market was moving
 * before the order was submitted.
 *
 * @param series    — Kalshi series prefix, e.g. "KXBTC15M"
 * @param date      — Eastern date string YYYY-MM-DD
 * @param winFilter — null = all, true = wins only, false = losses only
 */
export async function loadLossTimelineRows(
  series:    string,
  date:      string,
  winFilter: boolean | null = null,
): Promise<LossTimelineRow[]> {
  if (!_db || !_healthy) return [];
  try {
    const winClause =
      winFilter === null  ? sql`` :
      winFilter           ? sql`AND oa.won = true` :
                            sql`AND oa.won = false`;
    const result = await _db.execute<Record<string, unknown>>(sql`
      SELECT
        oa.order_id,
        oa.ticker,
        oa.series,
        oa.eastern_date,
        oa.timestamp_ms,
        oa.side,
        oa.trigger_price_cents,
        oa.limit_price_cents,
        COALESCE(oa.contracts, 0)        AS stored_contracts,
        oa.fill_price_cents              AS stored_fill_price_cents,
        COALESCE(oa.notional_dollars, 0) AS notional_dollars,
        COALESCE(oa.reconciled, false)   AS reconciled,
        oa.reconcile_failed,
        oa.fill_price_source,
        oa.won,
        oa.tick_received_ms,
        oa.eval_start_ms,
        oa.l2_start_ms,
        oa.l2_end_ms,
        oa.post_start_ms,
        oa.ack_ms,
        oa.l2_best_ask_cents,
        oa.l2_depth_dollars,
        CASE WHEN COUNT(f.id) > 0
          THEN json_agg(
            json_build_object(
              'fill_price_cents', f.fill_price_cents,
              'contracts',        f.contracts,
              'fee_dollars',      f.fee_dollars,
              'fill_timestamp',   f.fill_timestamp
            ) ORDER BY f.id
          )
          ELSE NULL
        END AS fills
      FROM order_attempts oa
      LEFT JOIN order_fills f ON f.order_id = oa.order_id
      WHERE oa.series = ${series}
        AND oa.eastern_date = ${date}
        AND oa.outcome IN ('partial_fill', 'full_fill', 'partially_filled', 'filled')
        AND oa.is_synthetic = false
        ${winClause}
      GROUP BY
        oa.order_id, oa.ticker, oa.series, oa.eastern_date, oa.timestamp_ms, oa.side,
        oa.trigger_price_cents, oa.limit_price_cents, oa.contracts, oa.fill_price_cents,
        oa.notional_dollars, oa.reconciled, oa.reconcile_failed, oa.fill_price_source, oa.won, oa.tick_received_ms, oa.eval_start_ms,
        oa.l2_start_ms, oa.l2_end_ms, oa.post_start_ms, oa.ack_ms,
        oa.l2_best_ask_cents, oa.l2_depth_dollars
      ORDER BY oa.timestamp_ms ASC
    `);
    return (result.rows ?? []) as unknown as LossTimelineRow[];
  } catch (err) {
    logger.warn({ err, series, date }, "tradeStore: loadLossTimelineRows failed");
    return [];
  }
}

export interface FillAccuracyRow {
  order_id:                 string | null;
  ticker:                   string;
  series:                   string;
  eastern_date:             string;
  timestamp_ms:             number;
  side:                     string;
  limit_price_cents:        number | null;
  trigger_price_cents:      number | null;
  stored_contracts:         number;
  stored_fill_price_cents:  number | null;
  notional_dollars:         number;
  reconciled:               boolean;
  won:                      boolean | null;
  fill_chunks:              number;
  actual_total_contracts:   number;
  actual_avg_fill_price_cents: number | null;
  min_fill_price_cents:     number | null;
  max_fill_price_cents:     number | null;
  actual_total_fee_cents:   number;
}

// ── Settlement coverage query ─────────────────────────────────────────────────

export interface MarketResultsCoverageResult {
  totalDurableCount:  number;
  coveredCount:       number;
  uncoveredTickers:   string[];
}

/**
 * Given an explicit list of tickers, returns how many have a durable result
 * in market_results and which ones are still missing.
 *
 * Also returns the total count of all rows in market_results for context.
 */
export async function loadMarketResultsCoverage(
  tickers: string[],
): Promise<MarketResultsCoverageResult> {
  if (!_db || !_healthy) {
    return { totalDurableCount: 0, coveredCount: 0, uncoveredTickers: tickers };
  }
  try {
    // Total rows in market_results
    const totalResult = await _db.execute<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM market_results`,
    );
    const totalDurableCount = parseInt((totalResult.rows[0] as { c: string })?.c ?? "0", 10);

    if (tickers.length === 0) {
      return { totalDurableCount, coveredCount: 0, uncoveredTickers: [] };
    }

    // Which of the supplied tickers are present
    const covered = await _db
      .select({ ticker: marketResults.ticker })
      .from(marketResults)
      .where(inArray(marketResults.ticker, tickers));

    const coveredSet = new Set(covered.map((r) => r.ticker));
    const uncoveredTickers = tickers.filter((t) => !coveredSet.has(t));

    return {
      totalDurableCount,
      coveredCount: coveredSet.size,
      uncoveredTickers,
    };
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadMarketResultsCoverage failed");
    return { totalDurableCount: 0, coveredCount: 0, uncoveredTickers: tickers };
  }
}

/**
 * Per-order comparison of stored fill_price_cents vs the actual weighted
 * average computed from order_fills. Returns up to 500 rows newest-first.
 *
 * @param days — 0 = all-time; positive = last N Eastern calendar days.
 */
export async function loadFillAccuracyRows(days = 0): Promise<FillAccuracyRow[]> {
  if (!_db || !_healthy) return [];
  try {
    const dateFilter = days > 0
      ? sql`AND oa.eastern_date >= ${new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)}`
      : sql``;
    const result = await _db.execute<Record<string, unknown>>(sql`
      SELECT
        oa.order_id,
        oa.ticker,
        oa.series,
        oa.eastern_date,
        oa.timestamp_ms,
        oa.side,
        oa.limit_price_cents,
        oa.trigger_price_cents,
        COALESCE(oa.contracts, 0)                                         AS stored_contracts,
        oa.fill_price_cents                                               AS stored_fill_price_cents,
        COALESCE(oa.notional_dollars, 0)                                  AS notional_dollars,
        COALESCE(oa.reconciled, false)                                    AS reconciled,
        oa.won,
        COUNT(f.id)::int                                                  AS fill_chunks,
        COALESCE(SUM(f.contracts), 0)                                     AS actual_total_contracts,
        CASE WHEN SUM(f.contracts) > 0
          THEN ROUND(
            SUM(f.fill_price_cents::numeric * f.contracts) /
            NULLIF(SUM(f.contracts::numeric), 0)
          )::int
          ELSE NULL
        END                                                               AS actual_avg_fill_price_cents,
        MIN(f.fill_price_cents)                                           AS min_fill_price_cents,
        MAX(f.fill_price_cents)                                           AS max_fill_price_cents,
        COALESCE(ROUND(SUM(f.fee_dollars) * 100), 0)                      AS actual_total_fee_cents
      FROM order_attempts oa
      LEFT JOIN order_fills f ON f.order_id = oa.order_id
      WHERE oa.outcome IN ('partial_fill', 'full_fill', 'partially_filled', 'filled')
        AND oa.order_id IS NOT NULL
        ${dateFilter}
      GROUP BY
        oa.order_id, oa.ticker, oa.series, oa.eastern_date, oa.timestamp_ms, oa.side,
        oa.limit_price_cents, oa.trigger_price_cents, oa.contracts, oa.fill_price_cents,
        oa.notional_dollars, oa.reconciled, oa.won
      ORDER BY oa.timestamp_ms DESC
      LIMIT 500
    `);
    return (result.rows ?? []) as unknown as FillAccuracyRow[];
  } catch (err) {
    logger.warn({ err, days }, "tradeStore: loadFillAccuracyRows failed");
    return [];
  }
}

export interface DiscoveredOrderAttemptParams {
  kalshiOrderId:   string;
  ticker:          string;
  series:          string;
  side:            "yes" | "no";
  easternDate:     string;
  fillTimestampMs: number;
}

/**
 * Set won=true/false for any filled attempt on `ticker` where won IS NULL.
 *
 * Called from the outcome reconciler after writing settlement so that
 * exchange-discovered rows (which are not in the analytics in-memory store)
 * also receive the win/loss outcome immediately.  Fire-and-forget; never throws.
 */
export async function markWonForSettledTicker(
  ticker: string,
  result: "yes" | "no",
): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db.execute(sql`
      UPDATE order_attempts
         SET won        = (side = ${result}),
             updated_at = NOW()
       WHERE ticker  = ${ticker}
         AND won     IS NULL
         AND outcome IN ('full_fill', 'partial_fill', 'filled', 'partially_filled')
    `);
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, ticker, result }, "tradeStore: markWonForSettledTicker failed");
  }
}

export interface InsertDiscoveredResult {
  attemptId:      string;
  alreadyExisted: boolean;
}

/**
 * Returns the count of filled bot-series attempts for `easternDate` that are
 * missing durable fill chunks in `order_fills` OR have an unknown settlement
 * outcome (`won IS NULL`).
 *
 * A count of zero means the date has full reconciliation coverage and may be
 * durably watermarked.
 *
 * FAIL-CLOSED: returns `Number.MAX_SAFE_INTEGER` when storage is unavailable
 * or the query fails so the sweep never falsely marks a date complete when it
 * cannot verify the DB state.
 */
export async function countIncompleteFillsForDate(easternDate: string): Promise<number> {
  if (!_db || !_healthy) {
    logger.warn({ easternDate }, "tradeStore: countIncompleteFillsForDate — storage unavailable, returning MAX to fail closed");
    return Number.MAX_SAFE_INTEGER;
  }
  try {
    const includeSynthetic = process.env["TRADE_STORE_INCLUDE_SYNTHETIC_FOR_TESTS"] === "true";
    const rows = await _db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n
      FROM   order_attempts oa
      WHERE  oa.eastern_date = ${easternDate}
        AND  (${includeSynthetic} OR oa.is_synthetic = false)
        AND  oa.series IN ('KXBTC15M', 'KXETH15M')
        AND  oa.outcome = 'filled'
        AND (
          NOT EXISTS (SELECT 1 FROM order_fills f WHERE f.order_id = oa.order_id)
          OR oa.won IS NULL
        )
    `);
    return parseInt(rows.rows[0]?.n ?? "0", 10);
  } catch (err) {
    logger.warn({ err, easternDate }, "tradeStore: countIncompleteFillsForDate failed — returning MAX to fail closed");
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Create a synthetic order_attempts row for an exchange-discovered fill whose
 * local record was never written (e.g. because storage was degraded when the
 * order was placed). Safe to call multiple times for the same Kalshi order —
 * an existing order_id check + onConflictDoNothing together make it idempotent.
 *
 * After inserting, checks market_results so `won` is set immediately for
 * already-settled markets without waiting for the live settlement path.
 *
 * Returns null when storage is unavailable; returns { alreadyExisted: true }
 * when a row for this Kalshi order_id already exists.
 */
export async function insertDiscoveredOrderAttempt(
  params: DiscoveredOrderAttemptParams,
): Promise<InsertDiscoveredResult | null> {
  if (!_db || !_healthy) return null;

  try {
    // Idempotency check: return the first existing attempt that tracks this order.
    const existing = await _db
      .select({ id: orderAttempts.id })
      .from(orderAttempts)
      .where(eq(orderAttempts.orderId, params.kalshiOrderId))
      .limit(1);

    if (existing.length > 0) {
      return { attemptId: existing[0]!.id, alreadyExisted: true };
    }

    // Stable synthetic id — deterministic so concurrent sweeps collide on
    // onConflictDoNothing instead of creating duplicate rows.
    const syntheticId = `disc-${params.kalshiOrderId}`;
    const now         = new Date();

    await _db.insert(orderAttempts).values({
      id:            syntheticId,
      clientOrderId: syntheticId,
      timestampMs:   params.fillTimestampMs,
      easternDate:   params.easternDate,
      ticker:        params.ticker,
      series:        params.series,
      side:          params.side,
      source:        "exchange_discovery",
      outcome:       "filled",
      orderId:       params.kalshiOrderId,
      reconciled:    false,
      // Test runners use an explicit persisted marker, so even a crashed
      // discovery test cannot be mistaken for a live exchange recovery row.
      isSynthetic:   process.env["TRADE_STORE_TEST_FIXTURES"] === "true",
      fixtureNamespace: process.env["TRADE_STORE_TEST_FIXTURES"] === "true"
        ? "test-fixture"
        : null,
      updatedAt:     now,
    }).onConflictDoNothing();

    // If the market has already settled, set won immediately so the daily P&L
    // query can include this fill without waiting for the live settlement path.
    const settled = await _db
      .select({ result: marketResults.result })
      .from(marketResults)
      .where(eq(marketResults.ticker, params.ticker))
      .limit(1);

    if (settled.length > 0) {
      const result = settled[0]!.result;
      if (result === "yes" || result === "no") {
        const won = params.side === result;
        await _db
          .update(orderAttempts)
          .set({ won, updatedAt: now })
          .where(eq(orderAttempts.orderId, params.kalshiOrderId));
      }
    }

    _lastWriteMs = Date.now();
    logger.info(
      { kalshiOrderId: params.kalshiOrderId, ticker: params.ticker, side: params.side, syntheticId },
      "tradeStore: insertDiscoveredOrderAttempt — synthetic row created",
    );
    return { attemptId: syntheticId, alreadyExisted: false };
  } catch (err) {
    logger.warn({ err, kalshiOrderId: params.kalshiOrderId }, "tradeStore: insertDiscoveredOrderAttempt failed");
    return null;
  }
}

/**
 * Returns the set of Eastern dates (YYYY-MM-DD) that have already been fully
 * processed by the exchange-history discovery sweep.  Used by startup to skip
 * already-swept dates and avoid re-scanning the full exchange history.
 */
export async function loadSweptDates(): Promise<Set<string>> {
  if (!_db || !_healthy) return new Set();
  try {
    const rows = await _db.select({ easternDate: exchangeSweepLog.easternDate }).from(exchangeSweepLog);
    return new Set(rows.map((r) => r.easternDate));
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadSweptDates failed");
    return new Set();
  }
}

export interface IncompleteFillAttempt {
  attemptId: string;
  orderId:   string;
  side:      string;
  ticker:    string;
}

/**
 * Returns filled bot-series order attempts for `easternDate` that are missing
 * durable fill evidence in `order_fills` (or have `reconcile_failed = true`).
 * Used by the discovery sweep to retry reconciliation for orders that were
 * inserted in a prior pass but whose fill-chunk write subsequently failed.
 *
 * Empty list is returned on storage degradation (fail-open, non-fatal).
 */
export async function loadIncompleteFilledAttempts(easternDate: string): Promise<IncompleteFillAttempt[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.execute<{
      attempt_id: string; order_id: string; side: string; ticker: string;
    }>(sql`
      SELECT oa.id AS attempt_id, oa.order_id, oa.side, oa.ticker
      FROM   order_attempts oa
      WHERE  oa.eastern_date = ${easternDate}
        AND  oa.series IN ('KXBTC15M', 'KXETH15M')
        AND  oa.outcome = 'filled'
        AND  oa.order_id IS NOT NULL
        AND (
          oa.reconcile_failed = true
          OR NOT EXISTS (
            SELECT 1 FROM order_fills f WHERE f.order_id = oa.order_id
          )
          OR oa.won IS NULL   -- market was open at fill time but may have since settled
        )
    `);
    return rows.rows.map((r) => ({
      attemptId: r.attempt_id,
      orderId:   r.order_id,
      side:      r.side,
      ticker:    r.ticker,
    }));
  } catch (err) {
    logger.warn({ err, easternDate }, "tradeStore: loadIncompleteFilledAttempts failed");
    return [];
  }
}

// ── Evaluation-events retention ───────────────────────────────────────────────

/** Default retention window for evaluation_events rows (30 days). */
const EVAL_EVENTS_RETENTION_DAYS_DEFAULT = 30;

/** Default retention window for coverage_incidents rows (30 days). */
const COVERAGE_INCIDENTS_RETENTION_DAYS_DEFAULT = 30;

/**
 * Delete evaluation_events rows older than `retentionDays` days.
 *
 * Safe to call repeatedly — idempotent DELETE.  Returns the number of rows
 * pruned, or -1 if storage is unavailable (non-fatal, will retry next run).
 *
 * Intended callers:
 *   • initTradeStore() startup sweep — clears any backlog on restart.
 *   • reportScheduler daily poll — keeps the table bounded over time.
 */
export async function pruneEvaluationEvents(
  retentionDays: number = EVAL_EVENTS_RETENTION_DAYS_DEFAULT,
): Promise<number> {
  if (!_db || !_healthy) {
    logger.warn(
      { retentionDays },
      "tradeStore: pruneEvaluationEvents skipped — storage unavailable",
    );
    return -1;
  }
  try {
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    const result = await _db.execute(sql`
      DELETE FROM evaluation_events
      WHERE  timestamp_ms < ${cutoffMs}
    `);
    const pruned = (result as { rowCount?: number }).rowCount ?? 0;
    logger.info(
      { retentionDays, cutoffMs, pruned },
      "tradeStore: pruneEvaluationEvents complete",
    );
    return pruned;
  } catch (err) {
    logger.warn({ err, retentionDays }, "tradeStore: pruneEvaluationEvents failed — will retry next run");
    return -1;
  }
}

// ── Coverage-incidents retention ──────────────────────────────────────────────

/**
 * Delete coverage_incidents rows older than `retentionDays` days.
 *
 * Safe to call repeatedly — idempotent DELETE.  Returns the number of rows
 * pruned, or -1 if storage is unavailable (non-fatal, will retry next run).
 *
 * Intended callers:
 *   • initTradeStore() startup sweep (Step 7) — clears any backlog on restart.
 *   • reportScheduler daily poll — keeps the table bounded between restarts.
 */
export async function pruneCoverageIncidents(
  retentionDays: number = COVERAGE_INCIDENTS_RETENTION_DAYS_DEFAULT,
): Promise<number> {
  if (!_db || !_healthy) {
    logger.warn(
      { retentionDays },
      "tradeStore: pruneCoverageIncidents skipped — storage unavailable",
    );
    return -1;
  }
  try {
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    const result = await _db.execute(sql`
      DELETE FROM coverage_incidents
      WHERE  detected_at_ms < ${cutoffMs}
    `);
    const pruned = (result as { rowCount?: number }).rowCount ?? 0;
    logger.info(
      { retentionDays, cutoffMs, pruned },
      "tradeStore: pruneCoverageIncidents complete",
    );
    return pruned;
  } catch (err) {
    logger.warn({ err, retentionDays }, "tradeStore: pruneCoverageIncidents failed — will retry next run");
    return -1;
  }
}

/** SQL-primary watchdog poll history. It is telemetry-only and cannot affect trading. */
export function recordRuntimeWatchdogPollToSql(result: { polledAt: string }): void {
  if (!_db || !_healthy) return;
  const polledAtMs = Date.parse(result.polledAt);
  if (!Number.isFinite(polledAtMs)) return;
  const id = `rwh:${polledAtMs}`;
  void _db.execute(sql`
    INSERT INTO runtime_watchdog_history (id, polled_at_ms, payload)
    VALUES (${id}, ${polledAtMs}, ${JSON.stringify(result)})
    ON CONFLICT (id) DO NOTHING
  `).catch((err) => logger.warn({ err }, "tradeStore: runtime watchdog history write failed"));
}

/** Read SQL-primary watchdog history for the authenticated observability API. */
export async function loadRuntimeWatchdogHistoryFromSql(limit = 250): Promise<unknown[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.execute<{ payload: string }>(sql`
      SELECT payload FROM runtime_watchdog_history ORDER BY polled_at_ms DESC LIMIT ${Math.max(1, Math.min(1000, limit))}
    `);
    return rows.rows.flatMap((row) => { try { return [JSON.parse(row.payload)]; } catch { return []; } });
  } catch (err) {
    logger.warn({ err }, "tradeStore: runtime watchdog history read failed");
    return [];
  }
}

type RuntimeLifecycleInput = {
  runId: string; eventType: "started" | "shutdown" | "recovered";
  occurredAtMs: number; pid: number; environment: string; reason?: string;
};
type RuntimeHeartbeatInput = {
  runId: string; occurredAtMs: number; pid: number; environment: string;
  components: Record<string, boolean>;
};

function easternTimestamp(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", dateStyle: "short", timeStyle: "medium", hour12: false,
  }).format(new Date(ms));
}

/** Records a start/recovery event and turns a prior >2 minute silence into an explicit offline interval. */
export async function beginRuntimeRun(input: Omit<RuntimeLifecycleInput, "eventType">): Promise<void> {
  if (!_db || !_healthy) throw new Error("runtime lifecycle storage unavailable");
  const prior = await _db.execute<{ run_id: string; occurred_at_ms: number }>(sql`
    SELECT run_id, occurred_at_ms FROM runtime_heartbeats ORDER BY occurred_at_ms DESC LIMIT 1
  `);
  const previous = prior.rows[0];
  if (previous && input.occurredAtMs - Number(previous.occurred_at_ms) > 120_000) {
    const id = `runtime-offline:${Number(previous.occurred_at_ms)}:${input.occurredAtMs}`;
    await _db.execute(sql`
      INSERT INTO runtime_offline_periods
        (id, detected_at_ms, started_at_ms, ended_at_ms, duration_ms, state, prior_run_id, recovered_by_run_id)
      VALUES (${id}, ${input.occurredAtMs}, ${Number(previous.occurred_at_ms)}, ${input.occurredAtMs},
        ${input.occurredAtMs - Number(previous.occurred_at_ms)}, 'MISSING / SYSTEM OFFLINE',
        ${previous.run_id}, ${input.runId})
      ON CONFLICT (id) DO NOTHING
    `);
    await recordRuntimeLifecycleEvent({ ...input, eventType: "recovered", reason: "heartbeat_gap_detected" });
  }
  await recordRuntimeLifecycleEvent({ ...input, eventType: "started", reason: "process_started" });
}

/** Durable lifecycle evidence; never contains credentials or market data. */
export async function recordRuntimeLifecycleEvent(input: RuntimeLifecycleInput): Promise<void> {
  if (!_db || !_healthy) throw new Error("runtime lifecycle storage unavailable");
  const id = `runtime-lifecycle:${input.runId}:${input.eventType}:${input.occurredAtMs}`;
  await _db.execute(sql`
    INSERT INTO runtime_lifecycle_events
      (id, run_id, event_type, occurred_at_ms, occurred_at_utc, occurred_at_et, pid, environment, reason)
    VALUES (${id}, ${input.runId}, ${input.eventType}, ${input.occurredAtMs},
      ${new Date(input.occurredAtMs).toISOString()}, ${easternTimestamp(input.occurredAtMs)},
      ${input.pid}, ${input.environment}, ${input.reason ?? null})
    ON CONFLICT (id) DO NOTHING
  `);
}

/** A successful write is the only signal accepted by the new-entry heartbeat gate. */
export async function recordRuntimeHeartbeat(input: RuntimeHeartbeatInput): Promise<void> {
  if (!_db || !_healthy) throw new Error("runtime heartbeat storage unavailable");
  const id = `runtime-heartbeat:${input.runId}:${input.occurredAtMs}`;
  await _db.execute(sql`
    INSERT INTO runtime_heartbeats
      (id, run_id, occurred_at_ms, occurred_at_utc, occurred_at_et, pid, environment, components)
    VALUES (${id}, ${input.runId}, ${input.occurredAtMs}, ${new Date(input.occurredAtMs).toISOString()},
      ${easternTimestamp(input.occurredAtMs)}, ${input.pid}, ${input.environment}, ${JSON.stringify(input.components)})
    ON CONFLICT (id) DO NOTHING
  `);
}

/** Bounded SQL-first operational proof for the authenticated runtime endpoint. */
export async function loadRuntimeLifecycleEvidence(limit = 250): Promise<{ lifecycle: unknown[]; heartbeats: unknown[]; offlinePeriods: unknown[] }> {
  if (!_db || !_healthy) return { lifecycle: [], heartbeats: [], offlinePeriods: [] };
  const safeLimit = Math.max(1, Math.min(1_000, limit));
  try {
    const [lifecycle, heartbeats, offlinePeriods] = await Promise.all([
      _db.execute(sql`SELECT * FROM runtime_lifecycle_events ORDER BY occurred_at_ms DESC LIMIT ${safeLimit}`),
      _db.execute(sql`SELECT * FROM runtime_heartbeats ORDER BY occurred_at_ms DESC LIMIT ${safeLimit}`),
      _db.execute(sql`SELECT * FROM runtime_offline_periods ORDER BY started_at_ms DESC LIMIT ${safeLimit}`),
    ]);
    return { lifecycle: lifecycle.rows, heartbeats: heartbeats.rows, offlinePeriods: offlinePeriods.rows };
  } catch (err) {
    logger.warn({ err }, "tradeStore: runtime lifecycle evidence read failed");
    return { lifecycle: [], heartbeats: [], offlinePeriods: [] };
  }
}

// ── Coverage incidents SQL persistence ────────────────────────────────────────

/**
 * Persist a CoverageIncident to SQL. Fire-and-forget with durable-write
 * buffer replay on DB failure. Uses upsert (last-state-wins) semantics:
 * each state transition for the same incidentId overwrites the prior row.
 *
 * Called via the hook injected into marketDataCoverage.ts at startup.
 */
export function recordCoverageIncidentToSql(incident: CoverageIncident): void {
  const key = `ci:${incident.incidentId}`;
  _fireDurableWrite(key, { kind: "coverage_incident", incident }, "recordCoverageIncidentToSql");
}

/** Persist the latest state of a permanent ticker/window coverage audit. */
export function recordCoverageWindowAuditToSql(audit: CoverageWindowAudit): void {
  _fireDurableWrite(
    `cwa:${audit.auditId}`,
    { kind: "coverage_window_audit", audit },
    "recordCoverageWindowAuditToSql",
  );
}

/** Load permanent final-window data-health audits, newest window first. */
export async function loadRecentCoverageWindowAuditsFromSql(
  limitMs = 7 * 86_400_000,
): Promise<CoverageWindowAudit[]> {
  if (!_db || !_healthy) return [];
  try {
    const cutoff = limitMs > 0 ? Date.now() - limitMs : 0;
    const rows = await _db
      .select()
      .from(coverageWindowAudits)
      .where(cutoff > 0 ? gte(coverageWindowAudits.discoveredAtMs, cutoff) : sql`TRUE`)
      .orderBy(desc(coverageWindowAudits.closeTime));
    const parse = <T>(value: string, fallback: T): T => {
      try { return JSON.parse(value) as T; } catch { return fallback; }
    };
    return rows.map((r) => ({
      auditId: r.auditId, ticker: r.ticker, series: r.series, closeTime: r.closeTime,
      discoveredAtMs: r.discoveredAtMs, eligibleStartMs: r.eligibleStartMs,
      finalWindowStartedAtMs: r.finalWindowStartedAtMs ?? null,
      finalWindowClosedAtMs: r.finalWindowClosedAtMs ?? null,
      firstUsableQuoteMs: r.firstUsableQuoteMs ?? null, lastUsableQuoteMs: r.lastUsableQuoteMs ?? null,
      firstEvaluationMs: r.firstEvaluationMs ?? null, lastEvaluationMs: r.lastEvaluationMs ?? null,
      finalWindowUsableQuotes: r.finalWindowUsableQuotes,
      finalWindowEvaluations: r.finalWindowEvaluations,
      status: r.status as CoverageWindowAudit["status"],
      incidentId: r.incidentId ?? null,
      transitions: parse(r.transitions, []),
      recoveryAttempts: parse(r.recoveryAttempts, []),
       evidenceCompleteness: (r.evidenceCompleteness === "restart_continuity_unknown" ? "restart_continuity_unknown" : "complete"),
       restartEvidenceUncertain: r.restartEvidenceUncertain === true,
    }));
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadRecentCoverageWindowAuditsFromSql failed");
    return [];
  }
}

/** Startup-only bounded query: permanent sealed history is never hydrated. */
export async function loadUnfinishedCoverageWindowAuditsFromSql(): Promise<CoverageWindowAudit[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(coverageWindowAudits)
      .where(eq(coverageWindowAudits.status, "OBSERVING"))
      .orderBy(desc(coverageWindowAudits.closeTime))
      .limit(32);
    const parse = <T>(value: string, fallback: T): T => {
      try { return JSON.parse(value) as T; } catch { return fallback; }
    };
    return rows.map((r) => ({
      auditId: r.auditId, ticker: r.ticker, series: r.series, closeTime: r.closeTime,
      discoveredAtMs: r.discoveredAtMs, eligibleStartMs: r.eligibleStartMs,
      finalWindowStartedAtMs: r.finalWindowStartedAtMs ?? null,
      finalWindowClosedAtMs: r.finalWindowClosedAtMs ?? null,
      firstUsableQuoteMs: r.firstUsableQuoteMs ?? null, lastUsableQuoteMs: r.lastUsableQuoteMs ?? null,
      firstEvaluationMs: r.firstEvaluationMs ?? null, lastEvaluationMs: r.lastEvaluationMs ?? null,
      finalWindowUsableQuotes: r.finalWindowUsableQuotes, finalWindowEvaluations: r.finalWindowEvaluations,
      status: "OBSERVING", incidentId: r.incidentId ?? null,
      transitions: parse(r.transitions, []), recoveryAttempts: parse(r.recoveryAttempts, []),
       evidenceCompleteness: (r.evidenceCompleteness === "restart_continuity_unknown" ? "restart_continuity_unknown" : "complete"),
       restartEvidenceUncertain: r.restartEvidenceUncertain === true,
    }));
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadUnfinishedCoverageWindowAuditsFromSql failed");
    return [];
  }
}

/** Backfill permanent audit NDJSON records into SQL after a restart/outage. */
export async function backfillCoverageWindowAuditsFromFiles(): Promise<void> {
  if (!_db || !_healthy) return;
  for (const audit of loadCoverageWindowAudits(0)) {
    try { await _sqlUpsertCoverageWindowAudit(audit); }
    catch (err) { logger.warn({ err, auditId: audit.auditId }, "tradeStore: coverage audit backfill failed"); }
  }
}

/**
 * Load recent coverage incidents from SQL.
 * Returns [] when storage is unavailable (callers fall back to NDJSON).
 *
 * @param limitMs Only return incidents from the last `limitMs` milliseconds
 *                (default 24 h). Pass 0 to load ALL stored incidents.
 */
export async function loadRecentCoverageIncidentsFromSql(
  limitMs = 24 * 60 * 60 * 1_000,
): Promise<CoverageIncident[]> {
  if (!_db || !_healthy) return [];
  try {
    const cutoff = limitMs > 0 ? Date.now() - limitMs : 0;
    const rows = await _db
      .select()
      .from(coverageIncidents)
      .where(cutoff > 0 ? gte(coverageIncidents.detectedAtMs, cutoff) : sql`TRUE`)
      .orderBy(desc(coverageIncidents.detectedAtMs));
    return rows.map((r) => ({
      incidentId:          r.incidentId,
      ticker:              r.ticker,
      series:              r.series,
      closeTime:           r.closeTime,
      detectedAtMs:        r.detectedAtMs,
      secondsLeftAtDetect: r.secondsLeftAtDetect,
      lastUsableQuoteMs:   r.lastUsableQuoteMs   ?? null,
      lastEvaluationMs:    r.lastEvaluationMs    ?? null,
      lastWsDataMsgMs:     r.lastWsDataMsgMs     ?? null,
      lastWsAnyMsgMs:      r.lastWsAnyMsgMs      ?? null,
      wsConnected:         r.wsConnected,
      recoveryAttempts:    (() => {
        try { return JSON.parse(r.recoveryAttempts) as CoverageIncident["recoveryAttempts"]; }
        catch { return []; }
      })(),
      status:              r.status as CoverageIncident["status"],
      recoveredAtMs:       r.recoveredAtMs ?? null,
    }));
  } catch (err) {
    logger.warn({ err }, "tradeStore: loadRecentCoverageIncidentsFromSql failed");
    return [];
  }
}

/**
 * One-time startup backfill: read all NDJSON coverage-incident files and
 * upsert into SQL so pre-deployment history survives a production redeploy.
 *
 * Always runs at startup (data volume is tiny — at most a handful of incidents
 * per day) and is idempotent via ON CONFLICT DO UPDATE.
 */
export async function backfillCoverageIncidentsFromFiles(dataDir?: string): Promise<void> {
  if (!_db || !_healthy) return;

  const base = dataDir ?? join(process.cwd(), "data", "analytics");
  let files: string[];
  try { files = readdirSync(base).filter((n) => n.startsWith("coverage-incidents-") && n.endsWith(".ndjson")); }
  catch { return; } // data dir does not exist yet — no incidents to backfill

  const byId = new Map<string, CoverageIncident>();
  for (const file of files) {
    let raw: string;
    try { raw = readFileSync(join(base, file), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const inc = JSON.parse(line) as CoverageIncident;
        if (inc && typeof inc.incidentId === "string") byId.set(inc.incidentId, inc);
      } catch { /* skip malformed */ }
    }
  }

  if (byId.size === 0) return;
  let upserted = 0;
  for (const incident of byId.values()) {
    try {
      await _sqlUpsertCoverageIncident(incident);
      upserted++;
    } catch (err) {
      logger.warn({ err, incidentId: incident.incidentId }, "tradeStore: backfillCoverageIncidentsFromFiles — upsert failed for one incident");
    }
  }
  logger.info({ upserted, total: byId.size }, "tradeStore: backfillCoverageIncidentsFromFiles complete");
}

// ── ETH_30_50 isolated strategy APIs ─────────────────────────────────────────
//
// These APIs are the only SQL integration point for the ETH_30_50 strategy.
// They are deliberately isolated from the legacy order_attempts / order_dedup
// ownership semantics: no existing table semantics are altered.
//
// Safety contract (consistent with the rest of this module):
//   • claimEth30Ticker  — fail closed: returns false when storage is degraded
//     or the ticker has already been claimed.
//   • recordEth30StrategyOrder / updateEth30StrategyOrder — fail closed: return
//     false on storage degradation or unexpected SQL error.
//   • appendEth30PositionEvent — fire-and-forget on storage degradation (returns
//     false, never throws).
//   • listEth30PositionEvents / getEth30TickerClaim / listEth30StrategyOrders
//     — return null/[] on storage degradation (callers must handle that).

export interface Eth2125ProspectiveRow {
  ticker: string; cohortStartMs: number; easternDate: string; observedAtMs: number;
  side: "yes" | "no"; entryPriceCents: number; contracts: number; entryCostCents: number;
  estimatedEntryFeeCents: number; firstTargetAtMs: number | null; firstTargetBidCents: number | null;
}

/** Passive research insert. Conflict means the ticker was already observed; no live state is touched. */
export async function insertEth2125ProspectiveRow(row: Eth2125ProspectiveRow): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    const inserted = await _db.insert(eth2125ProspectiveCohort).values({
      ...row, firstTargetAtMs: row.firstTargetAtMs ?? null, firstTargetBidCents: row.firstTargetBidCents ?? null,
      updatedAt: new Date(),
    }).onConflictDoNothing().returning({ ticker: eth2125ProspectiveCohort.ticker });
    if (inserted.length) _lastWriteMs = Date.now();
    return inserted.length > 0;
  } catch (err) {
    logger.warn({ err, ticker: row.ticker }, "eth2125 prospective insert failed (research row lost)");
    return false;
  }
}

/** Monotone passive target observation; never creates a row or affects live orders. */
export async function markEth2125ProspectiveTarget(
  ticker: string, targetAtMs: number, bidCents: number,
): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db.update(eth2125ProspectiveCohort)
      .set({ firstTargetAtMs: targetAtMs, firstTargetBidCents: bidCents, updatedAt: new Date() })
      .where(and(eq(eth2125ProspectiveCohort.ticker, ticker), isNull(eth2125ProspectiveCohort.firstTargetAtMs)));
  } catch (err) {
    logger.warn({ err, ticker }, "eth2125 prospective target update failed");
  }
}

export async function listEth2125ProspectiveRows(): Promise<Eth2125ProspectiveRow[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.select().from(eth2125ProspectiveCohort)
      .orderBy(asc(eth2125ProspectiveCohort.observedAtMs));
    return rows.map((r) => ({
      ticker: r.ticker, cohortStartMs: r.cohortStartMs, easternDate: r.easternDate, observedAtMs: r.observedAtMs,
      side: r.side as "yes" | "no", entryPriceCents: r.entryPriceCents, contracts: r.contracts,
      entryCostCents: r.entryCostCents, estimatedEntryFeeCents: r.estimatedEntryFeeCents,
      firstTargetAtMs: r.firstTargetAtMs ?? null, firstTargetBidCents: r.firstTargetBidCents ?? null,
    }));
  } catch (err) {
    logger.warn({ err }, "eth2125 prospective list failed");
    return [];
  }
}

export async function listMarketResultsForTickers(tickers: string[]): Promise<Map<string, "yes" | "no">> {
  if (!_db || !_healthy || tickers.length === 0) return new Map();
  try {
    const rows = await _db.select({ ticker: marketResults.ticker, result: marketResults.result })
      .from(marketResults).where(inArray(marketResults.ticker, tickers));
    return new Map(rows.filter((r) => r.result === "yes" || r.result === "no")
      .map((r) => [r.ticker, r.result as "yes" | "no"]));
  } catch (err) {
    logger.warn({ err }, "eth2125 prospective settlement lookup failed");
    return new Map();
  }
}

export interface Eth30TickerClaim {
  ticker:             string;
  easternDate:        string;
  claimedAtMs:        number;
  entryClientOrderId: string;
}

export interface Eth30StrategyOrderParams {
  /** "entry:{ticker}" or "exit:{ticker}:{sequenceNumber}" — caller provides stable PK. */
  id:                 string;
  ticker:             string;
  easternDate:        string;
  /** "entry" | "exit" */
  role:               "entry" | "exit";
  sequenceNumber:     number;
  clientOrderId:      string;
  side:               "yes" | "no";
  limitPriceCents:    number;
  requestedContracts: number;
}

export interface Eth30StrategyOrder extends Eth30StrategyOrderParams {
  kalshiOrderId:         string | null;
  /** Epoch ms the row was created (null for rows predating this field's mapping). */
  createdAtMs?:          number | null;
  /** "pending" | "full_fill" | "partial_fill" | "zero_fill" | "cancelled" | "error" | "unresolved" (ambiguous submission — blocks exit replacements) */
  outcome:               string;
  filledContracts:       number | null;
  averageFillPriceCents: number | null;
  updatedAtMs:           number;
}

export interface Eth30PositionEventParams {
  /** "${ticker}:${eventType}:${occurredAtMs}" — natural PK provided by caller. */
  id:              string;
  ticker:          string;
  easternDate:     string;
  /** "entry_fill" | "exit_fill" | "settlement" | "correction" */
  eventType:       "entry_fill" | "exit_fill" | "settlement" | "correction";
  contractsDelta:  number;
  contractsAfter:  number;
  strategyOrderId: string | null;
  fillPriceCents:  number | null;
  /** Exchange fee for this fill chunk in cents (rounded). Null for legacy rows
   *  written before fee capture was added, and for settlement events. */
  feeCents:        number | null;
  settlementResult: "yes" | "no" | null;
  note:            string | null;
  occurredAtMs:    number;
}

/**
 * Atomically claim a ticker for the ETH_30_50 strategy.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING so the operation is idempotent and
 * race-safe: exactly one caller wins the claim even under concurrent writers.
 *
 * Returns true if the claim was inserted (caller may proceed to place the entry
 * order), or false if the ticker was already claimed or storage is degraded.
 *
 * FAIL CLOSED: returns false on any storage error — never throws.
 */
export async function claimEth30Ticker(
  ticker:             string,
  easternDate:        string,
  entryClientOrderId: string,
): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ ticker }, "eth30: claimEth30Ticker — storage degraded, returning false (fail closed)");
    return false;
  }
  const now = Date.now();
  try {
    const inserted = await _db
      .insert(eth30TickerClaims)
      .values({ ticker, easternDate, claimedAtMs: now, entryClientOrderId })
      .onConflictDoNothing()
      .returning({ ticker: eth30TickerClaims.ticker });
    const claimed = inserted.length > 0;
    if (!claimed) {
      logger.warn({ ticker }, "eth30: claimEth30Ticker — ticker already claimed (conflict)");
    } else {
      _lastWriteMs = Date.now();
      logger.info({ ticker, easternDate, entryClientOrderId }, "eth30: claimEth30Ticker — ticker claimed successfully");
    }
    return claimed;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `eth30.claimEth30Ticker failed: ${_lastErrorMsg}`;
    logger.error({ err, ticker }, "eth30: claimEth30Ticker FAILED — storage degraded, scheduling reconnect");
    recordDbBlockedOperation("entry");
    _scheduleRetry();
    return false;
  }
}

/** Atomically reserve a paired market claim and both entry child orders.
 * No exchange POST is permitted until this returns true. */
export async function reserveEth30PairedEntry(params: {
  ticker: string; easternDate: string; entryClientOrderId: string;
  orders: readonly [Eth30StrategyOrderParams, Eth30StrategyOrderParams];
}): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  try {
    return await _db.transaction(async (tx) => {
      const claim = await tx.insert(eth30TickerClaims)
        .values({ ticker: params.ticker, easternDate: params.easternDate, claimedAtMs: now, entryClientOrderId: params.entryClientOrderId })
        .onConflictDoNothing().returning({ ticker: eth30TickerClaims.ticker });
      if (claim.length !== 1) return false;
      const inserted = await tx.insert(eth30StrategyOrders).values(params.orders.map((order) => ({
        ...order, kalshiOrderId: null, outcome: "pending", filledContracts: null,
        averageFillPriceCents: null, updatedAtMs: now,
      }))).onConflictDoNothing().returning({ id: eth30StrategyOrders.id });
      if (inserted.length !== 2) throw new Error("ETH30_PAIR_RESERVATION_INCOMPLETE");
      _lastWriteMs = Date.now();
      return true;
    });
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err);
    _degradedReason = `eth30.reserveEth30PairedEntry failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("entry"); _scheduleRetry();
    logger.error({ err, ticker: params.ticker }, "eth30: paired reservation failed closed");
    return false;
  }
}

/**
 * Read an existing ETH_30_50 ticker claim, or null if not found / storage degraded.
 */
export async function getEth30TickerClaim(ticker: string): Promise<Eth30TickerClaim | null> {
  if (!_db || !_healthy) return null;
  try {
    const rows = await _db
      .select()
      .from(eth30TickerClaims)
      .where(eq(eth30TickerClaims.ticker, ticker))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    };
  } catch (err) {
    logger.warn({ err, ticker }, "eth30: getEth30TickerClaim failed");
    return null;
  }
}

/**
 * List all ETH_30_50 ticker claims for a given Eastern date, newest first.
 * Returns [] when storage is degraded or no rows exist.
 */
export async function listEth30TickerClaimsForDate(easternDate: string): Promise<Eth30TickerClaim[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30TickerClaims)
      .where(eq(eth30TickerClaims.easternDate, easternDate))
      .orderBy(desc(eth30TickerClaims.claimedAtMs));
    return rows.map((r) => ({
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    }));
  } catch (err) {
    logger.warn({ err, easternDate }, "eth30: listEth30TickerClaimsForDate failed");
    return [];
  }
}

/**
 * List all ETH_30_50 ticker claims for a set of Eastern dates, newest first.
 * Use this when reconciling across a day boundary (e.g., today + yesterday).
 * Returns [] when storage is degraded, dates is empty, or no rows exist.
 */
export async function listEth30TickerClaimsForDates(dates: string[]): Promise<Eth30TickerClaim[]> {
  if (!_db || !_healthy || dates.length === 0) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30TickerClaims)
      .where(inArray(eth30TickerClaims.easternDate, dates))
      .orderBy(desc(eth30TickerClaims.claimedAtMs));
    return rows.map((r) => ({
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    }));
  } catch (err) {
    logger.warn({ err, dates }, "eth30: listEth30TickerClaimsForDates failed");
    return [];
  }
}

/**
 * Insert an ETH_30_50 strategy order record (entry or exit).
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency on retry.
 * Returns true on successful insert, false if row already exists or storage
 * is degraded. FAIL CLOSED — never throws.
 */
export async function recordEth30StrategyOrder(params: Eth30StrategyOrderParams): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ id: params.id }, "eth30: recordEth30StrategyOrder — storage degraded, returning false");
    return false;
  }
  const now = Date.now();
  try {
    const inserted = await _db
      .insert(eth30StrategyOrders)
      .values({
        id:                 params.id,
        ticker:             params.ticker,
        easternDate:        params.easternDate,
        role:               params.role,
        sequenceNumber:     params.sequenceNumber,
        clientOrderId:      params.clientOrderId,
        kalshiOrderId:      null,
        side:               params.side,
        limitPriceCents:    params.limitPriceCents,
        requestedContracts: params.requestedContracts,
        outcome:            "pending",
        filledContracts:    null,
        averageFillPriceCents: null,
        updatedAtMs:        now,
      })
      .onConflictDoNothing()
      .returning({ id: eth30StrategyOrders.id });
    const ok = inserted.length > 0;
    if (ok) {
      _lastWriteMs = Date.now();
      logger.info({ id: params.id, ticker: params.ticker, role: params.role }, "eth30: recordEth30StrategyOrder — order recorded");
    }
    return ok;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `eth30.recordEth30StrategyOrder failed: ${_lastErrorMsg}`;
    logger.error({ err, id: params.id }, "eth30: recordEth30StrategyOrder FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

export interface Eth30StrategyOrderUpdate {
  /** The eth30_strategy_orders.id PK to update. */
  id:                    string;
  kalshiOrderId?:        string | null;
  outcome?:              string;
  filledContracts?:      number | null;
  averageFillPriceCents?: number | null;
}

/**
 * Update fill/outcome fields on an existing ETH_30_50 strategy order row.
 *
 * Idempotent: only the supplied fields are written; unspecified fields retain
 * their current values (partial update via explicit SET).
 * Returns true on success, false on storage degradation or row not found.
 * FAIL CLOSED — never throws.
 */
export async function updateEth30StrategyOrder(update: Eth30StrategyOrderUpdate): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ id: update.id }, "eth30: updateEth30StrategyOrder — storage degraded, returning false");
    return false;
  }
  const now = Date.now();
  const patch: Record<string, unknown> = { updatedAtMs: now, updatedAt: new Date() };
  if (update.kalshiOrderId !== undefined)        patch["kalshiOrderId"]         = update.kalshiOrderId;
  // Exchange fill evidence is monotone. A stale cancellation/settlement write
  // must never erase a quantity already confirmed by Kalshi, nor downgrade a
  // fully filled order back to "cancelled". Keep this invariant in SQL rather
  // than relying on callers' stale in-memory snapshots.
  const existingFilled = sql<number>`COALESCE(${eth30StrategyOrders.filledContracts}, 0)`;
  const safeRequested = eth30StrategyOrders.requestedContracts;
  const monotoneFilled = update.filledContracts === undefined
    ? existingFilled
    : sql<number>`LEAST(${safeRequested}, GREATEST(${existingFilled}, ${Math.max(0, Math.trunc(update.filledContracts ?? 0))}))`;
  if (update.filledContracts !== undefined) patch["filledContracts"] = monotoneFilled;
  if (update.outcome !== undefined || update.filledContracts !== undefined) {
    patch["outcome"] = sql<string>`CASE
      WHEN ${monotoneFilled} >= ${safeRequested} THEN 'full_fill'
      ELSE ${update.outcome ?? eth30StrategyOrders.outcome}
    END`;
  }
  // A stale terminal observation frequently carries null economics. Preserve a
  // previously known price in that case; an authoritative non-null update may
  // still replace an earlier approximation.
  if (update.averageFillPriceCents != null) patch["averageFillPriceCents"] = update.averageFillPriceCents;

  try {
    // Build the concrete set object with only the specified fields.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await _db
      .update(eth30StrategyOrders)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set(patch as any)
      .where(eq(eth30StrategyOrders.id, update.id))
      .returning({ id: eth30StrategyOrders.id });
    const ok = result.length > 0;
    if (ok) {
      _lastWriteMs = Date.now();
      logger.info({ id: update.id, outcome: update.outcome }, "eth30: updateEth30StrategyOrder — order updated");
    } else {
      logger.warn({ id: update.id }, "eth30: updateEth30StrategyOrder — row not found");
    }
    return ok;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `eth30.updateEth30StrategyOrder failed: ${_lastErrorMsg}`;
    logger.error({ err, id: update.id }, "eth30: updateEth30StrategyOrder FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

/**
 * List ETH_30_50 strategy orders for a given ticker, ordered by sequence_number ASC.
 * Returns [] when storage is degraded or no rows exist.
 */
export async function listEth30StrategyOrders(ticker: string): Promise<Eth30StrategyOrder[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30StrategyOrders)
      .where(eq(eth30StrategyOrders.ticker, ticker))
      .orderBy(asc(eth30StrategyOrders.sequenceNumber));
    return rows.map((r) => ({
      id:                    r.id,
      ticker:                r.ticker,
      easternDate:           r.easternDate,
      role:                  r.role as "entry" | "exit",
      sequenceNumber:        r.sequenceNumber,
      clientOrderId:         r.clientOrderId,
      kalshiOrderId:         r.kalshiOrderId ?? null,
      side:                  r.side as "yes" | "no",
      limitPriceCents:       r.limitPriceCents,
      requestedContracts:    r.requestedContracts,
      outcome:               r.outcome,
      filledContracts:       r.filledContracts ?? null,
      averageFillPriceCents: r.averageFillPriceCents ?? null,
      updatedAtMs:           r.updatedAtMs,
      createdAtMs:           r.createdAt ? r.createdAt.getTime() : null,
    }));
  } catch (err) {
    logger.warn({ err, ticker }, "eth30: listEth30StrategyOrders failed");
    return [];
  }
}

/**
 * Append an immutable position event to the ETH_30_50 position event ledger.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency on replayed writes.
 * Returns true on success, false on storage degradation. Fire-and-forget safe
 * (callers may not need to await — a missed event is an audit gap, not a
 * trading-path failure). FAIL CLOSED — never throws.
 */
export async function appendEth30PositionEvent(params: Eth30PositionEventParams): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ ticker: params.ticker, eventType: params.eventType }, "eth30: appendEth30PositionEvent — storage degraded, event lost");
    return false;
  }
  try {
    await _db
      .insert(eth30PositionEvents)
      .values({
        id:               params.id,
        ticker:           params.ticker,
        easternDate:      params.easternDate,
        eventType:        params.eventType,
        contractsDelta:   params.contractsDelta,
        contractsAfter:   params.contractsAfter,
        strategyOrderId:  params.strategyOrderId ?? null,
        fillPriceCents:   params.fillPriceCents ?? null,
        feeCents:         params.feeCents ?? null,
        settlementResult: params.settlementResult ?? null,
        note:             params.note ?? null,
        occurredAtMs:     params.occurredAtMs,
      })
      // On conflict (same id), only update fee_cents when the stored value is
      // still NULL — this lets the canonical rebuild backfill exchange fees for
      // fill-chunk events that were written before the fee_cents column existed.
      // Every other field is intentionally left unchanged so replaying the same
      // canonical inputs remains a no-op.
      .onConflictDoUpdate({
        target: eth30PositionEvents.id,
        set: { feeCents: sql`EXCLUDED.fee_cents` },
        setWhere: sql`${eth30PositionEvents.feeCents} IS NULL`,
      });
    _lastWriteMs = Date.now();
    logger.info(
      { id: params.id, ticker: params.ticker, eventType: params.eventType, delta: params.contractsDelta },
      "eth30: appendEth30PositionEvent — event appended or fee updated",
    );
    return true;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `eth30.appendEth30PositionEvent failed: ${_lastErrorMsg}`;
    logger.error({ err, ticker: params.ticker }, "eth30: appendEth30PositionEvent FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

/**
 * Delete ETH_30_50 position events by exact id. Used ONLY by the canonical
 * fill-ledger rebuild: legacy approximate fill events (recorded from book or
 * limit prices before per-chunk exchange evidence existed) must be replaced
 * wholesale by authoritative chunk events — they are never blended.
 * Returns false when storage is degraded or the delete failed.
 */
export async function deleteEth30PositionEvents(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  if (!_db || !_healthy) {
    logger.warn({ ids }, "eth30: deleteEth30PositionEvents — storage degraded, skipped");
    return false;
  }
  try {
    await _db.delete(eth30PositionEvents).where(inArray(eth30PositionEvents.id, ids));
    _lastWriteMs = Date.now();
    logger.info({ ids }, "eth30: deleteEth30PositionEvents — legacy/stale fill events removed for canonical rebuild");
    return true;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `eth30.deleteEth30PositionEvents failed: ${_lastErrorMsg}`;
    logger.error({ err, ids }, "eth30: deleteEth30PositionEvents FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

/**
 * List ETH_30_50 position events for a given ticker, ordered by occurred_at_ms ASC
 * (chronological, suitable for replaying to recover current position).
 * Returns [] when storage is degraded or no rows exist for the ticker.
 */
export async function listEth30PositionEvents(ticker: string): Promise<Eth30PositionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30PositionEvents)
      .where(eq(eth30PositionEvents.ticker, ticker))
      .orderBy(asc(eth30PositionEvents.occurredAtMs));
    return rows.map((r) => ({
      id:               r.id,
      ticker:           r.ticker,
      easternDate:      r.easternDate,
      eventType:        r.eventType as Eth30PositionEventParams["eventType"],
      contractsDelta:   r.contractsDelta,
      contractsAfter:   r.contractsAfter,
      strategyOrderId:  r.strategyOrderId ?? null,
      fillPriceCents:   r.fillPriceCents ?? null,
      feeCents:         r.feeCents ?? null,
      settlementResult: (r.settlementResult === "yes" || r.settlementResult === "no")
        ? r.settlementResult
        : null,
      note:             r.note ?? null,
      occurredAtMs:     r.occurredAtMs,
    }));
  } catch (err) {
    logger.warn({ err, ticker }, "eth30: listEth30PositionEvents failed");
    return [];
  }
}

/**
 * List ETH_30_50 position events for an Eastern date, newest-event-first.
 * Useful for daily audit dashboards.
 * Returns [] when storage is degraded or no rows exist for the date.
 */
export async function listEth30PositionEventsForDate(easternDate: string): Promise<Eth30PositionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30PositionEvents)
      .where(eq(eth30PositionEvents.easternDate, easternDate))
      .orderBy(desc(eth30PositionEvents.occurredAtMs));
    return rows.map((r) => ({
      id:               r.id,
      ticker:           r.ticker,
      easternDate:      r.easternDate,
      eventType:        r.eventType as Eth30PositionEventParams["eventType"],
      contractsDelta:   r.contractsDelta,
      contractsAfter:   r.contractsAfter,
      strategyOrderId:  r.strategyOrderId ?? null,
      fillPriceCents:   r.fillPriceCents ?? null,
      feeCents:         r.feeCents ?? null,
      settlementResult: (r.settlementResult === "yes" || r.settlementResult === "no")
        ? r.settlementResult
        : null,
      note:             r.note ?? null,
      occurredAtMs:     r.occurredAtMs,
    }));
  } catch (err) {
    logger.warn({ err, easternDate }, "eth30: listEth30PositionEventsForDate failed");
    return [];
  }
}

// ── ETH_30_50 decision/skip evidence ledger ──────────────────────────────────

export interface Eth30DecisionEventParams {
  /** Natural PK provided by the caller; once-only events use a stable id. */
  id:           string;
  ticker:       string;
  easternDate:  string;
  /**
   * "gate_blocked" | "no_executable_candidate" | "claim_conflict" |
   * "entry_placed" | "entry_zero_fill" | "entry_error" | "target_first_executable"
   */
  decision:     string;
  side:         "yes" | "no" | null;
  priceCents:   number | null;
  contracts:    number | null;
  note:         string | null;
  occurredAtMs: number;
}

/**
 * Append an ETH_30_50 decision/skip evidence event. Audit-only ledger:
 * INSERT ... ON CONFLICT DO NOTHING (stable ids make once-only events, such as
 * target_first_executable, naturally idempotent). Returns true when the row was
 * newly inserted, false on conflict or storage degradation. Never throws.
 */
export async function appendEth30DecisionEvent(params: Eth30DecisionEventParams): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ ticker: params.ticker, decision: params.decision }, "eth30: appendEth30DecisionEvent — storage degraded, event lost");
    return false;
  }
  try {
    const inserted = await _db
      .insert(eth30DecisionEvents)
      .values({
        id:           params.id,
        ticker:       params.ticker,
        easternDate:  params.easternDate,
        decision:     params.decision,
        side:         params.side ?? null,
        priceCents:   params.priceCents ?? null,
        contracts:    params.contracts ?? null,
        note:         params.note ?? null,
        occurredAtMs: params.occurredAtMs,
      })
      .onConflictDoNothing()
      .returning({ id: eth30DecisionEvents.id });
    if (inserted.length > 0) _lastWriteMs = Date.now();
    return inserted.length > 0;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `eth30.appendEth30DecisionEvent failed: ${_lastErrorMsg}`;
    logger.error({ err, ticker: params.ticker }, "eth30: appendEth30DecisionEvent FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

function mapEth30DecisionRow(r: typeof eth30DecisionEvents.$inferSelect): Eth30DecisionEventParams {
  return {
    id:           r.id,
    ticker:       r.ticker,
    easternDate:  r.easternDate,
    decision:     r.decision,
    side:         r.side === "yes" || r.side === "no" ? r.side : null,
    priceCents:   r.priceCents ?? null,
    contracts:    r.contracts ?? null,
    note:         r.note ?? null,
    occurredAtMs: r.occurredAtMs,
  };
}

/** List ETH_30_50 decision events for a ticker, chronological. [] when degraded. */
export async function listEth30DecisionEvents(ticker: string): Promise<Eth30DecisionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30DecisionEvents)
      .where(eq(eth30DecisionEvents.ticker, ticker))
      .orderBy(asc(eth30DecisionEvents.occurredAtMs));
    return rows.map(mapEth30DecisionRow);
  } catch (err) {
    logger.warn({ err, ticker }, "eth30: listEth30DecisionEvents failed");
    return [];
  }
}

/** List recent ETH_30_50 decision events across all tickers, newest first. */
export async function listRecentEth30DecisionEvents(limit = 200): Promise<Eth30DecisionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30DecisionEvents)
      .orderBy(desc(eth30DecisionEvents.occurredAtMs))
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
    return rows.map(mapEth30DecisionRow);
  } catch (err) {
    logger.warn({ err }, "eth30: listRecentEth30DecisionEvents failed");
    return [];
  }
}

/** Passive ETH shadow telemetry; write failures are non-critical and never throw. */
export interface Eth30ShadowObservationParams {
  id: string; ticker: string; observedAtMs: number; payloadJson: string;
}

/** Append-only data only for the inactive ETH 420 candidate; never read by execution. */
export interface Eth420CandidateTelemetryParams {
  id: string; ticker: string; easternDate: string; observedAtMs: number;
  floorStrike: number | null; payloadJson: string;
}
export interface Eth420CandidateState {
  easternDate: string; side: "yes" | "no"; step: number;
  realizedPnlCents: number; lastBlockResetAtMs: number | null;
}

/** Distinguishes an absent daily row from storage unavailability for recovery. */
export async function readPersistedEth420CandidateState(easternDate: string): Promise<{
  available: boolean; state: Eth420CandidateState | null;
}> {
  if (!_db || !_healthy) return { available: false, state: null };
  try {
    const result = await _db.execute(sql`
      SELECT eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms
      FROM eth420_candidate_daily_state WHERE eastern_date=${easternDate}`);
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    if (!row) return { available: true, state: null };
    return { available: true, state: {
      easternDate: String(row["eastern_date"]), side: row["side"] === "yes" ? "yes" : "no",
      step: Math.max(0, Math.min(5, Number(row["martingale_step"]))),
      realizedPnlCents: Number(row["realized_pnl_cents"]),
      lastBlockResetAtMs: row["last_block_reset_at_ms"] == null ? null : Number(row["last_block_reset_at_ms"]),
    } };
  } catch (err) {
    logger.warn({ err }, "ETH 420 candidate state read failed");
    return { available: false, state: null };
  }
}

/** Returns a fresh independent candidate state when the ET date rolls over. */
export async function getEth420CandidateState(easternDate: string): Promise<Eth420CandidateState | null> {
  const persisted = await readPersistedEth420CandidateState(easternDate);
  if (!persisted.available) return null;
  return persisted.state ?? { easternDate, side: "no", step: 0, realizedPnlCents: 0, lastBlockResetAtMs: null };
}

/**
 * One-way additive migration from the pre-history singleton candidate state.
 * A date-keyed row wins: it may already include a newer candidate settlement
 * and must never be overwritten by legacy data.
 */
export async function migrateEth420LegacyStateToDailyState(strategyKey = ETH420_CANDIDATE_STATE_KEY): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    await _db.execute(sql`
      INSERT INTO eth420_candidate_daily_state
        (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
      SELECT eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms
      FROM eth420_candidate_state WHERE strategy_key=${strategyKey}
      ON CONFLICT (eastern_date) DO NOTHING`);
    return true;
  } catch (err) {
    logger.warn({ err }, "ETH 420 legacy candidate state migration failed");
    return false;
  }
}

/** Idempotently persists independent candidate state; it never touches live ETH state. */
export async function saveEth420CandidateState(state: Eth420CandidateState): Promise<boolean> {
  if (!_db || !_healthy) return false;
  if (!["yes", "no"].includes(state.side) || !Number.isFinite(state.step)
    || !Number.isFinite(state.realizedPnlCents)) return false;
  try {
    const now = Date.now();
    await _db.execute(sql`
      INSERT INTO eth420_candidate_daily_state
        (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
      VALUES (${state.easternDate}, ${state.side},
        ${Math.max(0, Math.min(5, Math.trunc(state.step)))}, ${Math.trunc(state.realizedPnlCents)},
        ${state.lastBlockResetAtMs}, ${now})
      ON CONFLICT (eastern_date) DO UPDATE SET side=EXCLUDED.side, martingale_step=EXCLUDED.martingale_step,
        realized_pnl_cents=EXCLUDED.realized_pnl_cents,
        last_block_reset_at_ms=EXCLUDED.last_block_reset_at_ms, updated_at_ms=EXCLUDED.updated_at_ms`);
    _lastWriteMs = now;
    return true;
  } catch (err) {
    logger.warn({ err }, "ETH 420 candidate state write failed");
    return false;
  }
}

export type Eth420CandidateStepResetResult =
  | { kind: "applied"; resetId: string; before: Eth420CandidateState; after: Eth420CandidateState }
  | { kind: "already_at_step_zero"; before: Eth420CandidateState; after: Eth420CandidateState }
  | { kind: "no_current_state" }
  | { kind: "unresolved_lifecycle" }
  | { kind: "storage_unavailable" };

/**
 * Operator-only recovery action for the live ETH 420 candidate.
 *
 * It shares the entry reservation lock so a reset cannot race a new candidate
 * claim. It changes only the recovery step; side, realized P&L, and the
 * blocked-reset marker are preserved exactly. Terminal rejected-insufficient-
 * balance rows are safe; every other lifecycle state fails closed.
 */
export async function resetEth420CandidateStepToZero(
  easternDate: string,
): Promise<Eth420CandidateStepResetResult> {
  if (!_db || !_healthy || !/^\d{4}-\d{2}-\d{2}$/.test(easternDate)) {
    return { kind: "storage_unavailable" };
  }
  try {
    return await _db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-candidate-entry:" + easternDate}))`);
      const stateResult = await tx.execute(sql`
        SELECT eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms
        FROM eth420_candidate_daily_state WHERE eastern_date=${easternDate} FOR UPDATE`);
      const stateRow = (stateResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!stateRow) return { kind: "no_current_state" } as const;

      const lifecycle = await tx.execute(sql`
        SELECT status FROM eth420_candidate_live_orders WHERE eastern_date=${easternDate} FOR UPDATE`);
      const lifecycleRows = (lifecycle as unknown as { rows: Array<Record<string, unknown>> }).rows;
      if (lifecycleRows.some((row) => row["status"] !== "settled" && row["status"] !== "rejected_insufficient_balance")) {
        return { kind: "unresolved_lifecycle" } as const;
      }

      const before: Eth420CandidateState = {
        easternDate: String(stateRow["eastern_date"]),
        side: stateRow["side"] === "yes" ? "yes" : "no",
        step: Math.max(0, Math.min(5, Number(stateRow["martingale_step"]))),
        realizedPnlCents: Number(stateRow["realized_pnl_cents"]),
        lastBlockResetAtMs: stateRow["last_block_reset_at_ms"] == null ? null : Number(stateRow["last_block_reset_at_ms"]),
      };
      const after: Eth420CandidateState = { ...before, step: 0 };
      if (before.step === 0) return { kind: "already_at_step_zero", before, after } as const;

      const resetId = `eth420-step-reset:${randomUUID()}`;
      const now = Date.now();
      await tx.execute(sql`
        UPDATE eth420_candidate_daily_state SET martingale_step=0, updated_at_ms=${now}
        WHERE eastern_date=${easternDate}`);
      await tx.execute(sql`
        INSERT INTO eth420_candidate_step_reset_audits (
          reset_id, eastern_date, reset_at_ms,
          prior_side, prior_step, prior_realized_pnl_cents, prior_last_block_reset_at_ms,
          next_side, next_step, next_realized_pnl_cents, next_last_block_reset_at_ms
        ) VALUES (
          ${resetId}, ${easternDate}, ${now},
          ${before.side}, ${before.step}, ${before.realizedPnlCents}, ${before.lastBlockResetAtMs},
          ${after.side}, ${after.step}, ${after.realizedPnlCents}, ${after.lastBlockResetAtMs}
        )`);
      _lastWriteMs = now;
      return { kind: "applied", resetId, before, after } as const;
    });
  } catch (err) {
    logger.warn({ err, easternDate }, "ETH 420 candidate step reset failed");
    return { kind: "storage_unavailable" };
  }
}

/** Applies a terminal candidate settlement once; duplicate recovery events are no-ops. */
export async function applyEth420CandidateConfirmedSettlement(params: {
  id: string; easternDate: string; nextState: Eth420CandidateState; realizedPnlDeltaCents: number;
}): Promise<boolean> {
  if (!_db || !_healthy || !params.id || !Number.isFinite(params.realizedPnlDeltaCents)) return false;
  try {
    return await _db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO eth420_candidate_settlement_events
          (id, eastern_date, realized_pnl_delta_cents, applied_at_ms)
        VALUES (${params.id}, ${params.easternDate}, ${Math.trunc(params.realizedPnlDeltaCents)}, ${Date.now()})
        ON CONFLICT (id) DO NOTHING RETURNING id`);
      if ((inserted as unknown as { rows: Array<unknown> }).rows.length === 0) return true;
      const state = params.nextState;
      await tx.execute(sql`
        INSERT INTO eth420_candidate_daily_state
          (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
        VALUES (${state.easternDate}, ${state.side},
          ${Math.max(0, Math.min(5, Math.trunc(state.step)))}, ${Math.trunc(state.realizedPnlCents)},
          ${state.lastBlockResetAtMs}, ${Date.now()})
        ON CONFLICT (eastern_date) DO UPDATE SET side=EXCLUDED.side, martingale_step=EXCLUDED.martingale_step,
          realized_pnl_cents=EXCLUDED.realized_pnl_cents,
          last_block_reset_at_ms=EXCLUDED.last_block_reset_at_ms, updated_at_ms=EXCLUDED.updated_at_ms`);
      _lastWriteMs = Date.now();
      return true;
    });
  } catch (err) {
    logger.warn({ err, id: params.id }, "ETH 420 candidate settlement state update failed");
    return false;
  }
}

export interface Eth420CandidateLiveOrder {
  id: string; ticker: string; easternDate: string; side: "yes" | "no"; step: number;
  marketOpenTimeMs?: number | null;
  requestedContracts: number; limitPriceCents: number; effectiveWagerCents: number;
  stateBeforeJson: string; kalshiOrderId: string | null; originalPrimaryKalshiOrderId?: string | null; secondaryClientOrderId?: string | null;
  primaryCancelConfirmedAtMs?: number | null; secondarySubmissionStartedAtMs?: number | null; secondaryBoundAtMs?: number | null; status: string;
  filledContracts: number | null; realizedPnlDeltaCents: number | null;
  actualNotionalDollars: string | null; actualFeeDollars: string | null; fillPriceCents: number | null;
  settlementResult: "yes" | "no" | null; stateAfterJson: string | null;
  rejectionReason?: string | null; rejectionConfirmedAtMs?: number | null;
  recoveryAttemptCount?: number; lastRecoveryOutcome?: string | null; lastRecoveryErrorClass?: string | null;
  /** First durable observation of the official market outcome; null until finalized. */
  finalizedAtMs?: number | null;
  createdAtMs: number; updatedAtMs: number;
  /** Lock-ordered durable sequence; legacy rows are 0 and permanently grandfathered. */
  secondaryActivationSequence?: number;
}

export interface Eth420CandidateBackFlipArm {
  sourceCandidateOrderId: string; sourceTicker: string; sourceOpenTimeMs: number;
  missedSide: "yes" | "no"; targetOpenTimeMs: number; armedAtMs: number;
}
export interface Eth420CandidateBackFlipReservation {
  sourceCandidateOrderId: string; targetTicker: string; targetOpenTimeMs: number;
  observedAtMs: number; missedSideBidCents: number;
  selectedSide: "yes" | "no"; intendedWagerCents: number; requestedContracts: number;
  executionMode: "cross_ioc" | "resting_gtc"; limitPriceCents: number;
}

export interface Eth420SecondaryActivationCutover {
  version: 1;
  activatedAtMs: number;
  reservationSequence: number;
}

function parseEth420SecondaryActivationCutover(value: unknown): Eth420SecondaryActivationCutover | null {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    return parsed.version === 1 && Number.isInteger(parsed.activatedAtMs) && Number(parsed.activatedAtMs) >= 0
      && Number.isInteger(parsed.reservationSequence) && Number(parsed.reservationSequence) >= 0
      ? { version: 1, activatedAtMs: Number(parsed.activatedAtMs), reservationSequence: Number(parsed.reservationSequence) }
      : null;
  } catch {
    return null;
  }
}

/** Read-only boundary lookup. Missing or malformed evidence is never eligible
 * for a secondary replacement. */
export async function getEth420SecondaryActivationCutover(): Promise<Eth420SecondaryActivationCutover | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`
      SELECT value FROM server_metadata WHERE key=${ETH420_SECONDARY_ACTIVATION_CUTOVER_KEY} LIMIT 1`);
    return parseEth420SecondaryActivationCutover(
      (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0]?.["value"],
    );
  } catch (err) {
    logger.warn({ err }, "ETH420 secondary activation cutover read failed");
    return null;
  }
}

/** Creates the immutable forward-only boundary. It never reads, changes, or
 * submits a candidate order; the shared advisory lock only orders it against
 * the atomic primary-reservation transaction. */
export async function activateEth420SecondaryActivationCutover(
): Promise<{ created: boolean; cutover: Eth420SecondaryActivationCutover } | null> {
  if (!_db || !_healthy) return null;
  try {
    return await _db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-secondary-activation-cutover"}))`);
      const existing = await tx.execute(sql`
        SELECT value FROM server_metadata WHERE key=${ETH420_SECONDARY_ACTIVATION_CUTOVER_KEY} FOR UPDATE`);
      const row = (existing as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (row) {
        const cutover = parseEth420SecondaryActivationCutover(row["value"]);
        return cutover ? { created: false, cutover } : null;
      }
      const sequenceResult = await tx.execute(sql`
        SELECT value FROM server_metadata WHERE key=${ETH420_SECONDARY_RESERVATION_SEQUENCE_KEY} FOR UPDATE`);
      const sequenceValue = (sequenceResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0]?.["value"];
      const reservationSequence = Number.isSafeInteger(Number(sequenceValue)) && Number(sequenceValue) >= 0
        ? Number(sequenceValue) : 0;
      // The timestamp is deliberately sampled only after holding the same
      // lock as reservations. Sampling it before acquiring that lock would
      // let a concurrently-reserved primary be misclassified as post-cutover.
      const cutover: Eth420SecondaryActivationCutover = { version: 1, activatedAtMs: Date.now(), reservationSequence };
      await tx.execute(sql`
        INSERT INTO server_metadata (key, value, updated_at)
        VALUES (${ETH420_SECONDARY_ACTIVATION_CUTOVER_KEY}, ${JSON.stringify(cutover)}, NOW())`);
      _lastWriteMs = cutover.activatedAtMs;
      return { created: true, cutover };
    });
  } catch (err) {
    logger.warn({ err }, "ETH420 secondary activation cutover write failed");
    return null;
  }
}

export interface Eth420CandidateExecutionSnapshot {
  snapshotId: string; candidateOrderId: string; ticker: string; scheduledOffsetMs: number;
  scheduledAtMs: number; observedAtMs: number; selectedSide: "yes" | "no"; requestedContracts: number;
  kalshiOrderId: string | null; orderStatus: string; filledContracts: number | null;
  selectedBestBidCents: number | null; selectedBestAskCents: number | null;
  depthAt50Contracts: number | null; fullSizeExecutablePriceCents: number | null;
  quoteAgeMs: number | null; quoteFreshness: "fresh" | "stale" | "unavailable";
  observationState: "captured" | "missed_on_restart";
}

export type Eth420CandidateRunawayResearchInput = {
  order: Eth420CandidateLiveOrder;
  snapshots: Eth420CandidateExecutionSnapshot[];
};

export type Eth420CandidateRunawayResearchRecord = {
  candidateOrderId: string; ticker: string; selectedSide: "yes" | "no"; requestedContracts: number;
  classifierVersion: string; alreadyGoneFired: boolean; acceleratingRunawayFired: boolean; quietRunawayFired: boolean;
  firedRegimes: Array<"already_gone" | "accelerating_runaway" | "quiet_runaway">;
  decisionPointOffsetMs: number | null; hypotheticalFullSizeEntryPriceCents: number | null; sourceSnapshotsJson: string;
  settlementResult: "yes" | "no" | null; hypotheticalEntryCostCents: number | null; hypotheticalFeeCents: number | null;
  hypotheticalGrossPnlCents: number | null; hypotheticalNetPnlCents: number | null; sourceUpdatedAtMs: number;
};

/** Candidate-only claim. It shares neither order/state tables nor locks with ETH martingale. */
export async function createEth420CandidateLiveOrder(params: Omit<Eth420CandidateLiveOrder,
  "kalshiOrderId" | "status" | "filledContracts" | "realizedPnlDeltaCents" | "actualNotionalDollars"
  | "actualFeeDollars" | "fillPriceCents" | "settlementResult" | "stateAfterJson" | "createdAtMs"
  | "rejectionReason" | "rejectionConfirmedAtMs" | "updatedAtMs">): Promise<boolean> {
  if (!_db || !_healthy || !params.id || !params.ticker || !["yes", "no"].includes(params.side)
    || !Number.isInteger(params.requestedContracts) || params.requestedContracts < 1) return false;
  try {
    const result = await _db.execute(sql`
      INSERT INTO eth420_candidate_live_orders
        (id, ticker, eastern_date, side, martingale_step, requested_contracts, limit_price_cents,
         effective_wager_cents, state_before_json, status, created_at_ms, updated_at_ms)
      VALUES (${params.id}, ${params.ticker}, ${params.easternDate}, ${params.side},
        ${Math.max(0, Math.min(5, Math.trunc(params.step)))}, ${params.requestedContracts},
        ${params.limitPriceCents}, ${params.effectiveWagerCents}, ${params.stateBeforeJson},
        'reserved', ${Date.now()}, ${Date.now()})
      ON CONFLICT (id) DO NOTHING RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, ticker: params.ticker }, "ETH420 candidate live order reservation failed");
    return false;
  }
}

/**
 * The candidate's only new-entry claim. State bootstrap, unresolved-lifecycle
 * inspection, prepared-state comparison, and reservation share one database
 * transaction so no uncertain candidate history can be bypassed between
 * evaluation and submission.
 */
export async function reserveEth420CandidateLiveOrderIfStateMatches(params: Omit<Eth420CandidateLiveOrder,
  "kalshiOrderId" | "status" | "filledContracts" | "realizedPnlDeltaCents" | "actualNotionalDollars"
  | "actualFeeDollars" | "fillPriceCents" | "settlementResult" | "stateAfterJson" | "createdAtMs"
  | "updatedAtMs"> & { expectedState: Eth420CandidateState; reservationAtMs?: number;
    backFlip?: Eth420CandidateBackFlipReservation | null }): Promise<boolean> {
  const expected = params.expectedState;
  const validState = expected.easternDate === params.easternDate
    && ["yes", "no"].includes(expected.side)
    && Number.isInteger(expected.step) && expected.step >= 0 && expected.step <= 5
    && Number.isInteger(expected.realizedPnlCents)
    && (expected.lastBlockResetAtMs == null || Number.isInteger(expected.lastBlockResetAtMs));
  if (!_db || !_healthy || !params.id || !params.ticker || !["yes", "no"].includes(params.side)
    || !Number.isInteger(params.requestedContracts) || params.requestedContracts < 1 || !validState
    || params.step !== expected.step
    || params.stateBeforeJson !== JSON.stringify(expected)) return false;
  // This is deliberately a synchronous, in-process guard. No emergency SQL,
  // lock, or I/O may be added to the normal candidate-entry path while the
  // emergency capability is dormant.
  if (!beginEth420CandidateEntryReservation()) return false;
  try {
    return await _db.transaction(async (tx) => {
      // Serialize the immutable activation boundary with each primary
      // reservation. The boundary timestamp is created under the same lock, so
      // a row cannot race from "already existed" into post-cutover eligibility.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-secondary-activation-cutover"}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-candidate-entry:" + params.easternDate}))`);
      const backFlip = params.backFlip ?? null;
      const overrideResult = await tx.execute(sql`
        SELECT source_candidate_order_id, missed_side FROM eth420_candidate_back_flip_overrides
        WHERE target_open_time_ms=${params.marketOpenTimeMs ?? -1} AND status='armed' FOR UPDATE`);
      const overrideRow = (overrideResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (overrideRow) {
        if (!backFlip || backFlip.sourceCandidateOrderId !== overrideRow["source_candidate_order_id"]
          || backFlip.targetOpenTimeMs !== params.marketOpenTimeMs
          || backFlip.targetTicker !== params.ticker || backFlip.selectedSide !== params.side
          || !Number.isInteger(backFlip.missedSideBidCents) || backFlip.missedSideBidCents < 0
          || backFlip.missedSideBidCents > 100 || backFlip.intendedWagerCents !== params.effectiveWagerCents
          || backFlip.requestedContracts !== params.requestedContracts
          || !["cross_ioc", "resting_gtc"].includes(backFlip.executionMode)
          || !Number.isInteger(backFlip.limitPriceCents) || backFlip.limitPriceCents < 1 || backFlip.limitPriceCents > 99
          || backFlip.limitPriceCents !== params.limitPriceCents) return false;
      } else if (backFlip || params.side !== expected.side) return false;
      const existing = await tx.execute(sql`
        SELECT eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms
        FROM eth420_candidate_daily_state WHERE eastern_date=${params.easternDate} FOR UPDATE`);
      const stateRow = (existing as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      const lifecycle = await tx.execute(sql`
        SELECT id, status FROM eth420_candidate_live_orders
        WHERE eastern_date=${params.easternDate} FOR UPDATE`);
      const lifecycleRows = (lifecycle as unknown as { rows: Array<Record<string, unknown>> }).rows;
      if (lifecycleRows.some((row) => row["status"] !== "settled" && row["status"] !== "rejected_insufficient_balance")) return false;
      if (stateRow) {
        const actual = {
          easternDate: String(stateRow["eastern_date"]),
          side: stateRow["side"] === "yes" ? "yes" as const : "no" as const,
          step: Number(stateRow["martingale_step"]),
          realizedPnlCents: Number(stateRow["realized_pnl_cents"]),
          lastBlockResetAtMs: stateRow["last_block_reset_at_ms"] == null ? null : Number(stateRow["last_block_reset_at_ms"]),
        };
        if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
      } else {
        // A no-state day is trustworthy only before the very first candidate
        // lifecycle. Bootstrap cannot silently reinterpret prior history.
        if (lifecycleRows.length > 0) return false;
        const canonical = expected.side === "no" && expected.step === 0
          && expected.realizedPnlCents === 0 && expected.lastBlockResetAtMs === null;
        if (!canonical) return false;
        await tx.execute(sql`
          INSERT INTO eth420_candidate_daily_state
            (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
          VALUES (${expected.easternDate}, ${expected.side}, ${expected.step}, ${expected.realizedPnlCents},
            ${expected.lastBlockResetAtMs}, ${Date.now()})`);
      }
      // `created_at_ms` is the immutable cutover comparison value. Sample it
      // only after taking the shared cutover lock, rather than trusting a
      // caller timestamp captured before transaction scheduling.
      const now = Date.now();
      const sequence = await tx.execute(sql`
        INSERT INTO server_metadata (key, value, updated_at)
        VALUES (${ETH420_SECONDARY_RESERVATION_SEQUENCE_KEY}, '1', NOW())
        ON CONFLICT (key) DO UPDATE SET value=((server_metadata.value::bigint) + 1)::text, updated_at=NOW()
        RETURNING value`);
      const reservationSequence = Number((sequence as unknown as { rows: Array<Record<string, unknown>> }).rows[0]?.["value"]);
      if (!Number.isSafeInteger(reservationSequence) || reservationSequence < 1) return false;
      const inserted = await tx.execute(sql`
        INSERT INTO eth420_candidate_live_orders
          (id, ticker, eastern_date, market_open_time_ms, side, martingale_step, requested_contracts, limit_price_cents,
           effective_wager_cents, state_before_json, status, created_at_ms, secondary_activation_sequence, updated_at_ms)
        VALUES (${params.id}, ${params.ticker}, ${params.easternDate}, ${params.marketOpenTimeMs ?? null}, ${params.side},
          ${params.step}, ${params.requestedContracts},
          ${params.limitPriceCents}, ${params.effectiveWagerCents}, ${params.stateBeforeJson},
           'reserved', ${now}, ${reservationSequence}, ${now})
        ON CONFLICT (id) DO NOTHING RETURNING id`);
      const reserved = (inserted as unknown as { rows: unknown[] }).rows.length === 1;
       if (reserved && backFlip) {
         await tx.execute(sql`UPDATE eth420_candidate_back_flip_overrides SET
            target_ticker=${backFlip.targetTicker}, status='reserved',
           observed_at_ms=${backFlip.observedAtMs}, missed_side_bid_cents=${backFlip.missedSideBidCents},
           selected_side=${backFlip.selectedSide}, intended_wager_cents=${backFlip.intendedWagerCents},
            requested_contracts=${backFlip.requestedContracts}, execution_mode=${backFlip.executionMode},
            execution_limit_price_cents=${backFlip.limitPriceCents}, candidate_order_id=${params.id},
           resolved_at_ms=${now}
           WHERE source_candidate_order_id=${backFlip.sourceCandidateOrderId} AND status='armed'`);
       }
      if (reserved) _lastWriteMs = now;
      return reserved;
    });
  } catch (err) {
    logger.warn({ err, ticker: params.ticker }, "ETH420 candidate atomic live order reservation failed");
    return false;
  }
}

export async function acknowledgeEth420CandidateLiveOrder(
  id: string, kalshiOrderId: string | null, status: string, rejectionReason?: string,
): Promise<boolean> {
  const allowed = ["submitted", "rejected_insufficient_balance", "submission_unknown_recovery_required",
    "terminal_recovered", "resting_recovered"];
  const confirmedZeroExposure = status === "rejected_insufficient_balance";
  const safeReason = confirmedZeroExposure && typeof rejectionReason === "string" && rejectionReason.trim()
    ? rejectionReason.trim().slice(0, 500)
    : null;
  if (!_db || !_healthy || !id || !allowed.includes(status)
    || ((status === "submitted" || status === "terminal_recovered" || status === "resting_recovered") && !kalshiOrderId)
    || (confirmedZeroExposure && safeReason == null)) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE eth420_candidate_live_orders SET
        kalshi_order_id=${kalshiOrderId},
        original_primary_kalshi_order_id=COALESCE(original_primary_kalshi_order_id, ${kalshiOrderId}), status=${status},
        filled_contracts=CASE WHEN ${confirmedZeroExposure} THEN 0 ELSE filled_contracts END,
        rejection_reason=CASE WHEN ${confirmedZeroExposure} THEN ${safeReason} ELSE rejection_reason END,
        rejection_confirmed_at_ms=CASE WHEN ${confirmedZeroExposure} THEN ${Date.now()} ELSE rejection_confirmed_at_ms END,
        updated_at_ms=${Date.now()}
      WHERE id=${id} AND (
        status='reserved'
        OR (${status}='submitted' AND kalshi_order_id IS NULL
          AND status='submission_unknown_recovery_required')
        OR (${status} IN ('terminal_recovered', 'resting_recovered')
          AND status IN ('submission_unknown_recovery_required', 'terminal_recovered', 'resting_recovered'))
      ) RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, id }, "ETH420 candidate live order acknowledgement failed");
    return false;
  }
}

/** Candidate-only conditional reservation release. This is intentionally a
 * DELETE: ticker is unique in this independent ledger, so retaining a proven
 * phantom would permanently prevent a later valid candidate submission. */
export async function releaseEth420CandidateProvenAbsentSubmission(id: string): Promise<boolean> {
  if (!_db || !_healthy || !id) return false;
  try {
    const result = await _db.execute(sql`
      DELETE FROM eth420_candidate_live_orders
      WHERE id=${id} AND kalshi_order_id IS NULL AND status='submission_unknown_recovery_required'
      RETURNING id`);
    const released = (result as unknown as { rows: unknown[] }).rows.length === 1;
    if (released) _lastWriteMs = Date.now();
    return released;
  } catch (err) {
    logger.warn({ err, id }, "ETH420 candidate proven-absent submission release failed");
    return false;
  }
}

export async function replaceEth420CandidatePrimaryWithSecondary(
  id: string, primaryOrderId: string, secondaryOrderId: string,
): Promise<boolean> {
  if (!_db || !_healthy || !id || !primaryOrderId || !secondaryOrderId) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE eth420_candidate_live_orders SET kalshi_order_id=${secondaryOrderId}, status='submitted',
        secondary_bound_at_ms=${Date.now()}, updated_at_ms=${Date.now()}
      WHERE id=${id} AND kalshi_order_id=${primaryOrderId}
        AND original_primary_kalshi_order_id=${primaryOrderId}
        AND status IN ('submitted', 'resting_recovered', 'secondary_submission_pending') AND settlement_result IS NULL
      RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, id }, "ETH420 secondary entry replacement binding failed");
    return false;
  }
}

export async function markEth420CandidateSecondarySubmissionPending(id: string, primaryOrderId: string, clientOrderId: string): Promise<boolean> {
  if (!_db || !_healthy || !id || !primaryOrderId || !clientOrderId) return false;
  try {
    const result = await _db.execute(sql`UPDATE eth420_candidate_live_orders SET status='secondary_submission_pending',
      secondary_client_order_id=${clientOrderId}, primary_cancel_confirmed_at_ms=${Date.now()},
      secondary_submission_started_at_ms=${Date.now()}, updated_at_ms=${Date.now()}
      WHERE id=${id} AND kalshi_order_id=${primaryOrderId} AND original_primary_kalshi_order_id=${primaryOrderId}
      AND status IN ('submitted', 'resting_recovered') AND settlement_result IS NULL RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch { return false; }
}

function mapEth420CandidateLiveOrder(row: Record<string, unknown>): Eth420CandidateLiveOrder {
  return {
    id: String(row["id"]), ticker: String(row["ticker"]), easternDate: String(row["eastern_date"]),
    marketOpenTimeMs: row["market_open_time_ms"] == null ? null : Number(row["market_open_time_ms"]),
    side: row["side"] === "yes" ? "yes" : "no", step: Number(row["martingale_step"]),
    requestedContracts: Number(row["requested_contracts"]), limitPriceCents: Number(row["limit_price_cents"]),
    effectiveWagerCents: Number(row["effective_wager_cents"]), stateBeforeJson: String(row["state_before_json"]),
    kalshiOrderId: row["kalshi_order_id"] == null ? null : String(row["kalshi_order_id"]),
    originalPrimaryKalshiOrderId: row["original_primary_kalshi_order_id"] == null ? null : String(row["original_primary_kalshi_order_id"]),
    secondaryClientOrderId: row["secondary_client_order_id"] == null ? null : String(row["secondary_client_order_id"]),
    primaryCancelConfirmedAtMs: row["primary_cancel_confirmed_at_ms"] == null ? null : Number(row["primary_cancel_confirmed_at_ms"]),
    secondarySubmissionStartedAtMs: row["secondary_submission_started_at_ms"] == null ? null : Number(row["secondary_submission_started_at_ms"]),
    secondaryBoundAtMs: row["secondary_bound_at_ms"] == null ? null : Number(row["secondary_bound_at_ms"]),
    status: String(row["status"]),
    filledContracts: row["filled_contracts"] == null ? null : Number(row["filled_contracts"]),
    realizedPnlDeltaCents: row["realized_pnl_delta_cents"] == null ? null : Number(row["realized_pnl_delta_cents"]),
    actualNotionalDollars: row["actual_notional_dollars"] == null ? null : String(row["actual_notional_dollars"]),
    actualFeeDollars: row["actual_fee_dollars"] == null ? null : String(row["actual_fee_dollars"]),
    fillPriceCents: row["fill_price_cents"] == null ? null : Number(row["fill_price_cents"]),
    settlementResult: row["settlement_result"] === "yes" || row["settlement_result"] === "no" ? row["settlement_result"] : null,
    stateAfterJson: row["state_after_json"] == null ? null : String(row["state_after_json"]),
    rejectionReason: row["rejection_reason"] == null ? null : String(row["rejection_reason"]),
    rejectionConfirmedAtMs: row["rejection_confirmed_at_ms"] == null ? null : Number(row["rejection_confirmed_at_ms"]),
    recoveryAttemptCount: Number(row["recovery_attempt_count"] ?? 0),
    lastRecoveryOutcome: row["last_recovery_outcome"] == null ? null : String(row["last_recovery_outcome"]),
    lastRecoveryErrorClass: row["last_recovery_error_class"] == null ? null : String(row["last_recovery_error_class"]),
    finalizedAtMs: row["finalized_at_ms"] == null ? null : Number(row["finalized_at_ms"]),
    createdAtMs: Number(row["created_at_ms"]), updatedAtMs: Number(row["updated_at_ms"]),
    secondaryActivationSequence: Number(row["secondary_activation_sequence"] ?? 0),
  };
}

export async function getEth420CandidateBackFlipArm(targetOpenTimeMs: number): Promise<Eth420CandidateBackFlipArm | null> {
  if (!_db || !_healthy || !Number.isInteger(targetOpenTimeMs)) return null;
  try {
    const result = await _db.execute(sql`SELECT source_candidate_order_id, source_ticker, source_open_time_ms,
      missed_side, target_open_time_ms, armed_at_ms FROM eth420_candidate_back_flip_overrides
      WHERE target_open_time_ms=${targetOpenTimeMs} AND status='armed'`);
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    return row && (row["missed_side"] === "yes" || row["missed_side"] === "no")
      ? { sourceCandidateOrderId: String(row["source_candidate_order_id"]), sourceTicker: String(row["source_ticker"]),
        sourceOpenTimeMs: Number(row["source_open_time_ms"]), missedSide: row["missed_side"],
        targetOpenTimeMs: Number(row["target_open_time_ms"]), armedAtMs: Number(row["armed_at_ms"]) } : null;
  } catch (err) { logger.warn({ err }, "ETH420 Back Flip arm read failed"); return null; }
}

export async function fallbackEth420CandidateBackFlip(params: {
  sourceCandidateOrderId: string; targetTicker: string; targetOpenTimeMs: number;
  observedAtMs: number; reason: string;
}): Promise<boolean> {
  if (!_db || !_healthy || !params.sourceCandidateOrderId || !params.targetTicker
    || !Number.isInteger(params.targetOpenTimeMs) || !params.reason) return false;
  try {
    const result = await _db.execute(sql`UPDATE eth420_candidate_back_flip_overrides SET
      target_ticker=${params.targetTicker}, status='fallback',
      observed_at_ms=${params.observedAtMs}, fallback_reason=${params.reason}, resolved_at_ms=${Date.now()}
      WHERE source_candidate_order_id=${params.sourceCandidateOrderId}
        AND target_open_time_ms=${params.targetOpenTimeMs} AND status='armed' RETURNING source_candidate_order_id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) { logger.warn({ err }, "ETH420 Back Flip fallback audit failed"); return false; }
}

export async function listPendingEth420CandidateLiveOrders(): Promise<Eth420CandidateLiveOrder[]> {
  if (!_db || !_healthy) return [];
  try {
    const result = await _db.execute(sql`
      SELECT * FROM eth420_candidate_live_orders
       WHERE status IN ('submitted', 'submission_unknown_recovery_required', 'terminal_recovered', 'resting_recovered', 'secondary_submission_pending')
      ORDER BY created_at_ms ASC`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map(mapEth420CandidateLiveOrder);
  } catch (err) {
    logger.warn({ err }, "ETH420 candidate live order recovery read failed");
    return [];
  }
}

/** Candidate-only durable exposure check. Null means storage is unavailable and
 * must remain fail-closed; this is deliberately broader than recovery polling,
 * so an unacknowledged reservation cannot look clear to a boundary scheduler. */
export async function hasUnresolvedEth420CandidateLiveExposure(): Promise<boolean | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM eth420_candidate_live_orders
        WHERE status NOT IN ('settled', 'rejected_insufficient_balance')
      ) AS has_exposure`);
    return Boolean((result as unknown as { rows: Array<Record<string, unknown>> }).rows[0]?.["has_exposure"]);
  } catch (err) {
    logger.warn({ err }, "ETH420 candidate boundary exposure read failed");
    return null;
  }
}

/** Read one candidate row for a passive telemetry sample; no lifecycle mutation. */
export async function getEth420CandidateLiveOrder(id: string): Promise<Eth420CandidateLiveOrder | null> {
  if (!_db || !_healthy || !id) return null;
  try {
    const result = await _db.execute(sql`SELECT * FROM eth420_candidate_live_orders WHERE id=${id}`);
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    return row ? mapEth420CandidateLiveOrder(row) : null;
  } catch (err) {
    logger.warn({ err, id }, "ETH420 candidate execution telemetry order read failed");
    return null;
  }
}

/** Bounded restart lookup for the seven passive execution observations only. */
export async function listRecentUnsettledEth420CandidateLiveOrders(sinceMs: number): Promise<Eth420CandidateLiveOrder[]> {
  if (!_db || !_healthy || !Number.isFinite(sinceMs)) return [];
  try {
    const result = await _db.execute(sql`
      SELECT * FROM eth420_candidate_live_orders
      WHERE status NOT IN ('settled', 'rejected_insufficient_balance') AND created_at_ms >= ${Math.trunc(sinceMs)}
      ORDER BY created_at_ms ASC`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map(mapEth420CandidateLiveOrder);
  } catch (err) {
    logger.warn({ err }, "ETH420 candidate execution telemetry restart lookup failed");
    return [];
  }
}

/** Idempotent scalar-only diagnostic insert; never changes order or state rows. */
export async function recordEth420CandidateExecutionSnapshot(
  snapshot: Eth420CandidateExecutionSnapshot,
): Promise<boolean> {
  const valid = snapshot.snapshotId && snapshot.candidateOrderId && snapshot.ticker
    && ["yes", "no"].includes(snapshot.selectedSide)
    && ["fresh", "stale", "unavailable"].includes(snapshot.quoteFreshness)
    && ["captured", "missed_on_restart"].includes(snapshot.observationState)
    && Number.isInteger(snapshot.scheduledOffsetMs)
    && Number.isFinite(snapshot.requestedContracts) && snapshot.requestedContracts >= 0
    && (snapshot.filledContracts == null
      || Number.isFinite(snapshot.filledContracts) && snapshot.filledContracts >= 0);
  if (!_db || !_healthy || !valid) return false;
  try {
    const result = await _db.execute(sql`
      INSERT INTO eth420_candidate_execution_snapshots (
        snapshot_id, candidate_order_id, ticker, scheduled_offset_ms, scheduled_at_ms, observed_at_ms,
        selected_side, requested_contracts, kalshi_order_id, order_status, filled_contracts,
        selected_best_bid_cents, selected_best_ask_cents, depth_at_50_contracts,
        full_size_executable_price_cents, quote_age_ms, quote_freshness, observation_state
      ) VALUES (
        ${snapshot.snapshotId}, ${snapshot.candidateOrderId}, ${snapshot.ticker}, ${snapshot.scheduledOffsetMs},
        ${snapshot.scheduledAtMs}, ${snapshot.observedAtMs}, ${snapshot.selectedSide}, ${snapshot.requestedContracts},
        ${snapshot.kalshiOrderId}, ${snapshot.orderStatus}, ${snapshot.filledContracts},
        ${snapshot.selectedBestBidCents}, ${snapshot.selectedBestAskCents}, ${snapshot.depthAt50Contracts},
        ${snapshot.fullSizeExecutablePriceCents}, ${snapshot.quoteAgeMs}, ${snapshot.quoteFreshness},
        ${snapshot.observationState}
      ) ON CONFLICT (candidate_order_id, scheduled_offset_ms) DO NOTHING RETURNING snapshot_id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, candidateOrderId: snapshot.candidateOrderId }, "ETH420 candidate execution telemetry write failed");
    return false;
  }
}

/** Passive bulk read for runaway research; no lifecycle or state mutation. */
export async function listEth420CandidateRunawayResearchInputs(limit = 2_000): Promise<Eth420CandidateRunawayResearchInput[]> {
  if (!_db || !_healthy) return [];
  const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit) || 2_000));
  try {
    const orders = (await _db.execute(sql`
      SELECT * FROM eth420_candidate_live_orders ORDER BY created_at_ms ASC LIMIT ${safeLimit}
    `) as unknown as { rows: Array<Record<string, unknown>> }).rows.map(mapEth420CandidateLiveOrder);
    if (!orders.length) return [];
    const ids = orders.map((order) => order.id);
    const rows = (await _db.execute(sql`
      SELECT * FROM eth420_candidate_execution_snapshots
      WHERE candidate_order_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      ORDER BY candidate_order_id ASC, scheduled_offset_ms ASC
    `) as unknown as { rows: Array<Record<string, unknown>> }).rows;
    const snapshotsByOrder = new Map<string, Eth420CandidateExecutionSnapshot[]>();
    for (const row of rows) {
      const candidateOrderId = String(row["candidate_order_id"]);
      const snapshots = snapshotsByOrder.get(candidateOrderId) ?? [];
      snapshots.push({
        snapshotId: String(row["snapshot_id"]), candidateOrderId, ticker: String(row["ticker"]),
        scheduledOffsetMs: Number(row["scheduled_offset_ms"]), scheduledAtMs: Number(row["scheduled_at_ms"]),
        observedAtMs: Number(row["observed_at_ms"]), selectedSide: row["selected_side"] === "yes" ? "yes" : "no",
        requestedContracts: Number(row["requested_contracts"]), kalshiOrderId: row["kalshi_order_id"] == null ? null : String(row["kalshi_order_id"]),
        orderStatus: String(row["order_status"]), filledContracts: row["filled_contracts"] == null ? null : Number(row["filled_contracts"]),
        selectedBestBidCents: row["selected_best_bid_cents"] == null ? null : Number(row["selected_best_bid_cents"]),
        selectedBestAskCents: row["selected_best_ask_cents"] == null ? null : Number(row["selected_best_ask_cents"]),
        depthAt50Contracts: row["depth_at_50_contracts"] == null ? null : Number(row["depth_at_50_contracts"]),
        fullSizeExecutablePriceCents: row["full_size_executable_price_cents"] == null ? null : Number(row["full_size_executable_price_cents"]),
        quoteAgeMs: row["quote_age_ms"] == null ? null : Number(row["quote_age_ms"]),
        quoteFreshness: row["quote_freshness"] === "fresh" || row["quote_freshness"] === "stale" ? row["quote_freshness"] : "unavailable",
        observationState: row["observation_state"] === "missed_on_restart" ? "missed_on_restart" : "captured",
      });
      snapshotsByOrder.set(candidateOrderId, snapshots);
    }
    return orders.map((order) => ({ order, snapshots: snapshotsByOrder.get(order.id) ?? [] }));
  } catch (err) {
    logger.warn({ err }, "ETH420 runaway research input read failed");
    return [];
  }
}

/** Idempotent research upsert. It never changes candidate orders or state. */
export async function recordEth420CandidateRunawayResearch(record: Eth420CandidateRunawayResearchRecord): Promise<boolean> {
  if (!_db || !_healthy || !record.candidateOrderId || !record.ticker || !["yes", "no"].includes(record.selectedSide)
    || !Number.isInteger(record.requestedContracts) || record.requestedContracts < 1) return false;
  try {
    const result = await _db.execute(sql`
      INSERT INTO eth420_candidate_runaway_research (
        candidate_order_id, ticker, selected_side, requested_contracts, classifier_version,
        already_gone_fired, accelerating_runaway_fired, quiet_runaway_fired, fired_regimes_json,
        decision_point_offset_ms, hypothetical_full_size_entry_price_cents, source_snapshots_json,
        settlement_result, hypothetical_entry_cost_cents, hypothetical_fee_cents, hypothetical_gross_pnl_cents,
        hypothetical_net_pnl_cents, source_updated_at_ms, classified_at_ms
      ) VALUES (
        ${record.candidateOrderId}, ${record.ticker}, ${record.selectedSide}, ${record.requestedContracts}, ${record.classifierVersion},
        ${record.alreadyGoneFired}, ${record.acceleratingRunawayFired}, ${record.quietRunawayFired}, ${JSON.stringify(record.firedRegimes)},
        ${record.decisionPointOffsetMs}, ${record.hypotheticalFullSizeEntryPriceCents}, ${record.sourceSnapshotsJson},
        ${record.settlementResult}, ${record.hypotheticalEntryCostCents}, ${record.hypotheticalFeeCents}, ${record.hypotheticalGrossPnlCents},
        ${record.hypotheticalNetPnlCents}, ${record.sourceUpdatedAtMs}, ${Date.now()}
      ) ON CONFLICT (candidate_order_id) DO UPDATE SET
        classifier_version=EXCLUDED.classifier_version, already_gone_fired=EXCLUDED.already_gone_fired,
        accelerating_runaway_fired=EXCLUDED.accelerating_runaway_fired, quiet_runaway_fired=EXCLUDED.quiet_runaway_fired,
        fired_regimes_json=EXCLUDED.fired_regimes_json, decision_point_offset_ms=EXCLUDED.decision_point_offset_ms,
        hypothetical_full_size_entry_price_cents=EXCLUDED.hypothetical_full_size_entry_price_cents,
        source_snapshots_json=EXCLUDED.source_snapshots_json, settlement_result=EXCLUDED.settlement_result,
        hypothetical_entry_cost_cents=EXCLUDED.hypothetical_entry_cost_cents, hypothetical_fee_cents=EXCLUDED.hypothetical_fee_cents,
        hypothetical_gross_pnl_cents=EXCLUDED.hypothetical_gross_pnl_cents, hypothetical_net_pnl_cents=EXCLUDED.hypothetical_net_pnl_cents,
        source_updated_at_ms=EXCLUDED.source_updated_at_ms, classified_at_ms=EXCLUDED.classified_at_ms
      RETURNING candidate_order_id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, candidateOrderId: record.candidateOrderId }, "ETH420 runaway research write failed");
    return false;
  }
}

export async function findEth420CandidateLiveOrderByTicker(ticker: string): Promise<Eth420CandidateLiveOrder | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`SELECT * FROM eth420_candidate_live_orders WHERE ticker=${ticker} LIMIT 2`);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    if (rows.length !== 1) return null;
    const row = rows[0];
    return row ? mapEth420CandidateLiveOrder(row) : null;
  } catch { return null; }
}

export type Eth420BoundaryResearchSnapshot = {
  id: string; ticker: string; anchor: string; marketOpenMs: number | null; marketCloseMs: number | null; priorMarketOpenMs: number | null;
  scheduledAtMs: number; actualAtMs: number; latenessMs: number; exchangeIndex: number | null;
  yesBid: number | null; yesAsk: number | null; noBid: number | null; noAsk: number | null; yesSpreadCents: number | null; noSpreadCents: number | null;
  l2Json: string; spotMidpoint: number | null; spotProvider: string | null; spotSourceTimestampMs: number | null; spotReceiptTimestampMs: number | null; spotAgeMs: number | null; spotIsProxy: boolean;
  candidateOrderId: string | null; kalshiOrderId: string | null; selectedSide: string | null; requestedContracts: number | null; primaryLimitCents: number | null; orderStatus: string | null; filledContracts: number | null; quality: string;
};
/** Append-only passive research write; never read by trading code. */
export async function recordEth420BoundaryResearchSnapshot(s: Eth420BoundaryResearchSnapshot): Promise<boolean> {
  if (!_db || !_healthy || !s.id || !s.ticker || !s.anchor) return false;
  try {
    const r = await _db.execute(sql`INSERT INTO eth420_boundary_research_snapshots (
      id,ticker,anchor,market_open_ms,market_close_ms,prior_market_open_ms,scheduled_at_ms,actual_at_ms,lateness_ms,exchange_index,
      yes_bid,yes_ask,no_bid,no_ask,yes_spread_cents,no_spread_cents,l2_json,spot_midpoint,spot_provider,spot_source_timestamp_ms,spot_receipt_timestamp_ms,spot_age_ms,spot_is_proxy,
      candidate_order_id,kalshi_order_id,selected_side,requested_contracts,primary_limit_cents,order_status,filled_contracts,quality)
      VALUES (${s.id},${s.ticker},${s.anchor},${s.marketOpenMs},${s.marketCloseMs},${s.priorMarketOpenMs},${s.scheduledAtMs},${s.actualAtMs},${s.latenessMs},${s.exchangeIndex},
      ${s.yesBid},${s.yesAsk},${s.noBid},${s.noAsk},${s.yesSpreadCents},${s.noSpreadCents},${s.l2Json},${s.spotMidpoint},${s.spotProvider},${s.spotSourceTimestampMs},${s.spotReceiptTimestampMs},${s.spotAgeMs},${s.spotIsProxy},
      ${s.candidateOrderId},${s.kalshiOrderId},${s.selectedSide},${s.requestedContracts},${s.primaryLimitCents},${s.orderStatus},${s.filledContracts},${s.quality})
      ON CONFLICT (ticker,anchor,scheduled_at_ms) DO NOTHING RETURNING id`);
    return (r as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) { logger.warn({ err, ticker: s.ticker, anchor: s.anchor }, "ETH420 boundary research write failed"); return false; }
}

export type Eth420BoundaryResearchRead =
  | { availability: "available"; rows: Array<Record<string, unknown>> }
  | { availability: "unavailable"; rows: []; diagnosticReason: "storage_unavailable" | "storage_read_failed" };

/**
 * Reads passive ETH420 boundary evidence without conflating an empty table with
 * a failed storage read. This is reporting-only and is never used by trading.
 */
export async function listEth420BoundaryResearchSnapshots(limit = 5_000): Promise<Eth420BoundaryResearchRead> {
  if (!_db || !_healthy) {
    return { availability: "unavailable", rows: [], diagnosticReason: "storage_unavailable" };
  }
  try {
    const rows = (await _db.execute(sql`
      SELECT * FROM eth420_boundary_research_snapshots
      ORDER BY scheduled_at_ms DESC
      LIMIT ${Math.max(1, Math.min(5_000, limit))}
    `) as unknown as { rows: Array<Record<string, unknown>> }).rows;
    return { availability: "available", rows };
  } catch (err) {
    logger.warn({ err }, "ETH420 boundary research read failed");
    return { availability: "unavailable", rows: [], diagnosticReason: "storage_read_failed" };
  }
}

/** Bounded per-order recovery telemetry: one latest summary, never raw exchange payloads. */
export async function recordEth420CandidateRecoveryOutcome(params: {
  id: string; outcome: string; errorClass: string | null;
}): Promise<boolean> {
  const allowed = ["not_terminal", "exchange_order_not_found", "exchange_evidence_ambiguous",
    "authenticated_fill_missing", "economics_incomplete", "official_result_missing",
    "earlier_candidate_unresolved", "persisted_state_read_failed", "bootstrap_not_allowed",
    "stale_state_retry", "settled", "unexpected_error"];
  if (!_db || !_healthy || !params.id || !allowed.includes(params.outcome)
    || (params.errorClass != null && !/^[a-z_]{1,80}$/.test(params.errorClass))) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE eth420_candidate_live_orders
      SET recovery_attempt_count=COALESCE(recovery_attempt_count, 0)+1,
        last_recovery_attempt_at_ms=${Date.now()}, last_recovery_outcome=${params.outcome},
        last_recovery_error_class=${params.errorClass}, updated_at_ms=${Date.now()}
      WHERE id=${params.id} RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, id: params.id }, "ETH420 candidate recovery telemetry write failed");
    return false;
  }
}

/** Records the first confirmed official-result boundary for dashboard alerting.
 * This is intentionally scalar telemetry only and cannot release, cancel, settle,
 * or otherwise alter the fail-closed candidate lifecycle. */
export async function markEth420CandidateOrderFinalized(id: string, finalizedAtMs: number): Promise<boolean> {
  if (!_db || !_healthy || !id || !Number.isSafeInteger(finalizedAtMs) || finalizedAtMs < 0) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE eth420_candidate_live_orders
      SET finalized_at_ms=COALESCE(finalized_at_ms, ${finalizedAtMs}), updated_at_ms=${Date.now()}
      WHERE id=${id} AND settlement_result IS NULL
      RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, id }, "ETH420 candidate finalization telemetry write failed");
    return false;
  }
}

/** Read-only dashboard view of the independent candidate ledger. */
export async function listRecentEth420CandidateLiveOrders(limit = 50): Promise<{
  available: boolean;
  orders: Eth420CandidateLiveOrder[];
}> {
  if (!_db || !_healthy) return { available: false, orders: [] };
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  try {
    const result = await _db.execute(sql`
      SELECT * FROM eth420_candidate_live_orders
      ORDER BY updated_at_ms DESC
      LIMIT ${safeLimit}`);
    return {
      available: true,
      orders: (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map(mapEth420CandidateLiveOrder),
    };
  } catch (err) {
    logger.warn({ err }, "ETH420 candidate live order dashboard read failed");
    return { available: false, orders: [] };
  }
}

export type Eth420CandidateDailyPnl = {
  easternDate: string;
  totalOrderCount: number;
  settledOrderCount: number;
  winningOrderCount: number;
  losingOrderCount: number;
  zeroPnlOrderCount: number;
  totalBetsCents: number;
  totalFeesCents: number;
  grossWinningsCents: number;
  grossLossesCents: number;
  netRealizedPnlCents: number;
};

/**
 * Read-only full-ledger ETH 420 P&L rollup. The persisted Eastern-day key is
 * authoritative so the dashboard never has to infer a trading day from a
 * browser timezone or a truncated order list.
 */
export async function listEth420CandidateDailyPnl(): Promise<{
  available: boolean;
  rows: Eth420CandidateDailyPnl[];
}> {
  if (!_db || !_healthy) return { available: false, rows: [] };
  try {
    const result = await _db.execute(sql`
      SELECT
        eastern_date AS "easternDate",
        COUNT(*) AS "totalOrderCount",
        COUNT(realized_pnl_delta_cents) AS "settledOrderCount",
        COUNT(*) FILTER (WHERE realized_pnl_delta_cents > 0) AS "winningOrderCount",
        COUNT(*) FILTER (WHERE realized_pnl_delta_cents < 0) AS "losingOrderCount",
        COUNT(*) FILTER (WHERE realized_pnl_delta_cents = 0) AS "zeroPnlOrderCount",
        COALESCE(ROUND(SUM(NULLIF(actual_notional_dollars, '')::numeric) * 100), 0)::bigint AS "totalBetsCents",
        COALESCE(ROUND(SUM(NULLIF(actual_fee_dollars, '')::numeric) * 100), 0)::bigint AS "totalFeesCents",
        COALESCE(SUM(realized_pnl_delta_cents) FILTER (WHERE realized_pnl_delta_cents > 0), 0) AS "grossWinningsCents",
        COALESCE(SUM(realized_pnl_delta_cents) FILTER (WHERE realized_pnl_delta_cents < 0), 0) AS "grossLossesCents",
        COALESCE(SUM(realized_pnl_delta_cents), 0) AS "netRealizedPnlCents"
      FROM eth420_candidate_live_orders
      GROUP BY eastern_date
      ORDER BY eastern_date DESC`);
    return {
      available: true,
      rows: (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => ({
        easternDate: String(row["easternDate"]),
        totalOrderCount: Number(row["totalOrderCount"]),
        settledOrderCount: Number(row["settledOrderCount"]),
        winningOrderCount: Number(row["winningOrderCount"]),
        losingOrderCount: Number(row["losingOrderCount"]),
        zeroPnlOrderCount: Number(row["zeroPnlOrderCount"]),
        totalBetsCents: Number(row["totalBetsCents"]),
        totalFeesCents: Number(row["totalFeesCents"]),
        grossWinningsCents: Number(row["grossWinningsCents"]),
        grossLossesCents: Number(row["grossLossesCents"]),
        netRealizedPnlCents: Number(row["netRealizedPnlCents"]),
      })),
    };
  } catch (err) {
    logger.warn({ err }, "ETH420 candidate daily P&L read failed");
    return { available: false, rows: [] };
  }
}

/**
 * Read-only current candidate lifecycle view for the operations dashboard.
 * An empty result is distinct from unavailable storage so callers never
 * misrepresent an unreadable ledger as no live exposure.
 */
export async function readCurrentEth420CandidateLivePosition(): Promise<{
  available: boolean; position: Eth420CandidateLiveOrder | null;
}> {
  if (!_db || !_healthy) return { available: false, position: null };
  try {
    const result = await _db.execute(sql`
      SELECT * FROM eth420_candidate_live_orders
      WHERE status NOT IN ('settled', 'rejected_insufficient_balance')
      ORDER BY updated_at_ms DESC
      LIMIT 1`);
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    return { available: true, position: row ? mapEth420CandidateLiveOrder(row) : null };
  } catch (err) {
    logger.warn({ err }, "ETH420 candidate live position dashboard read failed");
    return { available: false, position: null };
  }
}

/**
 * Read-only complete lifecycle snapshot for the operator's secondary-cross
 * activation assessment. It is intentionally separate from normal entry and
 * never participates in any order or emergency fence decision.
 *
 * The bounded result must be explicitly complete before it can support SAFE;
 * more rows than the bound are indistinguishable from incomplete evidence.
 */
export async function readEth420CandidateSecondaryActivationLedger(): Promise<{
  available: boolean;
  complete: boolean;
  orders: Eth420CandidateLiveOrder[];
  emergencyLifecycleExists: boolean;
}> {
  if (!_db || !_healthy) {
    return { available: false, complete: false, orders: [], emergencyLifecycleExists: true };
  }
  try {
    const limit = 101;
    const [ordersResult, emergencyResult] = await Promise.all([
      _db.execute(sql`
        SELECT candidate.*,
          EXISTS (
            SELECT 1 FROM eth420_candidate_telemetry telemetry
            WHERE telemetry.id LIKE candidate.id || ':secondary-entry:%'
              AND telemetry.payload_json::jsonb ->> 'event' IN
                ('cancel_requested', 'cancel_confirmed', 'submit_started', 'bind_confirmed')
          ) AS secondary_lifecycle_transition_active
        FROM eth420_candidate_live_orders candidate
        WHERE status NOT IN ('settled', 'rejected_insufficient_balance')
        ORDER BY created_at_ms ASC
        LIMIT ${limit}`),
      _db.execute(sql`SELECT 1 FROM eth420_candidate_emergency_reductions LIMIT 1`),
    ]);
    const rows = (ordersResult as unknown as { rows: Array<Record<string, unknown>> }).rows;
    return {
      available: true,
      complete: rows.length < limit,
      orders: rows.slice(0, limit - 1).map((row) => ({
        ...mapEth420CandidateLiveOrder(row),
        secondaryLifecycleTransitionActive: row["secondary_lifecycle_transition_active"] === true,
      })),
      emergencyLifecycleExists: (emergencyResult as unknown as { rows: unknown[] }).rows.length > 0,
    };
  } catch (err) {
    logger.warn({ err }, "ETH420 secondary-cross activation ledger read failed");
    return { available: false, complete: false, orders: [], emergencyLifecycleExists: true };
  }
}

/** Atomically records exact candidate fill economics and only then changes candidate daily state. */
export async function settleEth420CandidateLiveOrder(params: {
  id: string; result: "yes" | "no"; filledContracts: number; realizedPnlDeltaCents: number; nextState: Eth420CandidateState;
  expectedState?: Eth420CandidateState | null;
  actualNotionalDollars: string | null; actualFeeDollars: string | null; fillPriceCents: number | null;
}): Promise<boolean> {
  if (!_db || !_healthy || !params.id || !["yes", "no"].includes(params.result)
    || !Number.isFinite(params.filledContracts) || params.filledContracts < 0
    || (params.filledContracts === 0
      ? params.actualNotionalDollars !== null || params.actualFeeDollars !== null || params.fillPriceCents !== null
      : !/^\d+(?:\.\d+)?$/.test(params.actualNotionalDollars ?? "")
        || !/^\d+(?:\.\d+)?$/.test(params.actualFeeDollars ?? "")
        || params.fillPriceCents == null || !Number.isInteger(params.fillPriceCents)
        || params.fillPriceCents < 0 || params.fillPriceCents > 100)) return false;
  try {
    return await _db.transaction(async (tx) => {
      // This lock spans all candidate rows for a day, not merely the order
      // being settled. It prevents two recovery callers from accepting stale
      // state and overwriting chronological P&L or ladder progression.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-candidate-settlement:" + params.nextState.easternDate}))`);
      const locked = await tx.execute(sql`
        SELECT status, eastern_date, created_at_ms, ticker, side, market_open_time_ms FROM eth420_candidate_live_orders
        WHERE id=${params.id} FOR UPDATE`);
      const row = (locked as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!row) return false;
      if (row["status"] === "settled") return true;
      if (row["eastern_date"] !== params.nextState.easternDate) return false;
      const reductions = await tx.execute(sql`SELECT 1 FROM eth420_candidate_emergency_reductions
        WHERE candidate_order_id=${params.id} FOR UPDATE`);
      if ((reductions as unknown as { rows: unknown[] }).rows.length > 0) return false;
      const earlier = await tx.execute(sql`
        SELECT id FROM eth420_candidate_live_orders
        WHERE eastern_date=${params.nextState.easternDate}
          AND (created_at_ms < ${Number(row["created_at_ms"])}
            OR (created_at_ms = ${Number(row["created_at_ms"])} AND id < ${params.id}))
          AND status NOT IN ('settled', 'rejected_insufficient_balance')
        FOR UPDATE`);
      if ((earlier as unknown as { rows: unknown[] }).rows.length > 0) return false;
      const stateResult = await tx.execute(sql`
        SELECT eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms
        FROM eth420_candidate_daily_state WHERE eastern_date=${params.nextState.easternDate} FOR UPDATE`);
      const stateRow = (stateResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      const actualState = stateRow ? {
        easternDate: String(stateRow["eastern_date"]),
        side: stateRow["side"] === "yes" ? "yes" as const : "no" as const,
        step: Number(stateRow["martingale_step"]),
        realizedPnlCents: Number(stateRow["realized_pnl_cents"]),
        lastBlockResetAtMs: stateRow["last_block_reset_at_ms"] == null ? null : Number(stateRow["last_block_reset_at_ms"]),
      } : null;
      if (params.expectedState !== undefined
        && JSON.stringify(actualState) !== JSON.stringify(params.expectedState)) return false;
      // A Back Flip is a one-window overlay, never a martingale attempt. Lock
      // and recognize its durable claim here (the last state-write fence), so
      // its win/loss remains auditable on the order but cannot mutate the
      // parked ordinary candidate state that C must resume from.
      const backFlip = await tx.execute(sql`SELECT source_candidate_order_id
        FROM eth420_candidate_back_flip_overrides
        WHERE candidate_order_id=${params.id} AND status='reserved' FOR UPDATE`);
      const isBackFlip = (backFlip as unknown as { rows: unknown[] }).rows.length === 1;
      if (isBackFlip && !actualState) return false;
      const state = isBackFlip
        ? actualState!
        : {
          ...params.nextState,
          realizedPnlCents: (actualState?.realizedPnlCents ?? params.nextState.realizedPnlCents - params.realizedPnlDeltaCents)
            + params.realizedPnlDeltaCents,
        };
      await tx.execute(sql`
        INSERT INTO eth420_candidate_daily_state
          (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
        VALUES (${state.easternDate}, ${state.side}, ${state.step}, ${state.realizedPnlCents}, ${state.lastBlockResetAtMs}, ${Date.now()})
        ON CONFLICT (eastern_date) DO UPDATE SET side=EXCLUDED.side, martingale_step=EXCLUDED.martingale_step,
          realized_pnl_cents=EXCLUDED.realized_pnl_cents, last_block_reset_at_ms=EXCLUDED.last_block_reset_at_ms, updated_at_ms=EXCLUDED.updated_at_ms`);
      await tx.execute(sql`
        UPDATE eth420_candidate_live_orders SET status='settled', settlement_result=${params.result},
          filled_contracts=${params.filledContracts}, realized_pnl_delta_cents=${params.realizedPnlDeltaCents},
           actual_notional_dollars=${params.actualNotionalDollars}, actual_fee_dollars=${params.actualFeeDollars},
           fill_price_cents=${params.fillPriceCents},
          state_after_json=${JSON.stringify(state)}, settled_at_ms=${Date.now()}, updated_at_ms=${Date.now()} WHERE id=${params.id}`);
       await tx.execute(sql`UPDATE eth420_candidate_back_flip_overrides
         SET status='settled', resolved_at_ms=${Date.now()}
         WHERE candidate_order_id=${params.id} AND status='reserved'`);
       // This branch is reachable only after recovery independently proved an
       // official terminal result, complete zero fill history, and zero/absent
       // authenticated position. Legacy rows without official open time cannot
       // be safely mapped to a successor and therefore never arm an override.
       const sourceOpenTimeMs = Number(row["market_open_time_ms"]);
       if (!isBackFlip && params.filledContracts === 0 && Number.isInteger(sourceOpenTimeMs)
         && sourceOpenTimeMs > 0 && sourceOpenTimeMs % 900_000 === 0) {
         await tx.execute(sql`INSERT INTO eth420_candidate_back_flip_overrides
           (source_candidate_order_id, source_ticker, source_open_time_ms, missed_side,
            target_open_time_ms, status, armed_at_ms)
           VALUES (${params.id}, ${String(row["ticker"])}, ${sourceOpenTimeMs}, ${String(row["side"])},
             ${sourceOpenTimeMs + 900_000}, 'armed', ${Date.now()})
           ON CONFLICT (source_candidate_order_id) DO NOTHING`);
       }
      _lastWriteMs = Date.now();
      return true;
    });
  } catch (err) {
    logger.warn({ err, id: params.id }, "ETH420 candidate live settlement failed");
    return false;
  }
}

export interface Eth420EmergencyReduction {
  idempotencyKey: string; candidateOrderId: string; ticker: string;
  candidateKalshiOrderId: string; heldSide: "yes" | "no"; requestedContracts: number;
  clientOrderId: string; operatorReason: string; confirmation: string;
  expectedExitSide: "ask" | "bid";
  submittedLimitPriceCents: number | null; exchangeIndex: number | null;
  reconciledFillContracts: number | null; reconciledFeeDollars: string | null; reconciledResidualPosition: number | null;
  status: string; exitKalshiOrderId: string | null; failureReason: string | null;
  createdAtMs: number; updatedAtMs: number;
}

function mapEth420EmergencyReduction(row: Record<string, unknown>): Eth420EmergencyReduction {
  return {
    idempotencyKey: String(row["idempotency_key"]), candidateOrderId: String(row["candidate_order_id"]),
    ticker: String(row["ticker"]), candidateKalshiOrderId: String(row["candidate_kalshi_order_id"]),
    heldSide: row["held_side"] === "yes" ? "yes" : "no", requestedContracts: Number(row["requested_contracts"]),
    clientOrderId: String(row["client_order_id"]), operatorReason: String(row["operator_reason"]),
    confirmation: String(row["confirmation"]),
    expectedExitSide: row["expected_exit_side"] === "bid" ? "bid" : "ask",
    submittedLimitPriceCents: row["submitted_limit_price_cents"] == null ? null : Number(row["submitted_limit_price_cents"]),
    exchangeIndex: row["exchange_index"] == null ? null : Number(row["exchange_index"]),
    reconciledFillContracts: row["reconciled_fill_contracts"] == null ? null : Number(row["reconciled_fill_contracts"]),
    reconciledFeeDollars: row["reconciled_fee_dollars"] == null ? null : String(row["reconciled_fee_dollars"]),
    reconciledResidualPosition: row["reconciled_residual_position"] == null ? null : Number(row["reconciled_residual_position"]),
    status: String(row["status"]), exitKalshiOrderId: row["exit_kalshi_order_id"] == null ? null : String(row["exit_kalshi_order_id"]),
    failureReason: row["failure_reason"] == null ? null : String(row["failure_reason"]),
    createdAtMs: Number(row["created_at_ms"]), updatedAtMs: Number(row["updated_at_ms"]),
  };
}

/** A durable, candidate-only pre-POST reservation.  Existing idempotency rows
 * are returned verbatim; callers must never issue a second exchange POST. */
export async function reserveEth420CandidateEmergencyReduction(params: {
  idempotencyKey: string; candidateOrderId: string; ticker: string; candidateKalshiOrderId: string;
  heldSide: "yes" | "no"; requestedContracts: number; clientOrderId: string; operatorReason: string; confirmation: string;
  expectedExitSide: "ask" | "bid";
  submittedLimitPriceCents: number; exchangeIndex: number;
}): Promise<{ kind: "reserved"; reduction: Eth420EmergencyReduction } | { kind: "existing"; reduction: Eth420EmergencyReduction } | { kind: "blocked" }> {
  if (!_db || !_healthy || !/^[A-Za-z0-9._:-]{16,200}$/.test(params.idempotencyKey)
    || !params.candidateOrderId || !params.ticker || !params.candidateKalshiOrderId
    || !["yes", "no"].includes(params.heldSide) || !Number.isInteger(params.requestedContracts)
    || params.requestedContracts < 1 || !/^[A-Za-z0-9._:-]{16,240}$/.test(params.clientOrderId)
    || params.confirmation !== "REDUCE_ETH420_CANDIDATE_POSITION"
    || !["ask", "bid"].includes(params.expectedExitSide)
    || params.operatorReason.trim().length < 12 || params.operatorReason.trim().length > 500
    || !Number.isInteger(params.submittedLimitPriceCents) || params.submittedLimitPriceCents < 1 || params.submittedLimitPriceCents > 99
    || !Number.isInteger(params.exchangeIndex) || params.exchangeIndex < 0) return { kind: "blocked" };
  let durableLifecycleFound = false;
  try {
    const reservation = await _db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-candidate-emergency-global-fence"}))`);
      const existing = await tx.execute(sql`SELECT * FROM eth420_candidate_emergency_reductions
        WHERE idempotency_key=${params.idempotencyKey} FOR UPDATE`);
      const old = (existing as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (old) {
        durableLifecycleFound = true;
        return { kind: "existing" as const, reduction: mapEth420EmergencyReduction(old) };
      }
      const priorForCandidate = await tx.execute(sql`SELECT 1 FROM eth420_candidate_emergency_reductions
        WHERE candidate_order_id=${params.candidateOrderId} FOR UPDATE`);
      if ((priorForCandidate as unknown as { rows: unknown[] }).rows.length > 0) {
        durableLifecycleFound = true;
        return { kind: "blocked" as const };
      }
      const candidate = await tx.execute(sql`SELECT ticker, side, kalshi_order_id, filled_contracts, status
        FROM eth420_candidate_live_orders WHERE id=${params.candidateOrderId} FOR UPDATE`);
      const row = (candidate as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!row || row["ticker"] !== params.ticker || row["side"] !== params.heldSide
        || row["kalshi_order_id"] !== params.candidateKalshiOrderId
        || !Number.isInteger(Number(row["filled_contracts"])) || Number(row["filled_contracts"]) < params.requestedContracts
        || ["settled", "rejected_insufficient_balance"].includes(String(row["status"]))) return { kind: "blocked" as const };
      const now = Date.now();
      const inserted = await tx.execute(sql`INSERT INTO eth420_candidate_emergency_reductions
        (idempotency_key, candidate_order_id, ticker, candidate_kalshi_order_id, held_side, requested_contracts, client_order_id, operator_reason, confirmation, expected_exit_side, submitted_limit_price_cents, exchange_index, status, created_at_ms, updated_at_ms)
        VALUES (${params.idempotencyKey}, ${params.candidateOrderId}, ${params.ticker}, ${params.candidateKalshiOrderId},
          ${params.heldSide}, ${params.requestedContracts}, ${params.clientOrderId}, ${params.operatorReason.trim()}, ${params.confirmation}, ${params.expectedExitSide}, ${params.submittedLimitPriceCents}, ${params.exchangeIndex}, 'post_pending_recovery_required', ${now}, ${now})
        RETURNING *`);
      _lastWriteMs = now;
      durableLifecycleFound = true;
      return { kind: "reserved" as const, reduction: mapEth420EmergencyReduction(
        (inserted as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!,
      ) };
    });
    if (durableLifecycleFound) {
      _eth420CandidateEmergencyLifecycleDurable = true;
      _eth420CandidateEmergencyFenceActive = true;
    }
    return reservation;
  } catch (err) {
    logger.warn({ err, candidateOrderId: params.candidateOrderId }, "ETH420 emergency reduction reservation failed");
    return { kind: "blocked" };
  }
}

export async function acknowledgeEth420CandidateEmergencyReduction(
  idempotencyKey: string, exitKalshiOrderId: string | null, status: "submitted" | "submission_ambiguous" | "rejected",
  failureReason: string | null = null,
): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    const result = await _db.execute(sql`UPDATE eth420_candidate_emergency_reductions SET
      exit_kalshi_order_id=${exitKalshiOrderId}, status=${status}, failure_reason=${failureReason}, acknowledged_at_ms=${Date.now()}, updated_at_ms=${Date.now()}
      WHERE idempotency_key=${idempotencyKey} AND status='post_pending_recovery_required'`);
    return ((result as unknown as { rowCount?: number }).rowCount ?? 0) === 1;
  } catch { return false; }
}

export async function getEth420CandidateEmergencyReduction(idempotencyKey: string): Promise<Eth420EmergencyReduction | null> {
  if (!_db || !_healthy || !idempotencyKey) return null;
  try {
    const result = await _db.execute(sql`SELECT * FROM eth420_candidate_emergency_reductions WHERE idempotency_key=${idempotencyKey}`);
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    return row ? mapEth420EmergencyReduction(row) : null;
  } catch { return null; }
}

/** Writes only scalar, authenticated recovery evidence.  Anything other than
 * an exact full exit is deliberately retained as resolved_blocking. */
export async function reconcileEth420CandidateEmergencyReduction(params: {
  idempotencyKey: string; exitKalshiOrderId: string; fillContracts: number; feeDollars: string;
  residualPosition: number; outcome: "completed" | "resolved_blocking";
}): Promise<boolean> {
  if (!_db || !_healthy || !Number.isInteger(params.fillContracts) || !Number.isInteger(params.residualPosition)
    || !/^-?\d+(?:\.\d+)?$/.test(params.feeDollars)) return false;
  try {
    const result = await _db.execute(sql`UPDATE eth420_candidate_emergency_reductions SET
      exit_kalshi_order_id=${params.exitKalshiOrderId}, status=${params.outcome}, reconciled_at_ms=${Date.now()},
      reconciliation_result=${params.outcome}, reconciled_fill_contracts=${params.fillContracts},
      reconciled_fee_dollars=${params.feeDollars}, reconciled_residual_position=${params.residualPosition}, updated_at_ms=${Date.now()}
      WHERE idempotency_key=${params.idempotencyKey}`);
    return ((result as unknown as { rowCount?: number }).rowCount ?? 0) === 1;
  } catch { return false; }
}

export async function hasUnresolvedEth420CandidateEmergencyReduction(candidateOrderId: string): Promise<boolean> {
  if (!_db || !_healthy) return true;
  try {
    const result = await _db.execute(sql`SELECT 1 FROM eth420_candidate_emergency_reductions
      WHERE candidate_order_id=${candidateOrderId} LIMIT 1`);
    return (result as unknown as { rows: unknown[] }).rows.length > 0;
  } catch { return true; }
}
export async function recordEth420CandidateTelemetry(params: Eth420CandidateTelemetryParams): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    await _db.execute(sql`
      INSERT INTO eth420_candidate_telemetry
        (id, ticker, eastern_date, observed_at_ms, floor_strike, payload_json)
      VALUES (${params.id}, ${params.ticker}, ${params.easternDate}, ${params.observedAtMs},
        ${params.floorStrike}, ${params.payloadJson})
      ON CONFLICT (id) DO NOTHING`);
    _lastWriteMs = Date.now();
    return true;
  } catch (err) {
    logger.warn({ err, ticker: params.ticker }, "ETH 420 candidate telemetry lost");
    return false;
  }
}

/**
 * Atomically claims the one permitted secondary-entry evaluation for a primary
 * candidate order. This is an execution fence only: it neither changes its
 * ladder state nor authorizes an exchange submission on its own.
 */
export async function claimEth420CandidateSecondaryEntryAttempt(params: {
  candidateOrderId: string; attemptedAtMs: number; reservationAskCents: number | null;
}): Promise<boolean> {
  if (!_db || !_healthy || !params.candidateOrderId || !Number.isInteger(params.attemptedAtMs)
    || (params.reservationAskCents != null && (!Number.isInteger(params.reservationAskCents)
      || params.reservationAskCents < 1 || params.reservationAskCents > 99))) return false;
  try {
    const result = await _db.execute(sql`
      INSERT INTO eth420_candidate_telemetry (id, ticker, eastern_date, observed_at_ms, floor_strike, payload_json)
      SELECT ${params.candidateOrderId + ":secondary-entry:v1:attempt"}, ticker, eastern_date,
        ${params.attemptedAtMs}, NULL,
        ${JSON.stringify({ schemaVersion: 1, kind: "secondary_entry_attempt",
          reservationAskCents: params.reservationAskCents })}
      FROM eth420_candidate_live_orders
      WHERE id=${params.candidateOrderId}
      ON CONFLICT (id) DO NOTHING
      RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, candidateOrderId: params.candidateOrderId }, "ETH420 secondary entry attempt claim failed");
    return false;
  }
}

/** Append-only, scalar-only audit evidence for the secondary-entry candidate.
 * It is intentionally separate from candidate settlement and sequence state. */
export async function recordEth420CandidateSecondaryEntryEvent(params: {
  candidateOrderId: string; atMs: number; event: string; reason: string | null;
  reservationAskCents: number | null; currentAskCents: number | null;
  primaryOrderId?: string | null; secondaryClientOrderId?: string | null; secondaryOrderId?: string | null;
}): Promise<boolean> {
  const valid = params.candidateOrderId && Number.isInteger(params.atMs)
    && /^[a-z_]{1,80}$/.test(params.event)
    && (params.reason == null || /^[a-z_]{1,80}$/.test(params.reason))
    && [params.reservationAskCents, params.currentAskCents].every((value) => value == null
      || (Number.isInteger(value) && value >= 1 && value <= 99))
    && [params.primaryOrderId, params.secondaryClientOrderId, params.secondaryOrderId].every((value) =>
      value == null || (typeof value === "string" && value.length > 0 && value.length <= 256));
  if (!_db || !_healthy || !valid) return false;
  try {
    const result = await _db.execute(sql`
      INSERT INTO eth420_candidate_telemetry (id, ticker, eastern_date, observed_at_ms, floor_strike, payload_json)
      SELECT ${params.candidateOrderId + ":secondary-entry:v1:" + params.event + ":" + params.atMs},
        ticker, eastern_date, ${params.atMs}, NULL,
        ${JSON.stringify({ schemaVersion: 1, kind: "secondary_entry_event", event: params.event,
          reason: params.reason, reservationAskCents: params.reservationAskCents, currentAskCents: params.currentAskCents,
          primaryOrderId: params.primaryOrderId ?? null, secondaryClientOrderId: params.secondaryClientOrderId ?? null,
          secondaryOrderId: params.secondaryOrderId ?? null })}
      FROM eth420_candidate_live_orders
      WHERE id=${params.candidateOrderId}
      ON CONFLICT (id) DO NOTHING
      RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, candidateOrderId: params.candidateOrderId }, "ETH420 secondary entry event write failed");
    return false;
  }
}
export async function listEth420CandidateTelemetry(afterMs: number): Promise<Eth420CandidateTelemetryParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const result = await _db.execute(sql`
      SELECT id, ticker, eastern_date, observed_at_ms, floor_strike, payload_json
      FROM eth420_candidate_telemetry
      WHERE observed_at_ms >= ${afterMs}
      ORDER BY observed_at_ms ASC`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => ({
      id: String(row["id"]), ticker: String(row["ticker"]), easternDate: String(row["eastern_date"]),
      observedAtMs: Number(row["observed_at_ms"]), floorStrike: row["floor_strike"] == null ? null : Number(row["floor_strike"]),
      payloadJson: String(row["payload_json"]),
    }));
  } catch (err) {
    logger.warn({ err }, "ETH 420 candidate telemetry read failed");
    return [];
  }
}

export interface Eth420CounterfactualEntry {
  id: string; ticker: string; easternDate: string; observedAtMs: number;
  side: "yes" | "no"; step: number; effectiveWagerCents: number;
  decisionPayloadJson: string; stateBeforeJson: string;
  settlementResult: "yes" | "no" | null; filledContracts: number | null;
  realizedPnlDeltaCents: number | null; settledAtMs: number | null; stateAfterJson: string | null;
}

/** Records a hypothetical candidate entry. It is not an order, claim, or reservation. */
export async function recordEth420CounterfactualEntry(params: Omit<Eth420CounterfactualEntry,
  "settlementResult" | "filledContracts" | "realizedPnlDeltaCents" | "settledAtMs" | "stateAfterJson">): Promise<boolean> {
  if (!_db || !_healthy || !params.id || !params.ticker || !["yes", "no"].includes(params.side)
    || !Number.isFinite(params.observedAtMs) || !Number.isFinite(params.effectiveWagerCents)) return false;
  let expected: Record<string, unknown>;
  try { expected = JSON.parse(params.stateBeforeJson) as Record<string, unknown>; }
  catch { return false; }
  if ((expected["side"] !== "yes" && expected["side"] !== "no")
    || !Number.isInteger(expected["step"]) || !Number.isFinite(expected["realizedPnlCents"])) return false;
  try {
    const recorded = await _db.transaction(async (tx) => {
      // Observer calls are fire-and-forget. A transaction-scoped global lock
      // makes "one unresolved sequence step" an atomic invariant.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(420420)`);
      const pending = await tx.execute(sql`
        SELECT id FROM eth420_candidate_entries WHERE settlement_result IS NULL LIMIT 1`);
      if ((pending as unknown as { rows: Array<unknown> }).rows.length > 0) return false;
      const stateResult = await tx.execute(sql`
        SELECT side, martingale_step, realized_pnl_cents, last_block_reset_at_ms
        FROM eth420_counterfactual_daily_state WHERE eastern_date=${params.easternDate}`);
      const stateRow = (stateResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      const actual = {
        side: stateRow?.["side"] === "yes" ? "yes" : "no",
        step: Number(stateRow?.["martingale_step"] ?? 0),
        realizedPnlCents: Number(stateRow?.["realized_pnl_cents"] ?? 0),
        lastBlockResetAtMs: stateRow?.["last_block_reset_at_ms"] == null ? null : Number(stateRow["last_block_reset_at_ms"]),
      };
      if (actual.side !== expected["side"] || actual.step !== Number(expected["step"])
        || actual.realizedPnlCents !== Number(expected["realizedPnlCents"])
        || actual.lastBlockResetAtMs !== (expected["lastBlockResetAtMs"] ?? null)) return false;
      const inserted = await tx.execute(sql`
        INSERT INTO eth420_candidate_entries
          (id, ticker, eastern_date, observed_at_ms, side, martingale_step, effective_wager_cents, decision_payload_json, state_before_json)
        VALUES (${params.id}, ${params.ticker}, ${params.easternDate}, ${Math.trunc(params.observedAtMs)}, ${params.side},
          ${Math.max(0, Math.min(5, Math.trunc(params.step)))}, ${Math.max(0, Math.trunc(params.effectiveWagerCents))},
          ${params.decisionPayloadJson}, ${params.stateBeforeJson})
        ON CONFLICT (id) DO NOTHING RETURNING id`);
      return (inserted as unknown as { rows: Array<unknown> }).rows.length > 0;
    });
    if (!recorded) return false;
    _lastWriteMs = Date.now();
    // If a confirmed outcome was already durably written before this observer
    // ran, settle immediately from SQL. This is still counterfactual-only.
    const known = await _db.execute(sql`SELECT result FROM market_results WHERE ticker=${params.ticker}`);
    const result = (known as unknown as { rows: Array<Record<string, unknown>> }).rows[0]?.["result"];
    if (result === "yes" || result === "no") await settleEth420CounterfactualEntry(params.id, result);
    return true;
  } catch (err) {
    logger.warn({ err, ticker: params.ticker }, "ETH 420 counterfactual entry write failed");
    return false;
  }
}

function mapEth420CounterfactualEntry(row: Record<string, unknown>): Eth420CounterfactualEntry {
  return {
    id: String(row["id"]), ticker: String(row["ticker"]), easternDate: String(row["eastern_date"]),
    observedAtMs: Number(row["observed_at_ms"]), side: row["side"] === "yes" ? "yes" : "no",
    step: Math.max(0, Math.min(5, Number(row["martingale_step"]))), effectiveWagerCents: Number(row["effective_wager_cents"]),
    decisionPayloadJson: String(row["decision_payload_json"]), stateBeforeJson: String(row["state_before_json"]),
    settlementResult: row["settlement_result"] === "yes" || row["settlement_result"] === "no" ? row["settlement_result"] : null,
    filledContracts: row["filled_contracts"] == null ? null : Number(row["filled_contracts"]),
    realizedPnlDeltaCents: row["realized_pnl_delta_cents"] == null ? null : Number(row["realized_pnl_delta_cents"]),
    settledAtMs: row["settled_at_ms"] == null ? null : Number(row["settled_at_ms"]),
    stateAfterJson: row["state_after_json"] == null ? null : String(row["state_after_json"]),
  };
}

/** Read-only counterfactual history. Every row has an explicit no-order/no-fill assumption. */
export async function listEth420CounterfactualEntries(limit = 100): Promise<Eth420CounterfactualEntry[]> {
  if (!_db || !_healthy) return [];
  try {
    const result = await _db.execute(sql`
      SELECT id, ticker, eastern_date, observed_at_ms, side, martingale_step, effective_wager_cents,
        decision_payload_json, state_before_json, settlement_result, filled_contracts,
        realized_pnl_delta_cents, settled_at_ms, state_after_json
      FROM eth420_candidate_entries ORDER BY observed_at_ms DESC
      LIMIT ${Math.min(500, Math.max(1, Math.trunc(limit)))}`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map(mapEth420CounterfactualEntry);
  } catch (err) {
    logger.warn({ err }, "ETH 420 counterfactual history read failed");
    return [];
  }
}

/** Applies one authoritative market result as a zero-fill candidate transition, atomically and idempotently. */
export async function settleEth420CounterfactualEntry(id: string, result: "yes" | "no"): Promise<boolean> {
  if (!_db || !_healthy || !id || !["yes", "no"].includes(result)) return false;
  try {
    return await _db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(420420)`);
      const entryResult = await tx.execute(sql`
        SELECT id, eastern_date, side, martingale_step, settlement_result, state_before_json FROM eth420_candidate_entries
        WHERE id=${id} FOR UPDATE`);
      const entry = (entryResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!entry) return false;
      if (entry["settlement_result"] === "yes" || entry["settlement_result"] === "no") return true;
      const easternDate = String(entry["eastern_date"]);
      // The entry snapshot, rather than the mutable daily row, is
      // authoritative. A later blocked observation is allowed to reset the
      // prospective gate but must not change this already-recorded sequence.
      let captured: Record<string, unknown>;
      try { captured = JSON.parse(String(entry["state_before_json"])) as Record<string, unknown>; }
      catch { return false; }
      if ((captured["side"] !== "yes" && captured["side"] !== "no")
        || !Number.isInteger(captured["step"]) || Number(captured["step"]) < 0 || Number(captured["step"]) > 5
        || !Number.isFinite(captured["realizedPnlCents"])) return false;
      const before = {
        easternDate, side: captured["side"] as "yes" | "no", step: Number(captured["step"]),
        realizedPnlCents: Number(captured["realizedPnlCents"]),
        lastBlockResetAtMs: typeof captured["lastBlockResetAtMs"] === "number" ? captured["lastBlockResetAtMs"] : null,
      };
      const sequence = advanceEth420CandidateSequence(before, result);
      const after = { ...before, ...sequence };
      const event = await tx.execute(sql`
        INSERT INTO eth420_counterfactual_settlement_events (id, eastern_date, realized_pnl_delta_cents, applied_at_ms)
        VALUES (${"counterfactual:" + id}, ${easternDate}, 0, ${Date.now()})
        ON CONFLICT (id) DO NOTHING RETURNING id`);
      if ((event as unknown as { rows: Array<unknown> }).rows.length === 0) return true;
      await tx.execute(sql`
        INSERT INTO eth420_counterfactual_daily_state
          (eastern_date, side, martingale_step, realized_pnl_cents, last_block_reset_at_ms, updated_at_ms)
        VALUES (${after.easternDate}, ${after.side}, ${after.step}, ${after.realizedPnlCents}, ${after.lastBlockResetAtMs}, ${Date.now()})
        ON CONFLICT (eastern_date) DO UPDATE SET side=EXCLUDED.side, martingale_step=EXCLUDED.martingale_step,
          realized_pnl_cents=EXCLUDED.realized_pnl_cents, last_block_reset_at_ms=EXCLUDED.last_block_reset_at_ms,
          updated_at_ms=EXCLUDED.updated_at_ms`);
      await tx.execute(sql`
        UPDATE eth420_candidate_entries SET settlement_result=${result}, filled_contracts=0,
          realized_pnl_delta_cents=0, settled_at_ms=${Date.now()}, state_after_json=${JSON.stringify(after)}
        WHERE id=${id} AND settlement_result IS NULL`);
      _lastWriteMs = Date.now();
      return true;
    });
  } catch (err) {
    logger.warn({ err, id }, "ETH 420 counterfactual settlement failed");
    return false;
  }
}

/** Settles pending candidate entries for one market using a supplied authoritative outcome only. */
export async function settleEth420CounterfactualEntriesForTicker(ticker: string, result: "yes" | "no"): Promise<number> {
  if (!_db || !_healthy || !ticker || !["yes", "no"].includes(result)) return 0;
  const rows = await _db.execute(sql`
    SELECT id FROM eth420_candidate_entries WHERE ticker=${ticker} AND settlement_result IS NULL`);
  let settled = 0;
  for (const row of (rows as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    if (await settleEth420CounterfactualEntry(String(row["id"]), result)) settled++;
  }
  return settled;
}

/** Replays pending counterfactual entries after restart from already-persisted authoritative results. */
export async function backfillEth420CounterfactualSettlements(): Promise<number> {
  if (!_db || !_healthy) return 0;
  try {
    const rows = await _db.execute(sql`
      SELECT e.id, m.result FROM eth420_candidate_entries e
      JOIN market_results m ON m.ticker=e.ticker
      WHERE e.settlement_result IS NULL AND m.result IN ('yes', 'no')
      ORDER BY e.observed_at_ms ASC`);
    let settled = 0;
    for (const row of (rows as unknown as { rows: Array<Record<string, unknown>> }).rows) {
      const result = row["result"];
      if ((result === "yes" || result === "no")
        && await settleEth420CounterfactualEntry(String(row["id"]), result)) settled++;
    }
    return settled;
  } catch (err) {
    logger.warn({ err }, "ETH 420 counterfactual settlement backfill failed");
    return 0;
  }
}
export interface Eth30ShadowEventParams {
  id: string; ticker: string; signal: string; triggeredAtMs: number; payloadJson: string;
}
export async function insertEth30ShadowObservation(params: Eth30ShadowObservationParams): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    const inserted = await _db.insert(eth30ShadowObservations).values(params)
      .onConflictDoNothing().returning({ id: eth30ShadowObservations.id });
    if (inserted.length) _lastWriteMs = Date.now();
    return inserted.length > 0;
  } catch (err) {
    logger.warn({ err, ticker: params.ticker }, "eth30 shadow observation lost");
    return false;
  }
}
export async function listEth30ShadowObservations(ticker: string, afterMs = 0): Promise<Eth30ShadowObservationParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.select().from(eth30ShadowObservations)
      .where(and(eq(eth30ShadowObservations.ticker, ticker), gte(eth30ShadowObservations.observedAtMs, afterMs)))
      .orderBy(asc(eth30ShadowObservations.observedAtMs));
    return rows.map((r) => ({ id: r.id, ticker: r.ticker, observedAtMs: r.observedAtMs, payloadJson: r.payloadJson }));
  } catch (err) {
    logger.warn({ err, ticker }, "eth30: list shadow observations failed");
    return [];
  }
}
export async function upsertEth30ShadowEvent(params: Eth30ShadowEventParams): Promise<void> {
  if (!_db || !_healthy) return;
  try {
    await _db.insert(eth30ShadowEvents).values(params).onConflictDoUpdate({
      target: eth30ShadowEvents.id,
      set: { payloadJson: params.payloadJson, updatedAt: new Date() },
    });
    _lastWriteMs = Date.now();
  } catch (err) {
    logger.warn({ err, ticker: params.ticker }, "eth30 shadow event lost");
  }
}
export async function listEth30ShadowEvents(ticker: string): Promise<Eth30ShadowEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.select().from(eth30ShadowEvents)
      .where(eq(eth30ShadowEvents.ticker, ticker)).orderBy(asc(eth30ShadowEvents.triggeredAtMs));
    return rows.map((r) => ({ id: r.id, ticker: r.ticker, signal: r.signal, triggeredAtMs: r.triggeredAtMs, payloadJson: r.payloadJson }));
  } catch (err) {
    logger.warn({ err, ticker }, "eth30: list shadow events failed");
    return [];
  }
}

/**
 * Read-only loader for the shadow-signal report endpoint.
 * Returns all triggered ETH_30_50 shadow events across all tickers, newest first.
 * Optionally filtered to a single ticker.
 *
 * @param tickerFilter  When provided, only events for that ticker are returned.
 * @param limit         Maximum rows (1–2000, default 500).
 */
export async function listAllEth30ShadowEvents(
  tickerFilter?: string,
  limit = 500,
): Promise<Eth30ShadowEventParams[]> {
  if (!_db || !_healthy) return [];
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 2_000);
  try {
    const rows = tickerFilter
      ? await _db.select().from(eth30ShadowEvents)
          .where(eq(eth30ShadowEvents.ticker, tickerFilter))
          .orderBy(desc(eth30ShadowEvents.triggeredAtMs))
          .limit(safeLimit)
      : await _db.select().from(eth30ShadowEvents)
          .orderBy(desc(eth30ShadowEvents.triggeredAtMs))
          .limit(safeLimit);
    return rows.map((r) => ({ id: r.id, ticker: r.ticker, signal: r.signal, triggeredAtMs: r.triggeredAtMs, payloadJson: r.payloadJson }));
  } catch (err) {
    logger.warn({ err, tickerFilter }, "eth30: list all shadow events failed");
    return [];
  }
}

/** Read-only bounded loader for all passive ETH shadow observation kinds. */
export async function listAllEth30ShadowObservations(limit = 10_000): Promise<Eth30ShadowObservationParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.select().from(eth30ShadowObservations)
      .orderBy(desc(eth30ShadowObservations.observedAtMs)).limit(Math.min(Math.max(1, Math.trunc(limit)), 10_000));
    return rows.map((r) => ({ id: r.id, ticker: r.ticker, observedAtMs: r.observedAtMs, payloadJson: r.payloadJson }));
  } catch (err) {
    logger.warn({ err }, "eth30: list all shadow observations failed");
    return [];
  }
}

/** Bounded ETH_30_50 ledger read with an explicit failure state for runtime health. */
export async function loadEth30ActivityForRuntimeHealth(
  limit = 200,
): Promise<{ events: Eth30DecisionEventParams[]; available: boolean }> {
  if (!_db || !_healthy) return { events: [], available: false };
  try {
    const rows = await _db
      .select()
      .from(eth30DecisionEvents)
      .orderBy(desc(eth30DecisionEvents.occurredAtMs))
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
    return { events: rows.map(mapEth30DecisionRow), available: true };
  } catch (err) {
    logger.warn({ err }, "eth30: runtime activity read failed");
    return { events: [], available: false };
  }
}
/**
 * Return the distinct set of tickers that already have a settlement event in
 * the position-event ledger. Used at startup to pre-warm the in-memory
 * `_settledTickers` cache in eth30_50.ts with a single query so the first
 * periodic sweep incurs zero per-ticker SQL reads for already-settled markets.
 *
 * The result is bounded by the total number of ever-entered ETH_30_50 markets,
 * which grows slowly (at most one or two per day). [] when degraded.
 */
export async function listSettledEth30Tickers(): Promise<string[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.execute(sql`
      SELECT DISTINCT ticker
      FROM eth30_position_events
      WHERE event_type = 'settlement'
    `);
    const rawRows = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return rawRows.map((r) => String(r["ticker"]));
  } catch (err) {
    logger.warn({ err }, "eth30: listSettledEth30Tickers failed");
    return [];
  }
}

/**
 * List every ETH_30_50 ticker claim (all dates), newest first.
 * Used by the strategy-only report; the claims table is bounded (one row per
 * entered market) so a full read is safe. [] when degraded.
 */
export async function listAllEth30TickerClaims(): Promise<Eth30TickerClaim[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(eth30TickerClaims)
      .orderBy(desc(eth30TickerClaims.claimedAtMs));
    return rows.map((r) => ({
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    }));
  } catch (err) {
    logger.warn({ err }, "eth30: listAllEth30TickerClaims failed");
    return [];
  }
}

// ── SOL_30_50 isolated strategy APIs ─────────────────────────────────────────
//
// These APIs are the only SQL integration point for the SOL_30_50 strategy.
// They are an exact mirror of the ETH_30_50 APIs, operating on sol30_* tables.
// SOL is disabled by configuration; all APIs are wired but unreachable in
// normal operation.
//
// Safety contract (identical to ETH_30_50):
//   • claimSol30Ticker  — fail closed: returns false when storage is degraded
//     or the ticker has already been claimed.
//   • recordSol30StrategyOrder / updateSol30StrategyOrder — fail closed: return
//     false on storage degradation or unexpected SQL error.
//   • appendSol30PositionEvent — fire-and-forget on storage degradation (returns
//     false, never throws).
//   • listSol30PositionEvents / getSol30TickerClaim / listSol30StrategyOrders
//     — return null/[] on storage degradation (callers must handle that).

export interface Sol30TickerClaim {
  ticker:             string;
  easternDate:        string;
  claimedAtMs:        number;
  entryClientOrderId: string;
}

export interface Sol30StrategyOrderParams {
  /** "entry:{ticker}" or "exit:{ticker}:{sequenceNumber}" — caller provides stable PK. */
  id:                 string;
  ticker:             string;
  easternDate:        string;
  /** "entry" | "exit" */
  role:               "entry" | "exit";
  sequenceNumber:     number;
  clientOrderId:      string;
  side:               "yes" | "no";
  limitPriceCents:    number;
  requestedContracts: number;
}

export interface Sol30StrategyOrder extends Sol30StrategyOrderParams {
  kalshiOrderId:         string | null;
  /** "pending" | "full_fill" | "partial_fill" | "zero_fill" | "cancelled" | "error" | "unresolved" */
  outcome:               string;
  filledContracts:       number | null;
  averageFillPriceCents: number | null;
  updatedAtMs:           number;
}

export interface Sol30PositionEventParams {
  /** "${ticker}:${eventType}:${occurredAtMs}" — natural PK provided by caller. */
  id:              string;
  ticker:          string;
  easternDate:     string;
  /** "entry_fill" | "exit_fill" | "settlement" | "correction" */
  eventType:       "entry_fill" | "exit_fill" | "settlement" | "correction";
  contractsDelta:  number;
  contractsAfter:  number;
  strategyOrderId: string | null;
  fillPriceCents:  number | null;
  /** Exchange fee for this fill chunk in cents (rounded). Null for settlement events. */
  feeCents:        number | null;
  settlementResult: "yes" | "no" | null;
  note:            string | null;
  occurredAtMs:    number;
}

export interface Sol30StrategyOrderUpdate {
  /** The sol30_strategy_orders.id PK to update. */
  id:                    string;
  kalshiOrderId?:        string | null;
  outcome?:              string;
  filledContracts?:      number | null;
  averageFillPriceCents?: number | null;
}

export interface Sol30DecisionEventParams {
  /** Natural PK provided by the caller; once-only events use a stable id. */
  id:           string;
  ticker:       string;
  easternDate:  string;
  decision:     string;
  side:         "yes" | "no" | null;
  priceCents:   number | null;
  contracts:    number | null;
  note:         string | null;
  occurredAtMs: number;
}

/**
 * Atomically claim a ticker for the SOL_30_50 strategy.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING so the operation is idempotent and
 * race-safe: exactly one caller wins the claim even under concurrent writers.
 *
 * Returns true if the claim was inserted (caller may proceed to place the entry
 * order), or false if the ticker was already claimed or storage is degraded.
 *
 * FAIL CLOSED: returns false on any storage error — never throws.
 */
export async function claimSol30Ticker(
  ticker:             string,
  easternDate:        string,
  entryClientOrderId: string,
): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ ticker }, "sol30: claimSol30Ticker — storage degraded, returning false (fail closed)");
    return false;
  }
  const now = Date.now();
  try {
    const inserted = await _db
      .insert(sol30TickerClaims)
      .values({ ticker, easternDate, claimedAtMs: now, entryClientOrderId })
      .onConflictDoNothing()
      .returning({ ticker: sol30TickerClaims.ticker });
    const claimed = inserted.length > 0;
    if (!claimed) {
      logger.warn({ ticker }, "sol30: claimSol30Ticker — ticker already claimed (conflict)");
    } else {
      _lastWriteMs = Date.now();
      logger.info({ ticker, easternDate, entryClientOrderId }, "sol30: claimSol30Ticker — ticker claimed successfully");
    }
    return claimed;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `sol30.claimSol30Ticker failed: ${_lastErrorMsg}`;
    logger.error({ err, ticker }, "sol30: claimSol30Ticker FAILED — storage degraded, scheduling reconnect");
    recordDbBlockedOperation("entry");
    _scheduleRetry();
    return false;
  }
}

/** Atomically reserve a paired SOL market and both outcome-specific child rows. */
export async function reserveSol30PairedEntry(params: {
  ticker: string; easternDate: string; entryClientOrderId: string;
  orders: readonly [Sol30StrategyOrderParams, Sol30StrategyOrderParams];
}): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  try {
    return await _db.transaction(async (tx) => {
      const claim = await tx.insert(sol30TickerClaims)
        .values({ ticker: params.ticker, easternDate: params.easternDate, claimedAtMs: now, entryClientOrderId: params.entryClientOrderId })
        .onConflictDoNothing().returning({ ticker: sol30TickerClaims.ticker });
      if (claim.length !== 1) return false;
      const inserted = await tx.insert(sol30StrategyOrders).values(params.orders.map((order) => ({
        ...order, kalshiOrderId: null, outcome: "pending", filledContracts: null,
        averageFillPriceCents: null, updatedAtMs: now,
      }))).onConflictDoNothing().returning({ id: sol30StrategyOrders.id });
      if (inserted.length !== 2) throw new Error("SOL30_PAIR_RESERVATION_INCOMPLETE");
      _lastWriteMs = Date.now();
      return true;
    });
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err);
    _degradedReason = `sol30.reserveSol30PairedEntry failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("entry"); _scheduleRetry();
    logger.error({ err, ticker: params.ticker }, "sol30: paired reservation failed closed");
    return false;
  }
}

/**
 * Read an existing SOL_30_50 ticker claim, or null if not found / storage degraded.
 */
export async function getSol30TickerClaim(ticker: string): Promise<Sol30TickerClaim | null> {
  if (!_db || !_healthy) return null;
  try {
    const rows = await _db
      .select()
      .from(sol30TickerClaims)
      .where(eq(sol30TickerClaims.ticker, ticker))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    };
  } catch (err) {
    logger.warn({ err, ticker }, "sol30: getSol30TickerClaim failed");
    return null;
  }
}

/**
 * List all SOL_30_50 ticker claims for a given Eastern date, newest first.
 * Returns [] when storage is degraded or no rows exist.
 */
export async function listSol30TickerClaimsForDate(easternDate: string): Promise<Sol30TickerClaim[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30TickerClaims)
      .where(eq(sol30TickerClaims.easternDate, easternDate))
      .orderBy(desc(sol30TickerClaims.claimedAtMs));
    return rows.map((r) => ({
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    }));
  } catch (err) {
    logger.warn({ err, easternDate }, "sol30: listSol30TickerClaimsForDate failed");
    return [];
  }
}

/**
 * List all SOL_30_50 ticker claims for a set of Eastern dates, newest first.
 * Use this when reconciling across a day boundary (e.g., today + yesterday).
 * Returns [] when storage is degraded, dates is empty, or no rows exist.
 */
export async function listSol30TickerClaimsForDates(dates: string[]): Promise<Sol30TickerClaim[]> {
  if (!_db || !_healthy || dates.length === 0) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30TickerClaims)
      .where(inArray(sol30TickerClaims.easternDate, dates))
      .orderBy(desc(sol30TickerClaims.claimedAtMs));
    return rows.map((r) => ({
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    }));
  } catch (err) {
    logger.warn({ err, dates }, "sol30: listSol30TickerClaimsForDates failed");
    return [];
  }
}

/**
 * List every SOL_30_50 ticker claim (all dates), newest first.
 * Returns [] when storage is degraded.
 */
export async function listAllSol30TickerClaims(): Promise<Sol30TickerClaim[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30TickerClaims)
      .orderBy(desc(sol30TickerClaims.claimedAtMs));
    return rows.map((r) => ({
      ticker:             r.ticker,
      easternDate:        r.easternDate,
      claimedAtMs:        r.claimedAtMs,
      entryClientOrderId: r.entryClientOrderId,
    }));
  } catch (err) {
    logger.warn({ err }, "sol30: listAllSol30TickerClaims failed");
    return [];
  }
}

/**
 * Insert a SOL_30_50 strategy order record (entry or exit).
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency on retry.
 * Returns true on successful insert, false if row already exists or storage
 * is degraded. FAIL CLOSED — never throws.
 */
export async function recordSol30StrategyOrder(params: Sol30StrategyOrderParams): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ id: params.id }, "sol30: recordSol30StrategyOrder — storage degraded, returning false");
    return false;
  }
  const now = Date.now();
  try {
    const inserted = await _db
      .insert(sol30StrategyOrders)
      .values({
        id:                 params.id,
        ticker:             params.ticker,
        easternDate:        params.easternDate,
        role:               params.role,
        sequenceNumber:     params.sequenceNumber,
        clientOrderId:      params.clientOrderId,
        kalshiOrderId:      null,
        side:               params.side,
        limitPriceCents:    params.limitPriceCents,
        requestedContracts: params.requestedContracts,
        outcome:            "pending",
        filledContracts:    null,
        averageFillPriceCents: null,
        updatedAtMs:        now,
      })
      .onConflictDoNothing()
      .returning({ id: sol30StrategyOrders.id });
    const ok = inserted.length > 0;
    if (ok) {
      _lastWriteMs = Date.now();
      logger.info({ id: params.id, ticker: params.ticker, role: params.role }, "sol30: recordSol30StrategyOrder — order recorded");
    }
    return ok;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `sol30.recordSol30StrategyOrder failed: ${_lastErrorMsg}`;
    logger.error({ err, id: params.id }, "sol30: recordSol30StrategyOrder FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

/**
 * Update fill/outcome fields on an existing SOL_30_50 strategy order row.
 *
 * Idempotent: only the supplied fields are written; unspecified fields retain
 * their current values (partial update via explicit SET).
 * Returns true on success, false on storage degradation or row not found.
 * FAIL CLOSED — never throws.
 */
export async function updateSol30StrategyOrder(update: Sol30StrategyOrderUpdate): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ id: update.id }, "sol30: updateSol30StrategyOrder — storage degraded, returning false");
    return false;
  }
  const now = Date.now();
  const patch: Record<string, unknown> = { updatedAtMs: now, updatedAt: new Date() };
  if (update.kalshiOrderId !== undefined)        patch["kalshiOrderId"]         = update.kalshiOrderId;
  if (update.outcome !== undefined)               patch["outcome"]               = update.outcome;
  if (update.filledContracts !== undefined)       patch["filledContracts"]       = update.filledContracts;
  if (update.averageFillPriceCents !== undefined) patch["averageFillPriceCents"] = update.averageFillPriceCents;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await _db
      .update(sol30StrategyOrders)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set(patch as any)
      .where(eq(sol30StrategyOrders.id, update.id))
      .returning({ id: sol30StrategyOrders.id });
    const ok = result.length > 0;
    if (ok) {
      _lastWriteMs = Date.now();
      logger.info({ id: update.id, outcome: update.outcome }, "sol30: updateSol30StrategyOrder — order updated");
    } else {
      logger.warn({ id: update.id }, "sol30: updateSol30StrategyOrder — row not found");
    }
    return ok;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `sol30.updateSol30StrategyOrder failed: ${_lastErrorMsg}`;
    logger.error({ err, id: update.id }, "sol30: updateSol30StrategyOrder FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

/**
 * List SOL_30_50 strategy orders for a given ticker, ordered by sequence_number ASC.
 * Returns [] when storage is degraded or no rows exist.
 */
export async function listSol30StrategyOrders(ticker: string): Promise<Sol30StrategyOrder[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30StrategyOrders)
      .where(eq(sol30StrategyOrders.ticker, ticker))
      .orderBy(asc(sol30StrategyOrders.sequenceNumber));
    return rows.map((r) => ({
      id:                    r.id,
      ticker:                r.ticker,
      easternDate:           r.easternDate,
      role:                  r.role as "entry" | "exit",
      sequenceNumber:        r.sequenceNumber,
      clientOrderId:         r.clientOrderId,
      kalshiOrderId:         r.kalshiOrderId ?? null,
      side:                  r.side as "yes" | "no",
      limitPriceCents:       r.limitPriceCents,
      requestedContracts:    r.requestedContracts,
      outcome:               r.outcome,
      filledContracts:       r.filledContracts ?? null,
      averageFillPriceCents: r.averageFillPriceCents ?? null,
      updatedAtMs:           r.updatedAtMs,
      createdAtMs:           r.createdAt ? r.createdAt.getTime() : null,
    }));
  } catch (err) {
    logger.warn({ err, ticker }, "sol30: listSol30StrategyOrders failed");
    return [];
  }
}

/**
 * Append an immutable position event to the SOL_30_50 position event ledger.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency on replayed writes.
 * Returns true on success, false on storage degradation. Fire-and-forget safe.
 * FAIL CLOSED — never throws.
 */
export async function appendSol30PositionEvent(params: Sol30PositionEventParams): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ ticker: params.ticker, eventType: params.eventType }, "sol30: appendSol30PositionEvent — storage degraded, event lost");
    return false;
  }
  try {
    await _db
      .insert(sol30PositionEvents)
      .values({
        id:               params.id,
        ticker:           params.ticker,
        easternDate:      params.easternDate,
        eventType:        params.eventType,
        contractsDelta:   params.contractsDelta,
        contractsAfter:   params.contractsAfter,
        strategyOrderId:  params.strategyOrderId ?? null,
        fillPriceCents:   params.fillPriceCents ?? null,
        feeCents:         params.feeCents ?? null,
        settlementResult: params.settlementResult ?? null,
        note:             params.note ?? null,
        occurredAtMs:     params.occurredAtMs,
      })
      // On conflict (same id), only update fee_cents when the stored value is
      // still NULL — allows canonical rebuild to backfill exchange fees.
      .onConflictDoUpdate({
        target: sol30PositionEvents.id,
        set: { feeCents: sql`EXCLUDED.fee_cents` },
        setWhere: sql`${sol30PositionEvents.feeCents} IS NULL`,
      });
    _lastWriteMs = Date.now();
    logger.info(
      { id: params.id, ticker: params.ticker, eventType: params.eventType, delta: params.contractsDelta },
      "sol30: appendSol30PositionEvent — event appended or fee updated",
    );
    return true;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `sol30.appendSol30PositionEvent failed: ${_lastErrorMsg}`;
    logger.error({ err, ticker: params.ticker }, "sol30: appendSol30PositionEvent FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

/**
 * Delete SOL_30_50 position events by exact id. Used ONLY by canonical fill-ledger
 * rebuilds. Returns false when storage is degraded or the delete failed.
 */
export async function deleteSol30PositionEvents(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  if (!_db || !_healthy) {
    logger.warn({ ids }, "sol30: deleteSol30PositionEvents — storage degraded, skipped");
    return false;
  }
  try {
    await _db.delete(sol30PositionEvents).where(inArray(sol30PositionEvents.id, ids));
    _lastWriteMs = Date.now();
    logger.info({ ids }, "sol30: deleteSol30PositionEvents — legacy/stale fill events removed for canonical rebuild");
    return true;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `sol30.deleteSol30PositionEvents failed: ${_lastErrorMsg}`;
    logger.error({ err, ids }, "sol30: deleteSol30PositionEvents FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

/**
 * List SOL_30_50 position events for a given ticker, ordered by occurred_at_ms ASC
 * (chronological, suitable for replaying to recover current position).
 * Returns [] when storage is degraded or no rows exist for the ticker.
 */
export async function listSol30PositionEvents(ticker: string): Promise<Sol30PositionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30PositionEvents)
      .where(eq(sol30PositionEvents.ticker, ticker))
      .orderBy(asc(sol30PositionEvents.occurredAtMs));
    return rows.map((r) => ({
      id:               r.id,
      ticker:           r.ticker,
      easternDate:      r.easternDate,
      eventType:        r.eventType as Sol30PositionEventParams["eventType"],
      contractsDelta:   r.contractsDelta,
      contractsAfter:   r.contractsAfter,
      strategyOrderId:  r.strategyOrderId ?? null,
      fillPriceCents:   r.fillPriceCents ?? null,
      feeCents:         r.feeCents ?? null,
      settlementResult: (r.settlementResult === "yes" || r.settlementResult === "no")
        ? r.settlementResult
        : null,
      note:             r.note ?? null,
      occurredAtMs:     r.occurredAtMs,
    }));
  } catch (err) {
    logger.warn({ err, ticker }, "sol30: listSol30PositionEvents failed");
    return [];
  }
}

/**
 * List SOL_30_50 position events for an Eastern date, newest-event-first.
 * Returns [] when storage is degraded or no rows exist for the date.
 */
export async function listSol30PositionEventsForDate(easternDate: string): Promise<Sol30PositionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30PositionEvents)
      .where(eq(sol30PositionEvents.easternDate, easternDate))
      .orderBy(desc(sol30PositionEvents.occurredAtMs));
    return rows.map((r) => ({
      id:               r.id,
      ticker:           r.ticker,
      easternDate:      r.easternDate,
      eventType:        r.eventType as Sol30PositionEventParams["eventType"],
      contractsDelta:   r.contractsDelta,
      contractsAfter:   r.contractsAfter,
      strategyOrderId:  r.strategyOrderId ?? null,
      fillPriceCents:   r.fillPriceCents ?? null,
      feeCents:         r.feeCents ?? null,
      settlementResult: (r.settlementResult === "yes" || r.settlementResult === "no")
        ? r.settlementResult
        : null,
      note:             r.note ?? null,
      occurredAtMs:     r.occurredAtMs,
    }));
  } catch (err) {
    logger.warn({ err, easternDate }, "sol30: listSol30PositionEventsForDate failed");
    return [];
  }
}

// ── SOL_30_50 decision/skip evidence ledger ──────────────────────────────────

/**
 * Append a SOL_30_50 decision/skip evidence event. Audit-only ledger:
 * INSERT ... ON CONFLICT DO NOTHING (stable ids make once-only events naturally
 * idempotent). Returns true when the row was newly inserted, false on conflict
 * or storage degradation. Never throws.
 */
export async function appendSol30DecisionEvent(params: Sol30DecisionEventParams): Promise<boolean> {
  if (!_db || !_healthy) {
    logger.warn({ ticker: params.ticker, decision: params.decision }, "sol30: appendSol30DecisionEvent — storage degraded, event lost");
    return false;
  }
  try {
    const inserted = await _db
      .insert(sol30DecisionEvents)
      .values({
        id:           params.id,
        ticker:       params.ticker,
        easternDate:  params.easternDate,
        decision:     params.decision,
        side:         params.side ?? null,
        priceCents:   params.priceCents ?? null,
        contracts:    params.contracts ?? null,
        note:         params.note ?? null,
        occurredAtMs: params.occurredAtMs,
      })
      .onConflictDoNothing()
      .returning({ id: sol30DecisionEvents.id });
    if (inserted.length > 0) _lastWriteMs = Date.now();
    return inserted.length > 0;
  } catch (err) {
    _healthy        = false;
    _lastErrorMsg   = String(err);
    _degradedReason = `sol30.appendSol30DecisionEvent failed: ${_lastErrorMsg}`;
    logger.error({ err, ticker: params.ticker }, "sol30: appendSol30DecisionEvent FAILED — storage degraded, scheduling reconnect");
    _scheduleRetry();
    return false;
  }
}

function mapSol30DecisionRow(r: typeof sol30DecisionEvents.$inferSelect): Sol30DecisionEventParams {
  return {
    id:           r.id,
    ticker:       r.ticker,
    easternDate:  r.easternDate,
    decision:     r.decision,
    side:         r.side === "yes" || r.side === "no" ? r.side : null,
    priceCents:   r.priceCents ?? null,
    contracts:    r.contracts ?? null,
    note:         r.note ?? null,
    occurredAtMs: r.occurredAtMs,
  };
}

/** List SOL_30_50 decision events for a ticker, chronological. [] when degraded. */
export async function listSol30DecisionEvents(ticker: string): Promise<Sol30DecisionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30DecisionEvents)
      .where(eq(sol30DecisionEvents.ticker, ticker))
      .orderBy(asc(sol30DecisionEvents.occurredAtMs));
    return rows.map(mapSol30DecisionRow);
  } catch (err) {
    logger.warn({ err, ticker }, "sol30: listSol30DecisionEvents failed");
    return [];
  }
}

/** List recent SOL_30_50 decision events across all tickers, newest first. */
export async function listRecentSol30DecisionEvents(limit = 200): Promise<Sol30DecisionEventParams[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db
      .select()
      .from(sol30DecisionEvents)
      .orderBy(desc(sol30DecisionEvents.occurredAtMs))
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
    return rows.map(mapSol30DecisionRow);
  } catch (err) {
    logger.warn({ err }, "sol30: listRecentSol30DecisionEvents failed");
    return [];
  }
}

/** Bounded SOL_30_50 ledger read with an explicit failure state for runtime health. */
export async function loadSol30ActivityForRuntimeHealth(
  limit = 200,
): Promise<{ events: Sol30DecisionEventParams[]; available: boolean }> {
  if (!_db || !_healthy) return { events: [], available: false };
  try {
    const rows = await _db
      .select()
      .from(sol30DecisionEvents)
      .orderBy(desc(sol30DecisionEvents.occurredAtMs))
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
    return { events: rows.map(mapSol30DecisionRow), available: true };
  } catch (err) {
    logger.warn({ err }, "sol30: runtime activity read failed");
    return { events: [], available: false };
  }
}

/**
 * Return the distinct set of tickers that already have a settlement event in
 * the SOL_30_50 position-event ledger. [] when degraded.
 */
export async function listSettledSol30Tickers(): Promise<string[]> {
  if (!_db || !_healthy) return [];
  try {
    const rows = await _db.execute(sql`
      SELECT DISTINCT ticker
      FROM sol30_position_events
      WHERE event_type = 'settlement'
    `);
    const rawRows = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return rawRows.map((r) => String(r["ticker"]));
  } catch (err) {
    logger.warn({ err }, "sol30: listSettledSol30Tickers failed");
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Target-liquidity snapshots (ETH/SOL 30–50 observability)
// ═══════════════════════════════════════════════════════════════════════════════
// One row per throttled observation captured while a strategy's 50¢ GTC target
// rests AND the owned-side best bid is at/above the target. Fire-and-forget:
// a lost snapshot is an observability gap, never a trading-path failure.

export interface TargetLiquiditySnapshotRow {
  id:                       string;
  strategy:                 string;
  ticker:                   string;
  easternDate:              string;
  side:                     "yes" | "no";
  targetOrderDbId:          string | null;
  targetKalshiOrderId:      string | null;
  targetPlacedAtMs:         number | null;
  orderStatus:              string | null;
  restingContracts:         number | null;
  observedBidCents:         number | null;
  bidLevelsAtOrAboveTarget: Array<{ priceCents: number; contractsApprox: number }>;
  contractsAtOrAboveTarget: number;
  bookError:                string | null;
  capturedAtMs:             number;
}

/**
 * Fire-and-forget durable snapshot write. ON CONFLICT DO NOTHING keeps replays
 * idempotent. Never throws; failures are logged and dropped (observability
 * data — a periodic observer will produce the next snapshot regardless).
 */
export function insertTargetLiquiditySnapshot(row: TargetLiquiditySnapshotRow): void {
  if (!_db || !_healthy) return;
  void _db
    .insert(targetLiquiditySnapshots)
    .values({
      id:                       row.id,
      strategy:                 row.strategy,
      ticker:                   row.ticker,
      easternDate:              row.easternDate,
      side:                     row.side,
      targetOrderDbId:          row.targetOrderDbId,
      targetKalshiOrderId:      row.targetKalshiOrderId,
      targetPlacedAtMs:         row.targetPlacedAtMs,
      orderStatus:              row.orderStatus,
      restingContracts:         row.restingContracts,
      observedBidCents:         row.observedBidCents,
      bidLevelsJson:            JSON.stringify(row.bidLevelsAtOrAboveTarget),
      contractsAtOrAboveTarget: row.contractsAtOrAboveTarget,
      bookError:                row.bookError,
      capturedAtMs:             row.capturedAtMs,
    })
    .onConflictDoNothing()
    .then(() => { _lastWriteMs = Date.now(); })
    .catch((err) => {
      logger.warn({ err, ticker: row.ticker, strategy: row.strategy },
        "insertTargetLiquiditySnapshot failed — snapshot dropped (observability only)");
    });
}

/**
 * How many days of target-liquidity snapshots to retain and load.
 * Positions settle within a single trading window (hours), so 30 days covers
 * any realistic research window while keeping the table bounded.
 */
export const TARGET_LIQUIDITY_SNAPSHOT_RETENTION_DAYS = 30;

/** Return the Eastern calendar date N days before today (YYYY-MM-DD). */
function _easternDateDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return easternDay(d);
}

/**
 * Load target-liquidity snapshots for one strategy, oldest first.
 * Only rows on or after `sinceEasternDate` are returned; defaults to the last
 * TARGET_LIQUIDITY_SNAPSHOT_RETENTION_DAYS days so the query stays bounded
 * regardless of how many historical rows exist.
 * Returns [] on storage degradation or query failure (read-only reporting).
 */
export async function listTargetLiquiditySnapshots(
  strategy: string,
  sinceEasternDate?: string,
): Promise<TargetLiquiditySnapshotRow[]> {
  if (!_db || !_healthy) return [];
  const cutoff = sinceEasternDate ?? _easternDateDaysAgo(TARGET_LIQUIDITY_SNAPSHOT_RETENTION_DAYS);
  try {
    const rows = await _db
      .select()
      .from(targetLiquiditySnapshots)
      .where(
        and(
          eq(targetLiquiditySnapshots.strategy, strategy),
          gte(targetLiquiditySnapshots.easternDate, cutoff),
        ),
      )
      .orderBy(asc(targetLiquiditySnapshots.capturedAtMs));
    return rows.map((r) => {
      let levels: Array<{ priceCents: number; contractsApprox: number }> = [];
      try {
        const parsed = JSON.parse(r.bidLevelsJson) as unknown;
        if (Array.isArray(parsed)) {
          levels = parsed.filter((l): l is { priceCents: number; contractsApprox: number } =>
            l != null && typeof l === "object" &&
            Number.isFinite((l as { priceCents?: unknown }).priceCents) &&
            Number.isFinite((l as { contractsApprox?: unknown }).contractsApprox));
        }
      } catch { /* malformed JSON — treat as no level data */ }
      return {
        id:                       r.id,
        strategy:                 r.strategy,
        ticker:                   r.ticker,
        easternDate:              r.easternDate,
        side:                     r.side as "yes" | "no",
        targetOrderDbId:          r.targetOrderDbId ?? null,
        targetKalshiOrderId:      r.targetKalshiOrderId ?? null,
        targetPlacedAtMs:         r.targetPlacedAtMs ?? null,
        orderStatus:              r.orderStatus ?? null,
        restingContracts:         r.restingContracts ?? null,
        observedBidCents:         r.observedBidCents ?? null,
        bidLevelsAtOrAboveTarget: levels,
        contractsAtOrAboveTarget: r.contractsAtOrAboveTarget,
        bookError:                r.bookError ?? null,
        capturedAtMs:             r.capturedAtMs,
      };
    });
  } catch (err) {
    logger.warn({ err, strategy, cutoff }, "listTargetLiquiditySnapshots failed");
    return [];
  }
}

/**
 * Delete target-liquidity snapshot rows older than the given cutoff date
 * (exclusive — rows with eastern_date < cutoffEasternDate are removed).
 * Rows whose strategy is in `excludeStrategies` are never deleted — used to
 * preserve research-cohort depth evidence (e.g. the ETH 21–25¢ prospective
 * audit) through a review period that can exceed the default retention.
 * Returns the number of rows deleted, or -1 on failure.
 * Safe to call concurrently; a slow delete does not block reads or writes.
 * Observability data only — never throws; failures are logged and ignored.
 */
export async function pruneTargetLiquiditySnapshots(
  cutoffEasternDate: string,
  excludeStrategies: readonly string[] = [],
): Promise<number> {
  if (!_db || !_healthy) return -1;
  try {
    const result = await _db
      .delete(targetLiquiditySnapshots)
      .where(and(
        lt(targetLiquiditySnapshots.easternDate, cutoffEasternDate),
        ...(excludeStrategies.length > 0
          ? [not(inArray(targetLiquiditySnapshots.strategy, [...excludeStrategies]))]
          : []),
      ));
    const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (deleted > 0) {
      logger.info(
        { deleted, cutoffEasternDate },
        "pruneTargetLiquiditySnapshots: removed old snapshot rows",
      );
    }
    return deleted;
  } catch (err) {
    logger.warn({ err, cutoffEasternDate }, "pruneTargetLiquiditySnapshots failed — will retry next cycle");
    return -1;
  }
}

/** Deletes only compact ETH420 execution telemetry, never candidate orders or settlements. */
export async function pruneEth420CandidateExecutionSnapshots(cutoffMs: number): Promise<number> {
  if (!_db || !_healthy || !Number.isFinite(cutoffMs)) return -1;
  try {
    const result = await _db.execute(sql`
      DELETE FROM eth420_candidate_execution_snapshots WHERE observed_at_ms < ${Math.trunc(cutoffMs)}`);
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  } catch (err) {
    logger.warn({ err, cutoffMs }, "ETH420 candidate execution telemetry prune failed");
    return -1;
  }
}

// ── DOGE NO martingale durable APIs ──────────────────────────────────────────
// Deliberately uses its own tables and transaction.  This must never share the
// legacy order-dedup/budget state: DOGE's sequence is defined by settlements.
export interface DogeMartingaleState {
  easternDate: string;
  martingaleStep: number;
  spentCents: number;
  /** Filled losing principal plus its fee; reset only by a settled DOGE NO win. */
  recoveryLossCents: number;
  sequenceResetAtMs: number;
}

export interface DogeMartingaleOrder {
  id: string; ticker: string; easternDate: string; martingaleStep: number;
  clientOrderId: string; kalshiOrderId: string | null; noPriceCents: number;
  requestedContracts: number; reservedFeeCents: number; filledContracts: number | null;
  filledFeeCents: number | null; outcome: string;
  settlementResult: "yes" | "no" | "manual_yes" | "manual_no" | null; createdAtMs: number; submissionVersion: number;
}

export async function getDogeMartingaleState(): Promise<DogeMartingaleState | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`
      SELECT eastern_date, martingale_step, spent_cents, recovery_loss_cents, sequence_reset_at_ms FROM doge_martingale_state
      WHERE strategy_key = 'DOGE_NO_MARTINGALE'`);
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    return row ? {
      easternDate: String(row["eastern_date"]),
      martingaleStep: Number(row["martingale_step"]),
      spentCents: Number(row["spent_cents"]),
      recoveryLossCents: Number(row["recovery_loss_cents"]),
      sequenceResetAtMs: Number(row["sequence_reset_at_ms"] ?? 0),
    } : null;
  } catch (err) { logger.warn({ err }, "doge: state read failed"); return null; }
}

/** Fence a new market cycle so a late settlement from an older window cannot revive its loss step. */
export async function resetDogeMartingaleSequence(resetAtMs: number): Promise<boolean> {
  if (!_db || !_healthy || !Number.isFinite(resetAtMs)) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE doge_martingale_state
      SET martingale_step=0, recovery_loss_cents=0,
          sequence_reset_at_ms=GREATEST(sequence_reset_at_ms, ${Math.floor(resetAtMs)}),
          updated_at_ms=${Date.now()}
      WHERE strategy_key='DOGE_NO_MARTINGALE'
        AND sequence_reset_at_ms < ${Math.floor(resetAtMs)}
      RETURNING strategy_key`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) { logger.warn({ err }, "doge: pre-window sequence reset failed"); return false; }
}

/** Claim, record, and reserve principal plus the quoted taker fee atomically before POSTing. */
export async function reserveDogeMartingaleEntry(params: {
  ticker: string; easternDate: string; id: string; clientOrderId: string;
  martingaleStep: number; noPriceCents: number; requestedContracts: number;
  reservedFeeCents: number;
  dailyCapCents: number;
}): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  const cost = params.noPriceCents * params.requestedContracts + params.reservedFeeCents;
  try {
    return await _db.transaction(async (tx) => {
      const claim = await tx.execute(sql`
        INSERT INTO doge_martingale_claims (ticker, eastern_date, claimed_at_ms, client_order_id)
        VALUES (${params.ticker}, ${params.easternDate}, ${now}, ${params.clientOrderId})
        ON CONFLICT (ticker) DO NOTHING RETURNING ticker`);
      if ((claim as unknown as { rows: unknown[] }).rows.length !== 1) return false;
      const budget = await tx.execute(sql`
        UPDATE doge_martingale_state
        SET eastern_date = ${params.easternDate},
            spent_cents = CASE WHEN eastern_date = ${params.easternDate} THEN spent_cents + ${cost} ELSE ${cost} END,
            updated_at_ms = ${now}
        WHERE strategy_key = 'DOGE_NO_MARTINGALE'
          AND (CASE WHEN eastern_date = ${params.easternDate} THEN spent_cents ELSE 0 END) + ${cost} <= ${params.dailyCapCents}
        RETURNING spent_cents`);
      if ((budget as unknown as { rows: unknown[] }).rows.length !== 1) return false;
      await tx.execute(sql`
        INSERT INTO doge_martingale_orders
        (id,ticker,eastern_date,martingale_step,client_order_id,no_price_cents,requested_contracts,reserved_fee_cents,created_at_ms,updated_at_ms,submission_version)
        VALUES (${params.id},${params.ticker},${params.easternDate},${params.martingaleStep},${params.clientOrderId},
          ${params.noPriceCents},${params.requestedContracts},${params.reservedFeeCents},${now},${now},1)`);
      _lastWriteMs = Date.now();
      return true;
    });
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `doge.reserve failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("entry"); _scheduleRetry();
    logger.error({ err, ticker: params.ticker }, "doge: reservation failed closed");
    return false;
  }
}

/**
 * Durable fence immediately before the exchange POST. A remaining "pending"
 * reservation is therefore proof that no submission was attempted and can be
 * safely expired; post_started is always treated as ambiguous until recovery.
 */
export async function markDogeMartingaleOrderPostStarted(id: string): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE doge_martingale_orders SET outcome = 'post_started', updated_at_ms = ${Date.now()}
      WHERE id = ${id} AND outcome = 'pending' AND kalshi_order_id IS NULL AND filled_contracts IS NULL
      RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, id }, "doge: unable to record POST start; submission blocked");
    return false;
  }
}

/** Releases a reservation only when its durable state proves no POST began. */
export async function expireDogeMartingaleReservation(id: string, pendingBeforeMs: number): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    return await _db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE doge_martingale_orders
        SET outcome = 'expired', filled_contracts = 0, updated_at_ms = ${Date.now()}
        WHERE id = ${id} AND outcome = 'pending' AND kalshi_order_id IS NULL AND filled_contracts IS NULL
          AND submission_version >= 1 AND created_at_ms <= ${pendingBeforeMs}
        RETURNING requested_contracts, no_price_cents, reserved_fee_cents, eastern_date`);
      const row = (result as unknown as {
        rows: Array<{ requested_contracts: number; no_price_cents: number; reserved_fee_cents: number; eastern_date: string }>;
      }).rows[0];
      if (!row) return false;
      await tx.execute(sql`
        UPDATE doge_martingale_state SET spent_cents = GREATEST(0, spent_cents -
          ${row.requested_contracts} * ${row.no_price_cents} + ${row.reserved_fee_cents})
        WHERE strategy_key = 'DOGE_NO_MARTINGALE' AND eastern_date = ${row.eastern_date}`);
      return true;
    });
  } catch (err) {
    logger.warn({ err, id }, "doge: pending reservation expiry failed");
    return false;
  }
}

export async function updateDogeMartingaleOrder(params: {
  id: string; kalshiOrderId?: string | null; outcome?: string;
  filledContracts?: number | null; filledFeeCents?: number | null;
}): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    return await _db.transaction(async (tx) => {
      const terminal = params.filledContracts != null && params.outcome != null
        && ["full_fill", "partial_fill", "zero_fill", "error", "expired"].includes(params.outcome);
      // A terminal fill record is write-once. This WHERE condition is the
      // concurrency fence for WS/REST/recovery reconciliation: exactly one
      // caller can transition an order and receive the right to release its
      // unused reservation.
      const result = await tx.execute(sql`
        UPDATE doge_martingale_orders SET
          kalshi_order_id = COALESCE(${params.kalshiOrderId ?? null}, kalshi_order_id),
          outcome = COALESCE(${params.outcome ?? null}, outcome),
          filled_contracts = COALESCE(${params.filledContracts ?? null}, filled_contracts),
          filled_fee_cents = COALESCE(${params.filledFeeCents ?? null}, filled_fee_cents),
          updated_at_ms = ${Date.now()}
        WHERE id = ${params.id}
          AND (${terminal === false} OR filled_contracts IS NULL
            OR outcome NOT IN ('full_fill','partial_fill','zero_fill','error','expired'))
        RETURNING requested_contracts, no_price_cents, reserved_fee_cents, eastern_date`);
      const row = (result as unknown as { rows: Array<{ requested_contracts: number; no_price_cents: number; reserved_fee_cents: number; eastern_date: string }> }).rows[0];
      if (!row) return false;
      if (terminal) {
        await tx.execute(sql`
          UPDATE doge_martingale_state SET spent_cents = GREATEST(0, spent_cents -
            (CAST(${row.requested_contracts} AS integer) - CAST(${params.filledContracts!} AS integer))
              * CAST(${row.no_price_cents} AS integer)
            + CAST(${row.reserved_fee_cents} AS integer) - CAST(${params.filledFeeCents ?? 0} AS integer))
          WHERE strategy_key = 'DOGE_NO_MARTINGALE' AND eastern_date = ${row.eastern_date}`);
      }
      return true;
    });
  } catch (err) { logger.warn({ err, id: params.id }, "doge: order update failed"); return false; }
}

export async function listUnsettledDogeMartingaleOrders(): Promise<DogeMartingaleOrder[]> {
  if (!_db || !_healthy) return [];
  try {
    const result = await _db.execute(sql`
      SELECT * FROM doge_martingale_orders
      WHERE settlement_result IS NULL
        AND outcome IN ('pending','post_started','full_fill','partial_fill','unresolved')
      ORDER BY created_at_ms ASC`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
      id: String(r["id"]), ticker: String(r["ticker"]), easternDate: String(r["eastern_date"]),
      martingaleStep: Number(r["martingale_step"]), clientOrderId: String(r["client_order_id"]),
      kalshiOrderId: r["kalshi_order_id"] == null ? null : String(r["kalshi_order_id"]),
      noPriceCents: Number(r["no_price_cents"]), requestedContracts: Number(r["requested_contracts"]),
      reservedFeeCents: Number(r["reserved_fee_cents"]),
      filledContracts: r["filled_contracts"] == null ? null : Number(r["filled_contracts"]),
      filledFeeCents: r["filled_fee_cents"] == null ? null : Number(r["filled_fee_cents"]),
      outcome: String(r["outcome"]), settlementResult: null, createdAtMs: Number(r["created_at_ms"]),
      submissionVersion: Number(r["submission_version"]),
    }));
  } catch (err) { logger.warn({ err }, "doge: unsettled order list failed"); return []; }
}

/**
 * Applies exactly once; a DOGE NO win resets, a loss carries principal plus
 * the recorded exchange fee into recovery. Legacy rows without a recorded fee
 * retain the conservative quote-time estimate.
 */
export async function settleDogeMartingaleOrder(id: string, result: "yes" | "no"): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  try {
    return await _db.transaction(async (tx) => {
      const settled = await tx.execute(sql`
        UPDATE doge_martingale_orders
        SET settlement_result=${result}, settled_at_ms=${now}, updated_at_ms=${now},
            -- Legacy rows predate fill-fee persistence, so only those rows
            -- receive the conservative quote-time estimate. New rows have the
            -- exchange-reported fee (including zero) stored before settlement.
            filled_fee_cents = COALESCE(filled_fee_cents,
              CEIL(0.07 * filled_contracts * no_price_cents * (100 - no_price_cents) / 100.0)::integer)
        WHERE id=${id} AND settlement_result IS NULL
        RETURNING martingale_step, no_price_cents, filled_contracts, filled_fee_cents, created_at_ms, requested_contracts`);
      const row = (settled as unknown as {
        rows: Array<{ martingale_step: number; no_price_cents: number; filled_contracts: number; filled_fee_cents: number | null; created_at_ms: number; requested_contracts: number }>;
      }).rows[0];
      if (!row) return false;
      const partial = Number(row.filled_contracts) < Number(row.requested_contracts);
      const next = result === "no" || Number(row.martingale_step) >= 4 ? 0
        : partial ? Number(row.martingale_step) : Number(row.martingale_step) + 1;
      const lossCents = Number(row.filled_contracts) * Number(row.no_price_cents) + Number(row.filled_fee_cents ?? 0);
      await tx.execute(sql`UPDATE doge_martingale_state
        SET martingale_step=CASE WHEN ${Number(row.created_at_ms)} < sequence_reset_at_ms THEN 0 ELSE ${next} END,
            recovery_loss_cents = CASE WHEN ${Number(row.created_at_ms)} < sequence_reset_at_ms
              OR ${result} = 'no' OR ${next} = 0 THEN 0
              ELSE recovery_loss_cents + ${lossCents} END,
            updated_at_ms=${now}
        WHERE strategy_key='DOGE_NO_MARTINGALE'`);
      return true;
    });
  } catch (err) { logger.warn({ err, id }, "doge: settlement update failed"); return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ETH NO martingale — additive tables (eth_martingale_*); never shares DOGE state.
// Principals: [1500, 3000, 6000] cents. Three-step ladder; step 2 wraps to 0.
// Side tracks yes/no orientation for the daily sequence.
// realized_pnl_cents: even-money fill accounting (filled_contracts - cost).
// Daily state resets when eastern_date changes; no timer needed.
// ─────────────────────────────────────────────────────────────────────────────

export interface EthMartingaleState {
  easternDate: string;
  /** Which side we are betting next. Starts "no" each day. */
  side: "yes" | "no";
  martingaleStep: number;
  spentCents: number;
  /** Running realized P&L this ET day (even-money, cents). Losses are negative. */
  realizedPnlCents: number;
}

export interface EthMartingaleOrder {
  id: string; ticker: string; easternDate: string; martingaleStep: number;
  /** The side (yes/no) this order was placed on — persisted at reservation time and immutable. */
  side: "yes" | "no";
  clientOrderId: string; kalshiOrderId: string | null; noPriceCents: number;
  requestedContracts: number; reservedFeeCents: number; filledContracts: number | null;
  filledFeeCents: number | null; outcome: string; rejectionReason: string | null;
  /** Only present after the exchange fill ledger has supplied exact evidence. */
  actualFillPriceCents: number | null;
  actualNotionalDollars: number | null;
  actualFeeDollars: number | null;
  fillEconomicsVerifiedAtMs: number | null;
  /** Exact filled-contract total represented by the stored economics aggregate. */
  fillEconomicsVerifiedContracts: number | null;
  settlementResult: "yes" | "no" | "manual_yes" | "manual_no" | null; createdAtMs: number; submissionVersion: number;
  /** True only when an operator released a missing-Kalshi-result fence. */
  manualSettlementOverride: boolean;
  manualRecoveryId: string | null;
  settledAtMs?: number | null;
}

export type EthMartingaleLedgerPnlStatus =
  | "realized"
  | "zero_fill"
  | "unsettled"
  | "manual_override"
  | "missing_economics";

export type EthMartingaleLedgerExportRow = EthMartingaleOrder & {
  netPnlDollars: number | null;
  pnlStatus: EthMartingaleLedgerPnlStatus;
};

/**
 * Produce report-only P&L from immutable ETH order evidence. The persisted
 * order side is authoritative because the mutable sequence state can advance
 * before this historical row is exported.
 */
export function projectEthMartingaleLedgerExportRow(
  order: EthMartingaleOrder,
): EthMartingaleLedgerExportRow {
  const filledContracts = order.filledContracts ?? 0;
  if (filledContracts <= 0) return { ...order, netPnlDollars: null, pnlStatus: "zero_fill" };
  if (order.manualSettlementOverride
    || order.settlementResult === "manual_yes"
    || order.settlementResult === "manual_no") {
    return { ...order, netPnlDollars: null, pnlStatus: "manual_override" };
  }
  if (order.settlementResult !== "yes" && order.settlementResult !== "no") {
    return { ...order, netPnlDollars: null, pnlStatus: "unsettled" };
  }
  if (order.actualNotionalDollars == null || order.actualFeeDollars == null) {
    return { ...order, netPnlDollars: null, pnlStatus: "missing_economics" };
  }
  const costCents = calculateEthMartingaleCostCents(order.actualNotionalDollars, order.actualFeeDollars);
  if (costCents == null) return { ...order, netPnlDollars: null, pnlStatus: "missing_economics" };
  const pnlCents = order.side === order.settlementResult
    ? filledContracts * 100 - costCents
    : -costCents;
  return { ...order, netPnlDollars: pnlCents / 100, pnlStatus: "realized" };
}

export function summarizeEthMartingaleLedgerExport(rows: EthMartingaleLedgerExportRow[]): {
  orderCount: number;
  realizedOrderCount: number;
  wins: number;
  losses: number;
  realizedNetPnlDollars: number | null;
  nonRealizedOrderCount: number;
} {
  const realized = rows.filter((row) => row.pnlStatus === "realized" && row.netPnlDollars != null);
  return {
    orderCount: rows.length,
    realizedOrderCount: realized.length,
    wins: realized.filter((row) => row.side === row.settlementResult).length,
    losses: realized.filter((row) => row.side !== row.settlementResult).length,
    realizedNetPnlDollars: rows.some((row) => row.pnlStatus === "missing_economics")
      ? null
      : realized.reduce((total, row) => total + row.netPnlDollars!, 0),
    nonRealizedOrderCount: rows.length - realized.length,
  };
}

export interface EthMartingaleRecoveryCandidate {
  id: string;
  ticker: string;
  easternDate: string;
  side: "yes" | "no";
  outcome: string;
  filledContracts: number;
  kalshiOrderId: string;
}

export interface EthMartingaleRecoveryAudit {
  id: string;
  ticker: string;
  easternDate: string;
  declaredResult: "yes" | "no";
  reason: string;
  exchangeStatus: string;
  exchangeResult: "yes" | "no" | null;
  createdAtMs: number;
}

/**
 * Summary values for the ETH martingale dashboard. The sole input is the
 * strategy's durable order ledger so unrelated account fills cannot leak into
 * strategy-specific counts or notional.
 */
export function summarizeEthMartingaleOrders(orders: Array<Pick<
  EthMartingaleOrder,
  "side" | "settlementResult" | "createdAtMs" | "filledContracts" | "actualNotionalDollars" | "actualFeeDollars"
>>): {
  orderCount: number;
  wins: number;
  losses: number;
  streak: number;
  streakType: "win" | "loss" | null;
  filledContracts: number;
  actualNotionalDollars: number;
  fillEconomicsVerified: boolean;
} {
  const resolved = orders
    .filter((order) => order.settlementResult === "yes" || order.settlementResult === "no")
    .map((order) => ({
      order,
      result: order.settlementResult === order.side ? "win" as const : "loss" as const,
    }))
    .sort((a, b) => b.order.createdAtMs - a.order.createdAtMs);
  const streakType = resolved[0]?.result ?? null;
  const firstDifferentResult = streakType == null
    ? -1
    : resolved.findIndex((entry) => entry.result !== streakType);
  const filledOrders = orders.filter((order) => (order.filledContracts ?? 0) > 0);

  return {
    orderCount: orders.length,
    wins: resolved.filter((entry) => entry.result === "win").length,
    losses: resolved.filter((entry) => entry.result === "loss").length,
    streak: streakType == null ? 0 : (firstDifferentResult === -1 ? resolved.length : firstDifferentResult),
    streakType,
    filledContracts: filledOrders.reduce((total, order) => total + (order.filledContracts ?? 0), 0),
    actualNotionalDollars: filledOrders.reduce(
      (total, order) => total + (order.actualNotionalDollars ?? 0),
      0,
    ),
    fillEconomicsVerified: filledOrders.every((order) =>
      order.actualNotionalDollars != null && order.actualFeeDollars != null,
    ),
  };
}

/**
 * The open ETH martingale position is an unsettled ledger order with confirmed
 * filled contracts. Resting zero-fill orders deliberately do not count as an
 * open position or invested capital.
 */
export function findOpenEthMartingalePosition<T extends Pick<
  EthMartingaleOrder,
  "ticker" | "side" | "requestedContracts" | "filledContracts" | "actualNotionalDollars" | "outcome" | "settlementResult" | "createdAtMs"
>>(orders: T[]): T | null {
  let newest: T | null = null;
  for (const order of orders) {
    if (
      order.settlementResult == null &&
      (order.filledContracts ?? 0) > 0 &&
      (newest == null || order.createdAtMs > newest.createdAtMs)
    ) {
      newest = order;
    }
  }
  return newest;
}

/**
 * Exact exchange identities for acknowledged, unsettled ETH martingale orders.
 * A resting GTC order can fill after its last persisted fill count, so it
 * remains strategy ownership evidence even when that count is currently zero.
 */
export interface OpenEthMartingaleOrderIdentity {
  ticker: string;
  kalshiOrderId: string;
}

/**
 * The clean ETH-only rebuild owns a new generation. Earlier ledger rows remain
 * immutable reporting evidence, but are never allowed to fence or advance the
 * new dispatcher.
 */
export const ETH_MARTINGALE_ACTIVE_GENERATION_KEY = "ETH_NO_MARTINGALE_V2";
export const ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS = (() => {
  const configured = Number(process.env["ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS"]);
  // 2026-08-25 14:59 UTC: after the legacy/phantom ETH attempts and before
  // this clean generation can be published.
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : Date.UTC(2026, 7, 25, 14, 59);
})();

export function isActiveEthMartingaleGeneration(createdAtMs: number): boolean {
  return Number.isSafeInteger(createdAtMs)
    && createdAtMs >= ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS;
}

/** A Regular attempt can own side/rung chronology only after real exposure exists. */
export function ethMartingaleAttemptOwnsSequence(filledContracts: number | null | undefined): boolean {
  return Number.isFinite(filledContracts) && Number(filledContracts) > 0;
}

/**
 * Only the newest real Regular attempt for the ET day may mutate side/rung.
 * The newest owner is selected durably by created_at_ms DESC, id DESC while
 * holding the same state-row lock used by Regular reservations.
 */
export function isEthMartingaleSequenceOwner(
  settlingOrderId: string,
  newestSequenceOwnerId: string | null,
): boolean {
  return settlingOrderId.length > 0 && settlingOrderId === newestSequenceOwnerId;
}

/** Pure six-step transition shared by settlement and regression coverage. */
export function nextEthMartingaleSequence(
  orderSide: "yes" | "no",
  orderStep: number,
  result: "yes" | "no",
): { side: "yes" | "no"; step: number } {
  const won = result === orderSide;
  return {
    side: won ? (orderSide === "yes" ? "no" : "yes") : orderSide,
    step: won ? 0 : orderStep >= 5 ? 0 : orderStep + 1,
  };
}

export async function listOpenEthMartingaleOrderIdentities(): Promise<OpenEthMartingaleOrderIdentity[] | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`
      SELECT ticker, kalshi_order_id
      FROM eth_martingale_orders
      WHERE settlement_result IS NULL
        AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        AND kalshi_order_id IS NOT NULL
        AND outcome IN ('post_started','resting','full_fill','partial_fill','unresolved')`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => ({
      ticker: String(row["ticker"]),
      kalshiOrderId: String(row["kalshi_order_id"]),
    }));
  } catch (err) {
    logger.warn({ err }, "eth: open martingale order identity list failed");
    return null;
  }
}

export async function getEthMartingaleState(): Promise<EthMartingaleState | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`
      SELECT eastern_date, side, martingale_step, spent_cents, realized_pnl_cents
      FROM eth_martingale_state WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}`);
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    return row ? {
      easternDate: String(row["eastern_date"]),
      side: row["side"] === "yes" ? "yes" : "no",
      martingaleStep: Number(row["martingale_step"]),
      spentCents: Number(row["spent_cents"]),
      realizedPnlCents: Number(row["realized_pnl_cents"] ?? 0),
    } : null;
  } catch (err) { logger.warn({ err }, "eth: state read failed"); return null; }
}

/**
 * The emergency recovery route intentionally has no arbitrary ticker or order-ID
 * input. It can only target one current-generation filled order that still lacks
 * settlement evidence. Returning up to two rows lets the route fail closed when
 * the ledger is ambiguous instead of picking a convenient row.
 */
export async function listEthMartingaleEmergencyRecoveryCandidates(): Promise<EthMartingaleRecoveryCandidate[] | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await _db.execute(sql`
      SELECT id, ticker, eastern_date, side, outcome, filled_contracts, kalshi_order_id
      FROM eth_martingale_orders
      WHERE settlement_result IS NULL
        AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        AND outcome IN ('full_fill', 'partial_fill')
        AND filled_contracts > 0
        AND kalshi_order_id IS NOT NULL
      ORDER BY created_at_ms DESC, id DESC
      LIMIT 2`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => ({
      id: String(row["id"]),
      ticker: String(row["ticker"]),
      easternDate: String(row["eastern_date"]),
      side: row["side"] === "yes" ? "yes" : "no",
      outcome: String(row["outcome"]),
      filledContracts: Number(row["filled_contracts"]),
      kalshiOrderId: String(row["kalshi_order_id"]),
    }));
  } catch (err) {
    logger.warn({ err }, "eth: emergency recovery candidate lookup failed");
    return null;
  }
}

export async function loadLatestEthMartingaleRecoveryAudit(): Promise<EthMartingaleRecoveryAudit | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await readEthMartingaleLedgerWithDeadline("manual recovery audit", async (client) => client
      ? client.query(
        "SELECT id, ticker, eastern_date, declared_result, reason, exchange_status, exchange_result, created_at_ms FROM eth_martingale_recovery_audit WHERE strategy_key = $1 ORDER BY created_at_ms DESC LIMIT 1",
        [ETH_MARTINGALE_ACTIVE_GENERATION_KEY],
      )
      : _db!.execute(sql`
        SELECT id, ticker, eastern_date, declared_result, reason, exchange_status, exchange_result, created_at_ms
        FROM eth_martingale_recovery_audit
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        ORDER BY created_at_ms DESC
        LIMIT 1`));
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    return row ? {
      id: String(row["id"]),
      ticker: String(row["ticker"]),
      easternDate: String(row["eastern_date"]),
      declaredResult: row["declared_result"] === "no" ? "no" : "yes",
      reason: String(row["reason"]),
      exchangeStatus: String(row["exchange_status"]),
      exchangeResult: row["exchange_result"] === "yes" || row["exchange_result"] === "no"
        ? row["exchange_result"] : null,
      createdAtMs: Number(row["created_at_ms"]),
    } : null;
  } catch (err) {
    logger.warn({ err }, "eth: manual recovery audit lookup failed");
    return null;
  }
}

/**
 * A manual recovery releases only the local settlement fence; it never closes
 * the exchange position. Every recovered ticker must therefore be checked for
 * residual exchange exposure before a later strategy entry may be submitted.
 * Null means the ledger could not be read and must fail closed.
 */
export async function listEthMartingaleManualRecoveryTickers(): Promise<string[] | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await readEthMartingaleLedgerWithDeadline("manual recovery tickers", async (client) => client
      ? client.query(
        "SELECT DISTINCT ticker FROM eth_martingale_recovery_audit WHERE strategy_key = $1",
        [ETH_MARTINGALE_ACTIVE_GENERATION_KEY],
      )
      : _db!.execute(sql`
        SELECT DISTINCT ticker
        FROM eth_martingale_recovery_audit
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}`));
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows
      .map((row) => String(row["ticker"] ?? ""))
      .filter((ticker) => ticker.length > 0);
  } catch (err) {
    logger.warn({ err }, "eth: manual recovery ticker lookup failed");
    return null;
  }
}

export type EthMartingaleManualRecoveryResult =
  | { kind: "applied"; recovery: EthMartingaleRecoveryAudit }
  | { kind: "already_applied"; recovery: EthMartingaleRecoveryAudit }
  | { kind: "conflict" }
  | { kind: "unavailable" };

/**
 * Manual recovery is a last-resort operator action. It intentionally does not
 * use normal settlement accounting: the exchange has not provided an outcome,
 * so no invented P&L is added. Only the next-side/rung sequence is reset.
 */
export async function manuallyRecoverEthMartingaleOrder(params: {
  orderId: string;
  declaredResult: "yes" | "no";
  reason: string;
  acknowledgement: string;
  exchangeStatus: string;
}): Promise<EthMartingaleManualRecoveryResult> {
  if (!_db || !_healthy) return { kind: "unavailable" };
  const now = Date.now();
  const auditId = `eth-manual-recovery:${randomUUID()}`;
  try {
    return await _db.transaction(async (tx) => {
      const existing = await tx.execute(sql`
        SELECT id, ticker, eastern_date, declared_result, reason, exchange_status, exchange_result, created_at_ms
        FROM eth_martingale_recovery_audit
        WHERE target_order_id = ${params.orderId}
        FOR UPDATE`);
      const priorAudit = (existing as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (priorAudit) {
        return {
          kind: "already_applied" as const,
          recovery: {
            id: String(priorAudit["id"]), ticker: String(priorAudit["ticker"]),
            easternDate: String(priorAudit["eastern_date"]),
            declaredResult: priorAudit["declared_result"] === "no" ? "no" : "yes",
            reason: String(priorAudit["reason"]), exchangeStatus: String(priorAudit["exchange_status"]),
            exchangeResult: priorAudit["exchange_result"] === "yes" || priorAudit["exchange_result"] === "no"
              ? priorAudit["exchange_result"] : null,
            createdAtMs: Number(priorAudit["created_at_ms"]),
          },
        };
      }
      const orderResult = await tx.execute(sql`
        SELECT id, ticker, eastern_date, side, martingale_step, outcome, filled_contracts, kalshi_order_id
        FROM eth_martingale_orders
        WHERE id = ${params.orderId}
          AND settlement_result IS NULL
          AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND outcome IN ('full_fill', 'partial_fill')
          AND filled_contracts > 0
          AND kalshi_order_id IS NOT NULL
        FOR UPDATE`);
      const order = (orderResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!order || (order["side"] !== "yes" && order["side"] !== "no")) {
        return { kind: "conflict" as const };
      }
      const stateResult = await tx.execute(sql`
        SELECT eastern_date, side, martingale_step, spent_cents, realized_pnl_cents
        FROM eth_martingale_state
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date = ${String(order["eastern_date"])}
        FOR UPDATE`);
      const state = (stateResult as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!state) return { kind: "conflict" as const };
      const priorState = {
        side: String(state["side"]), martingaleStep: Number(state["martingale_step"]),
        spentCents: Number(state["spent_cents"]), realizedPnlCents: Number(state["realized_pnl_cents"]),
      };
      const resultingState = { ...priorState, side: "no", martingaleStep: 0 };
      await tx.execute(sql`
        INSERT INTO eth_martingale_recovery_audit (
          id, target_order_id, strategy_key, ticker, eastern_date, declared_result,
          reason, acknowledgement, exchange_status, exchange_result, prior_state, resulting_state, created_at_ms
        ) VALUES (
          ${auditId}, ${String(order["id"])}, ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY},
          ${String(order["ticker"])}, ${String(order["eastern_date"])}, ${params.declaredResult},
          ${params.reason}, ${params.acknowledgement}, ${params.exchangeStatus}, NULL,
          CAST(${JSON.stringify(priorState)} AS jsonb), CAST(${JSON.stringify(resultingState)} AS jsonb), ${now}
        )`);
      const settled = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET settlement_result = ${params.declaredResult === "yes" ? "manual_yes" : "manual_no"}, settled_at_ms = ${now}, updated_at_ms = ${now},
            manual_settlement_override = true, manual_recovery_id = ${auditId}
        WHERE id = ${String(order["id"])} AND settlement_result IS NULL`);
      if (((settled as unknown as { rowCount?: number }).rowCount ?? 0) !== 1) throw new Error("manual recovery order transition lost");
      const stateUpdated = await tx.execute(sql`
        UPDATE eth_martingale_state
        SET side = 'no', martingale_step = 0, updated_at_ms = ${now}
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date = ${String(order["eastern_date"])}`);
      if (((stateUpdated as unknown as { rowCount?: number }).rowCount ?? 0) !== 1) throw new Error("manual recovery state transition lost");
      return {
        kind: "applied" as const,
        recovery: {
          id: auditId, ticker: String(order["ticker"]), easternDate: String(order["eastern_date"]),
          declaredResult: params.declaredResult, reason: params.reason,
          exchangeStatus: params.exchangeStatus, exchangeResult: null, createdAtMs: now,
        },
      };
    });
  } catch (err) {
    logger.warn({ err, orderId: params.orderId }, "eth: manual recovery transaction failed");
    return { kind: "unavailable" };
  }
}

/** Claim, record, and reserve principal plus the quoted taker fee atomically before POSTing. */
export type EthMartingaleReservationOutcome = "reserved" | "proof_already_claimed" | "failed";

/** Roll back a reservation without treating a normal capacity/conflict outcome as DB outage. */
class EthMartingaleReservationRollback extends Error {}

export async function reserveEthMartingaleEntry(params: {
  ticker: string; easternDate: string; id: string; clientOrderId: string;
  /** The side this order will be placed on; persisted immutably for correct win/loss determination. */
  side: "yes" | "no";
  martingaleStep: number; noPriceCents: number; requestedContracts: number;
  reservedFeeCents: number;
  /** The controlled live proof may reserve exactly one durable entry forever. */
  claimProofFence?: boolean;
}): Promise<EthMartingaleReservationOutcome> {
  if (!_db || !_healthy) return "failed";
  const now = Date.now();
  const cost = params.noPriceCents * params.requestedContracts + params.reservedFeeCents;
  try {
    return await _db.transaction(async (tx) => {
      if (params.claimProofFence) {
        const proofClaim = await tx.execute(sql`
          INSERT INTO eth_martingale_proof_fences (generation, claimed_at_ms, ticker, client_order_id)
          VALUES (${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}, ${now}, ${params.ticker}, ${params.clientOrderId})
          ON CONFLICT (generation) DO NOTHING
          RETURNING generation`);
        if ((proofClaim as unknown as { rows: unknown[] }).rows.length !== 1) {
          return "proof_already_claimed";
        }
      }
      const claim = await tx.execute(sql`
        INSERT INTO eth_martingale_claims (generation, ticker, eastern_date, claimed_at_ms, client_order_id)
        VALUES (${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}, ${params.ticker}, ${params.easternDate}, ${now}, ${params.clientOrderId})
        ON CONFLICT (generation, ticker) DO NOTHING RETURNING ticker`);
      if ((claim as unknown as { rows: unknown[] }).rows.length !== 1) {
        // A proof-fence insert may have preceded this conflict. Roll it back
        // with the rest of the transaction so no orderless attempt is consumed.
        throw new EthMartingaleReservationRollback("ETH martingale ticker claim unavailable");
      }
      // Reset day if eastern_date changed before adding cost.
      // Note: the state table's side/step/pnl are only reset when eastern_date changes;
      // within the same day they are left as-is (settlement drives those transitions).
      const budget = await tx.execute(sql`
        UPDATE eth_martingale_state
        SET eastern_date = ${params.easternDate},
            spent_cents = CASE WHEN eastern_date = ${params.easternDate} THEN spent_cents + ${cost} ELSE ${cost} END,
            realized_pnl_cents = CASE WHEN eastern_date = ${params.easternDate} THEN realized_pnl_cents ELSE 0 END,
            side = CASE WHEN eastern_date = ${params.easternDate} THEN side ELSE 'no' END,
            martingale_step = CASE WHEN eastern_date = ${params.easternDate} THEN martingale_step ELSE 0 END,
            updated_at_ms = ${now}
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        RETURNING spent_cents`);
      if ((budget as unknown as { rows: unknown[] }).rows.length !== 1) {
        // The claim and optional proof fence must not survive an unsuccessful
        // state update.
        throw new EthMartingaleReservationRollback("ETH martingale state update unavailable");
      }
      await tx.execute(sql`
        INSERT INTO eth_martingale_orders
        (id,generation,ticker,eastern_date,martingale_step,side,client_order_id,no_price_cents,requested_contracts,reserved_fee_cents,created_at_ms,updated_at_ms,submission_version)
        VALUES (${params.id},${ETH_MARTINGALE_ACTIVE_GENERATION_KEY},${params.ticker},${params.easternDate},${params.martingaleStep},${params.side},${params.clientOrderId},
          ${params.noPriceCents},${params.requestedContracts},${params.reservedFeeCents},${now},${now},1)`);
      _lastWriteMs = Date.now();
      return "reserved";
    });
  } catch (err) {
    if (err instanceof EthMartingaleReservationRollback) return "failed";
    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `eth.reserve failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("entry"); _scheduleRetry();
    logger.error({ err, ticker: params.ticker }, "eth: reservation failed closed");
    return "failed";
  }
}

/**
 * Durable fence immediately before the exchange POST. A remaining "pending"
 * reservation is therefore proof that no submission was attempted.
 */
export async function markEthMartingaleOrderPostStarted(id: string): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE eth_martingale_orders SET outcome = 'post_started', updated_at_ms = ${Date.now()}
      WHERE id = ${id} AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        AND outcome = 'pending' AND kalshi_order_id IS NULL AND filled_contracts IS NULL
      RETURNING id`);
    return (result as unknown as { rows: unknown[] }).rows.length === 1;
  } catch (err) {
    logger.warn({ err, id }, "eth: unable to record POST start; submission blocked");
    return false;
  }
}

/** Returns the exact whole-cent reservation to release, or null for invalid ledger data. */
export function calculateEthPendingReservationReleaseCents(
  requestedContracts: number,
  noPriceCents: number,
  reservedFeeCents: number,
): number | null {
  if (![requestedContracts, noPriceCents, reservedFeeCents].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )) return null;
  const releaseCents = requestedContracts * noPriceCents + reservedFeeCents;
  return Number.isSafeInteger(releaseCents) ? releaseCents : null;
}

/**
 * A proof fence is single-submission evidence. It may be cleared only by the
 * exact attempt that claimed it; a prior confirmed attempt's fence is never
 * evidence about a later phantom.
 */
export function isEthMartingaleProofFenceForAttempt(
  fence: { ticker: string; clientOrderId: string } | null,
  attempt: { ticker: string; clientOrderId: string },
): boolean {
  return fence?.ticker === attempt.ticker && fence.clientOrderId === attempt.clientOrderId;
}

/** Releases a reservation only when its durable state proves no POST began. */
export async function expireEthMartingaleReservation(id: string, pendingBeforeMs: number): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    return await _db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET outcome = 'expired', filled_contracts = 0, updated_at_ms = ${Date.now()}
        WHERE id = ${id} AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND outcome = 'pending' AND kalshi_order_id IS NULL AND filled_contracts IS NULL
          AND filled_fee_cents IS NULL
          AND actual_fill_price_cents IS NULL
          AND actual_notional_dollars IS NULL AND actual_fee_dollars IS NULL
          AND fill_economics_verified_at_ms IS NULL AND fill_economics_verified_contracts IS NULL
          AND submission_version >= 1 AND created_at_ms <= ${pendingBeforeMs}
        RETURNING requested_contracts, no_price_cents, reserved_fee_cents, eastern_date`);
      const row = (result as unknown as {
        rows: Array<{ requested_contracts: number; no_price_cents: number; reserved_fee_cents: number; eastern_date: string }>;
      }).rows[0];
      if (!row) return false;
      const releaseCents = calculateEthPendingReservationReleaseCents(
        Number(row.requested_contracts),
        Number(row.no_price_cents),
        Number(row.reserved_fee_cents),
      );
      if (releaseCents === null) throw new Error("invalid ETH pending reservation release amount");
      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET spent_cents = GREATEST(0::integer, spent_cents - CAST(${releaseCents} AS integer))
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date = ${row.eastern_date}`);
      return true;
    });
  } catch (err) {
    logger.warn({ err, id }, "eth: pending reservation expiry failed");
    return false;
  }
}

/**
 * Releases an ambiguous post only after the ETH reconciliation path has
 * independently proved complete exchange-history absence. This transition is
 * deliberately narrower than a normal terminal update: it cannot touch an
 * order with an exchange identity, fills, or any retained fill economics.
 */
export async function resolveEthMartingaleProvenPhantom(id: string): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    return await _db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET outcome = 'zero_fill', filled_contracts = 0, filled_fee_cents = 0,
            updated_at_ms = ${Date.now()}
        WHERE id = ${id}
          AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND outcome IN ('post_started', 'unresolved')
          AND kalshi_order_id IS NULL AND filled_contracts IS NULL AND filled_fee_cents IS NULL
          AND actual_fill_price_cents IS NULL AND actual_notional_dollars IS NULL
          AND actual_fee_dollars IS NULL AND fill_economics_verified_at_ms IS NULL
          AND fill_economics_verified_contracts IS NULL
        RETURNING requested_contracts, no_price_cents, reserved_fee_cents, eastern_date, ticker, client_order_id`);
      const row = (result as unknown as { rows: Array<{
        requested_contracts: number; no_price_cents: number;
        reserved_fee_cents: number; eastern_date: string; ticker: string; client_order_id: string;
      }> }).rows[0];
      if (!row) return false;
      const releaseCents = calculateEthPendingReservationReleaseCents(
        Number(row.requested_contracts),
        Number(row.no_price_cents),
        Number(row.reserved_fee_cents),
      );
      if (releaseCents == null) throw new Error("invalid ETH phantom reservation release amount");
      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET spent_cents = GREATEST(0::integer, spent_cents - CAST(${releaseCents} AS integer)),
            updated_at_ms = ${Date.now()}
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date = ${row.eastern_date}`);
      // Re-arm only a fence proven to belong to this empty submission. A fence
      // for an earlier confirmed attempt must remain in place, but it cannot
      // prevent this independently-proven phantom from releasing its budget.
      const fence = await tx.execute(sql`
        SELECT ticker, client_order_id FROM eth_martingale_proof_fences
        WHERE generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}`);
      const activeFence = (fence as unknown as {
        rows: Array<{ ticker: string; client_order_id: string }>;
      }).rows[0];
      if (isEthMartingaleProofFenceForAttempt(
        activeFence == null ? null : { ticker: activeFence.ticker, clientOrderId: activeFence.client_order_id },
        { ticker: row.ticker, clientOrderId: row.client_order_id },
      )) {
        await tx.execute(sql`
          DELETE FROM eth_martingale_proof_fences
          WHERE generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
            AND ticker = ${row.ticker} AND client_order_id = ${row.client_order_id}`);
      }
      return true;
    });
  } catch (err) {
    logger.warn({ err, id }, "eth: proven phantom release failed closed");
    return false;
  }
}

/**
 * Record Kalshi's definitive POST rejection and release this exact reservation.
 * It is intentionally separate from the ambiguous-post recovery path: a
 * response-bearing rejection requires no history scan and must retain the
 * exchange reason for later audit.
 */
export async function rejectEthMartingaleOrder(params: {
  id: string; rejectionReason: string;
}): Promise<boolean> {
  if (!_db || !_healthy || params.rejectionReason.trim() === "") return false;
  try {
    return await _db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET outcome = 'rejected', rejection_reason = ${params.rejectionReason.trim().slice(0, 500)},
            filled_contracts = 0, filled_fee_cents = 0, updated_at_ms = ${Date.now()}
        WHERE id = ${params.id}
          AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND outcome IN ('post_started', 'unresolved')
          AND kalshi_order_id IS NULL AND filled_contracts IS NULL AND filled_fee_cents IS NULL
          AND actual_fill_price_cents IS NULL AND actual_notional_dollars IS NULL
          AND actual_fee_dollars IS NULL AND fill_economics_verified_at_ms IS NULL
          AND fill_economics_verified_contracts IS NULL
        RETURNING requested_contracts, no_price_cents, reserved_fee_cents, eastern_date`);
      const row = (result as unknown as { rows: Array<{
        requested_contracts: number; no_price_cents: number; reserved_fee_cents: number; eastern_date: string;
      }> }).rows[0];
      if (!row) return false;
      const releaseCents = calculateEthPendingReservationReleaseCents(
        Number(row.requested_contracts),
        Number(row.no_price_cents),
        Number(row.reserved_fee_cents),
      );
      if (releaseCents == null) throw new Error("invalid ETH rejected reservation release amount");
      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET spent_cents = GREATEST(0::integer, spent_cents - CAST(${releaseCents} AS integer)),
            updated_at_ms = ${Date.now()}
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date = ${row.eastern_date}`);
      return true;
    });
  } catch (err) {
    logger.warn({ err, id: params.id }, "eth: rejected order write failed closed");
    return false;
  }
}

export async function updateEthMartingaleOrder(params: {
  id: string; kalshiOrderId?: string | null; outcome?: string;
  filledContracts?: number | null; filledFeeCents?: number | null;
  /** Authenticated terminal evidence may prove a later fill than the count
   * already persisted on a terminal row. This is a strictly-increasing
   * evidence refresh, not a second terminal release. */
  terminalFillRefresh?: boolean;
  priorFilledContracts?: number | null;
  priorFilledFeeCents?: number | null;
}): Promise<boolean> {
  if (!_db || !_healthy) return false;
  try {
    return await _db.transaction(async (tx) => {
      const terminal = params.filledContracts != null && params.outcome != null
        && ["full_fill", "partial_fill", "zero_fill", "zero_fill_verified", "error", "expired", "rejected"].includes(params.outcome);
      const result = await tx.execute(sql`
        UPDATE eth_martingale_orders AS o SET
          kalshi_order_id = COALESCE(${params.kalshiOrderId ?? null}, o.kalshi_order_id),
          outcome = COALESCE(${params.outcome ?? null}, o.outcome),
          filled_contracts = COALESCE(incoming.filled_contracts, o.filled_contracts),
          filled_fee_cents = COALESCE(CAST(${params.filledFeeCents ?? null} AS integer), o.filled_fee_cents),
          -- Evidence belongs to an exact aggregate fill quantity. A resting GTC
          -- order can receive more fills, so invalidate the prior aggregate
          -- whenever the exchange-reported count changes.
          actual_fill_price_cents = CASE
            WHEN incoming.filled_contracts IS NOT NULL
              AND o.filled_contracts IS DISTINCT FROM incoming.filled_contracts
            THEN NULL ELSE o.actual_fill_price_cents END,
          actual_notional_dollars = CASE
            WHEN incoming.filled_contracts IS NOT NULL
              AND o.filled_contracts IS DISTINCT FROM incoming.filled_contracts
            THEN NULL ELSE o.actual_notional_dollars END,
          actual_fee_dollars = CASE
            WHEN incoming.filled_contracts IS NOT NULL
              AND o.filled_contracts IS DISTINCT FROM incoming.filled_contracts
            THEN NULL ELSE o.actual_fee_dollars END,
          fill_economics_verified_at_ms = CASE
            WHEN incoming.filled_contracts IS NOT NULL
              AND o.filled_contracts IS DISTINCT FROM incoming.filled_contracts
            THEN NULL ELSE o.fill_economics_verified_at_ms END,
          fill_economics_verified_contracts = CASE
            WHEN incoming.filled_contracts IS NOT NULL
              AND o.filled_contracts IS DISTINCT FROM incoming.filled_contracts
            THEN NULL ELSE o.fill_economics_verified_contracts END,
          updated_at_ms = ${Date.now()}
        FROM (SELECT CAST(${params.filledContracts ?? null} AS numeric) AS filled_contracts) AS incoming
        WHERE o.id = ${params.id}
          AND o.generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND o.created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND (${terminal === false} OR o.filled_contracts IS NULL
            OR o.outcome NOT IN ('full_fill','partial_fill','zero_fill','zero_fill_verified','error','expired')
            OR (${params.terminalFillRefresh === true}
              AND o.outcome IN ('full_fill','partial_fill')
              AND incoming.filled_contracts > o.filled_contracts
              AND o.filled_contracts = CAST(${params.priorFilledContracts ?? null} AS numeric)
              AND o.filled_fee_cents IS NOT DISTINCT FROM CAST(${params.priorFilledFeeCents ?? null} AS integer)))
        RETURNING o.requested_contracts, o.no_price_cents, o.reserved_fee_cents, o.eastern_date`);
      const row = (result as unknown as { rows: Array<{
        requested_contracts: number; no_price_cents: number; reserved_fee_cents: number; eastern_date: string;
      }> }).rows[0];
      if (!row) return false;
      if (terminal) {
        if (params.terminalFillRefresh) {
          // A terminal row already released its unused reservation. Charge only
          // the later authenticated fill and fee delta; re-releasing the whole
          // reservation here would understate the live day's exposure.
          await tx.execute(sql`
            UPDATE eth_martingale_state SET spent_cents = GREATEST(0, spent_cents + ROUND(
              (CAST(${params.filledContracts!} AS numeric) - CAST(${params.priorFilledContracts!} AS numeric))
                * CAST(${row.no_price_cents} AS numeric)
              + CAST(${params.filledFeeCents ?? 0} AS numeric)
              - CAST(${params.priorFilledFeeCents ?? 0} AS numeric)
            )::integer)
            WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
              AND eastern_date = ${row.eastern_date}`);
        } else {
          // Release: what we over-reserved = unused principal + unused fee.
          // Reserved = req*price + reserved_fee. Actual cost = filled*price + filled_fee.
          // Return = (req - filled)*price + (reserved_fee - filled_fee).
          await tx.execute(sql`
            UPDATE eth_martingale_state SET spent_cents = GREATEST(0, spent_cents - (
              ROUND(
                (CAST(${row.requested_contracts} AS numeric) - CAST(${params.filledContracts!} AS numeric))
                  * CAST(${row.no_price_cents} AS numeric)
                + CAST(${row.reserved_fee_cents} AS numeric) - CAST(${params.filledFeeCents ?? 0} AS numeric)
              )::integer))
            WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
              AND eastern_date = ${row.eastern_date}`);
        }
      }
      return true;
    });
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `eth order update failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("reconciliation"); _scheduleRetry();
    logger.warn({ err, id: params.id }, "eth: order update failed closed; reconciliation will retry after database recovery");
    return false;
  }
}

/**
 * Persist the aggregate of Kalshi's immutable fill chunks. This deliberately
 * does not alter the pre-POST reservation or ladder state: it is evidence for
 * settlement accounting, not a new execution path.
 */
export async function recordEthMartingaleFillEconomics(params: {
  id: string; contracts: number; fillPriceCents: number;
  notionalDollars: string; feeDollars: string;
}): Promise<boolean> {
  if (!_db || !_healthy) return false;
  if (!Number.isFinite(params.contracts) || params.contracts <= 0
    || !Number.isFinite(params.fillPriceCents)
    || !/^\d+(?:\.\d+)?$/.test(params.notionalDollars)
    || !/^\d+(?:\.\d+)?$/.test(params.feeDollars)) return false;
  try {
    const result = await _db.execute(sql`
      UPDATE eth_martingale_orders SET
        actual_fill_price_cents = ${Math.round(params.fillPriceCents)},
        actual_notional_dollars = ${params.notionalDollars},
        actual_fee_dollars = ${params.feeDollars},
        fill_economics_verified_at_ms = ${Date.now()},
        fill_economics_verified_contracts = ${params.contracts},
        updated_at_ms = ${Date.now()}
      WHERE id = ${params.id}
        AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        AND filled_contracts = ${params.contracts}
      RETURNING id, eastern_date, settlement_result`);
    const row = (result as unknown as {
      rows: Array<{ eastern_date: string; settlement_result: string | null }>;
    }).rows[0];
    if (!row) return false;
    // Historical rows may have been settled before their exact fill chunks were
    // retained. Once every settled row for the ET day has evidence, replace the
    // old limit-price aggregate atomically with an evidence-only aggregate.
    if (row.settlement_result === "yes" || row.settlement_result === "no") {
      await recomputeEthMartingaleDailyPnl(String(row.eastern_date));
    }
    return true;
  } catch (err) {
    logger.warn({ err, id: params.id }, "eth: fill economics write failed");
    return false;
  }
}

async function recomputeEthMartingaleDailyPnl(easternDate: string): Promise<void> {
  if (!_db || !_healthy) return;
  const result = await _db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE actual_notional_dollars IS NULL OR actual_fee_dollars IS NULL) AS missing,
      COALESCE(SUM(CASE WHEN settlement_result = side
        THEN filled_contracts * 100 - ROUND((actual_notional_dollars + actual_fee_dollars) * 100)::integer
        ELSE -ROUND((actual_notional_dollars + actual_fee_dollars) * 100)::integer
      END), 0) AS pnl_cents
    FROM eth_martingale_orders
    WHERE eastern_date = ${easternDate}
      AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
      AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
      AND settlement_result IS NOT NULL
      AND manual_settlement_override = false`);
  const row = (result as unknown as { rows: Array<{ missing: string | number; pnl_cents: string | number }> }).rows[0];
  if (!row || Number(row.missing) !== 0) return;
  await _db.execute(sql`
    UPDATE eth_martingale_state
    SET realized_pnl_cents = ${Math.round(Number(row.pnl_cents))}, updated_at_ms = ${Date.now()}
    WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
      AND eastern_date = ${easternDate}`);
}

export async function listUnsettledEthMartingaleOrders(): Promise<EthMartingaleOrder[] | null> {
  if (!_db || !_healthy) {
    recordDbBlockedOperation("reconciliation");
    return null;
  }
  try {
    const result = await _db.execute(sql`
      SELECT * FROM eth_martingale_orders
      WHERE settlement_result IS NULL
        AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        AND outcome IN ('pending','post_started','resting','full_fill','partial_fill','unresolved')
      ORDER BY created_at_ms ASC`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
      id: String(r["id"]), ticker: String(r["ticker"]), easternDate: String(r["eastern_date"]),
      martingaleStep: Number(r["martingale_step"]),
      side: r["side"] === "yes" ? "yes" as const : "no" as const,
      clientOrderId: String(r["client_order_id"]),
      kalshiOrderId: r["kalshi_order_id"] == null ? null : String(r["kalshi_order_id"]),
      noPriceCents: Number(r["no_price_cents"]), requestedContracts: Number(r["requested_contracts"]),
      reservedFeeCents: Number(r["reserved_fee_cents"]),
      filledContracts: r["filled_contracts"] == null ? null : Number(r["filled_contracts"]),
      filledFeeCents: r["filled_fee_cents"] == null ? null : Number(r["filled_fee_cents"]),
      rejectionReason: r["rejection_reason"] == null ? null : String(r["rejection_reason"]),
      actualFillPriceCents: r["actual_fill_price_cents"] == null ? null : Number(r["actual_fill_price_cents"]),
      actualNotionalDollars: r["actual_notional_dollars"] == null ? null : Number(r["actual_notional_dollars"]),
      actualFeeDollars: r["actual_fee_dollars"] == null ? null : Number(r["actual_fee_dollars"]),
      fillEconomicsVerifiedAtMs: r["fill_economics_verified_at_ms"] == null ? null : Number(r["fill_economics_verified_at_ms"]),
      fillEconomicsVerifiedContracts: r["fill_economics_verified_contracts"] == null ? null : Number(r["fill_economics_verified_contracts"]),
      outcome: String(r["outcome"]), settlementResult: null, createdAtMs: Number(r["created_at_ms"]),
      submissionVersion: Number(r["submission_version"]),
      manualSettlementOverride: Boolean(r["manual_settlement_override"]),
      manualRecoveryId: r["manual_recovery_id"] == null ? null : String(r["manual_recovery_id"]),
    }));
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `eth unsettled-order list failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("reconciliation"); _scheduleRetry();
    logger.warn({ err }, "eth: unsettled order list failed closed");
    return null;
  }
}

/**
 * Regular zero-fill orders whose ladder outcome has not been recognized yet.
 * They are intentionally excluded from the exposure settlement queue because
 * no contracts or financial accounting remain, but the official market outcome
 * still determines the next side and step. Verified closed-GTC no-attempt
 * handoffs use `zero_fill_verified` and intentionally do not enter this queue.
 */
export async function listUnsettledEthMartingaleZeroFillOrders(): Promise<EthMartingaleOrder[] | null> {
  if (!_db || !_healthy) {
    recordDbBlockedOperation("reconciliation");
    return null;
  }
  try {
    const result = await _db.execute(sql`
      SELECT * FROM eth_martingale_orders
      WHERE settlement_result IS NULL
        AND generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        AND outcome = 'zero_fill'
      ORDER BY created_at_ms ASC`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
      id: String(r["id"]), ticker: String(r["ticker"]), easternDate: String(r["eastern_date"]),
      martingaleStep: Number(r["martingale_step"]),
      side: r["side"] === "yes" ? "yes" as const : "no" as const,
      clientOrderId: String(r["client_order_id"]),
      kalshiOrderId: r["kalshi_order_id"] == null ? null : String(r["kalshi_order_id"]),
      noPriceCents: Number(r["no_price_cents"]), requestedContracts: Number(r["requested_contracts"]),
      reservedFeeCents: Number(r["reserved_fee_cents"]),
      filledContracts: r["filled_contracts"] == null ? null : Number(r["filled_contracts"]),
      filledFeeCents: r["filled_fee_cents"] == null ? null : Number(r["filled_fee_cents"]),
      rejectionReason: r["rejection_reason"] == null ? null : String(r["rejection_reason"]),
      actualFillPriceCents: r["actual_fill_price_cents"] == null ? null : Number(r["actual_fill_price_cents"]),
      actualNotionalDollars: r["actual_notional_dollars"] == null ? null : Number(r["actual_notional_dollars"]),
      actualFeeDollars: r["actual_fee_dollars"] == null ? null : Number(r["actual_fee_dollars"]),
      fillEconomicsVerifiedAtMs: r["fill_economics_verified_at_ms"] == null ? null : Number(r["fill_economics_verified_at_ms"]),
      fillEconomicsVerifiedContracts: r["fill_economics_verified_contracts"] == null ? null : Number(r["fill_economics_verified_contracts"]),
      outcome: String(r["outcome"]), settlementResult: null, createdAtMs: Number(r["created_at_ms"]),
      submissionVersion: Number(r["submission_version"]),
      manualSettlementOverride: Boolean(r["manual_settlement_override"]),
      manualRecoveryId: r["manual_recovery_id"] == null ? null : String(r["manual_recovery_id"]),
    }));
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `eth zero-fill ladder list failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("reconciliation"); _scheduleRetry();
    logger.warn({ err }, "eth: zero-fill ladder list failed closed");
    return null;
  }
}

/**
 * Records the official result for a proven zero-fill Regular attempt.
 * Zero fills are sequence-neutral: no side flip, rung advance, or rung reset.
 * They also never become chronology owners for later filled settlements.
 */
export async function advanceEthMartingaleLadderForZeroFill(
  id: string, result: "yes" | "no",
): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  try {
    return await _db.transaction(async (tx) => {
      const settled = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET settlement_result=${result}, settled_at_ms=${now}, updated_at_ms=${now}
        WHERE id=${id} AND settlement_result IS NULL AND outcome = 'zero_fill'
          AND generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        RETURNING id`);
      return (settled as unknown as { rows: Array<{ id: string }> }).rows.length === 1;
    });
  } catch (err) {
    logger.warn({ err, id }, "eth: zero-fill result recording failed");
    return false;
  }
}

/** Fill-evidence repair queue, including already-settled historical rows. */
export async function listEthMartingaleOrdersNeedingFillEconomics(): Promise<EthMartingaleOrder[] | null> {
  if (!_db || !_healthy) {
    recordDbBlockedOperation("reconciliation");
    return null;
  }
  try {
    const result = await _db.execute(sql`
      SELECT * FROM eth_martingale_orders
      WHERE generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
        AND kalshi_order_id IS NOT NULL
        AND COALESCE(filled_contracts, 0) > 0
        AND (actual_notional_dollars IS NULL OR actual_fee_dollars IS NULL)
      ORDER BY created_at_ms ASC
      LIMIT 100`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
      id: String(r["id"]), ticker: String(r["ticker"]), easternDate: String(r["eastern_date"]),
      martingaleStep: Number(r["martingale_step"]),
      side: r["side"] === "yes" ? "yes" as const : "no" as const,
      clientOrderId: String(r["client_order_id"]),
      kalshiOrderId: String(r["kalshi_order_id"]),
      noPriceCents: Number(r["no_price_cents"]), requestedContracts: Number(r["requested_contracts"]),
      reservedFeeCents: Number(r["reserved_fee_cents"]),
      filledContracts: Number(r["filled_contracts"]),
      filledFeeCents: r["filled_fee_cents"] == null ? null : Number(r["filled_fee_cents"]),
      rejectionReason: r["rejection_reason"] == null ? null : String(r["rejection_reason"]),
      actualFillPriceCents: r["actual_fill_price_cents"] == null ? null : Number(r["actual_fill_price_cents"]),
      actualNotionalDollars: r["actual_notional_dollars"] == null ? null : Number(r["actual_notional_dollars"]),
      actualFeeDollars: r["actual_fee_dollars"] == null ? null : Number(r["actual_fee_dollars"]),
      fillEconomicsVerifiedAtMs: r["fill_economics_verified_at_ms"] == null ? null : Number(r["fill_economics_verified_at_ms"]),
      fillEconomicsVerifiedContracts: r["fill_economics_verified_contracts"] == null ? null : Number(r["fill_economics_verified_contracts"]),
      outcome: String(r["outcome"]),
      settlementResult: r["settlement_result"] === "yes" || r["settlement_result"] === "no"
        || r["settlement_result"] === "manual_yes" || r["settlement_result"] === "manual_no"
        ? r["settlement_result"] as EthMartingaleOrder["settlementResult"] : null,
      createdAtMs: Number(r["created_at_ms"]), submissionVersion: Number(r["submission_version"]),
      manualSettlementOverride: Boolean(r["manual_settlement_override"]),
      manualRecoveryId: r["manual_recovery_id"] == null ? null : String(r["manual_recovery_id"]),
    }));
  } catch (err) {
    _healthy = false; _lastErrorMsg = String(err); _degradedReason = `eth fill-evidence queue failed: ${_lastErrorMsg}`;
    recordDbBlockedOperation("reconciliation"); _scheduleRetry();
    logger.warn({ err }, "eth: fill-evidence repair queue unavailable");
    return null;
  }
}

async function readEthMartingaleLedgerWithDeadline<T>(
  label: string,
  operation: (client: BoundedReadClient | null) => Promise<T>,
): Promise<T> {
  const read = _withBoundedReadOnlyClient
    ? _withBoundedReadOnlyClient(_ethMartingaleLedgerReadTimeoutMs, operation)
    : operation(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`ETH martingale ${label} read timed out after ${_ethMartingaleLedgerReadTimeoutMs}ms`)),
          _ethMartingaleLedgerReadTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function markEthMartingaleLedgerReadUnavailable(err: unknown, label: string): void {
  // A read-only dashboard request must not change the global storage/trading
  // gate. It only reports the unavailable ledger to its caller; existing
  // write-path failures remain the sole authority for fail-closed trading.
  logger.warn({ err, label }, "eth: martingale ledger unavailable");
}

/** Test-only: shorten the deadline for deterministic storage-outage coverage. */
export function _setEthMartingaleLedgerReadTimeoutForTesting(timeoutMs: number | null): void {
  _ethMartingaleLedgerReadTimeoutMs = timeoutMs ?? ETH_MARTINGALE_LEDGER_READ_TIMEOUT_MS;
}

export async function loadEthMartingaleDashboard(easternDate = easternDay(new Date())): Promise<{
  easternDate: string; state: EthMartingaleState; orders: EthMartingaleOrder[];
} | null> {
  if (!_db || !_healthy) return null;
  try {
    const [state, rows] = await readEthMartingaleLedgerWithDeadline("dashboard", async (client) => {
      if (client) {
        const [stateRows, orderRows] = await Promise.all([
          client.query("SELECT eastern_date, side, martingale_step, spent_cents, realized_pnl_cents FROM eth_martingale_state WHERE strategy_key = $1", [ETH_MARTINGALE_ACTIVE_GENERATION_KEY]),
          client.query("SELECT * FROM eth_martingale_orders WHERE eastern_date = $1 AND generation = $2 AND created_at_ms >= $3 ORDER BY created_at_ms DESC", [easternDate, ETH_MARTINGALE_ACTIVE_GENERATION_KEY, ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS]),
        ]);
        const row = stateRows.rows[0];
        const state = row ? {
          easternDate: String(row["eastern_date"]),
          side: row["side"] === "yes" ? "yes" as const : "no" as const,
          martingaleStep: Number(row["martingale_step"]),
          spentCents: Number(row["spent_cents"]),
          realizedPnlCents: Number(row["realized_pnl_cents"] ?? 0),
        } : null;
        return [state, orderRows] as const;
      }
      return Promise.all([
        getEthMartingaleState(),
        _db!.execute(sql`SELECT * FROM eth_martingale_orders
          WHERE eastern_date=${easternDate}
            AND generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
            AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          ORDER BY created_at_ms DESC`),
      ]);
    });
    const currentState = state && state.easternDate === easternDate
      ? state
      : { easternDate, side: "no" as const, martingaleStep: 0, spentCents: 0, realizedPnlCents: 0 };
    const orders = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
      id: String(r["id"]), ticker: String(r["ticker"]), easternDate: String(r["eastern_date"]),
      martingaleStep: Number(r["martingale_step"]),
      side: r["side"] === "yes" ? "yes" as const : "no" as const,
      clientOrderId: String(r["client_order_id"]),
      kalshiOrderId: r["kalshi_order_id"] == null ? null : String(r["kalshi_order_id"]),
      noPriceCents: Number(r["no_price_cents"]), requestedContracts: Number(r["requested_contracts"]),
      reservedFeeCents: Number(r["reserved_fee_cents"]),
      filledContracts: r["filled_contracts"] == null ? null : Number(r["filled_contracts"]),
      filledFeeCents: r["filled_fee_cents"] == null ? null : Number(r["filled_fee_cents"]),
      rejectionReason: r["rejection_reason"] == null ? null : String(r["rejection_reason"]),
      actualFillPriceCents: r["actual_fill_price_cents"] == null ? null : Number(r["actual_fill_price_cents"]),
      actualNotionalDollars: r["actual_notional_dollars"] == null ? null : Number(r["actual_notional_dollars"]),
      actualFeeDollars: r["actual_fee_dollars"] == null ? null : Number(r["actual_fee_dollars"]),
      fillEconomicsVerifiedAtMs: r["fill_economics_verified_at_ms"] == null ? null : Number(r["fill_economics_verified_at_ms"]),
      fillEconomicsVerifiedContracts: r["fill_economics_verified_contracts"] == null ? null : Number(r["fill_economics_verified_contracts"]),
      outcome: String(r["outcome"]),
      settlementResult: r["settlement_result"] === "yes" || r["settlement_result"] === "no"
        || r["settlement_result"] === "manual_yes" || r["settlement_result"] === "manual_no"
        ? r["settlement_result"] as EthMartingaleOrder["settlementResult"] : null,
      createdAtMs: Number(r["created_at_ms"]), submissionVersion: Number(r["submission_version"]),
      manualSettlementOverride: Boolean(r["manual_settlement_override"]),
      manualRecoveryId: r["manual_recovery_id"] == null ? null : String(r["manual_recovery_id"]),
    }));
    return { easternDate, state: currentState, orders };
  } catch (err) {
    markEthMartingaleLedgerReadUnavailable(err, "dashboard");
    return null;
  }
}

/** Load the active ETH generation across an explicit UTC range for reporting. */
export async function loadEthMartingaleLedgerExport(
  fromMs: number,
  toMs: number,
): Promise<EthMartingaleLedgerExportRow[] | null> {
  if (!_db || !_healthy || !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs > toMs) {
    return null;
  }
  try {
    const rows = await readEthMartingaleLedgerWithDeadline("historical export", async (client) => {
      if (client) {
        return client.query(
          `SELECT * FROM eth_martingale_orders
           WHERE generation = $1 AND created_at_ms >= $2 AND created_at_ms <= $3
           ORDER BY created_at_ms ASC`,
          [ETH_MARTINGALE_ACTIVE_GENERATION_KEY, fromMs, toMs],
        );
      }
      return _db!.execute(sql`SELECT * FROM eth_martingale_orders
        WHERE generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${fromMs} AND created_at_ms <= ${toMs}
        ORDER BY created_at_ms ASC`);
    });
    return (rows as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) =>
      projectEthMartingaleLedgerExportRow({
        id: String(r["id"]), ticker: String(r["ticker"]), easternDate: String(r["eastern_date"]),
        martingaleStep: Number(r["martingale_step"]), side: r["side"] === "yes" ? "yes" : "no",
        clientOrderId: String(r["client_order_id"]),
        kalshiOrderId: r["kalshi_order_id"] == null ? null : String(r["kalshi_order_id"]),
        noPriceCents: Number(r["no_price_cents"]), requestedContracts: Number(r["requested_contracts"]),
        reservedFeeCents: Number(r["reserved_fee_cents"]),
        filledContracts: r["filled_contracts"] == null ? null : Number(r["filled_contracts"]),
        filledFeeCents: r["filled_fee_cents"] == null ? null : Number(r["filled_fee_cents"]),
        rejectionReason: r["rejection_reason"] == null ? null : String(r["rejection_reason"]),
        actualFillPriceCents: r["actual_fill_price_cents"] == null ? null : Number(r["actual_fill_price_cents"]),
        actualNotionalDollars: r["actual_notional_dollars"] == null ? null : Number(r["actual_notional_dollars"]),
        actualFeeDollars: r["actual_fee_dollars"] == null ? null : Number(r["actual_fee_dollars"]),
        fillEconomicsVerifiedAtMs: r["fill_economics_verified_at_ms"] == null ? null : Number(r["fill_economics_verified_at_ms"]),
        fillEconomicsVerifiedContracts: r["fill_economics_verified_contracts"] == null ? null : Number(r["fill_economics_verified_contracts"]),
        outcome: String(r["outcome"]),
        settlementResult: r["settlement_result"] === "yes" || r["settlement_result"] === "no"
          || r["settlement_result"] === "manual_yes" || r["settlement_result"] === "manual_no"
          ? r["settlement_result"] : null,
        createdAtMs: Number(r["created_at_ms"]), submissionVersion: Number(r["submission_version"]),
        manualSettlementOverride: Boolean(r["manual_settlement_override"]),
        manualRecoveryId: r["manual_recovery_id"] == null ? null : String(r["manual_recovery_id"]),
        settledAtMs: r["settled_at_ms"] == null ? null : Number(r["settled_at_ms"]),
      }),
    );
  } catch (err) {
    markEthMartingaleLedgerReadUnavailable(err, "historical export");
    return null;
  }
}

/**
 * ETH settlement state machine.
 *
 * Win/loss is determined by comparing the market result against the
 * PERSISTED order side — not the current mutable state table side. This
 * prevents a TOCTOU race where a late settlement for an old order could
 * read the wrong side after earlier settlements have already flipped it.
 *
 *   win  (result === order.side) → side flips yes↔no, step = 0
 *   loss (result !== order.side) → side unchanged, step+1; after step 5 → step 0
 *
 * Full and partial fills use the same official-result ladder transition. Their
 * financial accounting remains based only on the exact contracts and fees
 * actually filled.
 *
 * Financial settlement and sequence ownership are deliberately separate:
 *   - each order's financial result is applied exactly once;
 *   - side/rung may change only when this order is the chronologically newest
 *     real (filled) Regular attempt for its ET day;
 *   - zero-fill / rejected / pre-POST attempts never own sequence chronology.
 *
 * The state row is locked before chronology is checked. Regular reservation
 * updates that same row before inserting their order, so a concurrent newer
 * reservation either commits first and is visible here, or waits and inherits
 * this settlement's completed transition. Step-number equality is never used
 * as an ownership test.
 *
 * Old-date guard: if the order's eastern_date is no longer the current state
 * date, the order remains financially settled in its immutable ledger row but
 * cannot mutate the new day's side/rung or realized-P&L accumulator.
 */
export async function settleEthMartingaleOrder(id: string, result: "yes" | "no"): Promise<boolean> {
  if (!_db || !_healthy) return false;
  const now = Date.now();
  try {
    return await _db.transaction(async (tx) => {
      // Mark the order settled and return its immutable fields.
      const settled = await tx.execute(sql`
        UPDATE eth_martingale_orders
        SET settlement_result=${result}, settled_at_ms=${now}, updated_at_ms=${now}
        WHERE id=${id} AND settlement_result IS NULL
          AND generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND COALESCE(filled_contracts, 0) > 0
          AND actual_notional_dollars IS NOT NULL AND actual_fee_dollars IS NOT NULL
        RETURNING id, created_at_ms, martingale_step, side, eastern_date, no_price_cents,
                  requested_contracts, filled_contracts, actual_notional_dollars, actual_fee_dollars`);
      const row = (settled as unknown as {
        rows: Array<{
          id: string; created_at_ms: number;
          martingale_step: number; side: string; eastern_date: string;
          no_price_cents: number; requested_contracts: number;
          filled_contracts: number; actual_notional_dollars: string | number; actual_fee_dollars: string | number;
        }>;
      }).rows[0];
      if (!row) return false; // already settled or not found — idempotent

      // Determine win/loss using the ORDER's persisted side, not the state table.
      const orderSide: "yes" | "no" = row.side === "yes" ? "yes" : "no";
      const won = result === orderSide;
       const filled = Number(row.filled_contracts);
       const costCents = calculateEthMartingaleCostCents(
         row.actual_notional_dollars, row.actual_fee_dollars,
       );
       if (costCents == null) {
         throw new Error("ETH settlement has invalid exact fill economics");
       }
      // Even-money P&L: win = filled contracts * $1 - cost; loss = -cost
      const pnlDelta = won ? filled * 100 - costCents : -costCents;

      const nextSequence = nextEthMartingaleSequence(orderSide, Number(row.martingale_step), result);

      // Serialize chronology ownership with Regular reservations. Reservation
      // updates this same row before inserting its order, so the newest committed
      // attempt is stable while the ownership query and state update run.
      const stateLock = await tx.execute(sql`
        SELECT eastern_date
        FROM eth_martingale_state
        WHERE strategy_key=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}
        FOR UPDATE`);
      if ((stateLock as unknown as { rows: Array<unknown> }).rows.length === 0) {
        return true; // old ET day: immutable order settlement is complete; current state is untouched
      }

      const newestOwner = await tx.execute(sql`
        SELECT id
        FROM eth_martingale_orders
        WHERE generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND COALESCE(filled_contracts, 0) > 0
        ORDER BY created_at_ms DESC, id DESC
        LIMIT 1`);
      const newestOwnerId = (newestOwner as unknown as { rows: Array<{ id: string }> }).rows[0]?.id ?? null;
      const ownsSequence = isEthMartingaleSequenceOwner(String(row.id), newestOwnerId);

      // Financial accounting is exactly-once because the order transition above
      // succeeds only while settlement_result IS NULL. Sequence fields are gated
      // independently by chronology ownership.
      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET side=CASE WHEN ${ownsSequence} THEN ${nextSequence.side} ELSE side END,
            martingale_step=CASE WHEN ${ownsSequence} THEN ${nextSequence.step} ELSE martingale_step END,
            realized_pnl_cents=realized_pnl_cents + ${pnlDelta},
            updated_at_ms=${now}
          WHERE strategy_key=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}`);
      return true;
    });
  } catch (err) { logger.warn({ err, id }, "eth: settlement update failed"); return false; }
}

/**
 * Round an exact non-negative dollar aggregate to whole cents without passing
 * through binary floating point. Exchange evidence is stored as decimal
 * numerics; converting values such as 10.075 to Number can incorrectly round
 * 1007.5 cents down.
 */
export function calculateEthMartingaleCostCents(
  notionalDollars: string | number,
  feeDollars: string | number,
): number | null {
  const toMicroDollars = (value: string | number): bigint | null => {
    const text = String(value).trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) return null;
    const whole = BigInt(match[1]);
    const fractionalText = match[2] ?? "";
    if (fractionalText.length <= 6) {
      return whole * 1_000_000n + BigInt(fractionalText.padEnd(6, "0") || "0");
    }

    // PostgreSQL numeric can retain an IEEE-754 tail from historical writes
    // (for example, 0.5250999999999999 for an exact 0.5251 exchange fee).
    // Normalize only residue smaller than one-billionth of a dollar. Values
    // with meaningful precision beyond micro-dollars remain unavailable so
    // realized P&L never silently rounds unverified economics.
    const denominator = 10n ** BigInt(fractionalText.length);
    const fractional = BigInt(fractionalText);
    const scaled = fractional * 1_000_000n;
    const roundedMicro = (scaled + denominator / 2n) / denominator;
    const residue = scaled >= roundedMicro * denominator
      ? scaled - roundedMicro * denominator
      : roundedMicro * denominator - scaled;
    if (residue * 1_000n > denominator) return null;
    return whole * 1_000_000n + roundedMicro;
  };
  const notional = toMicroDollars(notionalDollars);
  const fee = toMicroDollars(feeDollars);
  if (notional == null || fee == null) return null;
  const roundedCents = (notional + fee + 5_000n) / 10_000n;
  return roundedCents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(roundedCents) : null;
}

/** Fixed launch boundary: 2026-08-23 05:15 America/New_York (09:15 UTC). */
export const ETH_MARTINGALE_SESSION_STARTED_AT_MS = Date.UTC(2026, 7, 23, 9, 15);

export type EthMartingaleSessionProfitRow = {
  side: "yes" | "no";
  settlementResult: "yes" | "no" | null;
  filledContracts: number | null;
  actualNotionalDollars: string | number | null;
  actualFeeDollars: string | number | null;
};

/**
 * Derive session realized P&L exclusively from immutable fill evidence.
 * A settled row with exposure but missing actual cost or fee evidence makes
 * the aggregate unavailable rather than showing a misleading partial total.
 */
export function calculateEthMartingaleSessionRealizedPnlCents(
  rows: EthMartingaleSessionProfitRow[],
): { realizedPnlCents: number | null; settledOrderCount: number } {
  let realizedPnlCents = 0;
  let settledOrderCount = 0;

  for (const row of rows) {
    if (row.settlementResult == null || (row.filledContracts ?? 0) <= 0) continue;
    const filledContracts = row.filledContracts!;
    if (
      row.actualNotionalDollars == null ||
      row.actualFeeDollars == null
    ) {
      return { realizedPnlCents: null, settledOrderCount };
    }
    const costCents = calculateEthMartingaleCostCents(row.actualNotionalDollars, row.actualFeeDollars);
    if (costCents == null) return { realizedPnlCents: null, settledOrderCount };
    realizedPnlCents += row.settlementResult === row.side
      ? filledContracts * 100 - costCents
      : -costCents;
    settledOrderCount++;
  }
  return { realizedPnlCents, settledOrderCount };
}

/**
 * Cumulative realized P&L for the active ETH martingale generation.
 * This intentionally does not use daily state, reserved fees, limit prices,
 * mark-to-market values, or unsettled exposure.
 */
export async function loadEthMartingaleSessionProfit(): Promise<{
  startedAtMs: number; realizedPnlCents: number | null; settledOrderCount: number;
} | null> {
  if (!_db || !_healthy) return null;
  try {
    const result = await readEthMartingaleLedgerWithDeadline("session profit", async (client) => {
      if (client) {
        return client.query(
          `SELECT side, settlement_result, filled_contracts,
                  actual_notional_dollars, actual_fee_dollars
           FROM eth_martingale_orders
            WHERE generation = $1
              AND created_at_ms >= $2
             AND settlement_result IS NOT NULL
             AND manual_settlement_override = false`,
          [ETH_MARTINGALE_ACTIVE_GENERATION_KEY, ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS],
        );
      }
      return _db!.execute(sql`
        SELECT side, settlement_result, filled_contracts,
               actual_notional_dollars, actual_fee_dollars
        FROM eth_martingale_orders
        WHERE generation = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND created_at_ms >= ${ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS}
          AND settlement_result IS NOT NULL
          AND manual_settlement_override = false`);
    });
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => ({
      side: row["side"] === "yes" ? "yes" as const : "no" as const,
      settlementResult: row["settlement_result"] === "yes" || row["settlement_result"] === "no"
        ? row["settlement_result"] as "yes" | "no" : null,
      filledContracts: row["filled_contracts"] == null ? null : Number(row["filled_contracts"]),
      // PostgreSQL numeric values remain decimal strings until the exact,
      // half-up cents helper consumes them. This avoids floating point drift.
      actualNotionalDollars: row["actual_notional_dollars"] == null ? null : String(row["actual_notional_dollars"]),
      actualFeeDollars: row["actual_fee_dollars"] == null ? null : String(row["actual_fee_dollars"]),
    }));
    const summary = calculateEthMartingaleSessionRealizedPnlCents(rows);
    return {
      startedAtMs: ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS,
      realizedPnlCents: summary.realizedPnlCents,
      settledOrderCount: summary.settledOrderCount,
    };
  } catch (err) {
    markEthMartingaleLedgerReadUnavailable(err, "session profit");
    return null;
  }
}
