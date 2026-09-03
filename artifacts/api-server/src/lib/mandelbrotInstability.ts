/**
 * Mandelbrot Instability V1 — research-only market observation scoring.
 *
 * This module intentionally has no imports from order placement, Kalshi clients,
 * strategy guards, or storage. Callers opt in by passing enabled: true and an
 * injected writer; all capture failures are swallowed so research cannot affect
 * the surrounding trading workflow.
 *
 * Reliability improvements (v1.1):
 *  - Bounded capture queue with observable counters (drops, failures, queue depth).
 *  - BBO-derived spread fed into capture with explicit quality flag; depth marked
 *    unavailable rather than falsely reported as zero.
 *  - Quote-path hydration from NDJSON on startup so paths survive a server restart.
 *  - Fill-aware outcome reconciliation joins confirmed analytics fills to settled
 *    observations so fill/P&L metrics are evidence-backed. Post-entry price-move
 *    metrics stay unknown until genuine later quote evidence exists.
 *  - Report denominators distinguish unknown evidence from zero.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const MANDELBROT_INSTABILITY_VERSION = "mandelbrot-instability-v1";
export const MANDELBROT_MIN_SECONDS_LEFT = 30;
export const MANDELBROT_MAX_SECONDS_LEFT = 120;

export type MandelbrotSide = "yes" | "no";

/** How spread/depth values were obtained. */
export type MandelbrotBookQuality =
  | "bbo_derived"       // computed from BBO bid/ask fields — available without L2 fetch
  | "l2_snapshot"       // from a full orderbook snapshot (higher fidelity)
  | "unavailable";      // data was not available at capture time

export interface MandelbrotQuote {
  timestampMs: number;
  executablePriceCents: number | null;
  spreadCents?: number | null;
  executableDepthContracts?: number | null;
  quoteAgeMs?: number | null;
  wsStale?: boolean;
  realizedVolatility?: number | null;
}

export interface MandelbrotScoreComponents {
  pathRoughness: number;
  reversals: number;
  acceleration: number;
  spreadWidening: number;
  depthDeterioration: number;
  quoteStaleness: number;
  realizedVolatility: number;
  quoteSensitivity: number;
}

export interface MandelbrotScore {
  version: typeof MANDELBROT_INSTABILITY_VERSION;
  score: number;
  components: MandelbrotScoreComponents;
}

export interface MandelbrotCaptureInput {
  enabled?: boolean;
  ticker: string;
  timestampMs: number;
  secondsLeft: number;
  side: MandelbrotSide;
  executablePriceCents: number | null;
  quotes: readonly MandelbrotQuote[];
  spreadCents?: number | null;
  spreadQuality?: MandelbrotBookQuality | null;
  executableDepthContracts?: number | null;
  depthQuality?: MandelbrotBookQuality | null;
  quoteAgeMs?: number | null;
  wsStale?: boolean;
  /** Filled/settled evidence is optional and may be enriched later. */
  filled?: boolean | null;
  fallingKnife?: boolean | null;
  finalExecutablePriceCents?: number | null;
  settled?: boolean | null;
  won?: boolean | null;
  netPnlDollars?: number | null;
  roi?: number | null;
  /** True if fill data was reconciled from confirmed analytics fills. */
  fillsReconciled?: boolean | null;
}

export interface MandelbrotObservation extends MandelbrotCaptureInput {
  version: typeof MANDELBROT_INSTABILITY_VERSION;
  score: number;
  components: MandelbrotScoreComponents;
}

export type MandelbrotWriter = (observation: MandelbrotObservation) => void | Promise<void>;

// ── In-memory quote path cache (keyed by ticker) ───────────────────────────────
const pathsByTicker = new Map<string, MandelbrotQuote[]>();

// ── Capture health metrics ─────────────────────────────────────────────────────
const _metrics = {
  enqueueAttempts:  0,
  successfulWrites: 0,
  failedWrites:     0,
  queueDrops:       0,
  queueHighWater:   0,
  lastEnqueueMs:    null as number | null,
  lastWriteMs:      null as number | null,
  lastErrorMs:      null as number | null,
  lastError:        null as string | null,
};

// Bounded async write queue
const MAX_QUEUE = 500;
const _queue: MandelbrotObservation[] = [];
let _queueDraining = false;

function _enqueue(obs: MandelbrotObservation): void {
  _metrics.enqueueAttempts++;
  _metrics.lastEnqueueMs = Date.now();
  if (_queue.length >= MAX_QUEUE) {
    _metrics.queueDrops++;
    return;
  }
  _queue.push(obs);
  _metrics.queueHighWater = Math.max(_metrics.queueHighWater, _queue.length);
  if (!_queueDraining) _drainQueue();
}

function _drainQueue(): void {
  if (_queueDraining || _queue.length === 0) return;
  _queueDraining = true;
  setImmediate(() => {
    try {
      while (_queue.length > 0) {
        const obs = _queue.shift()!;
        try {
          mkdirSync(dataDir(), { recursive: true });
          appendFileSync(researchPath(), `${JSON.stringify(compactObservation(obs))}\n`);
          const latestQuote = obs.quotes.at(-1);
          if (latestQuote) {
            appendFileSync(pathCheckpointPath(), `${JSON.stringify({ ticker: obs.ticker, quote: latestQuote })}\n`);
          }
          _metrics.successfulWrites++;
          _metrics.lastWriteMs = Date.now();
          // Keep storage bounded during continued capture: every N successful
          // writes, compact if the ledger has exceeded the size threshold.
          if (_metrics.successfulWrites % 500 === 0) {
            compactMandelbrotObservationsIfNeeded();
          }
        } catch (err) {
          _metrics.failedWrites++;
          _metrics.lastErrorMs = Date.now();
          _metrics.lastError = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      _queueDraining = false;
    }
  });
}

/** Current capture health counters (read-only snapshot). */
export function getMandelbrotCaptureStatus() {
  return {
    enabled:          process.env["MANDELBROT_INSTABILITY_CAPTURE_ENABLED"] === "true",
    version:          MANDELBROT_INSTABILITY_VERSION,
    enqueueAttempts:  _metrics.enqueueAttempts,
    successfulWrites: _metrics.successfulWrites,
    failedWrites:     _metrics.failedWrites,
    queueDrops:       _metrics.queueDrops,
    queueHighWater:   _metrics.queueHighWater,
    queueDepth:       _queue.length,
    lastEnqueueMs:    _metrics.lastEnqueueMs,
    lastWriteMs:      _metrics.lastWriteMs,
    lastErrorMs:      _metrics.lastErrorMs,
    lastError:        _metrics.lastError,
    pathsHydrated:    pathsByTicker.size,
  };
}

// ── Pure scoring ───────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

function validPrices(quotes: readonly MandelbrotQuote[]): number[] {
  return quotes
    .map((quote) => quote.executablePriceCents)
    .filter((price): price is number => price !== null && Number.isFinite(price) && price >= 0 && price <= 100);
}

/** Deterministic 0–100 score from a caller-supplied, already-observed quote path. */
export function scoreMandelbrotInstability(
  quotes: readonly MandelbrotQuote[],
  current: Pick<MandelbrotCaptureInput, "spreadCents" | "executableDepthContracts" | "quoteAgeMs" | "wsStale">,
): MandelbrotScore {
  const path = validPrices(quotes);
  const changes = path.slice(1).map((price, index) => price - path[index]);
  const absoluteChanges = changes.map(Math.abs);
  const roughness = clamp(absoluteChanges.reduce((sum, value) => sum + value, 0) * 2, 0, 20);
  const reversals = clamp(
    changes.slice(1).filter((change, index) => change !== 0 && changes[index] !== 0 && Math.sign(change) !== Math.sign(changes[index])).length * 4,
    0,
    15,
  );
  const acceleration = clamp(
    changes.slice(1).reduce((sum, change, index) => sum + Math.abs(change - changes[index]), 0) * 2,
    0,
    15,
  );
  const spreads = quotes.map((quote) => quote.spreadCents).filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value >= 0);
  const spreadNow = current.spreadCents ?? spreads.at(-1) ?? 0;
  const spreadWidening = clamp(Math.max(0, spreadNow - (spreads[0] ?? spreadNow)) * 4, 0, 10);
  const depths = quotes.map((quote) => quote.executableDepthContracts).filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value >= 0);
  const depthNow = current.executableDepthContracts ?? depths.at(-1);
  const depthDeterioration = depths.length && depthNow !== undefined && depths[0] > 0
    ? clamp(((depths[0] - depthNow) / depths[0]) * 10, 0, 10)
    : 0;
  const quoteAge = current.quoteAgeMs ?? quotes.at(-1)?.quoteAgeMs ?? 0;
  const quoteStaleness = clamp((quoteAge / 1_000) + (current.wsStale ? 5 : 0), 0, 10);
  const realizedVolatility = clamp((quotes.at(-1)?.realizedVolatility ?? 0) * 20, 0, 10);
  const quoteSensitivity = clamp(absoluteChanges.filter((change) => change > 0 && change <= 1).length * 2, 0, 10);
  const components = {
    pathRoughness: roughness, reversals, acceleration, spreadWidening,
    depthDeterioration, quoteStaleness, realizedVolatility, quoteSensitivity,
  };
  return {
    version: MANDELBROT_INSTABILITY_VERSION,
    score: clamp(Math.round(Object.values(components).reduce((sum, value) => sum + value, 0)), 0, 100),
    components,
  };
}

export function isMandelbrotEligible(input: Pick<MandelbrotCaptureInput, "ticker" | "secondsLeft">): boolean {
  return /KX(?:BTC|ETH)15M/i.test(input.ticker)
    && input.secondsLeft >= MANDELBROT_MIN_SECONDS_LEFT
    && input.secondsLeft <= MANDELBROT_MAX_SECONDS_LEFT;
}

/**
 * Best-effort passive capture. Returns false for disabled/ineligible/failing
 * calls and never throws or invokes an order/Kalshi operation.
 */
export async function captureMandelbrotInstability(input: MandelbrotCaptureInput, writer: MandelbrotWriter): Promise<boolean> {
  if (input.enabled !== true || !isMandelbrotEligible(input)) return false;
  try {
    const scored = scoreMandelbrotInstability(input.quotes, input);
    await writer({ ...input, ...scored });
    return true;
  } catch {
    return false;
  }
}

/**
 * Add the current already-available BBO-derived price to the local research path,
 * then best-effort append the scored record via the bounded queue. No network,
 * order, or strategy call occurs here. Spread is passed with a quality tag so
 * consumers can distinguish BBO-derived (less precise) from unavailable.
 */
export async function captureMandelbrotFromLiveObservation(
  input: Omit<MandelbrotCaptureInput, "quotes">,
  writer: MandelbrotWriter,
): Promise<boolean> {
  const oldestAllowed = input.timestampMs - 120_000;
  const prior = (pathsByTicker.get(input.ticker) ?? []).filter((quote) => quote.timestampMs >= oldestAllowed);
  const current: MandelbrotQuote = {
    timestampMs: input.timestampMs,
    executablePriceCents: input.executablePriceCents,
    spreadCents: input.spreadCents,
    executableDepthContracts: input.executableDepthContracts,
    quoteAgeMs: input.quoteAgeMs,
    wsStale: input.wsStale,
  };
  const quotes = [...prior, current];
  pathsByTicker.set(input.ticker, quotes);
  return captureMandelbrotInstability({ ...input, quotes }, writer);
}

/** Test-only reset for isolated capture-path tests. */
export function _resetMandelbrotPathsForTesting(): void {
  pathsByTicker.clear();
  // Also reset metrics so tests start clean
  _metrics.enqueueAttempts  = 0;
  _metrics.successfulWrites = 0;
  _metrics.failedWrites     = 0;
  _metrics.queueDrops       = 0;
  _metrics.queueHighWater   = 0;
  _metrics.lastEnqueueMs    = null;
  _metrics.lastWriteMs      = null;
  _metrics.lastErrorMs      = null;
  _metrics.lastError        = null;
}

// ── Paths ──────────────────────────────────────────────────────────────────────

let _dataDirOverride: string | null = null;
function dataDir(): string {
  return _dataDirOverride ?? process.env["MANDELBROT_DATA_DIR"] ?? join(process.cwd(), "data");
}
function researchPath(): string {
  return join(dataDir(), "mandelbrot-instability-v1.ndjson");
}
function settlementsPath(): string {
  return join(dataDir(), "mandelbrot-instability-v1-settlements.ndjson");
}

/** Test-only: redirect research/settlement files to an isolated directory. */
export function _setMandelbrotDataDirForTesting(dir: string): void {
  _dataDirOverride = dir;
}
function pathCheckpointPath(): string {
  return join(dataDir(), "mandelbrot-instability-v1-paths.ndjson");
}

/**
 * Read a potentially large local NDJSON ledger without ever constructing one
 * giant JavaScript string. A corrupt line is deliberately handed to the caller
 * as-is so individual-record parsing can skip it without hiding valid records
 * that follow.
 */
function forEachNdjsonLine(path: string, visit: (line: string) => void): void {
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const maxRecordBytes = 1 * 1024 * 1024;
  let pending = Buffer.alloc(0);
  let discardingOversizedRecord = false;
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        if (discardingOversizedRecord) {
          const newline = chunk.indexOf(0x0a, offset);
          if (newline < 0) break;
          discardingOversizedRecord = false;
          offset = newline + 1;
          continue;
        }

        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? bytesRead : newline;
        const segment = chunk.subarray(offset, end);
        if (pending.length + segment.length > maxRecordBytes) {
          pending = Buffer.alloc(0);
          discardingOversizedRecord = newline < 0;
        } else if (newline < 0) {
          pending = pending.length ? Buffer.concat([pending, segment]) : Buffer.from(segment);
        } else {
          const line = pending.length ? Buffer.concat([pending, segment]) : segment;
          pending = Buffer.alloc(0);
          visit(line.toString("utf8"));
        }

        if (newline < 0) break;
        offset = newline + 1;
      }
    } while (bytesRead > 0);
    if (!discardingOversizedRecord && pending.length) visit(pending.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/**
 * Quotes are needed only while scoring an in-memory path. Persisting the same
 * 120-second path inside every result row caused the research ledger to grow
 * quadratically. Keep score evidence, not the repeatedly copied path.
 */
function compactObservation(observation: MandelbrotObservation): Omit<MandelbrotObservation, "quotes"> & { quoteCount: number } {
  const { quotes = [], ...compact } = observation;
  return { ...compact, quoteCount: quotes.length };
}

// ── Startup path hydration ─────────────────────────────────────────────────────

/**
 * Restore recent per-ticker quote paths from the NDJSON observation file so the
 * price-path context survives a server restart. Only quotes within the last 120
 * seconds relative to the most recent observation per ticker are kept. Safe to
 * call multiple times; idempotent (later calls extend with newer quotes).
 * Never throws.
 */
export function hydrateMandelbrotPathsFromFile(): void {
  try {
    // Compact first so a legacy oversized ledger becomes readable and bounded.
    compactMandelbrotObservationsIfNeeded();
    const now = Date.now();
    const WINDOW = 120_000;
    const quotesByTicker = new Map<string, MandelbrotQuote[]>();
    const appendRecentQuote = (ticker: string, quote: MandelbrotQuote): void => {
      if (quote.timestampMs < now - WINDOW || quote.timestampMs > now + 5_000) return;
      const list = quotesByTicker.get(ticker) ?? [];
      list.push(quote);
      quotesByTicker.set(ticker, list);
    };

    forEachNdjsonLine(researchPath(), (line) => {
      if (!line) return;
      const obs = parseNdjsonLine<MandelbrotObservation>(line);
      if (!obs || obs.version !== MANDELBROT_INSTABILITY_VERSION) return;
      if (!obs.ticker || !Array.isArray(obs.quotes)) return;
      for (const q of obs.quotes) {
        appendRecentQuote(obs.ticker, q);
      }
    });
    try {
      forEachNdjsonLine(pathCheckpointPath(), (line) => {
        try {
          const checkpoint = JSON.parse(line) as { ticker?: string; quote?: MandelbrotQuote };
          if (checkpoint.ticker && checkpoint.quote) appendRecentQuote(checkpoint.ticker, checkpoint.quote);
        } catch { /* skip malformed */ }
      });
    } catch { /* checkpoint file may not exist yet */ }

    for (const [ticker, quotes] of quotesByTicker) {
      // Deduplicate by timestampMs (keep last seen)
      const deduped = new Map<number, MandelbrotQuote>();
      for (const q of quotes) deduped.set(q.timestampMs, q);
      if (deduped.size > 0) {
        pathsByTicker.set(ticker, [...deduped.values()]
          .sort((a, b) => a.timestampMs - b.timestampMs)
          .slice(-120));
      }
    }
  } catch { /* file may not exist yet — normal on first run */ }
}

// ── Durable observation writer (used by production seam) ──────────────────────

/**
 * Bounded, observable observation writer.  Enqueues into the bounded queue and
 * drains asynchronously via setImmediate; write failures increment counters and
 * never propagate to the caller or affect trading.
 */
export function appendMandelbrotObservation(observation: MandelbrotObservation): void {
  try {
    _enqueue(observation);
  } catch { /* research cannot affect trading */ }
}

// ── Settlement and fill reconciliation ────────────────────────────────────────

interface SettlementRecord {
  ticker: string;
  result: "yes" | "no";
  settled: true;
  reconciledAtMs: number;
  side?: "yes" | "no" | null;
}

function loadMandelbrotSettlements(): Map<string, SettlementRecord> {
  const byTicker = new Map<string, SettlementRecord>();
  try {
    for (const line of readNdjsonLinesSync(settlementsPath())) {
      const rec = parseNdjsonLine<SettlementRecord>(line);
      if (rec && rec.ticker && rec.result) byTicker.set(rec.ticker, rec);
    }
  } catch { /* file may not exist yet */ }
  return byTicker;
}

/**
 * Passive-only settlement enrichment. Called by outcomeReconciler after a
 * market settles. Never throws; never affects order flow.
 */
export function recordMandelbrotSettlement(
  ticker: string,
  result: "yes" | "no",
  side: "yes" | "no" | null,
): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(settlementsPath(), `${JSON.stringify({ ticker, result, settled: true, reconciledAtMs: Date.now(), side })}\n`);
  } catch { /* research settlement persistence cannot affect trading */ }
}

/**
 * Fill-enriched settlement reconciliation.
 *
 * Called by outcomeReconciler after normal order reconciliation is complete.
 * Reads existing NDJSON observations for `ticker`, joins them to the provided
 * confirmed fills, computes evidence-backed P&L and adverse-move, then appends
 * patched records so future report reads reflect the real outcome.
 *
 * Design:
 *  - Does NOT modify the trading path.
 *  - Appends patched records (NDJSON last-write-wins by ticker+timestampMs+side
 *    dedup in loadMandelbrotObservations).
 *  - No matching fills are recorded as a reconciled no-fill observation.
 *  - Fill price proves execution, not a later market move, so it is never used
 *    as `finalExecutablePriceCents`.
 *  - Never throws.
 */
export function enrichMandelbrotWithFilledOrders(
  ticker: string,
  result: "yes" | "no",
  fills: Array<{
    side: "yes" | "no";
    fillPriceCents: number | null;
    contracts: number;
    feeDollars: number;
    netPnlDollars?: number | null;
  }>,
): void {
  try {
    if (!ticker || !result) return;

    // Read only this ticker's records without loading the whole research ledger.
    // Patches are appended after the scan so an active file does not re-read its
    // own new lines during this reconciliation.
    const patches: MandelbrotObservation[] = [];
    let patched = 0;
    try {
      forEachNdjsonLine(researchPath(), (line) => {
        if (!line) return;
        try {
          const obs = parseNdjsonLine<MandelbrotObservation>(line);
          if (!obs || obs.version !== MANDELBROT_INSTABILITY_VERSION) return;
          if (obs.ticker !== ticker) return;
          if (obs.fillsReconciled === true) return; // already patched

          // Match every confirmed partial/full fill on the observed side. A given
          // market can have several fills, so use their aggregate P&L and
          // contracts rather than arbitrarily selecting the largest one.
          const matchingFills = fills.filter((f) => f.side === obs.side);
          const won = obs.side === result;
          const contracts = matchingFills.reduce((sum, fill) => sum + Math.max(0, fill.contracts), 0);
          const pricedContracts = matchingFills
            .filter((fill) => fill.fillPriceCents !== null && fill.contracts > 0);
          const fillNotional = pricedContracts.reduce(
            (sum, fill) => sum + ((fill.fillPriceCents ?? 0) * fill.contracts) / 100,
            0,
          );
          patches.push({
            ...obs,
            filled: matchingFills.length > 0,
            settled: true,
            won,
            // Confirmed fill data does not establish a subsequent quote move.
            // Leave these values unknown instead of turning fill price into a
            // misleading adverse-movement/falling-knife measurement.
            finalExecutablePriceCents: null,
            fallingKnife: null,
            netPnlDollars: matchingFills.length
              ? matchingFills.reduce((sum, fill) => sum + (fill.netPnlDollars ?? 0), 0)
              : null,
            roi: null,
            fillsReconciled: true,
          });
          const patch = patches.at(-1)!;
          const netPnl = patch.netPnlDollars ?? null;
          patch.roi = netPnl !== null && contracts > 0 && fillNotional > 0
            ? netPnl / fillNotional
            : null;
        } catch { /* skip malformed */ }
      });
    } catch { return; }

    for (const patched_obs of patches) {
      try {
        mkdirSync(dataDir(), { recursive: true });
        appendFileSync(researchPath(), `${JSON.stringify(compactObservation(patched_obs))}\n`);
        patched++;
      } catch (err) {
        _metrics.failedWrites++;
        _metrics.lastError = err instanceof Error ? err.message : String(err);
        _metrics.lastErrorMs = Date.now();
      }
    }

    // Record settlement marker regardless of fill availability
    recordMandelbrotSettlement(ticker, result, null);
    // Patches appended — invalidate the cached report so the next read reflects them.
    if (patched > 0) invalidateMandelbrotReportCache();
  } catch { /* enrichment cannot affect trading */ }
}

// ── Observation loading with settlement enrichment ─────────────────────────────

/**
 * Read-only local report source. Enriches records with any available settlement.
 * Deduplicates by ticker+timestampMs+side (last-write-wins) so patched records
 * from enrichMandelbrotWithFilledOrders shadow their originals.
 */
export function loadMandelbrotObservations(): MandelbrotObservation[] {
  const settlements = loadMandelbrotSettlements();
  try {
    // Deduplicate: for same ticker+side+timestampMs keep the last-seen record
    const deduped = new Map<string, MandelbrotObservation>();

    forEachNdjsonLine(researchPath(), (line) => {
      if (!line) return;
      try {
        const record = parseNdjsonLine<MandelbrotObservation>(line);
        if (!record || record.version !== MANDELBROT_INSTABILITY_VERSION) return;
        const key = `${record.ticker}|${record.side}|${record.timestampMs}`;
        // The report needs the scored record, not every historical quote used
        // to derive it. Dropping the path here keeps a large history readable.
        const reportRecord = { ...record, quotes: [] };
        // Apply settlement enrichment for unsettled records when fills not yet reconciled
        if (!reportRecord.fillsReconciled && reportRecord.settled == null) {
          const settlement = settlements.get(record.ticker);
          if (settlement) {
            const won = settlement.result === reportRecord.side;
            deduped.set(key, { ...reportRecord, settled: true, won });
            return;
          }
        }
        deduped.set(key, reportRecord);
      } catch { /* skip malformed */ }
    });
    return [...deduped.values()];
  } catch { return []; }
}

// ── Reporting ──────────────────────────────────────────────────────────────────

export interface MandelbrotBucket {
  label: "0-19" | "20-39" | "40-59" | "60-79" | "80-100";
  sampleCount: number;
  filledCount: number;
  /** Reconciled fill count — fills with confirmed fill data from analytics. */
  reconciledFillCount: number;
  winRate: number | null;
  lossRate: number | null;
  adverseMoveRate: number | null;
  fallingKnifeRate: number | null;
  averagePreflightToFinalMoveCents: number | null;
  netPnlDollars: number | null;
  roi: number | null;
  /** True when evidence is present but not yet fill-reconciled. */
  hasUnreconciledFills: boolean;
}

export interface MandelbrotReportSummary {
  buckets: MandelbrotBucket[];
  totalObservations: number;
  totalFills: number;
  totalReconciledFills: number;
  settledObservations: number;
  /** Fraction of settled observations that have fill-level reconciliation. */
  reconciliationCompleteness: number | null;
  /** Quality breakdown: how many observations have BBO vs L2 vs unavailable spread data. */
  spreadQualityCounts: {
    bbo_derived: number;
    l2_snapshot: number;
    unavailable: number;
  };
}

const bucketLabels: MandelbrotBucket["label"][] = ["0-19", "20-39", "40-59", "60-79", "80-100"];
function bucketFor(score: number): MandelbrotBucket["label"] {
  return score >= 80 ? "80-100" : score >= 60 ? "60-79" : score >= 40 ? "40-59" : score >= 20 ? "20-39" : "0-19";
}
const average = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** Read-only aggregation. Null means the relevant evidence is not known yet. */
export function reportMandelbrotInstability(observations: readonly MandelbrotObservation[]): MandelbrotBucket[] {
  return bucketLabels.map((label) => {
    const records = observations.filter((record) => bucketFor(record.score) === label);
    const filled = records.filter((record) => record.filled === true);
    const reconciledFills = filled.filter((record) => record.fillsReconciled === true);
    const settledFilled = filled.filter((record) => record.settled === true && record.won !== null && record.won !== undefined);
    const adverseKnown = records.filter((record) => record.executablePriceCents !== null && record.finalExecutablePriceCents !== null && record.finalExecutablePriceCents !== undefined);
    const knifeKnown = records.filter((record) => record.fallingKnife !== null && record.fallingKnife !== undefined);
    const pnl = settledFilled.map((record) => record.netPnlDollars).filter((value): value is number => value !== null && value !== undefined);
    const roi = settledFilled.map((record) => record.roi).filter((value): value is number => value !== null && value !== undefined);
    return {
      label,
      sampleCount: records.length,
      filledCount: filled.length,
      reconciledFillCount: reconciledFills.length,
      winRate: settledFilled.length ? settledFilled.filter((record) => record.won).length / settledFilled.length : null,
      lossRate: settledFilled.length ? settledFilled.filter((record) => !record.won).length / settledFilled.length : null,
      adverseMoveRate: adverseKnown.length ? adverseKnown.filter((record) => (record.finalExecutablePriceCents! - record.executablePriceCents!) >= 4).length / adverseKnown.length : null,
      fallingKnifeRate: knifeKnown.length ? knifeKnown.filter((record) => record.fallingKnife).length / knifeKnown.length : null,
      averagePreflightToFinalMoveCents: average(adverseKnown.map((record) => record.finalExecutablePriceCents! - record.executablePriceCents!)),
      netPnlDollars: pnl.length ? pnl.reduce((sum, value) => sum + value, 0) : null,
      roi: average(roi),
      hasUnreconciledFills: filled.length > 0 && reconciledFills.length < filled.length,
    };
  });
}

/** Full report summary including health metadata. */
export function buildMandelbrotReportSummary(observations: readonly MandelbrotObservation[]): MandelbrotReportSummary {
  const buckets = reportMandelbrotInstability(observations);
  const filled = observations.filter((o) => o.filled === true);
  const reconciledFills = filled.filter((o) => o.fillsReconciled === true);
  const settled = observations.filter((o) => o.settled === true);
  const spreadQuality = { bbo_derived: 0, l2_snapshot: 0, unavailable: 0 };
  for (const obs of observations) {
    const q = obs.spreadQuality ?? "unavailable";
    if (q === "bbo_derived") spreadQuality.bbo_derived++;
    else if (q === "l2_snapshot") spreadQuality.l2_snapshot++;
    else spreadQuality.unavailable++;
  }
  return {
    buckets,
    totalObservations: observations.length,
    totalFills: filled.length,
    totalReconciledFills: reconciledFills.length,
    settledObservations: settled.length,
    reconciliationCompleteness: filled.length > 0 ? reconciledFills.length / filled.length : null,
    spreadQualityCounts: spreadQuality,
  };
}

// ── Report TTL cache ───────────────────────────────────────────────────────────

/**
 * Short-TTL in-memory cache for the Mandelbrot report.
 *
 * `loadMandelbrotObservations` streams and synchronously parses the entire
 * NDJSON ledger on every call. At the compaction threshold (~64 MB) that is
 * ~1 000 blocking readSync calls which can stall the event loop for tens of
 * milliseconds — the same process that places live orders. A 30-second cache
 * keeps the report fresh for the UI while ensuring at most one file parse per
 * 30-second window regardless of how many concurrent requests arrive.
 *
 * The cache is invalidated eagerly whenever compaction rewrites the ledger or
 * settlement enrichment appends new patches, so the report reflects the latest
 * data within one TTL cycle even after a burst of activity.
 */
export const REPORT_CACHE_TTL_MS = 30_000;

interface ReportCache {
  builtAtMs: number;
  observations: MandelbrotObservation[];
  summary: MandelbrotReportSummary;
}

let _reportCache: ReportCache | null = null;
let _reportCacheHits   = 0;
let _reportCacheMisses = 0;

/** Discard the cached report so the next call re-reads the ledger. */
export function invalidateMandelbrotReportCache(): void {
  _reportCache = null;
}

/** Test-only: reset all cache state so each test starts clean. */
export function _resetMandelbrotReportCacheForTesting(): void {
  _reportCache = null;
  _reportCacheHits = 0;
  _reportCacheMisses = 0;
}

/**
 * Test-only: artificially age the current cache entry by setting builtAtMs to
 * `Date.now() - ageMs`. No-op when the cache is empty. Used to simulate TTL
 * expiry without sleeping for 30 seconds.
 */
export function _ageReportCacheForTesting(ageMs: number): void {
  if (_reportCache) _reportCache.builtAtMs = Date.now() - ageMs;
}

/**
 * Return a cached {observations, summary} pair, rebuilding from disk at most
 * once every REPORT_CACHE_TTL_MS. Safe to call from any request handler —
 * a cache hit returns immediately with no disk I/O.
 */
export function getCachedMandelbrotReport(): {
  observations: MandelbrotObservation[];
  summary: MandelbrotReportSummary;
  cacheHits: number;
  cacheMisses: number;
  cacheAgeMs: number | null;
} {
  const now = Date.now();
  if (_reportCache && now - _reportCache.builtAtMs < REPORT_CACHE_TTL_MS) {
    _reportCacheHits++;
    return {
      observations: _reportCache.observations,
      summary:      _reportCache.summary,
      cacheHits:    _reportCacheHits,
      cacheMisses:  _reportCacheMisses,
      cacheAgeMs:   now - _reportCache.builtAtMs,
    };
  }
  _reportCacheMisses++;
  const observations = loadMandelbrotObservations();
  const summary      = buildMandelbrotReportSummary(observations);
  _reportCache = { builtAtMs: now, observations, summary };
  return {
    observations,
    summary,
    cacheHits:   _reportCacheHits,
    cacheMisses: _reportCacheMisses,
    cacheAgeMs:  0,
  };
}

/**
 * Parse one NDJSON line into an object. If direct parse fails (e.g. a Git-LFS
 * pointer fragment fused onto the front of a real observation), retry from the
 * first `{`. Returns null when nothing parseable is found.
 */
export function parseNdjsonLine<T>(line: string): T | null {
  try {
    const value = JSON.parse(line) as T;
    return value && typeof value === "object" ? value : null;
  } catch { /* fall through to salvage */ }
  const brace = line.indexOf("{");
  if (brace > 0) {
    try {
      const value = JSON.parse(line.slice(brace)) as T;
      return value && typeof value === "object" ? value : null;
    } catch { /* unsalvageable */ }
  }
  return null;
}

/** Max bytes a single NDJSON line may occupy before it is discarded as corrupt. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1 << 20;

/**
 * Synchronously iterate the lines of a file without loading it into one
 * string. Lines longer than MAX_LINE_BYTES are dropped (never yielded).
 * Throws only if the file cannot be opened (callers already catch, e.g.
 * ENOENT on first run).
 */
export function* readNdjsonLinesSync(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let leftover: Buffer = Buffer.alloc(0);
    let discardingOversizedLine = false;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const data = leftover.length > 0
        ? Buffer.concat([leftover, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl === -1) break;
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
        } else if (nl > start) {
          yield data.toString("utf8", start, nl);
        }
        start = nl + 1;
      }
      leftover = Buffer.from(data.subarray(start));
      if (leftover.length > MAX_LINE_BYTES) {
        leftover = Buffer.alloc(0);
        discardingOversizedLine = true;
      }
    }
    if (leftover.length > 0 && !discardingOversizedLine) {
      yield leftover.toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
}

/** Iterate valid, version-matched observations in file order. */
function* readObservationRecords(): Generator<MandelbrotObservation> {
  for (const line of readNdjsonLinesSync(researchPath())) {
    const obs = parseNdjsonLine<MandelbrotObservation>(line);
    if (!obs || obs.version !== MANDELBROT_INSTABILITY_VERSION) continue;
    yield obs;
  }
}

export const MANDELBROT_COMPACT_THRESHOLD_BYTES = 64 * 1024 * 1024;
const COMPACT_MAX_RECORDS = 50_000;

const HYDRATION_WINDOW_MS = 120_000;

/**
 * Compact the observation ledger when it exceeds `thresholdBytes`. Read-only
 * with respect to trading: touches only the research NDJSON file. Never throws.
 * Returns true when a compaction rewrite happened.
 */
export function compactMandelbrotObservationsIfNeeded(
  thresholdBytes: number = MANDELBROT_COMPACT_THRESHOLD_BYTES,
  nowMs: number = Date.now(),
): boolean {
  try {
    const path = researchPath();
    let size = 0;
    try {
      size = statSync(path).size;
    } catch { return false; /* no file yet */ }
    if (size <= thresholdBytes) return false;

    // Ring buffer of the newest COMPACT_MAX_RECORDS serialized records.
    const ring: string[] = new Array(COMPACT_MAX_RECORDS);
    let count = 0;
    const cutoffMs = nowMs - HYDRATION_WINDOW_MS;
    for (const obs of readObservationRecords()) {
      const keepQuotes = typeof obs.timestampMs === "number" && obs.timestampMs >= cutoffMs;
      const compacted = keepQuotes ? obs : { ...obs, quotes: [] };
      ring[count % COMPACT_MAX_RECORDS] = JSON.stringify(compacted);
      count++;
    }

    const tmp = `${path}.${process.pid}.compact.tmp`;
    const fd = openSync(tmp, "w");
    try {
      const kept = Math.min(count, COMPACT_MAX_RECORDS);
      const startIndex = count - kept;
      for (let i = 0; i < kept; i++) {
        writeSync(fd, `${ring[(startIndex + i) % COMPACT_MAX_RECORDS]}\n`);
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    // Compaction rewrote the ledger — cached report is stale.
    invalidateMandelbrotReportCache();
    return true;
  } catch (err) {
    _metrics.lastError = err instanceof Error ? err.message : String(err);
    _metrics.lastErrorMs = Date.now();
    return false;
  }
}
