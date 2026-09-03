/**
 * ETH 21–25¢ → 50¢ prospective cohort.
 *
 * This module is deliberately passive: it has no Kalshi client, no order
 * functions, no live claims, and no environment switch that can enable trades.
 */
import { easternDay } from "../dailyBudget.js";
import {
  insertEth2125ProspectiveRow, listEth2125ProspectiveRows, listTargetLiquiditySnapshots,
  listMarketResultsForTickers, markEth2125ProspectiveTarget,
} from "../tradeStore.js";
import { extractBidDepthAtOrAboveTarget, type TargetLiquiditySnapshotParams } from "./targetLiquidity.js";
import type { KalshiOrderbookRaw } from "../orderbookParsing.js";

export const ETH2125_COHORT_START_MS = Date.parse("2026-08-17T00:00:00.000Z");
export const ETH2125_ENTRY_MIN_CENTS = 21;
export const ETH2125_ENTRY_MAX_CENTS = 25;
export const ETH2125_TARGET_CENTS = 50;
export const ETH2125_NOTIONAL_CENTS = 1_000;
export const ETH2125_REVIEW_TRADES = 30;
/** Strategy key for depth snapshots retained in target_liquidity_snapshots. */
export const ETH2125_DEPTH_STRATEGY = "ETH2125_PROSPECTIVE";
/** Min ms between depth snapshots per ticker (bounds exchange reads). */
export const ETH2125_DEPTH_SNAPSHOT_INTERVAL_MS = 30_000;

export interface Eth2125Candidate {
  ticker: string; observedAtMs: number; side: "yes" | "no"; priceCents: number; depthContracts: number;
}

/** Same $10 floor-sizing policy used by the historical replay. */
export function eth2125Contracts(priceCents: number, depthContracts: number): number {
  if (!Number.isInteger(priceCents) || priceCents < ETH2125_ENTRY_MIN_CENTS || priceCents > ETH2125_ENTRY_MAX_CENTS) return 0;
  return Math.max(0, Math.min(Math.floor(ETH2125_NOTIONAL_CENTS / priceCents), Math.floor(depthContracts)));
}

/** Kalshi's displayed taker-fee curve; marked as an estimate until a real fill exists. */
export function estimateEth2125EntryFeeCents(contracts: number, priceCents: number): number {
  return Math.round(contracts * 0.07 * priceCents * (100 - priceCents) / 100);
}

export async function recordEth2125ProspectiveCandidate(candidate: Eth2125Candidate): Promise<void> {
  if (candidate.observedAtMs < ETH2125_COHORT_START_MS) return;
  const contracts = eth2125Contracts(candidate.priceCents, candidate.depthContracts);
  if (contracts === 0) return;
  await insertEth2125ProspectiveRow({
    ticker: candidate.ticker, cohortStartMs: ETH2125_COHORT_START_MS,
    easternDate: easternDay(new Date(candidate.observedAtMs)), observedAtMs: candidate.observedAtMs,
    side: candidate.side, entryPriceCents: candidate.priceCents, contracts,
    entryCostCents: contracts * candidate.priceCents,
    estimatedEntryFeeCents: estimateEth2125EntryFeeCents(contracts, candidate.priceCents),
    firstTargetAtMs: null, firstTargetBidCents: null,
  });
}

// ── Depth-evidence retention policy (bounded) ─────────────────────────────────
//
// Cohort depth snapshots must survive the default target-liquidity retention
// until the 30-trade review can actually happen, but the exemption is not
// permanent: it lifts a fixed grace period after the gate row was recorded,
// after which the shared table's normal retention bounds the strategy's rows.

/** How long depth evidence stays prune-exempt after the review gate is reached. */
export const ETH2125_DEPTH_RETENTION_GRACE_MS = 30 * 86_400_000;

/**
 * Pure policy core: retain while the cohort is still accumulating toward the
 * review gate, or within the grace window after the gate row's observation.
 */
export function eth2125DepthRetentionActive(
  rowCount: number, gateRowObservedAtMs: number | null, nowMs: number,
): boolean {
  if (rowCount < ETH2125_REVIEW_TRADES) return true;
  return gateRowObservedAtMs != null
    && nowMs - gateRowObservedAtMs < ETH2125_DEPTH_RETENTION_GRACE_MS;
}

/**
 * Should the prune job exempt ETH2125 depth snapshots right now?
 * Fail-safe: a storage-degraded row listing returns [], which reads as
 * "still accumulating" and retains the evidence rather than deleting it.
 */
export async function shouldRetainEth2125DepthEvidence(nowMs = Date.now()): Promise<boolean> {
  const rows = await listEth2125ProspectiveRows(); // observedAt-ascending
  const gateRow = rows.length >= ETH2125_REVIEW_TRADES ? rows[ETH2125_REVIEW_TRADES - 1]! : null;
  return eth2125DepthRetentionActive(rows.length, gateRow?.observedAtMs ?? null, nowMs);
}

// ── Post-touch depth evidence (passive, injected I/O) ─────────────────────────
//
// A recorded 50¢ reach is only a displayed BBO touch. To audit whether the
// full hypothetical $10 position had executable depth, a throttled observer
// captures the executable bid levels at/above the target whenever the owned
// side's bid is at/above 50¢ post-entry. Snapshots persist to the shared
// target_liquidity_snapshots table under ETH2125_DEPTH_STRATEGY with the
// hypothetical position size as restingContracts. Fire-and-forget; this
// module still has no order capability — the orderbook fetch is injected.

export interface Eth2125DepthCaptureDeps {
  fetchOrderbookRaw(ticker: string): Promise<KalshiOrderbookRaw>;
  insertSnapshot(params: TargetLiquiditySnapshotParams): void;
  now?(): number;
}

const _depthLastCaptureMs = new Map<string, number>();
const _depthInFlight = new Set<string>();

/** Test-only: reset in-memory depth-capture throttle state. */
export function _resetEth2125DepthStateForTesting(): void {
  _depthLastCaptureMs.clear(); _depthInFlight.clear();
}

async function captureEth2125TargetDepth(
  row: { ticker: string; side: "yes" | "no"; contracts: number; observedAtMs: number },
  bidCents: number, deps: Eth2125DepthCaptureDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  let levels: TargetLiquiditySnapshotParams["bidLevelsAtOrAboveTarget"] = [];
  let contracts = 0;
  let bookError: string | null = null;
  try {
    const raw = await deps.fetchOrderbookRaw(row.ticker);
    const depth = extractBidDepthAtOrAboveTarget(raw, row.side, ETH2125_TARGET_CENTS);
    levels = depth.levels;
    contracts = depth.contracts;
  } catch (err) {
    bookError = err instanceof Error ? err.message : String(err);
  }
  const capturedAtMs = now();
  deps.insertSnapshot({
    id: `${ETH2125_DEPTH_STRATEGY}:${row.ticker}:${capturedAtMs}`,
    strategy: ETH2125_DEPTH_STRATEGY, ticker: row.ticker,
    easternDate: easternDay(new Date(capturedAtMs)), side: row.side,
    // No real order exists: the hypothetical $10 position stands in for the
    // resting target so the shared classifier's depth-vs-size comparison holds.
    targetOrderDbId: null, targetKalshiOrderId: null, targetPlacedAtMs: row.observedAtMs,
    orderStatus: null, restingContracts: row.contracts, observedBidCents: bidCents,
    bidLevelsAtOrAboveTarget: levels, contractsAtOrAboveTarget: contracts,
    bookError, capturedAtMs,
  });
  // Deliberately no "confirmed once" suppression: insertSnapshot is
  // fire-and-forget and may drop a write under storage degradation, so the
  // observer keeps capturing on every throttled touch — the next touch
  // repairs a lost snapshot. Reads stay bounded by the interval and the
  // market's finite lifetime.
}

/** A direct post-entry BBO only; no quote is carried forward across timestamps. */
export async function observeEth2125ProspectiveTarget(
  ticker: string, observedAtMs: number, yesBid: number | null | undefined, noBid: number | null | undefined,
  depthDeps?: Eth2125DepthCaptureDeps,
): Promise<void> {
  const rows = await listEth2125ProspectiveRows();
  const row = rows.find((r) => r.ticker === ticker);
  if (!row || observedAtMs <= row.observedAtMs) return;
  const bid = row.side === "yes" ? yesBid : noBid;
  if (bid == null || bid < ETH2125_TARGET_CENTS) return;
  if (row.firstTargetAtMs == null) await markEth2125ProspectiveTarget(ticker, observedAtMs, bid);
  // Throttled depth evidence on every touch while it persists.
  if (!depthDeps || _depthInFlight.has(ticker)) return;
  const nowMs = (depthDeps.now ?? Date.now)();
  const last = _depthLastCaptureMs.get(ticker);
  if (last != null && nowMs - last < ETH2125_DEPTH_SNAPSHOT_INTERVAL_MS) return;
  _depthLastCaptureMs.set(ticker, nowMs);
  _depthInFlight.add(ticker);
  try {
    await captureEth2125TargetDepth(row, bid, depthDeps);
  } finally { _depthInFlight.delete(ticker); }
}

/**
 * Depth-evidence classification for a recorded 50¢ target reach:
 *   • depth_confirmed    — some usable snapshot showed executable depth at/above
 *                          50¢ covering the full hypothetical position size.
 *   • insufficient_depth — usable snapshots exist but none covered the size.
 *   • bbo_touch_only     — the reach is only a displayed BBO touch; no usable
 *                          depth snapshot was retained.
 *   • not_reached        — the target was never recorded as reached.
 */
export type Eth2125DepthClassification =
  | "depth_confirmed" | "insufficient_depth" | "bbo_touch_only" | "not_reached";

export interface Eth2125DepthAudit {
  classification: Eth2125DepthClassification;
  snapshotCount: number;
  usableSnapshotCount: number;
  maxContractsAtOrAboveTarget: number | null;
  /** True when depth ≥ the hypothetical position size in ≥1 usable snapshot. */
  depthConfirmed: boolean;
}

export interface Eth2125ProspectiveReport {
  researchOnly: true; tradingCapability: "none"; cohortStartMs: number; reviewGateTrades: number;
  benchmark: { trades: number; wins: number; losses: number; targetHitRate: number; netPnlCents: number; maxDrawdownCents: number };
  summary: { eligibleTrades: number; targetHits: number; targetHitRate: number | null; wins: number; losses: number; grossPnlCents: number; feesCents: number; netPnlCents: number; averageWinnerCents: number | null; averageLoserCents: number | null; maxDrawdownCents: number; reviewReady: boolean; openTrades: number;
    /** Target hits whose full hypothetical size had executable depth. */
    targetHitsDepthConfirmed: number;
    /** Target hits with usable depth data that never covered the size. */
    targetHitsInsufficientDepth: number;
    /** Target hits with no usable depth evidence (displayed touch only). */
    targetHitsBboTouchOnly: number;
    /** True only when review-ready AND every recorded hit is depth-confirmed. */
    reviewEvidenceComplete: boolean };
  rows: Array<{ ticker: string; side: "yes" | "no"; entryPriceCents: number; contracts: number; targetReachedAtMs: number | null; settlementResult: "yes" | "no" | null; grossPnlCents: number | null; feeCents: number; netPnlCents: number | null; cumulativeNetPnlCents: number; depthAudit: Eth2125DepthAudit }>;
}

/** Pure depth audit of one recorded reach against retained snapshots. */
export function auditEth2125TargetDepth(
  targetReachedAtMs: number | null,
  hypotheticalContracts: number,
  snapshots: readonly { contractsAtOrAboveTarget: number; bookError: string | null }[],
): Eth2125DepthAudit {
  const usable = snapshots.filter((s) => s.bookError == null);
  const maxDepth = usable.length > 0 ? Math.max(...usable.map((s) => s.contractsAtOrAboveTarget)) : null;
  const depthConfirmed = maxDepth != null && maxDepth >= hypotheticalContracts;
  const classification: Eth2125DepthClassification =
    targetReachedAtMs == null ? "not_reached"
    : usable.length === 0 ? "bbo_touch_only"
    : depthConfirmed ? "depth_confirmed"
    : "insufficient_depth";
  return {
    classification, snapshotCount: snapshots.length, usableSnapshotCount: usable.length,
    maxContractsAtOrAboveTarget: maxDepth, depthConfirmed: classification === "depth_confirmed",
  };
}

export async function buildEth2125ProspectiveReport(): Promise<Eth2125ProspectiveReport> {
  const stored = await listEth2125ProspectiveRows();
  const results = await listMarketResultsForTickers(stored.map((r) => r.ticker));
  // Depth snapshots retained since the cohort start. The explicit cutoff only
  // widens the read window; durability comes from the startup prune job
  // exempting ETH2125_DEPTH_STRATEGY (see index.ts) so cohort depth evidence
  // survives past the default 30-day retention until the review completes.
  const snapshots = await listTargetLiquiditySnapshots(
    ETH2125_DEPTH_STRATEGY, easternDay(new Date(ETH2125_COHORT_START_MS)));
  const snapshotsByTicker = new Map<string, typeof snapshots>();
  for (const snap of snapshots) {
    const list = snapshotsByTicker.get(snap.ticker) ?? [];
    list.push(snap);
    snapshotsByTicker.set(snap.ticker, list);
  }
  let cumulative = 0, peak = 0, maxDrawdown = 0;
  const rows = stored.map((row) => {
    const settlementResult = results.get(row.ticker) ?? null;
    const target = row.firstTargetAtMs != null;
    const gross = target ? row.contracts * ETH2125_TARGET_CENTS - row.entryCostCents
      : settlementResult == null ? null
      : (settlementResult === row.side ? row.contracts * 100 : 0) - row.entryCostCents;
    const net = gross == null ? null : gross - row.estimatedEntryFeeCents;
    if (net != null) { cumulative += net; peak = Math.max(peak, cumulative); maxDrawdown = Math.max(maxDrawdown, peak - cumulative); }
    return { ticker: row.ticker, side: row.side, entryPriceCents: row.entryPriceCents, contracts: row.contracts,
      targetReachedAtMs: row.firstTargetAtMs, settlementResult, grossPnlCents: gross, feeCents: row.estimatedEntryFeeCents,
      netPnlCents: net, cumulativeNetPnlCents: cumulative,
      depthAudit: auditEth2125TargetDepth(row.firstTargetAtMs, row.contracts, snapshotsByTicker.get(row.ticker) ?? []) };
  });
  const closed = rows.filter((r) => r.netPnlCents != null);
  const winners = closed.filter((r) => (r.netPnlCents ?? 0) > 0);
  const losers = closed.filter((r) => (r.netPnlCents ?? 0) < 0);
  const sum = (values: Array<{ netPnlCents: number | null }>) => values.reduce((n, r) => n + (r.netPnlCents ?? 0), 0);
  const net = sum(closed);
  const gross = closed.reduce((n, r) => n + (r.grossPnlCents ?? 0), 0);
  const fees = closed.reduce((n, r) => n + r.feeCents, 0);
  return {
    researchOnly: true, tradingCapability: "none", cohortStartMs: ETH2125_COHORT_START_MS, reviewGateTrades: ETH2125_REVIEW_TRADES,
    benchmark: { trades: 11, wins: 6, losses: 5, targetHitRate: 6 / 11, netPnlCents: 2096, maxDrawdownCents: 3087 },
    summary: { eligibleTrades: rows.length, targetHits: rows.filter((r) => r.targetReachedAtMs != null).length,
      targetHitRate: rows.length ? rows.filter((r) => r.targetReachedAtMs != null).length / rows.length : null,
      wins: winners.length, losses: losers.length, grossPnlCents: gross, feesCents: fees, netPnlCents: net,
      averageWinnerCents: winners.length ? sum(winners) / winners.length : null,
      averageLoserCents: losers.length ? sum(losers) / losers.length : null,
      maxDrawdownCents: maxDrawdown, reviewReady: rows.length >= ETH2125_REVIEW_TRADES, openTrades: rows.length - closed.length,
      targetHitsDepthConfirmed: rows.filter((r) => r.depthAudit.classification === "depth_confirmed").length,
      targetHitsInsufficientDepth: rows.filter((r) => r.depthAudit.classification === "insufficient_depth").length,
      targetHitsBboTouchOnly: rows.filter((r) => r.depthAudit.classification === "bbo_touch_only").length,
      reviewEvidenceComplete: rows.length >= ETH2125_REVIEW_TRADES
        && rows.every((r) => r.targetReachedAtMs == null || r.depthAudit.classification === "depth_confirmed") },
    rows,
  };
}