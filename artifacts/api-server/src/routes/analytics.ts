/**
 * Read-only analytics API endpoints — unauthenticated.
 *
 * These endpoints expose the passive production analytics collected by
 * analytics.ts. They have zero effect on trading state and are safe to poll
 * frequently from the dashboard.
 *
 * Routes:
 *   GET /trade/analytics/daily            — today's daily summary (BTC, ETH, combined)
 *   GET /trade/analytics/windows[?series] — window log enriched with analytics data
 *   GET /trade/analytics/orders[?ticker&limit] — recent order attempt records
 *
 *   GET /trade/analytics/reports/fill-performance — fill rate, latency, price improvement
 *   GET /trade/analytics/reports/retry            — retry distribution, pct never filled
 *   GET /trade/analytics/reports/guards           — guard outcome counts + percentages
 *   GET /trade/analytics/reports/time             — performance by Eastern hour / day-of-week
 *   GET /trade/analytics/reports/price-bands      — performance by trigger-price band
 *   GET /trade/analytics/reports/pnl?period=today|7d|all-time — P&L by asset/band/side/hour
 *   GET /trade/analytics/reports/what-if?floor&ceiling[&period] — hypothetical zone replay (read-only)
 *   GET /trade/analytics/reports/preflight-calibration?days — skip decisions vs settlement outcomes
 *   POST /trade/analytics/reports/replay-comparison — diff ReplayResult vs production
 *
 *   GET /trade/analytics/export/orders.csv  — order attempt records as CSV
 *   GET /trade/analytics/export/windows.csv — window analytics as CSV
 *   GET /trade/analytics/export/daily.csv   — daily summary as CSV
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { buildEth30Report, reconcileEth30Settlements, checkStaleEth30Claims, buildEth30TargetLiquidityReport } from "../lib/strategies/eth30_50.js";
import { buildSol30Report, reconcileSol30Settlements, checkStaleSol30Claims, buildSol30TargetLiquidityReport, buildSol30TargetProtectionReport } from "../lib/strategies/sol30_50.js";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";
import { getWindowLog } from "../lib/windowLog.js";
import {
  getDailySummary,
  getWindowAnalytics,
  getOrderAttempts,
} from "../lib/analytics.js";
import {
  getFillPerformanceReport,
  getRetryAnalysisReport,
  getGuardAnalysisReport,
  getTimeAnalysisReport,
  getPriceAnalysisReport,
  getReplayComparisonReport,
  getPnlReport,
  getReconciliationView,
  computeFinalReconciliationStatus,
  getEntryTimingReport,
  getEntryGapReport,
  getPreflightCalibrationReport,
  getWindowSensitivityReport,
  getTradeDecisionEvidenceReport,
  getH002EvidenceReadinessReport,
  getConditionRecommendationsReport,
} from "../lib/performanceReports.js";
import { loadReconciliationFailureAudits } from "../lib/tradeStore.js";
import {
  loadOrdersFromDateRangeAsync,
  DASHBOARD_ASSET_PREFIXES,
  DASHBOARD_CUTOFF_MS,
} from "../lib/analyticsStore.js";
import { getProtectiveExitMonitorStatus } from "../lib/protectiveExit.js";

// Shawshank's reporting/readiness boundary. This affects report inputs only;
// it does not alter live order, reconciliation, or protective-exit behavior.
const SHAWSHANK_REPORTING_START_DATE = "2026-08-09";
import { loadPreflightDecisionsFromDateRange, mergePreflightDecisionRecords } from "../lib/preflightStore.js";
import { getWhatIfReport } from "../lib/whatIfReport.js";
import {
  ordersToCSV,
  windowsToCSV,
  dailySummaryToCSV,
} from "../lib/csvExport.js";
import {
  getDailyRealizedPnl,
  getVerifiedPnlBySeries,
  getVerifiedPnlByTier,
  loadFillAccuracyRows,
  loadLossTimelineRows,
  loadMarketResultsCoverage,
  loadPreflightDecisionsFromSqlForRange,
  loadProtectiveExitAttempts,
  loadProtectiveExitMonitorIncidents,
  acknowledgeProtectiveExitMonitorIncident,
  listTargetLiquiditySnapshots,
  listAllEth30ShadowEvents,
  listEth420BoundaryResearchSnapshots,
} from "../lib/tradeStore.js";
import { isExchangeDiscoverySweepComplete } from "../lib/fillReconciler.js";
import { easternDay } from "../lib/dailyBudget.js";
import {
  dashboardOutcomeFromAnalytics,
  mergeDashboardWindow,
} from "../lib/dashboardWindowOutcome.js";
import { loadRecentBoundaryDiscoveryTimelines } from "../lib/boundaryDiscoveryAudit.js";
import {
  buildEth420BoundaryReplay,
  buildEth420BoundaryResearchResponse,
} from "../lib/eth420BoundaryResearch.js";

const router = Router();

/** Passive ETH420 boundary evidence only; no order or strategy state is read or changed. */
router.get("/trade/analytics/eth420-boundary-research", async (req, res) => {
  const limit = Math.max(1, Math.min(5_000, Number(req.query["limit"]) || 1_000));
  res.json(buildEth420BoundaryResearchResponse(await listEth420BoundaryResearchSnapshots(limit)));
});
router.get("/trade/analytics/reports/eth420-boundary-replay", async (_req, res) => {
  res.json(buildEth420BoundaryReplay(await listEth420BoundaryResearchSnapshots(5_000)));
});

// ── Auth for state-changing analytics endpoints ───────────────────────────────
// Read-only GET endpoints remain unauthenticated (analytics-only, no trading
// state is changed). Write endpoints (e.g. acknowledge) require the same
// X-Trade-Token header that trade.ts and report.ts require.

const _ACK_TOKEN_PRIMARY   = process.env["TRADE_API_TOKEN"]      ?? "";
const _ACK_TOKEN_DASHBOARD = process.env["VITE_TRADE_API_TOKEN"] ?? "";

function requireAckAuth(req: Request, res: Response, next: NextFunction): void {
  if (!_ACK_TOKEN_PRIMARY && !_ACK_TOKEN_DASHBOARD) {
    res.status(503).json({ error: "TRADE_API_TOKEN is not configured on the server" });
    return;
  }
  const provided = req.header("x-trade-token") ?? "";
  if (!provided) {
    res.status(401).json({ error: "Missing X-Trade-Token header" });
    return;
  }
  const matches = (expected: string): boolean => {
    if (!expected) return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (!matches(_ACK_TOKEN_PRIMARY) && !matches(_ACK_TOKEN_DASHBOARD)) {
    res.status(401).json({ error: "Invalid X-Trade-Token header" });
    return;
  }
  next();
}

// ── GET /trade/analytics/daily ────────────────────────────────────────────────

/**
 * Returns today's analytics summary augmented with the verified fill-ledger P&L.
 *
 * The analytics `combined.netPnlDollars` is an in-memory estimate derived from
 * order-attempt records.  The `verified` block is the authoritative number from
 * the `order_fills` child-chunk ledger (same source the settled-P&L strip uses).
 * Consumers should prefer `verified.netPnlDollars` when it is non-null.
 */
router.get("/trade/analytics/daily", async (_req, res) => {
  try {
    const today = easternDay(new Date());
    const [summary, verifiedPnl, verifiedBySeries] = await Promise.all([
      Promise.resolve(getDailySummary()),
      getDailyRealizedPnl(today),
      getVerifiedPnlBySeries(),
    ]);

    // Log settled counts per series so operators can confirm won-column
    // settlements (written by recoverForwardSettlementsFromSql) are being
    // counted in the verified.bySeries payload without a page reload.
    const seriesSettlementCounts = verifiedBySeries.bySeries
      .filter((r) => r.settledFillCount > 0)
      .map((r) => ({ series: r.series, settled: r.settledFillCount, pending: r.pendingVerificationCount }));
    if (seriesSettlementCounts.length > 0) {
      logger.debug(
        { bySeries: seriesSettlementCounts, combined: verifiedBySeries.combined.settledFillCount },
        "analytics/daily: verified.bySeries — won-path settlements included in response",
      );
    }

    res.json({
      ...summary,
      verified: {
        netPnlDollars:                  verifiedPnl.realizedNetPnlDollars,
        settledFillCount:               verifiedPnl.settledFillCount,
        pendingVerificationCount:       verifiedPnl.pendingVerificationCount,
        unverifiedFillCount:            verifiedPnl.unverifiedFillCount,
        /** True once the exchange-history discovery sweep has completed for today. */
        exchangeReconciliationComplete: isExchangeDiscoverySweepComplete(today),
        bySeries:                       verifiedBySeries.bySeries.map((row) => ({
          series:                   row.series,
          netPnlDollars:            row.realizedNetPnlDollars,
          settledFillCount:         row.settledFillCount,
          pendingVerificationCount: row.pendingVerificationCount,
          unverifiedFillCount:      row.unverifiedFillCount,
        })),
      },
    });
  } catch {
    res.status(500).json({ error: "analytics unavailable" });
  }
});

// ── GET /trade/analytics/windows ─────────────────────────────────────────────

/**
 * Returns the existing window log enriched with per-window analytics data.
 * The two sources are merged by ticker so the frontend only needs one request.
 *
 * Query params:
 *   series — optional filter, e.g. "KXBTC15M" or "KXETH15M"
 */
router.get("/trade/analytics/windows", (req, res) => {
  try {
    const seriesFilter = req.query["series"] as string | undefined;

    const windowLog = getWindowLog();
    const analyticsWindows = getWindowAnalytics(seriesFilter);
    const analyticsMap = new Map(analyticsWindows.map((w) => [w.ticker, w]));

    // Also include any analytics windows that have no corresponding window-log
    // entry (e.g. if the server restarted mid-window and wlOpen wasn't called).
    const logTickers = new Set(windowLog.map((e) => e.ticker));
    const analyticsOnly = analyticsWindows
      .filter((w) => !logTickers.has(w.ticker) && isDashboardWindow(w.ticker, w.windowStartMs))
      .map((w) => ({
        ticker:        w.ticker,
        series:        w.series,
        closeTime:     w.windowClose ?? null,
        firstSeenMs:   w.windowStartMs,
        entered:       w.qualifyingEvaluations > 0,
        inZone:        w.qualifyingEvaluations > 0,
        outcome:       dashboardOutcomeFromAnalytics(w.result),
        side:           null as string | null,
        priceCents:     w.actualFillPriceCents ?? null,
        contractsFilled: w.actualFilledContracts || null,
        spentDollars:   w.totalSpendDollars || null,
        skipReason:     null as string | null,
        // Analytics enrichment
        submittedOrders:         w.submittedOrders,
        zeroFills:               w.zeroFills,
        partialFills:            w.partialFills,
        fullFills:               w.fullFills,
        attemptNumberThatFilled: w.attemptNumberThatFilled,
        totalSpendDollars:       w.totalSpendDollars,
        totalFeesDollars:        w.totalFeesDollars,
        attempts:                w.attempts,
        analyticsResult:         w.result,
      }));

    // Dashboard scope: BTC/ETH only, on or after 2026-08-01 UTC.
    const isDashboardWindow = (ticker: string, firstSeenMs: number): boolean =>
      DASHBOARD_ASSET_PREFIXES.some((pfx) => ticker.startsWith(pfx)) &&
      firstSeenMs >= DASHBOARD_CUTOFF_MS;

    const filteredLog = windowLog.filter(
      (e) =>
        isDashboardWindow(e.ticker, e.firstSeenMs) &&
        (!seriesFilter || e.series === seriesFilter || e.ticker?.startsWith(seriesFilter)),
    );

    const merged = filteredLog.map((entry) => {
      const an = analyticsMap.get(entry.ticker);
      return mergeDashboardWindow(entry, an);
    });

    res.json({ windows: [...merged, ...analyticsOnly] });
  } catch {
    res.status(500).json({ error: "analytics unavailable" });
  }
});

// ── GET /trade/analytics/orders ───────────────────────────────────────────────

/**
 * Returns recent order attempt records (newest first).
 *
 * Query params:
 *   ticker — optional ticker filter
 *   limit  — max records to return (default 100, max 500)
 */
router.get("/trade/analytics/orders", async (req, res) => {
  try {
    const ticker = req.query["ticker"] as string | undefined;
    const rawLimit = Number(req.query["limit"] ?? 100);
    const limit    = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
    const all    = await loadOrdersFromDateRangeAsync(0); // 0 = all-time
    const orders = all
      .filter((o) => !ticker || o.ticker === ticker)
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, limit);
    res.json({ orders, count: orders.length });
  } catch {
    res.status(500).json({ error: "analytics unavailable" });
  }
});

/** Safe, append-only reconciliation failures for genuine runtime orders only. */
router.get("/trade/analytics/reconciliation-failures", async (req, res) => {
  try {
    const requested = Number(req.query["limit"] ?? 100);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 500) : 100;
    const failures = await loadReconciliationFailureAudits(limit);
    res.json({ failures, count: failures.length });
  } catch {
    res.status(500).json({ error: "reconciliation failure audit unavailable" });
  }
});

/** Read-only, separately persisted protective-exit evidence. */
router.get("/trade/analytics/protective-exits", async (req, res) => {
  try {
    const requested = Number(req.query["limit"] ?? 100);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 500) : 100;
    const exits = await loadProtectiveExitAttempts(limit);
    // Raw L2 data is retained durably for audited investigation but is omitted
    // from the routine dashboard response.
    const safeExits = exits.map(({ rawBook: _rawBook, ...exit }) => exit);
    res.json({ exits: safeExits, count: safeExits.length });
  } catch {
    res.status(500).json({ error: "protective exit audit unavailable" });
  }
});

/** Live, read-only protective-exit monitor state for dashboard alerts. */
router.get("/trade/analytics/protective-exit-status", (_req, res) => {
  res.json(getProtectiveExitMonitorStatus());
});

// ── GET /trade/analytics/boundary-discovery ───────────────────────────────────
/** Recent ETH 15-minute boundary-discovery evidence. Read-only: this loader
 * only reads the append-only audit ledger and cannot affect execution. */
router.get("/trade/analytics/boundary-discovery", async (req, res): Promise<void> => {
  const requested = Number(req.query["limit"] ?? 24);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 100) : 24;
  res.json(await loadRecentBoundaryDiscoveryTimelines(limit));
});

/** High-severity monitor incidents: confirmed local entries the exit monitor
 * could not verify while at/below (or unable to rule out) the 80¢ floor.
 *
 * Query params:
 *   limit              — max rows (1–500, default 100)
 *   unacknowledged     — "true" to return only un-reviewed incidents (used by the banner)
 */
router.get("/trade/analytics/protective-exit-incidents", async (req, res) => {
  try {
    const requested = Number(req.query["limit"] ?? 100);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 500) : 100;
    const onlyUnacknowledged = req.query["unacknowledged"] === "true";
    const incidents = await loadProtectiveExitMonitorIncidents(limit, onlyUnacknowledged);
    res.json({ incidents, count: incidents.length });
  } catch {
    res.status(500).json({ error: "protective exit monitor incidents unavailable" });
  }
});

/** Mark a protective-exit monitor incident as operator-reviewed.
 * The row is retained in the DB for audit purposes; only the acknowledged_at
 * timestamp is set.  Idempotent — re-acknowledging a row is a no-op (200).
 */
router.post("/trade/analytics/protective-exit-incidents/:id/acknowledge", requireAckAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string" || id.length > 200) {
      res.status(400).json({ error: "invalid incident id" });
      return;
    }
    const updated = await acknowledgeProtectiveExitMonitorIncident(id);
    res.json({ ok: true, updated });
  } catch {
    res.status(500).json({ error: "acknowledge failed" });
  }
});

// ── Performance Report Routes (Step 3) ────────────────────────────────────────

router.get("/trade/analytics/reports/fill-performance", (_req, res) => {
  try {
    res.json(getFillPerformanceReport());
  } catch {
    res.status(500).json({ error: "report unavailable" });
  }
});

router.get("/trade/analytics/reports/retry", (_req, res) => {
  try {
    res.json(getRetryAnalysisReport());
  } catch {
    res.status(500).json({ error: "report unavailable" });
  }
});

router.get("/trade/analytics/reports/guards", (_req, res) => {
  try {
    res.json(getGuardAnalysisReport());
  } catch {
    res.status(500).json({ error: "report unavailable" });
  }
});

router.get("/trade/analytics/reports/time", (_req, res) => {
  try {
    res.json(getTimeAnalysisReport());
  } catch {
    res.status(500).json({ error: "report unavailable" });
  }
});

router.get("/trade/analytics/reports/price-bands", (_req, res) => {
  try {
    res.json(getPriceAnalysisReport());
  } catch {
    res.status(500).json({ error: "report unavailable" });
  }
});

/**
 * GET /trade/analytics/reports/entry-timing?period=today|7d|all-time
 *
 * Win rate segmented by how many seconds before window close the order was placed.
 * Buckets: >3:00, 2:00–3:00, 1:00–2:00, <1:00 remaining.
 *
 * Only outcome-reconciled fills contribute to win/loss figures.
 * The current strategy fires in the last 2:00 (120 s), so the 2:00–3:00 and
 * <2:00 buckets are the most useful comparison points.
 */
router.get("/trade/analytics/reports/entry-timing", async (req, res) => {
  try {
    const period = (req.query["period"] as string | undefined) ?? "all-time";

    let days: number;
    switch (period) {
      case "today": days = 1; break;
      case "7d":    days = 7; break;
      default:      days = 0; break; // all-time
    }

    const orders = await loadOrdersFromDateRangeAsync(days);
    const today    = new Date();
    const toDate   = today.toISOString().slice(0, 10);
    const fromDate = days > 0
      ? new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      : "all";

    const report = getEntryTimingReport(orders, period === "today" ? "today" : period, fromDate, toDate);
    res.json(report);
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "entry-timing report unavailable", detail: e.message ?? "unknown" });
  }
});

/**
 * GET /trade/analytics/reports/entry-gap?period=today|7d|all-time
 *
 * Falling-knife detector: win rate split by the trigger→fill price gap
 * (0–2¢ / 3–6¢ / 7¢+), plus recent filled trades with their gap. A large
 * gap means the price was collapsing through the entry zone between
 * trigger and fill. Read-only analysis.
 */
router.get("/trade/analytics/reports/entry-gap", async (req, res) => {
  try {
    const period = (req.query["period"] as string | undefined) ?? "all-time";

    let days: number;
    switch (period) {
      case "today": days = 1; break;
      case "7d":    days = 7; break;
      default:      days = 0; break; // all-time
    }

    const orders = await loadOrdersFromDateRangeAsync(days);
    const today    = new Date();
    const toDate   = today.toISOString().slice(0, 10);
    const fromDate = days > 0
      ? new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      : "all";

    // Optional: caller can supply a different threshold for the reverse sim.
    // Accepted values: 1–50 cents (integer). Defaults to the server constant.
    const rawGap = Number(req.query["reverseSimMinGapCents"] ?? "NaN");
    const reverseSimMinGapCents =
      Number.isInteger(rawGap) && rawGap >= 1 && rawGap <= 50 ? rawGap : undefined;

    const periodKey = period === "today" ? "today" : period;
    const report = getEntryGapReport(orders, periodKey, fromDate, toDate, 100, reverseSimMinGapCents);

    // Compute all three standard threshold simulations in parallel (synchronous)
    const report5  = getEntryGapReport(orders, periodKey, fromDate, toDate, 0, 5);
    const report7  = getEntryGapReport(orders, periodKey, fromDate, toDate, 0, 7);
    const report10 = getEntryGapReport(orders, periodKey, fromDate, toDate, 0, 10);

    res.json({
      ...report,
      reverseSimAll: {
        '5':  report5.reverseSim,
        '7':  report7.reverseSim,
        '10': report10.reverseSim,
      },
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "entry-gap report unavailable", detail: e.message ?? "unknown" });
  }
});

/**
 * POST /trade/analytics/reports/replay-comparison
 * Body: { replayResult: ReplayResult }
 * Returns a diff of the replay summary vs today's production summary.
 */
router.post("/trade/analytics/reports/replay-comparison", (req, res) => {
  try {
    const { replayResult } = req.body as { replayResult: Parameters<typeof getReplayComparisonReport>[0] };
    if (!replayResult) {
      res.status(400).json({ error: "replayResult is required in request body" });
      return;
    }
    const config = (replayResult as { config?: unknown }).config;
    if (
      config === null ||
      typeof config !== "object" ||
      Object.keys(config as object).length === 0
    ) {
      res.status(400).json({
        error: "replayResult.config is required and must be a non-empty object",
      });
      return;
    }
    const summary = (replayResult as { summary?: unknown }).summary;
    if (summary === null || typeof summary !== "object") {
      res.status(400).json({
        error: "replayResult.summary is required and must be an object",
      });
      return;
    }
    const report = getReplayComparisonReport(replayResult);
    res.json(report);
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "replay-comparison report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── CSV Export Routes ─────────────────────────────────────────────────────────

router.get("/trade/analytics/export/orders.csv", (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');
    res.send(ordersToCSV());
  } catch {
    res.status(500).json({ error: "export unavailable" });
  }
});

router.get("/trade/analytics/export/windows.csv", (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="windows.csv"');
    res.send(windowsToCSV());
  } catch {
    res.status(500).json({ error: "export unavailable" });
  }
});

router.get("/trade/analytics/export/daily.csv", (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="daily.csv"');
    res.send(dailySummaryToCSV());
  } catch {
    res.status(500).json({ error: "export unavailable" });
  }
});

// ── GET /trade/analytics/reports/pnl ─────────────────────────────────────────

/**
 * Rolling P&L report.
 *
 * Query params:
 *   period  — "today" (default) | "7d" | "all-time"
 *
 * Only outcome-reconciled fills contribute to P&L figures; pending fills are
 * listed separately. Read-only and safe to call at any frequency.
 */
router.get("/trade/analytics/reports/pnl", async (req, res) => {
  try {
    const period = (req.query["period"] as string | undefined) ?? "all-time";

    let days: number;
    switch (period) {
      case "today": days = 1; break;
      case "7d":    days = 7; break;
      default:      days = 0; break; // all-time
    }

    const orders = await loadOrdersFromDateRangeAsync(days);
    const today    = new Date();
    const toDate   = today.toISOString().slice(0, 10);
    const fromDate = days > 0
      ? new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      : "all";

    const [verified, verifiedByTier] = await Promise.all([
      getVerifiedPnlBySeries(
        days > 0 ? fromDate : SHAWSHANK_REPORTING_START_DATE,
        days > 0 ? toDate : undefined,
      ),
      getVerifiedPnlByTier(
        days > 0 ? fromDate : SHAWSHANK_REPORTING_START_DATE,
        days > 0 ? toDate : undefined,
      ),
    ]);
    const pnlReport = getPnlReport(orders, period, fromDate, toDate);
    const reconciliation = getReconciliationView(orders, period, fromDate, toDate);

    // ── Authoritative status derivation ───────────────────────────────────────
    //
    // The parent-record analysis (`pnlReport.reconciliationStatus`) uses
    // fill_price_source flags on OrderAttemptRecord rows.  Those flags can
    // diverge from the real exchange fill economics (split-fill rounding, fee
    // adjustments, offsetting fills).  The SQL-backed child-fill ledger
    // (`verified.combined`) is the single authoritative source.
    //
    // `computeFinalReconciliationStatus` is exported and unit-tested separately.
    // It requires (a) parent analysis is fully verified, (b) ledger is available
    // (non-null), (c) ledger settled-fill count ≥ parent verified count and > 0
    // — so an empty SQL result (realizedNetPnlDollars: 0, settledFillCount: 0)
    // can never promote a non-empty parent report to exchange_reconciled — and
    // (d) ledger and parent totals agree within 1¢.
    const ledgerConfirmedNet  = verified?.combined?.realizedNetPnlDollars ?? null;
    const ledgerSettledFills  = verified?.combined?.settledFillCount      ?? 0;
    const parentNet           = pnlReport.summary?.netPnlDollars          ?? null;

    const finalStatus = computeFinalReconciliationStatus(
      pnlReport.reconciliationStatus,
      parentNet,
      reconciliation.exchangeVerified,
      { confirmedNetPnlDollars: ledgerConfirmedNet, settledFillCount: ledgerSettledFills },
    );

    const reconciliationWithLedger = {
      ...reconciliation,
      // Replace parent-derived confirmed net with the authoritative ledger total.
      verifiedNetPnlDollars: ledgerConfirmedNet,
      // Reconciliation view status must agree with the final top-level status.
      status: finalStatus,
    };

    res.json({
      ...pnlReport,
      // Override the parent-derived reconciliationStatus with the ledger-aware
      // final status.  This is the field the Dashboard uses for the badge — it
      // must reflect the ledger result, not just the parent-record flags.
      reconciliationStatus: finalStatus,
      verified,
      verifiedByTier,
      reconciliation: reconciliationWithLedger,
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "pnl report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/window-sensitivity ──────────────────────────

/**
 * Compares in-zone preflight-decision counts for the old 2:30 window
 * vs the new 3:00 window. The "new band" is the [150 s, 180 s) slice that
 * the recent cutoff extension unlocked. Shows how many extra entry signals
 * the wider window produces, broken down by series and Eastern hour.
 *
 * Query params:
 *   days — lookback window in days (default 7, max 90, 0 = all-time)
 */
router.get("/trade/analytics/reports/window-sensitivity", (req, res) => {
  try {
    const raw  = Number(req.query["days"] ?? 7);
    const days = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), 90) : 7;
    res.json(getWindowSensitivityReport(days));
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "window-sensitivity report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/preflight-calibration ───────────────────────

/**
 * Correlates skipped pre-flight L2 decisions against market settlements.
 *
 * Query params:
 *   days — lookback window in days (default 7, max 90)
 */
router.get("/trade/analytics/reports/preflight-calibration", (req, res) => {
  try {
    const raw  = Number(req.query["days"] ?? 7);
    const days = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 90) : 7;
    res.json(getPreflightCalibrationReport(days));
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "preflight-calibration report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/decision-evidence ────────────────────────────
router.get("/trade/analytics/reports/decision-evidence", async (req, res) => {
  try {
    const period = (req.query["period"] as string | undefined) ?? "all-time";
    const days = period === "today" ? 1 : period === "7d" ? 7 : 0;
    const [orders, sqlDecisions] = await Promise.all([
      loadOrdersFromDateRangeAsync(days),
      loadPreflightDecisionsFromSqlForRange(days),
    ]);
    // The calibration endpoint's disk loader is intentionally retained as the
    // fast local mirror; durable rows fill its restart/deployment gaps here.
    const diskDecisions = loadPreflightDecisionsFromDateRange(days);
    const decisions = mergePreflightDecisionRecords(diskDecisions, sqlDecisions)
      .filter((decision) => decision.timestampMs >= DASHBOARD_CUTOFF_MS);
    res.json(getTradeDecisionEvidenceReport(orders, decisions, period, {
      localDecisionRecords: diskDecisions.length,
      durableDecisionRecords: sqlDecisions.length,
    }));
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "decision-evidence report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/h-002-evidence ────────────────────────────────
router.get("/trade/analytics/reports/h-002-evidence", async (req, res) => {
  try {
    const period = (req.query["period"] as string | undefined) ?? "all-time";
    if (period !== "today" && period !== "7d" && period !== "all-time") {
      res.status(400).json({ error: "period must be today, 7d, or all-time" });
      return;
    }
    const days = period === "today" ? 1 : period === "7d" ? 7 : 0;
    const [orders, sqlDecisions] = await Promise.all([
      loadOrdersFromDateRangeAsync(days),
      loadPreflightDecisionsFromSqlForRange(days),
    ]);
    const diskDecisions = loadPreflightDecisionsFromDateRange(days);
    const decisions = mergePreflightDecisionRecords(diskDecisions, sqlDecisions);
    res.json(getH002EvidenceReadinessReport(orders, decisions, period, {
      localDecisionRecords: diskDecisions.length,
      durableDecisionRecords: sqlDecisions.length,
    }));
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "H-002 evidence readiness report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/condition-recommendations ────────────────────
router.get("/trade/analytics/reports/condition-recommendations", async (req, res) => {
  try {
    const period = (req.query["period"] as string | undefined) ?? "all-time";
    if (period !== "today" && period !== "7d" && period !== "all-time") {
      res.status(400).json({ error: "period must be today, 7d, or all-time" });
      return;
    }
    const rawAsset = (req.query["asset"] as string | undefined) ?? "all";
    if (rawAsset !== "all" && rawAsset !== "BTC" && rawAsset !== "ETH") {
      res.status(400).json({ error: "asset must be all, BTC, or ETH" });
      return;
    }
    const days = period === "today" ? 1 : period === "7d" ? 7 : 0;
    const [orders, sqlDecisions] = await Promise.all([
      loadOrdersFromDateRangeAsync(days),
      loadPreflightDecisionsFromSqlForRange(days),
    ]);
    const decisions = mergePreflightDecisionRecords(
      loadPreflightDecisionsFromDateRange(days),
      sqlDecisions,
    );
    res.json(getConditionRecommendationsReport(orders, decisions, period, rawAsset));
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "condition recommendations unavailable", detail: e.message ?? "unknown" });
  }
});


// ── GET /trade/analytics/reports/what-if ─────────────────────────────────────

/**
 * What-if zone/floor simulator — READ-ONLY.
 *
 * Replays historical reconciled fills against a hypothetical trigger-price
 * floor/ceiling. Never changes live trading parameters.
 *
 * Query params:
 *   floor   — hypothetical floor in cents (1–99, required)
 *   ceiling — hypothetical ceiling in cents (1–99, required, ≥ floor)
 *   period  — "today" | "7d" | "all-time" (default "all-time")
 */
router.get("/trade/analytics/reports/what-if", async (req, res) => {
  try {
    const floor   = Number(req.query["floor"]);
    const ceiling = Number(req.query["ceiling"]);
    if (!Number.isInteger(floor) || !Number.isInteger(ceiling) ||
        floor < 1 || floor > 99 || ceiling < 1 || ceiling > 99 || ceiling < floor) {
      res.status(400).json({
        error: "floor and ceiling must be integers 1–99 with ceiling >= floor",
      });
      return;
    }

    const period = (req.query["period"] as string | undefined) ?? "all-time";
    let days: number;
    switch (period) {
      case "today": days = 1; break;
      case "7d":    days = 7; break;
      default:      days = 0; break; // all-time
    }

    const orders = await loadOrdersFromDateRangeAsync(days);
    res.json(getWhatIfReport(orders, floor, ceiling, period));
  } catch (err) {
    const e = err as { message?: string };

    const daysRaw = Number(req.query["days"] ?? 7);
    res.status(500).json({ error: "what-if report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/fill-accuracy ───────────────────────────────

/**
 * Per-order comparison of stored fill_price_cents vs actual weighted average
 * computed from order_fills. Flags discrepancies and shows multi-chunk fills.
 *
 * Query params:
 *   period — "today" | "7d" | "all-time" (default "all-time")
 *
 * Rows include:
 *   stored_fill_price_cents  — what order_attempts currently holds
 *   actual_avg_fill_price_cents — weighted avg from order_fills (null if no chunks yet)
 *   discrepancyCents         — actual_avg − stored (negative = stored overstated cost)
 *   fill_chunks              — number of individual fill records in order_fills
 *   min/max_fill_price_cents — price range across fill chunks (multi-level fills)
 */
router.get("/trade/analytics/reports/fill-accuracy", async (_req, res) => {
  try {
    const period = (_req.query["period"] as string | undefined) ?? "all-time";
    let days: number;
    switch (period) {
      case "today": days = 1; break;
      case "7d":    days = 7; break;
      default:      days = 0; break;
    }

    const rows = await loadFillAccuracyRows(days);

    const withFillData  = rows.filter((r) => r.fill_chunks > 0);
    const discrepancies = withFillData.filter(
      (r) => r.actual_avg_fill_price_cents !== null &&
             r.stored_fill_price_cents     !== null &&
             r.actual_avg_fill_price_cents !== r.stored_fill_price_cents,
    );
    const discGaps       = discrepancies.map((r) =>
      Math.abs((r.actual_avg_fill_price_cents ?? 0) - (r.stored_fill_price_cents ?? 0)),
    );
    const maxDisc        = discGaps.length > 0 ? Math.max(...discGaps)                             : null;
    const avgDisc        = discGaps.length > 0 ? discGaps.reduce((a, b) => a + b, 0) / discGaps.length : null;
    const multiChunk     = withFillData.filter((r) => r.fill_chunks > 1).length;

    const enriched = rows.map((r) => ({
      ...r,
      // Positive → actual fill was cheaper than stored (price improvement captured).
      // Negative → stored price understated true cost.
      discrepancyCents:
        r.actual_avg_fill_price_cents !== null && r.stored_fill_price_cents !== null
          ? r.actual_avg_fill_price_cents - r.stored_fill_price_cents
          : null,
    }));

    res.json({
      period,
      summary: {
        totalFilled:         rows.length,
        withFillData:        withFillData.length,
        reconciled:          rows.filter((r) => r.reconciled).length,
        discrepancies:       discrepancies.length,
        multiChunkOrders:    multiChunk,
        maxDiscrepancyCents: maxDisc,
        avgDiscrepancyCents: avgDisc,
      },
      rows: enriched,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "fill-accuracy report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/eth30-50 ─────────────────────────────────────

/**
 * ETH_30_50 strategy-only report: fills, settlements, and exact P&L computed
 * EXCLUSIVELY from the isolated eth30_* ownership ledgers. Legacy ETH
 * order_attempts / order_fills rows are never consulted, so this report can
 * never attribute legacy ETH activity to the ETH_30_50 strategy.
 *
 * Lazily reconciles pending settlements (read-only wrt trading behavior)
 * before computing the report. Never alters strategy state.
 */
router.get("/trade/analytics/reports/eth30-50", async (_req, res) => {
  try {
    await reconcileEth30Settlements();
    const report = await buildEth30Report();
    // Fire-and-forget stale-claim watchdog: emits WARN logs for any claimed
    // ticker with no fills older than the stale threshold. Errors are swallowed
    // so they can never block the report response.
    checkStaleEth30Claims().catch(() => {});
    res.json(report);
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "eth30-50 report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/eth21-25-passive ───────────────────────────
// A dedicated, read-only prospective research report. It never reconciles or
// writes live ETH strategy state.
router.get("/trade/analytics/reports/eth21-25-passive", async (_req, res) => {
  try {
    const { buildEth2125ProspectiveReport } = await import("../lib/strategies/eth2125Prospective.js");
    res.json(await buildEth2125ProspectiveReport());
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "eth21-25 prospective report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/eth30-50/target-liquidity ───────────────────

/**
 * Per-position 50¢-target liquidity diagnosis: classifies each ETH_30_50
 * position as never-reached-50¢, touched 50¢ with insufficient queue depth,
 * or sufficient depth while the target rested unfilled (execution problem).
 * Read-only; computed from eth30_* ledgers + target_liquidity_snapshots.
 */
router.get("/trade/analytics/reports/eth30-50/target-liquidity", async (_req, res) => {
  try {
    res.json(await buildEth30TargetLiquidityReport());
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "eth30-50 target-liquidity report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/sol30-50/target-liquidity ───────────────────

/** SOL_30_50 counterpart of the target-liquidity diagnosis report. */
router.get("/trade/analytics/reports/sol30-50/target-liquidity", async (_req, res) => {
  try {
    res.json(await buildSol30TargetLiquidityReport());
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "sol30-50 target-liquidity report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/eth30-50/target-liquidity/snapshots ─────────

/**
 * Raw depth snapshots for a specific ETH_30_50 position.
 * Returns each snapshot's timestamp, depth at/above 50¢, resting size, and
 * whether depth was sufficient — the data the timeline chart needs.
 *
 * Query params:
 *   ticker — required; the market ticker to fetch snapshots for
 */
router.get("/trade/analytics/reports/eth30-50/target-liquidity/snapshots", async (req, res) => {
  try {
    const ticker = req.query["ticker"] as string | undefined;
    if (!ticker || typeof ticker !== "string" || ticker.length > 200) {
      res.status(400).json({ error: "ticker query parameter is required" });
      return;
    }
    const all = await listTargetLiquiditySnapshots("ETH_30_50");
    const snapshots = all
      .filter((s) => s.ticker === ticker)
      .map((s) => ({
        capturedAtMs:             s.capturedAtMs,
        contractsAtOrAboveTarget: s.contractsAtOrAboveTarget,
        restingContracts:         s.restingContracts,
        observedBidCents:         s.observedBidCents,
        orderStatus:              s.orderStatus,
        bookError:                s.bookError,
        bidLevelCount:            s.bidLevelsAtOrAboveTarget.length,
      }));
    res.json({ ticker, strategy: "ETH_30_50", snapshots });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "target-liquidity snapshots unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/sol30-50/target-liquidity/snapshots ──────────

/** SOL_30_50 counterpart of the per-ticker snapshot-detail endpoint. */
router.get("/trade/analytics/reports/sol30-50/target-liquidity/snapshots", async (req, res) => {
  try {
    const ticker = req.query["ticker"] as string | undefined;
    if (!ticker || typeof ticker !== "string" || ticker.length > 200) {
      res.status(400).json({ error: "ticker query parameter is required" });
      return;
    }
    const all = await listTargetLiquiditySnapshots("SOL_30_50");
    const snapshots = all
      .filter((s) => s.ticker === ticker)
      .map((s) => ({
        capturedAtMs:             s.capturedAtMs,
        contractsAtOrAboveTarget: s.contractsAtOrAboveTarget,
        restingContracts:         s.restingContracts,
        observedBidCents:         s.observedBidCents,
        orderStatus:              s.orderStatus,
        bookError:                s.bookError,
        bidLevelCount:            s.bidLevelsAtOrAboveTarget.length,
      }));
    res.json({ ticker, strategy: "SOL_30_50", snapshots });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "target-liquidity snapshots unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/eth30-50/shadow-signals ─────────────────────

/**
 * Read-only report listing all triggered ETH_30_50 shadow-signal events.
 *
 * Every record is labelled SHADOW_ONLY_NOT_EXECUTED — these signals were
 * observed and recorded passively; no order was ever placed as a result.
 *
 * Each event carries:
 *   - The causal context at trigger time (ETH price, BBO, L2 exit depth,
 *     signed ETH move, seconds remaining, entry fill price)
 *   - The realized outcome fields refreshed after settlement arrives
 *     (target-50 fill result, settlement result, gross P&L in cents)
 *
 * Query params:
 *   ticker — optional; restricts results to a single market ticker
 *   limit  — max events to return (1–2000, default 500)
 *
 * The endpoint is read-only and safe to call at any frequency.
 */
router.get("/trade/analytics/reports/eth30-50/shadow-signals", async (req, res) => {
  try {
    const ticker  = req.query["ticker"] as string | undefined;
    const rawLimit = Number(req.query["limit"] ?? 500);
    const limit   = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 2_000) : 500;

    if (ticker !== undefined && (typeof ticker !== "string" || ticker.length > 200)) {
      res.status(400).json({ error: "ticker must be a non-empty string up to 200 characters" });
      return;
    }

    const rawEvents = await listAllEth30ShadowEvents(ticker, limit);

    // Parse payloadJson once per row so downstream consumers get a flat object.
    const events = rawEvents.map((ev) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(ev.payloadJson) as Record<string, unknown>; } catch { /* retain empty */ }
      return {
        id:            ev.id,
        ticker:        ev.ticker,
        signal:        ev.signal,
        triggeredAtMs: ev.triggeredAtMs,
        triggeredAt:   new Date(ev.triggeredAtMs).toISOString(),
        // Execution label — always SHADOW_ONLY_NOT_EXECUTED; callers must never
        // infer a real order from the presence of this record.
        executionLabel: payload["label"] ?? "SHADOW_ONLY_NOT_EXECUTED",
        // Causal context at trigger time
        heldSide:                   payload["heldSide"]                   ?? null,
        ownedContracts:             payload["ownedContracts"]             ?? null,
        secondsRemaining:           payload["secondsRemaining"]           ?? null,
        secondsSinceEntry:          payload["secondsSinceEntry"]          ?? null,
        entryFillPriceCents:        payload["entryFillPriceCents"]        ?? null,
        referenceEthUsd:            payload["referenceEthUsd"]            ?? null,
        signedEthMove30s:           payload["signedEthMove30s"]           ?? null,
        signedEthMove60s:           payload["signedEthMove60s"]           ?? null,
        heldSideBboCents:           payload["heldSideBboCents"]           ?? null,
        yesBid:                     payload["yesBid"]                     ?? null,
        noBid:                      payload["noBid"]                      ?? null,
        executableSellBestCents:    payload["executableSellBestCents"]    ?? null,
        executableSellDepthContracts: payload["executableSellDepthContracts"] ?? null,
        estimatedExecutableContracts: payload["estimatedExecutableContracts"] ?? null,
        hypotheticalGrossExitValueCents: payload["hypotheticalGrossExitValueCents"] ?? null,
        hypotheticalGrossExitPnlCents:   payload["hypotheticalGrossExitPnlCents"]   ?? null,
        // Realized outcomes (refreshed post-settlement by refreshEth30ShadowOutcomes)
        actualTarget50FilledContracts: payload["actualTarget50FilledContracts"] ?? null,
        settlementResult:              payload["settlementResult"]              ?? null,
        realizedGrossPnlCents:         payload["realizedGrossPnlCents"]         ?? null,
      };
    });

    // Per-signal summary: trigger count and outcome availability.
    const signalSummary: Record<string, { triggerCount: number; withOutcome: number; withPnl: number }> = {};
    for (const ev of events) {
      const key = ev.signal;
      if (!signalSummary[key]) signalSummary[key] = { triggerCount: 0, withOutcome: 0, withPnl: 0 };
      signalSummary[key]!.triggerCount++;
      if (ev.settlementResult !== null) signalSummary[key]!.withOutcome++;
      if (ev.realizedGrossPnlCents !== null) signalSummary[key]!.withPnl++;
    }

    const totalWithPnl = events.filter((ev) => ev.realizedGrossPnlCents !== null).length;
    const grossPnlValues = events
      .map((ev) => ev.realizedGrossPnlCents)
      .filter((v): v is number => typeof v === "number");

    res.json({
      // Report metadata
      label:        "SHADOW_ONLY_NOT_EXECUTED",
      description:  "Passive ETH_30_50 shadow research signals. No order was placed for any of these records.",
      generatedAt:  new Date().toISOString(),
      tickerFilter: ticker ?? null,
      // Aggregate summary
      summary: {
        totalEvents:      events.length,
        totalWithOutcome: events.filter((ev) => ev.settlementResult !== null).length,
        totalWithPnl,
        grossPnlSumCents: grossPnlValues.length > 0 ? grossPnlValues.reduce((a, b) => a + b, 0) : null,
        bySignal:         signalSummary,
      },
      // Event list (newest first)
      events,
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "eth30-50 shadow-signal report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── DELETE /trade/analytics/reports/eth30-50/claims/:ticker ──────────────────

// ── GET /trade/analytics/reports/sol30-50 ────────────────────────────────────

/**
 * SOL_30_50 strategy-only report: fills, settlements, and exact P&L computed
 * EXCLUSIVELY from the isolated sol30_* ownership ledgers. Legacy SOL
 * order_attempts / order_fills rows are never consulted, so this report can
 * never attribute legacy SOL activity to the SOL_30_50 strategy.
 *
 * Lazily reconciles pending settlements (read-only wrt trading behavior)
 * before computing the report. Never alters strategy state.
 */
router.get("/trade/analytics/reports/sol30-50", async (_req, res) => {
  try {
    await reconcileSol30Settlements();
    const report = await buildSol30Report();
    // Fire-and-forget stale-claim watchdog: emits WARN logs for any claimed
    // ticker with no fills older than the stale threshold. Errors are swallowed
    // so they can never block the report response.
    checkStaleSol30Claims().catch(() => {});
    res.json(report);
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "sol30-50 report unavailable", detail: e.message ?? "unknown" });
  }
});

/** Authenticated, read-only target coverage audit for durable SOL_30_50 positions. */
router.get("/trade/analytics/reports/sol30-50/target-protection", async (_req, res) => {
  try {
    res.json(await buildSol30TargetProtectionReport());
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "sol30-50 target-protection report unavailable", detail: e.message ?? "unknown" });
  }
});

// ── GET /trade/analytics/reports/settlement-coverage ──────────────────────────

/**
 * Read-only status for the audited replay settlement study. The source audit is
 * intentionally retained as an analysis artifact; this endpoint only presents
 * its immutable backfill summary alongside a live durable-DB coverage check.
 * It does not write to market_results or alter strategy behavior.
 */
router.get("/trade/analytics/reports/settlement-coverage", async (_req, res) => {
  try {
    // Use import.meta.url so the path resolves to the artifact data directory
    // regardless of the working directory (production starts from the workspace root).
    // esbuild bundles all source into a single dist/index.mjs, so import.meta.url
    // refers to dist/index.mjs; one level up from dist/ reaches the artifact root
    // where data/analysis/ lives.
    const analysisDir = fileURLToPath(new URL("../data/analysis", import.meta.url));
    const [outcomesRaw, auditRaw] = await Promise.all([
      readFile(join(analysisDir, "replay-3c74e738-local-outcomes.json"), "utf8"),
      readFile(join(analysisDir, "replay-3c74e738-kalshi-market-results-backfill-audit.json"), "utf8"),
    ]);
    const outcomes = JSON.parse(outcomesRaw) as {
      summary: { replayId: string; population: number };
      rows: Array<{ ticker: string }>;
    };
    const audit = JSON.parse(auditRaw) as {
      completedAt: string;
      candidateCount: number;
      insertedCount: number;
      unchangedCount: number;
      unresolvedCount: number;
      errorCount: number;
    };
    const tickers = [...new Set(outcomes.rows.map((row) => row.ticker).filter(Boolean))];
    const coverage = await loadMarketResultsCoverage(tickers);

    res.json({
      replayId: outcomes.summary.replayId,
      population: outcomes.summary.population,
      durableCovered: coverage.coveredCount,
      durableUnresolved: coverage.uncoveredTickers.length,
      durableStorageTotal: coverage.totalDurableCount,
      audit: {
        completedAt: audit.completedAt,
        candidateCount: audit.candidateCount,
        insertedCount: audit.insertedCount,
        unchangedCount: audit.unchangedCount,
        unresolvedCount: audit.unresolvedCount,
        errorCount: audit.errorCount,
      },
      readonly: true,
      caveat: "This card reports an offline settlement-data study. It does not run a replay or change any live trading setting.",
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: "settlement coverage report unavailable", detail });
  }
});

// ── GET /trade/analytics/reports/loss-timeline ────────────────────────────────

/**
 * Detailed order timeline for filled orders on a given series + Eastern date.
 * Returns full latency instrumentation (tick→eval→L2→post→ack) plus individual
 * fill chunks for each order. Designed for "falling knife" audits — reveals how
 * long the market price had been moving before the order was posted.
 *
 * Query params:
 *   series — Kalshi series prefix, e.g. "KXBTC15M" (default "KXBTC15M")
 *   date   — Eastern date YYYY-MM-DD (default today)
 *   win    — "true" | "false" | "all" (default "all")
 *
 * Derived interval fields added to each order:
 *   evalToL2Ms    — l2_start_ms − eval_start_ms  (time before L2 fetch begins)
 *   l2LatencyMs   — l2_end_ms − l2_start_ms      (L2 round trip)
 *   l2ToPostMs    — post_start_ms − l2_end_ms    (decision→submit gap)
 *   postToAckMs   — ack_ms − post_start_ms       (Kalshi round trip)
 *   tickToAckMs   — ack_ms − tick_received_ms    (full pipeline latency)
 *   tickToPostMs  — post_start_ms − tick_received_ms
 */
router.get("/trade/analytics/reports/loss-timeline", async (req, res) => {
  try {
    const series    = (req.query["series"] as string | undefined) ?? "KXBTC15M";
    const today     = new Date();
    const date      = (req.query["date"] as string | undefined) ??
      today.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const winParam  = req.query["win"] as string | undefined;
    const winFilter: boolean | null =
      winParam === "true"  ? true  :
      winParam === "false" ? false : null;

    const rows = await loadLossTimelineRows(series, date, winFilter);

    const enriched = rows.map((r) => ({
      ...r,
      evalToL2Ms:   r.eval_start_ms  && r.l2_start_ms   ? r.l2_start_ms  - r.eval_start_ms  : null,
      l2LatencyMs:  r.l2_start_ms    && r.l2_end_ms      ? r.l2_end_ms    - r.l2_start_ms    : null,
      l2ToPostMs:   r.l2_end_ms      && r.post_start_ms  ? r.post_start_ms - r.l2_end_ms     : null,
      postToAckMs:  r.post_start_ms  && r.ack_ms         ? r.ack_ms        - r.post_start_ms  : null,
      tickToAckMs:  r.tick_received_ms && r.ack_ms       ? r.ack_ms        - r.tick_received_ms : null,
      tickToPostMs: r.tick_received_ms && r.post_start_ms ? r.post_start_ms - r.tick_received_ms : null,
    }));

    res.json({
      series,
      date,
      winFilter:   winParam ?? "all",
      count:       enriched.length,
      orders:      enriched,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const e = err as { message?: string };
    res.status(500).json({ error: "loss-timeline report unavailable", detail: e.message ?? "unknown" });
  }
});

export default router;
