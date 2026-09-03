/**
 * Analytics persistence layer.
 *
 * Handles all disk I/O for analytics data, completely separate from trading-
 * state storage (daily-budget.json, order-dedup.json).
 *
 * Layout:
 *   data/analytics/orders-YYYY-MM-DD.ndjson   — one JSON line per OrderAttemptRecord (final state)
 *   data/analytics/daily-YYYY-MM-DD.json      — daily summary snapshot (atomic write, periodic)
 *
 * Design:
 *  - Records are written once when they reach final state (zero_fill or fill).
 *  - NDJSON appends are non-blocking (setImmediate).
 *  - JSON summary writes use write-to-tmp-then-rename (atomic on same filesystem).
 *  - Startup hydration reads today's NDJSON and calls hydrateOrderAttempt() on
 *    each valid line; malformed lines are skipped without crashing.
 *  - All I/O is wrapped in try/catch. Failures are logged and never thrown.
 *  - Never touches data/daily-budget.json or data/order-dedup.json.
 */

import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { easternDay } from "./dailyBudget.js";
import { logger } from "./logger.js";
import {
  hydrateOrderAttempt,
  hydrateGuardCounts,
  setRecordUpdateHook,
  setStoreHook,
  getGuardCounts,
  getDailySummary,
  getOrderAttemptById,
  type OrderAttemptRecord,
} from "./analytics.js";
import { parseOrderRecord } from "./recordParser.js";
import {
  loadOrderAttemptsFromSql,
  loadOrdersFromSqlForRange,
  loadAllOrderRowsForBackfill,
  persistGuardCountsToSql,
  loadGuardCountsFromSql,
  isStorageHealthy,
  deriveSettlementFields,
  type BackfillOrderRow,
} from "./tradeStore.js";

const DATA_DIR       = join(process.cwd(), "data", "analytics");
const MAX_LINE_BYTES = 65_536; // skip lines larger than 64 KB (corrupted)

function ensureDir(): void {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ordersPath(date: string): string {
  return join(DATA_DIR, `orders-${date}.ndjson`);
}

function dailyPath(date: string): string {
  return join(DATA_DIR, `daily-${date}.json`);
}

function atomicWriteJson(path: string, data: unknown): void {
  try {
    ensureDir();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    logger.warn({ err, path, analytics_error: true }, "analyticsStore: atomic write failed");
  }
}

// ── Append order record (NDJSON) ──────────────────────────────────────────────

/**
 * Append one OrderAttemptRecord as a JSON line to the NDJSON file for the
 * record's own date (derived from timestampMs). Deferred via setImmediate.
 *
 * Writing to the record's own date (not necessarily today) ensures outcome
 * patches written days later land in the correct file. The loader uses
 * last-write-wins per ID, so repeated appends for the same record are safe.
 */
export function appendOrderRecord(record: OrderAttemptRecord): void {
  setImmediate(() => {
    try {
      ensureDir();
      // Use the record's own timestamp so outcome patches land in the right file
      const date = easternDay(new Date(record.timestampMs));
      const line = JSON.stringify(record) + "\n";
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        logger.warn({ recordId: record.id, analytics_error: true }, "analyticsStore: record too large, skipped");
        return;
      }
      appendFileSync(ordersPath(date), line, "utf8");
    } catch (err) {
      logger.warn({ err, recordId: record.id, analytics_error: true }, "analyticsStore: NDJSON append failed");
    }
  });
}

// ── Persist daily summary snapshot ────────────────────────────────────────────

let _summaryTimer: ReturnType<typeof setTimeout> | null = null;

function flushDailySummary(): void {
  if (_summaryTimer) return;
  _summaryTimer = setTimeout(() => {
    _summaryTimer = null;
    try {
      const date    = easternDay(new Date());
      const summary = getDailySummary();
      atomicWriteJson(dailyPath(date), summary);
    } catch (err) {
      logger.warn({ err, analytics_error: true }, "analyticsStore: daily summary flush failed");
    }
  }, 5_000);
  if (_summaryTimer?.unref) _summaryTimer.unref();
}

// ── Persist guard-outcome counts to SQL (debounced) ───────────────────────────

let _guardFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced flush of in-memory guard-outcome counts to the daily_guard_counts
 * SQL table. Triggered after every guard mutation via the analytics store hook.
 * A 3-second debounce batches rapid bursts (e.g. many outside_zone evaluations)
 * into a single upsert.
 */
function scheduleGuardCountFlush(): void {
  if (_guardFlushTimer) return;
  _guardFlushTimer = setTimeout(() => {
    _guardFlushTimer = null;
    try {
      if (!isStorageHealthy()) return;
      const date   = easternDay(new Date());
      const counts = getGuardCounts();
      // Convert Map<series, GuardOutcomeCounts> → Map<series, Record<string, number>>
      const plain = new Map<string, Record<string, number>>();
      for (const [series, c] of counts) plain.set(series, c as unknown as Record<string, number>);
      persistGuardCountsToSql(date, plain);
    } catch (err) {
      logger.warn({ err, analytics_error: true }, "analyticsStore: guard count flush failed");
    }
  }, 3_000);
  if (_guardFlushTimer?.unref) _guardFlushTimer.unref();
}

// ── Startup hydration ─────────────────────────────────────────────────────────

/**
 * Parse all NDJSON lines from a file, returning valid records.
 * Uses last-write-wins per ID so outcome patches override the original.
 * Malformed or oversized lines are skipped and counted.
 */
function parseNdjsonFile(path: string): { records: OrderAttemptRecord[]; skipped: number } {
  const raw    = readFileSync(path, "utf8");
  const lines  = raw.split("\n").filter((l) => l.trim().length > 0);
  const byId   = new Map<string, string>(); // id → last line seen
  let skipped  = 0;

  // Pass 1: deduplicate by ID (last write wins — handles outcome patches)
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { skipped++; continue; }
    try {
      const peek = JSON.parse(line) as { id?: unknown };
      if (typeof peek.id === "string" && peek.id) {
        byId.set(peek.id, line);
      } else {
        skipped++;
      }
    } catch { skipped++; }
  }

  // Pass 2: validate and parse each deduplicated record
  const records: OrderAttemptRecord[] = [];
  for (const [id, line] of byId) {
    const { record, failure } = parseOrderRecord(line);
    if (failure) {
      logger.warn(
        { recordId: id, reason: failure.reason, field: failure.field, analytics_error: true },
        "analyticsStore: skipping malformed record",
      );
      skipped++;
    } else {
      records.push(record!);
    }
  }

  return { records, skipped };
}

/**
 * Read today's NDJSON file (if it exists) and hydrate in-memory analytics state.
 * Uses parseOrderRecord() for safe parsing with normalization of all TrackedValue shapes.
 * Last-write-wins per ID handles outcome patch updates written after initial fill.
 * Malformed lines are logged and skipped — never crash startup.
 *
 * Returns the number of records loaded from disk.
 */
function loadAnalyticsFromDisk(): number {
  try {
    const date = easternDay(new Date());
    const path = ordersPath(date);

    if (!existsSync(path)) {
      logger.info({ date }, "analyticsStore: no prior analytics file for today — starting fresh");
      return 0;
    }

    const { records, skipped } = parseNdjsonFile(path);
    for (const record of records) {
      hydrateOrderAttempt(record);
    }

    logger.info({ date, loaded: records.length, skipped }, "analyticsStore: hydrated analytics from disk");
    return records.length;
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "analyticsStore: loadAnalyticsFromDisk failed");
    return 0;
  }
}

/**
 * Hydrate today's in-memory analytics from SQL when the NDJSON file is absent.
 * Called as a fallback after `loadAnalyticsFromDisk()` loads 0 records.
 * Exported so tests can call it directly to verify SQL-backed hydration.
 */
export async function hydrateAnalyticsFromSql(date: string): Promise<number> {
  if (!isStorageHealthy()) return 0;
  try {
    const records = await loadOrderAttemptsFromSql(date);
    for (const record of records) {
      hydrateOrderAttempt(record);
    }
    if (records.length > 0) {
      logger.info({ date, loaded: records.length }, "analyticsStore: hydrated analytics from SQL (NDJSON absent)");
    }
    return records.length;
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "analyticsStore: hydrateAnalyticsFromSql failed");
    return 0;
  }
}

/**
 * Restore today's guard-outcome counts from SQL into in-memory state.
 * Called unconditionally at startup because guard counts (halted, dedup,
 * daily_cap, outside_zone, …) are never stored in the NDJSON order files.
 * Uses take-the-max semantics so order-hydration bumps (submitted/zero_fill/…)
 * that were already applied by hydrateOrderAttempt() are not clobbered.
 */
async function hydrateGuardCountsFromSql(date: string): Promise<void> {
  if (!isStorageHealthy()) return;
  try {
    const raw = await loadGuardCountsFromSql(date);
    if (raw.size === 0) return;
    hydrateGuardCounts(raw);
    logger.info({ date, seriesCount: raw.size }, "analyticsStore: hydrated guard counts from SQL");
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "analyticsStore: hydrateGuardCountsFromSql failed");
  }
}

/**
 * Map a SQL outcome string (including unresolved states) to an analytics outcome.
 * Unresolved states map to "zero_fill" as a placeholder — the record will be
 * overwritten when reconciliation later calls recordZeroFill / recordFill.
 */
function backfillOutcome(sqlOutcome: string): OrderAttemptRecord["outcome"] {
  switch (sqlOutcome) {
    case "full_fill":
    case "filled":
    case "post_confirmed":      return "full_fill";
    case "partial_fill":
    case "partially_filled":    return "partial_fill";
    case "zero_fill":
    case "post_rejected":
    case "cancelled":
    case "reconciled_not_found": return "zero_fill";
    // Unresolved — order was submitted but outcome unknown (e.g. server restarted
    // mid-flight). Write as zero_fill so it appears in analytics; reconciliation
    // will append the correct outcome line once it runs.
    default:                    return "zero_fill";
  }
}

/**
 * At startup, scan all SQL order rows for today and write any that are missing
 * from the in-memory analytics store (i.e., not already loaded from NDJSON).
 * This closes the gap where the server restarts between order submission and the
 * fill/zero-fill analytics write.
 *
 * ID convention: analytics records use "${clientOrderId}-${attemptNumber}" as the
 * compound ID (see recordOrderAttempt in analytics.ts). SQL rows store the raw
 * clientOrderId in the `id` column. We always construct the compound ID here so
 * getOrderAttemptById correctly finds records that were loaded from NDJSON.
 *
 * Each backfilled record is:
 *   1. Hydrated into in-memory analytics state (visible immediately in this session)
 *   2. Appended to the NDJSON file (durable across subsequent restarts)
 *
 * Uses last-write-wins NDJSON semantics: the backfill record is the baseline;
 * when reconciliation later calls recordFill / recordZeroFill the hook appends
 * a second line with the true outcome, which wins on the next startup load.
 */
export async function backfillMissingOrdersFromSql(date: string): Promise<void> {
  if (!isStorageHealthy()) return;
  try {
    const rows: BackfillOrderRow[] = await loadAllOrderRowsForBackfill(date);
    if (rows.length === 0) return;

    let backfilled = 0;
    for (const row of rows) {
      // The canonical analytics ID is the compound form used by recordOrderAttempt.
      // SQL stores only the raw clientOrderId in the `id` column, so we must
      // reconstruct the compound ID here to correctly match in-memory records.
      const analyticsId = `${row.clientOrderId}-${row.attemptNumber}`;

      // Skip if already present in the in-memory store (loaded from NDJSON at startup).
      if (getOrderAttemptById(analyticsId)) continue;

      const outcome = backfillOutcome(row.outcome);
      const record: OrderAttemptRecord = {
        id:                     analyticsId,
        timestampMs:            row.timestampMs,
        ticker:                 row.ticker,
        series:                 row.series,
        windowCloseTime:        row.windowCloseTime,
        side:                   row.side,
        attemptNumber:          row.attemptNumber,
        source:                 (row.source as "websocket" | "rest_fallback" | "startup_prime"),
        triggerPriceCents:      row.triggerPriceCents,
        limitPriceCents:        row.limitPriceCents,
        requestedContracts:     row.requestedContracts,
        requestedNotionalCents: row.requestedNotionalCents,
        clientOrderId:          row.clientOrderId,
        orderId:                row.orderId,
        fillCount:              row.fillCount,
        remainingCount:         row.remainingCount,
        contracts:      { value: row.contracts,       source: "confirmed_from_response" },
        fillPriceCents: { value: row.fillPriceCents,  source: "confirmed_from_response" },
        notionalDollars:{ value: row.notionalDollars, source: "confirmed_from_response" },
        feeDollars:     { value: row.feeDollars,      source: "confirmed_from_response" },
        outcome,
        roundTripMs:       row.roundTripMs,
        reconciled:        row.reconciled,
        reconcile_failed:  row.reconcile_failed,
        fill_price_source: row.fill_price_source,
        // Settlement outcome — win/P&L/outcomeReconciledAt derived from `won` column,
        // mirroring the loadOrderAttemptsFromSql path so a settled order restored only
        // via backfill shows win/loss and P&L without waiting for reconciliation to re-run.
        ...deriveSettlementFields(row),
      };

      // 1. Hydrate into in-memory state so the record is immediately visible in
      //    this session without requiring a second restart.
      hydrateOrderAttempt(record);

      // 2. Append to NDJSON so the record survives subsequent restarts.
      appendOrderRecord(record);

      backfilled++;
    }

    if (backfilled > 0) {
      logger.warn(
        { date, backfilled, total: rows.length },
        "analyticsStore: backfilled missing orders from SQL — these were submitted but not written to NDJSON before last restart",
      );
    } else {
      logger.info(
        { date, total: rows.length },
        "analyticsStore: backfill check complete — no missing orders",
      );
    }
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "analyticsStore: backfillMissingOrdersFromSql failed");
  }
}

// ── Multi-day order loader (for rolling P&L reports) ─────────────────────────

/**
 * Load all OrderAttemptRecords from the past N calendar days (inclusive of today).
 * Reads NDJSON files from disk; does NOT affect in-memory analytics state.
 * Returns an empty array on any error (safe for report generation).
 *
 * @param days - 1 = today only, 7 = past 7 days, 0 = all available files
 */
export function loadOrdersFromDateRange(days: number): OrderAttemptRecord[] {
  try {
    ensureDir();
    const allFiles = existsSync(DATA_DIR)
      ? readdirSync(DATA_DIR)
          .filter((f) => f.startsWith("orders-") && f.endsWith(".ndjson"))
          .sort() // ascending date order
      : [];

    let targetFiles: string[];
    if (days <= 0) {
      targetFiles = allFiles; // all time
    } else {
      // Build set of date strings we want
      const wanted = new Set<string>();
      const now = new Date();
      for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - i);
        wanted.add(easternDay(d));
      }
      targetFiles = allFiles.filter((f) => {
        // filename: orders-YYYY-MM-DD.ndjson
        const date = f.replace(/^orders-/, "").replace(/\.ndjson$/, "");
        return wanted.has(date);
      });
    }

    const all: OrderAttemptRecord[] = [];
    for (const filename of targetFiles) {
      try {
        const { records } = parseNdjsonFile(join(DATA_DIR, filename));
        all.push(...records);
      } catch (err) {
        logger.warn({ err, filename, analytics_error: true }, "analyticsStore: could not read historical file");
      }
    }
    return all;
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "analyticsStore: loadOrdersFromDateRange failed");
    return [];
  }
}

/**
 * Combine the deployment-local mirror with durable SQL records.
 *
 * SQL is authoritative whenever it is available. The local mirror only fills
 * a temporary SQL-unavailable reporting path and is never allowed to override
 * a SQL record for the same canonical analytics ID.
 */
export function mergeAnalyticsOrderRecords(
  fromDisk: OrderAttemptRecord[],
  fromSql: OrderAttemptRecord[],
): OrderAttemptRecord[] {
  const byId = new Map<string, OrderAttemptRecord>();
  for (const record of fromDisk) byId.set(record.id, record);
  for (const record of fromSql) byId.set(record.id, record);
  return [...byId.values()];
}

export interface AnalyticsOrderLoaders {
  loadDisk(days: number): OrderAttemptRecord[];
  storageHealthy(): boolean;
  loadSql(days: number): Promise<OrderAttemptRecord[]>;
}

const productionAnalyticsOrderLoaders: AnalyticsOrderLoaders = {
  loadDisk: loadOrdersFromDateRange,
  storageHealthy: isStorageHealthy,
  loadSql: loadOrdersFromSqlForRange,
};

/**
 * Load report records from the local mirror and durable SQL, without mutating
 * analytics state. Exported with read-only loaders so regression tests can
 * verify failure isolation without a database or trading dependencies.
 */
export async function loadMergedAnalyticsOrders(
  days: number,
  loaders: AnalyticsOrderLoaders = productionAnalyticsOrderLoaders,
): Promise<OrderAttemptRecord[]> {
  const fromDisk = loaders.loadDisk(days);
  if (!loaders.storageHealthy()) return fromDisk;

  try {
    return mergeAnalyticsOrderRecords(fromDisk, await loaders.loadSql(days));
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "analyticsStore: report SQL merge failed; using local mirror");
    return fromDisk;
  }
}

// ── Dashboard scope constants ─────────────────────────────────────────────────
// All dashboard analytics are scoped to BTC and ETH from the Teal strategy
// start: August 9, 2026, 11:00 AM Eastern (= 2026-08-09T15:00:00Z).

export const DASHBOARD_ASSET_PREFIXES = ["KXBTC", "KXETH"] as const;
export const DASHBOARD_CUTOFF_MS      = Date.UTC(2026, 7, 9, 15, 0, 0); // 2026-08-09T15:00:00Z

/**
 * Returns true for any order record that should appear on the dashboard:
 *   - ticker starts with KXBTC or KXETH
 *   - event timestamp is on or after 2026-08-09 15:00 UTC (11:00 AM ET)
 */
export function isDashboardRecord(r: OrderAttemptRecord): boolean {
  return (
    DASHBOARD_ASSET_PREFIXES.some((pfx) => r.ticker.startsWith(pfx)) &&
    r.timestampMs >= DASHBOARD_CUTOFF_MS
  );
}

/**
 * Async version of loadOrdersFromDateRange that supplements deployment-local
 * NDJSON with durable SQL records. Used by report and replay routes so an
 * incomplete mirror does not hide otherwise finalized historical orders.
 *
 * Results are scoped to BTC/ETH records from the Shawshank reporting boundary:
 * 2026-08-09 15:00 UTC (11:00 AM Eastern) onward.
 */
export async function loadOrdersFromDateRangeAsync(days: number): Promise<OrderAttemptRecord[]> {
  const all = await loadMergedAnalyticsOrders(days);
  return all.filter(isDashboardRecord);
}

// ── Initialization ────────────────────────────────────────────────────────────

/**
 * Wire up persistence and hydrate state from disk, then fall back to SQL if the
 * NDJSON file for today is absent (e.g. after a deployment that wiped data/).
 * Call once at server startup, after the server begins listening and after
 * initTradeStore() has connected to the database.
 */
export async function initializeAnalyticsStore(): Promise<void> {
  try {
    // Register the record update hook so fills/zero-fills are persisted automatically
    setRecordUpdateHook(appendOrderRecord);

    // Register the store-change hook so guard-count mutations trigger a debounced SQL flush
    setStoreHook(scheduleGuardCountFlush);

    // Hydrate in-memory state from today's NDJSON
    const diskCount = loadAnalyticsFromDisk();

    // If NDJSON was absent (e.g. after a redeploy or data/ wipe), load from SQL.
    const date = easternDay(new Date());
    if (diskCount === 0) {
      await hydrateAnalyticsFromSql(date);
    }

    // Always restore guard counts from SQL — they are not stored in the NDJSON
    // (the NDJSON only records submitted/fill outcomes, not blocked evaluations).
    await hydrateGuardCountsFromSql(date);

    // Backfill any orders that appear in SQL but are absent from the NDJSON.
    // This catches the case where the server restarted between order submission
    // and the fill/zero-fill hook write (which is now also triggered at submission
    // time, but this safety net covers any rows written before that fix landed).
    await backfillMissingOrdersFromSql(date);

    // Flush daily summary every 5 minutes
    const summaryInterval = setInterval(flushDailySummary, 5 * 60_000);
    if (summaryInterval.unref) summaryInterval.unref();

    logger.info("analyticsStore: initialized");
  } catch (err) {
    logger.warn({ err, analytics_error: true }, "analyticsStore: initialization failed");
  }
}
