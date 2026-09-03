/**
 * Performance Analysis Framework — Step 3
 *
 * Pure computation layer: reads from analytics.ts getters, never mutates state.
 * Every function is safe to call at any time without affecting live trading.
 * Must NOT import pino/logger.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  getOrderAttempts,
  getWindowAnalytics,
  getDailySummary,
  type OrderAttemptRecord,
  type WindowAnalytics,
} from "./analytics.js";
import { canonicalFilledOrders } from "./orderCanonicalization.js";
import type { ReplayResult } from "../strategy/types.js";
import { TIME_ALERT_SECONDS as _TIME_ALERT_SECONDS } from "./autoTraderGuards.js";
import { loadPreflightDecisions, type PreflightDecision } from "./preflightStore.js";
import {
  MAX_BBO_L2_GAP_CENTS,
  MAX_BBO_L2_NEGATIVE_GAP_CENTS,
  ALERT_MIN,
  ALERT_MAX,
} from "./preflightGate.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

function avg(arr: number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function med(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const _etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hour12: false,
  weekday: "short",
});
/**
 * Eastern hour (0-23) from a UTC ms timestamp. Exact DST handling.
 */
export function easternHour(ms: number): number {
  return etHourAndDow(ms).hour;
}

/**
 * Eastern day-of-week (0=Sun … 6=Sat) from a UTC ms timestamp. Exact DST handling.
 */
export function easternDayOfWeek(ms: number): number {
  return etHourAndDow(ms).dow;
}

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// ── 1. Fill Performance Report ────────────────────────────────────────────────

export interface FillPerformanceSeries {
  series: string;
  qualifyingWindows: number;
  windowsTraded: number;
  windowsFilled: number;
  fillRateByWindow: number | null;
  fillRateByAttempt: number | null;
  avgAttemptsPerFill: number | null;
  medianAttemptsPerFill: number | null;
  maxAttempts: number;
  avgFillLatencyMs: number | null;
  medianFillLatencyMs: number | null;
  avgFillPriceCents: number | null;
  avgRequestedPriceCents: number | null;
  avgPriceImprovementCents: number | null;
}

export interface FillPerformanceReport {
  btc: FillPerformanceSeries;
  eth: FillPerformanceSeries;
}

function buildFillSeries(
  seriesKey: string,
  orders: OrderAttemptRecord[],
  windows: WindowAnalytics[],
): FillPerformanceSeries {
  const so = orders.filter((o) => o.series === seriesKey);
  const sw = windows.filter((w) => w.series === seriesKey);

  const qualifyingWindows = sw.filter((w) => w.qualifyingEvaluations > 0).length;
  const windowsTraded = sw.filter((w) => w.submittedOrders > 0).length;
  const windowsFilled = sw.filter(
    (w) => w.result === "filled" || w.result === "partial_fill",
  ).length;

  const filled = so.filter(
    (o) => o.outcome === "full_fill" || o.outcome === "partial_fill",
  );
  const attemptsPerFill = sw
    .filter((w) => w.attemptNumberThatFilled !== null)
    .map((w) => w.attemptNumberThatFilled!);

  const latencies = filled
    .filter((o) => o.roundTripMs !== null)
    .map((o) => o.roundTripMs!);
  const fillPrices = filled
    .filter((o) => o.fillPriceCents.value !== null)
    .map((o) => o.fillPriceCents.value as number);
  const reqPrices = so.map((o) => o.limitPriceCents);

  const avgFill = avg(fillPrices);
  const avgReq = avg(reqPrices);

  return {
    series: seriesKey,
    qualifyingWindows,
    windowsTraded,
    windowsFilled,
    fillRateByWindow: qualifyingWindows > 0 ? windowsFilled / qualifyingWindows : null,
    fillRateByAttempt: so.length > 0 ? filled.length / so.length : null,
    avgAttemptsPerFill: avg(attemptsPerFill),
    medianAttemptsPerFill: med(attemptsPerFill),
    maxAttempts: attemptsPerFill.length > 0 ? Math.max(...attemptsPerFill) : 0,
    avgFillLatencyMs: avg(latencies),
    medianFillLatencyMs: med(latencies),
    avgFillPriceCents: avgFill,
    avgRequestedPriceCents: avgReq,
    avgPriceImprovementCents:
      avgReq !== null && avgFill !== null ? avgReq - avgFill : null,
  };
}

export function getFillPerformanceReport(): FillPerformanceReport {
  const orders = getOrderAttempts(undefined, 1_000);
  const windows = getWindowAnalytics();
  return {
    btc: buildFillSeries("KXBTC15M", orders, windows),
    eth: buildFillSeries("KXETH15M", orders, windows),
  };
}

// ── 2. Retry Analysis Report ──────────────────────────────────────────────────

export interface RetryDistributionEntry {
  attemptNumber: number;
  fills: number;
  fillPct: number;
}

export interface RetryAnalysisReport {
  fillsByAttempt: RetryDistributionEntry[];
  pctWindowsNeverFilled: number | null;
  avgZeroFillsBeforeFirstFill: number | null;
  avgMsBetweenRetries: number | null;
}

export function getRetryAnalysisReport(): RetryAnalysisReport {
  const orders = getOrderAttempts(undefined, 1_000);
  const windows = getWindowAnalytics();

  const filled = orders.filter(
    (o) => o.outcome === "full_fill" || o.outcome === "partial_fill",
  );
  const maxAttempt =
    filled.length > 0 ? Math.max(...filled.map((o) => o.attemptNumber)) : 0;

  const fillsByAttempt: RetryDistributionEntry[] = [];
  for (let n = 1; n <= Math.max(maxAttempt, 1); n++) {
    const count = filled.filter((o) => o.attemptNumber === n).length;
    fillsByAttempt.push({
      attemptNumber: n,
      fills: count,
      fillPct: filled.length > 0 ? (count / filled.length) * 100 : 0,
    });
  }

  const traded = windows.filter((w) => w.submittedOrders > 0);
  const neverFilled = traded.filter(
    (w) => w.result !== "filled" && w.result !== "partial_fill",
  ).length;

  const zeroFillsBeforeFirst = windows
    .filter(
      (w) =>
        (w.result === "filled" || w.result === "partial_fill") &&
        w.attemptNumberThatFilled !== null,
    )
    .map((w) => w.zeroFills);

  // Avg time between successive retries (same ticker+side, gaps < 5 min only)
  const byKey = new Map<string, OrderAttemptRecord[]>();
  for (const o of orders) {
    const k = `${o.ticker}-${o.side}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(o);
  }
  const timeBetweenMs: number[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.attemptNumber - b.attemptNumber);
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i]!.timestampMs - sorted[i - 1]!.timestampMs;
      if (diff > 0 && diff < 300_000) timeBetweenMs.push(diff);
    }
  }

  return {
    fillsByAttempt,
    pctWindowsNeverFilled:
      traded.length > 0 ? (neverFilled / traded.length) * 100 : null,
    avgZeroFillsBeforeFirstFill: avg(zeroFillsBeforeFirst),
    avgMsBetweenRetries: avg(timeBetweenMs),
  };
}

// ── 3. Guard Analysis Report ──────────────────────────────────────────────────

export interface GuardEntry {
  guard: string;
  count: number;
  pct: number;
}

export interface GuardAnalysisReport {
  btc: GuardEntry[];
  eth: GuardEntry[];
  combined: GuardEntry[];
}

function buildGuardEntries(counts: Record<string, number>): GuardEntry[] {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([guard, count]) => ({
      guard,
      count,
      pct: total > 0 ? (count / total) * 100 : 0,
    }));
}

export function getGuardAnalysisReport(): GuardAnalysisReport {
  const s = getDailySummary();
  return {
    btc: buildGuardEntries(s.btc.guardOutcomeCounts as Record<string, number>),
    eth: buildGuardEntries(s.eth.guardOutcomeCounts as Record<string, number>),
    combined: buildGuardEntries(
      s.combined.guardOutcomeCounts as Record<string, number>,
    ),
  };
}

// ── 4. Time Analysis Report ───────────────────────────────────────────────────

export interface TimeBucket {
  label: string;
  submissions: number;
  fills: number;
  fillRate: number | null;
  avgLatencyMs: number | null;
  avgAttempts: number | null;
  avgSpendDollars: number | null;
}

export interface TimeAnalysisReport {
  byHour: TimeBucket[];
  byDayOfWeek: TimeBucket[];
}

function computeBuckets(
  orders: OrderAttemptRecord[],
  keyFn: (o: OrderAttemptRecord) => string,
  labels: readonly string[],
): TimeBucket[] {
  const groups = new Map<string, OrderAttemptRecord[]>();
  for (const lbl of labels) groups.set(lbl, []);
  for (const o of orders) {
    const k = keyFn(o);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(o);
  }
  return [...labels].map((lbl) => {
    const bucket = groups.get(lbl) ?? [];
    const filled = bucket.filter(
      (o) => o.outcome === "full_fill" || o.outcome === "partial_fill",
    );
    const latencies = filled
      .filter((o) => o.roundTripMs !== null)
      .map((o) => o.roundTripMs!);
    return {
      label: lbl,
      submissions: bucket.length,
      fills: filled.length,
      fillRate: bucket.length > 0 ? filled.length / bucket.length : null,
      avgLatencyMs: avg(latencies),
      avgAttempts: avg(bucket.map((o) => o.attemptNumber)),
      avgSpendDollars: avg(filled.map((o) => o.notionalDollars.value)),
    };
  });
}

export function getTimeAnalysisReport(): TimeAnalysisReport {
  const orders = getOrderAttempts(undefined, 1_000);
  const hourLabels = Array.from({ length: 24 }, (_, i) =>
    String(i).padStart(2, "0") + ":00",
  );
  return {
    byHour: computeBuckets(
      orders,
      (o) => String(easternHour(o.timestampMs)).padStart(2, "0") + ":00",
      hourLabels,
    ),
    byDayOfWeek: computeBuckets(
      orders,
      (o) => DAY_NAMES[easternDayOfWeek(o.timestampMs)]!,
      [...DAY_NAMES],
    ),
  };
}

// ── 5. Price Band Analysis Report ─────────────────────────────────────────────

export interface PriceBand {
  band: string;
  minCents: number;
  maxCents: number;
  submissions: number;
  fills: number;
  submissionRate: number | null;
  fillRate: number | null;
  avgAttempts: number | null;
  avgLatencyMs: number | null;
}

export interface PriceAnalysisReport {
  bands: PriceBand[];
}

export const PRICE_BANDS = [
  { band: "70-74", min: 70, max: 74 },
  { band: "75-79", min: 75, max: 79 },
  { band: "80-84", min: 80, max: 84 },
  { band: "85-89", min: 85, max: 89 },
  { band: "90-95", min: 90, max: 95 },
] as const;

export function getPriceAnalysisReport(): PriceAnalysisReport {
  const orders = getOrderAttempts(undefined, 1_000);
  const total = orders.length;

  const bands: PriceBand[] = PRICE_BANDS.map(({ band, min, max }) => {
    const bucket = orders.filter(
      (o) => o.triggerPriceCents >= min && o.triggerPriceCents <= max,
    );
    const filled = bucket.filter(
      (o) => o.outcome === "full_fill" || o.outcome === "partial_fill",
    );
    const latencies = filled
      .filter((o) => o.roundTripMs !== null)
      .map((o) => o.roundTripMs!);
    return {
      band,
      minCents: min,
      maxCents: max,
      submissions: bucket.length,
      fills: filled.length,
      submissionRate: total > 0 ? bucket.length / total : null,
      fillRate: bucket.length > 0 ? filled.length / bucket.length : null,
      avgAttempts: avg(bucket.map((o) => o.attemptNumber)),
      avgLatencyMs: avg(latencies),
    };
  });

  return { bands };
}

// ── 6. Replay Comparison Report ───────────────────────────────────────────────

export interface ReplayComparisonMetric {
  metric: string;
  replay: number | null;
  production: number | null;
  delta: number | null; // production - replay; positive = production higher
  deltaSign: "positive" | "negative" | "neutral";
}

export interface ReplayComparisonReport {
  replayId: string;
  runAt: string;
  strategyVersion: string;
  metrics: ReplayComparisonMetric[];
  note: string;
}

function cmpMetric(
  metric: string,
  replay: number | null,
  production: number | null,
  higherIsBetter: boolean,
): ReplayComparisonMetric {
  const delta =
    replay !== null && production !== null ? production - replay : null;
  let deltaSign: "positive" | "negative" | "neutral" = "neutral";
  if (delta !== null && delta !== 0) {
    deltaSign =
      (higherIsBetter ? delta > 0 : delta < 0) ? "positive" : "negative";
  }
  return { metric, replay, production, delta, deltaSign };
}

// ── 5b. P&L rolling report (fill-price bands, outcome-reconciled data) ────────

/**
 * User-defined fill-price bands for P&L analysis.
 * Based on actual fill price, not trigger price.
 */
export const PNL_PRICE_BANDS = [
  { band: "72-75", min: 72, max: 75 },
  { band: "76-80", min: 76, max: 80 },
  { band: "81-85", min: 81, max: 85 },
  { band: "86-90", min: 86, max: 90 },
] as const;

/** Sample-size guidance for each P&L bucket. */
export type SampleSizeWarning =
  | "very_small"       // < 30 fills
  | "preliminary"      // 30–99 fills
  | "more_meaningful"  // 100+ fills
  | null;              // no fills in bucket

export function sampleSizeWarning(n: number): SampleSizeWarning {
  if (n === 0) return null;
  if (n < 30)  return "very_small";
  if (n < 100) return "preliminary";
  return "more_meaningful";
}

export interface PnlBand {
  band:                    string;
  minCents:                number;
  maxCents:                number;
  fills:                   number;
  wins:                    number;
  losses:                  number;
  winRate:                 number | null;
  grossPnlDollars:         number | null;
  netPnlDollars:           number | null;
  notionalDeployedDollars: number | null;
  roi:                     number | null;
  avgFillPriceCents:       number | null;
  sampleWarning:           SampleSizeWarning;
}

export interface PnlByAsset {
  asset:                   "BTC" | "ETH" | "combined";
  fills:                   number;
  wins:                    number;
  losses:                  number;
  winRate:                 number | null;
  grossPnlDollars:         number | null;
  netPnlDollars:           number | null;
  notionalDeployedDollars: number | null;
  roi:                     number | null;
  sampleWarning:           SampleSizeWarning;
}

export interface PnlBySide {
  side:            "yes" | "no" | "combined";
  fills:           number;
  wins:            number;
  losses:          number;
  winRate:         number | null;
  grossPnlDollars: number | null;
  netPnlDollars:   number | null;
  roi:             number | null;
  sampleWarning:   SampleSizeWarning;
}

export interface PnlByHour {
  easternHour:     number;
  fills:           number;
  wins:            number;
  grossPnlDollars: number | null;
  netPnlDollars:   number | null;
  roi:             number | null;
  winRate:         number | null;
  sampleWarning:   SampleSizeWarning;
}

/**
 * Time-of-day buckets (Eastern) for win-rate analysis.
 * Half-open hour bounds [minHour, maxHour).
 */
export const TIME_OF_DAY_BUCKETS = [
  { label: "Overnight (12–6 AM)",  minHour: 0,  maxHour: 6 },
  { label: "Morning (6 AM–12 PM)", minHour: 6,  maxHour: 12 },
  { label: "Afternoon (12–6 PM)",  minHour: 12, maxHour: 18 },
  { label: "Evening (6 PM–12 AM)", minHour: 18, maxHour: 24 },
] as const;

export interface TimeOfDayStats {
  fills:           number;
  wins:            number;
  losses:          number;
  winRate:         number | null;
  grossPnlDollars: number | null;
  netPnlDollars:   number | null;
  roi:             number | null;
  sampleWarning:   SampleSizeWarning;
}

export interface PnlByTimeOfDay {
  label:    string;
  minHour:  number;
  maxHour:  number;
  combined: TimeOfDayStats;
  btc:      TimeOfDayStats;
  eth:      TimeOfDayStats;
}

export interface PendingReconciliation {
  fillsTotal:      number;
  fillsReconciled: number;
  fillsPending:    number;
  pendingTickers:  string[];
}

/**
 * Whether the report total is final (all fills verified against exchange) or
 * preliminary (some fills have estimated prices or pending settlement).
 *
 * - "exchange_reconciled" — every included fill has an exact cost and fee
 *   confirmed from Kalshi's fills endpoint (fill_price_source = 'actual',
 *   reconcile_failed ≠ true) and a settled market result.
 * - "reconstructed" — one or more fills use an estimated fill price
 *   (reconcile_failed = true or fill_price_source = 'limit_fallback') or
 *   have not yet settled.  The total is preliminary and should not be
 *   presented as a final official record.
 */
export type PnlReconciliationStatus = "exchange_reconciled" | "reconstructed";

export interface PnlReport {
  period:      string;   // "today" | "7d" | "all-time"
  dateRange:   { from: string; to: string };
  summary:     PnlByAsset;
  byAsset:     PnlByAsset[];
  byBand:      PnlBand[];
  bySide:      PnlBySide[];
  byHour:      PnlByHour[];
  byTimeOfDay: PnlByTimeOfDay[];
  pending:     PendingReconciliation;
  /** Number of settled fills whose P&L used an estimated fill price (reconcile_failed=true or fill_price_source='limit_fallback'). */
  estimatedFillCount: number;
  /**
   * Whether this report can be presented as final.  "exchange_reconciled"
   * means every included fill has exchange-verified economics.
   * "reconstructed" means the total is preliminary and must be labelled as
   * such until reconciliation completes.
   */
  reconciliationStatus: PnlReconciliationStatus;
  generatedAt: string;
}

// ── Final-status gate ────────────────────────────────────────────────────────

/**
 * The subset of the authoritative child-fill ledger result needed to gate the
 * final reconciliation status.  Callers (the analytics HTTP route) read this
 * from `getVerifiedPnlBySeries()`; tests supply it directly so the gate can
 * be exercised without a database.
 */
export interface LedgerCoverage {
  /**
   * Net P&L confirmed by the child-fill ledger.
   * Null when the ledger is unavailable or has pending verification rows.
   */
  confirmedNetPnlDollars: number | null;
  /**
   * Number of fills the ledger has settled exchange economics for.
   * An empty SQL result produces 0 — not null — so this field distinguishes
   * "ledger says zero balance" from "ledger is unavailable".
   */
  settledFillCount: number;
}

/**
 * Derive the authoritative final reconciliation status by cross-checking the
 * parent-record analysis against the SQL child-fill ledger.
 *
 * Exported as a pure function so the gating logic can be unit-tested
 * independently of the HTTP route and the database layer.
 *
 * A report is "exchange_reconciled" only when ALL of the following hold:
 *   (a) The parent-record analysis is "exchange_reconciled" (every fill has
 *       positive exchange confirmation and no failure markers).
 *   (b) The authoritative ledger is available (confirmedNetPnlDollars non-null).
 *   (c) The ledger settled-fill count meets or exceeds the parent's
 *       exchange-verified fill count, AND is > 0 for a non-empty report
 *       (zero ledger rows with non-zero parent fills means the SQL result
 *       covers nothing — it must not be mistaken for a zero-balance confirmation).
 *   (d) The ledger and parent net P&L agree within 1¢.  A larger divergence
 *       means the stored parent economics differ from actual exchange fills.
 *
 * Any failure in (a)–(d) returns "reconstructed" (fail-closed).
 * When there are no fills at all the result is vacuously "exchange_reconciled".
 */
export function computeFinalReconciliationStatus(
  /** Status derived from parent OrderAttemptRecord flags. */
  parentStatus: PnlReconciliationStatus,
  /** Net P&L from the parent summary (may be null when no settled fills). */
  parentNetPnlDollars: number | null,
  /** Exchange-verified fill count from the parent reconciliation view. */
  parentExchangeVerifiedCount: number,
  /** Authoritative ledger data; null when the ledger call was skipped. */
  ledger: LedgerCoverage | null,
): PnlReconciliationStatus {
  // Vacuously reconciled: no fills at all, nothing to verify.
  if (parentStatus === "exchange_reconciled" && parentExchangeVerifiedCount === 0) {
    return "exchange_reconciled";
  }

  // (a) Parent analysis found at least one unverified fill.
  if (parentStatus !== "exchange_reconciled") return "reconstructed";

  // (b) Ledger unavailable or has pending verification rows.
  if (ledger == null || ledger.confirmedNetPnlDollars == null) return "reconstructed";

  // (c) Ledger coverage check.
  // Zero ledger rows with non-zero parent fills means the SQL result covers
  // nothing for this period.  A zero result from an empty table is NOT a
  // confirmation of a zero-balance report.
  if (ledger.settledFillCount === 0) return "reconstructed";
  if (ledger.settledFillCount < parentExchangeVerifiedCount) return "reconstructed";

  // (d) Dollar-total agreement — reject at 1¢ or more.
  // A 1¢ difference on a $0 total is just as significant as a 1¢ difference on
  // any other total; using strict > would silently pass exactly-1¢ divergences.
  if (
    parentNetPnlDollars != null &&
    Math.abs(ledger.confirmedNetPnlDollars - parentNetPnlDollars) >= 0.01
  ) {
    return "reconstructed";
  }

  return "exchange_reconciled";
}

// ── P&L helpers ───────────────────────────────────────────────────────────────

function buildAsset(
  subset:  OrderAttemptRecord[],
  asset:   "BTC" | "ETH" | "combined",
): PnlByAsset {
  if (subset.length === 0) {
    return {
      asset, fills: 0, wins: 0, losses: 0,
      winRate: null, grossPnlDollars: null, netPnlDollars: null,
      notionalDeployedDollars: null, roi: null, sampleWarning: null,
    };
  }
  const wins    = subset.filter((o) => o.win === true).length;
  const gross   = subset.reduce((s, o) => s + (o.grossPnlDollars ?? 0), 0);
  const net     = subset.reduce((s, o) => s + (o.netPnlDollars ?? 0), 0);
  const notional = subset.reduce((s, o) => s + o.notionalDollars.value, 0);
  return {
    asset,
    fills:                   subset.length,
    wins,
    losses:                  subset.length - wins,
    winRate:                 wins / subset.length,
    grossPnlDollars:         gross,
    netPnlDollars:           net,
    notionalDeployedDollars: notional,
    roi:                     notional > 0 ? gross / notional : null,
    sampleWarning:           sampleSizeWarning(subset.length),
  };
}

function buildSide(
  subset: OrderAttemptRecord[],
  side:   "yes" | "no" | "combined",
): PnlBySide {
  if (subset.length === 0) {
    return {
      side, fills: 0, wins: 0, losses: 0,
      winRate: null, grossPnlDollars: null, netPnlDollars: null,
      roi: null, sampleWarning: null,
    };
  }
  const wins    = subset.filter((o) => o.win === true).length;
  const gross   = subset.reduce((s, o) => s + (o.grossPnlDollars ?? 0), 0);
  const net     = subset.reduce((s, o) => s + (o.netPnlDollars ?? 0), 0);
  const notional = subset.reduce((s, o) => s + o.notionalDollars.value, 0);
  return {
    side,
    fills:           subset.length,
    wins,
    losses:          subset.length - wins,
    winRate:         wins / subset.length,
    grossPnlDollars: gross,
    netPnlDollars:   net,
    roi:             notional > 0 ? gross / notional : null,
    sampleWarning:   sampleSizeWarning(subset.length),
  };
}

/**
 * Build a P&L report over the supplied order records.
 *
 * @param orders   - Order records for the desired date range (from analyticsStore)
 * @param period   - Human-readable label: "today", "7d", or "all-time"
 * @param fromDate - Inclusive start date string (YYYY-MM-DD)
 * @param toDate   - Inclusive end date string (YYYY-MM-DD)
 *
 * Only orders with marketResult set (outcome-reconciled) contribute to P&L figures.
 * Orders that filled but have not yet been reconciled are counted in `pending`.
 */
export function getPnlReport(
  orders:   OrderAttemptRecord[],
  period:   string,
  fromDate: string,
  toDate:   string,
): PnlReport {
  // All filled orders in the date range
  const allFills = canonicalFilledOrders(orders);

  // Reconciled subset: have a confirmed market result via the reconciler
  // (outcomeReconciledAt != null) OR via the won-column fallback written by
  // recoverForwardSettlementsFromSql() / markWonForSettledTicker() when a
  // market_results row is absent but the settlement direction is known (win != null).
  const fills = allFills.filter((o) => o.outcomeReconciledAt != null || o.win != null);

  // ── By asset ────────────────────────────────────────────────────────────────
  const btcFills = fills.filter((o) => o.series?.startsWith("KXBTC"));
  const ethFills = fills.filter((o) => o.series?.startsWith("KXETH"));

  // ── By band (using actual fill price) ───────────────────────────────────────
  const byBand: PnlBand[] = PNL_PRICE_BANDS.map(({ band, min, max }) => {
    const bucket = fills.filter((o) => {
      const fp = o.fillPriceCents.value ?? o.limitPriceCents;
      return fp >= min && fp <= max;
    });
    const wins    = bucket.filter((o) => o.win === true).length;
    const gross   = bucket.reduce((s, o) => s + (o.grossPnlDollars ?? 0), 0);
    const net     = bucket.reduce((s, o) => s + (o.netPnlDollars ?? 0), 0);
    const notional = bucket.reduce((s, o) => s + o.notionalDollars.value, 0);
    const avgFP   = avg(bucket.map((o) => o.fillPriceCents.value ?? o.limitPriceCents));
    return {
      band, minCents: min, maxCents: max,
      fills:                   bucket.length,
      wins,
      losses:                  bucket.length - wins,
      winRate:                 bucket.length > 0 ? wins / bucket.length : null,
      grossPnlDollars:         bucket.length > 0 ? gross   : null,
      netPnlDollars:           bucket.length > 0 ? net     : null,
      notionalDeployedDollars: bucket.length > 0 ? notional : null,
      roi:                     notional > 0 ? gross / notional : null,
      avgFillPriceCents:       avgFP,
      sampleWarning:           sampleSizeWarning(bucket.length),
    };
  });

  // ── By side ──────────────────────────────────────────────────────────────────
  const yesFills = fills.filter((o) => o.side === "yes");
  const noFills  = fills.filter((o) => o.side === "no");

  // ── By Eastern hour ──────────────────────────────────────────────────────────
  const hourMap = new Map<number, OrderAttemptRecord[]>();
  for (const o of fills) {
    const h = easternHour(o.timestampMs);
    if (!hourMap.has(h)) hourMap.set(h, []);
    hourMap.get(h)!.push(o);
  }
  const byHour: PnlByHour[] = [...hourMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([h, bucket]) => {
      const wins    = bucket.filter((o) => o.win === true).length;
      const gross   = bucket.reduce((s, o) => s + (o.grossPnlDollars ?? 0), 0);
      const net     = bucket.reduce((s, o) => s + (o.netPnlDollars ?? 0), 0);
      const notional = bucket.reduce((s, o) => s + o.notionalDollars.value, 0);
      return {
        easternHour:     h,
        fills:           bucket.length,
        wins,
        grossPnlDollars: bucket.length > 0 ? gross : null,
        netPnlDollars:   bucket.length > 0 ? net   : null,
        roi:             notional > 0 ? gross / notional : null,
        winRate:         bucket.length > 0 ? wins / bucket.length : null,
        sampleWarning:   sampleSizeWarning(bucket.length),
      };
    });

  // ── By time-of-day bucket (Eastern), per asset ───────────────────────────────
  const buildTodStats = (subset: OrderAttemptRecord[]): TimeOfDayStats => {
    if (subset.length === 0) {
      return {
        fills: 0, wins: 0, losses: 0, winRate: null,
        grossPnlDollars: null, netPnlDollars: null, roi: null, sampleWarning: null,
      };
    }
    const wins     = subset.filter((o) => o.win === true).length;
    const gross    = subset.reduce((s, o) => s + (o.grossPnlDollars ?? 0), 0);
    const net      = subset.reduce((s, o) => s + (o.netPnlDollars ?? 0), 0);
    const notional = subset.reduce((s, o) => s + o.notionalDollars.value, 0);
    return {
      fills:           subset.length,
      wins,
      losses:          subset.length - wins,
      winRate:         wins / subset.length,
      grossPnlDollars: gross,
      netPnlDollars:   net,
      roi:             notional > 0 ? gross / notional : null,
      sampleWarning:   sampleSizeWarning(subset.length),
    };
  };
  const byTimeOfDay: PnlByTimeOfDay[] = TIME_OF_DAY_BUCKETS.map(({ label, minHour, maxHour }) => {
    const inBucket = fills.filter((o) => {
      const h = easternHour(o.timestampMs);
      return h >= minHour && h < maxHour;
    });
    return {
      label, minHour, maxHour,
      combined: buildTodStats(inBucket),
      btc:      buildTodStats(inBucket.filter((o) => o.series?.startsWith("KXBTC"))),
      eth:      buildTodStats(inBucket.filter((o) => o.series?.startsWith("KXETH"))),
    };
  });

  // ── Pending reconciliation ───────────────────────────────────────────────────
  // An order is truly pending only when BOTH outcomeReconciledAt IS NULL AND
  // the won-column fallback is also absent (win == null).  An order with
  // win != null is settled (via the fallback path) and has already been counted
  // in `fills`, so it must not also appear in `pendingFills`.
  const pendingFills   = allFills.filter((o) => o.outcomeReconciledAt == null && o.win == null);
  const pendingTickers = [...new Set(pendingFills.map((o) => o.ticker))];

  // ── Estimated fill count ────────────────────────────────────────────────────
  // Reconciled fills where fill price is from the order limit (reconciliation
  // permanently failed). P&L from these may be inaccurate.
  const estimatedFillCount = fills.filter(
    (o) => o.reconcile_failed === true || o.fill_price_source === "limit_fallback",
  ).length;

  // ── Reconciliation status label ──────────────────────────────────────────────
  // "exchange_reconciled" requires **positive evidence** from the fills API for
  // every fill in the period:
  //   • fill_price_source === 'actual'  — price confirmed from Kalshi fills endpoint
  //   • outcomeReconciledAt != null     — market has settled
  //
  // Any fill without that explicit confirmation — whether its reconciliation is
  // still in-flight (null fill_price_source), permanently failed (reconcile_failed
  // or limit_fallback), or pending settlement — makes the total "reconstructed".
  // Checking only failure flags is insufficient: a fill with fill_price_source=null
  // and reconcile_failed=false is still unverified.
  //
  // reconcile_failed overrides even a fill that carries fill_price_source='actual':
  // if the reconciliation recorded a failure marker, the stored 'actual' tag cannot
  // be trusted as a definitive confirmation.
  const hasAnyUnverified = allFills.some(
    (o) =>
      o.fill_price_source !== "actual" ||
      o.outcomeReconciledAt == null ||
      o.reconcile_failed === true,
  );
  const reconciliationStatus: PnlReconciliationStatus =
    !hasAnyUnverified ? "exchange_reconciled" : "reconstructed";

  return {
    period,
    dateRange: { from: fromDate, to: toDate },
    summary:   buildAsset(fills, "combined"),
    byAsset:   [buildAsset(btcFills, "BTC"), buildAsset(ethFills, "ETH"), buildAsset(fills, "combined")],
    byBand,
    bySide:    [buildSide(yesFills, "yes"), buildSide(noFills, "no"), buildSide(fills, "combined")],
    byHour,
    byTimeOfDay,
    pending:   {
      fillsTotal:      allFills.length,
      fillsReconciled: fills.length,
      fillsPending:    pendingFills.length,
      pendingTickers,
    },
    estimatedFillCount,
    reconciliationStatus,
    generatedAt: new Date().toISOString(),
  };
}

// ── 6b. Reconciliation View ───────────────────────────────────────────────────

/**
 * Categorisation of a single filled order's reconciliation state.
 *
 * - "exchange_verified"      — positive evidence from Kalshi's fills API:
 *                              fill_price_source === 'actual' AND market settled.
 *                              Only this category contributes to a final total.
 * - "estimated_price"        — the market has settled but fill price could not be
 *                              confirmed (reconcile_failed=true or
 *                              fill_price_source='limit_fallback').  P&L may be
 *                              inaccurate.
 * - "pending_reconciliation" — the market has settled but the fills API has not
 *                              yet confirmed the fill price (fill_price_source is
 *                              null — reconciliation is still in-flight or was
 *                              never attempted).  These fills must not be labelled
 *                              as exchange-confirmed.
 * - "pending_settlement"     — the market has not yet settled; no outcome or P&L
 *                              can be reported for this fill.
 */
export type FillReconciliationCategory =
  | "exchange_verified"
  | "estimated_price"
  | "pending_reconciliation"
  | "pending_settlement";

export interface ReconciliationFillItem {
  id:              string;
  ticker:          string;
  series:          string;
  side:            "yes" | "no";
  fillPriceCents:  number | null;
  contracts:       number | null;
  notionalDollars: number | null;
  feeDollars:      number | null;
  fillPriceSource: string | null;
  /**
   * Classification of this fill's reconciliation state.
   * Only "exchange_verified" fills may contribute to a final official total.
   */
  category:              FillReconciliationCategory;
  /**
   * Net P&L as confirmed from exchange-authoritative fill records.
   * null for any category other than "exchange_verified".
   */
  exchangeVerifiedPnl:   number | null;
  /**
   * Net P&L as stored in the local order record.  Present for all fills
   * with a settled outcome, regardless of category.  Absent (null) for
   * "pending_settlement" fills where no outcome exists yet.
   */
  localPnl:              number | null;
}

/**
 * A structured view of fill-level reconciliation state for a date range.
 *
 * Use this view to:
 *   - Identify fills that are excluded from (or caveated in) the P&L total.
 *   - Compare the exchange-verified subtotal against the full reported total.
 *   - Prevent a final total from silently omitting unreconciled or inconsistent
 *     fills.
 *
 * When `status` is "exchange_reconciled", `verifiedNetPnlDollars` and
 * `reportedNetPnlDollars` are equal and the total may be presented as final.
 * When `status` is "reconstructed", the report must be labelled as
 * preliminary until all fills reach "exchange_verified".
 */
export interface ReconciliationView {
  status:         PnlReconciliationStatus;
  period:         string;
  dateRange:      { from: string; to: string };
  /** Total filled orders in the period (all categories). */
  totalFills:         number;
  /** Fills with exchange-confirmed exact economics and a settled outcome. */
  exchangeVerified:   number;
  /** Fills where reconciliation permanently failed and an estimated price was used. */
  estimatedPrice:     number;
  /**
   * Fills with a settled outcome but fill price not yet confirmed from the
   * exchange (fill_price_source is null — reconciliation in-flight or never
   * attempted).  Must not be treated as exchange-confirmed.
   */
  pendingReconciliation: number;
  /** Fills still awaiting market settlement. */
  pendingSettlement:  number;
  /**
   * Net P&L from exchange_verified fills only.
   * null when there are no verified fills.
   * This is the only component that may be labelled "confirmed".
   */
  verifiedNetPnlDollars:   number | null;
  /**
   * Net P&L from estimated_price and pending_reconciliation fills.
   * null when there are no such fills.
   * These components use local order economics and may be inaccurate.
   */
  estimatedNetPnlDollars:  number | null;
  /**
   * Combined net P&L from all fills with a settled outcome
   * (exchange_verified + estimated_price + pending_reconciliation).
   * Equals verifiedNetPnlDollars when all settled fills are verified.
   * null when there are no settled fills.
   */
  reportedNetPnlDollars:   number | null;
  /** Per-fill reconciliation detail, newest first. */
  fills:          ReconciliationFillItem[];
  generatedAt:    string;
}

/**
 * Build a per-fill reconciliation view over the supplied order records.
 *
 * This is a pure read-only report. It never modifies any analytics state and
 * is safe to call at any time alongside live trading.
 *
 * @param orders   - Order records for the desired date range
 * @param period   - Human-readable label: "today", "7d", or "all-time"
 * @param fromDate - Inclusive start date string (YYYY-MM-DD)
 * @param toDate   - Inclusive end date string (YYYY-MM-DD)
 */
export function getReconciliationView(
  orders:   OrderAttemptRecord[],
  period:   string,
  fromDate: string,
  toDate:   string,
): ReconciliationView {
  const allFills = canonicalFilledOrders(orders);

  const fillItems: ReconciliationFillItem[] = allFills.map((o) => {
    // Require positive evidence for exchange verification — all three conditions
    // must hold simultaneously. reconcile_failed overrides even a fill that
    // carries fill_price_source='actual'; if the reconciliation recorded a
    // failure marker that stored 'actual' tag cannot be trusted as confirmation.
    const isExchangeVerified  =
      o.fill_price_source === "actual" &&
      o.outcomeReconciledAt != null    &&
      o.reconcile_failed !== true;
    const isEstimatedPrice    = o.reconcile_failed === true || o.fill_price_source === "limit_fallback";
    const isPendingSettlement = o.outcomeReconciledAt == null;
    // Settled outcome but fill price not yet confirmed from exchange:
    // fill_price_source is null, not failed, not in pending_settlement.
    const isPendingReconciliation =
      !isExchangeVerified && !isEstimatedPrice && !isPendingSettlement;

    const category: FillReconciliationCategory = isPendingSettlement
      ? "pending_settlement"
      : isEstimatedPrice
        ? "estimated_price"
        : isPendingReconciliation
          ? "pending_reconciliation"
          : "exchange_verified";

    return {
      id:              o.id,
      ticker:          o.ticker,
      series:          o.series,
      side:            o.side,
      fillPriceCents:  o.fillPriceCents.value ?? null,
      contracts:       o.contracts?.value ?? null,
      notionalDollars: o.notionalDollars.value,
      feeDollars:      o.feeDollars?.value ?? null,
      fillPriceSource: o.fill_price_source ?? null,
      category,
      // exchangeVerifiedPnl is only set for fills with positive exchange
      // confirmation. Every other category keeps it null so the distinction
      // between "confirmed" and "estimated / in-flight" is always explicit.
      exchangeVerifiedPnl: category === "exchange_verified" ? (o.netPnlDollars ?? null) : null,
      // localPnl is the P&L as stored locally, available for settled fills
      // regardless of whether the price was exchange-confirmed.
      localPnl: isPendingSettlement ? null : (o.netPnlDollars ?? null),
    };
  });

  const verifiedItems              = fillItems.filter((f) => f.category === "exchange_verified");
  const estimatedItems             = fillItems.filter((f) => f.category === "estimated_price");
  const pendingReconciliationItems = fillItems.filter((f) => f.category === "pending_reconciliation");
  const pendingSettlementItems     = fillItems.filter((f) => f.category === "pending_settlement");

  const verifiedNet = verifiedItems.length > 0
    ? verifiedItems.reduce((s, f) => s + (f.exchangeVerifiedPnl ?? 0), 0)
    : null;

  // Non-verified settled fills: estimated_price + pending_reconciliation
  const nonVerifiedSettled = [...estimatedItems, ...pendingReconciliationItems];
  const estimatedNet = nonVerifiedSettled.length > 0
    ? nonVerifiedSettled.reduce((s, f) => s + (f.localPnl ?? 0), 0)
    : null;

  // Reported total spans all fills with a settled outcome (confirmed + unconfirmed).
  // Pending-settlement fills are intentionally excluded — they have no outcome.
  const settledItems = [...verifiedItems, ...estimatedItems, ...pendingReconciliationItems];
  const reportedNet  = settledItems.length > 0
    ? settledItems.reduce((s, f) => s + (f.localPnl ?? 0), 0)
    : null;

  // "exchange_reconciled" requires every fill to carry positive exchange
  // confirmation (fill_price_source === 'actual' + settled outcome).
  // Vacuously reconciled when there are no fills at all.
  const status: PnlReconciliationStatus =
    estimatedItems.length === 0 &&
    pendingReconciliationItems.length === 0 &&
    pendingSettlementItems.length === 0
      ? "exchange_reconciled"
      : "reconstructed";

  return {
    status,
    period,
    dateRange:              { from: fromDate, to: toDate },
    totalFills:             allFills.length,
    exchangeVerified:       verifiedItems.length,
    estimatedPrice:         estimatedItems.length,
    pendingReconciliation:  pendingReconciliationItems.length,
    pendingSettlement:      pendingSettlementItems.length,
    verifiedNetPnlDollars:  verifiedNet,
    estimatedNetPnlDollars: estimatedNet,
    reportedNetPnlDollars:  reportedNet,
    fills:                  fillItems,
    generatedAt:            new Date().toISOString(),
  };
}

// ── 7. Entry Timing Report ────────────────────────────────────────────────────

/**
 * Buckets for time-remaining-at-entry analysis.
 * Label is the human-readable range (e.g. "2:00–3:00 left").
 * minSecs/maxSecs are the half-open bounds [minSecs, maxSecs).
 * maxSecs = Infinity for the ">3:00" bucket.
 */
export const ENTRY_TIMING_BUCKETS = [
  { label: ">3:00 left",    minSecs:  180, maxSecs: Infinity },
  { label: "2:00–3:00 left", minSecs: 120, maxSecs: 180 },
  { label: "1:00–2:00 left", minSecs:  60, maxSecs: 120 },
  { label: "<1:00 left",    minSecs:    0, maxSecs:  60 },
] as const;

export interface EntryTimingBucket {
  label:             string;
  minSecs:           number;
  maxSecs:           number | null; // null = no upper bound
  submissions:       number;
  fills:             number;
  fillRate:          number | null;
  reconciled:        number;
  wins:              number;
  losses:            number;
  winRate:           number | null;
  avgFillPriceCents: number | null;
  avgNetPnlDollars:  number | null;
  sampleWarning:     SampleSizeWarning;
}

export interface EntryTimingReport {
  period:      string;
  dateRange:   { from: string; to: string };
  buckets:     EntryTimingBucket[];
  pending:     PendingReconciliation;
  generatedAt: string;
  /** The current TIME_ALERT_SECONDS value baked in at compile time is 120 s (2:00 left). */
  currentCutoffSecs: number;
}

/** The server's current TIME_ALERT_SECONDS value (re-exported from autoTraderGuards). */
export const TIME_ALERT_SECONDS = _TIME_ALERT_SECONDS;

/**
 * Build an entry-timing P&L report over the supplied order records.
 *
 * @param orders   - Order records for the desired date range
 * @param period   - Human-readable label: "today", "7d", or "all-time"
 * @param fromDate - Inclusive start date string (YYYY-MM-DD)
 * @param toDate   - Inclusive end date string (YYYY-MM-DD)
 *
 * Only outcome-reconciled fills contribute to win/loss figures.
 * Orders without a parseable windowCloseTime are excluded from timing buckets.
 */
export function getEntryTimingReport(
  orders:   OrderAttemptRecord[],
  period:   string,
  fromDate: string,
  toDate:   string,
): EntryTimingReport {
  // All filled orders
  const allFills = orders.filter(
    (o) => o.outcome === "full_fill" || o.outcome === "partial_fill",
  );

  // Reconciled subset
  const reconciledFills = allFills.filter((o) => o.outcomeReconciledAt != null);

  /** Compute seconds remaining at entry. Returns null when windowCloseTime is missing/unparseable. */
  function secsRemaining(o: OrderAttemptRecord): number | null {
    if (!o.windowCloseTime) return null;
    const closeMs = Date.parse(o.windowCloseTime);
    if (isNaN(closeMs)) return null;
    return (closeMs - o.timestampMs) / 1000;
  }

  const buckets: EntryTimingBucket[] = ENTRY_TIMING_BUCKETS.map(({ label, minSecs, maxSecs }) => {
    const inBucket = (o: OrderAttemptRecord) => {
      const s = secsRemaining(o);
      if (s === null) return false;
      return s >= minSecs && (maxSecs === Infinity || s < maxSecs);
    };

    const subm       = orders.filter(inBucket);
    const fills      = allFills.filter(inBucket);
    const reconciled = reconciledFills.filter(inBucket);
    const wins       = reconciled.filter((o) => o.win === true).length;

    const fillPrices   = fills
      .map((o) => o.fillPriceCents.value ?? null)
      .filter((v): v is number => v !== null);
    const netPnls      = reconciled
      .map((o) => o.netPnlDollars ?? null)
      .filter((v): v is number => v !== null);

    return {
      label,
      minSecs,
      maxSecs: maxSecs === Infinity ? null : maxSecs,
      submissions:       subm.length,
      fills:             fills.length,
      fillRate:          subm.length > 0 ? fills.length / subm.length : null,
      reconciled:        reconciled.length,
      wins,
      losses:            reconciled.length - wins,
      winRate:           reconciled.length > 0 ? wins / reconciled.length : null,
      avgFillPriceCents: avg(fillPrices),
      avgNetPnlDollars:  avg(netPnls),
      sampleWarning:     sampleSizeWarning(reconciled.length),
    };
  });

  // Pending reconciliation
  const pendingFills   = allFills.filter((o) => o.outcomeReconciledAt == null);
  const pendingTickers = [...new Set(pendingFills.map((o) => o.ticker))];

  return {
    period,
    dateRange: { from: fromDate, to: toDate },
    buckets,
    pending: {
      fillsTotal:      allFills.length,
      fillsReconciled: reconciledFills.length,
      fillsPending:    pendingFills.length,
      pendingTickers,
    },
    generatedAt:       new Date().toISOString(),
    currentCutoffSecs: TIME_ALERT_SECONDS,
  };
}

/**
 * Buckets for trigger→fill price-gap analysis.
 * Gap = triggerPriceCents − fillPriceCents. A large positive gap means the
 * price was collapsing through the entry zone between trigger and fill
 * (a "falling knife"). Negative gaps (fill above trigger) land in the
 * first bucket.
 */
export const ENTRY_GAP_BUCKETS = [
  { label: "0–2¢", minGap: -Infinity, maxGap: 2 },
  { label: "3–6¢", minGap: 3,         maxGap: 6 },
  { label: "7¢+",  minGap: 7,         maxGap: Infinity },
] as const;
/**
 * Read-only: compares a ReplayResult summary against today's production
 * DailySummary. Does not mutate any analytics state.
 */
export function getReplayComparisonReport(
  replayResult: ReplayResult,
): ReplayComparisonReport {
  const s = getDailySummary();
  const prod = s.combined;

  const replayFillRate =
    replayResult.summary.windowsEntered > 0
      ? replayResult.summary.tradeCount / replayResult.summary.windowsEntered
      : null;

  const metrics: ReplayComparisonMetric[] = [
    cmpMetric(
      "windows_entered",
      replayResult.summary.windowsEntered,
      prod.windowsEnteringZone,
      true,
    ),
    cmpMetric(
      "fills",
      replayResult.summary.tradeCount,
      prod.successfulFills + prod.partialFills,
      true,
    ),
    cmpMetric(
      "zero_fills",
      replayResult.summary.zeroFillCount,
      prod.zeroFills,
      false,
    ),
    cmpMetric(
      "fill_rate_pct",
      replayFillRate !== null ? replayFillRate * 100 : null,
      prod.fillRateByQualifyingWindow !== null
        ? prod.fillRateByQualifyingWindow * 100
        : null,
      true,
    ),
    cmpMetric(
      "total_spend_dollars",
      replayResult.summary.totalSpentDollars,
      prod.filledNotionalDollars,
      false,
    ),
    cmpMetric("avg_fill_price_cents", null, prod.avgActualFillPriceCents, false),
    cmpMetric(
      "avg_attempts_per_fill",
      null,
      prod.avgAttemptsPerFilledTicker,
      false,
    ),
  ];

  return {
    replayId: replayResult.replayId,
    runAt: replayResult.runAt,
    strategyVersion: replayResult.config.strategyVersion,
    metrics,
    note:
      "Production metrics cover today's Eastern day only. " +
      "Replay metrics cover the provided tick dataset. " +
      "This call is read-only and does not modify any trading or analytics state.",
  };
}

// ── 9. Evidence-grade trade decision report ───────────────────────────────────

/** Conservative threshold before a cohort is allowed to be called evidence-ready. */
export const DECISION_EVIDENCE_MIN_SETTLED = 100;

export interface DecisionEvidenceCohort {
  dimension: "price_band" | "side" | "asset" | "entry_timing" | "skip_reason";
  label: string;
  settled: number;
  pendingOrUnknown: number;
  wins: number;
  losses: number;
  winRate: number | null;
  winRateCi95: { low: number; high: number } | null;
  netPnlDollars: number | null;
  roi: number | null;
  submittedSettled: number;
  skippedSettled: number;
  sampleStatus: "no_data" | "observation" | "preliminary" | "evidence_ready";
  caveat: string;
}

export interface DecisionEvidenceHypothesis {
  label: string;
  cohort: string;
  status: "observation" | "preliminary" | "evidence_ready";
  settled: number;
  pendingOrUnknown: number;
  currentNetPnlDollars: number;
  excludedNetPnlDollars: number;
  retainedNetPnlDollars: number;
  volumeChange: number;
  rationale: string;
}

export interface TradeDecisionEvidenceReport {
  period: string;
  generatedAt: string;
  dataSources: { localDecisionRecords: number; durableDecisionRecords: number; orderRecords: number };
  summary: DecisionEvidenceCohort;
  byPriceBand: DecisionEvidenceCohort[];
  bySide: DecisionEvidenceCohort[];
  byAsset: DecisionEvidenceCohort[];
  byEntryTiming: DecisionEvidenceCohort[];
  bySkipReason: DecisionEvidenceCohort[];
  hypotheses: DecisionEvidenceHypothesis[];
  caveat: string;
  readonly: true;
}

function wilson95(wins: number, total: number): { low: number; high: number } | null {
  if (total === 0) return null;
  const z = 1.96;
  const p = wins / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const spread = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

function decisionSampleStatus(n: number): DecisionEvidenceCohort["sampleStatus"] {
  if (n === 0) return "no_data";
  if (n < 30) return "observation";
  if (n < DECISION_EVIDENCE_MIN_SETTLED) return "preliminary";
  return "evidence_ready";
}

function priceBand(price: number): string {
  if (price < 70) return "<70¢";
  if (price <= 74) return "70–74¢";
  if (price <= 79) return "75–79¢";
  if (price <= 84) return "80–84¢";
  if (price <= 89) return "85–89¢";
  if (price <= 95) return "90–95¢";
  return ">95¢";
}

function decisionTiming(seconds: number): string {
  if (seconds >= 120) return "2:00+ left";
  if (seconds >= 60) return "1:00–2:00 left";
  return "<1:00 left";
}

type EvidenceItem = {
  label: string; settled: boolean; won: boolean; source: "submitted" | "skipped";
  net: number | null; notional: number | null;
};

function buildDecisionCohort(
  dimension: DecisionEvidenceCohort["dimension"],
  label: string,
  items: EvidenceItem[],
): DecisionEvidenceCohort {
  const settled = items.filter((item) => item.settled);
  const wins = settled.filter((item) => item.won).length;
  const submitted = settled.filter((item) => item.source === "submitted");
  const netPnl = submitted.length ? submitted.reduce((sum, item) => sum + (item.net ?? 0), 0) : null;
  const notional = submitted.reduce((sum, item) => sum + (item.notional ?? 0), 0);
  const status = decisionSampleStatus(settled.length);
  return {
    dimension, label, settled: settled.length,
    pendingOrUnknown: items.length - settled.length, wins, losses: settled.length - wins,
    winRate: settled.length ? wins / settled.length : null, winRateCi95: wilson95(wins, settled.length),
    netPnlDollars: netPnl, roi: notional > 0 && netPnl !== null ? netPnl / notional : null,
    submittedSettled: submitted.length,
    skippedSettled: settled.length - submitted.length,
    sampleStatus: status,
    caveat: status === "evidence_ready"
      ? "Meets the count threshold; compare uncertainty and P&L trade-off before any owner-approved strategy review."
      : `Not actionable: ${settled.length}/${DECISION_EVIDENCE_MIN_SETTLED} settled observations.`,
  };
}

/**
 * Read-only cohort analysis. Submitted rows use actual reconciled fill P&L;
 * skipped rows are outcome-only opportunities and never contribute synthetic P&L.
 */
export function getTradeDecisionEvidenceReport(
  orders: OrderAttemptRecord[],
  decisions: PreflightDecision[],
  period: string,
  sourceCounts: { localDecisionRecords: number; durableDecisionRecords: number } = { localDecisionRecords: decisions.length, durableDecisionRecords: 0 },
): TradeDecisionEvidenceReport {
  const submittedFills = orders.filter((o) => o.outcome === "full_fill" || o.outcome === "partial_fill");
  const submittedItems = submittedFills.map((o): Record<"price_band" | "side" | "asset" | "entry_timing", EvidenceItem> => {
    // `win` is written by reconciliation from the market result. Some durable
    // historical records predate the optional marketResult field, so requiring
    // it would mislabel valid, reconciled outcomes as unknown.
    const settled = o.outcomeReconciledAt != null && o.win != null;
    const base = { settled, won: o.win === true, source: "submitted" as const, net: o.netPnlDollars ?? null, notional: o.notionalDollars.value };
    return {
      price_band: { ...base, label: priceBand(o.fillPriceCents.value ?? o.limitPriceCents) },
      side: { ...base, label: o.side.toUpperCase() },
      asset: { ...base, label: o.series.startsWith("KXBTC") ? "BTC" : o.series.startsWith("KXETH") ? "ETH" : "Other" },
      entry_timing: { ...base, label: o.windowCloseTime ? decisionTiming(Math.max(0, (Date.parse(o.windowCloseTime) - o.timestampMs) / 1000)) : "Unknown timing" },
    };
  });
  const skippedItems = decisions.filter((d) => d.decision !== "submit").map((d): Record<"price_band" | "side" | "asset" | "entry_timing" | "skip_reason", EvidenceItem> => {
    const settled = d.marketResult === "yes" || d.marketResult === "no";
    const base = { settled, won: d.marketResult === d.side, source: "skipped" as const, net: null, notional: null };
    return {
      price_band: { ...base, label: priceBand(d.verifiedLimitCents ?? d.bboDerivedLimitCents) },
      side: { ...base, label: d.side.toUpperCase() },
      asset: { ...base, label: d.series.startsWith("KXBTC") ? "BTC" : d.series.startsWith("KXETH") ? "ETH" : "Other" },
      entry_timing: { ...base, label: decisionTiming(d.secondsLeft) },
      skip_reason: { ...base, label: d.decision },
    };
  });
  const dimensions: Array<DecisionEvidenceCohort["dimension"]> = ["price_band", "side", "asset", "entry_timing"];
  const buildRows = (dimension: DecisionEvidenceCohort["dimension"]): DecisionEvidenceCohort[] => {
    const grouped = new Map<string, EvidenceItem[]>();
    for (const item of submittedItems) {
      const row = item[dimension as keyof typeof item];
      if (!grouped.has(row.label)) grouped.set(row.label, []);
      grouped.get(row.label)!.push(row);
    }
    for (const item of skippedItems) {
      const row = item[dimension as keyof typeof item];
      if (!grouped.has(row.label)) grouped.set(row.label, []);
      grouped.get(row.label)!.push(row);
    }
    return [...grouped].map(([label, items]) => buildDecisionCohort(dimension, label, items)).sort((a, b) => b.settled - a.settled || a.label.localeCompare(b.label));
  };
  const rows = Object.fromEntries(dimensions.map((dimension) => [dimension, buildRows(dimension)])) as Record<"price_band" | "side" | "asset" | "entry_timing", DecisionEvidenceCohort[]>;
  const skipRows = (() => {
    const grouped = new Map<string, EvidenceItem[]>();
    for (const item of skippedItems) {
      const row = item.skip_reason;
      if (!grouped.has(row.label)) grouped.set(row.label, []);
      grouped.get(row.label)!.push(row);
    }
    return [...grouped].map(([label, items]) => buildDecisionCohort("skip_reason", label, items)).sort((a, b) => b.settled - a.settled);
  })();
  // The summary is deliberately execution-only: skipped opportunities have a
  // settlement direction but no trade P&L or notional. Mixing them here would
  // turn actual net P&L / ROI into null whenever a skip exists. Skips remain
  // fully visible in every comparison cut and the skip-reason table below.
  const summary = buildDecisionCohort("price_band", "Submitted trades", submittedItems.map((item) => item.price_band));
  const baselineNet = submittedItems.reduce((sum, item) => sum + (item.price_band.net ?? 0), 0);
  const baselineSettled = submittedItems.filter((item) => item.price_band.settled).length;
  const hypotheses: DecisionEvidenceHypothesis[] = rows.price_band.map((cohort): DecisionEvidenceHypothesis => {
    const matching = submittedItems.filter((item) => item.price_band.label === cohort.label);
    const excludedNet = matching.reduce((sum, item) => sum + (item.price_band.net ?? 0), 0);
    const retained = baselineSettled - matching.filter((item) => item.price_band.settled).length;
    const evidenceReady = cohort.sampleStatus === "evidence_ready" && retained >= DECISION_EVIDENCE_MIN_SETTLED &&
      cohort.netPnlDollars !== null && cohort.netPnlDollars < 0;
    return {
      label: `Exclude ${cohort.label} entries`,
      cohort: cohort.label,
      status: evidenceReady ? "evidence_ready" : cohort.sampleStatus === "observation" || cohort.sampleStatus === "no_data" ? "observation" : "preliminary",
      settled: cohort.settled, pendingOrUnknown: cohort.pendingOrUnknown,
      currentNetPnlDollars: baselineNet, excludedNetPnlDollars: excludedNet,
      retainedNetPnlDollars: baselineNet - excludedNet,
      volumeChange: -matching.length,
      rationale: evidenceReady
        ? "Evidence threshold met; this is a review candidate only, not an automatic or approved strategy change."
        : "Watch only — insufficient comparable settled evidence; no parameter change is recommended.",
    };
  }).sort((a, b) => (b.excludedNetPnlDollars - a.excludedNetPnlDollars) || b.settled - a.settled);
  return {
    period, generatedAt: new Date().toISOString(),
    dataSources: { ...sourceCounts, orderRecords: orders.length },
    summary, byPriceBand: rows.price_band, bySide: rows.side, byAsset: rows.asset,
    byEntryTiming: rows.entry_timing, bySkipReason: skipRows, hypotheses,
    caveat: "Read-only evidence report. Only settled outcomes determine win rates and P&L. Skipped opportunities are outcome-only counterfactuals and never receive synthetic P&L.",
    readonly: true,
  };
}

// ── 9b. H-002 research sufficiency / evidence readiness ───────────────────────

export type H002EvidenceStatus = "no_data" | "observation" | "preliminary" | "evidence_ready";

export interface H002EvidenceReadinessReport {
  period: string;
  generatedAt: string;
  status: H002EvidenceStatus;
  counts: {
    decisionRecords: number;
    submittedDecisions: number;
    orderRecords: number;
    matchedSubmittedOrders: number;
    unmatchedSubmittedDecisions: number;
    filledOrders: number;
    reconciledFilledOrders: number;
    pendingFilledOrders: number;
    settledDecisionOutcomes: number;
    pendingDecisionOutcomes: number;
  };
  telemetry: {
    completeDecisions: number;
    missingQuotedBbo: number;
    missingBboAge: number;
    missingExecutableAsk: number;
    missingVerifiedLimit: number;
    missingDepth: number;
    missingL2Latency: number;
  };
  byDecision: Array<{ decision: string; records: number; settledOutcomes: number }>;
  blockingGaps: string[];
  dataSources: { localDecisionRecords: number; durableDecisionRecords: number; orderRecords: number };
  caveat: string;
  readonly: true;
}

/**
 * H-002 is a data-quality report, not a performance recommendation. It records
 * whether the captured decision/order/settlement chain is sufficient to test a
 * hypothesis without inventing outcomes or P&L for skipped decisions.
 */
export function getH002EvidenceReadinessReport(
  orders: OrderAttemptRecord[],
  decisions: PreflightDecision[],
  period: string,
  sourceCounts: { localDecisionRecords: number; durableDecisionRecords: number } = {
    localDecisionRecords: decisions.length,
    durableDecisionRecords: 0,
  },
): H002EvidenceReadinessReport {
  const submitted = decisions.filter((decision) => decision.decision === "submit");
  const orderKeys = new Set(orders.map((order) => `${order.ticker}:${order.side}`));
  const matchedSubmittedOrders = submitted.filter((decision) => orderKeys.has(`${decision.ticker}:${decision.side}`)).length;
  const filled = orders.filter((order) => order.outcome === "full_fill" || order.outcome === "partial_fill");
  const reconciledFilled = filled.filter((order) => order.outcomeReconciledAt != null && order.win != null);
  const settledDecisionOutcomes = decisions.filter((decision) => decision.marketResult === "yes" || decision.marketResult === "no").length;
  const missing = {
    quotedBbo: decisions.filter((decision) => decision.quotedBboAsk == null).length,
    bboAge: decisions.filter((decision) => decision.bboAgeMs == null).length,
    executableAsk: decisions.filter((decision) => decision.executableBestAskCents == null).length,
    verifiedLimit: decisions.filter((decision) => decision.verifiedLimitCents == null).length,
    depth: decisions.filter((decision) => !Number.isFinite(decision.depthAtLimitContracts) || !Number.isFinite(decision.depthAtLimitDollars)).length,
    l2Latency: decisions.filter((decision) => !Number.isFinite(decision.l2FetchLatencyMs)).length,
  };
  const completeDecisions = decisions.filter((decision) =>
    decision.quotedBboAsk != null &&
    decision.bboAgeMs != null &&
    decision.executableBestAskCents != null &&
    decision.verifiedLimitCents != null &&
    Number.isFinite(decision.depthAtLimitContracts) &&
    Number.isFinite(decision.depthAtLimitDollars) &&
    Number.isFinite(decision.l2FetchLatencyMs),
  ).length;
  const blockingGaps: string[] = [];
  if (decisions.length === 0) blockingGaps.push("No preflight decision observations were captured in this period.");
  if (submitted.length > matchedSubmittedOrders) blockingGaps.push(`${submitted.length - matchedSubmittedOrders} submitted decision${submitted.length - matchedSubmittedOrders === 1 ? "" : "s"} cannot be joined to an order record.`);
  if (filled.length > reconciledFilled.length) blockingGaps.push(`${filled.length - reconciledFilled.length} filled order${filled.length - reconciledFilled.length === 1 ? "" : "s"} still lack a reconciled settlement outcome.`);
  if (decisions.length > settledDecisionOutcomes) blockingGaps.push(`${decisions.length - settledDecisionOutcomes} decision observation${decisions.length - settledDecisionOutcomes === 1 ? "" : "s"} still lack a market settlement.`);
  const incompleteTelemetry = decisions.length - completeDecisions;
  if (incompleteTelemetry > 0) blockingGaps.push(`${incompleteTelemetry} decision observation${incompleteTelemetry === 1 ? "" : "s"} have incomplete BBO, L2, depth, or latency telemetry.`);
  if (sourceCounts.durableDecisionRecords === 0 && decisions.length > 0) blockingGaps.push("No durable SQL decision records were available; restart resilience cannot be confirmed from this response.");

  const settledEvidence = reconciledFilled.length + settledDecisionOutcomes;
  const chainComplete =
    submitted.length === matchedSubmittedOrders &&
    filled.length === reconciledFilled.length &&
    decisions.length === settledDecisionOutcomes &&
    completeDecisions === decisions.length;
  const status: H002EvidenceStatus =
    decisions.length === 0 && orders.length === 0 ? "no_data" :
    settledEvidence < 30 ? "observation" :
    settledEvidence < 100 || !chainComplete ? "preliminary" :
    "evidence_ready";
  const byDecision = [...new Set(decisions.map((decision) => decision.decision))]
    .map((decision) => {
      const rows = decisions.filter((row) => row.decision === decision);
      return { decision, records: rows.length, settledOutcomes: rows.filter((row) => row.marketResult === "yes" || row.marketResult === "no").length };
    })
    .sort((a, b) => b.records - a.records || a.decision.localeCompare(b.decision));

  return {
    period,
    generatedAt: new Date().toISOString(),
    status,
    counts: {
      decisionRecords: decisions.length, submittedDecisions: submitted.length, orderRecords: orders.length,
      matchedSubmittedOrders, unmatchedSubmittedDecisions: submitted.length - matchedSubmittedOrders,
      filledOrders: filled.length, reconciledFilledOrders: reconciledFilled.length, pendingFilledOrders: filled.length - reconciledFilled.length,
      settledDecisionOutcomes, pendingDecisionOutcomes: decisions.length - settledDecisionOutcomes,
    },
    telemetry: {
      completeDecisions, missingQuotedBbo: missing.quotedBbo, missingBboAge: missing.bboAge,
      missingExecutableAsk: missing.executableAsk, missingVerifiedLimit: missing.verifiedLimit,
      missingDepth: missing.depth, missingL2Latency: missing.l2Latency,
    },
    byDecision,
    blockingGaps,
    dataSources: { ...sourceCounts, orderRecords: orders.length },
    caveat: "Read-only research sufficiency report. Actual P&L is intentionally excluded: only reconciled filled orders may contribute realized P&L in performance reports, and skipped decisions never receive synthetic P&L.",
    readonly: true,
  };
}

// ── 9b. Conservative condition recommendations (read-only) ────────────────────

export type RecommendationStatus = "observation" | "preliminary" | "actionable";
export type RecommendationKind = "entry_zone_exclusion" | "entry_timing_exclusion" | "asset_exclusion" | "preflight_gate_review";

export interface ConditionRecommendation {
  id: string;
  kind: RecommendationKind;
  status: RecommendationStatus;
  asset: "BTC" | "ETH" | "all";
  currentCondition: string;
  proposedCondition: string;
  reason: string;
  settledSamples: number;
  pendingSamples: number;
  retainedSettledSamples: number;
  volumeChangeTrades: number | null;
  volumeChangePct: number | null;
  estimatedNetPnlImpactDollars: number | null;
  impactBasis: "realized_fill_pnl" | "outcome_only_counterfactual";
  currentNetPnlDollars: number | null;
  proposedNetPnlDollars: number | null;
  winRate: number | null;
  roi: number | null;
  winRateCi95: { low: number; high: number } | null;
  uncertainty: string;
  evidenceUrl: string;
}

export interface ConditionRecommendationsReport {
  period: string;
  asset: "BTC" | "ETH" | "all";
  generatedAt: string;
  recommendations: ConditionRecommendation[];
  excludedCandidates: Array<{ label: string; reason: string }>;
  dataSources: { orderRecords: number; decisionRecords: number };
  caveat: string;
  readonly: true;
}

function recommendationAsset(series: string): "BTC" | "ETH" | "Other" {
  return series.startsWith("KXBTC") ? "BTC" : series.startsWith("KXETH") ? "ETH" : "Other";
}

/**
 * Ranks a deliberately small set of review-only condition candidates.
 * It only uses reconciled submitted fills for estimated P&L. Gate skips retain
 * their useful settlement-direction evidence but cannot manufacture P&L and
 * therefore never become actionable recommendations.
 */
export function getConditionRecommendationsReport(
  allOrders: OrderAttemptRecord[],
  allDecisions: PreflightDecision[],
  period: string,
  asset: "BTC" | "ETH" | "all" = "all",
): ConditionRecommendationsReport {
  const matchesAsset = (series: string) => asset === "all" || recommendationAsset(series) === asset;
  const orders = allOrders.filter((order) => matchesAsset(order.series));
  const decisions = allDecisions.filter((decision) => matchesAsset(decision.series));
  const filled = orders.filter((o) => o.outcome === "full_fill" || o.outcome === "partial_fill");
  // Recommendations estimate *realized P&L*, so a settlement result alone is
  // not sufficient: historical rows missing their net P&L stay visible as
  // incomplete/pending rather than silently becoming $0 observations.
  const reconciled = filled.filter(
    (o) => o.outcomeReconciledAt != null && o.win != null && Number.isFinite(o.netPnlDollars),
  );
  const pending = filled.filter(
    (o) => o.outcomeReconciledAt == null || o.win == null || !Number.isFinite(o.netPnlDollars),
  );
  const baselineNet = reconciled.reduce((sum, o) => sum + o.netPnlDollars!, 0);
  const recommendations: ConditionRecommendation[] = [];
  const excludedCandidates: Array<{ label: string; reason: string }> = [];

  const addExclusion = (
    kind: Exclude<RecommendationKind, "preflight_gate_review">,
    label: string,
    currentCondition: string,
    proposedCondition: string,
    cohort: OrderAttemptRecord[],
    cohortPending: OrderAttemptRecord[],
    evidenceUrl: string,
  ) => {
    const settled = cohort.length;
    const retained = reconciled.length - settled;
    const net = cohort.reduce((sum, o) => sum + o.netPnlDollars!, 0);
    const cohortNotional = cohort.reduce((sum, o) => sum + o.notionalDollars.value, 0);
    const wins = cohort.filter((o) => o.win === true).length;
    const status = settled >= DECISION_EVIDENCE_MIN_SETTLED && retained >= DECISION_EVIDENCE_MIN_SETTLED && net < 0
      ? "actionable"
      : settled >= 30 ? "preliminary" : "observation";
    if (net >= 0) {
      excludedCandidates.push({ label: proposedCondition, reason: "Not ranked: this retained cohort did not have negative realized P&L." });
      return;
    }
    const ci = wilson95(wins, settled);
    recommendations.push({
      id: `${kind}:${label}`, kind, status, asset,
      currentCondition, proposedCondition,
      reason: `This cohort lost ${Math.abs(net).toFixed(2)} in realized net P&L across settled fills; excluding it would reduce volume while retaining the remaining historical cohort.`,
      settledSamples: settled, pendingSamples: cohortPending.length, retainedSettledSamples: retained,
      volumeChangeTrades: -settled, volumeChangePct: reconciled.length ? -settled / reconciled.length : null,
      estimatedNetPnlImpactDollars: -net, impactBasis: "realized_fill_pnl",
      currentNetPnlDollars: baselineNet, proposedNetPnlDollars: baselineNet - net,
      winRate: settled ? wins / settled : null,
      roi: cohortNotional > 0 ? net / cohortNotional : null,
      winRateCi95: ci,
      uncertainty: status === "actionable"
        ? "Count threshold is met, but this remains a historical estimate and requires owner review."
        : `${settled}/${DECISION_EVIDENCE_MIN_SETTLED} comparable settled fills; not actionable.`,
      evidenceUrl,
    });
  };

  for (const label of ["70–74¢", "75–79¢", "80–84¢", "85–89¢", "90–95¢"]) {
    const cohort = reconciled.filter((o) => priceBand(o.fillPriceCents.value ?? o.limitPriceCents) === label);
    const cohortPending = pending.filter((o) => priceBand(o.fillPriceCents.value ?? o.limitPriceCents) === label);
    addExclusion("entry_zone_exclusion", label, `Allow ${label} entry-price cohort`, `Exclude ${label} entry-price cohort`, cohort, cohortPending, "decision-evidence");
  }
  for (const label of ["2:00+ left", "1:00–2:00 left", "<1:00 left"]) {
    const cohort = reconciled.filter((o) => {
      const seconds = o.windowCloseTime ? Math.max(0, (Date.parse(o.windowCloseTime) - o.timestampMs) / 1000) : -1;
      return seconds >= 0 && decisionTiming(seconds) === label;
    });
    const cohortPending = pending.filter((o) => {
      const seconds = o.windowCloseTime ? Math.max(0, (Date.parse(o.windowCloseTime) - o.timestampMs) / 1000) : -1;
      return seconds >= 0 && decisionTiming(seconds) === label;
    });
    addExclusion("entry_timing_exclusion", label, `Allow entries ${label}`, `Exclude entries ${label}`, cohort, cohortPending, "decision-evidence");
  }
  if (asset === "all") {
    for (const candidateAsset of ["BTC", "ETH"] as const) {
      const cohort = reconciled.filter((o) => recommendationAsset(o.series) === candidateAsset);
      const cohortPending = pending.filter((o) => recommendationAsset(o.series) === candidateAsset);
      addExclusion("asset_exclusion", candidateAsset, `Trade ${candidateAsset} entries`, `Exclude ${candidateAsset} entries`, cohort, cohortPending, "decision-evidence");
    }
  }

  const skipsByReason = new Map<string, PreflightDecision[]>();
  for (const decision of decisions.filter((d) => d.decision !== "submit")) {
    const current = skipsByReason.get(decision.decision) ?? [];
    current.push(decision);
    skipsByReason.set(decision.decision, current);
  }
  for (const [reason, rows] of skipsByReason) {
    const settled = rows.filter((d) => d.marketResult === "yes" || d.marketResult === "no");
    const wins = settled.filter((d) => d.marketResult === d.side).length;
    if (!settled.length) continue;
    recommendations.push({
      id: `gate:${reason}`, kind: "preflight_gate_review",
      status: settled.length >= DECISION_EVIDENCE_MIN_SETTLED ? "preliminary" : "observation",
      asset, currentCondition: `Block when ${reason}`, proposedCondition: `Review ${reason} threshold with owner`,
      reason: `${wins}/${settled.length} skipped directions matched the eventual market result. This is outcome-only calibration evidence, not realized P&L.`,
      settledSamples: settled.length, pendingSamples: rows.length - settled.length, retainedSettledSamples: reconciled.length,
      volumeChangeTrades: null, volumeChangePct: null,
      estimatedNetPnlImpactDollars: null, impactBasis: "outcome_only_counterfactual",
      currentNetPnlDollars: baselineNet, proposedNetPnlDollars: null,
      winRate: wins / settled.length, roi: null, winRateCi95: wilson95(wins, settled.length),
      uncertainty: "No P&L is estimated because skipped decisions never created fills. A gate review cannot be actionable from direction-only evidence.",
      evidenceUrl: "decision-evidence",
    });
  }
  recommendations.sort((a, b) =>
    (Number(b.status === "actionable") - Number(a.status === "actionable")) ||
    ((b.estimatedNetPnlImpactDollars ?? -Infinity) - (a.estimatedNetPnlImpactDollars ?? -Infinity)) ||
    b.settledSamples - a.settledSamples,
  );
  return {
    period, asset, generatedAt: new Date().toISOString(), recommendations, excludedCandidates,
    dataSources: { orderRecords: orders.length, decisionRecords: decisions.length },
    caveat: "Read-only recommendations use reconciled fills for estimated P&L. Pending fills remain separate; skipped decisions are never assigned hypothetical P&L. Nothing here can apply or enable a live strategy change.",
    readonly: true,
  };
}

export interface PreflightCalibrationBucket {
  skipReason: string;
  total: number;
  saved: number;
  cost: number;
  unknown: number;
  /** saved / (saved + cost); null when no settled data in this bucket. */
  saveRate: number | null;
  /** Average L2-to-BBO gap in ¢ at skip time; null if field absent. */
  avgBboToL2GapCents: number | null;
  /** Average executable best ask in ¢ at skip time; null if field absent. */
  avgExecAskCents: number | null;
}

/** Return the YYYY-MM-DD string for a date N days before today (Eastern). */
function dateNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  // Approximate Eastern (EDT = UTC-4, EST = UTC-5)
  const month = d.getUTCMonth();
  const offsetH = month >= 2 && month <= 10 ? -4 : -5;
  const eastern = new Date(d.getTime() + offsetH * 3_600_000);
  return eastern.toISOString().slice(0, 10);
}

export interface PreflightCalibrationSeriesBucket {
  series: string;
  total: number;
  saved: number;
  cost: number;
  unknown: number;
  saveRate: number | null;
}

export interface PreflightCalibrationReport {
  generatedAt: string;
  daysAnalyzed: number;
  totalDecisions: number;
  totalSubmitted: number;
  totalSkipped: number;
  settledSkips: number;
  overallSaveRate: number | null;
  byReason: PreflightCalibrationBucket[];
  bySeries: PreflightCalibrationSeriesBucket[];
  constants: {
    MAX_BBO_L2_GAP_CENTS: number;
    MAX_BBO_L2_NEGATIVE_GAP_CENTS: number;
    ALERT_MIN: number;
    ALERT_MAX: number;
  };
  tuningNotes: string[];
  sampleWarning: string | null;
}

function buildCalibrationBucket(
  skipReason: string,
  saved: number,
  cost: number,
  unknown: number,
  gaps: number[],
  execAsks: number[],
): PreflightCalibrationBucket {
  const settled = saved + cost;
  return {
    skipReason,
    total: settled + unknown,
    saved,
    cost,
    unknown,
    saveRate: settled > 0 ? saved / settled : null,
    avgBboToL2GapCents: gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    avgExecAskCents: execAsks.length > 0 ? execAsks.reduce((a, b) => a + b, 0) / execAsks.length : null,
  };
}

/** Read the on-disk market-result cache and return a ticker → result map. */
function loadMarketResultCache(): Map<string, string> {
  const CACHE_PATH = join(process.cwd(), "data", "market-result-cache.json");
  try {
    const raw = readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed && typeof parsed === "object") {
      return new Map(Object.entries(parsed));
    }
  } catch {
    /* cache absent or unreadable — return empty map */
  }
  return new Map();
}

/** Discover available NDJSON date strings by scanning the analytics directory. */
function availablePreflightDates(): string[] {
  const DATA_DIR = join(process.cwd(), "data", "analytics");
  try {
    return readdirSync(DATA_DIR)
      .filter((f) => f.startsWith("preflight-decisions-") && f.endsWith(".ndjson"))
      .map((f) => f.replace("preflight-decisions-", "").replace(".ndjson", ""))
      .sort();
  } catch {
    return [];
  }
}

export function getPreflightCalibrationReport(days = 7): PreflightCalibrationReport {
  // 1. Determine which dates to load
  const allDates = availablePreflightDates();
  let targetDates: string[];
  if (days === 0) {
    targetDates = allDates;
  } else {
    const cutoff = dateNDaysAgo(days - 1);
    targetDates = allDates.filter((d) => d >= cutoff);
  }

  // 2. Load all decisions
  const allDecisions = targetDates.flatMap((date) => loadPreflightDecisions(date));

  // 3. Load market results
  const marketResults = loadMarketResultCache();

  // 4. Partition into submitted vs skipped
  const submitted = allDecisions.filter((d) => d.decision === "submit");
  const skipped   = allDecisions.filter((d) => d.decision !== "submit");

  // 5. Per-reason accumulators
  const reasonSaved:   Map<string, number>   = new Map();
  const reasonCost:    Map<string, number>   = new Map();
  const reasonUnknown: Map<string, number>   = new Map();
  const reasonGaps:    Map<string, number[]> = new Map();
  const reasonExec:    Map<string, number[]> = new Map();

  // Per-series accumulators
  const seriesSaved:   Map<string, number> = new Map();
  const seriesCost:    Map<string, number> = new Map();
  const seriesUnknown: Map<string, number> = new Map();

  let totalSaved = 0;
  let totalCost  = 0;

  for (const d of skipped) {
    const reason = d.decision;
    if (!reasonSaved.has(reason))   reasonSaved.set(reason, 0);
    if (!reasonCost.has(reason))    reasonCost.set(reason, 0);
    if (!reasonUnknown.has(reason)) reasonUnknown.set(reason, 0);
    if (!reasonGaps.has(reason))    reasonGaps.set(reason, []);
    if (!reasonExec.has(reason))    reasonExec.set(reason, []);

    if (!seriesSaved.has(d.series))   seriesSaved.set(d.series, 0);
    if (!seriesCost.has(d.series))    seriesCost.set(d.series, 0);
    if (!seriesUnknown.has(d.series)) seriesUnknown.set(d.series, 0);

    const marketResult = marketResults.get(d.ticker);

    if (d.bboToL2GapCents != null) {
      reasonGaps.get(reason)!.push(d.bboToL2GapCents);
    }
    if (d.executableBestAskCents != null) {
      reasonExec.get(reason)!.push(d.executableBestAskCents);
    }

    if (marketResult == null) {
      reasonUnknown.set(reason, reasonUnknown.get(reason)! + 1);
      seriesUnknown.set(d.series, seriesUnknown.get(d.series)! + 1);
    } else if (marketResult !== d.side) {
      // Market resolved opposite to our intended side → filter saved us
      reasonSaved.set(reason, reasonSaved.get(reason)! + 1);
      seriesSaved.set(d.series, seriesSaved.get(d.series)! + 1);
      totalSaved++;
    } else {
      // Market resolved for our side → filter cost us a win
      reasonCost.set(reason, reasonCost.get(reason)! + 1);
      seriesCost.set(d.series, seriesCost.get(d.series)! + 1);
      totalCost++;
    }
  }

  // 6. Build byReason buckets (sorted by total desc)
  const allReasons = new Set([
    ...reasonSaved.keys(),
    ...reasonCost.keys(),
    ...reasonUnknown.keys(),
  ]);
  const byReason: PreflightCalibrationBucket[] = [...allReasons]
    .map((r) => buildCalibrationBucket(
      r,
      reasonSaved.get(r) ?? 0,
      reasonCost.get(r)  ?? 0,
      reasonUnknown.get(r) ?? 0,
      reasonGaps.get(r) ?? [],
      reasonExec.get(r) ?? [],
    ))
    .sort((a, b) => b.total - a.total);

  // 7. Build bySeries buckets
  const allSeries = new Set([
    ...seriesSaved.keys(),
    ...seriesCost.keys(),
    ...seriesUnknown.keys(),
  ]);
  const bySeries: PreflightCalibrationSeriesBucket[] = [...allSeries]
    .map((s) => {
      const sv  = seriesSaved.get(s)   ?? 0;
      const co  = seriesCost.get(s)    ?? 0;
      const unk = seriesUnknown.get(s) ?? 0;
      const settled = sv + co;
      return {
        series: s,
        total: settled + unk,
        saved: sv,
        cost: co,
        unknown: unk,
        saveRate: settled > 0 ? sv / settled : null,
      };
    })
    .sort((a, b) => b.total - a.total);

  // 8. Tuning notes
  const tuningNotes: string[] = [];
  const settledSkips = totalSaved + totalCost;
  const overallSaveRate = settledSkips > 0 ? totalSaved / settledSkips : null;

  if (overallSaveRate !== null) {
    if (overallSaveRate < 0.35) {
      tuningNotes.push(
        `Overall save rate is ${(overallSaveRate * 100).toFixed(0)}% — filter is blocking more winning trades than losing ones. ` +
        `Consider relaxing thresholds.`,
      );
    } else if (overallSaveRate > 0.65) {
      tuningNotes.push(
        `Overall save rate is ${(overallSaveRate * 100).toFixed(0)}% — filter is correctly blocking bad fills. Thresholds appear well-calibrated.`,
      );
    } else {
      tuningNotes.push(
        `Overall save rate is ${(overallSaveRate * 100).toFixed(0)}% — marginal. Review per-reason breakdown for tuning opportunities.`,
      );
    }
  }

  // skip_stale_bbo_gap specific note
  const gapBucket = byReason.find((b) => b.skipReason === "skip_stale_bbo_gap");
  if (gapBucket && gapBucket.saveRate !== null) {
    const avgGap = gapBucket.avgBboToL2GapCents;
    if (gapBucket.saveRate < 0.35 && avgGap !== null) {
      tuningNotes.push(
        `skip_stale_bbo_gap save rate is ${(gapBucket.saveRate * 100).toFixed(0)}% ` +
        `(avg gap ${avgGap.toFixed(1)}¢). MAX_BBO_L2_GAP_CENTS=${MAX_BBO_L2_GAP_CENTS}¢ ` +
        `may be too tight — consider raising to 3–4¢.`,
      );
    } else if (gapBucket.saveRate > 0.6 && avgGap !== null) {
      tuningNotes.push(
        `skip_stale_bbo_gap save rate is ${(gapBucket.saveRate * 100).toFixed(0)}% ` +
        `(avg gap ${avgGap.toFixed(1)}¢). Current MAX_BBO_L2_GAP_CENTS=${MAX_BBO_L2_GAP_CENTS}¢ appears effective.`,
      );
    }
  }

  const depthBucket = byReason.find((b) => b.skipReason === "skip_zero_depth");
  if (depthBucket && depthBucket.saveRate !== null && depthBucket.saveRate < 0.35) {
    tuningNotes.push(
      `skip_zero_depth save rate is ${(depthBucket.saveRate * 100).toFixed(0)}% — ` +
      `markets with empty books are resolving in our favour. ` +
      `These may be thin but not adversarial; depth threshold may be over-filtering.`,
    );
  }

  // 9. Sample size warning
  let sampleWarning: string | null = null;
  if (settledSkips === 0) {
    sampleWarning = "No settled market outcomes yet — save rate cannot be computed. Check back after markets close.";
  } else if (settledSkips < 20) {
    sampleWarning = `Only ${settledSkips} settled skip${settledSkips === 1 ? "" : "s"} — results are preliminary. Interpret save rates with caution.`;
  }

  return {
    generatedAt: new Date().toISOString(),
    daysAnalyzed: targetDates.length,
    totalDecisions: allDecisions.length,
    totalSubmitted: submitted.length,
    totalSkipped: skipped.length,
    settledSkips,
    overallSaveRate,
    byReason,
    bySeries,
    constants: {
      MAX_BBO_L2_GAP_CENTS,
      MAX_BBO_L2_NEGATIVE_GAP_CENTS,
      ALERT_MIN,
      ALERT_MAX,
    },
    tuningNotes,
    sampleWarning,
  };
}

export interface EntryGapBucket {
  label:            string;
  minGap:           number | null; // null = no lower bound
  maxGap:           number | null; // null = no upper bound
  fills:            number;
  reconciled:       number;
  wins:             number;
  losses:           number;
  winRate:          number | null;
  avgGapCents:      number | null;
  avgNetPnlDollars: number | null;
  sampleWarning:    SampleSizeWarning;
}

/** Gap at or above this is flagged as a falling knife. */
export const FALLING_KNIFE_GAP_CENTS = 7;

export interface EntryGapTrade {
  id:                string;
  timestampMs:       number;
  ticker:            string;
  series:            string;
  side:              string;
  triggerPriceCents: number;
  fillPriceCents:    number;
  gapCents:          number;
  fallingKnife:      boolean;
  win:               boolean | null;
  netPnlDollars:     number | null;
  /** 'limit_fallback' when fill price came from the order limit (reconciliation permanently failed). */
  fillPriceSource:   string | null;
  /** true when the fill price is estimated — reconcile_failed=true OR fill_price_source='limit_fallback'. */
  estimatedFillPrice: boolean;
  /** Reverse-to-NO simulation fields (only present for YES-side falling-knife entries). */
  simNoEntryPriceCents: number | null;
  simNoPnlDollars:      number | null;
  simNoWin:             boolean | null;
}

/**
 * Aggregate results for the stop-and-reverse-to-NO simulation.
 * Only covers outcome-reconciled YES-side falling-knife entries.
 */
export interface ReverseSimResult {
  /** Number of outcome-reconciled YES-side falling-knife fills included. */
  count:                    number;
  /** Avg YES entry price across the included fills (cents). */
  avgYesEntryPriceCents:    number | null;
  /** Avg estimated NO entry price (= 100 − yesEntry) across the fills (cents). */
  avgNoEntryPriceCents:     number | null;
  /** Actual YES-side outcome metrics. */
  actualWins:               number;
  actualLosses:             number;
  actualWinRate:            number | null;
  actualTotalPnlDollars:    number | null;
  actualAvgPnlDollars:      number | null;
  /** Simulated NO-side outcome metrics (net P&L — estimated fee from the actual YES fill deducted). */
  simWins:                  number;
  simLosses:                number;
  simWinRate:               number | null;
  simTotalPnlDollars:       number | null;
  simAvgPnlDollars:         number | null;
  /**
   * Simulated avg P&L minus actual avg P&L.
   * Positive = NO entry would have outperformed YES in these windows.
   */
  deltaAvgPnlDollars:       number | null;
  sampleWarning:            SampleSizeWarning;
}

/**
 * Build a trigger→fill gap ("falling knife") report over the supplied orders.
 * Read-only analysis; only filled orders with a known fill price contribute.
 * Win/loss figures use only outcome-reconciled fills.
 *
 * @param reverseSimMinGapCents - Minimum gap (¢) to qualify a YES fill for the
 *   reverse-to-NO simulation. Defaults to FALLING_KNIFE_GAP_CENTS (7¢).
 *   Callers can pass 5 or 10 to compare thresholds.
 */
export function getEntryGapReport(
  orders:   OrderAttemptRecord[],
  period:   string,
  fromDate: string,
  toDate:   string,
  maxTrades = 100,
  reverseSimMinGapCents = FALLING_KNIFE_GAP_CENTS,
): EntryGapReport {
  const allFills = orders.filter(
    (o) => o.outcome === "full_fill" || o.outcome === "partial_fill",
  );

  function gapOf(o: OrderAttemptRecord): number | null {
    const fill = o.fillPriceCents.value ?? null;
    if (fill === null || o.triggerPriceCents == null) return null;
    return o.triggerPriceCents - fill;
  }

  const withGap        = allFills.filter((o) => gapOf(o) !== null);
  const reconciledGaps = withGap.filter((o) => o.outcomeReconciledAt != null);

  const buckets: EntryGapBucket[] = ENTRY_GAP_BUCKETS.map(({ label, minGap, maxGap }) => {
    const inBucket = (o: OrderAttemptRecord) => {
      const g = gapOf(o)!;
      return (minGap === -Infinity || g >= minGap) &&
             (maxGap === Infinity  || g <= maxGap);
    };

    const fills      = withGap.filter(inBucket);
    const reconciled = reconciledGaps.filter(inBucket);
    const wins       = reconciled.filter((o) => o.win === true).length;
    const netPnls    = reconciled
      .map((o) => o.netPnlDollars ?? null)
      .filter((v): v is number => v !== null);

    return {
      label,
      minGap: minGap === -Infinity ? null : minGap,
      maxGap: maxGap === Infinity  ? null : maxGap,
      fills:            fills.length,
      reconciled:       reconciled.length,
      wins,
      losses:           reconciled.length - wins,
      winRate:          reconciled.length > 0 ? wins / reconciled.length : null,
      avgGapCents:      avg(fills.map((o) => gapOf(o)!)),
      avgNetPnlDollars: avg(netPnls),
      sampleWarning:    sampleSizeWarning(reconciled.length),
    };
  });

  // ── Reverse-to-NO simulation ──────────────────────────────────────────────
  // For every falling-knife YES-side fill that has been outcome-reconciled,
  // estimate what buying NO at the complement price would have returned.
  //   NO entry price = 100 − YES fill price (¢)
  //   If YES won  → NO loses  → simGross = −(noPrice/100) × contracts
  //   If YES lost → NO wins   → simGross = (1 − noPrice/100) × contracts
  // Apply the same fee paid on the actual YES fill as the estimated NO fee
  // (same contract count, same fee structure) so sim P&L is net, matching the
  // actual YES netPnlDollars used on the other side of the comparison.

  function buildReverseSim(minGapCents: number) {
    const knivesYes = reconciledGaps.filter(
      (o) => gapOf(o)! >= minGapCents && o.side === "yes",
    );

    const entries = knivesYes
      .filter((o) =>
        o.win !== null &&
        o.win !== undefined &&
        typeof o.fillPriceCents?.value === "number" &&
        typeof o.contracts?.value === "number" &&
        o.contracts.value > 0,
      )
      .map((o) => {
        const fillCents    = o.fillPriceCents.value as number;
        const noEntryCents = 100 - fillCents;
        const contracts    = o.contracts.value as number;
        const simWin       = o.win === false; // NO wins when YES loses
        const simGross     = simWin
          ? (1 - noEntryCents / 100) * contracts
          : -(noEntryCents / 100) * contracts;
        // Deduct the same fee paid on the actual YES fill as an estimated NO fee
        // (identical contract count → same fee structure).
        const estimatedFee = o.feeDollars?.value ?? 0;
        const simNet       = simGross - estimatedFee;
        return { o, noEntryCents, simWin, simGross, simNet };
      });

    const simCount        = entries.length;
    const simWins         = entries.filter((e) => e.simWin).length;
    const simLosses       = simCount - simWins;
    const simTotal        = simCount > 0 ? entries.reduce((s, e) => s + e.simNet, 0) : null;
    const simAvg          = simCount > 0 ? simTotal! / simCount : null;

    const actualPnls      = entries
      .map((e) => e.o.netPnlDollars ?? null)
      .filter((v): v is number => v !== null);
    const actualWins_rs   = entries.filter((e) => e.o.win === true).length;
    const actualLosses_rs = simCount - actualWins_rs;
    const actualTotal     = actualPnls.length > 0 ? actualPnls.reduce((s, v) => s + v, 0) : null;
    const actualAvg       = actualPnls.length > 0 ? actualTotal! / actualPnls.length : null;

    const result: ReverseSimResult = {
      count:                 simCount,
      avgYesEntryPriceCents: avg(entries.map((e) => e.o.fillPriceCents.value!)),
      avgNoEntryPriceCents:  avg(entries.map((e) => e.noEntryCents)),
      actualWins:            actualWins_rs,
      actualLosses:          actualLosses_rs,
      actualWinRate:         simCount > 0 ? actualWins_rs / simCount : null,
      actualTotalPnlDollars: actualTotal,
      actualAvgPnlDollars:   actualAvg,
      simWins,
      simLosses,
      simWinRate:            simCount > 0 ? simWins / simCount : null,
      simTotalPnlDollars:    simTotal,
      simAvgPnlDollars:      simAvg,
      deltaAvgPnlDollars:
        simAvg !== null && actualAvg !== null ? simAvg - actualAvg : null,
      sampleWarning:         sampleSizeWarning(simCount),
    };

    return { result, entries };
  }

  const { result: reverseSim, entries: simEntries } = buildReverseSim(reverseSimMinGapCents);

  // Build a lookup for per-trade sim fields
  const simByOrderId = new Map(
    simEntries.map((e) => [e.o.id, e]),
  );

  const trades: EntryGapTrade[] = withGap
    .slice()
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, maxTrades)
    .map((o) => {
      const gap   = gapOf(o)!;
      const entry = simByOrderId.get(o.id);
      return {
        id:                   o.id,
        timestampMs:          o.timestampMs,
        ticker:               o.ticker,
        series:               o.series,
        side:                 o.side,
        triggerPriceCents:    o.triggerPriceCents,
        fillPriceCents:       o.fillPriceCents.value!,
        gapCents:             gap,
        fallingKnife:         gap >= FALLING_KNIFE_GAP_CENTS,
        win:                  o.win ?? null,
        netPnlDollars:        o.netPnlDollars ?? null,
        fillPriceSource:      o.fill_price_source ?? null,
        estimatedFillPrice:   o.reconcile_failed === true || o.fill_price_source === "limit_fallback",
        simNoEntryPriceCents: entry?.noEntryCents ?? null,
        simNoPnlDollars:      entry?.simNet       ?? null,
        simNoWin:             entry?.simWin        ?? null,
      };
    });

  const pendingFills   = allFills.filter((o) => o.outcomeReconciledAt == null);
  const pendingTickers = [...new Set(pendingFills.map((o) => o.ticker))];

  return {
    period,
    dateRange: { from: fromDate, to: toDate },
    buckets,
    trades,
    excludedMissingPrice: allFills.length - withGap.length,
    fallingKnifeGapCents: FALLING_KNIFE_GAP_CENTS,
    reverseSimMinGapCents,
    pending: {
      fillsTotal:      allFills.length,
      fillsReconciled: reconciledGaps.length,
      fillsPending:    pendingFills.length,
      pendingTickers,
    },
    reverseSim,
    reverseSimAll: {
      '5':  buildReverseSim(5).result,
      '7':  buildReverseSim(7).result,
      '10': buildReverseSim(10).result,
    },
    generatedAt: new Date().toISOString(),
  };
}

export interface EntryGapReport {
  period:               string;
  dateRange:            { from: string; to: string };
  buckets:              EntryGapBucket[];
  /** Filled trades with a known trigger→fill gap, newest first (capped). */
  trades:               EntryGapTrade[];
  /** Fills excluded because trigger or fill price is unknown. */
  excludedMissingPrice: number;
  /** Default falling-knife threshold used for the per-trade KNIFE badge. */
  fallingKnifeGapCents: number;
  /**
   * Minimum gap used for the reverse-to-NO simulation (may differ from
   * fallingKnifeGapCents when caller requests a tighter/wider threshold).
   */
  reverseSimMinGapCents: number;
  pending:              PendingReconciliation;
  /**
   * Stop-and-reverse simulation: what if we had bought NO instead of YES on
   * every falling-knife window (gap ≥ reverseSimMinGapCents)?
   */
  reverseSim:           ReverseSimResult;
  /**
   * Reverse-to-NO simulation results for all three standard thresholds
   * (5¢, 7¢, 10¢) so the caller can display a side-by-side comparison.
   */
  reverseSimAll:        { '5': ReverseSimResult; '7': ReverseSimResult; '10': ReverseSimResult };
  generatedAt:          string;
}

// ── 10. Window Sensitivity Report ─────────────────────────────────────────────

/**
 * Compares in-zone preflight-decision counts for the OLD 2:30 window (< 150 s)
 * vs the NEW 3:00 window (< 180 s). The "new band" is the 30-second slice
 * [150 s, 180 s) that the recent cutoff extension unlocked.
 *
 * Source: preflight-decisions NDJSON files (+ SQL). Only evaluations where
 * bboDerivedLimitCents falls within [ALERT_MIN, ALERT_MAX] are counted — those
 * are the ticks that would actually trigger an entry attempt.
 */
export interface WindowSensitivityBand {
  label:           string;
  minSecs:         number;
  maxSecs:         number;
  inZoneDecisions: number;   // preflight evals in-zone in this time slice
  submits:         number;   // gate said "submit" (order was placed)
  settled:         number;   // submitted decisions with a known market result
  wins:            number;   // market resolved in our favour
  losses:          number;
  winRate:         number | null;
}

export interface WindowSensitivityBySeries {
  series:            string;
  newBandDecisions:  number;
  newBandSubmits:    number;
}

export interface WindowSensitivityByHour {
  easternHour:      number;
  newBandDecisions: number;
  newBandSubmits:   number;
}

export interface WindowSensitivityReport {
  generatedAt:           string;
  daysAnalyzed:          number;
  oldCutoffSecs:         number;   // 120 — the previous window
  newCutoffSecs:         number;   // 180 — current TIME_ALERT_SECONDS
  zoneMinCents:          number;
  zoneMaxCents:          number;
  /** Comparison rows: old-window slice and new-band slice. */
  bands:                 WindowSensitivityBand[];
  bySeries:              WindowSensitivityBySeries[];
  byHour:                WindowSensitivityByHour[];
  totalNewBandDecisions: number;
  totalNewBandSubmits:   number;
  sampleWarning:         string | null;
}

const OLD_CUTOFF_SECS = 150;

export function getWindowSensitivityReport(days = 7): WindowSensitivityReport {
  // 1. Determine which dates to load
  const allDates = availablePreflightDates();
  let targetDates: string[];
  if (days === 0) {
    targetDates = allDates;
  } else {
    const cutoff = dateNDaysAgo(days - 1);
    targetDates = allDates.filter((d) => d >= cutoff);
  }

  // 2. Load all decisions and the market-result cache
  const allDecisions  = targetDates.flatMap((date) => loadPreflightDecisions(date));
  const marketResults = loadMarketResultCache();

  // 3. Filter to in-zone ticks only
  const inZone = allDecisions.filter(
    (d) => d.bboDerivedLimitCents >= ALERT_MIN && d.bboDerivedLimitCents <= ALERT_MAX,
  );

  // 4. Helper: build one band
  function buildBand(label: string, minSecs: number, maxSecs: number): WindowSensitivityBand {
    const slice = inZone.filter(
      (d) => d.secondsLeft >= minSecs && d.secondsLeft < maxSecs,
    );
    const submits = slice.filter((d) => d.decision === "submit");
    let wins = 0, losses = 0;
    for (const d of submits) {
      const r = marketResults.get(d.ticker);
      if (r == null) continue;
      if (r === d.side) wins++; else losses++;
    }
    const settled = wins + losses;
    return {
      label,
      minSecs,
      maxSecs,
      inZoneDecisions: slice.length,
      submits:         submits.length,
      settled,
      wins,
      losses,
      winRate:         settled > 0 ? wins / settled : null,
    };
  }

  // 5. Two comparison bands
  const newCutoff = TIME_ALERT_SECONDS;
  const bands: WindowSensitivityBand[] = [
    buildBand(`< ${OLD_CUTOFF_SECS / 60}:${String(OLD_CUTOFF_SECS % 60).padStart(2, "0")} left (old window)`, 0, OLD_CUTOFF_SECS),
    buildBand(`${OLD_CUTOFF_SECS / 60}:00–${Math.floor(newCutoff / 60)}:${String(newCutoff % 60).padStart(2, "0")} left (new band)`, OLD_CUTOFF_SECS, newCutoff),
  ];

  // 6. By series — new-band slice only
  const newBandSlice = inZone.filter(
    (d) => d.secondsLeft >= OLD_CUTOFF_SECS && d.secondsLeft < newCutoff,
  );
  const seriesMap = new Map<string, { decisions: number; submits: number }>();
  for (const d of newBandSlice) {
    if (!seriesMap.has(d.series)) seriesMap.set(d.series, { decisions: 0, submits: 0 });
    const s = seriesMap.get(d.series)!;
    s.decisions++;
    if (d.decision === "submit") s.submits++;
  }
  const bySeries: WindowSensitivityBySeries[] = [...seriesMap.entries()]
    .sort((a, b) => b[1].decisions - a[1].decisions)
    .map(([series, { decisions, submits }]) => ({
      series,
      newBandDecisions: decisions,
      newBandSubmits:   submits,
    }));

  // 7. By Eastern hour — new-band slice only
  const hourMap = new Map<number, { decisions: number; submits: number }>();
  for (const d of newBandSlice) {
    const h = easternHour(d.timestampMs);
    if (!hourMap.has(h)) hourMap.set(h, { decisions: 0, submits: 0 });
    const s = hourMap.get(h)!;
    s.decisions++;
    if (d.decision === "submit") s.submits++;
  }
  const byHour: WindowSensitivityByHour[] = [...hourMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([easternHour, { decisions, submits }]) => ({
      easternHour,
      newBandDecisions: decisions,
      newBandSubmits:   submits,
    }));

  // 8. Sample-size warning
  let sampleWarning: string | null = null;
  if (allDecisions.length === 0) {
    sampleWarning = "No preflight decision files found. Decisions are recorded from the server — check back after the next trading session.";
  } else if (newBandSlice.length === 0) {
    sampleWarning = "No in-zone ticks found in the new 2:30–3:00 band yet. This is normal if the server has only been running the new cutoff for a short time.";
  }

  return {
    generatedAt:           new Date().toISOString(),
    daysAnalyzed:          targetDates.length,
    oldCutoffSecs:         OLD_CUTOFF_SECS,
    newCutoffSecs:         newCutoff,
    zoneMinCents:          ALERT_MIN,
    zoneMaxCents:          ALERT_MAX,
    bands,
    bySeries,
    byHour,
    totalNewBandDecisions: newBandSlice.length,
    totalNewBandSubmits:   newBandSlice.filter((d) => d.decision === "submit").length,
    sampleWarning,
  };
}

const _WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function etHourAndDow(ms: number): { hour: number; dow: number } {
  let hour = 0;
  let dow = 0;
  for (const p of _etParts.formatToParts(ms)) {
    if (p.type === "hour") hour = Number(p.value) % 24; // "24" → 0 at midnight
    else if (p.type === "weekday") dow = _WEEKDAY_INDEX[p.value] ?? 0;
  }
  return { hour, dow };
}
