import app from "./app";
import { db } from "@workspace/db";
import { logger } from "./lib/logger";
import { kalshiStream } from "./lib/kalshiStream";
import { startAutoTrader, getAutoTraderStatus } from "./lib/autoTrader";
import {
  getEthOrderSubmissionStatus,
  isWorkspaceEnvironment,
  isProductionRuntime,
  isTradingHalted,
  isEnvLocked,
} from "./lib/tradingKillSwitch";
import { flushTradeState, applyRestoredBudget, applyRestoredDedupSlots, getCurrentBudget } from "./routes/trade";
import { initializeAnalyticsStore } from "./lib/analyticsStore";
import { runPreflightSettlementBackfill } from "./lib/outcomeReconciler";
import { wlLoad, wlRestoreFromSqlIfEmpty } from "./lib/windowLog";
import {
  initTradeStore,
  restoreState,
  upsertStrategyVersionInSql,
  markAttemptInterruptedShutdown,
  recoverForwardSettlementsFromSql,
  reconcileSettlementForReconciledOrders,
  getOpenConfirmedPositions,
  getOpenLegacyPositionTickers,
  listOpenEthMartingaleOrderIdentities,
  recordEvaluationEventToSql,
  backfillEvaluationEventsFromFiles,
  recordCoverageIncidentToSql,
  backfillCoverageIncidentsFromFiles,
  recordCoverageWindowAuditToSql,
  recordRuntimeWatchdogPollToSql,
  recordKalshiReadNetworkEvent,
  backfillCoverageWindowAuditsFromFiles,
  loadUnfinishedCoverageWindowAuditsFromSql,
  pruneTargetLiquiditySnapshots,
  pruneEth420CandidateExecutionSnapshots,
  TARGET_LIQUIDITY_SNAPSHOT_RETENTION_DAYS,
  backfillEth420CounterfactualSettlements,
} from "./lib/tradeStore.js";
import * as tradeStore from "./lib/tradeStore.js";
import { setEvaluationEventSqlWriter } from "./lib/evaluationEventStore.js";
import { hydrateUnfinishedCoverageAudits, runCoverageCheck, setCoverageAuditSqlWriter, setCoverageIncidentSqlWriter } from "./lib/marketDataCoverage.js";
import { submissionOrderIds } from "./lib/autoTraderGuards.js";
import { easternDay } from "./lib/dailyBudget.js";
import { ETH2125_DEPTH_STRATEGY, shouldRetainEth2125DepthEvidence } from "./lib/strategies/eth2125Prospective.js";
import { startReportScheduler } from "./lib/reportScheduler.js";
import { STRATEGY_VERSION } from "./strategy/decide.js";
import { hydrateMandelbrotPathsFromFile } from "./lib/mandelbrotInstability.js";
import {
  reconcileUnreconciledFilledOrders,
  discoverAndReconcileMissingBotFills,
  retrySweepIncompleteHistory,
  checkExchangeFillCoverage,
} from "./lib/fillReconciler.js";
import { startWatchdog, getWatchdogStatus } from "./lib/runtimeWatchdog.js";
import { appendWatchdogPollToFile, setWatchdogHistorySink } from "./lib/runtimeWatchdog.js";
import { setKalshiReadNetworkEventSink } from "./lib/kalshiAuth.js";
import { startRuntimeHeartbeat, stopRuntimeHeartbeat } from "./lib/runtimeHeartbeat.js";
import { getProtectiveExitMonitorStatus, startProtectiveExitRestoreCoordinator } from "./lib/protectiveExit.js";
import { reconcileEthMartingaleSettlements } from "./lib/strategies/ethOnlyMartingale.js";
import {
  bootstrapEth420PercentileHistory,
  reconcileEth420CandidateLiveSettlements,
} from "./lib/strategies/eth420SixStepCandidate.js";
import { resumeEth420CandidateExecutionTelemetry } from "./lib/eth420ExecutionTelemetry.js";
import { refreshEth420RunawayResearch } from "./lib/eth420RunawayResearch.js";
import { runEthBigBetAccountingSweepSingleFlight } from "./lib/strategies/ethBigBetAccountingSweep.js";
import {
  WEEK_2_PRODUCTION_NEW_ENTRY_SERIES,
} from "./lib/week2EntryPolicy.js";
import {
  PostgresA2ShadowStore,
  ensureA2BaselineReversionShadowSchema,
} from "./lib/strategies/a2BaselineReversionShadowStore.js";
import { startA2BaselineReversionRuntime } from "./lib/strategies/a2BaselineReversionRuntime.js";

const FILL_RECONCILIATION_RECOVERY_INTERVAL_MS = 15 * 60_000;
const PROTECTIVE_EXIT_RESTORE_RETRY_INTERVAL_MS = 15_000;
const ETH_MARTINGALE_LIFECYCLE_SWEEP_INTERVAL_MS = 60_000;
const ETH_420_CANDIDATE_LIFECYCLE_SWEEP_INTERVAL_MS = 60_000;
const ETH_420_RUNAWAY_RESEARCH_REFRESH_INTERVAL_MS = 60_000;
const ETH_BIG_BET_ACCOUNTING_SWEEP_INTERVAL_MS = 5 * 60_000;
const ETH_MARKET_WINDOW_MS = 15 * 60_000;
const ETH_BOUNDARY_SETTLEMENT_OFFSETS_MS = [
  1_000, 3_000, 5_000, 8_000, 12_000, 18_000, 25_000, 35_000, 45_000, 55_000,
] as const;
/**
 * The old cross-strategy protective-exit restore monitor can replay every
 * historical BTC/SOL/DOGE position at startup. It is deliberately opt-in while
 * the clean ETH martingale owns live execution, so retained historical rows
 * cannot consume the exchange read budget or revive a legacy trading path.
 */
const legacyProtectiveExitRestoreEnabled =
  process.env["LEGACY_PROTECTIVE_EXIT_RESTORE_ENABLED"] === "true";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Restore window log history before the server begins accepting connections
wlLoad();

app.listen(port, "0.0.0.0", async () => {
  // ── Cold-start banner ────────────────────────────────────────────────────────
  // Emitted as the very first structured log line so a production cold-start is
  // immediately identifiable without back-calculating from request IDs.
  logger.info(
    {
      pid:                  process.pid,
      timestamp:            new Date().toISOString(),
      environment:          isWorkspaceEnvironment() ? "workspace" : "production",
      auto_trading_enabled: process.env["AUTO_TRADING_ENABLED"] !== "false",
      live_strategy: "ETH_NO_MARTINGALE",
      legacy_strategy_execution: "disabled",
      research_collectors: "disabled",
      ...getEthOrderSubmissionStatus("KXETH15M-startup"),
      commit_sha:           process.env["COMMIT_SHA"] ?? "unknown",
      port,
    },
    "Server cold start",
  );

  // ── Durable SQL storage init ────────────────────────────────────────────────
  // Must complete before startAutoTrader() so the storage health flag is set
  // before any order attempt. If SQL is unavailable, claimOrderSlot() returns
  // false and trading is halted until storage recovers.
  await initTradeStore();

  // A2 has its own isolated BTC runtime. This mode deliberately returns before
  // any ETH WebSocket, auto-trader, settlement, or authenticated trade API
  // startup path is armed. A2 remains shadow-only and cannot submit orders.
  if (isProductionRuntime() && process.env["A2_BASELINE_RUNTIME_ONLY"] === "true") {
    await ensureA2BaselineReversionShadowSchema(db);
    const a2Store = new PostgresA2ShadowStore(db);
    startA2BaselineReversionRuntime(a2Store);
    logger.info(
      {
        strategy: "a2_baseline_reversion",
        enabled: process.env["A2_BASELINE_REVERSION_ENABLED"] === "true",
        runtimeOnly: true,
        orderSubmissionPermitted: false,
      },
      "A2 baseline reversion runtime-only service started",
    );
    return;
  }

  // Read-only evidence bootstrap. It is intentionally non-blocking so an
  // unavailable public catalog cannot delay the authoritative runner; until a
  // complete history arrives, ETH 420 remains on its existing live-only input.
  void bootstrapEth420PercentileHistory().catch((err) =>
    logger.warn({ err }, "ETH 420 percentile bootstrap failed; retaining live telemetry only"),
  );
  void backfillEth420CounterfactualSettlements()
    .then((settled) => { if (settled) logger.info({ settled }, "ETH 420 counterfactual settlement startup backfill complete"); });
  const runtimeRunId = `${process.pid}:${Date.now()}`;
  const runtimeStartedAt = new Date().toISOString();
  await startRuntimeHeartbeat({
    runId: runtimeRunId,
    startedAt: runtimeStartedAt,
    getComponents: () => {
      const autoTrader = getAutoTraderStatus();
      const watchdog = getWatchdogStatus();
      return {
        runner: true,
        collector: autoTrader.lastTickMs > 0 && Date.now() - autoTrader.lastTickMs <= 120_000,
        watchdog: watchdog.lastPolledAt !== null && watchdog.lastPollSuccess === true,
        websocket: kalshiStream.isConnected(),
        protectiveExit: getProtectiveExitMonitorStatus().enabled,
      };
    },
  });
  setKalshiReadNetworkEventSink(recordKalshiReadNetworkEvent);
  // Backfill pre-deployment evaluation history from NDJSON files into SQL.
  // Must be awaited BEFORE the live SQL writer is registered: if the live
  // writer were active during the scan, any event written to NDJSON while
  // the import runs would receive a random UUID in SQL AND a bf:<idx> ID on
  // import — two rows for the same event, undetectable by onConflictDoNothing.
  // The backfill is fast (one-time, local disk + batched SQL) and only runs
  // on the first startup after deployment (guarded by a marker file).
  await backfillEvaluationEventsFromFiles();
  // Wire the SQL write hook so evaluation events are durably persisted to the
  // database in addition to the NDJSON backup files.
  setEvaluationEventSqlWriter(recordEvaluationEventToSql);
  // Backfill pre-deployment coverage incident history from NDJSON files into
  // SQL so that diagnostic history survives a production redeploy.
  await backfillCoverageIncidentsFromFiles();
  await backfillCoverageWindowAuditsFromFiles();
  // Wire the SQL write hook so future coverage incidents dual-write to SQL.
  setCoverageIncidentSqlWriter(recordCoverageIncidentToSql);
  // Permanent coverage audits are separate from short-retention incidents.
  setCoverageAuditSqlWriter(recordCoverageWindowAuditToSql);
  hydrateUnfinishedCoverageAudits(await loadUnfinishedCoverageWindowAuditsFromSql());
  // One bounded pass seals any restored window that already closed while down.
  runCoverageCheck();
  const today = easternDay(new Date());
  const restored = await restoreState(today);
  applyRestoredBudget(restored.spentCents);
  applyRestoredDedupSlots(restored.dedupSlots);
  await wlRestoreFromSqlIfEmpty();
  // Position enumeration and the live protective-exit monitor belong to the
  // authoritative production VM only. A workspace must never become a second
  // order-producing process, even for exits.
  if (isProductionRuntime() && legacyProtectiveExitRestoreEnabled) {
    startProtectiveExitRestoreCoordinator({
      loadPositions: getOpenConfirmedPositions,
      loadLegacyTickers: getOpenLegacyPositionTickers,
      loadEthMartingaleOrders: listOpenEthMartingaleOrderIdentities,
      retryIntervalMs: PROTECTIVE_EXIT_RESTORE_RETRY_INTERVAL_MS,
    });
  } else if (isProductionRuntime()) {
    logger.info(
      { legacyProtectiveExitRestoreEnabled: false },
      "Legacy protective-exit restore monitor disabled for ETH martingale rebuild",
    );
  }
  upsertStrategyVersionInSql(STRATEGY_VERSION);
  // Sync current budget (whichever is higher — file or SQL) back to SQL so that
  // any spending that occurred before this deployment is also durable in SQL.
  const syncBudget = getCurrentBudget();
  void import("./lib/tradeStore.js").then(({ persistBudgetToSql }) =>
    persistBudgetToSql(syncBudget.date, syncBudget.spentCents),
  );
  // ─────────────────────────────────────────────────────────────────────────────

  // Only the published production VM is allowed to own the live runner. A
  // workspace browser can inspect the API but cannot create a second WebSocket,
  // evaluator, watchdog, collector, or protective-exit order path.
  if (isProductionRuntime()) {
    kalshiStream.start().catch((e) =>
      logger.error({ e }, "KalshiStream start failed"),
    );
    startAutoTrader();
    // Independent of the dashboard/SSE: authenticated loopback telemetry probe only.
    setWatchdogHistorySink((poll) => {
      appendWatchdogPollToFile(poll);
      recordRuntimeWatchdogPollToSql(poll);
    });
    startWatchdog();
    // ETH GTC lifecycle repair must not depend on an open browser, WebSocket
    // tick, or the broad market REST refresh. It runs after SQL restoration and
    // shares the strategy's single-flight guard with autoTrader reconciliation.
    const runEthMartingaleLifecycleSweep = () => {
      void reconcileEthMartingaleSettlements().then((reconciled) => {
        if (!reconciled) logger.warn("ETH martingale lifecycle sweep retained unresolved exposure");
      }).catch((err) => logger.warn({ err }, "ETH martingale lifecycle sweep failed"));
    };
    runEthMartingaleLifecycleSweep();
    const ethMartingaleLifecycleTimer = setInterval(
      runEthMartingaleLifecycleSweep,
      ETH_MARTINGALE_LIFECYCLE_SWEEP_INTERVAL_MS,
    );
    ethMartingaleLifecycleTimer.unref();
    // Candidate orders have their own isolated ledger and state transition.
    // Run after SQL restoration and independently of market ticks so a filled
    // candidate order cannot remain submitted while waiting for the next UI,
    // websocket, or entry-evaluation event.
    const runEth420CandidateLifecycleSweep = () => {
      void reconcileEth420CandidateLiveSettlements(tradeStore).then((settled) => {
        if (settled) logger.info({ settled }, "ETH 420 candidate lifecycle sweep settled orders");
      }).catch((err) => logger.warn({ err }, "ETH 420 candidate lifecycle sweep failed"));
    };
    runEth420CandidateLifecycleSweep();

    // B/C settlement is accounting-only and never controls future strategy
    // evaluation. Retry incomplete authenticated fill evidence at startup and
    // on a low-cadence single-flight timer so resolved rows release reserved
    // capital without coupling B/C to martingale settlement state.
    const runEthBigBetAccountingSweep = () => {
      void runEthBigBetAccountingSweepSingleFlight().then((result) => {
        if (result.settledRows > 0 || result.unresolvedRows > 0 || result.errors > 0) {
          logger.info(result, "B/C accounting retry sweep completed");
        }
      }).catch((err) => logger.warn({ err }, "B/C accounting retry sweep failed"));
    };
    runEthBigBetAccountingSweep();
    const ethBigBetAccountingSweepTimer = setInterval(
      runEthBigBetAccountingSweep,
      ETH_BIG_BET_ACCOUNTING_SWEEP_INTERVAL_MS,
    );
    ethBigBetAccountingSweepTimer.unref();

    // Every ETH 15-minute close gets the same fast lifecycle treatment. This
    // accelerates both the ordinary martingale and the isolated ETH420 ledger,
    // while their existing 60-second timers remain independent recovery paths.
    // The strategy reconcilers retain their own single-flight/fail-closed rules;
    // these timers only ask them to re-check settlement evidence sooner.
    const runEthBoundaryLifecycleSweep = () => {
      runEthMartingaleLifecycleSweep();
      runEth420CandidateLifecycleSweep();
    };
    const scheduleEthBoundarySettlementBurst = () => {
      const now = Date.now();
      const boundaryAtMs = Math.floor(now / ETH_MARKET_WINDOW_MS) * ETH_MARKET_WINDOW_MS
        + ETH_MARKET_WINDOW_MS;
      const boundaryTimer = setTimeout(() => {
        for (const offsetMs of ETH_BOUNDARY_SETTLEMENT_OFFSETS_MS) {
          const timer = setTimeout(
            runEthBoundaryLifecycleSweep,
            Math.max(0, boundaryAtMs + offsetMs - Date.now()),
          );
          timer.unref();
        }
        scheduleEthBoundarySettlementBurst();
      }, Math.max(0, boundaryAtMs - now));
      boundaryTimer.unref();
    };
    scheduleEthBoundarySettlementBurst();

    void resumeEth420CandidateExecutionTelemetry(tradeStore).catch((err) =>
      logger.warn({ err }, "ETH 420 candidate execution telemetry resume failed"));
    // Research-only: reads retained candidate/snapshot rows and upserts a
    // separate classifier table. It has no execution or candidate-state API.
    const runEth420RunawayResearchRefresh = () => {
      void refreshEth420RunawayResearch(tradeStore).catch((err) =>
        logger.warn({ err }, "ETH 420 runaway research refresh failed"));
    };
    runEth420RunawayResearchRefresh();
    const eth420RunawayResearchTimer = setInterval(
      runEth420RunawayResearchRefresh,
      ETH_420_RUNAWAY_RESEARCH_REFRESH_INTERVAL_MS,
    );
    eth420RunawayResearchTimer.unref();
    const eth420CandidateLifecycleTimer = setInterval(
      runEth420CandidateLifecycleSweep,
      ETH_420_CANDIDATE_LIFECYCLE_SWEEP_INTERVAL_MS,
    );
    eth420CandidateLifecycleTimer.unref();
  } else {
    logger.warn(
      { environment: "workspace", live_runner_started: false },
      "Workspace runner disabled — production VM is the only authoritative trading process",
    );
  }
  // Repair any fills whose short post-order reconciliation window was interrupted
  // by a restart or API delay. This is read-only against Kalshi and runs in the
  // background, one order at a time, so it cannot affect order submission.
  const runFillRecoverySweep = () => {
    void reconcileUnreconciledFilledOrders().catch((err) =>
      logger.warn({ err }, "fillReconciler: recovery sweep failed"),
    );
    // Re-sweep any exchange-history dates left incomplete from startup (e.g.
    // because the market was open when the date was first swept, a DB write
    // failed, or pagination was truncated).  The inner in-flight guard
    // serializes concurrent calls, so this is safe to run alongside the
    // fill-chunk recovery sweep.
    void retrySweepIncompleteHistory().catch((err) =>
      logger.warn({ err }, "fillReconciler: incomplete-sweep retry failed"),
    );
  };
  // On startup: chain settlement recovery AFTER the fill sweep so any order
  // that gains canonical_economics=true during this sweep is visible to the
  // settlement query. Subsequent periodic ticks use runFillRecoverySweep()
  // which fires both concurrently (acceptable since the ordering race only
  // matters on the first startup sweep when offline settlements accumulate).
  void reconcileUnreconciledFilledOrders()
    .then(() => reconcileSettlementForReconciledOrders())
    .catch((err) =>
      logger.warn({ err }, "tradeStore: startup fill+settlement recovery failed"),
    );
  // A later Kalshi propagation or transport failure should heal without a
  // deployment restart. The reconciler keeps this read-only and serializes
  // sweeps so the periodic tick cannot overlap a slow backlog catch-up.
  const fillRecoveryTimer = setInterval(runFillRecoverySweep, FILL_RECONCILIATION_RECOVERY_INTERVAL_MS);

  // Startup exchange-history sweep is forward-only. Historical ownership must
  // not be guessed from exchange data, so a restart rechecks today's durable
  // bot activity only. This also prevents a malformed legacy date from turning
  // startup into a large rate-limit-consuming history scan.
  void (async () => {
    logger.info(
      { easternDate: today },
      "fillReconciler: startup will recheck current-day exchange history only",
    );
    await discoverAndReconcileMissingBotFills(today).catch((err: unknown) =>
      logger.warn({ err, date: today }, "fillReconciler: exchange-history discovery sweep failed"),
    );
    // Do not run this concurrently with the startup discovery request: both
    // read /portfolio/fills and would compete for the same Kalshi quota.
    await checkExchangeFillCoverage().catch((err: unknown) =>
      logger.warn({ err }, "fillReconciler: exchange coverage check failed"),
    );
  })();

  // ── Trading startup state audit log ──────────────────────────────────────
  // Printed once on every startup so each restart produces a clear record of
  // whether this process is permitted to place live orders.
  logger.info(
    {
      environment:               isWorkspaceEnvironment() ? "workspace" : "production",
      trading_halted:            isTradingHalted(),
      environment_lock:          isEnvLocked(),
      order_submission_permitted: getEthOrderSubmissionStatus("KXETH15M-startup").eth_order_submission_permitted,
      live_strategy:             "ETH_NO_MARTINGALE",
      legacy_strategy_execution: "disabled",
      ...getEthOrderSubmissionStatus("KXETH15M-startup"),
    },
    "Trading startup state",
  );

  // Forward-only SQL settlement recovery. Legacy analytics and historical SQL
  // rows remain untouched; only canonical exact-ledger parents can be updated.
  await recoverForwardSettlementsFromSql();

  // Retention and report scheduling maintain existing historical records only;
  // neither can evaluate an entry or submit an exchange order.
  hydrateMandelbrotPathsFromFile();
  startReportScheduler();
  const runSnapshotPrune = () => {
    const cutoffDate = easternDay(
      new Date(Date.now() - TARGET_LIQUIDITY_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );
    void (async () => {
      const retain = await shouldRetainEth2125DepthEvidence();
      await pruneTargetLiquiditySnapshots(cutoffDate, retain ? [ETH2125_DEPTH_STRATEGY] : []);
      await pruneEth420CandidateExecutionSnapshots(Date.now() - 30 * 24 * 60 * 60 * 1000);
    })().catch((err: unknown) =>
      logger.warn({ err }, "target-liquidity snapshot prune failed"),
    );
  };
  runSnapshotPrune();
  const retentionTimer = setInterval(runSnapshotPrune, 24 * 60 * 60 * 1000);
  retentionTimer.unref();

  // Passive collectors, shadow studies, and the unfinished recoverability
  // experiment are intentionally not started. Their historical files/rows stay
  // available to read-only report endpoints.
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Received shutdown signal — flushing state and exiting");
  await stopRuntimeHeartbeat(signal).catch((err) =>
    logger.warn({ err, signal }, "runtime heartbeat shutdown record failed"),
  );
  flushTradeState();

  // Mark any in-flight orders as interrupted_shutdown so the post-restart
  // outcomeReconciler can identify and resolve them.
  const inFlight = [...submissionOrderIds.entries()];
  if (inFlight.length > 0) {
    logger.warn(
      { count: inFlight.length, orders: inFlight.map(([t, c]) => ({ ticker: t, clientOrderId: c })) },
      "SIGTERM: in-flight orders detected — marking as interrupted_shutdown",
    );
    await Promise.allSettled(
      inFlight.map(([, clientOrderId]) => markAttemptInterruptedShutdown(clientOrderId)),
    );
  }

  process.exit(0);
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT",  () => { void shutdown("SIGINT"); });

// Keep the process alive on unhandled async errors — log them but don't crash.
// Without these, a single unexpected rejection from any library can silently
// kill the server and halt trading for the rest of the day.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — server staying alive");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — server staying alive");
});
