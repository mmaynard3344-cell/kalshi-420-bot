/**
 * Compact-shadow sidecar. It deliberately has no imports from the API app,
 * order submission, strategies, positions, risk controls, or Kalshi auth.
 * It only consumes compact public-feed ledgers and writes Phase 4B research.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, phase4bCompactLedgerCheckpoints, phase4bDecisionSnapshots, phase4bMarketIntervals, phase4bMarketOutcomes, phase4bProspectiveSimulations, phase4bReferenceObservations } from "@workspace/db";
import { and, asc, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SUPERVISOR = join(ROOT, "analysis/run-research-collectors.mjs");
const OUT = join(ROOT, "analysis/out");
const ASSETS = ["BTC", "ETH"] as const;
type Asset = typeof ASSETS[number];
type Row = Record<string, unknown>;

/**
 * Frozen, prospective cohort contract. This is deliberately a literal task
 * acceptance timestamp, rather than a rolling "now", so a future report can
 * always identify the untouched validation boundary.
 */
// v2 preserves the frozen thresholds while making the source-time eligibility
// contract auditable. Existing v1 enrollments remain immutable historical data.
export const NORMALIZED_DISTANCE_EXPERIMENT_VERSION = "compact-normalized-distance-prospective-v2";
export const NORMALIZED_DISTANCE_EXPERIMENT_OUTCOME_VERSION = "compact-normalized-distance-prospective-v2-outcome";
export const NORMALIZED_DISTANCE_EXPERIMENT_START_MS = Date.parse("2026-08-21T23:00:24.446Z");
export const NORMALIZED_DISTANCE_YES_THRESHOLD = 0.25;
export const NORMALIZED_DISTANCE_NO_THRESHOLD = -0.25;
export type NormalizedDistanceDirection = "yes" | "no" | "neutral" | "unavailable";

export type NormalizedDistanceSourceUnavailableReason =
  | "missing_source_observation"
  | "source_before_window"
  | "source_after_capture";
export const COMPACT_CHECKPOINTS_SECONDS = [600, 450, 300, 180, 120, 60] as const;
export const COMPACT_PERSISTENCE_SECONDS = [60, 120] as const;
export const COMPACT_SHOCK_HORIZONS_SECONDS = [5, 15, 30, 60] as const;
export const COMPACT_SHOCK_VELOCITY_DOLLARS_PER_SECOND = 0.25;
export const COMPACT_SHOCK_FLOW_IMBALANCE = 0.50;
export const COMPACT_SHOCK_HORIZON_MAX_DELAY_MS = 2_500;
export const COMPACT_CHECKPOINT_VERSION = "compact-normalized-distance-checkpoints-v1";
export const COMPACT_PERSISTENCE_VERSION = "compact-normalized-distance-persistence-v1";
export const COMPACT_SHOCK_VERSION = "compact-coinbase-shock-kalshi-lag-v1";
/** New-study prospective boundary. Existing normalized-distance v2 retains its
 * own earlier immutable boundary and is never filtered by this value. */
export const COMPACT_STUDIES_START_MS = Date.parse("2026-08-22T00:00:00.000Z");
const FIELDS = new Set([
  "id","kind","schema_version","recorded_at_ms","ticker","window_open_ms","window_close_ms",
  "seconds_remaining","feed_status","feed_connected","feed_reconnecting","feed_last_receipt_ms",
  "current_sol_price","current_reference_price","coinbase_bid","coinbase_ask","coinbase_best_bid",
  "coinbase_best_ask","coinbase_best_bid_depth","coinbase_best_ask_depth","coinbase_spread",
  "coinbase_order_book_imbalance","coinbase_microprice","coinbase_trade_flow_imbalance_60s",
  "coinbase_microstructure_age_ms","target_price","target_source","distance_to_target_dollars",
  "distance_to_target_percent","realized_volatility_30s","realized_volatility_1m",
  "realized_volatility_3m","momentum_30s","momentum_30s_elapsed_seconds","momentum_1m",
  "momentum_1m_elapsed_seconds","velocity_dollars_per_second_30s","target_crossing_count",
  "expected_movement_to_close_dollars","normalized_distance_volatility_units",
  "kalshi_yes_bid_cents","kalshi_yes_ask_cents","kalshi_no_bid_cents","kalshi_no_ask_cents",
  "kalshi_yes_executable_bid_cents","kalshi_no_executable_bid_cents",
  "kalshi_yes_executable_bid_depth_contracts","kalshi_no_executable_bid_depth_contracts",
  "kalshi_yes_executable_ask_cents","kalshi_no_executable_ask_cents",
  "kalshi_yes_executable_depth_contracts","kalshi_no_executable_depth_contracts",
  "kalshi_yes_weighted_executable_price_cents","kalshi_no_weighted_executable_price_cents",
  "kalshi_yes_executable_spread_cents","kalshi_no_executable_spread_cents",
  "kalshi_orderbook_age_ms","kalshi_orderbook_captured_ms","asset","reference_source",
  "raw_ticks_persisted","status","connected","reconnecting","last_receipt_ms","age_ms",
  "reconnect_count","write_failures","error",
  // path fields
  "path_first_target_cross_ms","path_last_target_cross_ms","path_time_since_last_cross_ms",
  "path_max_distance_above_target","path_max_distance_below_target","path_mfe_dollars",
  "path_mae_dollars","path_longest_above_target_ms","path_longest_below_target_ms",
  "path_failed_breakout_recross_count","path_window_high","path_window_low","path_window_range",
  "path_position_in_range","path_largest_move_dollars","path_breakout_hold_ms",
  "path_retest_depth_dollars","research_path_complete",
  // feature fields
  "feature_volatility_change_1m","feature_momentum_acceleration",
  "venue_coinbase_imbalance_change","venue_trade_flow_persistent",
  // opportunity fields (scalar only — no nested objects or arrays)
  "opportunity_peak_edge_cents","opportunity_peak_edge_ms","opportunity_edge_duration_ms",
  "opportunity_executable_duration_ms",
  // regime / latency fields
  "regime","latency_ms","snapshot_latency_ms",
  // signal concurrence and model divergence (scalar cents)
  "signal_concurrence","coinbase_kalshi_model_divergence_cents",
]);
for (const field of [
  "age_ms","data_complete","data_fresh","coinbase_microstructure_complete",
  "kalshi_executable_complete","latency_complete","path_summary_complete","cross_asset_complete",
  "source_timestamp_ms","source_receipt_ms","source_latency_ms","source_clock_skew_ms",
  "kalshi_fetch_latency_ms","window_fetch_latency_ms","source_provenance","utc_hour","session","volatility_regime","momentum_regime",
  "cross_asset_peer_price","cross_asset_peer_distance","cross_asset_peer_age_ms",
  "feature_normalized_distance_trend","feature_spread_change","feature_range_expansion_dollars",
  "path_breakout_count","path_first_breakout_ms","path_last_breakout_ms",
  "path_failed_breakout_count","path_retest_count","path_range_expansion_count",
  "path_largest_checkpoint_move_dollars","path_largest_checkpoint_move_ms",
  "path_time_since_largest_move_ms","path_observe_count",
  "kalshi_yes_ask_velocity_cents_per_s","kalshi_no_ask_velocity_cents_per_s",
  "kalshi_spread_change_from_open_cents","kalshi_depth_yes_change_contracts",
  "kalshi_depth_no_change_contracts",
  "kalshi_yes_executable_contracts_2c_slippage","kalshi_yes_executable_contracts_5c_slippage",
  "kalshi_no_executable_contracts_2c_slippage","kalshi_no_executable_contracts_5c_slippage",
  "kalshi_yes_executable_principal_cents_2c_slippage","kalshi_yes_executable_principal_cents_5c_slippage",
  "kalshi_no_executable_principal_cents_2c_slippage","kalshi_no_executable_principal_cents_5c_slippage",
  "path_peak_yes_contracts_2c","path_peak_yes_contracts_5c",
  "path_peak_no_contracts_2c","path_peak_no_contracts_5c",
  "path_peak_yes_principal_cents_2c","path_peak_yes_principal_cents_5c",
  "path_peak_no_principal_cents_2c","path_peak_no_principal_cents_5c",
  "path_peak_yes_2c_ms","path_peak_no_2c_ms",
  "lifecycle_peak_yes_executable_price_cents","lifecycle_peak_no_executable_price_cents",
  "lifecycle_peak_yes_executable_price_ms","lifecycle_peak_no_executable_price_ms",
  "lifecycle_min_yes_executable_price_cents","lifecycle_min_no_executable_price_cents",
  "lifecycle_yes_first_80_ms","lifecycle_no_first_80_ms",
  "lifecycle_yes_first_90_ms","lifecycle_no_first_90_ms",
  "lifecycle_yes_recovery_80_duration_ms","lifecycle_no_recovery_80_duration_ms",
  "lifecycle_final_reference_price","lifecycle_final_distance_to_target_dollars",
  "lifecycle_final_yes_executable_price_cents","lifecycle_final_no_executable_price_cents",
  "lifecycle_final_pre_settlement_ms",
  "acc_peak_edge_cents","acc_peak_edge_ms","acc_edge_duration_ms",
  "acc_executable_positive_duration_ms","acc_signal_concurrence_count","acc_snapshot_count",
  "acc_signal_concurrence_ratio","acc_max_model_divergence_cents","acc_avg_model_divergence_cents",
  "acc_model_divergence_observation_count",
]) FIELDS.add(field);

const num = (value: unknown) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const price = (value: unknown) => { const valueAsNumber = num(value); return valueAsNumber !== null && valueAsNumber >= 1 && valueAsNumber <= 99 ? valueAsNumber : null; };
const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));

/** Exact frozen thresholds: +0.25 is YES and -0.25 is NO. */
export function classifyNormalizedDistance(distance: unknown): NormalizedDistanceDirection {
  const value = num(distance);
  if (value === null) return "unavailable";
  if (value >= NORMALIZED_DISTANCE_YES_THRESHOLD) return "yes";
  if (value <= NORMALIZED_DISTANCE_NO_THRESHOLD) return "no";
  return "neutral";
}

/**
 * The normalized-distance call is prospective only when its Coinbase source
 * observation is causal for this specific Kalshi market window.  Capture
 * receipt time is audit context; source time is the event-time contract.
 */
export function normalizedDistanceSourceUnavailableReason(
  row: Row,
  payload: Row,
): NormalizedDistanceSourceUnavailableReason | null {
  const sourceTimestampMs = num(payload.source_timestamp_ms);
  const windowOpenMs = num(row.window_open_ms);
  const capturedAtMs = num(row.recorded_at_ms);
  if (sourceTimestampMs === null || windowOpenMs === null || capturedAtMs === null) {
    return "missing_source_observation";
  }
  if (sourceTimestampMs < windowOpenMs) return "source_before_window";
  if (sourceTimestampMs > capturedAtMs) return "source_after_capture";
  return null;
}
/** A validation market must begin after the frozen boundary, not merely have
 * a later snapshot. This excludes any market that was already underway when
 * the hypothesis was frozen. */
export function isNormalizedDistanceExperimentEligible(row: Row, payload: Row): boolean {
  const capturedAtMs = num(row.recorded_at_ms);
  const windowOpenMs = num(row.window_open_ms);
  const windowCloseMs = num(row.window_close_ms);
  return capturedAtMs !== null
    && windowOpenMs !== null
    && windowCloseMs !== null
    && windowOpenMs >= NORMALIZED_DISTANCE_EXPERIMENT_START_MS
    && capturedAtMs >= NORMALIZED_DISTANCE_EXPERIMENT_START_MS
    && capturedAtMs < windowCloseMs
    && payload.feed_status === "fresh"
    && payload.data_fresh === true
    && payload.data_complete === true
    && payload.coinbase_microstructure_complete === true
    && payload.kalshi_executable_complete === true
    && payload.latency_complete === true
    && classifyNormalizedDistance(payload.normalized_distance_volatility_units) !== "unavailable"
    && normalizedDistanceSourceUnavailableReason(row, payload) === null;
}

/** Shared future-only admission contract for the new studies. It intentionally
 * leaves the frozen normalized-distance v2 boundary and semantics untouched. */
export function compactStudyUnavailableReason(row: Row, payload: Row): string | null {
  const captured = num(row.recorded_at_ms), open = num(row.window_open_ms), close = num(row.window_close_ms);
  if (captured === null || open === null || close === null || captured < open || captured >= close) return "outside_window";
  if (open < COMPACT_STUDIES_START_MS || captured < COMPACT_STUDIES_START_MS) return "before_study_start";
  if (payload.feed_status !== "fresh" || payload.data_fresh !== true || payload.data_complete !== true
    || payload.coinbase_microstructure_complete !== true || payload.kalshi_executable_complete !== true
    || payload.latency_complete !== true) return "incomplete_or_stale";
  return normalizedDistanceSourceUnavailableReason(row, payload);
}

export function checkpointForSecondsRemaining(value: unknown): number | null {
  const seconds = num(value);
  if (seconds === null) return null;
  // First stored observation at or after a checkpoint in elapsed time means
  // seconds remaining is at or below the fixed boundary.
  for (let index = 0; index < COMPACT_CHECKPOINTS_SECONDS.length; index++) {
    const checkpoint = COMPACT_CHECKPOINTS_SECONDS[index]!;
    const next = COMPACT_CHECKPOINTS_SECONDS[index + 1];
    if (seconds <= checkpoint && (next === undefined || seconds > next)) return checkpoint;
  }
  return null;
}

export function isCompactShock(payload: Row): boolean {
  const velocity = num(payload.velocity_dollars_per_second_30s);
  const flow = num(payload.coinbase_trade_flow_imbalance_60s);
  return (velocity !== null && Math.abs(velocity) >= COMPACT_SHOCK_VELOCITY_DOLLARS_PER_SECOND)
    || (flow !== null && Math.abs(flow) >= COMPACT_SHOCK_FLOW_IMBALANCE);
}

/** A nominal horizon is useful only when the later compact observation landed
 * close enough to it. Missed intervals remain unavailable rather than being
 * relabeled with a much later quote. */
export function isShockHorizonDue(elapsedMs: number, horizonSeconds: number): boolean {
  const targetMs = horizonSeconds * 1000;
  return elapsedMs >= targetMs && elapsedMs <= targetMs + COMPACT_SHOCK_HORIZON_MAX_DELAY_MS;
}

export function compactPersistenceQualification(payload: Row, durationSeconds: number): NormalizedDistanceDirection | "unavailable" {
  const direction = classifyNormalizedDistance(payload.normalized_distance_volatility_units);
  const holdMs = direction === "yes" ? num(payload.path_longest_above_target_ms) : num(payload.path_longest_below_target_ms);
  const sinceCrossMs = num(payload.path_time_since_last_cross_ms);
  const currentDistance = num(payload.distance_to_target_dollars);
  const peakDistance = direction === "yes" ? num(payload.path_max_distance_above_target) : num(payload.path_max_distance_below_target);
  // Direction must remain beyond the frozen threshold throughout the bounded
  // observation summary. A target recross or materially shorter hold rejects it.
  if (direction === "unavailable" || direction === "neutral" || holdMs === null || sinceCrossMs === null
    || currentDistance === null || peakDistance === null || Math.abs(currentDistance) < peakDistance * 0.5
    || holdMs < durationSeconds * 1000 || sinceCrossMs < durationSeconds * 1000) return "unavailable";
  return direction;
}

export function wilsonInterval(successes: number, trials: number): { low: number | null; high: number | null } {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0 || successes < 0 || successes > trials) {
    return { low: null, high: null };
  }
  const z = 1.959963984540054;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials) / denominator;
  return { low: center - margin, high: center + margin };
}

export function summarizeDirectionalResults(rows: Array<{ asset: Asset; direction: NormalizedDistanceDirection; result: "yes" | "no" | null }>) {
  const groups: Array<Asset | "combined"> = ["BTC", "ETH", "combined"];
  return groups.map((asset) => {
    const group = rows.filter((row) => asset === "combined" || row.asset === asset);
    const settled = group.filter((row) => row.result === "yes" || row.result === "no");
    const directional = settled.filter((row) => row.direction === "yes" || row.direction === "no");
    const yesCalls = directional.filter((row) => row.direction === "yes");
    const noCalls = directional.filter((row) => row.direction === "no");
    const correct = directional.filter((row) => row.direction === row.result).length;
    const yesCorrect = yesCalls.filter((row) => row.result === "yes").length;
    const noCorrect = noCalls.filter((row) => row.result === "no").length;
    return {
      asset,
      enrolledCount: group.length,
      settledCount: settled.length,
      pendingCount: group.length - settled.length,
      neutralCount: group.filter((row) => row.direction === "neutral").length,
      directionalCount: directional.length,
      correctCount: correct,
      directionalAccuracy: directional.length ? correct / directional.length : null,
      directionalWilson95: wilsonInterval(correct, directional.length),
      yesCallCount: yesCalls.length,
      yesCorrectCount: yesCorrect,
      yesAccuracy: yesCalls.length ? yesCorrect / yesCalls.length : null,
      yesWilson95: wilsonInterval(yesCorrect, yesCalls.length),
      noCallCount: noCalls.length,
      noCorrectCount: noCorrect,
      noAccuracy: noCalls.length ? noCorrect / noCalls.length : null,
      noWilson95: wilsonInterval(noCorrect, noCalls.length),
    };
  });
}

export type ShadowAction = "WOULD_BUY" | "SKIP" | "HOLD" | "WOULD_EXIT";

/**
 * Allowlist filter: rejects any record that contains raw-shaped or nested data,
 * or fields outside the strict scalar allowlist.
 */
export function allowlistedCompactPayload(row: Row): Row | null {
  if (row.raw_ticks_persisted !== false || ["ticks", "payload", "raw", "quotes"].some((key) => Object.hasOwn(row, key))) return null;
  if (Object.keys(row).some((key) => !FIELDS.has(key))) return null;
  // Reject any value that is a non-null object/array (nested raw data guard)
  if (Object.values(row).some((v) => v !== null && typeof v === "object")) return null;
  return Object.fromEntries(Object.entries(row).filter(([key]) => FIELDS.has(key)));
}

/** Pure, causal, and deliberately unrelated to live strategy logic. */
export function scoreCompactShadow(row: Row): { action: ShadowAction; finishProbability: number | null; touchProbability: number | null; executableEdgeCents: number | null; confidence: string; reason: string | null } {
  const age = num(row.age_ms), seconds = num(row.seconds_remaining), reference = num(row.current_reference_price);
  const target = num(row.target_price), distance = num(row.normalized_distance_volatility_units);
  const expected = num(row.expected_movement_to_close_dollars), yesAsk = price(row.kalshi_yes_weighted_executable_price_cents), noAsk = price(row.kalshi_no_weighted_executable_price_cents);
  const cbAge = num(row.coinbase_microstructure_age_ms), bookAge = num(row.kalshi_orderbook_age_ms);
  const sourceLatency = num(row.source_latency_ms), snapshotLatency = num(row.snapshot_latency_ms);
  const clockSkew = num(row.source_clock_skew_ms), kalshiFetchLatency = num(row.kalshi_fetch_latency_ms);
  const windowFetchLatency = num(row.window_fetch_latency_ms);
  if (row.feed_status !== "fresh" || row.data_fresh !== true || row.data_complete !== true
    || row.coinbase_microstructure_complete !== true || row.kalshi_executable_complete !== true
    || row.latency_complete !== true
    || age === null || age < 0 || age > 20_000
    || cbAge === null || cbAge < 0 || cbAge > 20_000
    || bookAge === null || bookAge < 0 || bookAge > 20_000
    || sourceLatency === null || sourceLatency < 0 || sourceLatency > 20_000
    || snapshotLatency === null || snapshotLatency < 0 || snapshotLatency > 20_000
    || clockSkew === null || clockSkew < 0 || clockSkew > 20_000
    || kalshiFetchLatency === null || kalshiFetchLatency < 0 || kalshiFetchLatency > 5_000
    || windowFetchLatency === null || windowFetchLatency < 0 || windowFetchLatency > 5_000
    || seconds === null || seconds <= 0 || reference === null || reference <= 0
    || target === null || target <= 0 || distance === null || expected === null || expected <= 0
    || yesAsk === null || noAsk === null) {
    return { action: "SKIP", finishProbability: null, touchProbability: null, executableEdgeCents: null, confidence: "unavailable", reason: "missing_or_stale_compact_evidence" };
  }
  const direction = target >= reference ? 1 : -1;
  const finishProbability = clamp(0.5 + direction * Math.exp(-Math.abs(distance)) * .22, .02, .98);
  const touchProbability = clamp(Math.max(direction > 0 ? finishProbability : 1 - finishProbability, Math.exp(-Math.abs(distance) * .65)), .02, .99);
  const edge = (direction > 0 ? finishProbability : 1 - finishProbability) * 100 - (direction > 0 ? yesAsk : noAsk);
  return { action: edge >= 4 ? "WOULD_BUY" : edge <= -4 ? "WOULD_EXIT" : "HOLD", finishProbability, touchProbability, executableEdgeCents: edge, confidence: Math.abs(distance) <= 2 ? "high" : "low", reason: null };
}

// ── Opportunity accumulator ───────────────────────────────────────────────────
// Bounded per-asset, per-ticker accumulator. Tracks peak model edge+time,
// edge duration, executable positive-opportunity duration, signal concurrence,
// and Coinbase/Kalshi model divergence across snapshots within one window.
// Max 200 tickers retained; oldest evicted when capacity is exceeded.
const OPP_ACCUMULATOR_MAX_TICKERS = 200;

export interface OpportunityAccumulator {
  ticker: string;
  asset: Asset;
  /** Peak executable edge observed (cents) */
  peakEdgeCents: number | null;
  /** Timestamp at which peak edge was observed */
  peakEdgeMs: number | null;
  /** Total ms where any (positive or negative) executable edge existed */
  edgeDurationMs: number;
  /** Total ms where executable edge was strictly positive (buy-side opportunity) */
  executablePositiveDurationMs: number;
  /** Count of snapshots where signal_concurrence field was truthy */
  signalConcurrenceCount: number;
  /** Total snapshots contributing to this accumulator */
  snapshotCount: number;
  /** Latest absolute coinbase_kalshi_model_divergence_cents observed */
  maxModelDivergenceCents: number | null;
  /** Sum of model divergence values (for average) */
  sumModelDivergenceCents: number;
  /** Count of model divergence observations */
  modelDivergenceObservationCount: number;
  /** Timestamp of last snapshot contributing to this accumulator */
  lastSnapshotMs: number;
}

// Exported so tests and the status handler can read accumulator state.
export const opportunityAccumulators = new Map<string, OpportunityAccumulator>();

function getOrCreateAccumulator(ticker: string, asset: Asset): OpportunityAccumulator {
  if (!opportunityAccumulators.has(ticker)) {
    // Evict oldest entry if at capacity
    if (opportunityAccumulators.size >= OPP_ACCUMULATOR_MAX_TICKERS) {
      let oldestKey: string | null = null, oldestMs = Infinity;
      for (const [k, v] of opportunityAccumulators) {
        if (v.lastSnapshotMs < oldestMs) { oldestMs = v.lastSnapshotMs; oldestKey = k; }
      }
      if (oldestKey) opportunityAccumulators.delete(oldestKey);
    }
    opportunityAccumulators.set(ticker, {
      ticker, asset, peakEdgeCents: null, peakEdgeMs: null,
      edgeDurationMs: 0, executablePositiveDurationMs: 0,
      signalConcurrenceCount: 0, snapshotCount: 0,
      maxModelDivergenceCents: null, sumModelDivergenceCents: 0,
      modelDivergenceObservationCount: 0, lastSnapshotMs: 0,
    });
  }
  return opportunityAccumulators.get(ticker)!;
}

export function restoreOpportunityAccumulator(ticker: string, asset: Asset, payload: Row): OpportunityAccumulator {
  const acc = getOrCreateAccumulator(ticker, asset);
  acc.peakEdgeCents = num(payload.acc_peak_edge_cents);
  acc.peakEdgeMs = num(payload.acc_peak_edge_ms);
  acc.edgeDurationMs = num(payload.acc_edge_duration_ms) ?? 0;
  acc.executablePositiveDurationMs = num(payload.acc_executable_positive_duration_ms) ?? 0;
  acc.signalConcurrenceCount = num(payload.acc_signal_concurrence_count) ?? 0;
  acc.snapshotCount = num(payload.acc_snapshot_count) ?? 0;
  acc.maxModelDivergenceCents = num(payload.acc_max_model_divergence_cents);
  acc.modelDivergenceObservationCount = num(payload.acc_model_divergence_observation_count) ?? 0;
  const avgDivergence = num(payload.acc_avg_model_divergence_cents);
  acc.sumModelDivergenceCents = avgDivergence === null ? 0 : avgDivergence * acc.modelDivergenceObservationCount;
  acc.lastSnapshotMs = num(payload.recorded_at_ms) ?? 0;
  return acc;
}

async function hydrateOpportunityAccumulator(ticker: string, asset: Asset): Promise<void> {
  if (opportunityAccumulators.has(ticker)) return;
  const rows = await db.select({ payload: phase4bDecisionSnapshots.payload })
    .from(phase4bDecisionSnapshots)
    .where(and(eq(phase4bDecisionSnapshots.marketId, ticker), eq(phase4bDecisionSnapshots.source, "compact-coinbase-shadow")))
    .orderBy(desc(phase4bDecisionSnapshots.capturedAtMs))
    .limit(1);
  if (rows[0]?.payload && typeof rows[0].payload === "object" && !Array.isArray(rows[0].payload)) {
    restoreOpportunityAccumulator(ticker, asset, rows[0].payload as Row);
  }
}

/**
 * Update accumulator for the given snapshot and return the accumulated
 * opportunity fields to augment the persisted payload.
 */
function updateAccumulator(ticker: string, asset: Asset, payload: Row, score: ReturnType<typeof scoreCompactShadow>, capturedAtMs: number): Record<string, number | null | boolean> {
  const acc = getOrCreateAccumulator(ticker, asset);
  const elapsedMs = acc.lastSnapshotMs > 0 && capturedAtMs > acc.lastSnapshotMs
    ? Math.min(60_000, capturedAtMs - acc.lastSnapshotMs) : 0;
  acc.snapshotCount++;

  // Peak edge
  const edge = score.executableEdgeCents;
  if (edge !== null) {
    if (acc.peakEdgeCents === null || edge > acc.peakEdgeCents) {
      acc.peakEdgeCents = edge;
      acc.peakEdgeMs = capturedAtMs;
    }
    acc.edgeDurationMs += elapsedMs;
    if (edge > 0) acc.executablePositiveDurationMs += elapsedMs;
  }

  // Signal concurrence
  if (payload.signal_concurrence === true || payload.signal_concurrence === 1 || payload.signal_concurrence === "true") {
    acc.signalConcurrenceCount++;
  }

  // Coinbase/Kalshi model divergence
  const divergence = num(payload.coinbase_kalshi_model_divergence_cents);
  if (divergence !== null) {
    const absDivergence = Math.abs(divergence);
    if (acc.maxModelDivergenceCents === null || absDivergence > acc.maxModelDivergenceCents) {
      acc.maxModelDivergenceCents = absDivergence;
    }
    acc.sumModelDivergenceCents += divergence;
    acc.modelDivergenceObservationCount++;
  }
  acc.lastSnapshotMs = capturedAtMs;

  return {
    acc_peak_edge_cents: acc.peakEdgeCents,
    acc_peak_edge_ms: acc.peakEdgeMs,
    acc_edge_duration_ms: acc.edgeDurationMs,
    acc_executable_positive_duration_ms: acc.executablePositiveDurationMs,
    acc_signal_concurrence_count: acc.signalConcurrenceCount,
    acc_snapshot_count: acc.snapshotCount,
    acc_signal_concurrence_ratio: acc.snapshotCount > 0 ? acc.signalConcurrenceCount / acc.snapshotCount : null,
    acc_max_model_divergence_cents: acc.maxModelDivergenceCents,
    acc_avg_model_divergence_cents: acc.modelDivergenceObservationCount > 0
      ? acc.sumModelDivergenceCents / acc.modelDivergenceObservationCount
      : null,
    acc_model_divergence_observation_count: acc.modelDivergenceObservationCount,
    raw_ticks_persisted: false,
  };
}

const counters = { ingested: 0, rejected: 0, writeFailures: 0, outcomeFailures: 0, scored: 0, skippedCycles: 0, lifecycleSimulations: 0, lifecycleBackfills: 0 };
let collector: ChildProcess | null = null;
export interface LedgerCheckpoint {
  device: string | null;
  inode: string | null;
  byteOffset: number;
  lastRecordId: string | null;
  lastRecordAtMs: number | null;
  status: string;
  lastReason: string | null;
  rejectedCount: number;
  malformedCount: number;
  writeFailureCount: number;
  lostRecordCount: number;
  rotationCount: number;
  truncationCount: number;
}
const ledgerCheckpoints = new Map<string, LedgerCheckpoint>();
const MAX_LEDGER_READ_BYTES = 1_048_576;
const BACKLOG_BYTES_WARNING = MAX_LEDGER_READ_BYTES * 4;
function assetOf(row: Row, fallback: Asset | null): Asset | null { const asset = row.asset ?? fallback; return ASSETS.includes(asset as Asset) ? asset as Asset : null; }

export function classifyCompactUnreadChunk(finalNewline: number, readLength: number): "complete" | "partial" | "oversized" {
  if (finalNewline >= 0) return "complete";
  return readLength >= MAX_LEDGER_READ_BYTES ? "oversized" : "partial";
}

/**
 * Commit a candidate cursor only after its durable write succeeds.  The cache
 * represents the last acknowledged database state, never a speculative offset.
 */
export async function commitCompactLedgerCheckpoint(
  cache: Map<string, LedgerCheckpoint>,
  file: string,
  candidate: LedgerCheckpoint,
  write: (checkpoint: LedgerCheckpoint) => Promise<void>,
): Promise<LedgerCheckpoint> {
  const committed = { ...candidate };
  await write({ ...committed });
  cache.set(file, committed);
  return committed;
}

/** The sidecar owns this additive table so research-schema failures can never
 * participate in the API's execution-critical storage initialization. */
async function ensureCompactLedgerCheckpointSchema(): Promise<void> {
  await db.execute(sql`
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
}

export function compactOutcomeStatusForHttp(status: number): "unavailable_http_404" | null {
  // A public market 404 is authoritative absence, not a settlement result.
  // Recording it terminates retries while retaining result=null so reports can
  // never mistake unavailable history for a yes/no outcome.
  return status === 404 ? "unavailable_http_404" : null;
}

function emptyCheckpoint(): LedgerCheckpoint {
  return {
    device: null, inode: null, byteOffset: 0, lastRecordId: null, lastRecordAtMs: null,
    status: "new", lastReason: null, rejectedCount: 0, malformedCount: 0,
    writeFailureCount: 0, lostRecordCount: 0, rotationCount: 0, truncationCount: 0,
  };
}

/** Pure resume policy, exported for restart/rotation/truncation regression tests. */
export function resolveCompactLedgerCheckpoint(
  prior: LedgerCheckpoint | null,
  identity: { device: string; inode: string; size: number },
): { checkpoint: LedgerCheckpoint; reason: "new" | "resumed" | "rotated" | "truncated" } {
  const checkpoint = { ...(prior ?? emptyCheckpoint()) };
  if (!prior) {
    checkpoint.device = identity.device; checkpoint.inode = identity.inode;
    return { checkpoint, reason: "new" };
  }
  if (checkpoint.device !== identity.device || checkpoint.inode !== identity.inode) {
    checkpoint.device = identity.device; checkpoint.inode = identity.inode; checkpoint.byteOffset = 0;
    checkpoint.rotationCount++; checkpoint.lostRecordCount++; checkpoint.status = "rotation_detected";
    checkpoint.lastReason = "ledger_rotation_before_checkpoint";
    return { checkpoint, reason: "rotated" };
  }
  if (identity.size < checkpoint.byteOffset) {
    checkpoint.byteOffset = 0; checkpoint.truncationCount++; checkpoint.lostRecordCount++;
    checkpoint.status = "truncation_detected"; checkpoint.lastReason = "ledger_truncated_before_checkpoint";
    return { checkpoint, reason: "truncated" };
  }
  return { checkpoint, reason: "resumed" };
}

async function loadCheckpoint(file: string, stat: { dev: number; ino: number; size: number }): Promise<LedgerCheckpoint> {
  const cached = ledgerCheckpoints.get(file);
  const identity = { device: String(stat.dev), inode: String(stat.ino), size: stat.size };
  if (cached) {
    const resolved = resolveCompactLedgerCheckpoint(cached, identity);
    if (resolved.reason === "rotated" || resolved.reason === "truncated") {
      await persistCheckpoint(file, resolved.checkpoint);
    }
    return resolved.checkpoint;
  }
  const rows = await db.select().from(phase4bCompactLedgerCheckpoints)
    .where(eq(phase4bCompactLedgerCheckpoints.ledgerPath, file)).limit(1);
  const stored = rows[0];
  const prior = stored ? {
    device: stored.device, inode: stored.inode, byteOffset: stored.byteOffset,
    lastRecordId: stored.lastRecordId, lastRecordAtMs: stored.lastRecordAtMs,
    status: stored.status, lastReason: stored.lastReason,
    rejectedCount: stored.rejectedCount, malformedCount: stored.malformedCount,
    writeFailureCount: stored.writeFailureCount, lostRecordCount: stored.lostRecordCount,
    rotationCount: stored.rotationCount, truncationCount: stored.truncationCount,
  } satisfies LedgerCheckpoint : null;
  const result = resolveCompactLedgerCheckpoint(prior, identity);
  if (result.reason === "rotated" || result.reason === "truncated") {
    await persistCheckpoint(file, result.checkpoint);
  } else {
    ledgerCheckpoints.set(file, result.checkpoint);
  }
  return result.checkpoint;
}

async function persistCheckpoint(file: string, checkpoint: LedgerCheckpoint): Promise<LedgerCheckpoint> {
  return commitCompactLedgerCheckpoint(ledgerCheckpoints, file, checkpoint, async (candidate) => {
    await db.insert(phase4bCompactLedgerCheckpoints).values({
      ledgerPath: file, ...candidate, updatedAtMs: Date.now(),
    }).onConflictDoUpdate({
      target: phase4bCompactLedgerCheckpoints.ledgerPath,
      set: { ...candidate, updatedAtMs: Date.now() },
    });
  });
}

/** Returns true only when this ledger row is durably represented already or now. */
async function save(asset: Asset, row: Row, payload: Row): Promise<boolean> {
  const capturedAtMs = num(row.recorded_at_ms)!;
  if (row.kind === "feed_health") {
    await db.insert(phase4bProspectiveSimulations).values({ id: `compact-health:${row.id}`, snapshotId: `compact-health:${row.id}`, hypothesisVersion: "compact-shadow-feed-health-v1", qualification: String(payload.status ?? "unknown"), ticker: typeof row.ticker === "string" ? row.ticker : `KX${asset}15M-health`, capturedAtMs, payload: { asset, ...payload, raw_ticks_persisted: false }, schemaVersion: "compact-shadow-v2" }).onConflictDoNothing();
    return true;
  }
  if (row.kind !== "derived_snapshot" || typeof row.id !== "string" || typeof row.ticker !== "string" || num(row.window_close_ms) === null) return false;
  const ticker = row.ticker, closeMs = num(row.window_close_ms)!, snapshotId = `compact:${row.id}`, score = scoreCompactShadow(payload);
  const existing = await db.select({ snapshotId: phase4bDecisionSnapshots.snapshotId })
    .from(phase4bDecisionSnapshots).where(eq(phase4bDecisionSnapshots.snapshotId, snapshotId)).limit(1);
  if (existing.length > 0) return true;
  await hydrateOpportunityAccumulator(ticker, asset);
  const yesAsk = price(payload.kalshi_yes_weighted_executable_price_cents);
  const modelDivergence = score.finishProbability !== null && yesAsk !== null
    ? score.finishProbability * 100 - yesAsk : null;
  const modelSide = score.finishProbability === null ? 0 : Math.sign(score.finishProbability - 0.5);
  const evidenceSigns = [num(payload.momentum_30s), num(payload.coinbase_order_book_imbalance), num(payload.coinbase_trade_flow_imbalance_60s)]
    .filter((value): value is number => value !== null && value !== 0).map(Math.sign);
  const derivedConcurrence = modelSide !== 0 && evidenceSigns.length >= 2
    ? evidenceSigns.every((sign) => sign === modelSide) : null;
  const comparisonPayload: Row = {
    ...payload,
    signal_concurrence: payload.signal_concurrence ?? derivedConcurrence,
    coinbase_kalshi_model_divergence_cents: modelDivergence,
  };

  // Augment payload with opportunity accumulator fields
  const priorAccumulator = { ...getOrCreateAccumulator(ticker, asset) };
  const accFields = updateAccumulator(ticker, asset, comparisonPayload, score, capturedAtMs);
  const augmentedPayload: Row = { ...comparisonPayload, ...accFields };
  const normalizedDirection = classifyNormalizedDistance(augmentedPayload.normalized_distance_volatility_units);
  const isExperimentEligible = isNormalizedDistanceExperimentEligible(row, augmentedPayload);
  const sourceUnavailableReason = normalizedDistanceSourceUnavailableReason(row, augmentedPayload);
  const studyUnavailableReason = compactStudyUnavailableReason(row, augmentedPayload);
  // A late observation is evidence for the checkpoint nearest to its actual
  // remaining time only. Never backfill earlier checkpoints from that same
  // row: that would manufacture time-to-close cohorts from late data.
  const checkpoint = checkpointForSecondsRemaining(augmentedPayload.seconds_remaining);
  const supportingFields = [
    "current_reference_price", "target_price", "distance_to_target_dollars",
    "realized_volatility_30s", "realized_volatility_1m", "momentum_30s", "momentum_1m",
    "feature_normalized_distance_trend", "coinbase_order_book_imbalance",
    "coinbase_microprice", "coinbase_trade_flow_imbalance_60s",
    "kalshi_yes_weighted_executable_price_cents", "kalshi_no_weighted_executable_price_cents",
    "kalshi_yes_executable_depth_contracts", "kalshi_no_executable_depth_contracts",
    "kalshi_yes_executable_spread_cents", "kalshi_no_executable_spread_cents",
    "regime", "volatility_regime", "momentum_regime", "seconds_remaining",
    "source_latency_ms", "snapshot_latency_ms", "kalshi_fetch_latency_ms", "window_fetch_latency_ms",
  ];
  const experimentPayload: Row = {
    experiment_version: NORMALIZED_DISTANCE_EXPERIMENT_VERSION,
    experiment_start_ms: NORMALIZED_DISTANCE_EXPERIMENT_START_MS,
    asset,
    ticker,
    snapshot_timestamp_ms: capturedAtMs,
    snapshot_id: snapshotId,
    window_open_ms: num(row.window_open_ms),
    window_close_ms: closeMs,
    normalized_distance_volatility_units: num(augmentedPayload.normalized_distance_volatility_units),
    directional_call: normalizedDirection,
    threshold_yes: NORMALIZED_DISTANCE_YES_THRESHOLD,
    threshold_no: NORMALIZED_DISTANCE_NO_THRESHOLD,
    source_timestamp_ms: num(augmentedPayload.source_timestamp_ms),
    source_receipt_ms: num(augmentedPayload.source_receipt_ms),
    source_provenance: augmentedPayload.source_provenance ?? null,
    raw_ticks_persisted: false,
    ...Object.fromEntries(supportingFields.map((field) => [field, augmentedPayload[field] ?? null])),
  };

  try {
    await db.transaction(async (tx) => {
      await tx.insert(phase4bMarketIntervals).values({ marketId: ticker, ticker, series: `KX${asset}15M`, asset, intervalStartMs: num(row.window_open_ms), intervalEndMs: closeMs, windowCloseMs: closeMs, metadataCapturedAtMs: capturedAtMs, schemaVersion: "compact-shadow-v2", metadataVersion: "public-kalshi-window-v1" }).onConflictDoNothing();
      await tx.insert(phase4bDecisionSnapshots).values({ snapshotId, marketId: ticker, capturedAtMs, secondsLeft: Math.max(0, Math.round(num(row.seconds_remaining) ?? 0)), candidateSide: "none", source: "compact-coinbase-shadow", payload: augmentedPayload, schemaVersion: "compact-shadow-v2" }).onConflictDoNothing();
      await tx.insert(phase4bReferenceObservations).values({ id: `reference:${snapshotId}`, snapshotId, marketId: ticker, capturedAtMs, asset, source: "coinbase_public_ticker_batch", payload: augmentedPayload, schemaVersion: "compact-shadow-v2" }).onConflictDoNothing();
      await tx.insert(phase4bProspectiveSimulations).values({ id: `compact-score:${snapshotId}`, snapshotId, hypothesisVersion: "compact-shadow-probability-edge-v1", qualification: score.action, ticker, capturedAtMs, payload: { ...score, asset, raw_ticks_persisted: false }, schemaVersion: "compact-shadow-v2" }).onConflictDoNothing();
      // Explicitly record source-time failures for research observability. They
      // are per-snapshot (not per ticker), so a later causal observation remains
      // free to claim the ticker's one immutable enrollment.
      if (sourceUnavailableReason) {
        await tx.insert(phase4bProspectiveSimulations).values({
          id: `compact-normalized-distance-unavailable:${snapshotId}`,
          snapshotId,
          hypothesisVersion: "compact-normalized-distance-prospective-v2-unavailable",
          qualification: sourceUnavailableReason,
          ticker,
          capturedAtMs,
          payload: {
            ...experimentPayload,
            unavailable_reason: sourceUnavailableReason,
            research_only: true,
            execution_gate: false,
          },
          schemaVersion: "compact-shadow-v3",
        }).onConflictDoNothing();
      }
      // One immutable enrollment per ticker. An earlier incomplete snapshot does
      // not consume the enrollment; the first later complete/fresh snapshot does.
      if (isExperimentEligible) {
        await tx.insert(phase4bProspectiveSimulations).values({
          id: `compact-normalized-distance:${ticker}`,
          snapshotId,
          hypothesisVersion: NORMALIZED_DISTANCE_EXPERIMENT_VERSION,
          qualification: normalizedDirection,
          ticker,
          capturedAtMs,
          payload: experimentPayload,
          schemaVersion: "compact-shadow-v3",
        }).onConflictDoNothing();
      }
      // New studies are independent from frozen v2 enrollment. Rejections are
      // per snapshot and therefore never consume a market/checkpoint/duration
      // identity that a later causal observation can satisfy.
      if (!studyUnavailableReason && checkpoint !== null && normalizedDirection !== "unavailable") {
        await tx.insert(phase4bProspectiveSimulations).values({
            id: `compact-checkpoint:${ticker}:${checkpoint}`,
            snapshotId, hypothesisVersion: COMPACT_CHECKPOINT_VERSION,
            qualification: normalizedDirection, ticker, capturedAtMs,
            payload: { asset, ticker, study_start_ms: COMPACT_STUDIES_START_MS, checkpoint_seconds_remaining: checkpoint,
              observed_seconds_remaining: num(augmentedPayload.seconds_remaining),
              directional_call: normalizedDirection, source_timestamp_ms: num(augmentedPayload.source_timestamp_ms),
              raw_ticks_persisted: false, ...Object.fromEntries(supportingFields.map((field) => [field, augmentedPayload[field] ?? null])) },
            schemaVersion: "compact-shadow-v3",
          }).onConflictDoNothing();
      }
      if (!studyUnavailableReason) {
        for (const durationSeconds of COMPACT_PERSISTENCE_SECONDS) {
          const qualification = compactPersistenceQualification(augmentedPayload, durationSeconds);
          if (qualification === "unavailable") continue;
          await tx.insert(phase4bProspectiveSimulations).values({
            id: `compact-persistence:${ticker}:${durationSeconds}`,
            snapshotId, hypothesisVersion: COMPACT_PERSISTENCE_VERSION, qualification, ticker, capturedAtMs,
            payload: { asset, ticker, duration_seconds: durationSeconds, directional_call: qualification,
              path_breakout_hold_ms: num(augmentedPayload.path_breakout_hold_ms),
              path_longest_above_target_ms: num(augmentedPayload.path_longest_above_target_ms),
              path_longest_below_target_ms: num(augmentedPayload.path_longest_below_target_ms),
              path_time_since_last_cross_ms: num(augmentedPayload.path_time_since_last_cross_ms),
              normalized_distance_volatility_units: num(augmentedPayload.normalized_distance_volatility_units),
              source_timestamp_ms: num(augmentedPayload.source_timestamp_ms), raw_ticks_persisted: false },
            schemaVersion: "compact-shadow-v3",
          }).onConflictDoNothing();
        }
        if (isCompactShock(augmentedPayload)) {
          await tx.insert(phase4bProspectiveSimulations).values({
            id: `compact-shock:${ticker}`, snapshotId, hypothesisVersion: COMPACT_SHOCK_VERSION,
            qualification: "shock", ticker, capturedAtMs,
            payload: { asset, ticker, event_timestamp_ms: capturedAtMs,
              velocity_dollars_per_second_30s: num(augmentedPayload.velocity_dollars_per_second_30s),
              trade_flow_imbalance_60s: num(augmentedPayload.coinbase_trade_flow_imbalance_60s),
              yes_executable_price_cents: num(augmentedPayload.kalshi_yes_weighted_executable_price_cents),
              no_executable_price_cents: num(augmentedPayload.kalshi_no_weighted_executable_price_cents),
              yes_executable_depth_contracts: num(augmentedPayload.kalshi_yes_executable_depth_contracts),
              no_executable_depth_contracts: num(augmentedPayload.kalshi_no_executable_depth_contracts),
              source_timestamp_ms: num(augmentedPayload.source_timestamp_ms), raw_ticks_persisted: false },
            schemaVersion: "compact-shadow-v3",
          }).onConflictDoNothing();
        }
      } else {
        await tx.insert(phase4bProspectiveSimulations).values({
          id: `compact-study-unavailable:${snapshotId}`, snapshotId,
          hypothesisVersion: "compact-shadow-studies-v1-unavailable", qualification: studyUnavailableReason,
          ticker, capturedAtMs, payload: { asset, ticker, raw_ticks_persisted: false, execution_gate: false },
          schemaVersion: "compact-shadow-v3",
        }).onConflictDoNothing();
      }
    });
  } catch (error) {
    opportunityAccumulators.set(ticker, priorAccumulator);
    throw error;
  }
  // Horizons are append-only observations after a durably enrolled shock.
  // They are deliberately evaluated only from another eligible compact row.
  if (!studyUnavailableReason) await recordShockHorizons(asset, ticker, snapshotId, capturedAtMs, augmentedPayload);
  counters.ingested++; counters.scored++;
  return true;
}

async function recordShockHorizons(asset: Asset, ticker: string, snapshotId: string, capturedAtMs: number, payload: Row): Promise<void> {
  const shocks = await db.select({ capturedAtMs: phase4bProspectiveSimulations.capturedAtMs, payload: phase4bProspectiveSimulations.payload })
    .from(phase4bProspectiveSimulations)
    .where(and(eq(phase4bProspectiveSimulations.hypothesisVersion, COMPACT_SHOCK_VERSION), eq(phase4bProspectiveSimulations.ticker, ticker))).limit(1);
  const shock = shocks[0];
  if (!shock) return;
  const elapsed = capturedAtMs - shock.capturedAtMs;
  if (elapsed <= 0) return;
  const original = shock.payload as Row;
  for (const horizonSeconds of COMPACT_SHOCK_HORIZONS_SECONDS) {
    if (!isShockHorizonDue(elapsed, horizonSeconds)) continue;
    const initialYes = num(original.yes_executable_price_cents), initialNo = num(original.no_executable_price_cents);
    const yes = num(payload.kalshi_yes_weighted_executable_price_cents), no = num(payload.kalshi_no_weighted_executable_price_cents);
    // A horizon must cite executable prices from both observations; otherwise
    // it is unavailable and does not fabricate repricing.
    if (initialYes === null || initialNo === null || yes === null || no === null) continue;
    await db.insert(phase4bProspectiveSimulations).values({
      id: `compact-shock-horizon:${ticker}:${horizonSeconds}`, snapshotId,
      hypothesisVersion: `${COMPACT_SHOCK_VERSION}-horizon`, qualification: String(horizonSeconds),
      ticker, capturedAtMs,
      payload: { asset, ticker, horizon_seconds: horizonSeconds, event_timestamp_ms: shock.capturedAtMs,
        observed_timestamp_ms: capturedAtMs, elapsed_ms: elapsed,
        yes_price_change_cents: yes - initialYes, no_price_change_cents: no - initialNo,
        yes_executable_price_cents: yes, no_executable_price_cents: no,
        yes_executable_depth_contracts: num(payload.kalshi_yes_executable_depth_contracts),
        no_executable_depth_contracts: num(payload.kalshi_no_executable_depth_contracts),
        raw_ticks_persisted: false },
      schemaVersion: "compact-shadow-v3",
    }).onConflictDoNothing();
  }
}

async function ingestFile(file: string, fallback: Asset | null): Promise<void> {
  const stat = statSync(file) as { dev: number; ino: number; size: number };
  const size = stat.size;
  let checkpoint = await loadCheckpoint(file, stat);
  const start = checkpoint.byteOffset;
  if (size <= start) return;
  const readLength = Math.min(MAX_LEDGER_READ_BYTES, size - start);
  const bytes = Buffer.alloc(readLength), fd = openSync(file, "r");
  try { readSync(fd, bytes, 0, readLength, start); } finally { closeSync(fd); }
  const finalNewline = bytes.lastIndexOf(10);
  if (finalNewline < 0) {
    const oversized = classifyCompactUnreadChunk(finalNewline, readLength) === "oversized";
    const firstOversizedFailure = oversized && checkpoint.lastReason !== "oversized_or_unterminated_ndjson_record";
    const candidate: LedgerCheckpoint = {
      ...checkpoint,
      status: oversized ? "degraded" : "partial_record_pending",
      lastReason: oversized ? "oversized_or_unterminated_ndjson_record" : "partial_ndjson_record_pending",
      rejectedCount: checkpoint.rejectedCount + (firstOversizedFailure ? 1 : 0),
      malformedCount: checkpoint.malformedCount + (firstOversizedFailure ? 1 : 0),
      lostRecordCount: checkpoint.lostRecordCount + (firstOversizedFailure ? 1 : 0),
    };
    await persistCheckpoint(file, candidate);
    return; // retain the partial final line; never silently advance it
  }
  let cursor = start;
  const lines = bytes.subarray(0, finalNewline + 1).toString("utf8").split("\n");
  lines.pop(); // the final newline is already included in the prior line's byte count
  for (const rawLine of lines) {
    const consumedBytes = Buffer.byteLength(rawLine) + 1;
    const nextOffset = cursor + consumedBytes;
    let row: Row;
    try { row = JSON.parse(rawLine) as Row; }
    catch {
      const candidate: LedgerCheckpoint = {
        ...checkpoint,
        byteOffset: nextOffset,
        status: "loss_detected",
        lastReason: "malformed_ndjson_record",
        rejectedCount: checkpoint.rejectedCount + 1,
        malformedCount: checkpoint.malformedCount + 1,
        lostRecordCount: checkpoint.lostRecordCount + 1,
      };
      await persistCheckpoint(file, candidate);
      counters.rejected++;
      checkpoint = candidate;
      cursor = nextOffset;
      continue;
    }
    try {
      const asset = assetOf(row, fallback), payload = allowlistedCompactPayload(row);
      if (!asset || !payload || num(row.recorded_at_ms) === null) {
        const candidate: LedgerCheckpoint = {
          ...checkpoint,
          byteOffset: nextOffset,
          status: "loss_detected",
          lastReason: "rejected_compact_record",
          rejectedCount: checkpoint.rejectedCount + 1,
          lostRecordCount: checkpoint.lostRecordCount + 1,
        };
        await persistCheckpoint(file, candidate);
        counters.rejected++;
        checkpoint = candidate;
        cursor = nextOffset;
        continue;
      }
      const accepted = await save(asset, row, payload);
      if (!accepted) {
        const candidate: LedgerCheckpoint = {
          ...checkpoint,
          byteOffset: nextOffset,
          status: "loss_detected",
          lastReason: "rejected_compact_record",
          rejectedCount: checkpoint.rejectedCount + 1,
          lostRecordCount: checkpoint.lostRecordCount + 1,
        };
        await persistCheckpoint(file, candidate);
        counters.rejected++;
        checkpoint = candidate;
        cursor = nextOffset;
        continue;
      }
      // Only checkpoint an offset after its compact record is durably accepted.
      const candidate: LedgerCheckpoint = {
        ...checkpoint,
        byteOffset: nextOffset,
        lastRecordId: typeof row.id === "string" ? row.id : null,
        lastRecordAtMs: num(row.recorded_at_ms),
      };
      // Loss counters are intentionally sticky. A later valid record proves
      // recovery of the worker, not recovery of evidence that was rotated,
      // truncated, or rejected before its cursor could be checkpointed.
      candidate.status = candidate.lostRecordCount > 0 ? "loss_detected"
        : size - nextOffset > BACKLOG_BYTES_WARNING ? "backlog" : "healthy";
      candidate.lastReason = candidate.lostRecordCount > 0 ? candidate.lastReason
        : size - nextOffset > BACKLOG_BYTES_WARNING ? "backlog_pending" : null;
      await persistCheckpoint(file, candidate);
      checkpoint = candidate;
      cursor = nextOffset;
    } catch {
      counters.writeFailures++;
      const candidate: LedgerCheckpoint = {
        ...checkpoint,
        writeFailureCount: checkpoint.writeFailureCount + 1,
        status: "degraded",
        lastReason: "durable_write_failed",
      };
      await persistCheckpoint(file, candidate).catch(() => {});
      break; // retry the failed durable write from the same byte next cycle
    }
  }
  if (size - cursor > BACKLOG_BYTES_WARNING && checkpoint.status === "healthy") {
    await persistCheckpoint(file, { ...checkpoint, status: "backlog", lastReason: "backlog_pending" });
  }
}

async function ingestAll(): Promise<void> {
  for (const [dir, fallback] of [[join(OUT, "btc-eth-coinbase-target"), null]] as const) {
    if (existsSync(dir)) for (const file of readdirSync(dir).filter((name) => name.endsWith(".ndjson")).sort()) await ingestFile(join(dir, file), fallback);
  }
}

async function outcomes(): Promise<void> {
  const candidates = await db.select({ ticker: phase4bMarketIntervals.marketId, closeMs: phase4bMarketIntervals.windowCloseMs }).from(phase4bMarketIntervals).leftJoin(phase4bMarketOutcomes, eq(phase4bMarketOutcomes.marketId, phase4bMarketIntervals.marketId)).where(and(
    eq(phase4bMarketIntervals.metadataVersion, "public-kalshi-window-v1"),
    lte(phase4bMarketIntervals.windowCloseMs, Date.now() - 180_000),
    isNull(phase4bMarketOutcomes.result),
    or(isNull(phase4bMarketOutcomes.settlementStatus), ne(phase4bMarketOutcomes.settlementStatus, "unavailable_http_404")),
  )).orderBy(asc(phase4bMarketIntervals.windowCloseMs)).limit(20);
  for (const candidate of candidates) try {
    const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(candidate.ticker)}`);
    const unavailableStatus = compactOutcomeStatusForHttp(response.status);
    if (unavailableStatus) {
      await db.insert(phase4bMarketOutcomes).values({
        marketId: candidate.ticker, result: null, settlementTimestampMs: null,
        reconciledAtMs: Date.now(), settlementStatus: unavailableStatus, schemaVersion: "compact-shadow-v2",
      }).onConflictDoUpdate({
        target: phase4bMarketOutcomes.marketId,
        // Never overwrite a real outcome if the public endpoint later loses
        // retention for a market we already resolved.
        set: {
          reconciledAtMs: sql`CASE WHEN ${phase4bMarketOutcomes.result} IS NULL THEN ${Date.now()} ELSE ${phase4bMarketOutcomes.reconciledAtMs} END`,
          settlementStatus: sql`CASE WHEN ${phase4bMarketOutcomes.result} IS NULL THEN ${unavailableStatus} ELSE ${phase4bMarketOutcomes.settlementStatus} END`,
          schemaVersion: sql`CASE WHEN ${phase4bMarketOutcomes.result} IS NULL THEN 'compact-shadow-v2' ELSE ${phase4bMarketOutcomes.schemaVersion} END`,
        },
      });
      continue;
    }
    if (!response.ok) { counters.outcomeFailures++; continue; }
    const market = (await response.json() as { market?: { ticker?: unknown; result?: unknown; status?: unknown } }).market;
    if (market?.ticker !== candidate.ticker) { counters.outcomeFailures++; continue; }
    const result = market?.result === "yes" || market?.result === "no" ? market.result : null;
    await db.insert(phase4bMarketOutcomes).values({ marketId: candidate.ticker, result, settlementTimestampMs: result ? candidate.closeMs : null, reconciledAtMs: Date.now(), settlementStatus: String(market?.status ?? `http_${response.status}`), schemaVersion: "compact-shadow-v2" }).onConflictDoUpdate({
      target: phase4bMarketOutcomes.marketId,
      set: result ? {
        result: sql`COALESCE(${phase4bMarketOutcomes.result}, ${result})`,
        settlementTimestampMs: sql`COALESCE(${phase4bMarketOutcomes.settlementTimestampMs}, ${candidate.closeMs})`,
        reconciledAtMs: Date.now(), settlementStatus: String(market?.status ?? "finalized"), schemaVersion: "compact-shadow-v2",
      } : { reconciledAtMs: Date.now(), settlementStatus: String(market?.status ?? `http_${response.status}`), schemaVersion: "compact-shadow-v2" },
    });
    // On exact yes/no settlement: persist one idempotent compact lifecycle simulation
    if (result === "yes" || result === "no") {
      await persistLifecycleSimulation(candidate.ticker, result, candidate.closeMs, String(market?.status ?? "finalized"));
      await reconcileNormalizedDistanceExperiment();
    }
  } catch { counters.outcomeFailures++; }
}

/**
 * Append settlement evidence without changing the frozen enrollment record.
 * This also catches outcomes that were reconciled before a worker restart.
 */
async function reconcileNormalizedDistanceExperiment(): Promise<void> {
  const result = await db.execute(sql`
    SELECT enrollment.ticker, enrollment.snapshot_id, enrollment.captured_at_ms,
      enrollment.qualification AS directional_call, enrollment.payload, outcome.result,
      outcome.settlement_timestamp_ms, outcome.settlement_status
    FROM phase4b_prospective_simulations enrollment
    INNER JOIN phase4b_market_outcomes outcome ON outcome.market_id = enrollment.ticker
    WHERE enrollment.hypothesis_version = ${NORMALIZED_DISTANCE_EXPERIMENT_VERSION}
      AND enrollment.captured_at_ms >= ${NORMALIZED_DISTANCE_EXPERIMENT_START_MS}
      AND outcome.result IN ('yes', 'no')
      AND NOT EXISTS (
        SELECT 1 FROM phase4b_prospective_simulations reconciled
        WHERE reconciled.id = ('compact-normalized-distance-outcome:' || enrollment.ticker)
      )
    ORDER BY enrollment.captured_at_ms ASC
    LIMIT 50
  `);
  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  for (const row of rows) {
    const call = row.directional_call === "yes" || row.directional_call === "no" ? row.directional_call : "neutral";
    const settlement = row.result === "yes" || row.result === "no" ? row.result : null;
    if (!settlement) continue;
    await db.insert(phase4bProspectiveSimulations).values({
      id: `compact-normalized-distance-outcome:${String(row.ticker)}`,
      snapshotId: String(row.snapshot_id),
      hypothesisVersion: NORMALIZED_DISTANCE_EXPERIMENT_OUTCOME_VERSION,
      qualification: call === "neutral" ? "neutral_reconciled" : call === settlement ? "correct" : "incorrect",
      ticker: String(row.ticker),
      capturedAtMs: Date.now(),
      payload: {
        experiment_version: NORMALIZED_DISTANCE_EXPERIMENT_VERSION,
        experiment_start_ms: NORMALIZED_DISTANCE_EXPERIMENT_START_MS,
        asset: (row.payload as Row | null)?.asset ?? null,
        ticker: String(row.ticker),
        enrollment_snapshot_id: String(row.snapshot_id),
        enrollment_timestamp_ms: num(row.captured_at_ms),
        directional_call: call,
        settlement_result: settlement,
        directional_call_correct: call === "neutral" ? null : call === settlement,
        settlement_timestamp_ms: num(row.settlement_timestamp_ms),
        settlement_status: String(row.settlement_status ?? "finalized"),
        raw_ticks_persisted: false,
      },
      schemaVersion: "compact-shadow-v3",
    }).onConflictDoNothing();
  }
}

/** Every new compact-study enrollment gets a separate append-only authoritative
 * outcome row; neither enrollment nor horizon evidence is ever rewritten. */
async function reconcileCompactStudyOutcomes(): Promise<void> {
  const result = await db.execute(sql`
    SELECT enrollment.id, enrollment.ticker, enrollment.snapshot_id, enrollment.hypothesis_version,
      enrollment.qualification, enrollment.payload, outcome.result, outcome.settlement_timestamp_ms, outcome.settlement_status
    FROM phase4b_prospective_simulations enrollment
    INNER JOIN phase4b_market_outcomes outcome ON outcome.market_id = enrollment.ticker
    WHERE enrollment.hypothesis_version IN (${COMPACT_CHECKPOINT_VERSION}, ${COMPACT_PERSISTENCE_VERSION}, ${COMPACT_SHOCK_VERSION})
      AND outcome.result IN ('yes', 'no')
      AND NOT EXISTS (SELECT 1 FROM phase4b_prospective_simulations settled
        WHERE settled.id = ('compact-study-outcome:' || enrollment.id))
    ORDER BY enrollment.captured_at_ms ASC LIMIT 100
  `);
  for (const row of (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? []) {
    await db.insert(phase4bProspectiveSimulations).values({
      id: `compact-study-outcome:${String(row.id)}`, snapshotId: String(row.snapshot_id),
      hypothesisVersion: `${String(row.hypothesis_version)}-outcome`,
      qualification: String(row.result), ticker: String(row.ticker), capturedAtMs: Date.now(),
      payload: { ...(row.payload as Row), enrollment_id: String(row.id), settlement_result: String(row.result),
        settlement_timestamp_ms: num(row.settlement_timestamp_ms), settlement_status: String(row.settlement_status ?? "finalized"),
        raw_ticks_persisted: false },
      schemaVersion: "compact-shadow-v3",
    }).onConflictDoNothing();
  }
}

/**
 * Recover lifecycle rows that predate lifecycle recording. This reads only
 * already-authoritative settlement facts and already-captured scalar compact
 * evidence; it never refetches an outcome or manufactures a snapshot.
 */
async function backfillHistoricalLifecycles(): Promise<void> {
  const candidates = await db.execute(sql`
    SELECT mi.market_id AS ticker, mi.window_close_ms AS close_ms,
      mo.result, mo.settlement_status
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
      AND NOT EXISTS (
        SELECT 1
        FROM phase4b_prospective_simulations ps
        WHERE ps.hypothesis_version = 'compact-shadow-lifecycle-v1'
          AND ps.ticker = mi.market_id
      )
    ORDER BY mi.window_close_ms ASC
    LIMIT 50
  `);
  const rows = (candidates as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  for (const row of rows) {
    const result = row.result === "yes" || row.result === "no" ? row.result : null;
    const closeMs = num(row.close_ms);
    if (!result || closeMs === null) continue;
    const inserted = await persistLifecycleSimulation(
      String(row.ticker),
      result,
      closeMs,
      String(row.settlement_status ?? "finalized"),
    );
    counters.lifecycleBackfills += inserted;
  }
}

/**
 * Persist one idempotent compact lifecycle simulation linked to ticker,
 * exact outcome, latest final pre-settlement snapshot payload, and
 * settlement timestamps/status. No raw data.
 */
async function persistLifecycleSimulation(ticker: string, result: "yes" | "no", closeMs: number, settlementStatus: string): Promise<number> {
  // Idempotent: one lifecycle simulation per ticker+result
  const lifecycleId = `compact-lifecycle:${ticker}:${result}`;
  try {
    const latestSnapshotRows = await db
      .select({ snapshotId: phase4bDecisionSnapshots.snapshotId, capturedAtMs: phase4bDecisionSnapshots.capturedAtMs, payload: phase4bDecisionSnapshots.payload })
      .from(phase4bDecisionSnapshots)
      .where(and(eq(phase4bDecisionSnapshots.marketId, ticker), eq(phase4bDecisionSnapshots.source, "compact-coinbase-shadow"), lte(phase4bDecisionSnapshots.capturedAtMs, closeMs)))
      .orderBy(desc(phase4bDecisionSnapshots.capturedAtMs))
      .limit(1);
    const latestSnapshot = latestSnapshotRows[0] ?? null;
    // A lifecycle row is useful only when it can cite final compact evidence.
    // The backfill query has the same guard, and this keeps the live path
    // consistent if an interval/outcome exists without a stored snapshot.
    if (!latestSnapshot) return 0;
    const latestPayload = latestSnapshot?.payload && typeof latestSnapshot.payload === "object" && !Array.isArray(latestSnapshot.payload)
      ? latestSnapshot.payload as Record<string, unknown> : {};

    // Retrieve accumulator snapshot for this ticker (if present)
    const acc = opportunityAccumulators.get(ticker) ?? null;

    const lifecyclePayload: Record<string, unknown> = {
      ticker,
      result,
      settlement_timestamp_ms: closeMs,
      settlement_status: settlementStatus,
      reconciled_at_ms: Date.now(),
      latest_pre_settlement_snapshot_id: latestSnapshot?.snapshotId ?? null,
      latest_pre_settlement_captured_at_ms: latestSnapshot?.capturedAtMs ?? null,
      // Include only scalar, non-raw fields from the final snapshot payload
      ...(Object.keys(latestPayload).length > 0
        ? Object.fromEntries(
            Object.entries(latestPayload).filter(([k, v]) =>
              FIELDS.has(k) && (v === null || typeof v !== "object")
            )
          )
        : {}),
      // Accumulator summary
      acc_peak_edge_cents: acc?.peakEdgeCents ?? num(latestPayload.acc_peak_edge_cents),
      acc_peak_edge_ms: acc?.peakEdgeMs ?? num(latestPayload.acc_peak_edge_ms),
      acc_edge_duration_ms: acc?.edgeDurationMs ?? num(latestPayload.acc_edge_duration_ms),
      acc_executable_positive_duration_ms: acc?.executablePositiveDurationMs ?? num(latestPayload.acc_executable_positive_duration_ms),
      acc_signal_concurrence_count: acc?.signalConcurrenceCount ?? num(latestPayload.acc_signal_concurrence_count),
      acc_snapshot_count: acc?.snapshotCount ?? num(latestPayload.acc_snapshot_count),
      acc_signal_concurrence_ratio: acc && acc.snapshotCount > 0
        ? acc.signalConcurrenceCount / acc.snapshotCount : num(latestPayload.acc_signal_concurrence_ratio),
      acc_max_model_divergence_cents: acc?.maxModelDivergenceCents ?? num(latestPayload.acc_max_model_divergence_cents),
      acc_avg_model_divergence_cents: acc && acc.modelDivergenceObservationCount > 0
        ? acc.sumModelDivergenceCents / acc.modelDivergenceObservationCount
        : num(latestPayload.acc_avg_model_divergence_cents),
      acc_model_divergence_observation_count: acc?.modelDivergenceObservationCount
        ?? num(latestPayload.acc_model_divergence_observation_count),
      raw_ticks_persisted: false,
    };

    const inserted = await db.insert(phase4bProspectiveSimulations).values({
      id: lifecycleId,
      snapshotId: lifecycleId,
      hypothesisVersion: "compact-shadow-lifecycle-v1",
      qualification: result,
      ticker,
      capturedAtMs: Date.now(),
      payload: lifecyclePayload,
      schemaVersion: "compact-shadow-v2",
    }).onConflictDoNothing().returning({ id: phase4bProspectiveSimulations.id });
    counters.lifecycleSimulations += inserted.length;
    return inserted.length;
  } catch {
    counters.writeFailures++;
    return 0;
  }
}

async function health(status: string, error: string | null = null): Promise<void> {
  const capturedAtMs = Date.now(), id = `compact-worker:${Math.floor(capturedAtMs / 60_000)}`;
  await db.insert(phase4bProspectiveSimulations).values({ id, snapshotId: id, hypothesisVersion: "compact-shadow-worker-health-v1", qualification: status, ticker: "compact-shadow-worker", capturedAtMs, payload: { status, error, checkpoint_count: ledgerCheckpoints.size, ...counters, raw_ticks_persisted: false }, schemaVersion: "compact-shadow-v2" }).onConflictDoNothing();
}

export async function runCompactShadowWorker(): Promise<void> {
  await ensureCompactLedgerCheckpointSchema();
  const collectorEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    BTC_ETH_COINBASE_TARGET_LEDGER_DIR: process.env.BTC_ETH_COINBASE_TARGET_LEDGER_DIR ?? join(OUT, "btc-eth-coinbase-target"),
  };
  collector = spawn(process.execPath, [SUPERVISOR], { cwd: ROOT, stdio: "inherit", env: collectorEnv });
  let cycleInFlight = false;
  const cycle = async () => {
    if (cycleInFlight) { counters.skippedCycles++; return; }
    cycleInFlight = true;
    try {
        await ingestAll(); await outcomes(); await backfillHistoricalLifecycles(); await reconcileNormalizedDistanceExperiment(); await reconcileCompactStudyOutcomes();
      const blocking = [...ledgerCheckpoints.values()].find((checkpoint) => checkpoint.status !== "healthy");
      await health(blocking ? "degraded" : "healthy", blocking?.lastReason ?? null);
    }
    catch (error) { await health("degraded", error instanceof Error ? error.message : "unknown").catch(() => {}); }
    finally { cycleInFlight = false; }
  };
  await cycle(); const timer = setInterval(() => { void cycle(); }, 30_000);
  const stop = () => { clearInterval(timer); collector?.kill("SIGTERM"); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
