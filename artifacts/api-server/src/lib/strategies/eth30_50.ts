/**
 * ETH_30_50 is deliberately independent from the legacy final-window strategy.
 * It observes the same normalized market tick, but owns only rows explicitly
 * claimed in eth30_* storage and is disabled unless ETH_30_50_ENABLED=true.
 */
import { randomUUID } from "node:crypto";
import { kalshiAuthFetch } from "../kalshiAuth.js";
import { captureOrderbook } from "../orderbookCapture.js";
import { parseKalshiOrderResponse } from "../orderResponseParser.js";
import { easternDay } from "../dailyBudget.js";
import { allowNewInvestment } from "../dailyProfitStop.js";
import { isTradingHalted } from "../tradingKillSwitch.js";
import { logger } from "../logger.js";
import {
  ETH30_ENTRY_CAP_CENTS, ETH30_TARGET_CENTS, ETH30_PRINCIPAL_CAP_CENTS,
  eth30EntryPriceBucket, eth30PrincipalCapForEntryPrice,
  isEth30Ticker, isEth30OpeningWindow, contractsForEth30Capacity, mayEnterEth30,
} from "./eth30_50Rules.js";
import { isPaired30HighLeg, planPaired30Entry, type Paired30Leg } from "./paired30_50Rules.js";
import { planCanonicalFillLedger, settlementReadiness, buildAuthoritativeFillChunks, isChunkFillEvent, type AuthoritativeFillChunk } from "./eth30FillSync.js";
import { normalizeKalshiFill, type KalshiFillWire, type NormalizedKalshiFill } from "../kalshiFillNormalizer.js";

export {
  ETH30_STRATEGY_ID, ETH30_ENTRY_MIN_CENTS, ETH30_ENTRY_CAP_CENTS, ETH30_TARGET_CENTS,
  ETH30_PRINCIPAL_CAP_CENTS, ETH30_HIGH_TIER_PRINCIPAL_CAP_CENTS,
  eth30EntryPolicy, eth30EntryPriceBucket, eth30PrincipalCapForEntryPrice,
  isEth30Ticker, isEth30OpeningWindow, contractsForEth30Capacity, mayEnterEth30,
} from "./eth30_50Rules.js";
import * as realStore from "../tradeStore.js";
import { kalshiFetch } from "../kalshi.js";
import {
  createTargetLiquidityObserver, buildTargetLiquidityReport,
  type TargetLiquidityReport, type TargetLiquidityPositionInput,
} from "./targetLiquidity.js";
import type { KalshiOrderbookRaw } from "../orderbookParsing.js";
import { computeEth30Report, STALE_NO_FILL_THRESHOLD_MS, type Eth30Report } from "./eth30Report.js";
import {
  eth2125Contracts, observeEth2125ProspectiveTarget, recordEth2125ProspectiveCandidate,
} from "./eth2125Prospective.js";
import { getKrakenPrices } from "../krakenPrices.js";
import {
  observeEth30ShadowTelemetry, refreshEth30ShadowOutcomes,
  type Eth30ShadowStore,
} from "./eth30ShadowTelemetry.js";
import { observePairedSideShadow, refreshPairedSideSettlementOutcomes } from "./pairedSideShadow.js";

export interface Eth30MarketState {
  ticker: string; openTime: string | null; closeTime: string | null;
  status: string | null; bidUpdatedMs: number;
  /** Optional BBO cents (present on the shared evaluator's state). Used only
   *  for passive first-executable-50¢ evidence — never for order placement. */
  yesBid?: number | null; noBid?: number | null;
}

export type Eth30Store = Pick<typeof realStore,
  | "claimEth30Ticker"
  | "recordEth30StrategyOrder"
  | "updateEth30StrategyOrder"
  | "listEth30StrategyOrders"
  | "appendEth30PositionEvent"
  | "listEth30PositionEvents"
  | "listEth30TickerClaimsForDate"
  | "listEth30TickerClaimsForDates"
  | "deleteEth30PositionEvents"
  | "appendEth30DecisionEvent"
  | "listEth30DecisionEvents"
  | "listRecentEth30DecisionEvents"
  | "listAllEth30TickerClaims"
  | "listSettledEth30Tickers"
> & { reserveEth30PairedEntry?: typeof realStore.reserveEth30PairedEntry };
let highOnlyTargetsSuspended = false;
/** Test-only reset for the process-local high-only cancellation latch. */
export function _resetEth30HighOnlyStateForTesting(): void {
  highOnlyTargetsSuspended = false;
}
function liveEnabled(): boolean {
  // Retired at the ETH-only martingale cutover. Historical rows remain
  // available for audit and existing-position recovery, but no new entry or
  // target replacement may be submitted through this strategy.
  return false;
}
/**
 * Owner-directed ETH mode: exercise only the 70–80¢ paired leg.
 *
 * This is deliberately the safe default. A missing, malformed, or not-yet-
 * propagated high-only setting must never fall through to the legacy low-leg
 * strategy. Re-enabling any 20–30¢ child (or its 50¢ target) requires the
 * separate, explicit legacy opt-in below. If both switches are present, the
 * high-only instruction wins.
 */
function highLegOnlyTestEnabled(): boolean {
  const enabled = process.env["ETH30_HIGH_LEG_ONLY_TEST_ENABLED"] === "true"
    || process.env["ETH30_ALLOW_LEGACY_LOW_LEGS"] !== "true";
  // A later high-only → explicitly opted-in legacy transition must repeat the
  // cancellation gate before high-only can resume.
  if (!enabled) highOnlyTargetsSuspended = false;
  return enabled;
}
function outcomeBookSide(side: "yes" | "no"): "bid" | "ask" { return side === "yes" ? "bid" : "ask"; }
function bookPrice(side: "yes" | "no", cents: number): string {
  return ((side === "yes" ? cents : 100 - cents) / 100).toFixed(4);
}

const inFlight = new Set<string>();
const pairedSideCaptureInFlight = new Set<string>();
const pairedSideLastCaptureMs = new Map<string, number>();
type Eth30OrderbookCapture = typeof captureOrderbook;
let _eth30OrderbookCaptureForTesting: Eth30OrderbookCapture | null = null;
let _eth30HaltProbeForTesting: (() => boolean) | null = null;
let _eth30InvestmentProbeForTesting: ((ticker: string) => ReturnType<typeof allowNewInvestment>) | null = null;
function captureEth30Orderbook(...args: Parameters<Eth30OrderbookCapture>): ReturnType<Eth30OrderbookCapture> {
  return (_eth30OrderbookCaptureForTesting ?? captureOrderbook)(...args);
}
function eth30IsTradingHalted(): boolean { return (_eth30HaltProbeForTesting ?? isTradingHalted)(); }
function eth30AllowNewInvestment(ticker: string): ReturnType<typeof allowNewInvestment> {
  return (_eth30InvestmentProbeForTesting ?? allowNewInvestment)(ticker);
}

function isEth30PairedHighEntry(order: realStore.Eth30StrategyOrder): boolean {
  return order.role === "entry"
    && new RegExp(`^entry:${order.ticker}:(yes|no)$`).test(order.id)
    && isPaired30HighLeg(order.limitPriceCents);
}

function eth30SideNeedsTarget(orders: readonly realStore.Eth30StrategyOrder[], side: "yes" | "no"): boolean {
  const filledEntry = orders.find((order) => order.role === "entry" && order.side === side && (order.filledContracts ?? 0) > 0);
  return !filledEntry || !isEth30PairedHighEntry(filledEntry);
}

/** Durable settlement-hold classification used by the global ETH protective
 * exit monitor. It applies only while the paired high child still has owned
 * quantity, so ordinary ETH positions retain their normal protection. */
export async function isEth30PairedHighLegSettlementHold(ticker: string, heldSide: "yes" | "no"): Promise<boolean> {
  try {
    const orders = await db().listEth30StrategyOrders(ticker);
    return computeEth30OwnedQuantityForSide(orders, heldSide) > 0
      && orders.some((order) =>
        order.side === heldSide && isEth30PairedHighEntry(order) && (order.filledContracts ?? 0) > 0,
      );
  } catch (err) {
    logger.warn({ err, ticker, heldSide }, "ETH_30_50 settlement-hold lookup failed; retaining normal protective-exit behavior");
    return false;
  }
}

/**
 * Safe recompute of the currently owned contract quantity from the durable
 * strategy-order rows: entry fills minus exit fills, floored at zero. This is
 * the single source of truth for target-exit sizing — the append-only event
 * ledger is an audit trail, not the quantity authority.
 */
export function computeEth30OwnedQuantity(orders: readonly realStore.Eth30StrategyOrder[]): number {
  let bought = 0;
  let sold = 0;
  for (const order of orders) {
    const filled = Math.max(0, order.filledContracts ?? 0);
    if (order.role === "entry") bought += filled;
    else sold += filled;
  }
  return Math.max(0, bought - sold);
}

/** Side-scoped quantity is required once a market can hold both outcomes. */
export function computeEth30OwnedQuantityForSide(
  orders: readonly realStore.Eth30StrategyOrder[], side: "yes" | "no",
): number {
  return computeEth30OwnedQuantity(orders.filter((order) => order.side === side));
}

/**
 * Exit outcomes that must block a replacement target. "unresolved" marks a
 * submission whose exchange acceptance is unknown (transport failure or a
 * success response with no order id): the order may be resting on the
 * exchange with no durable link to reconcile or cancel, so it is treated as
 * fully resting until resolved manually — never post beside it.
 */
export const ETH30_BLOCKING_EXIT_OUTCOMES = ["pending", "partial_fill", "unresolved"] as const;

/**
 * In-memory index of tickers with an open resting 50¢ target and the held
 * side. Used only for passive first-executable-50¢ evidence recording; a
 * server restart loses it until `recoverEth30Targets` repopulates it.
 */
const openTargets = new Map<string, "yes" | "no">();

/**
 * Target-liquidity observer (pure observability): while a 50¢ target rests
 * and the held side's best bid is at/above 50¢, persists throttled snapshots
 * of the executable bid depth at/above the target plus the target order's
 * durable identity, resting size, and exchange status. Never affects trading.
 */
const targetLiquidityObserver = createTargetLiquidityObserver({
  strategy: "ETH_30_50",
  targetCents: ETH30_TARGET_CENTS,
  listOrders: async (ticker) => (await db().listEth30StrategyOrders(ticker)).map((o) => ({
    id: o.id, role: o.role, outcome: o.outcome, kalshiOrderId: o.kalshiOrderId,
    requestedContracts: o.requestedContracts, filledContracts: o.filledContracts,
    createdAtMs: o.createdAtMs ?? null,
  })),
  fetchOrderbookRaw: (ticker) => kalshiFetch<KalshiOrderbookRaw>(`/markets/${encodeURIComponent(ticker)}/orderbook`),
  fetchOrderStatus: async (kalshiOrderId) => {
    const raw = await kfetch()<Record<string, unknown>>(
      "GET", `/portfolio/events/orders/${encodeURIComponent(kalshiOrderId)}`);
    return parseKalshiOrderResponse(raw, 0).orderStatus ?? null;
  },
  insertSnapshot: (params) => realStore.insertTargetLiquiditySnapshot(params),
  easternDate: (nowMs) => easternDay(new Date(nowMs)),
  onCaptureError: (err, ticker) => logger.warn({ err, ticker },
    "eth30: target-liquidity snapshot capture failed (observability only — trading unaffected)"),
});

/** Test-only accessor for the target-liquidity observer arm state. */
export function _isEth30TargetLiquidityArmedForTesting(ticker: string): boolean {
  return targetLiquidityObserver.isArmed(ticker);
}

/** Fire-and-forget decision/skip evidence; never blocks the trading path. */
function recordDecision(
  ticker: string, decision: string, extra: {
    id?: string; side?: "yes" | "no" | null; priceCents?: number | null;
    contracts?: number | null; note?: string | null;
  } = {},
): void {
  const now = Date.now();
  void db().appendEth30DecisionEvent({
    id: extra.id ?? `${ticker}:${decision}:${now}:${randomUUID().slice(0, 8)}`,
    ticker, easternDate: easternDay(new Date(now)), decision,
    side: extra.side ?? null, priceCents: extra.priceCents ?? null,
    contracts: extra.contracts ?? null, note: extra.note ?? null, occurredAtMs: now,
  }).catch(() => { /* audit-only */ });
}

/**
 * Passive evidence: record (once per ticker, via stable PK) the first moment
 * the resting 50¢ target became executable — held side's best bid ≥ 50¢.
 */
function observeTargetExecutability(state: Eth30MarketState): void {
  const side = openTargets.get(state.ticker);
  if (!side) return;
  const bid = side === "yes" ? state.yesBid : state.noBid;
  if (bid == null || bid < ETH30_TARGET_CENTS) return;
  openTargets.delete(state.ticker);
  recordDecision(state.ticker, "target_first_executable", {
    id: `${state.ticker}:target_first_executable`, side, priceCents: bid,
    note: `held-${side} best bid ${bid}¢ ≥ ${ETH30_TARGET_CENTS}¢ target`,
  });
}

/**
 * Read-only 21–25¢ prospective cohort hook. Candidate selection deliberately
 * mirrors the live strategy's YES-then-NO L2 candidate order and executable
 * depth check, but never claims or submits anything.
 */
async function observeEth2125Prospective(state: Eth30MarketState): Promise<void> {
  await observeEth2125ProspectiveTarget(state.ticker, state.bidUpdatedMs, state.yesBid, state.noBid, {
    fetchOrderbookRaw: (ticker) => kalshiFetch<KalshiOrderbookRaw>(`/markets/${encodeURIComponent(ticker)}/orderbook`),
    insertSnapshot: (params) => realStore.insertTargetLiquiditySnapshot(params),
  });
  if (!isEth30Ticker(state.ticker) || !isEth30OpeningWindow(state.openTime, state.bidUpdatedMs)) return;
  for (const side of ["yes", "no"] as const) {
    const book = await captureEth30Orderbook(state.ticker, side, ETH30_ENTRY_CAP_CENTS);
    const price = book.lowestLevelCents;
    const liveStyleContracts = price == null ? 0
      : contractsForEth30Capacity(ETH30_PRINCIPAL_CAP_CENTS, price, book.lowestLevelContractsApprox ?? 0);
    if (book.error || price == null || liveStyleContracts <= 0) continue;
    // The first valid executable live-style candidate decides the cohort.
    if (price >= 21 && price <= 25) {
      await recordEth2125ProspectiveCandidate({
        ticker: state.ticker, observedAtMs: state.bidUpdatedMs, side, priceCents: price,
        depthContracts: book.depthAtOrBetterContracts,
      });
    }
    return;
  }
}

/** Capability-checked bridge to the isolated passive shadow recorder. Minimal
 * unit-test stores intentionally lack these methods; the live store has them.
 * No missing/failing telemetry capability is allowed to affect strategy flow. */
function shadowStore(): Eth30ShadowStore | null {
  const candidate = db() as Partial<Eth30ShadowStore>;
  return typeof candidate.listEth30ShadowObservations === "function"
    && typeof candidate.listEth30ShadowEvents === "function"
    && typeof candidate.insertEth30ShadowObservation === "function"
    && typeof candidate.upsertEth30ShadowEvent === "function"
    ? candidate as Eth30ShadowStore : null;
}
async function observeEth30Shadow(state: Eth30MarketState): Promise<void> {
  const store = shadowStore();
  if (!store) return;
  await observeEth30ShadowTelemetry({
    store,
    getEthReference: async (observedAtMs) => {
      const snapshot = await getKrakenPrices(observedAtMs);
      return { price: snapshot.eth, sourceTimestampMs: snapshot.sourceTimestampMs };
    },
    fetchOrderbookRaw: (ticker) => kalshiFetch<KalshiOrderbookRaw>(`/markets/${encodeURIComponent(ticker)}/orderbook`),
  }, { ticker: state.ticker, closeTime: state.closeTime, observedAtMs: state.bidUpdatedMs, yesBid: state.yesBid, noBid: state.noBid });
}
/**
 * Bounded passive paired-book observer. It runs before *all* entry/gate checks
 * and receives its own receipt timestamp after both independently fetched L2
 * books are available. The BBO update timestamp is retained only as source
 * provenance; it never determines dedupe or lead/lag ordering.
 */
async function observePairedSideBooks(state: Eth30MarketState): Promise<void> {
  if (!isEth30Ticker(state.ticker) || pairedSideCaptureInFlight.has(state.ticker)) return;
  const now = Date.now();
  if ((pairedSideLastCaptureMs.get(state.ticker) ?? 0) > now - 5_000) return;
  pairedSideCaptureInFlight.add(state.ticker);
  try {
    const [yesBook, noBook] = await Promise.all([
      captureEth30Orderbook(state.ticker, "yes", 100),
      captureEth30Orderbook(state.ticker, "no", 100),
    ]);
    const receiptTimestampMs = Date.now();
    pairedSideLastCaptureMs.set(state.ticker, receiptTimestampMs);
    const store = shadowStore();
    if (!store) return;
    await observePairedSideShadow(store, {
      ticker: state.ticker, observedAtMs: receiptTimestampMs, sourceTimestampMs: state.bidUpdatedMs,
      yes: { priceCents: yesBook.lowestLevelCents, depthContracts: Math.max(0, Math.floor(yesBook.lowestLevelContractsApprox ?? 0)) },
      no: { priceCents: noBook.lowestLevelCents, depthContracts: Math.max(0, Math.floor(noBook.lowestLevelContractsApprox ?? 0)) },
    });
  } finally {
    pairedSideCaptureInFlight.delete(state.ticker);
  }
}

async function submitEth30PairedLeg(
  ticker: string, date: string, leg: Paired30Leg, clientOrderId: string, id: string,
): Promise<"filled" | "zero" | "unresolved"> {
  try {
    const raw = await kfetch()<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker, client_order_id: clientOrderId, side: outcomeBookSide(leg.side),
      count: `${leg.contracts}.00`, price: bookPrice(leg.side, leg.priceCents),
      time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross",
    });
    const ack = parseKalshiOrderResponse(raw, leg.contracts);
    if (!ack.rejectReason && !ack.kalshiOrderId) {
      await db().updateEth30StrategyOrder({ id, outcome: "unresolved" });
      return "unresolved";
    }
    const filled = Math.max(0, Math.min(leg.contracts, Math.trunc(ack.fillCount)));
    await db().updateEth30StrategyOrder({
      id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
      averageFillPriceCents: filled > 0 ? leg.priceCents : null,
      outcome: ack.rejectReason ? "error" : filled === 0 ? "zero_fill" : filled === leg.contracts ? "full_fill" : "partial_fill",
    });
    if (filled <= 0) return "zero";
    // These follow-up operations must not rewrite a known exchange acceptance
    // as "unresolved". The order id/fill state is already durable and restart
    // reconciliation can safely retry the missing evidence/target work.
    try {
      await syncTickerFillEvidence(ticker);
       // The 70–80¢ paired leg is a settlement hold. Only the 20–30¢ leg
       // receives the ordinary 50¢ target.
       if (!isPaired30HighLeg(leg.priceCents)) await ensureEth30TargetExit(ticker, leg.side, filled, date);
    } catch (err) {
      logger.error({ err, ticker, side: leg.side, orderId: ack.kalshiOrderId },
        "ETH_30_50 paired leg accepted but post-ack evidence/target work failed; known order remains recoverable");
    }
    return "filled";
  } catch (err) {
    await db().updateEth30StrategyOrder({ id, outcome: "unresolved" });
    logger.error({ err, ticker, side: leg.side }, "ETH_30_50 paired IOC outcome unknown — keeping reservation fail closed");
    return "unresolved";
  }
}

/** Returns true once a complementary pair has been detected, even if its
 * reservation/freshness checks fail: legacy single-side fallback must never
 * turn a failed pair attempt into a different market exposure. */
async function tryEth30PairedEntry(state: Eth30MarketState): Promise<boolean> {
  const initial = await Promise.all((["yes", "no"] as const).map(async (side) => {
    const book = await captureEth30Orderbook(state.ticker, side, 100);
    return { side, book, price: book.lowestLevelCents, depth: Math.max(0, Math.floor(book.lowestLevelContractsApprox ?? 0)) };
  }));
  const yes = initial[0]!, no = initial[1]!;
  if (yes.book.error || no.book.error) return false;
  const plan = planPaired30Entry(yes.price, yes.depth, no.price, no.depth);
  if (!plan) return false;

  const date = easternDay(new Date());
  const clientOrderIds = { yes: `eth30-pair-${randomUUID()}:yes`, no: `eth30-pair-${randomUUID()}:no` };
  // The permanent ticker claim is the durable market-level reservation. Both
  // child rows are written before any exchange POST, so restart recovery knows
  // the complete intended pair and blocks a duplicate market entry.
  const ids = { yes: `entry:${state.ticker}:yes`, no: `entry:${state.ticker}:no` };
  const pairOrders = [
    { id: ids.yes, ticker: state.ticker, easternDate: date, role: "entry" as const, sequenceNumber: 0,
      clientOrderId: clientOrderIds.yes, side: "yes" as const, limitPriceCents: plan.yes.priceCents, requestedContracts: plan.yes.contracts },
    { id: ids.no, ticker: state.ticker, easternDate: date, role: "entry" as const, sequenceNumber: 0,
      clientOrderId: clientOrderIds.no, side: "no" as const, limitPriceCents: plan.no.priceCents, requestedContracts: plan.no.contracts },
  ] as const;
  if (!await (db().reserveEth30PairedEntry?.({ ticker: state.ticker, easternDate: date, entryClientOrderId: clientOrderIds.yes, orders: pairOrders }) ?? Promise.resolve(false))) {
    recordDecision(state.ticker, "paired_reservation_failed", { note: "durable pair reservation incomplete; no exchange POST" });
    return true;
  }
  // Fresh L2 recheck immediately before submission; prices and depth must still
  // support the exact bounded pair rather than relying on the discovery books.
  const fresh = await Promise.all((["yes", "no"] as const).map(async (side) => {
    const book = await captureEth30Orderbook(state.ticker, side, 100);
    return { side, price: book.lowestLevelCents, depth: Math.max(0, Math.floor(book.lowestLevelContractsApprox ?? 0)), error: book.error };
  }));
  const refreshed = !fresh[0]!.error && !fresh[1]!.error
    ? planPaired30Entry(fresh[0]!.price, fresh[0]!.depth, fresh[1]!.price, fresh[1]!.depth) : null;
  if (!refreshed || refreshed.yes.priceCents !== plan.yes.priceCents || refreshed.no.priceCents !== plan.no.priceCents
    || refreshed.yes.contracts < plan.yes.contracts || refreshed.no.contracts < plan.no.contracts) {
    await Promise.all([db().updateEth30StrategyOrder({ id: ids.yes, outcome: "error" }), db().updateEth30StrategyOrder({ id: ids.no, outcome: "error" })]);
    recordDecision(state.ticker, "paired_freshness_failed", { note: "paired reservation retained; L2 changed before exchange POST" });
    return true;
  }
  const first = await submitEth30PairedLeg(state.ticker, date, plan.yes, clientOrderIds.yes, ids.yes);
  if (first !== "filled") {
    await db().updateEth30StrategyOrder({ id: ids.no, outcome: "error" });
    recordDecision(state.ticker, "paired_second_leg_blocked", { side: "yes", note: `YES ${first}; NO was not submitted` });
    return true;
  }
  const second = await submitEth30PairedLeg(state.ticker, date, plan.no, clientOrderIds.no, ids.no);
  recordDecision(state.ticker, "paired_entry_completed", {
    note: JSON.stringify({ yes: plan.yes, no: plan.no, secondOutcome: second, totalPrincipalCents: plan.yes.contracts * plan.yes.priceCents + plan.no.contracts * plan.no.priceCents }),
  });
  return true;
}

/**
 * Owner-directed test variant of the complementary pair. It preserves the
 * pair's two-sided signal validation and per-side $1 cap, but submits only the
 * 70–80¢ child. It never reserves, posts, or targets the 20–30¢ child.
 */
async function tryEth30HighLegOnlyEntry(state: Eth30MarketState): Promise<boolean> {
  const capturePair = async () => {
    const books = await Promise.all((["yes", "no"] as const).map(async (side) => {
      const book = await captureEth30Orderbook(state.ticker, side, 100);
      return { side, book, price: book.lowestLevelCents, depth: Math.max(0, Math.floor(book.lowestLevelContractsApprox ?? 0)) };
    }));
    return books;
  };
  const initial = await capturePair();
  if (initial[0]!.book.error || initial[1]!.book.error) return false;
  const plan = planPaired30Entry(initial[0]!.price, initial[0]!.depth, initial[1]!.price, initial[1]!.depth);
  if (!plan) return false;
  const high = isPaired30HighLeg(plan.yes.priceCents) ? plan.yes : plan.no;
  const date = easternDay(new Date());
  const clientOrderId = `eth30-high-only-${randomUUID()}`;
  const id = `entry:${state.ticker}:${high.side}`;
  if (!await db().claimEth30Ticker(state.ticker, date, clientOrderId)) {
    recordDecision(state.ticker, "high_leg_test_claim_conflict", {
      id: `${state.ticker}:high_leg_test_claim_conflict`,
      side: high.side, priceCents: high.priceCents, contracts: high.contracts,
      note: "high-leg-only candidate found but ticker already claimed (or storage degraded)",
    });
    return true;
  }
  if (!await db().recordEth30StrategyOrder({
    id, ticker: state.ticker, easternDate: date, role: "entry", sequenceNumber: 0,
    clientOrderId, side: high.side, limitPriceCents: high.priceCents, requestedContracts: high.contracts,
  })) return true;

  const fresh = await capturePair();
  const refreshed = !fresh[0]!.book.error && !fresh[1]!.book.error
    ? planPaired30Entry(fresh[0]!.price, fresh[0]!.depth, fresh[1]!.price, fresh[1]!.depth) : null;
  const refreshedHigh = refreshed && (isPaired30HighLeg(refreshed.yes.priceCents) ? refreshed.yes : refreshed.no);
  if (!refreshedHigh || refreshedHigh.side !== high.side || refreshedHigh.priceCents !== high.priceCents
    || refreshedHigh.contracts < high.contracts) {
    await db().updateEth30StrategyOrder({ id, outcome: "error" });
    recordDecision(state.ticker, "high_leg_test_freshness_failed", {
      side: high.side, priceCents: high.priceCents, contracts: high.contracts,
      note: "high-leg-only reservation retained; complementary L2 changed before exchange POST",
    });
    return true;
  }
  const outcome = await submitEth30PairedLeg(state.ticker, date, high, clientOrderId, id);
  recordDecision(state.ticker, "high_leg_test_entry_completed", {
    side: high.side, priceCents: high.priceCents, contracts: high.contracts,
    note: `70–80¢ only; outcome=${outcome}; complementary 20–30¢ leg intentionally not submitted`,
  });
  return true;
}

async function refreshEth30Shadow(ticker: string): Promise<void> {
  const store = shadowStore();
  if (store) await Promise.all([
    refreshEth30ShadowOutcomes(store, ticker),
    refreshPairedSideSettlementOutcomes(store, ticker),
  ]);
}

/** Called from the shared evaluator after the legacy evaluation; never alters it. */
export async function evaluateEth30(state: Eth30MarketState): Promise<void> {
  if (!isEth30Ticker(state.ticker)) return;
  const highOnlyMode = highLegOnlyTestEnabled();
  observeTargetExecutability(state);
  // Independent passive research recorder. Its failure never blocks or changes
  // the live ETH strategy, and it has no order/claim mutation capabilities.
  void observeEth2125Prospective(state).catch((err) => logger.warn({ err, ticker: state.ticker }, "eth2125 prospective observer failed"));
  // Research-only causal evidence. The promise is deliberately detached before
  // the live gate, and any failure is explicitly non-blocking.
  void observeEth30Shadow(state).catch((err) => logger.warn({ err, ticker: state.ticker }, "eth30 shadow telemetry failed"));
  void observePairedSideBooks(state).catch((err) => logger.warn({ err, ticker: state.ticker }, "paired-side shadow capture failed (research only)"));
  targetLiquidityObserver.observe(state.ticker, { yesBid: state.yesBid, noBid: state.noBid });
  if (!isEth30OpeningWindow(state.openTime)) return;
  // This is a new-entry strategy, so it shares the global non-negotiable halt
  // and daily-loss gate. It must never make the feature-specific env flag a
  // bypass around a production kill switch.
  const investmentGuard = await eth30AllowNewInvestment(state.ticker);
  if (!mayEnterEth30(liveEnabled(), eth30IsTradingHalted(), investmentGuard.allowed)) {
    // Once-per-ticker evidence (stable id) of why an eligible window was skipped.
    // Only recorded when the strategy is enabled — a disabled flag would
    // otherwise write a row for every ETH window forever.
    if (liveEnabled()) {
      recordDecision(state.ticker, "gate_blocked", {
        id: `${state.ticker}:gate_blocked`,
          note: eth30IsTradingHalted()
            ? "global_halt"
            : `daily_investment_guard:${investmentGuard.status.state}${investmentGuard.status.reason ? `:${investmentGuard.status.reason}` : ""}`,
      });
    }
    return;
  }
  if (inFlight.has(state.ticker)) return;
  inFlight.add(state.ticker);
  try {
    if (highOnlyMode) {
      // Do not permit a new high-leg test order until any existing 50¢ target
      // owned by this strategy has been conclusively cancelled. This is
      // intentionally fail-closed: a target with ambiguous cancellation can
      // still fill, so it is unsafe to claim the requested settlement hold.
      if (!highOnlyTargetsSuspended) {
        highOnlyTargetsSuspended = await recoverEth30Targets();
      }
      if (!highOnlyTargetsSuspended) {
        recordDecision(state.ticker, "high_leg_test_target_cancellation_blocked", {
          id: `${state.ticker}:high_leg_test_target_cancellation_blocked`,
          note: "70–80¢ test mode blocked: an existing 50¢ target could not be conclusively cancelled",
        });
        return;
      }
      if (await tryEth30HighLegOnlyEntry(state)) return;
      recordDecision(state.ticker, "high_leg_test_no_eligible_pair", {
        id: `${state.ticker}:high_leg_test_no_eligible_pair`,
        note: "70–80¢ test mode: no complementary 20–30¢ / 70–80¢ L2 pair; no order submitted",
      });
      return;
    }
    if (await tryEth30PairedEntry(state)) return;
    // Claim only after an executable L2 candidate exists.  The claim is
    // permanent even if the ensuing IOC fills zero: first executable side wins.
    const candidates: Array<"yes" | "no"> = ["yes", "no"];
    for (const side of candidates) {
      // Capture the whole executable side so an out-of-band first price is
      // auditable. The resulting IOC remains limited to the selected price.
      const book = await captureEth30Orderbook(state.ticker, side, 100);
      const price = book.lowestLevelCents;
      if (book.error || price == null) continue;
      const principalCap = eth30PrincipalCapForEntryPrice(price);
      const availableDepth = Math.max(0, Math.floor(book.lowestLevelContractsApprox ?? 0));
      const count = principalCap === null ? 0 : contractsForEth30Capacity(principalCap, price, availableDepth);
      const bucket = eth30EntryPriceBucket(price);
      if (principalCap === null) {
        recordDecision(state.ticker, "entry_rejected_price_band", {
          id: `${state.ticker}:entry_candidate`,
          side, priceCents: price, contracts: 0,
          note: JSON.stringify({
            priceBucket: bucket,
            eligible: false,
            rejectionReason: "outside_23_28_live_band",
            principalCapCents: 0,
            calculatedContracts: 0,
            availableL2Contracts: availableDepth,
          }),
        });
        // First executable side wins even when the approved band rejects it:
        // do not skip a rejected YES candidate and trade NO instead.
        return;
      }
      if (count <= 0) {
        recordDecision(state.ticker, "entry_no_executable_depth", {
          id: `${state.ticker}:entry_candidate:${side}:no_depth`,
          side, priceCents: price, contracts: 0,
          note: JSON.stringify({
            priceBucket: bucket,
            eligible: true,
            rejectionReason: "no_immediately_executable_depth",
            principalCapCents: principalCap,
            calculatedContracts: 0,
            availableL2Contracts: availableDepth,
          }),
        });
        // This quote is in the approved price band but does not have an
        // executable quantity. It is not the first executable side.
        continue;
      }
      recordDecision(state.ticker, "entry_candidate_eligible", {
        id: `${state.ticker}:entry_candidate`,
        side, priceCents: price, contracts: count,
        note: JSON.stringify({
          priceBucket: bucket,
          eligible: true,
          rejectionReason: null,
          principalCapCents: principalCap,
          calculatedContracts: count,
          availableL2Contracts: availableDepth,
        }),
      });
      const clientOrderId = `eth30-entry-${randomUUID()}`;
      const date = easternDay(new Date());
      if (!await db().claimEth30Ticker(state.ticker, date, clientOrderId)) {
        recordDecision(state.ticker, "claim_conflict", {
          id: `${state.ticker}:claim_conflict`, side, priceCents: price, contracts: count,
          note: "executable candidate found but ticker already claimed (or storage degraded)",
        });
        return;
      }
      const id = `entry:${state.ticker}`;
      if (!await db().recordEth30StrategyOrder({
        id, ticker: state.ticker, easternDate: date, role: "entry", sequenceNumber: 0,
        clientOrderId, side, limitPriceCents: price, requestedContracts: count,
      })) return;
      try {
        const raw = await kfetch()<Record<string, unknown>>("POST", "/portfolio/events/orders", {
          ticker: state.ticker, client_order_id: clientOrderId, side: outcomeBookSide(side),
          count: `${count}.00`, price: bookPrice(side, price), time_in_force: "immediate_or_cancel",
          self_trade_prevention_type: "taker_at_cross",
        });
        const ack = parseKalshiOrderResponse(raw, count);
        const filled = Math.max(0, Math.min(count, Math.trunc(ack.fillCount)));
        await db().updateEth30StrategyOrder({ id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
          averageFillPriceCents: filled > 0 ? price : null, outcome: ack.rejectReason ? "error" : filled === 0 ? "zero_fill" : filled === count ? "full_fill" : "partial_fill" });
        recordDecision(state.ticker,
          ack.rejectReason ? "entry_error" : filled === 0 ? "entry_zero_fill" : "entry_placed",
          { id: `${state.ticker}:entry_outcome`, side, priceCents: price, contracts: filled,
            note: ack.rejectReason ?? `requested ${count}, filled ${filled} (IOC)` });
        if (filled > 0) {
          // Fill evidence comes from the authoritative per-chunk fills
          // endpoint — an IOC can sweep multiple L2 levels, so recording the
          // scanned book price for every contract would be inexact. If the
          // fetch fails here, reconciliation retries and settlement is gated
          // until chunk evidence is complete.
          await syncTickerFillEvidence(state.ticker);
          await ensureEth30TargetExit(state.ticker, side, filled, date);
        }
      } catch (err) {
        await db().updateEth30StrategyOrder({ id, outcome: "error" });
        recordDecision(state.ticker, "entry_error", {
          id: `${state.ticker}:entry_outcome`, side, priceCents: price, contracts: 0,
          note: "entry transport error; permanent claim prevents re-entry",
        });
        logger.error({ err, ticker: state.ticker }, "ETH_30_50 entry transport error; permanent claim prevents re-entry");
      }
      return;
    }
    // Both sides scanned inside an eligible window without an executable price
    // candidate. Stable id ⇒ at most one skip row per ticker, so the ledger
    // candidate. Stable id ⇒ at most one skip row per ticker, so the ledger
    // stays bounded even though ticks arrive continuously.
    recordDecision(state.ticker, "no_executable_candidate", {
      id: `${state.ticker}:no_executable_candidate`,
      note: `no executable L2 level found on yes or no`,
    });
  } finally { inFlight.delete(state.ticker); }
}

/**
 * Cancel a strategy-owned resting order via its durable exchange order id.
 * Returns true only when the exchange confirmed the cancel (any terminal fill
 * count in the cancel response is captured before the row is closed out).
 * On failure the row stays non-terminal and the caller MUST NOT post a
 * replacement — an unconfirmed resting order plus a new one could oversell.
 */
/**
 * Extract an explicit, VALID fill count from a raw exchange order response.
 * Returns the whole-contract count, or null when the field is absent,
 * non-numeric, negative, non-integer, or non-finite — any of which means the
 * quantity is ambiguous and callers must fail closed rather than trust 0.
 */
function explicitFillCountFromResponse(raw: Record<string, unknown> | undefined): number | null {
  const orderData = (raw?.["order"] ?? raw) as Record<string, unknown> | undefined;
  if (orderData == null) return null;
  const value = orderData["fill_count_fp"] ?? orderData["fill_count"];
  if (value == null) return null;
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num) || num < 0) return null;
  const whole = Math.trunc(num);
  // fill_count_fp is a decimal string like "3.00"; a fractional contract
  // count is malformed — fail closed.
  if (Math.abs(num - whole) > 1e-9) return null;
  return whole;
}
async function cancelEth30Order(order: realStore.Eth30StrategyOrder): Promise<boolean> {
  if (!order.kalshiOrderId) return false;
  try {
    const raw = await kfetch()<Record<string, unknown>>(
      "DELETE", `/portfolio/events/orders/${encodeURIComponent(order.kalshiOrderId)}`);
    const parsed = parseKalshiOrderResponse(raw, Math.max(0, order.requestedContracts - (order.filledContracts ?? 0)));
    // An HTTP-success DELETE is not a confirmed cancel: the exchange must
    // report a terminal status. A missing, unknown, or still-resting status
    // leaves the durable row pending and blocks any replacement (no oversell).
    const TERMINAL_CANCEL_STATUSES = new Set(["canceled", "cancelled", "executed", "filled"]);
    if (parsed.rejectReason || !parsed.orderStatus || !TERMINAL_CANCEL_STATUSES.has(parsed.orderStatus)) {
      logger.warn(
        { ticker: order.ticker, orderId: order.kalshiOrderId, status: parsed.orderStatus, rejectReason: parsed.rejectReason },
        "ETH_30_50 cancel not confirmed terminal by exchange — leaving order pending (fail closed)",
      );
      return false;
    }
    // The shared parser defaults an omitted fill count to 0, which would let a
    // terminal response without an explicit count fake "no fills" and cause a
    // full-size replacement beside contracts the target already sold. Require
    // the count to be explicit; for an unambiguous fully-executed status the
    // requested quantity is a safe inference — otherwise fail closed.
    const explicitFillCount = explicitFillCountFromResponse(raw);
    let reportedFillCount: number;
    if (explicitFillCount != null) {
      reportedFillCount = explicitFillCount;
    } else if (parsed.orderStatus === "executed" || parsed.orderStatus === "filled") {
      reportedFillCount = order.requestedContracts;
    } else {
      logger.warn(
        { ticker: order.ticker, orderId: order.kalshiOrderId, status: parsed.orderStatus },
        "ETH_30_50 terminal cancel response lacks an explicit fill count — leaving order pending (fail closed)",
      );
      return false;
    }
    const prior = order.filledContracts ?? 0;
    const filled = Math.min(order.requestedContracts, Math.max(prior, reportedFillCount));
    await db().updateEth30StrategyOrder({
      id: order.id, outcome: "cancelled", filledContracts: filled,
      averageFillPriceCents: filled > 0 ? (order.averageFillPriceCents ?? order.limitPriceCents) : null,
    });
    // A cancel ack can confirm fills that were never acked before; append the
    // delta so the audit ledger stays consistent with the durable order row.
    const delta = Math.max(0, filled - prior);
    if (delta > 0) {
      const sign = order.role === "exit" ? -1 : 1;
      const events = await db().listEth30PositionEvents(order.ticker);
      const before = events.at(-1)?.contractsAfter ?? 0;
      await db().appendEth30PositionEvent({
        id: `${order.ticker}:${order.role}_fill:${order.kalshiOrderId}:${filled}`,
        ticker: order.ticker, easternDate: order.easternDate,
        eventType: order.role === "exit" ? "exit_fill" : "entry_fill",
        contractsDelta: sign * delta, contractsAfter: Math.max(0, before + sign * delta),
        strategyOrderId: order.id, fillPriceCents: order.limitPriceCents, feeCents: null,
        settlementResult: null, note: "cancel_ack_fill_reconciliation", occurredAtMs: Date.now(),
      });
    }
    return true;
  } catch (err) {
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId }, "ETH_30_50 cancel of resting target failed — leaving order pending (fail closed)");
    return false;
  }
}

/**
 * Fetch authoritative fill chunks for one owned order. Returns null when the
 * endpoint failed or returned no usable chunks — the caller defers, never
 * approximates.
 */
async function fetchOwnedFillChunks(
  kalshiOrderId: string,
  side: "yes" | "no",
): Promise<AuthoritativeFillChunk[] | null> {
  try {
    const data = await kfetch()<{ fills?: KalshiFillWire[] }>(
      "GET", `/portfolio/fills?order_id=${encodeURIComponent(kalshiOrderId)}`,
    );
    const chunks = (data.fills ?? []).flatMap((wire) => {
      const normalized = normalizeKalshiFill(wire, side);
      if (!normalized || !normalized.fillId) return [];
      const ts = normalized.fillTimestamp ? Date.parse(normalized.fillTimestamp) : NaN;
      return [{
        fillId: normalized.fillId,
        contracts: normalized.contracts,
        fillPriceCents: normalized.fillPriceCents,
        // feeDollars is always a finite number when normalizeKalshiFill returns non-null
        // (the normalizer returns null when fee is absent). Convert to cents.
        feeCents: Math.round(normalized.feeDollars * 100),
        occurredAtMs: Number.isFinite(ts) ? ts : Date.now(),
      }];
    });
    return chunks.length > 0 ? chunks : null;
  } catch (err) {
    logger.warn({ err, orderId: kalshiOrderId }, "ETH_30_50 fill-chunk fetch failed; will retry on next reconciliation");
    return null;
  }
}

/**
 * Rebuild the ticker's fill-event ledger from authoritative exchange fill
 * chunks (actual per-chunk execution prices — an IOC entry can sweep multiple
 * L2 levels; a resting target can fill in pieces). Legacy approximate events
 * are deleted and replaced wholesale — never blended. If any filled order
 * lacks complete chunk coverage, nothing is written and the ticker's
 * settlement stays deferred.
 */
async function syncTickerFillEvidence(ticker: string): Promise<void> {
  const orders = await db().listEth30StrategyOrders(ticker);
  if (!orders.some((o) => (o.filledContracts ?? 0) > 0)) return;
  const events = await db().listEth30PositionEvents(ticker);
  const chunksByOrder = new Map<string, AuthoritativeFillChunk[] | null>();
  for (const order of orders) {
    if (!(order.filledContracts ?? 0)) continue;
    chunksByOrder.set(order.id,
      order.kalshiOrderId ? await fetchOwnedFillChunks(order.kalshiOrderId, order.side) : null);
  }
  const plan = planCanonicalFillLedger(orders, events, chunksByOrder);
  if (plan.deferredOrderIds.length > 0) {
    logger.warn({ ticker, deferred: plan.deferredOrderIds }, "ETH_30_50 fill evidence incomplete — canonical rebuild deferred");
    return;
  }
  // A stale local exit row may have caused settlement to close contracts that
  // Kalshi had already bought from us. Rebuild settlement alongside canonical
  // fills so it closes only the exchange-evidenced remainder.
  const settlement = events.find((ev) => ev.eventType === "settlement") ?? null;
  const ownedAfterAuthoritativeFills = computeEth30OwnedQuantity(orders);
  const rewriteSettlement = settlement != null
    && (settlement.contractsDelta !== -ownedAfterAuthoritativeFills || settlement.contractsAfter !== 0);
  const deleteIds = rewriteSettlement && settlement
    ? [...plan.deleteIds, settlement.id]
    : plan.deleteIds;
  if (deleteIds.length > 0 && !await db().deleteEth30PositionEvents(deleteIds)) return;
  for (const event of plan.appends) await db().appendEth30PositionEvent(event);
  if (rewriteSettlement && settlement) {
    await db().appendEth30PositionEvent({
      ...settlement,
      contractsDelta: -ownedAfterAuthoritativeFills,
      contractsAfter: 0,
      note: `market settled ${settlement.settlementResult}; ${ownedAfterAuthoritativeFills} owned contracts closed after exchange exit reconciliation`,
    });
  }
}

/**
 * Keeps exactly one valid owner-scoped resting 50¢ target for the remaining
 * owned quantity; it never invokes protective exits.
 *
 * Quantity discipline: the caller-supplied quantity is only an upper bound —
 * the posted size is always clamped to the owned remainder recomputed from
 * durable strategy-order rows, so a stale caller can never oversell.
 */
export async function ensureEth30TargetExit(ticker: string, side: "yes" | "no", quantity: number, date = easternDay(new Date())): Promise<void> {
  const highOnlyMode = highLegOnlyTestEnabled();
  if (!liveEnabled() || highOnlyMode || quantity <= 0) return;
  let orders = await db().listEth30StrategyOrders(ticker);
  const owned = computeEth30OwnedQuantityForSide(orders, side);
  let open = Math.min(Math.max(0, Math.trunc(quantity)), owned);
  if (open <= 0) return;

  // An unresolved submission (unknown exchange acceptance, no durable link)
  // permanently blocks replacements: it cannot be reconciled or cancelled, so
  // posting anything beside it could oversell. Requires manual intervention.
  if (orders.some((order) => order.side === side && order.role === "exit" && order.outcome === "unresolved")) {
    logger.warn({ ticker }, "ETH_30_50 unresolved target submission blocks replacement — manual intervention required");
    return;
  }

  const pendingExits = orders.filter((order) => order.side === side && isBlockingExit(order));
  const resting = computeEth30RestingExitQuantity(orders, side);
  // Exactly one resting target whose remaining size equals the owned remainder:
  // nothing to do — this is the no-churn fast path used on every restart.
  // Keep first-executable-50¢ observation armed (the in-memory index is lost
  // on restart).
  if (pendingExits.length === 1 && resting === open) {
    openTargets.set(ticker, side);
    targetLiquidityObserver.arm(ticker, side);
    return;
  }

  if (pendingExits.length > 0) {
    // Size (or count) mismatch: cancel the stale target(s) before reposting.
    let allCancelled = true;
    for (const pending of pendingExits) {
      if (!await cancelEth30Order(pending)) allCancelled = false;
    }
    if (!allCancelled) return; // fail closed — never post beside an unconfirmed resting order
    // Cancels can race a fill; re-read the durable rows and recompute.
    orders = await db().listEth30StrategyOrders(ticker);
    open = Math.min(Math.max(0, Math.trunc(quantity)), computeEth30OwnedQuantityForSide(orders, side));
    if (open <= 0) return;
  }

  const sequence = orders.filter((order) => order.role === "exit").length + 1;
  const id = `exit:${ticker}:${side}:${sequence}`;
  const clientOrderId = `eth30-exit-${randomUUID()}`;
  if (!await db().recordEth30StrategyOrder({ id, ticker, easternDate: date, role: "exit", sequenceNumber: sequence,
    clientOrderId, side, limitPriceCents: ETH30_TARGET_CENTS, requestedContracts: open })) return;
  try {
    // Kalshi expresses a NO position as the complement of YES. To close a held
    // YES, offer YES (ask); to close a held NO, bid YES. Sending an ask for a
    // held NO opens/acquires NO instead of closing it, and can execute at the
    // current NO price rather than rest at the target.
    const exitSide = side === "yes" ? "ask" : "bid";
    const raw = await kfetch()<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker, client_order_id: clientOrderId, side: exitSide, count: `${open}.00`,
      price: (ETH30_TARGET_CENTS / 100).toFixed(4), time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
    });
    const ack = parseKalshiOrderResponse(raw, open);
    if (!ack.rejectReason && !ack.kalshiOrderId) {
      // Accepted-looking response with no exchange order id: the order may be
      // resting but there is no durable link to reconcile or cancel it.
      // Fail closed — block any future replacement until resolved manually.
      await db().updateEth30StrategyOrder({ id, outcome: "unresolved" });
      logger.error({ ticker, clientOrderId }, "ETH_30_50 target response carried no order id — marked unresolved (blocks replacements)");
      return;
    }
    const filled = Math.max(0, Math.min(open, Math.trunc(ack.fillCount)));
    await db().updateEth30StrategyOrder({ id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
      averageFillPriceCents: filled > 0 ? ETH30_TARGET_CENTS : null, outcome: ack.rejectReason ? "error" : filled === open ? "full_fill" : "pending" });
    // Arm passive first-executable-50¢ observation while the target rests.
    if (!ack.rejectReason && filled < open) {
      openTargets.set(ticker, side);
      targetLiquidityObserver.arm(ticker, side);
    }
    if (filled > 0) {
      await db().appendEth30PositionEvent({
        id: `${ticker}:exit_fill:${ack.kalshiOrderId ?? clientOrderId}:initial`, ticker, easternDate: date,
        eventType: "exit_fill", contractsDelta: -filled, contractsAfter: Math.max(0, open - filled),
        strategyOrderId: id, fillPriceCents: ETH30_TARGET_CENTS, feeCents: null, settlementResult: null,
        note: "target_order_ack", occurredAtMs: Date.now(),
      });
      // Replace the approximate ack event with authoritative per-chunk
      // evidence when available (canonical rebuild is idempotent).
      await syncTickerFillEvidence(ticker);
    }
  } catch (err) {
    // Transport ambiguity: Kalshi may have accepted the GTC ask even though
    // the response was lost. Mark unresolved (NOT error) so recovery treats
    // the possible resting order as blocking and never posts a replacement.
    await db().updateEth30StrategyOrder({ id, outcome: "unresolved" });
    logger.error({ err, ticker }, "ETH_30_50 target submission outcome unknown — marked unresolved (blocks replacements)");
  }
}

/**
 * Pre-populate the in-memory `_settledTickers` cache from SQL with a single
 * query. Called at startup (from recoverEth30Targets) so the first periodic
 * sweep incurs zero per-ticker SQL reads for already-settled markets, making
 * the cold-start sweep as cheap as any subsequent sweep regardless of how many
 * positions have settled over the server's lifetime.
 *
 * Also exported so callers that initialise the strategy without calling
 * recoverEth30Targets (e.g. production paths where liveEnabled() is false but
 * the reconciliation sweep still runs) can warm the cache independently.
 *
 * Never throws — a failed query leaves the cache empty and the sweep falls
 * back to its existing per-ticker SQL read path.
 */
export async function warmEth30SettledTickersCache(): Promise<void> {
  try {
    const settled = await db().listSettledEth30Tickers();
    for (const ticker of settled) _settledTickers.add(ticker);
    if (settled.length > 0) {
      logger.info(
        { count: settled.length },
        "ETH_30_50 settled-ticker cache warmed at startup — first sweep will skip these tickers",
      );
    }
  } catch (err) {
    logger.warn({ err }, "ETH_30_50 settled-ticker cache warmup failed — sweep will repopulate lazily");
  }
}

/** Restart-safe recovery restricted to rows durably owned by this strategy.
 * Returns false only when high-leg-only mode could not conclusively cancel a
 * target that must be held through settlement. */
export async function recoverEth30Targets(date = easternDay(sweepNow())): Promise<boolean> {
  if (!liveEnabled()) return true;
  const highOnlyMode = highLegOnlyTestEnabled();
  let highOnlyTargetsSafe = true;
  // Also check the prior Eastern date so a position entered just before midnight
  // is not missed when the server restarts shortly after the day boundary.
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  for (const claim of await db().listEth30TickerClaimsForDates([date, yesterday])) {
    // Fast path: cache hit — market settled before this restart. The trade
    // lifecycle is final, but passive settlement enrichment must still run
    // now (not wait for the five-minute periodic sweep) after a restart.
    if (_settledTickers.has(claim.ticker)) {
      void refreshEth30Shadow(claim.ticker).catch((err) =>
        logger.warn({ err, ticker: claim.ticker }, "eth30 shadow startup outcome refresh failed"));
      continue;
    }
    // Fail-closed fallback: always verify via the per-ticker event ledger for
    // any ticker not already in the cache. This preserves the original safe
    // behaviour regardless of whether the warmup query succeeded, raced with a
    // settlement write, or returned an incomplete result due to storage
    // degradation (listSettledEth30Tickers returns [] on any error, so the
    // caller cannot distinguish "no settlements" from "query failed").
    const events = await db().listEth30PositionEvents(claim.ticker);
    if (events.some((ev) => ev.eventType === "settlement")) {
      _settledTickers.add(claim.ticker); // populate for future sweeps
      void refreshEth30Shadow(claim.ticker).catch((err) =>
        logger.warn({ err, ticker: claim.ticker }, "eth30 shadow startup outcome refresh failed"));
      continue;
    }
    await reconcileEth30OwnedOrders(claim.ticker);
    // Re-read after reconciliation; stale pre-recovery rows cannot drive a
    // duplicate target or an incorrect remaining quantity.
    const orders = await db().listEth30StrategyOrders(claim.ticker);
    for (const side of ["yes", "no"] as const) {
      const open = computeEth30OwnedQuantityForSide(orders, side);
      const settlementHold = !eth30SideNeedsTarget(orders, side) || highOnlyMode;
      if (open > 0 && settlementHold) {
        // High legs always settle. During the owner-directed high-only test,
        // low-leg targets are also cancelled so existing 20–30¢ positions
        // remain held until settlement rather than selling at 50¢.
        for (const exit of orders.filter((order) => order.role === "exit" && order.side === side && isBlockingExit(order))) {
          if (!await cancelEth30Order(exit) && highOnlyMode) highOnlyTargetsSafe = false;
        }
        continue;
      }
      if (open > 0) {
        await ensureEth30TargetExit(claim.ticker, side, open, claim.easternDate);
      }
    }
  }
  return highOnlyTargetsSafe;
}

/**
 * Scan all ETH_30_50 ticker claims and emit a WARN log for any that have no
 * entry fills after STALE_NO_FILL_THRESHOLD_MS. These are orphaned claims —
 * the ticker was claimed but the IOC order returned zero fills or the exchange
 * rejected the order. Call this from a periodic watchdog or on-demand.
 *
 * Returns the list of stale tickers found (empty if none).
 */
export async function checkStaleEth30Claims(nowMs = Date.now()): Promise<string[]> {
  const claims = await db().listAllEth30TickerClaims();
  const stale: string[] = [];
  for (const claim of claims) {
    if (nowMs - claim.claimedAtMs <= STALE_NO_FILL_THRESHOLD_MS) continue;
    // Fast path: settled tickers always have entry fills and can never be stale.
    // Skip the SQL round-trip entirely — a settled market cannot un-settle.
    if (_settledTickers.has(claim.ticker)) continue;
    // Only flag claims with no entry fills.
    const events = await db().listEth30PositionEvents(claim.ticker);
    const entryFills = events.filter((ev) => ev.eventType === "entry_fill")
      .reduce((sum, ev) => sum + ev.contractsDelta, 0);
    if (entryFills > 0) continue;
    stale.push(claim.ticker);
    const ageMinutes = Math.round((nowMs - claim.claimedAtMs) / 60_000);
    logger.warn(
      { ticker: claim.ticker, easternDate: claim.easternDate, claimedAtMs: claim.claimedAtMs, ageMinutes },
      "ETH_30_50 stale no-fill claim detected — ticker claimed but never filled",
    );
  }
  return stale;
}
/**
 * Fetch per-chunk exchange fills for one strategy-owned order via its durable
 * kalshi_order_id link. Fail-closed: any chunk missing Kalshi's immutable
 * fill_id makes the whole response unusable for the ledger (null), so a
 * partial subset is never persisted. Null also on transport failure.
 */
async function fetchEth30OwnedOrderFills(order: realStore.Eth30StrategyOrder): Promise<NormalizedKalshiFill[] | null> {
  if (!order.kalshiOrderId) return null;
  try {
    const data = await kfetch()<{ fills?: KalshiFillWire[] }>(
      "GET", `/portfolio/fills?order_id=${encodeURIComponent(order.kalshiOrderId)}`);
    const fills = data.fills ?? [];
    const normalized: NormalizedKalshiFill[] = [];
    for (const fill of fills) {
      const chunk = normalizeKalshiFill(fill, order.side);
      if (!chunk || !chunk.fillId) {
        logger.warn({ ticker: order.ticker, orderId: order.kalshiOrderId },
          "ETH_30_50 fill chunk missing identity or exact economics — rejecting entire response (fail-closed)");
        return null;
      }
      normalized.push(chunk);
    }
    // Deterministic order for incremental attribution across restarts.
    normalized.sort((a, b) =>
      (a.fillTimestamp ?? "").localeCompare(b.fillTimestamp ?? "") || a.fillId!.localeCompare(b.fillId!));
    return normalized;
  } catch (err) {
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId }, "ETH_30_50 owned-order fills fetch failed");
    return null;
  }
}

/**
 * Promote a locally stale exit row from immutable Kalshi fill evidence. This
 * intentionally works for terminal local outcomes too: a settlement-time
 * "cancelled / 0" label is not authoritative and must never hide a fill.
 */
async function promoteEth30ExitFromKalshiFills(order: realStore.Eth30StrategyOrder): Promise<boolean> {
  if (order.role !== "exit" || !order.kalshiOrderId) return false;
  const chunks = await fetchEth30OwnedOrderFills(order);
  const chunkTotal = chunks?.reduce((sum, chunk) => sum + chunk.contracts, 0) ?? 0;
  const prior = order.filledContracts ?? 0;
  if (chunkTotal <= prior) return false;
  const filled = Math.min(order.requestedContracts, chunkTotal);
  const avgCents = Math.round(chunks!.reduce(
    (sum, chunk) => sum + chunk.fillPriceCents * chunk.contracts, 0,
  ) / chunkTotal);
  await db().updateEth30StrategyOrder({
    id: order.id,
    filledContracts: filled,
    averageFillPriceCents: avgCents,
    outcome: filled >= order.requestedContracts ? "full_fill" : "partial_fill",
  });
  order.filledContracts = filled;
  order.outcome = filled >= order.requestedContracts ? "full_fill" : "partial_fill";
  return true;
}

/** Loads all eth30 ownership rows from SQL and computes the strategy-only report. */
export async function buildEth30Report(): Promise<Eth30Report> {
  const claims = await db().listAllEth30TickerClaims();
  const ordersByTicker    = new Map<string, realStore.Eth30StrategyOrder[]>();
  const eventsByTicker    = new Map<string, realStore.Eth30PositionEventParams[]>();
  const decisionsByTicker = new Map<string, realStore.Eth30DecisionEventParams[]>();
  for (const claim of claims) {
    const [orders, events, decisions] = await Promise.all([
      db().listEth30StrategyOrders(claim.ticker),
      db().listEth30PositionEvents(claim.ticker),
      db().listEth30DecisionEvents(claim.ticker),
    ]);
    ordersByTicker.set(claim.ticker, orders);
    eventsByTicker.set(claim.ticker, events);
    decisionsByTicker.set(claim.ticker, decisions);
  }
  const recentDecisions = await db().listRecentEth30DecisionEvents(100);
  return computeEth30Report({ claims, ordersByTicker, eventsByTicker, decisionsByTicker, recentDecisions });
}

/**
 * Per-position target-liquidity report: classifies each claimed ticker with
 * fills as never-reached-50¢, insufficient depth, or sufficient depth while
 * the target rested unfilled. Read-only over eth30_* ledgers and the shared
 * target_liquidity_snapshots table.
 */
export async function buildEth30TargetLiquidityReport(): Promise<TargetLiquidityReport> {
  const claims = await db().listAllEth30TickerClaims();
  const allSnapshots = await realStore.listTargetLiquiditySnapshots("ETH_30_50");
  const snapshotsByTicker = new Map<string, typeof allSnapshots>();
  for (const snap of allSnapshots) {
    const list = snapshotsByTicker.get(snap.ticker) ?? [];
    list.push(snap);
    snapshotsByTicker.set(snap.ticker, list);
  }
  const inputs: TargetLiquidityPositionInput[] = [];
  for (const claim of claims) {
    const [orders, events, decisions] = await Promise.all([
      db().listEth30StrategyOrders(claim.ticker),
      db().listEth30PositionEvents(claim.ticker),
      db().listEth30DecisionEvents(claim.ticker),
    ]);
    const entry = orders.find((o) => o.role === "entry") ?? null;
    let entryContracts = 0, exitContracts = 0;
    let settled = false;
    for (const ev of events) {
      if (ev.eventType === "entry_fill" && ev.contractsDelta > 0) entryContracts += ev.contractsDelta;
      else if (ev.eventType === "exit_fill" && ev.contractsDelta < 0) exitContracts += -ev.contractsDelta;
      else if (ev.eventType === "settlement") settled = true;
    }
    const firstExec = decisions.find((d) => d.decision === "target_first_executable") ?? null;
    inputs.push({
      ticker: claim.ticker, easternDate: claim.easternDate, side: entry?.side ?? null,
      entryContracts, exitContracts,
      openContracts: computeEth30OwnedQuantity(orders),
      settled, firstExecutableAtMs: firstExec?.occurredAtMs ?? null,
      snapshots: snapshotsByTicker.get(claim.ticker) ?? [],
    });
  }
  return buildTargetLiquidityReport("ETH_30_50", ETH30_TARGET_CENTS, inputs);
}

interface KalshiMarketResult { market?: { result?: string; status?: string } }

/**
 * Settlement reconciliation for strategy-owned positions only.
 *
 * For each claimed ticker that has entry fills but no settlement event yet,
 * fetches the market result from Kalshi and — when the market has settled —
 * appends a once-only `settlement` position event closing the remaining open
 * contracts. Read-only with respect to trading behavior; safe to invoke from
 * the report path. Never throws.
 */
export async function reconcileEth30Settlements(options?: {
  /**
   * When true, skip the fee-backfill step for already-settled tickers.
   * The backfill calls syncTickerFillEvidence, which hits the exchange fills
   * endpoint — inappropriate from the periodic sweep where settled tickers
   * should generate no exchange I/O. The backfill still runs when this
   * function is called from the report/analytics path (default: false).
   */
  skipFeeBackfill?: boolean;
}): Promise<void> {
  for (const claim of await db().listAllEth30TickerClaims()) {
    try {
      // Fast path: if a prior sweep already confirmed this ticker settled and
      // we are in the periodic-sweep path (where fee backfill is explicitly
      // disabled), skip the SQL round-trip entirely — a settled market cannot
      // un-settle, so there is nothing actionable to do for this ticker.
      if (options?.skipFeeBackfill && _settledTickers.has(claim.ticker)) {
        // A detached refresh can have failed just before a restart. Keep this
        // non-trading, no-exchange-I/O enrichment retry alive even though the
        // settlement itself is permanently final.
        void refreshEth30Shadow(claim.ticker).catch((err) =>
          logger.warn({ err, ticker: claim.ticker }, "eth30 shadow outcome refresh retry failed"));
        continue;
      }

      let events = await db().listEth30PositionEvents(claim.ticker);
      if (events.some((ev) => ev.eventType === "settlement")) {
        // Ledger is finalised — no new fills or settlement will be appended.
        // Cache this ticker so future periodic sweeps skip the SQL read above.
        _settledTickers.add(claim.ticker);
        // However, canonical fill-chunk events written before the fee_cents
        // column existed have feeCents=null.  Backfill them now so the report
        // can switch to net P&L for settled positions (idempotent).
        // Skip this exchange-hitting step when called from the periodic sweep.
        if (!options?.skipFeeBackfill) {
          await reconcileEth30OwnedOrders(claim.ticker);
        }
        // Settlement may predate this process or a prior detached telemetry
        // update may have failed. Re-run the passive durable enrichment on
        // every settled-ledger visit; refresh is idempotent and never orders.
        void refreshEth30Shadow(claim.ticker).catch((err) =>
          logger.warn({ err, ticker: claim.ticker }, "eth30 shadow outcome refresh retry failed"));
        continue;
      }
      // Reconcile owned orders FIRST: a resting 50¢ target may have filled
      // while the server was running and not yet be reflected in the event
      // ledger. Settling from stale events would close out (and potentially
      // pay out) contracts that were already sold.
      await reconcileEth30OwnedOrders(claim.ticker);
      events = await db().listEth30PositionEvents(claim.ticker);
      const entered = events.filter((ev) => ev.eventType === "entry_fill")
        .reduce((sum, ev) => sum + ev.contractsDelta, 0);
      if (entered <= 0) continue;
      const orders = await db().listEth30StrategyOrders(claim.ticker);
      const readiness = settlementReadiness(orders, events);
      if (!readiness.ready) {
        logger.warn({ ticker: claim.ticker, missing: readiness.missingOrderIds },
          "ETH_30_50 settlement deferred — fill evidence incomplete for owned orders");
        continue;
      }
      const raw = await kfetch()<KalshiMarketResult>("GET", `/markets/${encodeURIComponent(claim.ticker)}`);
      const result = raw.market?.result;
      if (result !== "yes" && result !== "no") continue; // not settled yet
      openTargets.delete(claim.ticker);
      targetLiquidityObserver.disarm(claim.ticker);
      const open = readiness.openContracts;
      const settled = await db().appendEth30PositionEvent({
        id: `${claim.ticker}:settlement`, ticker: claim.ticker, easternDate: claim.easternDate,
        eventType: "settlement", contractsDelta: -open, contractsAfter: 0, strategyOrderId: null,
        fillPriceCents: null, feeCents: null, settlementResult: result,
        note: `market settled ${result}; ${open} owned contracts closed at settlement`,
        occurredAtMs: Date.now(),
      });
      // Only cache when the durable write confirmed. If storage is degraded
      // (false return), leave the ticker out so a future sweep retries the
      // settlement after storage recovers. A successfully appended settlement
      // event is permanent — the ticker is safe to skip on all future sweeps.
      if (settled) _settledTickers.add(claim.ticker);
      // Mark any still-blocking exit orders as terminal: the exchange
      // automatically cancels resting GTC orders when a market settles, so
      // there is no need to send a cancel request — just reflect the reality.
      for (const order of orders) {
        if (order.role === "exit" && (ETH30_BLOCKING_EXIT_OUTCOMES as readonly string[]).includes(order.outcome)) {
          await db().updateEth30StrategyOrder({
            id: order.id,
            outcome: "cancelled",
            filledContracts: order.filledContracts ?? 0,
            averageFillPriceCents: (order.filledContracts ?? 0) > 0
              ? (order.averageFillPriceCents ?? order.limitPriceCents)
              : null,
          });
        }
      }
      // Enrich only already-recorded shadow events. This performs no market or
      // order mutation and runs after durable settlement handling.
      void refreshEth30Shadow(claim.ticker).catch((err) =>
        logger.warn({ err, ticker: claim.ticker }, "eth30 shadow outcome refresh failed"));
    } catch (err) {
      logger.warn({ err, ticker: claim.ticker }, "ETH_30_50 settlement reconciliation failed");
    }
  }
}

/**
 * Read-only exchange reconciliation for strategy-owned orders only.
 *
 * For each non-terminal order that has a durable kalshi_order_id link, this:
 *   1. Reads the exchange order status (terminal outcome + reject/cancel).
 *   2. Reads the exchange fills for that order id and persists any not-yet
 *      recorded fill chunks to the position ledger, keyed by fill_id.
 *   3. Recomputes the filled quantity from the exchange chunks (falling back
 *      to the order-status fill count when the fills endpoint is unusable)
 *      and updates the strategy-order row — quantities are monotone and
 *      clamped to the requested size.
 *
 * It never attributes exchange activity by ticker or side, and it never
 * submits, changes, or cancels an order.
 */
/** Resolve an ambiguous IOC only when exchange fill and order-detail identity
 * both match the durable client id.  A missing/ambiguous response stays
 * unresolved forever rather than risking a foreign-order link. */
async function recoverEth30UnresolvedEntry(order: realStore.Eth30StrategyOrder): Promise<boolean> {
  try {
    const raw = await kfetch()<{ fills?: Array<Record<string, unknown>> }>(
      "GET", `/portfolio/fills?${new URLSearchParams({ ticker: order.ticker, limit: "100" })}`,
    );
    const ids = new Set((raw.fills ?? []).filter((fill) =>
      fill.market_ticker === order.ticker && fill.action === "buy" && typeof fill.order_id === "string",
    ).map((fill) => fill.order_id as string));
    if (ids.size !== 1) return false;
    const kalshiOrderId = [...ids][0]!;
    const detailRaw = await kfetch()<Record<string, unknown>>("GET", `/portfolio/orders/${encodeURIComponent(kalshiOrderId)}`);
    const detail = (detailRaw.order as Record<string, unknown> | undefined) ?? detailRaw;
    if (detail.client_order_id !== order.clientOrderId || (typeof detail.ticker === "string" && detail.ticker !== order.ticker)) return false;
    const explicit = explicitFillCountFromResponse({ order: detail });
    const parsed = parseKalshiOrderResponse({ order: detail }, order.requestedContracts);
    if (explicit == null && parsed.orderStatus !== "executed" && parsed.orderStatus !== "filled") return false;
    const filled = Math.min(order.requestedContracts, explicit ?? order.requestedContracts);
    const outcome = parsed.rejectReason ? "error" : filled === 0 ? "zero_fill"
      : filled >= order.requestedContracts ? "full_fill" : "partial_fill";
    await db().updateEth30StrategyOrder({ id: order.id, kalshiOrderId, filledContracts: filled,
      averageFillPriceCents: filled > 0 ? order.limitPriceCents : null, outcome });
    order.kalshiOrderId = kalshiOrderId;
    order.filledContracts = filled;
    order.outcome = outcome;
    return true;
  } catch (err) {
    logger.warn({ err, ticker: order.ticker, clientOrderId: order.clientOrderId },
      "ETH_30_50 unresolved entry recovery failed; keeping claim blocked");
    return false;
  }
}

export async function reconcileEth30OwnedOrders(ticker: string): Promise<void> {
  const orders = await db().listEth30StrategyOrders(ticker);
  const events = await db().listEth30PositionEvents(ticker);
  const knownEventIds = new Set(events.map((event) => event.id));
  // Running owned quantity for contracts_after on newly appended chunk events.
  let running = computeEth30OwnedQuantity(orders);

  for (const order of orders) {
    if (!order.kalshiOrderId && order.role === "entry" && order.outcome === "unresolved") {
      await recoverEth30UnresolvedEntry(order);
    }
    if (!order.kalshiOrderId) continue;
    const isPendingOrPartial = ["pending", "partial_fill"].includes(order.outcome);
    if (!isPendingOrPartial) {
      // Audit terminal exit rows too. Kalshi retains fill evidence after the
      // single-order endpoint stops serving a settled market's order details.
      await promoteEth30ExitFromKalshiFills(order);
      continue;
    }
    try {
      const raw = await kfetch()<Record<string, unknown>>("GET", `/portfolio/events/orders/${encodeURIComponent(order.kalshiOrderId)}`);
      const parsed = parseKalshiOrderResponse(raw, Math.max(0, order.requestedContracts - (order.filledContracts ?? 0)));
      const chunks = await fetchEth30OwnedOrderFills(order);
      const prior = order.filledContracts ?? 0;
      const chunkTotal = chunks?.reduce((sum, chunk) => sum + chunk.contracts, 0) ?? null;
      // Only a validated explicit count may raise the quantity — malformed or
      // absent counts contribute nothing (never NaN/negative into durable state).
      const statusTotal = explicitFillCountFromResponse(raw) ?? 0;
      // The order-status fill count is a safety floor: the fills endpoint can
      // lag behind a terminal status (e.g. a cancel ack that already reports
      // partial fills while /portfolio/fills is still empty). Quantities are
      // monotone — take the max of every durable signal, clamped to requested.
      // Chunks are used for fill-level economics/events, never to shrink.
      const filled = Math.min(order.requestedContracts, Math.max(prior, statusTotal, chunkTotal ?? 0));
      // Never terminalize a canceled order from a response that omits (or
      // malforms) the explicit fill count: the parser defaults an absent count
      // to 0, and terminal rows are never re-reconciled — a hidden partial
      // fill would become an oversell on the replacement target. A non-empty
      // fills page is NOT corroboration: the fills endpoint can lag and show
      // only a subset of the chunks that actually executed, so terminalizing
      // from a partial chunk total would understate the sold quantity just as
      // badly. Only the exchange's own validated count may close the row;
      // otherwise it stays pending (blocking any replacement).
      const explicitFillCount = explicitFillCountFromResponse(raw);
      const isCancelStatus = parsed.orderStatus === "canceled" || parsed.orderStatus === "cancelled";
      if (isCancelStatus && explicitFillCount == null) {
        logger.warn(
          { ticker, orderId: order.kalshiOrderId, status: parsed.orderStatus, chunkTotal },
          "ETH_30_50 canceled status without a validated explicit fill count — keeping row pending (fail closed)",
        );
        continue;
      }
      const avgCents = chunks && chunkTotal && chunkTotal > 0
        ? Math.round(chunks.reduce((sum, chunk) => sum + chunk.fillPriceCents * chunk.contracts, 0) / chunkTotal)
        : order.limitPriceCents;
      const terminal = parsed.rejectReason ? "error" : isCancelStatus ? "cancelled" :
        filled >= order.requestedContracts ? "full_fill" : filled > 0 ? "partial_fill" : "pending";
      await db().updateEth30StrategyOrder({ id: order.id, outcome: terminal, filledContracts: filled,
        averageFillPriceCents: filled > 0 ? avgCents : null });
      order.filledContracts = filled;
      order.outcome = terminal;

      const sign = order.role === "exit" ? -1 : 1;
      let ledgerTotalForOrder = events
        .filter((event) => event.strategyOrderId === order.id)
        .reduce((sum, event) => sum + Math.abs(event.contractsDelta), 0);
      if (chunks && chunks.length > 0) {
        // Persist incremental chunk events. Chunk contracts already recorded
        // for this order (via the submission ack or an earlier reconciliation)
        // are skipped by walking the cumulative count past the ledger total,
        // so replays and ack/chunk overlap can never double-count a contract.
        let cumulative = 0;
        for (const chunk of chunks) {
          const alreadyCovered = Math.max(0, ledgerTotalForOrder - cumulative);
          const cap = Math.max(0, filled - cumulative);
          const newPortion = Math.min(chunk.contracts, cap) - Math.min(chunk.contracts, alreadyCovered);
          cumulative += chunk.contracts;
          if (newPortion <= 0) continue;
          const id = `${ticker}:${order.role}_fill:fid:${chunk.fillId}`;
          if (knownEventIds.has(id)) continue;
          running = Math.max(0, running + sign * newPortion);
          await db().appendEth30PositionEvent({
            id, ticker, easternDate: order.easternDate,
            eventType: order.role === "exit" ? "exit_fill" : "entry_fill",
            contractsDelta: sign * newPortion, contractsAfter: running,
            strategyOrderId: order.id, fillPriceCents: chunk.fillPriceCents,
            feeCents: Math.round(chunk.feeDollars * 100), settlementResult: null, note: "exchange_fill_reconciliation",
            occurredAtMs: Date.now(),
          });
          knownEventIds.add(id);
        }
        ledgerTotalForOrder = Math.max(ledgerTotalForOrder, Math.min(filled, chunkTotal ?? 0));
      }
      // Status-only remainder: when the durable fill quantity exceeds what the
      // chunk data covered (fills endpoint lagging or unusable), record the
      // coarse delta so the audit ledger stays consistent with the order row.
      const remainder = Math.max(0, filled - ledgerTotalForOrder);
      if (remainder > 0) {
        const id = `${ticker}:${order.role}_fill:${order.kalshiOrderId}:${filled}`;
        if (!knownEventIds.has(id)) {
          running = Math.max(0, running + sign * remainder);
          await db().appendEth30PositionEvent({
            id, ticker, easternDate: order.easternDate,
            eventType: order.role === "exit" ? "exit_fill" : "entry_fill", contractsDelta: sign * remainder,
            contractsAfter: running, strategyOrderId: order.id,
            fillPriceCents: order.limitPriceCents, feeCents: null, settlementResult: null,
            note: "exchange_order_status_reconciliation", occurredAtMs: Date.now(),
          });
          knownEventIds.add(id);
        }
      }
    } catch (err) {
      // On settled markets Kalshi can return 404 for the order-status endpoint
      // while the fill endpoint still returns immutable completed fills. Do not
      // let that status lookup failure strand an exit at cancelled / zero.
      await promoteEth30ExitFromKalshiFills(order);
      logger.warn({ err, ticker, orderId: order.kalshiOrderId }, "ETH_30_50 owned-order reconciliation failed");
    }
  }
  // Ensure every owned order's exchange-reported fills are evidenced as
  // per-chunk position events at actual execution prices (canonical rebuild).
  // This covers fills that happened while the server was running (e.g. a
  // resting 50¢ target that filled after startup), ack-time fetch failures,
  // and any legacy approximate events, which are replaced wholesale.
  await syncTickerFillEvidence(ticker);
}

/**
 * Interval between periodic owned-order reconciliation sweeps while the server
 * is running. A resting 50¢ GTC target that fills mid-session is not visible
 * to the event ledger until the next reconciliation — 5 minutes is short enough
 * to keep the dashboard current without hammering the Kalshi fills endpoint.
 */
const ETH30_RECONCILE_INTERVAL_MS = 5 * 60_000;

let _reconcileSweepInFlight = false;

/**
 * Single sweep: reconcile owned-order fills for all of today's ETH_30_50
 * claims. Read-only with respect to trading — it updates the durable ledger
 * and order rows from exchange data but never places or cancels an order.
 * The in-flight guard ensures sweeps never overlap.
 */
async function runEth30PeriodicReconcileSweep(): Promise<void> {
  if (!liveEnabled()) return;
  if (_reconcileSweepInFlight) {
    logger.warn("ETH_30_50 periodic reconcile sweep already in flight — skipping tick");
    return;
  }
  _reconcileSweepInFlight = true;
  try {
    const today = easternDay(sweepNow());
    // Include the preceding Eastern calendar date so positions entered just
    // before a midnight boundary continue to be reconciled after the date
    // rolls over.  We derive "yesterday" via pure calendar arithmetic on the
    // Eastern date string — subtracting 24 h in milliseconds is unreliable at
    // the spring-forward DST transition, where the Eastern day is only 23 h
    // long and 24 h back can land two calendar dates earlier.
    const [y, m, d] = today.split("-").map(Number);
    const yesterday = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
    const dates = [today, yesterday];
    const claims = await db().listEth30TickerClaimsForDates(dates);
    if (claims.length > 0) {
      logger.debug({ dates, count: claims.length }, "ETH_30_50 periodic reconcile sweep: checking owned orders");
      for (const claim of claims) {
        try {
          // Fast path: if the cache already knows this ticker settled (warmed
          // at startup by warmEth30SettledTickersCache or populated lazily by
          // prior sweeps), skip it without any SQL round-trip.  A settled
          // market can never un-settle, so no further action is possible.
          if (_settledTickers.has(claim.ticker)) {
            void refreshEth30Shadow(claim.ticker).catch((err) =>
              logger.warn({ err, ticker: claim.ticker }, "eth30 shadow outcome refresh retry failed"));
            continue;
          }
          // Slower path (only for tickers not yet in the cache): read the
          // position-event ledger and cache a settlement entry when found.
          // As the pool of settled claims grows, this path becomes rarer;
          // after the first post-restart sweep it only runs for tickers whose
          // settlement arrived after the startup cache-warm ran.
          const events = await db().listEth30PositionEvents(claim.ticker);
          if (events.some((ev) => ev.eventType === "settlement")) {
            _settledTickers.add(claim.ticker);
            void refreshEth30Shadow(claim.ticker).catch((err) =>
              logger.warn({ err, ticker: claim.ticker }, "eth30 shadow outcome refresh retry failed"));
            continue;
          }
          await reconcileEth30OwnedOrders(claim.ticker);
        } catch (err) {
          logger.warn({ err, ticker: claim.ticker }, "ETH_30_50 periodic reconcile sweep: per-ticker reconcile failed — continuing with remaining tickers");
        }
      }
    }
    // Check all claims (including prior days) for settled markets and close
    // out positions automatically, without waiting for a report request.
    // skipFeeBackfill: the periodic sweep must not hit the exchange fills
    // endpoint for settled tickers; fee backfill happens via the report path.
    await reconcileEth30Settlements({ skipFeeBackfill: true });
  } catch (err) {
    logger.warn({ err }, "ETH_30_50 periodic reconcile sweep failed");
  } finally {
    _reconcileSweepInFlight = false;
  }
}

/**
 * Start the periodic reconciliation timer. Returns a cleanup function that
 * cancels the interval (useful in tests or controlled shutdown).
 * Must only be called from the production runtime — the workspace must never
 * produce a second reconciliation path that touches durable storage.
 */
export function startEth30PeriodicReconciliation(): () => void {
  // Warm the settled-ticker cache at sweep initialisation so the first periodic
  // sweep never does N SQL reads for already-settled tickers, regardless of
  // whether live trading is enabled (recoverEth30Targets returns early when the
  // flag is off, so the warm must live here — not inside the recovery path).
  void warmEth30SettledTickersCache().catch((err) =>
    logger.warn({ err }, "ETH_30_50 settled-ticker cache warmup failed at sweep init"),
  );
  const timer = setInterval(() => {
    void runEth30PeriodicReconcileSweep().catch((err) =>
      logger.warn({ err }, "ETH_30_50 periodic reconcile sweep unhandled error"),
    );
  }, ETH30_RECONCILE_INTERVAL_MS);
  // Prevent the timer from blocking process exit.
  if (typeof timer === "object" && "unref" in timer) (timer as NodeJS.Timeout).unref();
  return () => clearInterval(timer);
}

type KalshiFetch = typeof kalshiAuthFetch;

function kfetch(): KalshiFetch { return _kalshiFetchImpl ?? kalshiAuthFetch; }

let _storeImpl: Eth30Store | null = null;

/**
 * In-memory cache of tickers confirmed as settled across periodic sweep calls.
 * Once a ticker has a settlement event it can never un-settle, so we avoid
 * re-fetching position events for it on every sweep tick. Populated lazily as
 * sweeps run; cleared when the test store is swapped so tests don't interfere.
 */
const _settledTickers = new Set<string>();

export function _setEth30StoreForTesting(s: Eth30Store | null): void {
  _storeImpl = s;
  // Clear the settled-ticker cache at each test-store boundary so settled state
  // from one test case cannot bleed into the next.
  _settledTickers.clear();
}

/**
 * Read-only view of the settled-ticker cache. Tests use this to assert that a
 * ticker was added to the cache (and therefore that subsequent watchdog calls
 * skip it without a SQL round-trip).
 */
export function _settledTickersForTesting(): ReadonlySet<string> { return _settledTickers; }
/** Override the clock used by the periodic sweep (tests only). */
let _nowFnForTesting: (() => Date) | null = null;
let _kalshiFetchImpl: KalshiFetch | null = null;

function db(): Eth30Store { return _storeImpl ?? realStore; }

/** Contracts still resting on the exchange across all non-terminal exit orders. */
export function computeEth30RestingExitQuantity(orders: readonly realStore.Eth30StrategyOrder[], side?: "yes" | "no"): number {
  return orders
    .filter((order) => isBlockingExit(order) && (side == null || order.side === side))
    .reduce((sum, order) => sum + Math.max(0, order.requestedContracts - (order.filledContracts ?? 0)), 0);
}

export function _setEth30KalshiFetchForTesting(fn: KalshiFetch | null): void { _kalshiFetchImpl = fn; }

/** Injects L2 evidence for evaluator-path tests. Never used by production code. */
export function _setEth30OrderbookCaptureForTesting(fn: Eth30OrderbookCapture | null): void {
  _eth30OrderbookCaptureForTesting = fn;
}

/** Overrides shared guards only in evaluator-path tests; production always uses the real guards. */
export function _setEth30EntryGuardsForTesting(
  haltProbe: (() => boolean) | null,
  investmentProbe: ((ticker: string) => ReturnType<typeof allowNewInvestment>) | null,
): void {
  _eth30HaltProbeForTesting = haltProbe;
  _eth30InvestmentProbeForTesting = investmentProbe;
}

/** Exposed only for in-flight guard tests — do not call from production paths. */
export const _runEth30PeriodicReconcileSweepForTesting = runEth30PeriodicReconcileSweep;

function isBlockingExit(order: realStore.Eth30StrategyOrder): boolean {
  return order.role === "exit" && (ETH30_BLOCKING_EXIT_OUTCOMES as readonly string[]).includes(order.outcome);
}

export function _setEth30NowForTesting(fn: (() => Date) | null): void { _nowFnForTesting = fn; }

function sweepNow(): Date { return _nowFnForTesting ? _nowFnForTesting() : new Date(); }
