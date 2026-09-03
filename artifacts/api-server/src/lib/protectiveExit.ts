/**
 * Opt-in, fail-closed 80¢ protective exit for confirmed positions.
 *
 * This module is intentionally separate from the entry engine.  It neither
 * reads nor mutates entry budget/dedup state and it uses the exact held-side
 * buyer book rather than entry-side asks.
 */
import { randomUUID } from "node:crypto";
import { kalshiAuthFetch } from "./kalshiAuth.js";
import { kalshiFetch } from "./kalshi.js";
import { logger } from "./logger.js";
import { parseExitSellBids, type KalshiOrderbookRaw } from "./orderbookParsing.js";
import { parseKalshiOrderResponse } from "./orderResponseParser.js";
import type { ProtectiveExitAttemptRecord, ProtectiveExitMonitorIncident } from "./tradeStore.js";

export const PROTECTIVE_EXIT_FLOOR_CENTS = 80;
export const PROTECTIVE_EXIT_MAX_BOOK_AGE_MS = 2_000;
/** A single bounded retry is enough to absorb a transient 429/network blip
 * without turning the protective monitor into a quota-consuming retry loop. */
export const PROTECTIVE_EXIT_POSITION_LOOKUP_MAX_ATTEMPTS = 2;
export const PROTECTIVE_EXIT_POSITION_LOOKUP_RETRY_DELAY_MS = 150;

export type HeldSide = "yes" | "no";
export interface ConfirmedPosition { side: HeldSide; quantity: number; }
export interface ProtectiveExitResult { attempted: boolean; reason: string; id?: string; }

const inFlight = new Set<string>();

/**
 * Tickers pre-armed from SQL on startup. Populated by restoreArmedPositions()
 * so callers can confirm that a ticker had a known open position at the last
 * restart without having to re-query the database.
 *
 * Note: the protective exit fires on ANY confirmed position at or below the
 * floor regardless of this set — the set is for logging/observability only
 * and does not gate the IOC submission path.
 */
const _restoredArmedTickers = new Set<string>();

// ETH martingale orders are a separately-owned strategy. Its durable exchange
// order IDs are recorded at startup so the legacy 80¢ monitor cannot sell a
// position it did not create. Ticker is used only for the exchange position
// lookup boundary; ownership is never inferred from a ticker prefix.
const _ethMartingaleOrderIdsByTicker = new Map<string, ReadonlySet<string>>();

// Kalshi exposes one net position per ticker. When it is owned by both the
// legacy strategy and ETH martingale, an ask cannot be attributed safely.
const _mixedEthStrategyOwnershipTickers = new Set<string>();

// Suppress duplicate bypass-only audit rows when the same condition persists
// across consecutive state ticks. Key: `${ticker}:${heldSide}:${outcome}`.
// Cleared by _resetProtectiveExitForTesting so tests always start fresh.
const _bypassLastWrittenMs = new Map<string, number>();
const BYPASS_COOLDOWN_MS = 5 * 60_000; // 5 minutes between identical bypass rows
// Prevents concurrent disabled evaluations from racing past the cooldown check
// and each persisting a row before either has set the cooldown timestamp.
const _bypassInFlight = new Set<string>();

// ── Local confirmed-entry registry ───────────────────────────────────────────
// Tracks entries the SERVER knows were filled (from the entry engine's fill
// path or the startup restore) independently of the exchange position lookup.
// This is what lets the monitor distinguish "no position" from "the exchange
// lookup failed / reported zero for a position we know we filled".
// Entries expire after LOCAL_ENTRY_TTL_MS (15-minute markets settle well
// within this) so a settled market stops producing evidence rows.
export const LOCAL_ENTRY_TTL_MS = 30 * 60_000;
interface LocalConfirmedEntry {
  side: HeldSide | null;      // null when restored from SQL without side info
  quantity: number | null;    // null when unknown
  notedAtMs: number;
}
const _localConfirmedEntries = new Map<string, LocalConfirmedEntry>();

/** Called by the entry engine whenever a real fill is confirmed. */
export function noteConfirmedLocalEntry(ticker: string, side: HeldSide, quantity: number): void {
  _localConfirmedEntries.set(ticker, { side, quantity, notedAtMs: Date.now() });
}
/** Called after a verified full exit or settlement. */
export function clearConfirmedLocalEntry(ticker: string): void {
  _localConfirmedEntries.delete(ticker);
}
function localConfirmedEntryFor(ticker: string): LocalConfirmedEntry | null {
  const entry = _localConfirmedEntries.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.notedAtMs > LOCAL_ENTRY_TTL_MS) {
    _localConfirmedEntries.delete(ticker);
    return null;
  }
  return entry;
}
export function _getLocalConfirmedEntriesForTesting(): ReadonlyMap<string, LocalConfirmedEntry> {
  return _localConfirmedEntries;
}

// ── Monitor incidents (durable, high-severity) ───────────────────────────────
// Raised when the monitor cannot verify a locally confirmed position AND the
// market is (or may be) at/below the protective floor. In-memory counters are
// surfaced through getProtectiveExitMonitorStatus for runtime health.
let _monitorIncidentCount = 0;
let _lastMonitorIncident: ProtectiveExitMonitorIncident | null = null;
type MonitorIncidentWriter = (incident: ProtectiveExitMonitorIncident) => void;
let _incidentWriter: MonitorIncidentWriter | null = null;
export function _setProtectiveExitIncidentWriterForTesting(fn: MonitorIncidentWriter | null): void {
  _incidentWriter = fn;
}

let _positionLookup: ((ticker: string) => Promise<number>) | null = null;
let _bookFetch: ((ticker: string) => Promise<KalshiOrderbookRaw>) | null = null;
let _authFetch: typeof kalshiAuthFetch | null = null;
type CreateAudit = (record: ProtectiveExitAttemptRecord) => Promise<boolean>;
type UpdateAudit = (id: string, patch: {
  postInitiated?: boolean; responseReceived?: boolean; kalshiOrderId?: string | null;
  fillQuantity?: number | null; averageExitPriceCents?: number | null;
  remainingPosition?: number | null; outcome?: string; reason?: string | null;
}) => Promise<boolean>;
let _storeCreate: CreateAudit | null = null;
let _storeUpdate: UpdateAudit | null = null;

/** Read-only server-process monitor state; it never changes exit behavior. */
export function getProtectiveExitMonitorStatus(): {
  enabled: boolean; inFlightCount: number; restoredArmedTickers: string[];
  localConfirmedEntryTickers: string[];
  mixedEthStrategyOwnershipTickers: string[];
  monitorIncidentCount: number;
  lastMonitorIncident: ProtectiveExitMonitorIncident | null;
} {
  return {
    enabled: process.env["PROTECTIVE_EXIT_ENABLED"] === "true",
    inFlightCount: inFlight.size,
    restoredArmedTickers: [..._restoredArmedTickers].sort(),
    localConfirmedEntryTickers: [..._localConfirmedEntries.keys()].sort(),
    mixedEthStrategyOwnershipTickers: [..._mixedEthStrategyOwnershipTickers].sort(),
    monitorIncidentCount: _monitorIncidentCount,
    lastMonitorIncident: _lastMonitorIncident ? { ..._lastMonitorIncident } : null,
  };
}

export function _setProtectiveExitPositionLookupForTesting(fn: (ticker: string) => Promise<number>): void { _positionLookup = fn; }
export function _setProtectiveExitBookFetchForTesting(fn: (ticker: string) => Promise<KalshiOrderbookRaw>): void { _bookFetch = fn; }
export function _setProtectiveExitAuthFetchForTesting(fn: typeof kalshiAuthFetch): void { _authFetch = fn; }
export function _setProtectiveExitStoreForTesting(
  create: CreateAudit,
  update: UpdateAudit,
): void { _storeCreate = create; _storeUpdate = update; }
export function _resetProtectiveExitForTesting(): void {
  inFlight.clear(); _bypassLastWrittenMs.clear(); _bypassInFlight.clear();
  _restoredArmedTickers.clear();
  _ethMartingaleOrderIdsByTicker.clear();
  _mixedEthStrategyOwnershipTickers.clear();
  _localConfirmedEntries.clear();
  _monitorIncidentCount = 0; _lastMonitorIncident = null; _incidentWriter = null;
  _positionLookup = null; _bookFetch = null; _authFetch = null;
  _storeCreate = null; _storeUpdate = null;
}

type ProtectiveAsset = "BTC" | "ETH" | "SOL" | "DOGE";

function assetFor(ticker: string): ProtectiveAsset | null {
  if (ticker.startsWith("KXBTC15M")) return "BTC";
  if (ticker.startsWith("KXETH15M")) return "ETH";
  if (ticker.startsWith("KXSOL15M")) return "SOL";
  if (ticker.startsWith("KXDOGE15M")) return "DOGE";
  return null;
}

async function authoritativeSignedPosition(ticker: string): Promise<number> {
  if (_positionLookup) return _positionLookup(ticker);
  const data = await kalshiAuthFetch<{ market_positions?: Array<Record<string, unknown>> }>(
    "GET", `/portfolio/positions?ticker=${encodeURIComponent(ticker)}`,
    undefined,
    { readPriority: "safety" },
  );
  const row = data.market_positions?.find((entry) => entry["ticker"] === ticker);
  const value = Number(row?.["position"]);
  if (!Number.isFinite(value)) throw new Error("position_missing_or_invalid");
  return value;
}

function isRetryablePositionLookupError(err: unknown): boolean {
  const candidate = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = Number(candidate?.status);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const code = String(candidate?.code ?? "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code)) return true;
  const message = String(candidate?.message ?? err ?? "").toLowerCase();
  return /rate.?limit|timeout|timed out|network|socket|fetch failed|temporar(?:y|ily)|unavailable/.test(message);
}

function positionLookupErrorSummary(err: unknown): string {
  const candidate = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = Number(candidate?.status);
  const statusText = Number.isFinite(status) ? `status=${status}` : null;
  const code = candidate?.code == null ? null : `code=${String(candidate.code)}`;
  const message = candidate?.message == null ? String(err) : String(candidate.message);
  return [statusText, code, message].filter(Boolean).join(" ");
}

/**
 * Protective exits must never use a cached/stale position. This retries only a
 * live, idempotent GET when the failure is plausibly transient. POSTs remain
 * single-attempt and a failed retry sequence still returns no position value.
 */
async function verifyAuthoritativeSignedPosition(ticker: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROTECTIVE_EXIT_POSITION_LOOKUP_MAX_ATTEMPTS; attempt++) {
    try {
      return await authoritativeSignedPosition(ticker);
    } catch (err) {
      lastError = err;
      if (
        attempt === PROTECTIVE_EXIT_POSITION_LOOKUP_MAX_ATTEMPTS ||
        !isRetryablePositionLookupError(err)
      ) break;
      logger.warn(
        {
          ticker,
          attempt,
          maxAttempts: PROTECTIVE_EXIT_POSITION_LOOKUP_MAX_ATTEMPTS,
          delayMs: PROTECTIVE_EXIT_POSITION_LOOKUP_RETRY_DELAY_MS,
          error: positionLookupErrorSummary(err),
        },
        "protectiveExit: live position lookup failed transiently; retrying without using cached state",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, PROTECTIVE_EXIT_POSITION_LOOKUP_RETRY_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(positionLookupErrorSummary(lastError));
}

function averageFillCents(raw: Record<string, unknown>, heldSide: HeldSide, fillCount: number): number | null {
  const order = (raw["order"] as Record<string, unknown> | undefined) ?? raw;
  const fills = (order["fills"] as Array<Record<string, unknown>> | undefined) ?? [];
  let total = 0; let quantity = 0;
  for (const fill of fills) {
    const count = Number(fill["count_fp"] ?? fill["count"] ?? fill["fill_count_fp"] ?? 0);
    const decimal = Number(fill[heldSide === "yes" ? "yes_price_dollars" : "no_price_dollars"]);
    if (Number.isFinite(count) && count > 0 && Number.isFinite(decimal)) {
      total += count * Math.round(decimal * 100); quantity += count;
    }
  }
  return quantity > 0 ? Math.round(total / quantity) : (fillCount > 0 ? PROTECTIVE_EXIT_FLOOR_CENTS : null);
}

/**
 * Evaluate one ticker. Callers may invoke on every state tick; disabled state,
 * unconfirmed positions and stale/missing books stop before a write or order
 * request. Any confirmed position with an executable held-side bid at or below
 * 80¢ sends the IOC at that bid, including after a restart or a fast gap down.
 */
/**
 * Write a lightweight bypass-only audit row (no POST).
 * Suppresses duplicate writes for the same ticker/side/outcome within
 * BYPASS_COOLDOWN_MS so repeated evaluator ticks cannot flood the audit table.
 */
async function _writeBypassAudit(params: {
  ticker: string; asset: ProtectiveAsset; heldSide: HeldSide; quantity: number;
  outcome: string; reason: string; executableBidCents: number | null; depth: number;
  capturedAtMs: number | null; quoteAgeMs: number | null; book: KalshiOrderbookRaw | null;
}): Promise<void> {
  const cooldownKey = `${params.ticker}:${params.heldSide}:${params.outcome}`;
  const lastMs = _bypassLastWrittenMs.get(cooldownKey) ?? 0;
  if (Date.now() - lastMs < BYPASS_COOLDOWN_MS) return;
  // Prevent two concurrent disabled evaluations from both passing the cooldown
  // check before either has set the timestamp. Without this guard, both calls
  // would persist a row, pushing the first one out of the 100-row fetch window.
  if (_bypassInFlight.has(cooldownKey)) return;
  _bypassInFlight.add(cooldownKey);
  // Do NOT set the cooldown timestamp until the write succeeds. The store
  // returns false (without throwing) when storage is degraded; treating a
  // silent false as success would suppress retries for BYPASS_COOLDOWN_MS.
  try {
    const store = _storeCreate ? null : await import("./tradeStore.js");
    const create = _storeCreate ?? store!.createProtectiveExitAttempt;
    const ok = await create({
      id: randomUUID(), timestampMs: Date.now(),
      ticker: params.ticker, asset: params.asset, heldSide: params.heldSide,
      confirmedPositionBefore: params.quantity,
      triggerCents: PROTECTIVE_EXIT_FLOOR_CENTS,
      executableBidCents: params.executableBidCents,
      bidDepthContracts: params.depth,
      quoteTimestampMs: params.capturedAtMs, quoteAgeMs: params.quoteAgeMs,
      requestedContracts: 0,
      limitPriceCents: params.executableBidCents ?? PROTECTIVE_EXIT_FLOOR_CENTS,
      timeInForce: "immediate_or_cancel",
      postInitiated: false, responseReceived: false,
      outcome: params.outcome, reason: params.reason,
      rawBook: params.book ? JSON.stringify(params.book.orderbook_fp ?? {}) : null,
    });
    if (ok) {
      _bypassLastWrittenMs.set(cooldownKey, Date.now());
    } else {
      logger.warn({ ticker: params.ticker, outcome: params.outcome },
        "protectiveExit: bypass audit write returned false (storage unavailable) — will retry next tick");
    }
  } catch (err) {
    // Exception path: no cooldown set so the next tick can retry.
    logger.warn({ err, ticker: params.ticker, outcome: params.outcome }, "protectiveExit: bypass audit write threw (non-critical)");
  } finally {
    _bypassInFlight.delete(cooldownKey);
  }
}

/**
 * Raise a durable, rate-limited high-severity monitor incident. Never throws
 * and never affects the exit decision path — evidence only.
 */
function _raiseMonitorIncident(params: {
  ticker: string; kind: string; details: string;
  localSide: HeldSide | null; localQuantity: number | null;
  executableBidCents: number | null;
}): void {
  const cooldownKey = `incident:${params.ticker}:${params.kind}`;
  const lastMs = _bypassLastWrittenMs.get(cooldownKey) ?? 0;
  if (Date.now() - lastMs < BYPASS_COOLDOWN_MS) return;
  _bypassLastWrittenMs.set(cooldownKey, Date.now());
  const incident: ProtectiveExitMonitorIncident = {
    id: randomUUID(), ticker: params.ticker, detectedAtMs: Date.now(),
    kind: params.kind, severity: "high",
    localSide: params.localSide, localQuantity: params.localQuantity,
    executableBidCents: params.executableBidCents, details: params.details,
    acknowledgedAt: null,
  };
  _monitorIncidentCount++;
  _lastMonitorIncident = incident;
  logger.error(
    { ticker: params.ticker, kind: params.kind, details: params.details,
      executableBidCents: params.executableBidCents },
    "protectiveExit: MONITOR INCIDENT — confirmed local entry cannot be verified while at/below (or unable to rule out) the protective floor",
  );
  try {
    if (_incidentWriter) { _incidentWriter(incident); return; }
    void import("./tradeStore.js")
      .then((store) => { store.recordProtectiveExitMonitorIncident(incident); })
      .catch(() => { /* durable-write buffer handles retries; nothing else to do */ });
  } catch { /* evidence-only path — never disturb the monitor */ }
}

/**
 * Best-effort book probe used ONLY on verification-failure paths to decide
 * whether the market is (or may be) at/below the protective floor.
 */
async function _probeFloorForEvidence(ticker: string, side: HeldSide): Promise<{
  state: "at_or_below_floor" | "above_floor" | "unavailable";
  bestBidCents: number | null; depth: number;
  capturedAtMs: number | null; quoteAgeMs: number | null; book: KalshiOrderbookRaw | null;
}> {
  try {
    const capturedAtMs = Date.now();
    const book = await (_bookFetch ?? ((t) => kalshiFetch<KalshiOrderbookRaw>(`/markets/${t}/orderbook`)))(ticker);
    const quoteAgeMs = Date.now() - capturedAtMs;
    if (quoteAgeMs > PROTECTIVE_EXIT_MAX_BOOK_AGE_MS) {
      return { state: "unavailable", bestBidCents: null, depth: 0, capturedAtMs, quoteAgeMs, book };
    }
    const bids = parseExitSellBids(book, side);
    const bestBid = bids.at(-1) ?? null;
    if (!bestBid) {
      // No buyers at all — cannot rule out a gap below the floor.
      return { state: "at_or_below_floor", bestBidCents: null, depth: 0, capturedAtMs, quoteAgeMs, book };
    }
    const depth = bids.filter((b) => b.priceCents === bestBid.priceCents)
      .reduce((s, b) => s + b.contractsApprox, 0);
    return {
      state: bestBid.priceCents <= PROTECTIVE_EXIT_FLOOR_CENTS ? "at_or_below_floor" : "above_floor",
      bestBidCents: bestBid.priceCents, depth, capturedAtMs, quoteAgeMs, book,
    };
  } catch {
    return { state: "unavailable", bestBidCents: null, depth: 0, capturedAtMs: null, quoteAgeMs: null, book: null };
  }
}

/**
 * Durable evidence + (when warranted) incident for an evaluation where the
 * exchange position lookup could not verify a locally confirmed entry.
 * Evidence-only: never places an order, never throws.
 */
async function _recordVerificationFailure(params: {
  ticker: string; asset: ProtectiveAsset; outcome: string; reason: string;
  local: LocalConfirmedEntry;
  /** Floor state when already known (pre-POST paths); null → probe the book. */
  knownBidCents?: number | null;
}): Promise<void> {
  const quantity = params.local.quantity ?? 0;
  let side: HeldSide = params.local.side ?? "yes";
  let bidCents: number | null;
  let floorState: "at_or_below_floor" | "above_floor" | "unavailable";
  let probe: Awaited<ReturnType<typeof _probeFloorForEvidence>> | null = null;
  if (params.knownBidCents !== undefined) {
    bidCents = params.knownBidCents;
    floorState = bidCents !== null && bidCents <= PROTECTIVE_EXIT_FLOOR_CENTS
      ? "at_or_below_floor" : "above_floor";
  } else if (params.local.side !== null) {
    probe = await _probeFloorForEvidence(params.ticker, side);
    bidCents = probe.bestBidCents;
    floorState = probe.state;
  } else {
    // Held side unknown (ticker-only restart restore): probe BOTH executable
    // books and take the worst case. Defaulting to YES here would suppress an
    // incident for a restored NO position whose NO bid breached the floor.
    const [yesProbe, noProbe] = await Promise.all([
      _probeFloorForEvidence(params.ticker, "yes"),
      _probeFloorForEvidence(params.ticker, "no"),
    ]);
    const severity = (s: "at_or_below_floor" | "above_floor" | "unavailable"): number =>
      s === "at_or_below_floor" ? 2 : s === "unavailable" ? 1 : 0;
    const worst = severity(noProbe.state) > severity(yesProbe.state)
      ? { probe: noProbe, side: "no" as const }
      : { probe: yesProbe, side: "yes" as const };
    probe = worst.probe;
    side = worst.side;
    bidCents = probe.bestBidCents;
    floorState = probe.state;
  }
  await _writeBypassAudit({
    ticker: params.ticker, asset: params.asset, heldSide: side, quantity,
    outcome: params.outcome,
    reason: `${params.reason}; floor_state=${floorState}${params.local.side === null ? "; held_side_unknown_probed_both_books" : ""}`,
    executableBidCents: bidCents, depth: probe?.depth ?? 0,
    capturedAtMs: probe?.capturedAtMs ?? null, quoteAgeMs: probe?.quoteAgeMs ?? null,
    book: probe?.book ?? null,
  });
  // Incident only when the position cannot be verified AND we are at/below the
  // floor or cannot rule it out. Above the floor, the evidence row suffices.
  if (floorState !== "above_floor") {
    _raiseMonitorIncident({
      ticker: params.ticker, kind: params.outcome,
      details: `${params.reason}; floor_state=${floorState}`,
      localSide: params.local.side, localQuantity: params.local.quantity,
      executableBidCents: bidCents,
    });
  }
}

export async function evaluateProtectiveExit(
  ticker: string,
  isSettlementHeld?: (ticker: string, heldSide: HeldSide) => Promise<boolean>,
): Promise<ProtectiveExitResult> {
  const enabled = process.env["PROTECTIVE_EXIT_ENABLED"] === "true";
  const asset = assetFor(ticker);
  if (!asset) return { attempted: false, reason: "untracked_ticker" };
  const local = localConfirmedEntryFor(ticker);

  let signed: number;
  try { signed = await verifyAuthoritativeSignedPosition(ticker); }
  catch {
    if (local) {
      await _recordVerificationFailure({
        ticker, asset, local,
        outcome: "position_lookup_unavailable",
        reason: "exchange position lookup failed for a locally confirmed entry",
      });
    }
    return { attempted: false, reason: "position_uncertain" };
  }
  // A successful zero-position lookup is authoritative evidence that this
  // ticker is no longer an active shared position. Do not clear it on a
  // lookup failure: the monitor must stay fail-closed until the exchange
  // positively confirms the position is gone.
  if (signed === 0) {
    _mixedEthStrategyOwnershipTickers.delete(ticker);
    if (local) {
      await _recordVerificationFailure({
        ticker, asset, local,
        outcome: "position_zero_unreconciled",
        reason: `exchange reports ${signed} but a local entry of ${local.quantity ?? "?"} ${local.side ?? "?"} contracts was confirmed`,
      });
    }
    return { attempted: false, reason: "no_confirmed_position" };
  }
  if (!Number.isInteger(signed)) {
    if (local) {
      await _recordVerificationFailure({
        ticker, asset, local,
        outcome: "position_zero_unreconciled",
        reason: `exchange reports ${signed} but a local entry of ${local.quantity ?? "?"} ${local.side ?? "?"} contracts was confirmed`,
      });
    }
    return { attempted: false, reason: "no_confirmed_position" };
  }
  const heldSide: HeldSide = signed > 0 ? "yes" : "no";
  const quantity = Math.abs(signed);
  if (_mixedEthStrategyOwnershipTickers.has(ticker)) {
    const orderIds = _ethMartingaleOrderIdsByTicker.get(ticker) ?? new Set<string>();
    const reason = `legacy and ETH martingale ownership overlap; exchange only reports net ${heldSide} position; martingale_order_ids=${[...orderIds].join(",")}`;
    await _writeBypassAudit({
      ticker, asset, heldSide, quantity, outcome: "mixed_eth_strategy_ownership",
      reason, executableBidCents: null, depth: 0,
      capturedAtMs: null, quoteAgeMs: null, book: null,
    });
    _raiseMonitorIncident({
      ticker, kind: "mixed_eth_strategy_ownership", details: reason,
      localSide: local?.side ?? heldSide, localQuantity: local?.quantity ?? quantity,
      executableBidCents: null,
    });
    return { attempted: false, reason: "mixed_eth_strategy_ownership" };
  }
  if (_ethMartingaleOrderIdsByTicker.has(ticker)) {
    return { attempted: false, reason: "eth_martingale_owned" };
  }
  // Complementary ETH 30–50 high legs are intentionally held through
  // settlement. Check this after confirming a position so the durable lookup
  // is not made for every quote tick without an owned position.
  if (asset === "ETH" && isSettlementHeld && await isSettlementHeld(ticker, heldSide)) {
    return { attempted: false, reason: "settlement_hold" };
  }

  if (!enabled) {
    // Even when disabled, check whether the position is at or below the exit
    // floor and record a not_armed row if so. This surfaces a suppressed exit to
    // the dashboard without placing an order.
    try {
      const capturedAtMs = Date.now();
      const book = await (_bookFetch ?? ((t) => kalshiFetch<KalshiOrderbookRaw>(`/markets/${t}/orderbook`)))(ticker);
      const quoteAgeMs = Date.now() - capturedAtMs;
      if (quoteAgeMs <= PROTECTIVE_EXIT_MAX_BOOK_AGE_MS) {
        const bids = parseExitSellBids(book, heldSide);
        const bestBid = bids.at(-1) ?? null;
        if (bestBid && bestBid.priceCents <= PROTECTIVE_EXIT_FLOOR_CENTS) {
          const depth = bids
            .filter((b) => b.priceCents === bestBid.priceCents)
            .reduce((s, b) => s + b.contractsApprox, 0);
          await _writeBypassAudit({
            ticker, asset, heldSide, quantity, outcome: "not_armed",
            reason: "PROTECTIVE_EXIT_ENABLED is not set to true",
            executableBidCents: bestBid.priceCents, depth,
            capturedAtMs, quoteAgeMs, book,
          });
        }
      }
    } catch { /* non-critical — position still confirmed, exit still suppressed */ }
    return { attempted: false, reason: "disabled" };
  }

  const key = `${ticker}:${heldSide}`;
  if (inFlight.has(key)) return { attempted: false, reason: "exit_in_flight" };
  inFlight.add(key);

  try {
    const capturedAtMs = Date.now();
    let book: KalshiOrderbookRaw;
    try { book = await (_bookFetch ?? ((t) => kalshiFetch<KalshiOrderbookRaw>(`/markets/${t}/orderbook`)))(ticker); }
    catch {
      // Position is CONFIRMED but the monitor is blind: it cannot rule out a
      // bid at/below the floor. Durable evidence + high-severity incident.
      await _writeBypassAudit({
        ticker, asset, heldSide, quantity, outcome: "book_unavailable",
        reason: "orderbook fetch failed for a confirmed position; floor cannot be verified",
        executableBidCents: null, depth: 0, capturedAtMs: null, quoteAgeMs: null, book: null,
      });
      _raiseMonitorIncident({
        ticker, kind: "book_unavailable",
        details: "orderbook fetch failed while holding a confirmed position",
        localSide: heldSide, localQuantity: quantity, executableBidCents: null,
      });
      return { attempted: false, reason: "book_unavailable" };
    }
    const quoteAgeMs = Date.now() - capturedAtMs;
    if (quoteAgeMs > PROTECTIVE_EXIT_MAX_BOOK_AGE_MS) {
      await _writeBypassAudit({
        ticker, asset, heldSide, quantity, outcome: "book_stale",
        reason: `orderbook fetch took ${quoteAgeMs}ms (> ${PROTECTIVE_EXIT_MAX_BOOK_AGE_MS}ms) for a confirmed position; floor cannot be verified`,
        executableBidCents: null, depth: 0, capturedAtMs, quoteAgeMs, book,
      });
      _raiseMonitorIncident({
        ticker, kind: "book_stale",
        details: `stale orderbook (${quoteAgeMs}ms) while holding a confirmed position`,
        localSide: heldSide, localQuantity: quantity, executableBidCents: null,
      });
      return { attempted: false, reason: "book_stale" };
    }
    const bids = parseExitSellBids(book, heldSide);
    const bestBid = bids.at(-1) ?? null;
    if (!bestBid) {
      // No buyers at all on the held side — the market may have gapped below the
      // floor. Record for dashboard visibility so a silently unexecutable exit is
      // not a post-mortem discovery.
      await _writeBypassAudit({
        ticker, asset, heldSide, quantity, outcome: "gap_below_floor",
        reason: "no_buyers_on_held_side",
        executableBidCents: null, depth: 0,
        capturedAtMs, quoteAgeMs, book,
      });
      return { attempted: false, reason: "no_buyer" };
    }
    if (bestBid.priceCents > PROTECTIVE_EXIT_FLOOR_CENTS) {
      return { attempted: false, reason: "above_exit_threshold" };
    }
    // Sell at the executable bid on an 80¢ touch or a gap below it. The exit
    // intentionally has no arming prerequisite: a restart or missed tick must
    // not leave a confirmed losing position unprotected. A limit pinned at 80¢
    // would not execute after a fast gap, defeating the stop.
    const exitPriceCents = bestBid.priceCents;
    const depth = bids.filter((bid) => bid.priceCents === exitPriceCents)
      .reduce((sum, bid) => sum + bid.contractsApprox, 0);

    // Re-verify immediately before creating a pre-POST record / sending a sell.
    // At this point the bid is KNOWN to be at/below the floor, so any failure
    // to re-confirm the position is immediately high-severity.
    try { signed = await verifyAuthoritativeSignedPosition(ticker); }
    catch {
      await _recordVerificationFailure({
        ticker, asset, local: { side: heldSide, quantity, notedAtMs: Date.now() },
        outcome: "position_lookup_unavailable",
        reason: "pre-POST position re-verification failed with an executable bid at/below the floor",
        knownBidCents: bestBid.priceCents,
      });
      return { attempted: false, reason: "position_uncertain_prepost" };
    }
    if (!Number.isInteger(signed) || signed === 0 || (signed > 0 ? "yes" : "no") !== heldSide) {
      await _recordVerificationFailure({
        ticker, asset, local: { side: heldSide, quantity, notedAtMs: Date.now() },
        outcome: "position_changed_prepost",
        reason: `pre-POST re-verification returned ${signed} (was ${heldSide} ${quantity}) with an executable bid at/below the floor`,
        knownBidCents: bestBid.priceCents,
      });
      return { attempted: false, reason: "position_changed_prepost" };
    }
    const confirmedQuantity = Math.abs(signed);
    const requestedContracts = Math.min(confirmedQuantity, depth);
    if (requestedContracts <= 0) return { attempted: false, reason: "zero_capped_quantity" };

    const id = randomUUID();
    // Dynamic loading keeps the module testable without opening the SQL driver.
    // Production always resolves these store functions before any order POST.
    const store = _storeCreate && _storeUpdate ? null : await import("./tradeStore.js");
    const create = _storeCreate ?? store!.createProtectiveExitAttempt;
    const update = _storeUpdate ?? store!.updateProtectiveExitAttempt;
    const persisted = await create({
      id, timestampMs: Date.now(), ticker, asset, heldSide,
      confirmedPositionBefore: confirmedQuantity, triggerCents: PROTECTIVE_EXIT_FLOOR_CENTS,
      executableBidCents: bestBid.priceCents, bidDepthContracts: depth,
      quoteTimestampMs: capturedAtMs, quoteAgeMs, requestedContracts,
        limitPriceCents: exitPriceCents, timeInForce: "immediate_or_cancel",
      postInitiated: false, responseReceived: false, outcome: "reserved",
      rawBook: JSON.stringify(book.orderbook_fp ?? {}),
    });
    if (!persisted) return { attempted: false, reason: "audit_persistence_failed" };
    // Durable transition must also succeed before the POST.
    if (!await update(id, { postInitiated: true, outcome: "post_started" })) {
      return { attempted: false, reason: "audit_post_transition_failed" };
    }

    try {
      const post = _authFetch ?? kalshiAuthFetch;
      // Kalshi's events orders endpoint represents a reduce-only held-side sale
      // as an ask on the held outcome. IOC prevents a resting exit order.
      const response = await post<Record<string, unknown>>("POST", "/portfolio/events/orders", {
        ticker, client_order_id: id, side: "ask", count: `${requestedContracts}.00`,
        price: (exitPriceCents / 100).toFixed(4),
        time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross",
      });
      const parsed = parseKalshiOrderResponse(response, requestedContracts);
      const fills = Math.max(0, Math.min(requestedContracts, Math.trunc(parsed.fillCount)));
      const remaining = Math.max(0, confirmedQuantity - fills);
      const outcome = parsed.rejectReason ? "provider_rejected" :
        fills === 0 ? "zero_fill" : fills < requestedContracts ? "partial_fill" : "full_fill";
      await update(id, {
        responseReceived: true, kalshiOrderId: parsed.kalshiOrderId,
        fillQuantity: fills, averageExitPriceCents: averageFillCents(response, heldSide, fills),
        remainingPosition: remaining, outcome, reason: parsed.rejectReason ?? parsed.cancelReason,
      });
      // A verified full exit ends the local confirmed entry; verification-
      // failure evidence for this ticker is no longer meaningful.
      if (outcome === "full_fill" && remaining === 0) clearConfirmedLocalEntry(ticker);
      return { attempted: true, reason: outcome, id };
    } catch (err) {
      await update(id, { outcome: "post_unknown", reason: "transport_uncertain" });
      logger.warn({ err, ticker, heldSide, id }, "protectiveExit: transport outcome uncertain; no automatic immediate retry");
      return { attempted: true, reason: "transport_uncertain", id };
    }
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Pre-populate the restored-tickers set from SQL-backed open positions found
 * at startup. Call once from the startup sequence after restoreState().
 * Passing an empty array clears any prior entries without error.
 */
export function restoreArmedPositions(
  entries: Array<string | { ticker: string; side: HeldSide; quantity: number }>,
  ethMartingaleOrders: ReadonlyArray<{ ticker: string; kalshiOrderId: string }> = [],
): void {
  _restoredArmedTickers.clear();
  _ethMartingaleOrderIdsByTicker.clear();
  _mixedEthStrategyOwnershipTickers.clear();
  for (const order of ethMartingaleOrders) {
    const existing = _ethMartingaleOrderIdsByTicker.get(order.ticker);
    _ethMartingaleOrderIdsByTicker.set(
      order.ticker,
      new Set([...(existing ?? []), order.kalshiOrderId]),
    );
  }
  for (const entry of entries) {
    const ticker = typeof entry === "string" ? entry : entry.ticker;
    _restoredArmedTickers.add(ticker);
    // A restored ticker is a locally confirmed entry — it must not lose
    // verification-failure evidence after a restart. Side/quantity are kept
    // when the caller has them; ticker-only entries stay side-unknown and the
    // verification-failure probe then checks BOTH books (never assumes YES).
    if (!_localConfirmedEntries.has(ticker)) {
      _localConfirmedEntries.set(ticker, typeof entry === "string"
        ? { side: null, quantity: null, notedAtMs: Date.now() }
        : { side: entry.side, quantity: entry.quantity, notedAtMs: Date.now() });
    }
  }
  for (const ticker of _ethMartingaleOrderIdsByTicker.keys()) {
    if (_restoredArmedTickers.has(ticker)) _mixedEthStrategyOwnershipTickers.add(ticker);
  }
  if (entries.length > 0) {
    logger.info(
      { count: entries.length, tickers: [..._restoredArmedTickers] },
      "protectiveExit: startup restore — pre-noted tickers with confirmed open positions",
    );
  }
  if (ethMartingaleOrders.length > 0) {
    logger.info(
      {
        orderCount: ethMartingaleOrders.length,
        tickers: [..._ethMartingaleOrderIdsByTicker.keys()],
        mixedOwnershipTickers: [..._mixedEthStrategyOwnershipTickers],
      },
      "protectiveExit: excluded ETH martingale-owned positions from legacy protective monitoring",
    );
  }
}

export interface ProtectiveExitRestoreSnapshot {
  positions: Array<{ ticker: string; side: HeldSide; quantity: number }>;
  legacyTickers: string[];
  ethMartingaleOrders: Array<{ ticker: string; kalshiOrderId: string }>;
}
/**
 * Poll restored confirmed positions independently of strategy subscriptions.
 * This may only place reduce-only protective exits; it cannot create exposure
 * or revive a retired strategy's entry logic.
 */
export async function monitorRestoredProtectiveExits(): Promise<void> {
  for (const ticker of _restoredArmedTickers) {
    await evaluateProtectiveExit(ticker);
  }
}

/** Snapshot of tickers pre-noted during startup restore (for tests only). */
export function _getRestoredArmedTickersForTesting(): ReadonlySet<string> { return _restoredArmedTickers; }
export function _getEthMartingaleOrderIdsByTickerForTesting(): ReadonlyMap<string, ReadonlySet<string>> {
  return _ethMartingaleOrderIdsByTicker;
}
export function _getMixedEthStrategyOwnershipTickersForTesting(): ReadonlySet<string> {
  return _mixedEthStrategyOwnershipTickers;
}

export interface ProtectiveExitRestoreCoordinatorOptions {
  loadPositions: () => Promise<ProtectiveExitRestoreSnapshot["positions"] | null>;
  loadLegacyTickers: () => Promise<string[] | null>;
  loadEthMartingaleOrders: () => Promise<ProtectiveExitRestoreSnapshot["ethMartingaleOrders"] | null>;
  retryIntervalMs: number;
  installSnapshot?: (
    entries: Array<string | { ticker: string; side: HeldSide; quantity: number }>,
    ethMartingaleOrders: ProtectiveExitRestoreSnapshot["ethMartingaleOrders"],
  ) => void;
  monitor?: () => Promise<void>;
  startMonitorLoop?: (tick: () => void) => RestoreTimer;
  scheduleRetry?: (retry: () => void, delayMs: number) => RestoreTimer;
}

/**
 * Starts the production restart-time protective coverage restore.
 *
 * All three durable reads are treated as one snapshot: a missing source leaves
 * the existing monitor state untouched. Retries are scheduled only after the
 * prior read settled, and recovery may install exactly one snapshot and loop.
 * The optional seams keep this startup wiring deterministic to regression test.
 */
export function startProtectiveExitRestoreCoordinator(
  options: ProtectiveExitRestoreCoordinatorOptions,
): void {
  const installSnapshot = options.installSnapshot ?? restoreArmedPositions;
  const monitor = options.monitor ?? monitorRestoredProtectiveExits;
  const startMonitorLoop = options.startMonitorLoop ?? ((tick: () => void): RestoreTimer => {
    const timer = setInterval(tick, 15_000);
    timer.unref();
    return timer;
  });
  const scheduleRetryTimer = options.scheduleRetry ?? ((retry: () => void, delayMs: number): RestoreTimer => {
    const timer = setTimeout(retry, delayMs);
    timer.unref();
    return timer;
  });

  let retryTimer: RestoreTimer | null = null;
  let attemptInFlight = false;
  let recovered = false;

  const scheduleRetry = (): void => {
    if (recovered || retryTimer) return;
    retryTimer = scheduleRetryTimer(() => {
      retryTimer = null;
      void attemptRestore();
    }, options.retryIntervalMs);
    retryTimer.unref?.();
  };

  const attemptRestore = async (): Promise<void> => {
    if (recovered || attemptInFlight) return;
    attemptInFlight = true;
    try {
      const [positionsResult, legacyTickersResult, ethMartingaleOrdersResult] = await Promise.allSettled([
        options.loadPositions(),
        options.loadLegacyTickers(),
        options.loadEthMartingaleOrders(),
      ]);
      if (
        positionsResult.status === "rejected" ||
        legacyTickersResult.status === "rejected" ||
        ethMartingaleOrdersResult.status === "rejected"
      ) {
        logger.warn(
          "Startup: protective-exit restore read failed — retaining coverage and retrying after all reads settled",
        );
        return;
      }
      const positions = positionsResult.value;
      const legacyTickers = legacyTickersResult.value;
      const ethMartingaleOrders = ethMartingaleOrdersResult.value;
      if (positions === null || legacyTickers === null || ethMartingaleOrders === null) {
        logger.warn(
          "Startup: protective-exit restore unavailable (DB not ready) — retaining coverage and retrying",
        );
        return;
      }

      const knownTickers = new Set(positions.map((position) => position.ticker));
      installSnapshot(
        [...positions, ...legacyTickers.filter((ticker) => !knownTickers.has(ticker))],
        ethMartingaleOrders,
      );
      if (positions.length + legacyTickers.length > 0) {
        void monitor();
        startMonitorLoop(() => { void monitor(); });
      }
      recovered = true;
      logger.info(
        { confirmedCount: positions.length, legacyCount: legacyTickers.length, ethMartingaleOrderCount: ethMartingaleOrders.length },
        "Startup: restored all open positions for reduce-only protective exits",
      );
    } catch (err) {
      logger.warn({ err }, "Startup: protective-exit restore retry failed; scheduling another retry");
    } finally {
      attemptInFlight = false;
      if (!recovered) scheduleRetry();
    }
  };

  void attemptRestore();
}

type RestoreTimer = { unref?: () => void };
