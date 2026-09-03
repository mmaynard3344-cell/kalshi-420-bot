import { kalshiAuthFetch } from "./kalshiAuth.js";
import { easternDay } from "./dailyBudget.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// Daily realized P&L remains observable, but it is not an order gate.
// A prior $75 target stopped the ETH martingale after profitable sessions.
export const DAILY_PROFIT_TARGET_DOLLARS: number | null = null;
const CACHE_MS = 5_000;

export type DailyProfitStopStatus = {
  easternDate: string;
  realizedPnlDollars: number | null;
  source: "GET /portfolio/fills + GET /markets/{ticker}";
  retrievedAt: string | null;
  state: "below_target" | "target_reached" | "unavailable" | "disabled";
  reason?: string;
};

type Fill = {
  ticker?: unknown; side?: unknown; yes_price_dollars?: unknown; no_price_dollars?: unknown;
  count_fp?: unknown; fee_cost?: unknown; created_time?: unknown;
};
let cached: { until: number; status: DailyProfitStopStatus } | null = null;
// A resolved market result never changes, so it is cached indefinitely. This
// is the difference between O(distinct unresolved tickers) and O(every
// same-day fill) authenticated /markets calls per run — the uncached version
// tripped Kalshi's rate limit in production (2026-08-17) and blocked entries.
const resolvedMarketResults = new Map<string, "yes" | "no">();
const MAX_RESOLVED_CACHE = 10_000;
// Single-flight: concurrent callers (ETH and SOL evaluate on every tick)
// share one computation instead of issuing duplicate authenticated bursts.
// Keyed by Eastern date so a post-midnight caller can never inherit a
// pre-midnight run's status (a prior day's below_target must not permit a
// new-day entry without checking the new day's fills).
let inFlight: { easternDate: string; promise: Promise<DailyProfitStopStatus> } | null = null;
const AUDIT_FILE = join(process.cwd(), "data", "daily-profit-stop.ndjson");
export type DailyProfitStopAuditRecord = {
  kind: "triggered" | "rejected";
  ticker: string | null;
  at: string;
  easternDate: string;
  realizedPnlDollars: number | null;
  source: DailyProfitStopStatus["source"];
  state: DailyProfitStopStatus["state"];
  retrievedAt: string | null;
};
type KalshiFetch = <T>(method: string, path: string) => Promise<T>;
let kalshiFetchForTesting: KalshiFetch | null = null;
type AuditRecord = { kind: "triggered" | "rejected"; ticker: string | null; status: DailyProfitStopStatus };
let auditSinkForTesting: ((record: AuditRecord) => void) | null = null;

function fetchKalshi<T>(method: string, path: string): Promise<T> {
  return kalshiFetchForTesting
    ? kalshiFetchForTesting<T>(method, path)
    : kalshiAuthFetch<T>(method, path);
}

/** Test seam: production always uses authenticated Kalshi account history. */
export function _setDailyProfitStopFetchForTesting(fetcher: KalshiFetch | null): void {
  kalshiFetchForTesting = fetcher;
  cached = null;
}

/** Test seam for asserting trigger/rejection audit events without loading SQL. */
export function _setDailyProfitStopAuditSinkForTesting(sink: ((record: AuditRecord) => void) | null): void {
  auditSinkForTesting = sink;
}

/** Clears process-local cache and test-only exchange injection. */
export function _resetDailyProfitStopForTesting(): void {
  kalshiFetchForTesting = null;
  auditSinkForTesting = null;
  cached = null;
  resolvedMarketResults.clear();
  inFlight = null;
}

/** File-based read fallback for the authenticated audit-history endpoint. */
export function loadDailyProfitStopAuditFile(limit = 100): DailyProfitStopAuditRecord[] {
  try {
    if (!existsSync(AUDIT_FILE)) return [];
    return readFileSync(AUDIT_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as DailyProfitStopAuditRecord;
          return value && (value.kind === "triggered" || value.kind === "rejected") ? [value] : [];
        } catch {
          return [];
        }
      })
      .slice(-Math.max(1, Math.min(500, limit)))
      .reverse();
  } catch {
    return [];
  }
}

function persistAudit(kind: "triggered" | "rejected", status: DailyProfitStopStatus, ticker?: string): void {
  if (auditSinkForTesting) {
    auditSinkForTesting({ kind, ticker: ticker ?? null, status });
    return;
  }
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify({ kind, ticker: ticker ?? null, at: new Date().toISOString(), ...status })}\n`);
    void import("./tradeStore.js").then(({ recordDailyProfitStopAuditToSql }) =>
      recordDailyProfitStopAuditToSql({
        easternDate: status.easternDate, kind, ticker: ticker ?? null,
        realizedPnlDollars: status.realizedPnlDollars, source: status.source,
        sourceStatus: status.state, retrievedAt: status.retrievedAt,
        reason: status.reason ?? null,
      }),
    );
  } catch {
    // The guard itself remains fail-closed from the authoritative source; a
    // telemetry write error must not turn into a permit.
  }
}

/**
 * User-authorized source: the same authenticated Kalshi account-history
 * "all fills" calculation shown in the dashboard. This intentionally does not
 * read bot SQL/ledger P&L or strategy state. It is reporting-only when the
 * daily profit target is disabled.
 */
export async function getDailyProfitStopStatus(now = new Date()): Promise<DailyProfitStopStatus> {
  const easternDate = easternDay(now);
  // When a target is enabled, never cache a permit. A stale below-target result
  // could otherwise allow an entry after an external settlement crossed it.
  // With no target configured, this remains reporting-only but is kept fresh.
  if (
    cached
    && cached.until > Date.now()
    && cached.status.easternDate === easternDate
    && cached.status.state !== "below_target"
    && cached.status.state !== "disabled"
  ) return cached.status;
  // Concurrent same-day callers share one in-flight computation. This is safe
  // for the same reason a fresh run is: every sharer receives a status
  // computed from exchange data fetched after it asked. Without it, ETH and
  // SOL tick evaluators each launched a full fills+markets burst
  // simultaneously. A caller on a different Eastern date never shares — it
  // starts its own run for its own trading day.
  if (inFlight && inFlight.easternDate === easternDate) return inFlight.promise;
  const flight = {
    easternDate,
    promise: computeDailyProfitStopStatus(now, easternDate).finally(() => {
      if (inFlight?.promise === flight.promise) inFlight = null;
    }),
  };
  inFlight = flight;
  return flight.promise;
}

async function computeDailyProfitStopStatus(now: Date, easternDate: string): Promise<DailyProfitStopStatus> {
  const unavailable = (reason: string): DailyProfitStopStatus => ({
    easternDate, realizedPnlDollars: null, source: "GET /portfolio/fills + GET /markets/{ticker}",
    retrievedAt: null, state: "unavailable", reason,
  });
  try {
    const fills: Fill[] = [];
    let cursor: string | undefined;
    // Exhaust pagination: a capped history is not authoritative enough to permit entry.
    for (;;) {
      const qs = new URLSearchParams({ limit: "1000" });
      if (cursor) qs.set("cursor", cursor);
      const page = await fetchKalshi<{ fills?: Fill[]; cursor?: string }>("GET", `/portfolio/fills?${qs}`);
      if (!Array.isArray(page.fills)) throw new Error("missing fills array");
      fills.push(...page.fills);
      if (!page.cursor) break;
      cursor = page.cursor;
      if (fills.length > 50_000) throw new Error("fill history exceeds safe authoritative limit");
    }
    // Validate all same-day fills first, then resolve each distinct ticker's
    // market exactly once per run. Resolved results are cached indefinitely
    // (a settled market never changes), so steady-state runs only query the
    // handful of tickers still awaiting settlement — the per-fill version
    // issued hundreds of /markets calls per run and rate-limited itself into
    // a false "unavailable" that blocked entries (2026-08-17).
    const todaysFills: Array<{ ticker: string; side: "yes" | "no"; count: number; price: number; fee: number }> = [];
    for (const fill of fills) {
      if (typeof fill.created_time !== "string" || easternDay(new Date(fill.created_time)) !== easternDate) continue;
      if (typeof fill.ticker !== "string" || (fill.side !== "yes" && fill.side !== "no")) throw new Error("malformed fill");
      const count = Number(fill.count_fp);
      const price = Number(fill.side === "yes" ? fill.yes_price_dollars : fill.no_price_dollars);
      const fee = Number(fill.fee_cost ?? "0");
      if (![count, price, fee].every(Number.isFinite)) throw new Error("malformed fill economics");
      todaysFills.push({ ticker: fill.ticker, side: fill.side, count, price, fee });
    }
    const resultsByTicker = new Map<string, "yes" | "no" | null>();
    for (const ticker of new Set(todaysFills.map((fill) => fill.ticker))) {
      const cachedResult = resolvedMarketResults.get(ticker);
      if (cachedResult) { resultsByTicker.set(ticker, cachedResult); continue; }
      const market = await fetchKalshi<{ market?: { result?: string } }>("GET", `/markets/${ticker}`);
      const result = market.market?.result;
      if (result === "yes" || result === "no") {
        if (resolvedMarketResults.size >= MAX_RESOLVED_CACHE) resolvedMarketResults.clear();
        resolvedMarketResults.set(ticker, result);
        resultsByTicker.set(ticker, result);
      } else {
        resultsByTicker.set(ticker, null);
      }
    }
    let pnl = 0;
    for (const fill of todaysFills) {
      const result = resultsByTicker.get(fill.ticker);
      // An unresolved same-day fill cannot be called realized P&L; it contributes
      // neither gain nor loss, as in the account-history dashboard.
      if (result !== "yes" && result !== "no") continue;
      pnl += (result === fill.side ? fill.count : 0) - fill.count * fill.price - fill.fee;
    }
    const status: DailyProfitStopStatus = {
      easternDate, realizedPnlDollars: pnl, source: "GET /portfolio/fills + GET /markets/{ticker}",
      retrievedAt: now.toISOString(),
      state: DAILY_PROFIT_TARGET_DOLLARS == null
        ? "disabled"
        : pnl >= DAILY_PROFIT_TARGET_DOLLARS ? "target_reached" : "below_target",
    };
    if (status.state === "target_reached") persistAudit("triggered", status);
    cached = status.state === "below_target" ? null : { until: Date.now() + CACHE_MS, status };
    return status;
  } catch (err) {
    const status = unavailable(err instanceof Error ? err.message : "Kalshi account history unavailable");
    cached = { until: Date.now() + 1_000, status };
    return status;
  }
}

/**
 * Entry-only compatibility hook. A disabled daily profit target must never
 * block a new investment, including during a transient account-history outage.
 * Never call this from protective-exit or settlement code.
 */
export async function allowNewInvestment(ticker?: string): Promise<{ allowed: boolean; status: DailyProfitStopStatus }> {
  if (DAILY_PROFIT_TARGET_DOLLARS == null) {
    return {
      allowed: true,
      status: {
        easternDate: easternDay(new Date()),
        realizedPnlDollars: null,
        source: "GET /portfolio/fills + GET /markets/{ticker}",
        retrievedAt: null,
        state: "disabled",
        reason: "Daily realized-profit target is disabled",
      },
    };
  }
  const status = await getDailyProfitStopStatus();
  if (status.state !== "below_target") persistAudit("rejected", status, ticker);
  return { allowed: status.state === "below_target", status };
}