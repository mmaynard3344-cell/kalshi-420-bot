import { Router, type Request, type Response, type NextFunction } from "express";
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";
import { kalshiAuthFetch, diagnoseKalshiAuth, getKalshiCredentialFingerprint, KALSHI_TRADE_BASE } from "../lib/kalshiAuth";
import { fetchSharedKalshiPositions, sharedFillsViewCache } from "../lib/kalshiAccountReads.js";
import {
  buildTradeBalanceDashboardResponse,
  fetchKalshiBalance,
  fetchKalshiBalanceForExchangeRead,
  fetchKalshiBalanceRead,
} from "../lib/kalshiBalance.js";
import { logger } from "../lib/logger";
import { getWindowLog } from "../lib/windowLog";
import { isPriceInBand, PRICE_FLOOR_CENTS, PRICE_CAP_CENTS, PRICE_TIERS, PRICE_TIERS_VERSION } from "../lib/autoTraderGuards";
import {
  SERIES_CONFIG,
  getAutoTraderStatus,
  getCurrentEthExchangeIndex,
  getCurrentEthMarketSnapshot,
} from "../lib/autoTrader.js";
import type { CurrentEthMarketSnapshot } from "../lib/autoTrader.js";
import { getStaleGapPassiveCaptureStatus } from "../lib/staleGapPassiveCapture.js";
import { getResearchRetentionStatus } from "../lib/researchRetentionStatus.js";
import { getCompactShadowStatusInSql } from "../lib/tradeStore.js";
import { getPhase4BPassiveCaptureStatus } from "../lib/phase4b/passiveCapture.js";
import {
  buildMandelbrotReportSummary,
  getCachedMandelbrotReport,
  getMandelbrotCaptureStatus,
  loadMandelbrotObservations,
} from "../lib/mandelbrotInstability.js";
import { loadRecentEvaluationEvents, type EvaluationEvent } from "../lib/evaluationEventStore.js";
import { getCoverageStatus, getCoverageWindowAudits, loadCoverageWindowAudits, loadRecentCoverageIncidents } from "../lib/marketDataCoverage.js";
import { getWatchdogHistory, getWatchdogStatus } from "../lib/runtimeWatchdog.js";
import { loadRecentCoverageIncidentsFromSql, loadRecentCoverageWindowAuditsFromSql, loadRuntimeWatchdogHistoryFromSql } from "../lib/tradeStore.js";
import {
  ETH_420_CANDIDATE_EXECUTION_APPROVED,
  ETH_420_HISTORY_DAYS,
  ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS,
  ETH_420_MIN_HISTORY,
  ETH_420_PRINCIPALS_CENTS,
  percentile,
  eth420EmergencyReductionInstruction,
} from "../lib/strategies/eth420SixStepCandidate.js";
import {
  assessEth420SecondaryGlobalActivation,
  evaluateEth420SecondaryActivationReadiness,
  type Eth420SecondaryEntryExchangeOrder,
} from "../lib/strategies/eth420SecondaryEntry.js";
import { parseKalshiOrderResponse } from "../lib/orderResponseParser.js";
import { parseExitSellBids, parseOrderbookResponse } from "../lib/orderbookParsing.js";
import type { PreflightDecision } from "../lib/preflightStore.js";
import {
  getExchangeCoverageStatus,
  getFillReconciliationStatus,
  reconcileOrder,
  discoverAndReconcileMissingBotFills,
  isExchangeDiscoverySweepComplete,
} from "../lib/fillReconciler.js";
import { STRATEGY_CONFIG } from "../strategy/decide.js";
import {
  easternDay,
  rollIfNewDay,
  tryReserve,
  releaseCents,
  parseBudgetFile,
  nextEasternMidnight,
  type DailyBudgetState,
} from "../lib/dailyBudget";
import * as tradeStore from "../lib/tradeStore.js";
import {
  allowNewInvestment,
  DAILY_PROFIT_TARGET_DOLLARS,
  getDailyProfitStopStatus,
  loadDailyProfitStopAuditFile,
} from "../lib/dailyProfitStop.js";
import { kalshiStream } from "../lib/kalshiStream.js";
import { getProtectiveExitMonitorStatus } from "../lib/protectiveExit.js";
import { getExchangeDiscoverySweepStatus } from "../lib/fillReconciler.js";
import { timingSafeEqual } from "crypto";
import { ethMartingaleLedgerToCSV } from "../lib/csvExport.js";
import { getAccountHistoryFingerprint } from "../lib/kalshiAccountFingerprint.js";
import { getRuntimeHeartbeatStatus, isRuntimeEntryHealthy } from "../lib/runtimeHeartbeat.js";
import { summarizeEth30StrategyActivity, summarizeLegacyStrategyActivity, summarizeSol30StrategyActivity } from "../lib/strategyActivity.js";
import { summarizePairedSideStudy } from "../lib/strategies/pairedSideShadow.js";
import {
  isNewEntryPermitted,
  WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
  WEEK_2_PRODUCTION_NEW_ENTRY_SERIES,
  ACTIVE_ENTRY_SERIES_POLICY,
} from "../lib/week2EntryPolicy.js";
import { isManualNewOrderSubmissionDisabled } from "../lib/manualOrderBoundary.js";
import { getEthMartingaleBlockerStatus, reconcileEthMartingaleSettlements } from "../lib/strategies/ethOnlyMartingale.js";
import { ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS } from "../lib/tradeStore.js";

const router = Router();

const DATA_DIR = join(process.cwd(), "data");

function parseEthLedgerExportBoundary(
  raw: unknown,
  fallback: number,
): number | null {
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?[+-]\d{2}:?\d{2}$/.test(raw)) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function loadEthLedgerExportResponse(req: Request) {
  const fromMs = parseEthLedgerExportBoundary(
    req.query["from_et"],
    ETH_MARTINGALE_ACTIVE_GENERATION_STARTED_AT_MS,
  );
  const toMs = parseEthLedgerExportBoundary(req.query["to_et"], Date.now());
  if (fromMs == null || toMs == null || fromMs > toMs) return null;
  const rows = await tradeStore.loadEthMartingaleLedgerExport(fromMs, toMs);
  return rows == null ? null : {
    fromMs,
    toMs,
    rows,
    summary: tradeStore.summarizeEthMartingaleLedgerExport(rows),
  };
}

/**
 * The evaluation event is emitted immediately after its preflight decision,
 * but intentionally stores only the BBO-derived context. Attach the matching
 * durable L2 evidence for observability responses without changing the event
 * ledger or trading path.
 */
type EvaluationEventWithPreflightEvidence = EvaluationEvent & {
  freshExecutablePriceCents?: number | null;
  authorizedLimitCents?: number | null;
};

function attachPreflightEvidence(
  events: EvaluationEvent[],
  preflights: PreflightDecision[],
): EvaluationEventWithPreflightEvidence[] {
  const MAX_MATCH_GAP_MS = 1_500;

  return events.map((event) => {
    if (!event.side) return event;
    let closest: PreflightDecision | undefined;
    let closestGap = Infinity;

    for (const preflight of preflights) {
      if (preflight.ticker !== event.ticker || preflight.side !== event.side) continue;
      const gap = Math.abs(preflight.timestampMs - event.timestampMs);
      if (gap <= MAX_MATCH_GAP_MS && gap < closestGap) {
        closest = preflight;
        closestGap = gap;
      }
    }

    if (!closest) return event;
    return {
      ...event,
      freshExecutablePriceCents: closest.executableBestAskCents,
      authorizedLimitCents: closest.bboDerivedLimitCents,
    };
  });
}

// ---------------------------------------------------------------------------
// Atomic + debounced persistence
//
// The originals called writeFileSync straight from the request path, so every
// order blocked the event loop on disk I/O, and a crash mid-write left JSON
// that failed to parse on the next boot. Writes now go to a temp file and are
// renamed into place (rename is atomic on the same filesystem), and callers
// mark state dirty rather than writing synchronously.
// ---------------------------------------------------------------------------

/** Returns true on success, false on any write error. */
function atomicWriteJson(path: string, data: unknown): boolean {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, path);
    return true;
  } catch (err) {
    logger.warn({ err, path }, "Could not persist state file");
    return false;
  }
}

let dedupWriteFailures = 0;
const PERSIST_DEBOUNCE_MS = 2_000;
const pendingWrites = new Map<string, () => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(path: string, write: () => void): void {
  pendingWrites.set(path, write);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPendingWrites();
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer.unref) persistTimer.unref();
}

function flushPendingWrites(): void {
  for (const write of pendingWrites.values()) write();
  pendingWrites.clear();
}

// ---------------------------------------------------------------------------
// Auth
//
// Nothing previously authenticated /trade/order — anything that could reach
// the port could spend the balance. A shared secret is the minimum bar for a
// service that places real orders. Note this guards against other hosts, not
// against someone already at the browser: the token ships to the client.
// ---------------------------------------------------------------------------

const TRADE_API_TOKEN = process.env["TRADE_API_TOKEN"] ?? "";
// The browser client is built with VITE_TRADE_API_TOKEN baked in (the old
// unauthenticated /trade/client-token endpoint that handed out the primary
// token was removed). Accept it as an additional valid token so the two
// secrets don't have to share a value.
const VALID_TRADE_TOKENS = [TRADE_API_TOKEN, process.env["VITE_TRADE_API_TOKEN"] ?? ""].filter(
  (t) => t.length > 0,
);
function tokenMatches(provided: string): boolean {
  const a = Buffer.from(provided, "utf8");
  return VALID_TRADE_TOKENS.some((t) => {
    const b = Buffer.from(t, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

function requireTradeAuth(req: Request, res: Response, next: NextFunction): void {
  if (VALID_TRADE_TOKENS.length === 0) {
    logger.error("TRADE_API_TOKEN is unset — refusing all trade requests");
    res.status(503).json({ error: "TRADE_API_TOKEN is not configured on the server" });
    return;
  }

  const provided = req.header("x-trade-token") ?? "";

  if (!provided || !tokenMatches(provided)) {
    logger.warn({ ip: req.ip, path: req.path }, "Rejected trade request with an invalid token");
    res.status(401).json({ error: "Invalid or missing X-Trade-Token header" });
    return;
  }

  next();
}

/**
 * Manual ETH settlement recovery is intentionally protected by a credential
 * that is never included in the browser bundle. The normal trade token alone
 * must not be enough to declare a missing exchange result.
 */
function requireEthRecoveryAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env["ETH_MARTINGALE_RECOVERY_TOKEN"] ?? "";
  if (!configured || VALID_TRADE_TOKENS.some((tradeToken) => {
    const a = Buffer.from(configured, "utf8");
    const b = Buffer.from(tradeToken, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  })) {
    logger.error("ETH_MARTINGALE_RECOVERY_TOKEN is unset or duplicates a browser/server trade token — refusing manual ETH recovery");
    res.status(503).json({ error: "ETH martingale recovery is not configured" });
    return;
  }
  const provided = req.header("x-eth-recovery-token") ?? "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (!provided || a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn({ ip: req.ip, path: req.path }, "Rejected ETH martingale recovery with invalid recovery credential");
    res.status(401).json({ error: "Invalid or missing ETH recovery credential" });
    return;
  }
  next();
}

// Auth is applied per-route to all writes (order placement, halt toggle), to
// every endpoint exposing portfolio data (balance, positions, orders, fills),
// and to reads exposing commercially sensitive strategy config (/trade/status).
// Only non-sensitive strategy constants (e.g. /trade/tiers) stay open.

// ---------------------------------------------------------------------------
// Kill switch + daily notional cap
//
// The system will place orders every 15 minutes forever with nobody watching.
// These two limits are what stop a bad afternoon from becoming a bad month.
// ---------------------------------------------------------------------------

const MAX_DAILY_NOTIONAL_CENTS = Number(process.env["MAX_DAILY_NOTIONAL_CENTS"] ?? 800_000);
const BUDGET_FILE = join(DATA_DIR, "daily-budget.json");

// In-process budget state. Written by reserveNotional/releaseNotional (sync),
// persisted asynchronously via schedulePersist. All mutations are synchronous —
// no await points between date-check, cap-check, and increment — so Node.js's
// single-threaded event loop makes reserveNotional atomic with respect to
// concurrent callers.
let budget: DailyBudgetState = { date: easternDay(new Date()), spentCents: 0 };

// Environment kill switch + runtime halt flag live in a dependency-free module
// so tests can import them without pulling in Express/pino CJS bundles.
export {
  envTradingDisabled,
  envWorkspaceHaltActive,
  getDogeOrderSubmissionStatus,
  isTradingHalted,
  isWorkspaceEnvironment,
  isEnvLocked,
  workspaceTradingEnabled,
  getEthOrderSubmissionStatus,
} from "../lib/tradingKillSwitch";
import {
  envTradingDisabled,
  getDogeOrderSubmissionStatus,
  getEthOrderSubmissionStatus,
  isTradingHalted,
  setTradingHalted,
  isEnvLocked,
} from "../lib/tradingKillSwitch";

function loadBudget(): void {
  try {
    const raw = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
    const restored = parseBudgetFile(raw, new Date());
    const prior = budget;
    budget = restored;
    if (restored.spentCents > 0) {
      logger.info(
        { date: restored.date, spentCents: restored.spentCents },
        "Restored daily notional spend from disk",
      );
    } else if (Number((raw as Record<string, unknown>)?.["spentCents"]) > 0) {
      // File had spend but it was for a prior day — log the reset
      logger.info(
        {
          priorDate:            (raw as Record<string, unknown>)["date"] ?? (raw as Record<string, unknown>)["day"],
          newDate:              restored.date,
          priorDailySpentCents: (raw as Record<string, unknown>)["spentCents"],
          resetDailySpentCents: 0,
        },
        "Daily notional budget rolled over on startup (new Eastern day)",
      );
    }
    void prior; // suppress unused-variable warning
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      logger.warn({ err }, "Could not read daily budget file — starting fresh");
    }
  }
}

function persistBudget(): void {
  schedulePersist(BUDGET_FILE, () => {
    const ok = atomicWriteJson(BUDGET_FILE, budget);
    if (!ok) {
      budgetWriteFailures++;
      logger.warn(
        { budgetWriteFailures, file: BUDGET_FILE },
        "Could not write daily budget file — budget will not survive a restart",
      );
    }
  });
}

/**
 * Checks whether the Eastern calendar date has advanced since the last
 * reservation or sweep. If it has, resets spend to zero, logs the rollover,
 * and persists. Called on the 5-minute sweep timer so the reset happens
 * automatically after midnight even if no order attempts are made.
 */
function maybeMidnightRollover(): void {
  const result = rollIfNewDay(budget, new Date());
  if (result.rolled) {
    logger.info(
      {
        priorDate:            result.priorDate,
        newDate:              result.next.date,
        priorDailySpentCents: result.priorSpentCents,
        resetDailySpentCents: 0,
      },
      "Daily notional budget rolled over at midnight (ET)",
    );
    budget = result.next;
    persistBudget();
  }
}

/**
 * Reserve notional up front. Returns false when the reservation would exceed
 * the daily cap. Also performs a lazy midnight rollover so the cap always
 * applies to the correct Eastern calendar day.
 *
 * Atomic: all operations (date check → cap check → increment) are synchronous.
 * Node.js's event loop serialises synchronous code — two concurrent callers
 * cannot both pass the cap check or both initialise a fresh day simultaneously.
 */
export function reserveNotional(cents: number): boolean {
  const result = tryReserve(budget, cents, MAX_DAILY_NOTIONAL_CENTS, new Date());

  if (result.rollResult.rolled) {
    logger.info(
      {
        priorDate:            result.rollResult.priorDate,
        newDate:              result.rollResult.next.date,
        priorDailySpentCents: result.rollResult.priorSpentCents,
        resetDailySpentCents: 0,
      },
      "Daily notional budget rolled over at midnight (ET)",
    );
  }

  if (!result.ok) return false;

  budget = result.next;
  persistBudget();
  return true;
}

export function releaseNotional(cents: number): void {
  budget = releaseCents(budget, cents);
  persistBudget();
}

loadBudget();

// ---------------------------------------------------------------------------
// Server-side order dedup
//
// Split into claim/release. The original set the timestamp as a side effect of
// *checking*, so a single failed order locked that ticker+side out for the
// full 20-minute window.
// ---------------------------------------------------------------------------

const ORDER_DEDUP_WINDOW_MS = 20 * 60_000;
const recentOrders = new Map<string, number>(); // `${ticker}-${side}` → placed-at ms
const DEDUP_FILE = join(DATA_DIR, "order-dedup.json");

function loadPersistedDedup(): void {
  try {
    const stored = JSON.parse(readFileSync(DEDUP_FILE, "utf8")) as Record<string, number>;
    const now = Date.now();
    let loaded = 0;
    for (const [key, ts] of Object.entries(stored)) {
      if (typeof key === "string" && typeof ts === "number" && now - ts < ORDER_DEDUP_WINDOW_MS) {
        recentOrders.set(key, ts);
        loaded++;
      }
    }
    logger.info({ loaded }, "Loaded order dedup set from disk");
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      logger.warn({ err }, "Could not read order dedup file");
    }
  }
}

function persistDedup(): void {
  schedulePersist(DEDUP_FILE, () => {
    const ok = atomicWriteJson(DEDUP_FILE, Object.fromEntries(recentOrders));
    if (!ok) {
      dedupWriteFailures++;
      logger.warn(
        { dedupWriteFailures, file: DEDUP_FILE },
        "Could not write order dedup file — dedup is in-memory only; duplicate orders are possible after a restart",
      );
    }
  });
}

loadPersistedDedup();

/**
 * Apply budget restored from SQL. Called from index.ts after initTradeStore().
 * Uses the higher of the file value vs the SQL value (SQL is authoritative for
 * a running deployment; file is a cross-restart carry-forward fallback).
 */
export function applyRestoredBudget(spentCents: number): void {
  const date = easternDay(new Date());
  if (budget.date !== date) return; // day already rolled — ignore stale SQL row
  if (spentCents > budget.spentCents) {
    budget = { ...budget, spentCents };
    persistBudget();
    logger.info({ date, spentCents }, "Budget updated from SQL restore (SQL > file)");
  }
}

/** Returns the current in-memory budget state. Used by index.ts to sync to SQL. */
export function getCurrentBudget(): { date: string; spentCents: number } {
  return { date: budget.date, spentCents: budget.spentCents };
}

/**
 * Apply non-expired dedup slots restored from SQL. Called from index.ts after
 * initTradeStore(). Merges into the in-memory map without overwriting slots
 * that are already present (file restore took priority for those).
 */
export function applyRestoredDedupSlots(slots: Map<string, number>): void {
  const now = Date.now();
  let added = 0;
  for (const [key, ts] of slots) {
    if (now - ts < ORDER_DEDUP_WINDOW_MS && !recentOrders.has(key)) {
      recentOrders.set(key, ts);
      added++;
    }
  }
  if (added > 0) logger.info({ added }, "Dedup slots merged from SQL restore");
}

/** Claim a ticker+side slot. Returns false when one is already held OR storage is degraded. */
export function claimOrderSlot(ticker: string, side: string): boolean {
  // Storage health gate: if SQL is unreachable we cannot safely record orders.
  // Block until storage recovers to prevent unrecorded live orders.
  if (!tradeStore.isStorageHealthy()) {
    logger.warn({ ticker, side }, "claimOrderSlot: SQL storage degraded — order blocked until storage recovers");
    return false;
  }
  // A persisted heartbeat is required for all new entries. This is deliberately
  // here, before any dedup/budget mutation, and is never used by protective exits.
  if (!isRuntimeEntryHealthy()) {
    logger.warn({ ticker, side, runtime: getRuntimeHeartbeatStatus() },
      "claimOrderSlot: runtime heartbeat/collector unhealthy — new entry blocked until telemetry resumes");
    return false;
  }
  const key = `${ticker}-${side}`;
  const now = Date.now();
  for (const [k, ts] of recentOrders) {
    if (now - ts > ORDER_DEDUP_WINDOW_MS) recentOrders.delete(k);
  }
  if (recentOrders.has(key)) return false;
  recentOrders.set(key, now);
  persistDedup();
  return true;
}

export function releaseOrderSlot(ticker: string, side: string): void {
  recentOrders.delete(`${ticker}-${side}`);
  persistDedup();
}

// ---------------------------------------------------------------------------
// Position guard
//
// Kalshi's V2 book is quoted entirely from the YES leg: "bid" buys YES and
// "ask" sells YES. Selling YES is economically equivalent to buying NO only
// when you are flat. Hold YES and submit an "ask" and you have not opened NO
// exposure — you have closed the YES position, which turns this strategy into
// an accidental stop-loss. So: check the book before crossing.
// ---------------------------------------------------------------------------

/** Signed position for a ticker: positive = long YES, negative = long NO. */
export async function getSignedPosition(ticker: string): Promise<number> {
  const data = await kalshiAuthFetch<{ market_positions?: Array<Record<string, unknown>> }>(
    "GET",
    `/portfolio/positions?ticker=${encodeURIComponent(ticker)}`,
  );
  const row = data.market_positions?.find((p) => p["ticker"] === ticker);
  const raw = row?.["position"];
  const value = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Market-result cache (resolved markets never change → cached indefinitely)
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 60_000;
const MAX_CACHE_SIZE = 1_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_CACHE_FILE_BYTES = 1_048_576;
const CACHE_FILE = join(DATA_DIR, "market-result-cache.json");

interface CacheEntry {
  result: string;
  expiresAt: number; // Infinity for resolved entries
}

const marketResultCache = new Map<string, CacheEntry>();
let cacheFileReadSafely = false;

function readResolvedCacheFile(): Array<[string, string]> | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8");
    const stored = JSON.parse(raw) as unknown;
    if (!stored || Array.isArray(stored) || typeof stored !== "object") {
      throw new Error("market result cache must be a JSON object");
    }
    return Object.entries(stored).filter(
      ([ticker, result]) => typeof ticker === "string" && typeof result === "string" && result !== "",
    );
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    logger.warn({ err, file: CACHE_FILE }, "Could not safely read market result cache file; refusing to overwrite it");
    return null;
  }
}

function loadPersistedCache(): void {
  const valid = readResolvedCacheFile();
  if (valid === null) return;
  try {
    const fileSizeBytes = existsSync(CACHE_FILE) ? statSync(CACHE_FILE).size : 0;
    const toLoad =
      valid.length > MAX_CACHE_SIZE ? valid.slice(valid.length - MAX_CACHE_SIZE) : valid;
    for (const [ticker, result] of toLoad) {
      marketResultCache.set(ticker, { result, expiresAt: Infinity });
    }
    logger.info(
      { loaded: toLoad.length, skipped: valid.length - toLoad.length, fileSizeBytes },
      "Loaded market result cache from disk",
    );
    if (fileSizeBytes > MAX_CACHE_FILE_BYTES) {
      logger.warn(
        { fileSizeBytes, maxCacheFileBytes: MAX_CACHE_FILE_BYTES },
        "Cache file is larger than expected — likely written before size trimming existed",
      );
    }
    cacheFileReadSafely = true;
  } catch (err: unknown) {
    logger.warn({ err, file: CACHE_FILE }, "Could not initialize market result cache; refusing to overwrite it");
  }
}

function writeMergedResolvedCache(): boolean {
  if (!cacheFileReadSafely) return false;
  const diskEntries = readResolvedCacheFile();
  if (diskEntries === null) return false;
  const merged = new Map(diskEntries);
  for (const [ticker, entry] of marketResultCache) {
    if (entry.expiresAt === Infinity) merged.set(ticker, entry.result);
  }
  const entries = [...merged.entries()];
  const trimmed = entries.length > MAX_CACHE_SIZE ? entries.slice(entries.length - MAX_CACHE_SIZE) : entries;
  return atomicWriteJson(CACHE_FILE, Object.fromEntries(trimmed));
}

function persistCache(): void {
  schedulePersist(CACHE_FILE, () => {
    if (!writeMergedResolvedCache()) {
      cacheWriteFailures++;
      logger.warn(
        { cacheWriteFailures, file: CACHE_FILE },
        "Could not safely write market result cache file — preserving existing cache contents",
      );
    }
  });
}

loadPersistedCache();

function evictOldestIfFull(): void {
  if (marketResultCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = marketResultCache.keys().next().value;
    if (oldestKey !== undefined) marketResultCache.delete(oldestKey);
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of marketResultCache) {
    if (entry.expiresAt !== Infinity && now >= entry.expiresAt) {
      marketResultCache.delete(key);
    }
  }
  for (const [k, ts] of recentOrders) {
    if (now - ts > ORDER_DEDUP_WINDOW_MS) recentOrders.delete(k);
  }
  maybeMidnightRollover();
  persistCache();
  persistDedup();
}

const sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
if (sweepTimer.unref) sweepTimer.unref();

/**
 * Flush all state to disk. The app entrypoint should call this in its shutdown
 * handler, then server.close(), then exit — this module no longer calls
 * process.exit() itself, which used to kill in-flight requests.
 */
export function flushTradeState(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  // Force the current state out even if nothing scheduled a write.
  if (!writeMergedResolvedCache()) {
    cacheWriteFailures++;
    logger.warn({ cacheWriteFailures, file: CACHE_FILE }, "Could not write market result cache file on shutdown");
  }
  if (!atomicWriteJson(DEDUP_FILE, Object.fromEntries(recentOrders))) {
    dedupWriteFailures++;
    logger.warn(
      { dedupWriteFailures, file: DEDUP_FILE },
      "Could not write order dedup file on shutdown — dedup is in-memory only; duplicate orders are possible after a restart",
    );
  }
  if (!atomicWriteJson(BUDGET_FILE, budget)) {
    budgetWriteFailures++;
    logger.warn({ budgetWriteFailures, file: BUDGET_FILE }, "Could not write daily budget file on shutdown");
  }
  pendingWrites.clear();
}

async function getMarketResult(ticker: string): Promise<string> {
  const now = Date.now();
  const cached = marketResultCache.get(ticker);
  if (cached && now < cached.expiresAt) return cached.result;

  try {
    const mkt = await kalshiAuthFetch<{ market?: { result?: string } }>(
      "GET",
      `/markets/${ticker}`,
    );
    const result = mkt.market?.result ?? "";
    const expiresAt = result !== "" ? Infinity : now + PENDING_TTL_MS;

    // Delete-then-insert keeps Map iteration order as LRU order.
    marketResultCache.delete(ticker);
    evictOldestIfFull();
    marketResultCache.set(ticker, { result, expiresAt });

    if (expiresAt === Infinity) {
      persistCache();
      tradeStore.upsertMarketResultInSql(ticker, result);
    }
    return result;
  } catch {
    return ""; // Don't cache errors — try again next poll.
  }
}

/** Run an async map with bounded concurrency. Kalshi meters reads per second. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index] as T;
      try {
        results[index] = { status: "fulfilled", value: await fn(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /trade/tiers — canonical price-tier definitions.
 *
 * Returns the same tier boundaries used by the server for analytics
 * (passiveObserver hypotheticalTier) so the frontend Portfolio breakdown
 * never drifts out of sync with the server.  No auth required — these are
 * non-sensitive strategy constants, not portfolio data.
 *
 * Clients SHOULD store the returned `version` and include it as
 * `tier_version` in POST /trade/order bodies.  Orders with a mismatched
 * `tier_version` are rejected (HTTP 409) so stale clients cannot silently
 * double-buy or mis-size orders after a tier update.
 *
 * Response: { tiers: Array<{ label: string; min: number; max: number }>, version: string }
 */
router.get("/trade/tiers", (_req, res) => {
  res.json({ tiers: PRICE_TIERS, version: PRICE_TIERS_VERSION });
});

/** GET /trade/storage/status — durable SQL storage health and counts. */
router.get("/trade/storage/status", async (_req, res) => {
  const status = await tradeStore.getStorageStatus();
  res.status(status.status === "healthy" ? 200 : 503).json(status);
});

/** GET /trade/status — current guard rails, for a health panel or a quick curl.
 *  Requires auth: exposes strategy config (bet sizes, alert band) and budget
 *  consumption, which are commercially sensitive. */
router.get("/trade/status", requireTradeAuth, async (_req, res) => {
  maybeMidnightRollover();
  const now = new Date();
  const nextReset = nextEasternMidnight(now);
  const secondsUntilReset = Math.max(0, Math.round((nextReset.getTime() - now.getTime()) / 1000));
  const successAt = tradeStore.getLastDatabaseSuccessAt();
  const realizedPnl = await tradeStore.getDailyRealizedPnl(budget.date);
  const dailyProfitStop = await getDailyProfitStopStatus(now);
  const dogeOrderSubmission = getDogeOrderSubmissionStatus("KXDOGE15M-status");
  const ethOrderSubmission = getEthOrderSubmissionStatus("KXETH15M-status");
  const dashboardReadProtection = tradeStore.getDashboardReadProtection();
  const ethMartingaleBlocker = getEthMartingaleBlockerStatus();
  res.json({
    // Build-time identity lets the operator prove this response came from the
    // intended deployed bundle, rather than merely a healthy older VM.
    build_commit_sha:         process.env["COMMIT_SHA"] ?? "unknown",
    trading_halted:           isTradingHalted(),
    environment_lock:         isEnvLocked(),
    ...dogeOrderSubmission,
    ...ethOrderSubmission,
    eth_martingale_blocker: ethMartingaleBlocker,
    date:                     budget.date,
    timezone:                 "America/New_York",
    spent_cents:              budget.spentCents,
    max_daily_notional_cents: MAX_DAILY_NOTIONAL_CENTS,
    remaining_cents:          Math.max(0, MAX_DAILY_NOTIONAL_CENTS - budget.spentCents),
    daily_realized_net_pnl_dollars: realizedPnl.realizedNetPnlDollars,
    daily_realized_settled_fill_count: realizedPnl.settledFillCount,
    daily_realized_pending_fill_count: realizedPnl.pendingVerificationCount,
    daily_realized_unverified_fill_count: realizedPnl.unverifiedFillCount,
    kalshi_daily_realized_pnl: dailyProfitStop,
    daily_profit_target_dollars: DAILY_PROFIT_TARGET_DOLLARS,
    exchange_history_coverage:        getExchangeCoverageStatus(),
    /** True once the exchange-history discovery sweep has completed for today. */
    exchange_reconciliation_complete: isExchangeDiscoverySweepComplete(budget.date),
    next_reset_at:            nextReset.toISOString(),
    seconds_until_reset:      secondsUntilReset,
    open_dedup_slots:         recentOrders.size,
    // ── Strategy config ──────────────────────────────────────────────────────
    bet_dollars_btc:          SERIES_CONFIG.KXBTC15M.betDollars,
    bet_dollars_eth:          SERIES_CONFIG.KXETH15M.betDollars,
    alert_min:                STRATEGY_CONFIG.ALERT_MIN,
    alert_max:                STRATEGY_CONFIG.ALERT_MAX,
    time_alert_seconds:       STRATEGY_CONFIG.TIME_ALERT_SECONDS,
    // ── Database health ──────────────────────────────────────────────────────
    sql_storage_status:       tradeStore.isStorageHealthy() ? "healthy" : "degraded",
    database_connected:       tradeStore.isStorageHealthy(),
    last_database_error:      tradeStore.getLastDatabaseError() || null,
    last_database_success_at: successAt ? new Date(successAt).toISOString() : null,
    database_retry_count:     tradeStore.getDatabaseRetryCount(),
    // Dashboard reads share a bounded lane that deliberately leaves one pool
    // client available for durable heartbeats and settlement reconciliation.
    // These counts never include query text or alter order submission.
    dashboard_read_protection: {
      active_read_count: dashboardReadProtection.activeReadCount,
      queued_read_count: dashboardReadProtection.queueDepth,
      max_concurrent_reads: dashboardReadProtection.maxConcurrentReads,
      reserved_safety_clients: dashboardReadProtection.reservedSafetyClients,
      traffic_throttled: dashboardReadProtection.dashboardTrafficThrottled,
      message: dashboardReadProtection.message,
    },
    orphanedFillLinks:        tradeStore.getOrphanedFillLinkStatus(),
  });
});

/**
 * Read-only authoritative ETH martingale session. Unlike analytics/windows,
 * this reads only the strategy's durable order/state ledger and only exposes
 * fill notional after immutable Kalshi fill evidence is stored.
 */
router.get("/trade/martingale/export-summary", requireTradeAuth, async (req, res) => {
  const report = await loadEthLedgerExportResponse(req);
  if (report == null) {
    res.status(400).json({
      error: "Provide a valid ET range using from_et and to_et, with an explicit UTC offset",
      example: "2026-08-24T12:00:00-04:00",
    });
    return;
  }
  res.json({
    range: { from_et: req.query["from_et"] ?? null, to_et: req.query["to_et"] ?? null, from_ms: report.fromMs, to_ms: report.toMs },
    summary: report.summary,
  });
});

router.get("/trade/martingale/export.csv", requireTradeAuth, async (req, res) => {
  const report = await loadEthLedgerExportResponse(req);
  if (report == null) {
    res.status(400).json({
      error: "Provide a valid ET range using from_et and to_et, with an explicit UTC offset",
      example: "2026-08-24T12:00:00-04:00",
    });
    return;
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=eth-martingale-ledger.csv");
  res.setHeader(
    "X-ETH-Martingale-Realized-Net-Pnl-Dollars",
    report.summary.realizedNetPnlDollars == null ? "unavailable" : report.summary.realizedNetPnlDollars.toFixed(2),
  );
  res.send(ethMartingaleLedgerToCSV(report.rows));
});

router.get("/trade/martingale", requireTradeAuth, async (_req, res) => {
  let dashboard: Awaited<ReturnType<typeof tradeStore.loadEthMartingaleDashboard>>;
  let sessionProfit: Awaited<ReturnType<typeof tradeStore.loadEthMartingaleSessionProfit>>;
  let manualRecovery: Awaited<ReturnType<typeof tradeStore.loadLatestEthMartingaleRecoveryAudit>>;
  let manualRecoveryTickers: Awaited<ReturnType<typeof tradeStore.listEthMartingaleManualRecoveryTickers>>;
  try {
    [dashboard, sessionProfit, manualRecovery, manualRecoveryTickers] = await Promise.all([
      tradeStore.loadEthMartingaleDashboard(),
      tradeStore.loadEthMartingaleSessionProfit(),
      tradeStore.loadLatestEthMartingaleRecoveryAudit(),
      tradeStore.listEthMartingaleManualRecoveryTickers(),
    ]);
  } catch (err) {
    _req.log.warn({ err }, "martingale ledger request failed");
    dashboard = null;
    sessionProfit = null;
    manualRecovery = null;
    manualRecoveryTickers = null;
  }
  if (!dashboard || !sessionProfit) {
    res.status(503).json({
      error: "Martingale ledger is temporarily unavailable",
      code: "MARTINGALE_LEDGER_UNAVAILABLE",
      retry_after_seconds: 5,
      storage_status: tradeStore.isStorageHealthy() ? "healthy" : "degraded",
    });
    return;
  }
  const session = tradeStore.summarizeEthMartingaleOrders(dashboard.orders);
  const openPosition = tradeStore.findOpenEthMartingalePosition(dashboard.orders);
  const blocker = getEthMartingaleBlockerStatus();
  res.json({
    eastern_date: dashboard.easternDate,
    state: {
      next_side: dashboard.state.side,
      martingale_step: dashboard.state.martingaleStep,
      next_principal_cents: [1500, 3000, 6000, 12000, 24000, 32000][Math.max(0, Math.min(5, dashboard.state.martingaleStep))],
      realized_pnl_dollars: dashboard.state.realizedPnlCents / 100,
    },
    session: {
      order_count: session.orderCount,
      wins: session.wins,
      losses: session.losses,
      streak: session.streak,
      streak_type: session.streakType,
      filled_contracts: session.filledContracts,
      actual_notional_dollars: session.actualNotionalDollars,
      fill_economics_verified: session.fillEconomicsVerified,
    },
    session_profit: {
      started_at_ms: sessionProfit.startedAtMs,
      realized_pnl_dollars: sessionProfit.realizedPnlCents == null ? null : sessionProfit.realizedPnlCents / 100,
      settled_order_count: sessionProfit.settledOrderCount,
      fill_economics_verified: sessionProfit.realizedPnlCents != null,
    },
    open_position: openPosition == null ? null : (() => {
      // findOpenEthMartingalePosition only returns positive fills, but keep this
      // defensive fallback at the API boundary so the payload remains numeric.
      const filledContracts = openPosition.filledContracts ?? 0;
      return {
        ticker: openPosition.ticker,
        side: openPosition.side,
        requested_contracts: openPosition.requestedContracts,
        filled_contracts: filledContracts,
        remaining_contracts: Math.max(0, openPosition.requestedContracts - filledContracts),
        actual_notional_dollars: openPosition.actualNotionalDollars,
        outcome: openPosition.outcome,
        created_at_ms: openPosition.createdAtMs,
      };
    })(),
    blocker,
    manual_recovery_tickers: manualRecoveryTickers,
    manual_recovery: manualRecovery == null ? null : {
      id: manualRecovery.id,
      ticker: manualRecovery.ticker,
      eastern_date: manualRecovery.easternDate,
      declared_result: manualRecovery.declaredResult,
      reason: manualRecovery.reason,
      exchange_status: manualRecovery.exchangeStatus,
      exchange_result: manualRecovery.exchangeResult,
      created_at_ms: manualRecovery.createdAtMs,
    },
    orders: dashboard.orders,
  });
});

/**
 * POST /trade/martingale/recovery — emergency-only release of one current,
 * filled ETH order for which Kalshi still has no official result. It never
 * submits an order and has no arbitrary ticker or database-ID input.
 */
router.post("/trade/martingale/recovery", requireTradeAuth, requireEthRecoveryAuth, async (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  const acknowledgement = typeof body?.["acknowledgement"] === "string" ? body["acknowledgement"] : "";
  const reason = typeof body?.["reason"] === "string" ? body["reason"].trim() : "";
  const declaredResult = body?.["declared_result"];
  if (acknowledgement !== "MANUALLY_SETTLE_AND_RESET_ETH_TO_NO_BASE"
    || reason.length < 12 || reason.length > 500
    || (declaredResult !== "yes" && declaredResult !== "no")) {
    res.status(400).json({
      error: "Explicit acknowledgement, a 12–500 character reason, and declared_result yes/no are required",
      acknowledgement_required: "MANUALLY_SETTLE_AND_RESET_ETH_TO_NO_BASE",
    });
    return;
  }
  const candidates = await tradeStore.listEthMartingaleEmergencyRecoveryCandidates();
  if (candidates == null) {
    res.status(503).json({ error: "ETH martingale recovery ledger is unavailable" });
    return;
  }
  if (candidates.length !== 1) {
    res.status(409).json({
      error: candidates.length === 0 ? "No eligible unsettled ETH filled order exists" : "ETH recovery is ambiguous; multiple unsettled filled orders exist",
      candidate_count: candidates.length,
    });
    return;
  }
  const candidate = candidates[0]!;
  let market: Record<string, unknown> | null = null;
  try {
    const raw = await kalshiAuthFetch<Record<string, unknown>>(
      "GET", `/markets/${encodeURIComponent(candidate.ticker)}`,
    );
    market = raw["market"] as Record<string, unknown> | undefined ?? null;
  } catch (err) {
    req.log.warn({ err, ticker: candidate.ticker }, "ETH manual recovery exchange recheck failed");
    res.status(503).json({ error: "Kalshi market recheck failed; recovery remains fenced" });
    return;
  }
  const exchangeResult = market?.["result"];
  const exchangeStatus = typeof market?.["status"] === "string" ? market["status"] : "";
  if (exchangeResult === "yes" || exchangeResult === "no") {
    res.status(409).json({
      error: "Kalshi now has an official result; use normal reconciliation instead",
      ticker: candidate.ticker,
      exchange_result: exchangeResult,
    });
    return;
  }
  if (exchangeStatus !== "closed") {
    res.status(409).json({
      error: "Kalshi does not confirm the target market is closed without a result",
      ticker: candidate.ticker,
      exchange_status: exchangeStatus || null,
    });
    return;
  }
  const recovered = await tradeStore.manuallyRecoverEthMartingaleOrder({
    orderId: candidate.id,
    declaredResult,
    reason,
    acknowledgement,
    exchangeStatus,
  });
  if (recovered.kind === "unavailable") {
    res.status(503).json({ error: "ETH martingale recovery write failed; no state was released" });
    return;
  }
  if (recovered.kind === "conflict") {
    res.status(409).json({ error: "ETH recovery target changed; no state was released" });
    return;
  }
  // This only refreshes reconciliation state; it does not enter the order path.
  // The override is already committed, so a post-commit read failure must never
  // be reported as though the recovery was not applied.
  void reconcileEthMartingaleSettlements().catch((err) =>
    req.log.warn({ err }, "ETH recovery completed but blocker-status refresh failed"),
  );
  res.status(recovered.kind === "applied" ? 200 : 208).json({
    status: recovered.kind,
    recovery: recovered.recovery,
    next_state: { side: "no", martingale_step: 0 },
    order_submitted: false,
  });
});

/** GET /trade/daily-profit-stop/audit — authenticated, read-only stop history. */
router.get("/trade/daily-profit-stop/audit", requireTradeAuth, async (req, res) => {
  const requested = Number(req.query["limit"] ?? 100);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 100;
  const sqlRecords = await tradeStore.loadDailyProfitStopAuditsFromSql(limit);
  const records = sqlRecords.length > 0 ? sqlRecords : loadDailyProfitStopAuditFile(limit);
  res.json({
    source: sqlRecords.length > 0 ? "sql" : "file_fallback",
    records,
  });
});

/**
 * GET /trade/runtime-health — server-owned trading-runtime liveness snapshot.
 * This reads only API-process timers/state and Kalshi connection state; no
 * dashboard request, SSE client, or browser cache participates in this result.
 */
router.get("/trade/runtime-health", requireTradeAuth, async (_req, res) => {
  const nowMs = Date.now();
  const coverage = getCoverageStatus(nowMs);
  const quoteFor = (series: "KXBTC15M" | "KXETH15M") => {
    const rows = coverage.filter((row) => row.series === series);
    const newest = rows.sort((a, b) => (a.lastUsableQuoteAgeMs ?? Infinity) - (b.lastUsableQuoteAgeMs ?? Infinity))[0];
    return newest ? {
      ticker: newest.ticker,
      last_usable_quote_at: newest.lastUsableQuoteAgeMs == null ? null : new Date(nowMs - newest.lastUsableQuoteAgeMs).toISOString(),
      age_ms: newest.lastUsableQuoteAgeMs,
      coverage_state: newest.state,
    } : { ticker: null, last_usable_quote_at: null, age_ms: null, coverage_state: "unobserved" };
  };
  const sweeps = Object.values(getExchangeDiscoverySweepStatus());
  const lastReconciliationMs = sweeps.reduce<number | null>(
    (latest, sweep) => latest === null || sweep.lastRunAt > latest ? sweep.lastRunAt : latest, null,
  );

  const [dailyProfitStop, accountFingerprint, legacyActivity, eth30Activity, sol30Activity, manualRecovery, eth420BoundaryEvidence] = await Promise.all([
    getDailyProfitStopStatus(new Date(nowMs)),
    getAccountHistoryFingerprint(),
    tradeStore.loadEvaluationActivityForRuntimeHealth(300),
    tradeStore.loadEth30ActivityForRuntimeHealth(200),
    tradeStore.loadSol30ActivityForRuntimeHealth(200),
    tradeStore.loadLatestEthMartingaleRecoveryAudit(),
    // Passive reporting health only. This does not read or alter any candidate,
    // order, position, or strategy state.
    tradeStore.listEth420BoundaryResearchSnapshots(1),
  ]);
  const autoTrader = getAutoTraderStatus();
  res.json({
    generated_at: new Date(nowMs).toISOString(),
    generated_by: "api-server",
    browser_independent: true,
    process: { pid: process.pid, uptime_seconds: Math.floor(process.uptime()), started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString() },
    autotrader: autoTrader,
    kalshi_connection: { websocket_connected: kalshiStream.isConnected(), last_ticker_refresh_at: kalshiStream.lastRefreshAtMs ? new Date(kalshiStream.lastRefreshAtMs).toISOString() : null },
    usable_quotes: { btc: quoteFor("KXBTC15M"), eth: quoteFor("KXETH15M") },
    reconciliation: { last_discovery_sweep_at: lastReconciliationMs ? new Date(lastReconciliationMs).toISOString() : null, fill_repair: getFillReconciliationStatus() },
    daily_profit_lockout: { target_dollars: DAILY_PROFIT_TARGET_DOLLARS, ...dailyProfitStop },
    eth420_boundary_evidence: {
      availability: eth420BoundaryEvidence.availability,
      diagnostic_reason: eth420BoundaryEvidence.availability === "unavailable"
        ? eth420BoundaryEvidence.diagnosticReason
        : null,
    },
    eth_martingale_manual_recovery: manualRecovery == null ? null : {
      id: manualRecovery.id,
      ticker: manualRecovery.ticker,
      eastern_date: manualRecovery.easternDate,
      declared_result: manualRecovery.declaredResult,
      exchange_status: manualRecovery.exchangeStatus,
      created_at_ms: manualRecovery.createdAtMs,
    },
    protective_exit_monitor: getProtectiveExitMonitorStatus(),
    runtime_heartbeat: getRuntimeHeartbeatStatus(nowMs),
    strategy_activity: {
      // These are observability-only ledgers. They never feed the runtime entry
      // gate and are intentionally summarized independently to preserve ownership
      // isolation between the legacy strategy, ETH_30_50, and SOL_30_50.
      legacy: summarizeLegacyStrategyActivity(
        legacyActivity.events, nowMs, tradeStore.isStorageHealthy() && legacyActivity.available,
      ),
      eth_30_50: summarizeEth30StrategyActivity(
        eth30Activity.events, nowMs, tradeStore.isStorageHealthy() && eth30Activity.available,
      ),
      sol_30_50: summarizeSol30StrategyActivity(
        sol30Activity.events, nowMs, tradeStore.isStorageHealthy() && sol30Activity.available,
      ),
    },
    kalshi_account: {
      ...accountFingerprint,
      note: "Compare the fingerprint value between dev and production. Matching values confirm the same Kalshi account. The fingerprint is a one-way hash — it does not expose any account identifier.",
    },
  });
});

/** Server-owned watchdog history; independent of browser/dashboard activity. */
router.get("/trade/runtime-watchdog", requireTradeAuth, async (req, res) => {
  const requested = Number(req.query["limit"] ?? 250);
    const limit = Math.min(Number(req.query["limit"] ?? 100), 1_000);
  const sqlHistory = await loadRuntimeWatchdogHistoryFromSql(limit);
  res.json({ source: sqlHistory.length ? "sql" : "in_memory", status: getWatchdogStatus(), history: sqlHistory.length ? sqlHistory : getWatchdogHistory() });
});

/** Durable server-process evidence, not a dashboard reconstruction. */
router.get("/trade/runtime-lifecycle", requireTradeAuth, async (req, res) => {
  const limit = Math.min(Math.max(1, Number(req.query["limit"] ?? 250)), 1_000);
  const evidence = await tradeStore.loadRuntimeLifecycleEvidence(limit);
  res.json({ source: evidence.heartbeats.length ? "sql" : "unavailable", current: getRuntimeHeartbeatStatus(), ...evidence });
});

/** GET /trade/autotrader-status — live health of the autoTrader WS/REST trigger. */
router.get("/trade/autotrader-status", (_req, res) => {
  res.json(getAutoTraderStatus());
});

/** GET /trade/stale-gap-capture/status — passive research writer health only. */
router.get("/trade/stale-gap-capture/status", requireTradeAuth, (_req, res) => {
  res.json(getStaleGapPassiveCaptureStatus());
});

/** GET /trade/phase4b-capture/status — passive Phase 4B operational health only. */
router.get("/trade/phase4b-capture/status", requireTradeAuth, (_req, res) => {
  const status = getPhase4BPassiveCaptureStatus();
  res.json({
    enabled: status.enabled,
    referenceHistoryCorruptReloads: status.referenceHistoryCorruptReloads,
    enqueueAttempts: status.enqueueAttempts,
    successfulWrites: status.successfulWrites,
    failedWrites: status.failedWrites,
    queueDrops: status.queueDrops,
    mostRecentEnqueueAt: status.mostRecentEnqueueAt,
    mostRecentSuccessfulWriteAt: status.mostRecentSuccessfulWriteAt,
    mostRecentWriteError: status.mostRecentWriteError,
    fillReconciliation: getFillReconciliationStatus(),
  });
});

/** GET /trade/phase4b-capture/entry-gap-report — read-only reconstruction of
 *  entry-time BTC target distance for 90–95¢ cases from persisted records only.
 *  Merges live-capture rows (hypothesisVersion = entry-gap-90-95-v1) with
 *  historical backfill rows (backfillSource = "phase4b_reference_observations").
 *  Backfill rows are distinguishable by their backfillSource field. */
router.get("/trade/phase4b-capture/entry-gap-report", requireTradeAuth, async (_req, res) => {
  try {
    const [{ buildPhase4BEntryGapReport }, { PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION }] = await Promise.all([
      import("../lib/phase4b/entryGapReport.js"),
      import("../lib/phase4b/types.js"),
    ]);
    const [payloads, backfillPairs] = await Promise.all([
      tradeStore.listPhase4BProspectiveRecordsByHypothesisInSql(PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION),
      tradeStore.listPhase4BHistoricalSnapshotsForBackfillInSql(),
    ]);
    res.json(buildPhase4BEntryGapReport(payloads, backfillPairs));
  } catch (error) {
    res.status(503).json({ error: "entry_gap_report_unavailable", detail: error instanceof Error ? error.message : String(error) });
  }
});

/** GET /trade/phase4b-capture/entry-gap-backfill-report — one-time read-only
 *  reconstruction for historical 90–95¢ BTC cases that predate the live
 *  entry-gap-90-95-v1 capture path. Pairs persisted decision snapshots with
 *  their reference observations and derives causal gap values solely from
 *  fields recorded at the original capture time. Never writes or fetches live data. */
router.get("/trade/phase4b-capture/entry-gap-backfill-report", requireTradeAuth, async (_req, res) => {
  try {
    const [{ buildPhase4BEntryGapBackfillReport }] = await Promise.all([
      import("../lib/phase4b/entryGapReport.js"),
    ]);
    const pairs = await tradeStore.listPhase4BHistoricalSnapshotsForBackfillInSql();
    res.json(buildPhase4BEntryGapBackfillReport(pairs, Date.now()));
  } catch (error) {
    res.status(503).json({ error: "entry_gap_backfill_report_unavailable", detail: error instanceof Error ? error.message : String(error) });
  }
});

/** GET /trade/phase4b-capture/passive-counterfactual-report — settlement-only
 * passive experiment analysis. It cannot write, submit, alter a guard, or fetch
 * fresh market data; unavailable hypotheses stay unavailable in the response. */
router.get("/trade/phase4b-capture/passive-counterfactual-report", requireTradeAuth, async (_req, res) => {
  try {
    const { buildPassiveCounterfactualReport } = await import("../lib/phase4b/passiveCounterfactualReport.js");
    const captures = await tradeStore.listPassiveExperimentSettledCapturesInSql();
    res.json(buildPassiveCounterfactualReport(captures));
  } catch (error) {
    res.status(503).json({ error: "passive_counterfactual_report_unavailable", detail: error instanceof Error ? error.message : String(error) });
  }
});

/** Unified passive-program readiness only. It is deliberately separate from
 * execution status and has no controls or live-decision consumers. */
router.get("/trade/phase4b-capture/passive-program-readiness", requireTradeAuth, async (_req, res) => {
  try {
    const [{ buildPassiveCounterfactualReport }, { buildPassiveProgramReadiness }] = await Promise.all([
      import("../lib/phase4b/passiveCounterfactualReport.js"), import("../lib/phase4b/passiveProgramReadiness.js"),
    ]);
    const [captures, statusRows, compactShadow, pairedObservations, eth30Decisions] = await Promise.all([
      tradeStore.listPassiveExperimentSettledCapturesInSql(), tradeStore.listPassiveExperimentStatusRowsInSql(), getCompactShadowStatusInSql(),
      tradeStore.listAllEth30ShadowObservations(), tradeStore.listRecentEth30DecisionEvents(1_000),
    ]);
    res.json(buildPassiveProgramReadiness(statusRows, buildPassiveCounterfactualReport(captures), {
      phase4bPassiveCapture: getPhase4BPassiveCaptureStatus(), compactShadow, retention: getResearchRetentionStatus(),
      pairedSideLeadLag: summarizePairedSideStudy(pairedObservations, eth30Decisions),
    }));
  } catch (error) {
    res.status(503).json({ error: "passive_program_readiness_unavailable", detail: error instanceof Error ? error.message : String(error) });
  }
});

/** POST /trade/storage/retry — trigger an immediate database reconnect attempt.
 *  No-op when storage is already healthy. */
router.post("/trade/storage/retry", requireTradeAuth, (_req, res) => {
  if (tradeStore.isStorageHealthy()) {
    res.json({ triggered: false, reason: "storage already healthy" });
    return;
  }
  tradeStore.retryDatabaseConnectionNow();
  res.json({ triggered: true, database_retry_count: tradeStore.getDatabaseRetryCount() });
});

/**
 * POST /trade/reconcile/exchange — trigger the exchange-history discovery sweep
 * for today's Eastern date immediately.  Idempotent: re-running after a
 * successful sweep is a no-op (isExchangeDiscoverySweepComplete stays true).
 *
 * Runs in the background — the response returns as soon as the sweep is queued.
 */
router.post("/trade/reconcile/exchange", requireTradeAuth, (_req, res) => {
  const date = budget.date;
  void discoverAndReconcileMissingBotFills(date).catch((err) =>
    logger.warn({ err, date }, "trade: manual exchange reconciliation sweep failed"),
  );
  res.json({
    triggered:                        true,
    date,
    exchange_reconciliation_complete: isExchangeDiscoverySweepComplete(date),
  });
});

/**
 * POST /trade/halt — panic button. Body: { halted: boolean }
 *
 * Halting (halted: true) always succeeds.
 * Clearing (halted: false) is blocked with HTTP 409 while either env-var kill
 * switch is active — the environment lock cannot be overridden at runtime.
 */
router.post("/trade/halt", requireTradeAuth, (req, res) => {
  const { halted } = req.body as { halted?: unknown };
  if (typeof halted !== "boolean") {
    res.status(400).json({ error: "halted must be a boolean" });
    return;
  }
  if (!halted && isEnvLocked()) {
    // Refuse to clear the halt while any env-level lock is active (explicit kill
    // switch or workspace-environment detection).
    res.status(409).json({
      trading_halted:   true,
      environment_lock: true,
      error: "Trading cannot be enabled while an environment lock is active (AUTO_TRADING_ENABLED=false, TRADING_ENABLED=false, or workspace environment).",
    });
    return;
  }
  setTradingHalted(halted);
  logger.warn({ trading_halted: halted, environment_lock: isEnvLocked() }, "Trading halt flag changed");
  res.json({ trading_halted: isTradingHalted(), environment_lock: isEnvLocked() });
});

/** GET /trade/diagnose — pre-flight checks: key presence, RSA signing, Kalshi reachability.
 *  Requires trade auth — never exposed unauthenticated in any environment. */
router.get("/trade/diagnose", requireTradeAuth, async (_req, res) => {
  // 1. Synchronous auth checks (no network)
  const auth = diagnoseKalshiAuth();

  // 2. Kalshi host reachability — unauthenticated public endpoint, 5 s timeout
  let kalshiReachable = false;
  let kalshiPing: { status?: number; error?: string; url?: string } = {};
  const pingUrl = `${KALSHI_TRADE_BASE}/markets?limit=1`;
  try {
    const resp = await fetch(pingUrl, { signal: AbortSignal.timeout(5_000) });
    kalshiReachable = resp.status < 500;
    kalshiPing = { url: pingUrl, status: resp.status };
  } catch (e) {
    kalshiPing = { url: pingUrl, error: String(e) };
  }

  res.json({
    timestamp:       new Date().toISOString(),
    auth,
    kalshiReachable,
    kalshiPing,
    env: {
      KALSHI_API_KEY_ID:  process.env["KALSHI_API_KEY_ID"]  ? `set (${process.env["KALSHI_API_KEY_ID"].length} chars)` : "NOT SET",
      KALSHI_PRIVATE_KEY: process.env["KALSHI_PRIVATE_KEY"] ? `set (${process.env["KALSHI_PRIVATE_KEY"].length} chars)` : "NOT SET",
    },
  });
});

/**
 * GET /trade/account-fingerprint — confirms which Kalshi account this process
 * is authenticated as, using its fill history as the identity signal.
 *
 * Makes an authenticated GET /portfolio/fills call and paginates through the
 * full history to find the account's oldest fill. The fingerprint is a one-way
 * SHA-256 hash of that fill's stable fields (fill_id + created_time + ticker).
 *
 * Because fills are immutable and tied to exactly one account, this fingerprint
 * is stable and account-scoped. Compare the value between dev and production:
 * matching fingerprints confirm the same Kalshi account; a mismatch or an
 * "unavailable" status confirms different accounts or an auth failure.
 *
 * Requires trade auth — never exposed unauthenticated.
 */
router.get("/trade/account-fingerprint", requireTradeAuth, async (_req, res) => {
  const result = await getAccountHistoryFingerprint();
  res.json({
    ...result,
    note: "Compare the fingerprint value between dev and production. Matching values confirm the same Kalshi account. The fingerprint is a one-way hash — it does not expose any account identifier.",
  });
});

/** GET /trade/balance — portfolio balance, also confirms auth is working. */
router.get("/trade/balance", requireTradeAuth, async (_req, res) => {
  const kalshiUrl = `${KALSHI_TRADE_BASE}/portfolio/balance`;
  try {
    // ── Step 1: verify keys are present and RSA signing works ─────────────────
    // Fail fast with a 503 + diagnostic payload instead of a silent 502.
    const diag = diagnoseKalshiAuth();
    if (!diag.keyIdPresent || !diag.privateKeyPresent || !diag.signingWorks) {
      logger.error({ diag }, "Kalshi auth pre-flight failed — aborting balance request");
      res.status(503).json({
        error:      "Kalshi authentication not ready",
        details:    diag.errors.join("; "),
        status:     503,
        diagnostic: diag,
      });
      return;
    }

    // ── Step 2: call Kalshi ───────────────────────────────────────────────────
    // Quota-aware read: served from the shared cache when fresh; after a 429
    // the last known balance is returned marked stale instead of erroring.
    logger.info({ url: kalshiUrl }, "Kalshi balance: requesting");
    const activeEthExchangeIndex = getCurrentEthExchangeIndex();
    const [read, activeEthExchangeBalance] = await Promise.all([
      fetchKalshiBalanceRead(),
      activeEthExchangeIndex == null
        ? Promise.resolve(null)
        : fetchKalshiBalanceForExchangeRead(activeEthExchangeIndex).catch((err) => {
          logger.warn({ err, exchangeIndex: activeEthExchangeIndex }, "Active ETH exchange balance is unavailable for dashboard display");
          return null;
        }),
    ]);
    res.json(buildTradeBalanceDashboardResponse(read, activeEthExchangeIndex, activeEthExchangeBalance));
  } catch (err: unknown) {
    const e = err as { status?: number; body?: unknown; message?: string; stack?: string };

    // Log full context: request URL, Kalshi response status, body, and stack
    logger.error(
      {
        kalshiUrl,
        kalshiStatus: e.status,
        kalshiBody:   e.body,
        errorMessage: e.message,
      },
      "Kalshi balance fetch failed",
    );

    if (res.headersSent) return; // response already started — can't send error

    // ── Structured error response ─────────────────────────────────────────────
    // Forward the exact Kalshi JSON body when available; fall back to a
    // structured envelope so the caller always gets parseable JSON (never a
    // bare HTML 502 page).
    const httpStatus = typeof e.status === "number" ? e.status : 502;
    res.status(httpStatus).json({
      error:   "Kalshi request failed",
      details: e.message ?? String(err),
      status:  httpStatus,
      kalshi:  e.body ?? null,
      // Include stack in development to speed up debugging
      ...(process.env["NODE_ENV"] !== "production" && e.stack
        ? { stack: e.stack }
        : {}),
    });
  }
});

/**
 * GET /trade/active-runtime-verification — token-protected, read-only proof
 * that the active API process uses one configured Kalshi credential source for
 * orders, account history, exits, and reconciliation. No account ID, balance,
 * access key, or private key is returned.
 */
router.get("/trade/active-runtime-verification", requireTradeAuth, async (_req, res) => {
  const auth = diagnoseKalshiAuth();
  let portfolioReadAuthenticated = false;
  let portfolioReadError: string | null = null;
  if (auth.keyIdPresent && auth.privateKeyPresent && auth.signingWorks) {
    try {
      await fetchKalshiBalance();
      portfolioReadAuthenticated = true;
    } catch (error) {
      portfolioReadError = error instanceof Error ? error.message : "Kalshi portfolio read failed";
    }
  }
  const dailyProfit = await getDailyProfitStopStatus();
  const storage = await tradeStore.getEvidenceStorageHealth();
  const runtimeActive = getAutoTraderStatus();
  const verificationReady = portfolioReadAuthenticated
    && dailyProfit.state !== "unavailable"
    && storage.source === "sql_authoritative"
    && storage.tables.every((table) => table.state === "ok");

  res.status(verificationReady ? 200 : 503).json({
    generatedAt: new Date().toISOString(),
    runtime: "workspace_api_server",
    credentialSourceFingerprint: getKalshiCredentialFingerprint(),
    authentication: {
      signedPortfolioReadAccepted: portfolioReadAuthenticated,
      signingReady: auth.signingWorks,
      error: portfolioReadError,
    },
    sharedCredentialClient: {
      autoTraderOrderSubmission: "kalshiAuthFetch",
      accountHistoryAndDailyProfitLockout: "kalshiAuthFetch",
      protectiveExits: "kalshiAuthFetch",
      fillReconciliation: "kalshiAuthFetch",
    },
    runtimeComponents: {
      autoTrader: runtimeActive,
      dailyProfitLockout: {
        targetDollars: DAILY_PROFIT_TARGET_DOLLARS,
        source: dailyProfit.source,
        state: dailyProfit.state,
        retrievedAt: dailyProfit.retrievedAt,
      },
      protectiveExits: getProtectiveExitMonitorStatus(),
      reconciliation: getFillReconciliationStatus(),
    },
    durableSqlEvidence: {
      source: storage.source,
      databaseFingerprint: storage.databaseFingerprint,
      allRequiredTablesReadable: storage.tables.every((table) => table.state === "ok"),
      warnings: storage.warnings,
    },
    verificationReady,
    sensitiveValuesOmitted: ["kalshi_api_key_id", "kalshi_private_key", "kalshi_account_id", "portfolio_balance"],
  });
});

/**
 * POST /trade/order
 * Body: { ticker, side, count, outcome_price_cents, trigger_bid_cents, client_order_id, tier_version? }
 *
 * `tier_version` is REQUIRED for all external HTTP callers.  It must match
 * PRICE_TIERS_VERSION (the server's current canonical tier hash).  A mismatch
 * — or an absent field — means the client's tier definitions may have drifted,
 * which could cause the client to compute a wrong dedup key or wrong order
 * size, so the order is rejected (HTTP 409) until the client re-fetches
 * GET /api/trade/tiers and retries with the returned version string.
 *
 * The server-side autoTrader bypasses this route entirely (it calls placeOrder()
 * directly within the same process), so the requirement only applies to
 * external HTTP callers such as a browser client or curl.
 *
 * Book-side translation (V2 quotes everything from the YES leg):
 *   YES at X¢  →  side:"bid",  price = X / 100
 *   NO  at X¢  →  side:"ask",  price = (100 − X) / 100
 *
 * Both branches now send the identical V2 field set. The old YES branch also
 * sent `type`, `action` and `outcome_side` — legacy v1 fields absent from the
 * V2 schema — and formatted `count` differently from the NO branch.
 */
router.post("/trade/order", requireTradeAuth, async (req, res) => {
  // This must remain before body parsing, dedup/budget reservations, and all
  // exchange helpers. Only evaluateEthNoMartingale may create a new position.
  if (isManualNewOrderSubmissionDisabled()) {
    res.status(403).json({
      error: "MANUAL_ORDERING_DISABLED",
      message: "Only the ETH martingale strategy may submit new live orders.",
    });
    return;
  }
  const _body = req.body as {
    ticker?: string;
    side?: string;
    count?: number;
    outcome_price_cents?: number;
    trigger_bid_cents?: number;
    client_order_id?: string;
    tier_version?: string;
  };
  if (
    typeof _body.ticker              !== "string" ||
    typeof _body.side                !== "string" ||
    typeof _body.count               !== "number" ||
    typeof _body.outcome_price_cents !== "number" ||
    typeof _body.client_order_id     !== "string"
  ) {
    res.status(400).json({ error: "Missing or invalid required fields: ticker, side, count, outcome_price_cents, client_order_id" });
    return;
  }
  const ticker              = _body.ticker              as string;
  const side                = _body.side                as "yes" | "no";
  const count               = _body.count               as number;
  const outcome_price_cents = _body.outcome_price_cents as number;
  const client_order_id     = _body.client_order_id     as string;
  const trigger_bid_cents   = _body.trigger_bid_cents;
  const tier_version        = _body.tier_version;
  // External/manual requests must obey the exact same outcome-side hard band
  // as autoTrader. Do this before claiming dedup, budget, position, SQL, or
  // submitting an order so an invalid price cannot consume state.
  if (!Number.isInteger(outcome_price_cents) || !isPriceInBand(outcome_price_cents)) {
    logger.warn(
      { ticker, side, client_order_id, outcome_price_cents, priceFloorCents: PRICE_FLOOR_CENTS, priceCapCents: PRICE_CAP_CENTS },
      "POST /trade/order blocked by hard price band",
    );
    res.status(422).json({
      error: `Outcome price must be a whole number of cents within ${PRICE_FLOOR_CENTS}–${PRICE_CAP_CENTS}¢`,
      outcome_price_cents,
      price_floor_cents: PRICE_FLOOR_CENTS,
      price_cap_cents: PRICE_CAP_CENTS,
    });
    return;
  }
  // Manual/browser orders always obey the global halt. DOGE's exception is
  // intentionally limited to the dedicated DOGE strategy and cannot unlock
  // this generic endpoint.
  if (isTradingHalted()) {
    logger.warn({ ticker, side, client_order_id }, "POST /trade/order blocked by global trading halt");
    res.status(503).json({ error: "TRADING_HALTED", trading_halted: true, environment_lock: isEnvLocked() });
    return;
  }
  const notionalCents       = count * outcome_price_cents;
  const dailyProfitGuard = await allowNewInvestment(ticker);
  if (!dailyProfitGuard.allowed) {
    logger.warn({ ticker, side, dailyProfitStop: dailyProfitGuard.status }, "POST /trade/order blocked by DAILY_PROFIT_STOP");
    res.status(503).json({ error: "DAILY_PROFIT_STOP", daily_profit_stop: dailyProfitGuard.status });
    return;
  }

  // ── Dedup slot ────────────────────────────────────────────────────────────
  if (!claimOrderSlot(ticker, side)) {
    logger.warn({ ticker, side, client_order_id }, "Duplicate order blocked by server-side dedup");
    res.status(409).json({ error: `An order for ${ticker} ${side} is already open in this window` });
    return;
  }

  // ── Daily cap ─────────────────────────────────────────────────────────────
  if (!reserveNotional(notionalCents)) {
    releaseOrderSlot(ticker, side);
    logger.warn(
      { ticker, side, notionalCents, spentCents: budget.spentCents, cap: MAX_DAILY_NOTIONAL_CENTS },
      "Order blocked by daily notional cap",
    );
    res.status(429).json({
      error: `Daily notional cap reached: ${budget.spentCents} of ${MAX_DAILY_NOTIONAL_CENTS} cents used`,
    });
    return;
  }

  const unwind = () => {
    releaseOrderSlot(ticker, side);
    releaseNotional(notionalCents);
  };

  // ── Position guard ────────────────────────────────────────────────────────
  try {
    const position = await getSignedPosition(ticker);
    const wouldReduce = (side === "no" && position > 0) || (side === "yes" && position < 0);
    if (wouldReduce) {
      unwind();
      logger.warn(
        { ticker, side, position },
        "Order blocked: would close the existing position rather than open new exposure",
      );
      res.status(409).json({
        error:
          `Holding ${position} contracts on ${ticker}. A '${side}' order here would close that ` +
          `position instead of opening new exposure, so it was not submitted.`,
      });
      return;
    }
  } catch (err) {
    // Fail closed: without a position read we cannot tell open from close.
    unwind();
    logger.error({ err, ticker }, "Position check failed — order not submitted");
    res.status(502).json({ error: "Could not read the current position, so the order was not submitted" });
    return;
  }

  // ── SQL pre-commit ────────────────────────────────────────────────────────
  // Must succeed (and be awaited) before the Kalshi API call so every live
  // order always has a matching SQL record. If the write fails, the order is
  // aborted — no order can reach Kalshi without a database record.
  const _sqlReserve = await tradeStore.reserveAndRecord({
    clientOrderId:          client_order_id,
    ticker,
    series:                 ticker.match(/^(KX[A-Z0-9]+15M)/)?.[1] ?? "",
    windowCloseTime:        null,
    side,
    source:                 "api",
    triggerPriceCents:      trigger_bid_cents ?? outcome_price_cents,
    limitPriceCents:        outcome_price_cents,
    requestedContracts:     count,
    requestedNotionalCents: notionalCents,
    easternDate:            easternDay(new Date()),
  });
  if (!_sqlReserve.claimed) {
    unwind();
    logger.warn(
      { ticker, side, reason: _sqlReserve.reason },
      "POST /trade/order: SQL pre-commit rejected — order not submitted",
    );
    res.status(503).json({
      error: `Order blocked: storage ${_sqlReserve.reason ?? "error"} — retry in a few seconds`,
    });
    return;
  }

  // ── Book-side translation ─────────────────────────────────────────────────
  const bookPrice = side === "no" ? 100 - outcome_price_cents : outcome_price_cents;
  const priceDecimal = (bookPrice / 100).toFixed(4);

  const orderBody = {
    ticker,
    client_order_id,
    side: side === "no" ? "ask" : "bid",
    count: `${count}.00`,
    price: priceDecimal,
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };

  logger.info(
    {
      requested_outcome: side,
      requested_outcome_price_cents: outcome_price_cents,
      trigger_bid_cents,
      submitted_book_side: orderBody.side,
      submitted_price_decimal: priceDecimal,
      notional_cents: notionalCents,
      daily_spent_cents: budget.spentCents,
      count,
      ticker,
      client_order_id,
    },
    "Placing Kalshi order",
  );

  try {
    // Final new-entry gate: all manual/browser orders are checked immediately
    // before the exchange request. It is intentionally not shared with any
    // protective-exit route, and releases the same reservations a zero-fill
    // response would release.
    if (isTradingHalted()) {
      unwind();
      void tradeStore.finaliseOrderAttempt({
        clientOrderId: client_order_id,
        outcome: "zero_fill",
        zeroFillDiagnostic: "TRADING_HALTED",
      });
      void tradeStore.releaseDedupSlotInSql(ticker, side);
      void tradeStore.releaseBudgetInSql(easternDay(new Date()), notionalCents);
      logger.warn({ ticker, side, client_order_id }, "POST /trade/order blocked by final global trading halt");
      res.status(503).json({ error: "TRADING_HALTED", trading_halted: true, environment_lock: isEnvLocked() });
      return;
    }
    if (!isNewEntryPermitted(ticker)) {
      unwind();
      void tradeStore.finaliseOrderAttempt({
        clientOrderId: client_order_id,
        outcome: "zero_fill",
        zeroFillDiagnostic: WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
      });
      void tradeStore.releaseDedupSlotInSql(ticker, side);
      void tradeStore.releaseBudgetInSql(easternDay(new Date()), notionalCents);
      logger.info(
        {
          ticker, side, client_order_id,
          entry_series_policy: ACTIVE_ENTRY_SERIES_POLICY,
          permitted_series: [WEEK_2_PRODUCTION_NEW_ENTRY_SERIES],
          reason: WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
        },
        "POST /trade/order withheld by entry-series policy",
      );
      res.status(403).json({
        error: "Entry-series policy withheld new entry for this ticker",
        reason: WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON,
        entry_series_policy: ACTIVE_ENTRY_SERIES_POLICY,
        permitted_series: [WEEK_2_PRODUCTION_NEW_ENTRY_SERIES],
      });
      return;
    }
    const data = await kalshiAuthFetch<{ order?: Record<string, unknown>; fills?: Fill[] }>("POST", "/portfolio/orders", orderBody);

    const order = (data.order ?? {}) as Record<string, unknown>;
    const kalshiOrderId = typeof order["order_id"] === "string" ? order["order_id"] : "";
    const fillCount = Number(order["fill_count"] ?? 0);
    const remaining = Number(order["remaining_count"] ?? 0);

    // ── Compute actual cost from per-fill prices ──────────────────────────────
    // The submitted `outcome_price_cents` is only the LIMIT price. Fills may
    // occur at price improvement (actual ≤ limit for buys), so the budget
    // should reflect what was truly paid, not the limit. This prevents the
    // server from over-counting spend and blocking valid future orders.
    const fills = data.fills ?? [];
    let actualCostCents = 0;
    let fillPricesKnown = false;

    if (fills.length > 0 && fillCount > 0) {
      fillPricesKnown = true;
      for (const fill of fills) {
        const fc = parseFloat(String(fill["count_fp"] ?? fill["count"] ?? "0")) || 0;
        if (fc === 0) continue;
        let outcomePriceDollars: number;
        if (side === "no") {
          const np = parseFloat(String(fill["no_price_dollars"] ?? fill["no_price"] ?? ""));
          const p  = parseFloat(String(fill["price"] ?? ""));
          // Raw `price` is always YES-leg; complement converts to NO cost
          outcomePriceDollars = !isNaN(np) ? np : !isNaN(p) ? 1 - p : NaN;
        } else {
          const yp = parseFloat(String(fill["yes_price_dollars"] ?? fill["yes_price"] ?? ""));
          const p  = parseFloat(String(fill["price"] ?? ""));
          outcomePriceDollars = !isNaN(yp) ? yp : !isNaN(p) ? p : NaN;
        }
        if (isNaN(outcomePriceDollars)) {
          fillPricesKnown = false;
          outcomePriceDollars = outcome_price_cents / 100; // conservative fallback
        }
        actualCostCents += Math.round(fc * outcomePriceDollars * 100);
      }
    } else if (fillCount > 0) {
      // No fills array in response — fall back to submitted price (conservative)
      actualCostCents = fillCount * outcome_price_cents;
    }

    // Unused notional = reserved amount − actual cost of filled contracts.
    // Always non-negative: with IOC, fills cannot exceed the limit price.
    const unusedNotionalCents = Math.max(0, notionalCents - actualCostCents);

    // Average fill price for logging and SQL (falls back to submitted price)
    const avgFillPriceCents = fillCount > 0 && fillPricesKnown && fills.length > 0
      ? Math.round(actualCostCents / fillCount)
      : outcome_price_cents;

    // Immediate-or-cancel often expires unfilled. Nothing was bought, so give
    // back both the dedup slot and the budget — the next tick may do better.
    if (fillCount === 0) {
      unwind();
      logger.info({ ticker, side, client_order_id }, "Order expired without a fill");
      void tradeStore.finaliseOrderAttempt({ clientOrderId: client_order_id, outcome: "zero_fill" });
      void tradeStore.releaseDedupSlotInSql(ticker, side);
      void tradeStore.releaseBudgetInSql(easternDay(new Date()), notionalCents);
    } else if (fillCount < count) {
      // Partial fill: release unused notional (price improvement + unfilled contracts)
      if (unusedNotionalCents > 0) releaseNotional(unusedNotionalCents);
      releaseOrderSlot(ticker, side); // allow immediate retry for remaining contracts
      logger.info(
        { ticker, side, fillCount, count, actualCostCents, unusedNotionalCents, avgFillPriceCents, fillPricesKnown },
        "Order partially filled — slot released for retry",
      );
      void tradeStore.finaliseOrderAttempt({
        clientOrderId:   client_order_id,
        outcome:         "partial_fill",
          orderId:         kalshiOrderId || null,
        fillCount,
        remainingCount:  count - fillCount,
        fillPriceCents:  avgFillPriceCents,
        notionalDollars: actualCostCents / 100,
      }).then(() => tradeStore.captureGreenZoneSnapshot(client_order_id));
      void tradeStore.releaseDedupSlotInSql(ticker, side);
      if (unusedNotionalCents > 0) {
        void tradeStore.releaseBudgetInSql(easternDay(new Date()), unusedNotionalCents);
      }
    } else {
      // Full fill — dedup slot stays held to prevent duplicate orders.
      // Release any unused notional from price improvement so the budget
      // accurately reflects what was actually paid rather than the limit price.
      if (unusedNotionalCents > 0) releaseNotional(unusedNotionalCents);
      logger.info(
        { ticker, side, fillCount, actualCostCents, unusedNotionalCents, avgFillPriceCents, fillPricesKnown },
        "Order fully filled",
      );
      void tradeStore.finaliseOrderAttempt({
        clientOrderId:   client_order_id,
        outcome:         "full_fill",
          orderId:         kalshiOrderId || null,
        fillCount,
          remainingCount:  remaining,
          contracts:       fillCount,
        fillPriceCents:  avgFillPriceCents,
        notionalDollars: actualCostCents / 100,
      }).then(() => tradeStore.captureGreenZoneSnapshot(client_order_id));
      if (unusedNotionalCents > 0) {
        void tradeStore.releaseBudgetInSql(easternDay(new Date()), unusedNotionalCents);
      }
    }

    // Post-fill reconciliation is analytics-only: it reads Kalshi's fills endpoint
    // with retries and persists normalized order_fills rows. It never retries or
    // modifies the submitted order.
    if (fillCount > 0 && kalshiOrderId) {
      void reconcileOrder(client_order_id, kalshiOrderId, side, outcome_price_cents, ticker)
        .catch((err: unknown) =>
          logger.warn({ err, client_order_id, kalshiOrderId }, "Manual order fill reconciliation failed"),
        );
    } else if (fillCount > 0) {
      logger.warn({ client_order_id, ticker, fillCount }, "Filled manual order response missing Kalshi order_id; normalized fill reconciliation skipped");
    }

    res.json({ ...order, fill_count: fillCount, remaining_count: remaining });
  } catch (err: unknown) {
    unwind();
    void tradeStore.finaliseOrderAttempt({ clientOrderId: client_order_id, outcome: "zero_fill", zeroFillDiagnostic: String(err) });
    void tradeStore.releaseDedupSlotInSql(ticker, side);
    void tradeStore.releaseBudgetInSql(easternDay(new Date()), notionalCents);
    const e = err as { status?: number; body?: unknown; message?: string };
    logger.error({ err, ticker, side }, "Kalshi order failed");
    res.status(e.status ?? 502).json({ error: e.body ?? e.message ?? "Kalshi rejected the order" });
  }
});

/**
 * GET /trade/positions
 * Open market positions enriched with current bid/ask from the public API.
 */
router.get("/trade/positions", requireTradeAuth, async (_req, res) => {
  try {
    // Shared quota-aware cache: dashboard polling across any number of open
    // tabs coalesces into at most one Kalshi call per TTL, and a 429 serves
    // the last known snapshot marked stale instead of a retry burst.
    const posRead = await fetchSharedKalshiPositions();
    const posData = posRead.value;

    const positions = posData.market_positions ?? [];
    const tickers = positions.map((p) => p["ticker"] as string).filter(Boolean);

    // Bounded concurrency — 100 simultaneous fetches used to risk a 429 that
    // took out the whole endpoint.
    const marketResults = await mapWithConcurrency(tickers, 5, async (t) => {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`);
      const d = (await r.json()) as Record<string, unknown>;
      return { ticker: t, market: d["market"] as Record<string, unknown> | undefined };
    });

    const marketMap: Record<string, Record<string, unknown>> = {};
    for (const r of marketResults) {
      if (r.status === "fulfilled" && r.value.market) {
        marketMap[r.value.ticker] = r.value.market;
      }
    }

    const enriched = positions.map((p) => ({
      ...p,
      market: marketMap[p["ticker"] as string] ?? null,
    }));

    res.json({ ...posData, market_positions: enriched, stale: posRead.stale });
  } catch (err: unknown) {
    const e = err as { status?: number; body?: unknown; message?: string };
    logger.error({ err }, "Kalshi positions fetch failed");
    res.status(e.status ?? 502).json({ error: e.body ?? e.message ?? "Kalshi request failed" });
  }
});

/** GET /trade/orders?limit= — recent orders. */
router.get("/trade/orders", requireTradeAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query["limit"] ?? 25), 100);
    const qs = new URLSearchParams({ limit: String(limit) });
    const data = await kalshiAuthFetch<{ orders?: unknown[] }>("GET", `/portfolio/orders?${qs}`);
    res.json(data);
  } catch (err: unknown) {
    const e = err as { status?: number; body?: unknown; message?: string };
    logger.error({ err }, "Kalshi orders fetch failed");
    res.status(e.status ?? 502).json({ error: e.body ?? e.message ?? "Kalshi request failed" });
  }
});

/** GET /trade/fills?limit=&status= — fills enriched with market result for P&L.
 *
 * Kalshi's fills endpoint is capped at 100 per page. When the caller requests
 * more than 100 fills we paginate automatically using the cursor Kalshi returns
 * until we have accumulated `limit` fills or the API reports no further pages.
 */
router.get("/trade/fills", requireTradeAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query["limit"] ?? 100), 1_000);

    // Cached per requested limit through the shared quota-aware read path:
    // concurrent dashboard refreshes coalesce into one paginated sweep, and a
    // Kalshi 429 serves the last known fills view marked stale instead of
    // re-paginating in a burst.
    const read = await sharedFillsViewCache.get(`limit=${limit}`, async () => {
      // Paginate through Kalshi's 100-per-page fills endpoint.
      const PAGE_SIZE = 100;
      const fills: Fill[] = [];
      let cursor: string | undefined;

      while (fills.length < limit) {
        const remaining = limit - fills.length;
        const pageLimit = Math.min(remaining, PAGE_SIZE);
        const qs = new URLSearchParams({ limit: String(pageLimit) });
        if (cursor) qs.set("cursor", cursor);

        const page = await kalshiAuthFetch<{ fills?: Fill[]; cursor?: string }>(
          "GET",
          `/portfolio/fills?${qs}`,
        );

        const pageFills = page.fills ?? [];
        fills.push(...pageFills);

        // Stop if Kalshi returned fewer than a full page or no next cursor.
        if (pageFills.length < pageLimit || !page.cursor) break;
        cursor = page.cursor;
      }

      const uniqueTickers = [...new Set(fills.map((f) => f.ticker))];
      const resultMap: Record<string, string> = {};

      await mapWithConcurrency(uniqueTickers, 5, async (ticker) => {
        resultMap[ticker] = await getMarketResult(ticker);
      });

      return fills.map((f) => ({
        ...f,
        market_result: resultMap[f.ticker] ?? "",
      }));
    });

    res.json({ fills: read.value, stale: read.stale });
  } catch (err: unknown) {
    const e = err as { status?: number; body?: unknown; message?: string };
    logger.error({ err }, "Kalshi fills fetch failed");
    res.status(e.status ?? 502).json({ error: e.body ?? e.message ?? "Kalshi request failed" });
  }
});

interface Fill {
  ticker: string;
  side: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  count_fp: string;
  fee_cost: string;
  [key: string]: unknown;
}

// ── Window log ────────────────────────────────────────────────────────────────

router.get("/trade/window-log", (_req, res) => {
  res.json({ windows: getWindowLog() });
});

// ── Passive observation status ────────────────────────────────────────────────

router.get("/trade/passive-observations/status", (_req, res) => {
  const today   = easternDay(new Date());
  const obsPath = join(DATA_DIR, `three-minute-observations-${today}.ndjson`);
  const malPath = join(DATA_DIR, `three-minute-obs-malformed-${today}.ndjson`);

  let validCount      = 0;
  let malformedCount  = 0;
  let earliestMs: number | null  = null;
  let latestMs:   number | null  = null;
  let btcCount    = 0;
  let ethCount    = 0;
  let yesCount    = 0;
  let noCount     = 0;

  // Parse today's observation file
  try {
    const lines = readFileSync(obsPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as {
          timestampMs: number;
          asset: string;
          hypotheticalSide: string | null;
        };
        validCount++;
        if (earliestMs === null || r.timestampMs < earliestMs) earliestMs = r.timestampMs;
        if (latestMs   === null || r.timestampMs > latestMs)   latestMs   = r.timestampMs;
        if (r.asset === "BTC") btcCount++;
        if (r.asset === "ETH") ethCount++;
        if (r.hypotheticalSide === "yes") yesCount++;
        if (r.hypotheticalSide === "no")  noCount++;
      } catch { /* skip unparseable line */ }
    }
  } catch { /* file not yet created */ }

  // Count today's malformed records
  try {
    const mlines = readFileSync(malPath, "utf8").split("\n").filter(Boolean);
    malformedCount = mlines.filter((l) => { try { JSON.parse(l); return true; } catch { return false; } }).length;
  } catch { /* file not yet created */ }

  res.json({
    easternDate:        today,
    observationFile:    `three-minute-observations-${today}.ndjson`,
    validRecordCount:   validCount,
    malformedCount,
    earliestMs,
    earliestIso:        earliestMs ? new Date(earliestMs).toISOString() : null,
    latestMs,
    latestIso:          latestMs   ? new Date(latestMs).toISOString()   : null,
    btcCount,
    ethCount,
    qualifyingYesCount: yesCount,
    qualifyingNoCount:  noCount,
  });
});

/**
 * GET /trade/analytics/evaluation-events
 *
 * Returns recent server evaluation decision events from today and yesterday
 * so the Dashboard can correlate browser quote alerts to the nearest server
 * decision after the window closes.
 *
 * Query parameters:
 *   ticker  — filter to a specific market ticker (optional)
 *   limitMs — only return events from the last N ms (default 24 h; 0 = all)
 *
 * No trade-auth required — no sensitive data, observability-only.
 */
router.get("/trade/analytics/evaluation-events", requireTradeAuth, async (req, res) => {
  try {
    const limitMs = req.query["limitMs"] != null ? Number(req.query["limitMs"]) : 24 * 60 * 60 * 1_000;
    const resolvedLimitMs = isNaN(limitMs) ? 24 * 60 * 60 * 1_000 : limitMs;

    // Primary: SQL (survives disk resets and deployment restarts).
    // Fallback: NDJSON files (for the transition period or when DB is unhealthy).
    let events = await tradeStore.loadRecentEvaluationEventsFromSql(resolvedLimitMs);
    if (events.length === 0) {
      events = loadRecentEvaluationEvents(resolvedLimitMs);
    }

    const ticker = req.query["ticker"];
    if (typeof ticker === "string" && ticker.length > 0) {
      events = events.filter((e) => e.ticker === ticker);
    }

    // Evaluation events retain the BBO-derived quote that triggered a check.
    // Preflight records retain the fresh executable L2 result. The two are
    // joined only for this read-only observability response.
    const earliestEventMs = events.reduce(
      (earliest, event) => Math.min(earliest, event.timestampMs),
      Date.now(),
    );
    const preflightLookbackDays = events.length === 0
      ? 0
      : Math.max(2, Math.ceil((Date.now() - earliestEventMs) / 86_400_000) + 2);
    const preflights = preflightLookbackDays > 0
      ? await tradeStore.loadPreflightDecisionsFromSqlForRange(preflightLookbackDays)
      : [];
    const eventsWithEvidence = attachPreflightEvidence(events, preflights);

    res.json({ events: eventsWithEvidence, count: eventsWithEvidence.length });
  } catch (err) {
    logger.warn({ err }, "trade: evaluation-events read failed");
    res.json({ events: [], count: 0 });
  }
});

export type Eth420CandidateHistoryData = {
  entries: Awaited<ReturnType<typeof tradeStore.listEth420CounterfactualEntries>>;
  state: Awaited<ReturnType<typeof tradeStore.getEth420CandidateState>>;
  recentOrders: Awaited<ReturnType<typeof tradeStore.listRecentEth420CandidateLiveOrders>>;
  telemetry: Awaited<ReturnType<typeof tradeStore.listEth420CandidateTelemetry>>;
  dailyPnl: Awaited<ReturnType<typeof tradeStore.listEth420CandidateDailyPnl>>;
};

type Eth420FinalizedReconciliationAlert = {
  ticker: string;
  latestRecoveryOutcome: string | null;
  finalizedAtMs: number;
  ageMs: number;
  nextSafeAction: "await_automatic_reconciliation";
};

export type Eth420CandidateHistoryLoaders = {
  listEntries: typeof tradeStore.listEth420CounterfactualEntries;
  getState: typeof tradeStore.getEth420CandidateState;
  listOrders: typeof tradeStore.listRecentEth420CandidateLiveOrders;
  listTelemetry: typeof tradeStore.listEth420CandidateTelemetry;
  listDailyPnl: typeof tradeStore.listEth420CandidateDailyPnl;
};

const defaultEth420CandidateHistoryLoaders: Eth420CandidateHistoryLoaders = {
  listEntries: tradeStore.listEth420CounterfactualEntries,
  getState: tradeStore.getEth420CandidateState,
  listOrders: tradeStore.listRecentEth420CandidateLiveOrders,
  listTelemetry: tradeStore.listEth420CandidateTelemetry,
  listDailyPnl: tradeStore.listEth420CandidateDailyPnl,
};

/**
 * Loads bounded dashboard history independently from the full-ledger rollup.
 * A failed rollup must remain distinguishable from an empty or zero-P&L day.
 */
export async function loadEth420CandidateHistoryData(
  limit: number,
  nowMs: number = Date.now(),
  loaders: Eth420CandidateHistoryLoaders = defaultEth420CandidateHistoryLoaders,
): Promise<Eth420CandidateHistoryData> {
  const [entries, state, telemetry] = await Promise.all([
    loaders.listEntries(limit),
    loaders.getState(easternDay(new Date(nowMs))),
    loaders.listTelemetry(nowMs - ETH_420_HISTORY_DAYS * 86_400_000),
  ]);
  const recentOrders = await loaders.listOrders(Math.min(limit, 100))
    .catch(() => ({ available: false, orders: [] }));
  const dailyPnl = await loaders.listDailyPnl().catch(() => ({ available: false, rows: [] }));
  return { entries, state, recentOrders, telemetry, dailyPnl };
}

export function buildEth420CandidateHistoryResponse(
  data: Eth420CandidateHistoryData,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const { entries, state, recentOrders, telemetry, dailyPnl } = data;
  const orders = recentOrders.orders;
  const validatedMove = (row: typeof telemetry[number]): number | null => {
    try {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      const open = payload["openTimeMs"], priorOpen = payload["priorOpenTimeMs"];
      const priorStrike = payload["priorFloorStrike"], move = payload["currentMove"];
      if (payload["schemaVersion"] !== 2 || payload["validAdjacentMove"] !== true
        || !Number.isFinite(row.floorStrike) || row.floorStrike! <= 0
        || !Number.isFinite(open) || !Number.isFinite(priorOpen)
        || !Number.isInteger(open) || !Number.isInteger(priorOpen)
        || Number(open) % 900_000 !== 0 || Number(priorOpen) % 900_000 !== 0
        || Number(open) - Number(priorOpen) !== 900_000
        || !Number.isFinite(priorStrike) || Number(priorStrike) <= 0
        || !Number.isFinite(move) || Number(move) < 0) return null;
      const recomputed = Math.abs(row.floorStrike! - Number(priorStrike)) / Number(priorStrike);
      return Math.abs(recomputed - Number(move)) < 1e-12 ? Number(move) : null;
    } catch { return null; }
  };
  const validMoves = telemetry.map(validatedMove).filter((move): move is number => move != null).sort((a, b) => a - b);
  const latestTelemetry = [...telemetry].sort((a, b) => b.observedAtMs - a.observedAtMs)[0] ?? null;
  const latestMove = latestTelemetry == null ? null : validatedMove(latestTelemetry);
  const unresolvedOrders = orders.filter((order) => order.status !== "settled" && order.status !== "rejected_insufficient_balance");
  const finalizedReconciliationAlerts: Eth420FinalizedReconciliationAlert[] = orders
    .filter((order) => order.status !== "settled"
      && order.status !== "rejected_insufficient_balance"
      && order.settlementResult == null
      && Number.isSafeInteger(order.finalizedAtMs)
      && nowMs - order.finalizedAtMs! >= ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS)
    .map((order) => ({
      ticker: order.ticker,
      latestRecoveryOutcome: order.lastRecoveryOutcome ?? null,
      finalizedAtMs: order.finalizedAtMs!,
      ageMs: nowMs - order.finalizedAtMs!,
      nextSafeAction: "await_automatic_reconciliation" as const,
    }));
  const stateConsistent = state != null && Number.isInteger(state.step) && state.step >= 0 && state.step <= 5;
  const safetyState = !ETH_420_CANDIDATE_EXECUTION_APPROVED || process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] !== "true"
    ? { status: "disabled", reason: "live_execution_not_enabled" }
    : unresolvedOrders.length > 0
      ? { status: "blocked_unresolved_prior_order", reason: "candidate_lifecycle_unresolved" }
      : !stateConsistent && orders.length > 0
        ? { status: "blocked_missing_or_inconsistent_state", reason: "durable_state_unavailable_or_invalid" }
        : { status: "unavailable_pending_market_evaluation", reason: "no_persisted_current_evaluation" };
  return {
    label: "ETH_420_6_STEP_RESET_SHADOW_ONLY",
    counterfactual: true,
    execution: "NO_ORDER_NO_RESERVATION_ZERO_FILL_ASSUMPTION",
    executionApproved: ETH_420_CANDIDATE_EXECUTION_APPROVED,
    shadowEnabled: process.env["ETH_420_CANDIDATE_SHADOW_ENABLED"] === "true",
    liveEnabled: process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true",
    state,
    orders,
    ordersAvailability: { available: recentOrders.available },
    finalizedReconciliation: {
      available: recentOrders.available,
      thresholdMs: ETH_420_FINALIZED_RECONCILIATION_ALERT_THRESHOLD_MS,
      alerts: recentOrders.available ? finalizedReconciliationAlerts : [],
    },
    entries,
    dailyPnl,
    operationalStatus: {
      nextNormalWagerCents: stateConsistent ? ETH_420_PRINCIPALS_CENTS[state.step] : null,
      unresolvedLifecycleCount: unresolvedOrders.length,
      safetyState,
      telemetry: {
        validObservationCount: validMoves.length,
        requiredObservationCount: ETH_420_MIN_HISTORY,
        currentMove: latestMove,
        p95: validMoves.length >= ETH_420_MIN_HISTORY ? percentile(validMoves, .95) : null,
        p99: validMoves.length >= ETH_420_MIN_HISTORY ? percentile(validMoves, .99) : null,
        jumpReady: validMoves.length >= ETH_420_MIN_HISTORY,
        jumpFired: null,
        latestObservedAtMs: latestTelemetry?.observedAtMs ?? null,
      },
      prospectiveDailyLoss: { status: "unavailable", reason: "no persisted current evaluation evidence" },
    },
  };
}

/** Read-only, explicitly counterfactual ETH 420 rehearsal history. */
router.get("/trade/analytics/eth420-candidate-history", requireTradeAuth, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 100) || 100));
  res.json(buildEth420CandidateHistoryResponse(await loadEth420CandidateHistoryData(limit)));
});

/**
 * Read-only evidence check for one ordinary, current primary. This is not a
 * global secondary-cross activation authorization: callers must still apply
 * every separate operational release requirement. A submitted local row is
 * not treated as exposure-free without an exact, current exchange read.
 * This endpoint never schedules, cancels, or submits.
 */
router.get("/trade/eth420-candidate/secondary-primary-readiness", requireTradeAuth, async (_req, res) => {
  const current = await tradeStore.readCurrentEth420CandidateLivePosition();
  if (!current.available) {
    res.status(503).json({
      eligiblePrimary: false,
      reason: "candidate_ledger_unavailable",
      livePrimaryEnabled: process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true",
      secondaryCrossEnabled: process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] === "true",
      scope: "per_primary_evidence_only",
    });
    return;
  }
  const primary = current.position;
  let exchangeOrder: {
    orderId: string; clientOrderId: string; ticker: string; status: string | null; filledContracts: number | null;
  } | null = null;
  if (primary?.kalshiOrderId) {
    try {
      const raw = await kalshiAuthFetch<Record<string, unknown>>(
        "GET", `/portfolio/orders/${encodeURIComponent(primary.kalshiOrderId)}`,
      );
      const wire = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
      const parsed = parseKalshiOrderResponse(raw, primary.requestedContracts);
      exchangeOrder = {
        orderId: parsed.kalshiOrderId ?? "",
        clientOrderId: typeof wire["client_order_id"] === "string" ? wire["client_order_id"] : "",
        ticker: typeof wire["ticker"] === "string" ? wire["ticker"] : "",
        status: parsed.orderStatus,
        filledContracts: parsed.fillCountProvided && Number.isInteger(parsed.fillCount) ? parsed.fillCount : null,
      };
    } catch {
      // A failed live exchange read remains identity-uncertain and therefore
      // fail-closed through the shared readiness evaluator below.
    }
  }
  const readiness = evaluateEth420SecondaryActivationReadiness(primary, exchangeOrder);
  res.json({
    eligiblePrimary: readiness.ready,
    reason: readiness.ready ? null : readiness.reason,
    livePrimaryEnabled: process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true",
    secondaryCrossEnabled: process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] === "true",
    scope: "per_primary_evidence_only",
    primary: primary == null ? null : {
      id: primary.id,
      ticker: primary.ticker,
      status: primary.status,
      kalshiOrderId: primary.kalshiOrderId,
      createdAtMs: primary.createdAtMs,
    },
  });
});

/**
 * Read-only global evidence assessment for a future secondary-cross release.
 * This endpoint is intentionally not an activation control: it never changes
 * environment state and is not consumed by timers or the order execution path.
 */
router.get("/trade/eth420-candidate/secondary-cross-activation-assessment", requireTradeAuth, async (_req, res) => {
  const ledger = await tradeStore.readEth420CandidateSecondaryActivationLedger();
  const activationCutover = await tradeStore.getEth420SecondaryActivationCutover();
  const candidates = await Promise.all(ledger.orders.map(async (primary) => {
    let exchangeOrder: Eth420SecondaryEntryExchangeOrder | null = null;
    if (primary.kalshiOrderId) {
      try {
        const raw = await kalshiAuthFetch<Record<string, unknown>>(
          "GET", `/portfolio/orders/${encodeURIComponent(primary.kalshiOrderId)}`,
        );
        const wire = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
        const parsed = parseKalshiOrderResponse(raw, primary.requestedContracts);
        exchangeOrder = {
          orderId: parsed.kalshiOrderId ?? "",
          clientOrderId: typeof wire["client_order_id"] === "string" ? wire["client_order_id"] : "",
          ticker: typeof wire["ticker"] === "string" ? wire["ticker"] : "",
          status: parsed.orderStatus,
          filledContracts: parsed.fillCountProvided && Number.isInteger(parsed.fillCount) ? parsed.fillCount : null,
        };
      } catch {
        // A failed authenticated exchange read is deliberately represented as
        // incomplete evidence and remains blocking in the pure assessment.
      }
    }
    return { primary, exchangeOrder };
  }));
  const productionHealthy = tradeStore.isStorageHealthy() && isRuntimeEntryHealthy();
  const assessment = assessEth420SecondaryGlobalActivation({
    productionHealthy,
    candidateLedgerAvailable: ledger.available,
    candidateLedgerComplete: ledger.complete,
    emergencyLifecycleExists: ledger.emergencyLifecycleExists,
    activationCutover,
    candidates,
  });
  res.json({
    assessment: assessment.safe ? "SAFE" : "NOT_SAFE",
    safe: assessment.safe,
    scope: "global_eth420_secondary_cross_evidence_only",
    productionHealthy,
    candidateLedgerAvailable: ledger.available,
    candidateLedgerComplete: ledger.complete,
    emergencyLifecycleExists: ledger.emergencyLifecycleExists,
    activationCutover,
    unresolvedCandidateCount: ledger.orders.length,
    blockers: assessment.blockers,
    flags: {
      livePrimaryEnabled: process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true",
      secondaryCrossEnabled: process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] === "true",
    },
  });
});

/**
 * Creates the immutable, forward-only boundary for a later secondary-cross
 * release. This does not enable any flag and never reads, cancels, submits, or
 * updates a candidate order.
 */
router.post("/trade/eth420-candidate/secondary-cross-activation-cutover", requireTradeAuth, requireEthRecoveryAuth, async (req, res) => {
  if (req.body?.confirmation !== "GRANDFATHER_EXISTING_ETH420_PRIMARIES") {
    res.status(400).json({ error: "confirmation must be GRANDFATHER_EXISTING_ETH420_PRIMARIES" });
    return;
  }
  const activation = await tradeStore.activateEth420SecondaryActivationCutover();
  if (!activation) {
    res.status(503).json({ error: "activation cutover could not be durably recorded" });
    return;
  }
  res.json({
    created: activation.created,
    activationCutover: activation.cutover,
    flags: {
      livePrimaryEnabled: process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true",
      secondaryCrossEnabled: process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] === "true",
    },
  });
});

/**
 * Operator-only emergency exit for a filled ETH420 candidate order.  This is
 * intentionally not wired to any monitor, timer, UI, or normal settlement
 * path. The idempotency reservation is durable before the POST; therefore a
 * process crash or lost exchange acknowledgement leaves an explicit blocker
 * rather than risking a second sale.
 */
async function reconcileEth420EmergencyReductionCommand(
  reduction: tradeStore.Eth420EmergencyReduction,
): Promise<"completed" | "resolved_blocking" | "recovery_required"> {
  try {
    let exitOrderId = reduction.exitKalshiOrderId;
    let order: Record<string, unknown> | undefined;
    if (exitOrderId) {
      const raw = await kalshiAuthFetch<Record<string, unknown>>("GET", `/portfolio/orders/${encodeURIComponent(exitOrderId)}`);
      order = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
    } else {
      // Exact deterministic client identity is the only permitted lost-ack
      // lookup. A missing or multiply-matched response remains unresolved.
      const raw = await kalshiAuthFetch<{ orders?: Array<Record<string, unknown>> }>(
        "GET", `/portfolio/orders?client_order_id=${encodeURIComponent(reduction.clientOrderId)}&ticker=${encodeURIComponent(reduction.ticker)}&limit=100`,
      );
      const matches = (raw.orders ?? []).filter((entry) => entry["client_order_id"] === reduction.clientOrderId && entry["ticker"] === reduction.ticker);
      if (matches.length !== 1 || typeof matches[0]?.["order_id"] !== "string") return "recovery_required";
      order = matches[0]; exitOrderId = String(order["order_id"]);
    }
    const status = typeof order["status"] === "string" ? order["status"].toLowerCase() : "";
    if (!exitOrderId || order["order_id"] !== exitOrderId || order["ticker"] !== reduction.ticker
      || order["client_order_id"] !== reduction.clientOrderId || order["side"] !== reduction.expectedExitSide
      || order["time_in_force"] !== "immediate_or_cancel"
      || !["executed", "filled", "canceled", "cancelled", "rejected", "expired"].includes(status)) return "recovery_required";
    let cursor: string | null = null, fills = 0, fee = 0;
    const seen = new Set<string>();
    for (;;) {
      const query: URLSearchParams = new URLSearchParams({ order_id: exitOrderId, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page: { fills?: Array<Record<string, unknown>>; cursor?: unknown } = await kalshiAuthFetch("GET", `/portfolio/fills?${query}`);
      if (!Array.isArray(page.fills)) return "recovery_required";
      for (const fill of page.fills) {
        if (fill["order_id"] !== exitOrderId || (fill["ticker"] ?? fill["market_ticker"]) !== reduction.ticker) return "recovery_required";
        const count = Number(fill["count_fp"] ?? fill["count"]);
        const fillFee = Number(fill["fee_cost_dollars"] ?? fill["fee_dollars"]);
        if (!Number.isInteger(count) || count < 0 || !Number.isFinite(fillFee) || fillFee < 0) return "recovery_required";
        fills += count; fee += fillFee;
      }
      if (page.cursor == null || page.cursor === "") break;
      if (typeof page.cursor !== "string" || seen.has(page.cursor)) return "recovery_required";
      seen.add(page.cursor); cursor = page.cursor;
    }
    const positions = await kalshiAuthFetch<{ market_positions?: Array<Record<string, unknown>> }>("GET", `/portfolio/positions?ticker=${encodeURIComponent(reduction.ticker)}`);
    const row = positions.market_positions?.find((position) => position["ticker"] === reduction.ticker);
    const residual = Number(row?.["position_fp"] ?? row?.["position"] ?? 0);
    if (!Number.isInteger(residual) || fills < 0 || fills > reduction.requestedContracts) return "recovery_required";
    const expectedSign = reduction.heldSide === "yes" ? 1 : -1;
    const expectedResidual = expectedSign * (reduction.requestedContracts - fills);
    // A terminal zero-fill did not reduce exposure. It is durable evidence but
    // remains deliberately blocking for a new explicit operator decision.
    const exactTerminal = fills === reduction.requestedContracts && residual === 0;
    const outcome = exactTerminal ? "completed" : "resolved_blocking";
    if (!await tradeStore.reconcileEth420CandidateEmergencyReduction({
      idempotencyKey: reduction.idempotencyKey, exitKalshiOrderId: exitOrderId, fillContracts: fills,
      feeDollars: fee.toFixed(4), residualPosition: residual, outcome,
    })) return "recovery_required";
    return outcome;
  } catch { return "recovery_required"; }
}

router.post("/trade/eth420-candidate/emergency-reduce", requireTradeAuth, requireEthRecoveryAuth, async (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  const confirmation = body?.["confirmation"];
  const candidateOrderId = body?.["candidate_order_id"];
  const idempotencyKey = body?.["idempotency_key"];
  const contracts = body?.["contracts"];
  const reason = body?.["reason"];
  if (confirmation !== "REDUCE_ETH420_CANDIDATE_POSITION"
    || typeof candidateOrderId !== "string" || !candidateOrderId
    || typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)
    || !Number.isInteger(contracts) || (contracts as number) < 1
    || typeof reason !== "string" || reason.trim().length < 12 || reason.trim().length > 500) {
    res.status(400).json({ error: "Typed confirmation, bounded reason, candidate_order_id, idempotency_key, and positive integer contracts are required" });
    return;
  }
  const requestedContracts = contracts as number;
  const existingReduction = await tradeStore.getEth420CandidateEmergencyReduction(idempotencyKey);
  if (existingReduction) {
    const outcome = await reconcileEth420EmergencyReductionCommand(existingReduction);
    res.status(202).json({ outcome, reduction: await tradeStore.getEth420CandidateEmergencyReduction(idempotencyKey) });
    return;
  }
  // An idempotent replay deliberately does not re-read a potentially changed
  // exchange position and never POSTs again.
  const already = await tradeStore.reserveEth420CandidateEmergencyReduction({
    idempotencyKey, candidateOrderId, ticker: "__idempotency_probe__", candidateKalshiOrderId: "__probe__",
    heldSide: "yes", requestedContracts, clientOrderId: `eth420-reduce:${idempotencyKey}`, expectedExitSide: "ask",
    operatorReason: reason, confirmation, submittedLimitPriceCents: 1, exchangeIndex: 0,
  });
  if (already.kind === "existing") {
    const outcome = await reconcileEth420EmergencyReductionCommand(already.reduction);
    res.status(202).json({ outcome, reduction: await tradeStore.getEth420CandidateEmergencyReduction(idempotencyKey) });
    return;
  }
  // The probe is expected to be blocked for a new key because its immutable
  // candidate identity cannot match. It avoids adding a separate unaudited
  // idempotency read API.
  const candidate = await tradeStore.getEth420CandidateLiveOrder(candidateOrderId);
  if (!candidate?.kalshiOrderId || candidate.filledContracts == null || candidate.filledContracts !== requestedContracts) {
    res.status(409).json({ error: "Candidate order is not a verified filled reduction target" });
    return;
  }
  try {
    const orderResponse = await kalshiAuthFetch<Record<string, unknown>>(
      "GET", `/portfolio/orders/${encodeURIComponent(candidate.kalshiOrderId)}`,
    );
    const order = (orderResponse["order"] as Record<string, unknown> | undefined) ?? orderResponse;
    const expectedClientId = candidate.secondaryClientOrderId ?? candidate.id;
    const filled = Number(order["fill_count_fp"] ?? order["filled_contracts"] ?? order["fill_count"]);
    const status = typeof order["status"] === "string" ? order["status"].toLowerCase() : "";
    if (order["order_id"] !== candidate.kalshiOrderId || order["ticker"] !== candidate.ticker
      || order["client_order_id"] !== expectedClientId || !["executed", "filled"].includes(status)
      || !Number.isInteger(filled) || filled !== candidate.filledContracts) {
      res.status(409).json({ error: "Fresh authenticated candidate order verification failed" });
      return;
    }
    const fills = await kalshiAuthFetch<{ fills?: Array<Record<string, unknown>> }>(
      "GET", `/portfolio/fills?order_id=${encodeURIComponent(candidate.kalshiOrderId)}&limit=100`,
    );
    const exactFilled = fills.fills?.reduce((total, fill) => {
      if (fill["order_id"] !== candidate.kalshiOrderId || (fill["ticker"] ?? fill["market_ticker"]) !== candidate.ticker) return NaN;
      return total + Number(fill["count_fp"] ?? fill["count"]);
    }, 0);
    if (!Number.isInteger(exactFilled) || exactFilled !== candidate.filledContracts) {
      res.status(409).json({ error: "Fresh authenticated full fill evidence is incomplete" });
      return;
    }
    const positions = await kalshiAuthFetch<{ market_positions?: Array<Record<string, unknown>> }>(
      "GET", `/portfolio/positions?ticker=${encodeURIComponent(candidate.ticker)}`,
    );
    const position = positions.market_positions?.find((row) => row["ticker"] === candidate.ticker);
    const rawPosition = position?.["position_fp"] ?? position?.["position"];
    const signed = Number(rawPosition);
    const expectedSign = candidate.side === "yes" ? 1 : -1;
    if (!Number.isInteger(signed) || signed * expectedSign !== candidate.filledContracts || requestedContracts !== candidate.filledContracts) {
      res.status(409).json({ error: "Fresh authenticated position verification failed" });
      return;
    }
    const book = await kalshiAuthFetch<Record<string, unknown>>(
      "GET", `/markets/${encodeURIComponent(candidate.ticker)}/orderbook`,
    );
    // Kalshi's YES-book convention is asymmetric: selling a held YES is an
    // ask, while closing a held NO is a YES bid. Never issue an ask for NO.
    const yesBidLevels = parseExitSellBids(book as any, "yes").sort((a, b) => b.priceCents - a.priceCents);
    // A NO holder is flattened by buying YES. parseOrderbookResponse("yes")
    // converts NO-side asks into YES-price terms; the lowest YES ask is the
    // executable bid limit and its available supply is the relevant depth.
    const yesAskLevels = parseOrderbookResponse(book as any, "yes").sort((a, b) => a.priceCents - b.priceCents);
    const levels = candidate.side === "yes" ? yesBidLevels : yesAskLevels;
    const instruction = eth420EmergencyReductionInstruction(
      candidate.side, yesBidLevels[0]?.priceCents ?? 0, yesAskLevels[0]?.priceCents ?? 0,
    );
    const depth = levels.reduce((sum, level) => sum + level.contractsApprox, 0);
    const limitPriceCents = instruction?.limitPriceCents;
    const market = await kalshiAuthFetch<Record<string, unknown>>(
      "GET", `/markets/${encodeURIComponent(candidate.ticker)}`,
    );
    const marketRow = (market["market"] as Record<string, unknown> | undefined) ?? market;
    const exchangeIndex = Number(marketRow["exchange_index"] ?? order["exchange_index"]
      ?? (order["market"] as Record<string, unknown> | undefined)?.["exchange_index"]);
    if (!instruction || !limitPriceCents || depth < requestedContracts || !Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
      res.status(409).json({ error: "Fresh executable exit book or exchange index verification failed" });
      return;
    }
    (candidate as typeof candidate & { emergencyExitPriceCents: number; emergencyExchangeIndex: number; emergencyExitSide: "ask" | "bid" }).emergencyExitPriceCents = instruction.limitPriceCents;
    (candidate as typeof candidate & { emergencyExitPriceCents: number; emergencyExchangeIndex: number; emergencyExitSide: "ask" | "bid" }).emergencyExchangeIndex = exchangeIndex;
    (candidate as typeof candidate & { emergencyExitPriceCents: number; emergencyExchangeIndex: number; emergencyExitSide: "ask" | "bid" }).emergencyExitSide = instruction.side;
  } catch {
    res.status(503).json({ error: "Fresh authenticated exchange verification unavailable" });
    return;
  }
  const reservation = await tradeStore.reserveEth420CandidateEmergencyReduction({
    idempotencyKey, candidateOrderId, ticker: candidate.ticker, candidateKalshiOrderId: candidate.kalshiOrderId,
    heldSide: candidate.side, requestedContracts, clientOrderId: `eth420-reduce:${idempotencyKey}`,
    operatorReason: reason, confirmation,
    expectedExitSide: (candidate as any).emergencyExitSide,
    submittedLimitPriceCents: (candidate as any).emergencyExitPriceCents,
    exchangeIndex: (candidate as any).emergencyExchangeIndex,
  });
  if (reservation.kind === "blocked") {
    res.status(409).json({ error: "Emergency reduction could not be durably reserved" });
    return;
  }
  if (reservation.kind === "existing") {
    res.status(202).json({ outcome: "already_reserved", reduction: reservation.reduction });
    return;
  }
  try {
    const response = await kalshiAuthFetch<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker: candidate.ticker, client_order_id: `eth420-reduce:${idempotencyKey}`, side: (candidate as any).emergencyExitSide,
      count: `${requestedContracts}.00`, price: ((candidate as any).emergencyExitPriceCents / 100).toFixed(4),
      exchange_index: (candidate as any).emergencyExchangeIndex,
      time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross",
    });
    const parsed = parseKalshiOrderResponse(response, requestedContracts);
    if (!parsed.kalshiOrderId || !await tradeStore.acknowledgeEth420CandidateEmergencyReduction(
      idempotencyKey, parsed.kalshiOrderId, "submitted",
    )) {
      res.status(202).json({ outcome: "recovery_required", reduction: reservation.reduction });
      return;
    }
    const outcome = await reconcileEth420EmergencyReductionCommand(
      (await tradeStore.getEth420CandidateEmergencyReduction(idempotencyKey))!,
    );
    res.status(202).json({ outcome, idempotencyKey, exitOrderId: parsed.kalshiOrderId });
  } catch {
    // Do not release the reservation: transport ambiguity is exposure ambiguity.
    await tradeStore.acknowledgeEth420CandidateEmergencyReduction(idempotencyKey, null, "submission_ambiguous", "transport_or_provider_ambiguity");
    res.status(202).json({ outcome: "recovery_required", idempotencyKey });
  }
});

/**
 * Reset only the current ETH 420 candidate recovery step. This deliberately
 * uses the server-only recovery credential and delegates all lifecycle/state
 * protection to the single atomic store operation.
 */
router.post("/trade/eth420-candidate/reset-step", requireTradeAuth, requireEthRecoveryAuth, async (_req, res) => {
  const easternDate = easternDay(new Date());
  const result = await tradeStore.resetEth420CandidateStepToZero(easternDate);
  if (result.kind === "storage_unavailable") {
    res.status(503).json({ error: "ETH 420 candidate reset is unavailable" });
    return;
  }
  if (result.kind === "no_current_state") {
    res.status(409).json({ error: "No current ETH 420 candidate state exists", easternDate });
    return;
  }
  if (result.kind === "unresolved_lifecycle") {
    res.status(409).json({ error: "ETH 420 candidate reset blocked by unresolved lifecycle", easternDate });
    return;
  }
  const successfulResult = result;
  logger.warn({
    easternDate, resetId: successfulResult.kind === "applied" ? successfulResult.resetId : null,
    before: successfulResult.before, after: successfulResult.after, outcome: successfulResult.kind,
  }, "ETH 420 candidate operator step reset");
  res.json({ easternDate, outcome: successfulResult.kind,
    resetId: successfulResult.kind === "applied" ? successfulResult.resetId : null,
    before: successfulResult.before, after: successfulResult.after });
});

export interface Eth420LiveMarketTelemetry {
  ticker: string;
  observedAtMs: number;
  floorStrike: number | null;
  payloadJson: string;
}

/**
 * Builds display-only ETH 420 evidence from already observed state. Candidate
 * telemetry is immutable per ticker, while quotes and market rules retain
 * independent 20-second freshness gates.
 */
export async function buildEth420LiveMarketResponse(
  snapshot: CurrentEthMarketSnapshot | null,
  loadTelemetry: (afterMs: number) => Promise<Eth420LiveMarketTelemetry[]>,
  nowMs: number = Date.now(),
): Promise<Record<string, unknown>> {
  const unavailable = (reason: string, market: Record<string, unknown> | null = null) => ({
    generatedAtMs: nowMs,
    readOnly: true,
    availability: { status: "unavailable", reason },
    market,
    evidence: null,
    adjacentMoveAvailability: { status: "unavailable", reason: "quote_or_market_evidence_unavailable" },
  });
  if (!snapshot) return unavailable("active_eth_market_not_observed");

  const openTimeMs = snapshot.openTime == null ? NaN : Date.parse(snapshot.openTime);
  const closeTimeMs = snapshot.closeTime == null ? NaN : Date.parse(snapshot.closeTime);
  const market = {
    ticker: snapshot.ticker,
    exchangeIndex: snapshot.exchangeIndex,
    openTime: snapshot.openTime,
    closeTime: snapshot.closeTime,
    status: snapshot.status,
    quoteUpdatedAtMs: snapshot.quoteUpdatedAtMs,
  };
  if (!Number.isFinite(openTimeMs) || !Number.isFinite(closeTimeMs) || closeTimeMs <= nowMs) {
    return unavailable("active_eth_market_timing_unavailable_or_closed", market);
  }

  const quoteAgeMs = snapshot.quoteUpdatedAtMs == null ? null : nowMs - snapshot.quoteUpdatedAtMs;
  if (quoteAgeMs == null || quoteAgeMs < 0 || quoteAgeMs > 20_000) {
    return {
      generatedAtMs: nowMs,
      readOnly: true,
      availability: { status: "stale", reason: "latest_quote_is_stale", quoteAgeMs },
      market,
      evidence: null,
      adjacentMoveAvailability: { status: "unavailable", reason: "quote_or_market_evidence_unavailable" },
    };
  }

  const validPrice = (price: number | null): price is number =>
    typeof price === "number" && Number.isInteger(price) && price >= 0 && price <= 100;
  if (![snapshot.yesBid, snapshot.yesAsk, snapshot.noBid, snapshot.noAsk].every(validPrice)
    || snapshot.yesAsk! < snapshot.yesBid! || snapshot.noAsk! < snapshot.noBid!
    || !Number.isFinite(snapshot.floorStrike) || snapshot.floorStrike! <= 0
    || snapshot.rulesObservedAtMs == null || nowMs - snapshot.rulesObservedAtMs > 20_000) {
    return unavailable("current_quote_or_market_rule_evidence_invalid", market);
  }

  let telemetry: Eth420LiveMarketTelemetry[] = [];
  let adjacentMoveReason: string | null = null;
  try {
    telemetry = await loadTelemetry(openTimeMs);
  } catch {
    adjacentMoveReason = "current_adjacent_move_evidence_unavailable";
  }
  const latest = telemetry
    .filter((row) => row.ticker === snapshot.ticker)
    .sort((a, b) => b.observedAtMs - a.observedAtMs)[0] ?? null;
  let adjacentMove: number | null = null;
  if (latest) {
    try {
      const payload = JSON.parse(latest.payloadJson) as Record<string, unknown>;
      const priorStrike = payload["priorFloorStrike"];
      const open = payload["openTimeMs"];
      const priorOpen = payload["priorOpenTimeMs"];
      const move = payload["currentMove"];
      const isValid = payload["schemaVersion"] === 2
        && payload["validAdjacentMove"] === true
        && Number.isFinite(priorStrike) && Number(priorStrike) > 0
        && Number.isInteger(open) && Number.isInteger(priorOpen)
        && Number(open) % 900_000 === 0 && Number(priorOpen) % 900_000 === 0
        && Number(open) - Number(priorOpen) === 900_000
        && Number.isFinite(move) && Number(move) >= 0;
      const strikeMatchesCurrentMarket = latest.floorStrike === snapshot.floorStrike;
      const recomputed = isValid && Number.isFinite(latest.floorStrike) && latest.floorStrike! > 0
        ? Math.abs(latest.floorStrike! - Number(priorStrike)) / Number(priorStrike)
        : NaN;
      if (isValid && strikeMatchesCurrentMarket && Math.abs(recomputed - Number(move)) < 1e-12) {
        adjacentMove = Number(move);
      }
    } catch { /* Invalid telemetry is reported below as unavailable evidence. */ }
  }
  if (adjacentMove == null && adjacentMoveReason == null) {
    adjacentMoveReason = "validated_adjacent_move_not_current";
  }

  return {
    generatedAtMs: nowMs,
    readOnly: true,
    availability: { status: "fresh", reason: null, quoteAgeMs },
    market,
    evidence: {
      yesBid: snapshot.yesBid,
      yesAsk: snapshot.yesAsk,
      noBid: snapshot.noBid,
      noAsk: snapshot.noAsk,
      yesSpreadCents: snapshot.yesAsk! - snapshot.yesBid!,
      noSpreadCents: snapshot.noAsk! - snapshot.noBid!,
      floorStrike: snapshot.floorStrike,
      adjacentMove,
    },
    adjacentMoveAvailability: adjacentMove == null
      ? { status: "unavailable", reason: adjacentMoveReason }
      : { status: "fresh", reason: null },
  };
}

/**
 * Read-only current ETH 15-minute market evidence for the ETH 420 dashboard.
 * This consumes only already-observed cache and durable telemetry; it cannot
 * start an evaluation, mutate candidate state, reserve funds, or submit orders.
 */
router.get("/trade/analytics/eth420-live-market", requireTradeAuth, async (_req, res) => {
  let positionTimeout: ReturnType<typeof setTimeout> | null = null;
  let livePosition: Awaited<ReturnType<typeof tradeStore.readCurrentEth420CandidateLivePosition>> = {
    available: false, position: null,
  };
  try {
    livePosition = await Promise.race([
      tradeStore.readCurrentEth420CandidateLivePosition(),
      new Promise<{ available: false; position: null }>((resolve) => {
        positionTimeout = setTimeout(() => resolve({ available: false, position: null }), 1_000);
      }),
    ]);
  } finally {
    if (positionTimeout) clearTimeout(positionTimeout);
  }
  // Capture and validate runner evidence after the independently bounded
  // ledger read so freshness is measured at response time, not request start.
  const nowMs = Date.now();
  const candidatePosition = !livePosition.available
    ? { availability: "unavailable", reason: "durable_candidate_ledger_unavailable", position: null }
    : livePosition.position == null
      ? { availability: "available", reason: null, position: null }
      : {
        availability: "available",
        reason: null,
        position: {
          ticker: livePosition.position.ticker,
          side: livePosition.position.side,
          step: livePosition.position.step,
          intendedWagerCents: livePosition.position.effectiveWagerCents,
          kalshiOrderId: livePosition.position.kalshiOrderId,
          lifecycleStatus: livePosition.position.status,
          requestedContracts: livePosition.position.requestedContracts,
          filledContracts: livePosition.position.filledContracts,
          restingContracts: null,
          averageFillPriceCents: livePosition.position.fillPriceCents,
          principalCommittedDollars: livePosition.position.actualNotionalDollars,
          feesDollars: livePosition.position.actualFeeDollars,
          realizedPnlDeltaCents: livePosition.position.realizedPnlDeltaCents,
          settlementResult: livePosition.position.settlementResult,
        },
      };
  const evidenceResponse = await buildEth420LiveMarketResponse(
    getCurrentEthMarketSnapshot(),
    (afterMs) => tradeStore.listEth420CandidateTelemetry(afterMs),
    nowMs,
  );
  res.json({ ...evidenceResponse, candidatePosition });
});

/**
 * GET /trade/analytics/market-data-coverage
 *
 * Final-window market-data coverage status per active ticker plus recent
 * durable data-gap incidents (with recovery attempts and outcomes).
 * Read-only observability — never touches trading state.
 *
 * Responds with telemetryState:"degraded" (and empty lists) when the
 * telemetry itself cannot be read, so the dashboard shows an explicit
 * unknown state instead of implying a healthy window.
 */
router.get("/trade/analytics/market-data-coverage", requireTradeAuth, async (req, res) => {
  try {
    const limitMs = req.query["limitMs"] != null ? Number(req.query["limitMs"]) : 24 * 60 * 60 * 1_000;
    const resolvedLimitMs = isNaN(limitMs) ? 24 * 60 * 60 * 1_000 : limitMs;
    const status = getCoverageStatus();
    // Prefer SQL (survives redeploys); fall back to NDJSON when SQL is
    // unavailable or returns nothing (e.g. fresh deployment, DB degraded).
    let incidents = await loadRecentCoverageIncidentsFromSql(resolvedLimitMs);
    if (incidents.length === 0) {
      incidents = loadRecentCoverageIncidents(resolvedLimitMs);
    }
    let audits = await loadRecentCoverageWindowAuditsFromSql(resolvedLimitMs);
    if (audits.length === 0) audits = loadCoverageWindowAudits(resolvedLimitMs);
    // The in-memory rows include live, unsealed windows; SQL includes durable
    // final history across restarts. Never infer a missing row as healthy.
    const liveAudits = getCoverageWindowAudits();
    const byId = new Map(audits.map((audit) => [audit.auditId, audit]));
    for (const audit of liveAudits) byId.set(audit.auditId, audit);
    const records = [...byId.values()];
    res.json({
      telemetryState: "ok",
      source: audits.length > 0 ? "sql" : "file_fallback",
      retentionDays: 8,
      evidenceCompleteness: records.every((audit) => audit.evidenceCompleteness === "complete")
        ? "complete"
        : "restart_continuity_unknown",
      status,
      incidents,
      audits: records,
    });
  } catch (err) {
    logger.warn({ err }, "trade: market-data-coverage read failed");
    res.json({ telemetryState: "degraded", status: [], incidents: [], audits: [] });
  }
});

/** Authenticated, SQL-first evidence storage and source-health inventory. */
router.get("/trade/analytics/storage-health", requireTradeAuth, async (_req, res) => {
  try {
    res.json(await tradeStore.getEvidenceStorageHealth());
  } catch (err) {
    logger.warn({ err }, "trade: storage-health read failed");
    res.status(503).json({
      source: "environment_local_fallback",
      databaseFingerprint: null,
      generatedAt: new Date().toISOString(),
      warnings: ["sql_unavailable", "environment_local_fallback"],
      tables: [],
      totalRetainedBytes: 0,
      estimatedDailyGrowthBytes: 0,
      estimatedEightDayBytes: 0,
      queryLatencyMs: null,
      localFallbacks: [
        "analytics NDJSON order mirrors",
        "preflight decision NDJSON",
        "window tick NDJSON",
        "coverage audit and incident NDJSON",
        "window-log.json",
      ],
    });
  }
});

// Read-only research report. It never queries Kalshi and reports unknown
// settlement/fill fields as null until separately reconciled evidence exists.
//
// loadMandelbrotObservations() streams and synchronously parses the entire NDJSON
// ledger. At the 64 MB compaction threshold that is ~1 000 blocking readSync calls
// which can stall the event loop long enough to delay order evaluation ticks. A
// 30-second TTL cache (getCachedMandelbrotReport) ensures at most one parse per
// window regardless of request rate; the cache is eagerly invalidated after
// compaction rewrites or settlement enrichment appends.
router.get("/trade/analytics/reports/mandelbrot-instability", (_req, res) => {
  const { observations, summary, cacheHits, cacheMisses, cacheAgeMs } = getCachedMandelbrotReport();
  res.json({
    version: "mandelbrot-instability-v1",
    captureEnabled: process.env["MANDELBROT_INSTABILITY_CAPTURE_ENABLED"] === "true",
    observationCount: observations.length,
    ...summary,
    captureStatus: getMandelbrotCaptureStatus(),
    reportCache: { cacheHits, cacheMisses, cacheAgeMs },
  });
});

// Read-only health snapshot for the opt-in research capture. It performs no
// market lookup and intentionally exposes no trading control.
router.get("/trade/analytics/mandelbrot-instability/status", (_req, res) => {
  res.json(getMandelbrotCaptureStatus());
});

// Informational only: it reports research retention policy and has no route
// back into strategy health, order evaluation, or any execution control.
router.get("/trade/analytics/research-retention/status", (_req, res) => {
  res.json(getResearchRetentionStatus());
});

// Read-only research observability. No trading code reads this endpoint or its
// storage, and an unavailable status is explicitly not an execution health gate.
router.get("/trade/analytics/compact-shadow/status", async (_req, res) => {
  try {
    res.json({
      researchOnly: true,
      executionGate: false,
      rawTicksPersisted: false,
      ...(await getCompactShadowStatusInSql()),
      generatedAtMs: Date.now(),
    });
  } catch (err) {
    logger.warn({ err }, "compactShadow: status unavailable");
    res.status(503).json({ researchOnly: true, executionGate: false, storage: "unavailable", assets: [] });
  }
});

export default router;

let budgetWriteFailures = 0;

let cacheWriteFailures = 0;
