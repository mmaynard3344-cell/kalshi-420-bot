/**
 * Target-liquidity observability for the ETH/SOL 30–50 strategies.
 *
 * Answers, after the fact, why a resting 50¢ GTC target did not fill:
 *   • the owned-side best bid never reached the target price, or
 *   • it did, but the queue depth at/above the target was too thin, or
 *   • depth was sufficient while the target rested unfilled — an execution /
 *     order-management defect worth investigating.
 *
 * While a target is resting and the owned-side best bid is at/above the
 * target, a throttled observer persists a snapshot of the executable bid
 * levels (price + contracts) at/above the target, together with the target
 * order's durable identity, resting size, and (best-effort) exchange status.
 *
 * PURE observability: this module never places, cancels, or resizes orders,
 * and every write is fire-and-forget — a failure can never affect trading.
 */
import { parseExitSellBids, type L2Level } from "../orderbookParsing.js";
import type { KalshiOrderbookRaw } from "../orderbookParsing.js";

// ── Snapshot shape (mirrors the target_liquidity_snapshots table) ────────────

export interface TargetLiquidityBidLevel {
  priceCents:      number;
  contractsApprox: number;
}

export interface TargetLiquiditySnapshotParams {
  /** "${strategy}:${ticker}:${capturedAtMs}" — natural PK. */
  id:                        string;
  strategy:                  string;          // "ETH_30_50" | "SOL_30_50"
  ticker:                    string;
  easternDate:               string;
  /** Held outcome side whose buyers must absorb the target ask. */
  side:                      "yes" | "no";
  /** Durable strategy-order row id of the resting target (e.g. "exit:T:1"). */
  targetOrderDbId:           string | null;
  targetKalshiOrderId:       string | null;
  /** Epoch ms when the target order row was created (start of the durable target-active interval). */
  targetPlacedAtMs:          number | null;
  /** Exchange-reported order status at snapshot time; null when the status fetch failed. */
  orderStatus:               string | null;
  /** Contracts still resting on the target (requested − filled) per durable rows. */
  restingContracts:          number | null;
  /** BBO owned-side bid that triggered this snapshot. */
  observedBidCents:          number | null;
  /** Executable owned-side bid levels at/above the target price. */
  bidLevelsAtOrAboveTarget:  TargetLiquidityBidLevel[];
  /** Total contracts across those levels. */
  contractsAtOrAboveTarget:  number;
  /** Non-null when the orderbook fetch failed (depth fields are zero/empty). */
  bookError:                 string | null;
  capturedAtMs:              number;
}

// ── Depth extraction (pure) ───────────────────────────────────────────────────

/**
 * Extract the owned-side executable bid levels at/above the target price from
 * a raw Kalshi orderbook. For a held YES sold at the target, the buyers are
 * the resting BUY YES orders (yes side); for a held NO, the BUY NO orders.
 */
export function extractBidDepthAtOrAboveTarget(
  raw: KalshiOrderbookRaw,
  heldSide: "yes" | "no",
  targetCents: number,
): { levels: TargetLiquidityBidLevel[]; contracts: number } {
  const bids: L2Level[] = parseExitSellBids(raw, heldSide);
  const levels = bids
    .filter((level) => level.priceCents >= targetCents)
    .sort((a, b) => b.priceCents - a.priceCents)
    .map((level) => ({ priceCents: level.priceCents, contractsApprox: level.contractsApprox }));
  return { levels, contracts: levels.reduce((sum, l) => sum + l.contractsApprox, 0) };
}

// ── Observer engine ───────────────────────────────────────────────────────────

/** Minimal view of a durable strategy-order row the observer needs. */
export interface TargetLiquidityOrderView {
  id:                 string;
  role:               string;               // "entry" | "exit"
  outcome:            string;
  kalshiOrderId:      string | null;
  requestedContracts: number;
  filledContracts:    number | null;
  /** Epoch ms the row was created/last mutated — used for targetPlacedAtMs. */
  createdAtMs:        number | null;
}

export interface TargetLiquidityObserverDeps {
  strategy:    string;
  targetCents: number;
  /** Min ms between snapshots per ticker (bounds exchange reads). */
  intervalMs?: number;
  listOrders(ticker: string): Promise<TargetLiquidityOrderView[]>;
  fetchOrderbookRaw(ticker: string): Promise<KalshiOrderbookRaw>;
  /** Best-effort exchange status of the resting target; null on any failure. */
  fetchOrderStatus(kalshiOrderId: string): Promise<string | null>;
  insertSnapshot(params: TargetLiquiditySnapshotParams): void;
  easternDate(nowMs: number): string;
  now?(): number;
  /** Optional capture-failure logger (kept injectable so tests avoid pino). */
  onCaptureError?(err: unknown, ticker: string): void;
}

export interface TargetLiquidityObserver {
  /** Arm observation for a ticker with a resting target on the held side. */
  arm(ticker: string, side: "yes" | "no"): void;
  /** Disarm (target gone: filled, cancelled, or settled). */
  disarm(ticker: string): void;
  /** Tick hook: fire-and-forget; snapshots only when armed and the held side's bid ≥ target. */
  observe(ticker: string, bids: { yesBid?: number | null; noBid?: number | null }): void;
  /** Test/introspection helper. */
  isArmed(ticker: string): boolean;
}

export const TARGET_LIQUIDITY_SNAPSHOT_INTERVAL_MS = 30_000;

export function createTargetLiquidityObserver(deps: TargetLiquidityObserverDeps): TargetLiquidityObserver {
  const armed = new Map<string, "yes" | "no">();
  const lastSnapshotMs = new Map<string, number>();
  const inFlight = new Set<string>();
  const intervalMs = deps.intervalMs ?? TARGET_LIQUIDITY_SNAPSHOT_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  async function capture(ticker: string, side: "yes" | "no", bidCents: number): Promise<void> {
    // Re-derive the resting target from durable rows so a stale in-memory arm
    // can never fabricate snapshots for a target that no longer rests.
    const orders = await deps.listOrders(ticker);
    const restingExits = orders.filter((o) =>
      o.role === "exit" && (o.outcome === "pending" || o.outcome === "partial_fill"));
    if (restingExits.length === 0) { armed.delete(ticker); return; }
    // Latest resting exit wins (there is at most one by design).
    const target = restingExits[restingExits.length - 1]!;
    const restingContracts = Math.max(0, target.requestedContracts - (target.filledContracts ?? 0));
    if (restingContracts <= 0) { armed.delete(ticker); return; }

    let levels: TargetLiquidityBidLevel[] = [];
    let contracts = 0;
    let bookError: string | null = null;
    try {
      const raw = await deps.fetchOrderbookRaw(ticker);
      const depth = extractBidDepthAtOrAboveTarget(raw, side, deps.targetCents);
      levels = depth.levels;
      contracts = depth.contracts;
    } catch (err) {
      bookError = err instanceof Error ? err.message : String(err);
    }

    let orderStatus: string | null = null;
    if (target.kalshiOrderId) {
      try { orderStatus = await deps.fetchOrderStatus(target.kalshiOrderId); } catch { orderStatus = null; }
    }

    const capturedAtMs = now();
    deps.insertSnapshot({
      id: `${deps.strategy}:${ticker}:${capturedAtMs}`,
      strategy: deps.strategy, ticker, easternDate: deps.easternDate(capturedAtMs), side,
      targetOrderDbId: target.id, targetKalshiOrderId: target.kalshiOrderId,
      targetPlacedAtMs: target.createdAtMs, orderStatus, restingContracts,
      observedBidCents: bidCents, bidLevelsAtOrAboveTarget: levels,
      contractsAtOrAboveTarget: contracts, bookError, capturedAtMs,
    });
  }

  return {
    arm(ticker, side) { armed.set(ticker, side); },
    disarm(ticker) { armed.delete(ticker); lastSnapshotMs.delete(ticker); },
    isArmed(ticker) { return armed.has(ticker); },
    observe(ticker, bids) {
      const side = armed.get(ticker);
      if (!side) return;
      const bidCents = side === "yes" ? bids.yesBid : bids.noBid;
      if (bidCents == null || bidCents < deps.targetCents) return;
      const nowMs = now();
      const last = lastSnapshotMs.get(ticker);
      if (last != null && nowMs - last < intervalMs) return;
      if (inFlight.has(ticker)) return;
      lastSnapshotMs.set(ticker, nowMs);
      inFlight.add(ticker);
      void capture(ticker, side, bidCents)
        .catch((err) => { try { deps.onCaptureError?.(err, ticker); } catch { /* never throw */ } })
        .finally(() => inFlight.delete(ticker));
    },
  };
}

// ── Per-position classification (pure) ────────────────────────────────────────

export type TargetLiquidityClassification =
  | "no_position"                    // never held contracts on this ticker
  | "target_filled"                  // the 50¢ target sold every owned contract
  | "never_reached_target"           // owned-side best bid never reached the target
  | "reached_target_no_depth_data"   // bid reached target but no usable depth snapshots exist
  | "insufficient_depth"             // touched target, but depth never covered the resting size
  | "sufficient_depth_unfilled";     // depth covered the resting size while the target stayed unfilled

export interface TargetLiquiditySnapshotView {
  contractsAtOrAboveTarget: number;
  restingContracts:         number | null;
  capturedAtMs:             number;
  bookError:                string | null;
  orderStatus:              string | null;
  targetKalshiOrderId:      string | null;
  targetPlacedAtMs:         number | null;
}

export interface TargetLiquidityPositionInput {
  ticker:              string;
  easternDate:         string;
  side:                "yes" | "no" | null;
  entryContracts:      number;
  exitContracts:       number;
  openContracts:       number;
  settled:             boolean;
  /** Epoch ms of the once-only "target_first_executable" decision event, if any. */
  firstExecutableAtMs: number | null;
  snapshots:           readonly TargetLiquiditySnapshotView[];
}

export interface TargetLiquidityPositionReport {
  ticker:                   string;
  easternDate:              string;
  side:                     "yes" | "no" | null;
  classification:           TargetLiquidityClassification;
  entryContracts:           number;
  exitContracts:            number;
  openContracts:            number;
  settled:                  boolean;
  firstExecutableAtMs:      number | null;
  snapshotCount:            number;
  usableSnapshotCount:      number;
  firstSnapshotAtMs:        number | null;
  lastSnapshotAtMs:         number | null;
  /** Deepest observed queue at/above the target across usable snapshots. */
  maxContractsAtOrAboveTarget: number | null;
  /** Resting target size at the last usable snapshot. */
  lastRestingContracts:     number | null;
  lastOrderStatus:          string | null;
  targetKalshiOrderId:      string | null;
  targetPlacedAtMs:         number | null;
  /** Count of usable snapshots where depth ≥ resting size (execution-problem evidence). */
  sufficientDepthSnapshots: number;
}

export function classifyTargetLiquidity(input: TargetLiquidityPositionInput): TargetLiquidityPositionReport {
  const snapshots = [...input.snapshots].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  const usable = snapshots.filter((s) => s.bookError == null);
  const last = snapshots[snapshots.length - 1] ?? null;
  const lastUsable = usable[usable.length - 1] ?? null;
  const maxDepth = usable.length > 0
    ? Math.max(...usable.map((s) => s.contractsAtOrAboveTarget)) : null;
  const sufficientCount = usable.filter((s) =>
    s.restingContracts != null && s.restingContracts > 0 &&
    s.contractsAtOrAboveTarget >= s.restingContracts).length;

  let classification: TargetLiquidityClassification;
  if (input.entryContracts <= 0) {
    classification = "no_position";
  } else if (input.exitContracts >= input.entryContracts && input.exitContracts > 0) {
    classification = "target_filled";
  } else if (input.firstExecutableAtMs == null && snapshots.length === 0) {
    classification = "never_reached_target";
  } else if (usable.length === 0) {
    classification = "reached_target_no_depth_data";
  } else if (sufficientCount > 0) {
    classification = "sufficient_depth_unfilled";
  } else {
    classification = "insufficient_depth";
  }

  return {
    ticker: input.ticker,
    easternDate: input.easternDate,
    side: input.side,
    classification,
    entryContracts: input.entryContracts,
    exitContracts: input.exitContracts,
    openContracts: input.openContracts,
    settled: input.settled,
    firstExecutableAtMs: input.firstExecutableAtMs,
    snapshotCount: snapshots.length,
    usableSnapshotCount: usable.length,
    firstSnapshotAtMs: snapshots[0]?.capturedAtMs ?? null,
    lastSnapshotAtMs: last?.capturedAtMs ?? null,
    maxContractsAtOrAboveTarget: maxDepth,
    lastRestingContracts: lastUsable?.restingContracts ?? last?.restingContracts ?? null,
    lastOrderStatus: last?.orderStatus ?? null,
    targetKalshiOrderId: last?.targetKalshiOrderId ?? null,
    targetPlacedAtMs: last?.targetPlacedAtMs ?? null,
    sufficientDepthSnapshots: sufficientCount,
  };
}

export interface TargetLiquidityReport {
  strategy:      string;
  targetCents:   number;
  generatedAtMs: number;
  positions:     TargetLiquidityPositionReport[];
  summary: {
    positions:                 number;
    targetFilled:              number;
    neverReachedTarget:        number;
    reachedNoDepthData:        number;
    insufficientDepth:         number;
    sufficientDepthUnfilled:   number;
  };
}

export function buildTargetLiquidityReport(
  strategy: string,
  targetCents: number,
  inputs: readonly TargetLiquidityPositionInput[],
  nowMs = Date.now(),
): TargetLiquidityReport {
  const positions = inputs
    .map(classifyTargetLiquidity)
    .filter((p) => p.classification !== "no_position");
  const count = (c: TargetLiquidityClassification) =>
    positions.filter((p) => p.classification === c).length;
  return {
    strategy, targetCents, generatedAtMs: nowMs, positions,
    summary: {
      positions: positions.length,
      targetFilled: count("target_filled"),
      neverReachedTarget: count("never_reached_target"),
      reachedNoDepthData: count("reached_target_no_depth_data"),
      insufficientDepth: count("insufficient_depth"),
      sufficientDepthUnfilled: count("sufficient_depth_unfilled"),
    },
  };
}
