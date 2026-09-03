/**
 * SOL_30_50 is deliberately independent from any legacy strategy.
 * It observes the same normalized market tick, but owns only rows explicitly
 * claimed in sol30_* storage and is disabled unless SOL_30_50_ENABLED=true.
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
  SOL30_ENTRY_CAP_CENTS, SOL30_TARGET_CENTS, SOL30_PRINCIPAL_CAP_CENTS,
  isSol30Ticker, isSol30OpeningWindow, contractsForSol30Capacity, mayEnterSol30,
} from "./sol30_50Rules.js";
import { isPaired30HighLeg, planPaired30Entry, type Paired30Leg } from "./paired30_50Rules.js";
import {
  planSol30CanonicalFillLedger, sol30SettlementReadiness, buildSol30AuthoritativeFillChunks,
  isSol30ChunkFillEvent,
  type Sol30AuthoritativeFillChunk, type Sol30PositionEventParams,
} from "./sol30FillSync.js";
import { normalizeKalshiFill, type KalshiFillWire } from "../kalshiFillNormalizer.js";
import { computeSol30Report, SOL30_STALE_NO_FILL_THRESHOLD_MS, type Sol30Report } from "./sol30Report.js";
import { kalshiFetch } from "../kalshi.js";
import {
  createTargetLiquidityObserver, buildTargetLiquidityReport,
  type TargetLiquidityReport, type TargetLiquidityPositionInput,
} from "./targetLiquidity.js";
import type { KalshiOrderbookRaw } from "../orderbookParsing.js";
import { insertTargetLiquiditySnapshot, listTargetLiquiditySnapshots } from "../tradeStore.js";
import type {
  Sol30TickerClaim, Sol30StrategyOrder, Sol30StrategyOrderParams,
  Sol30DecisionEventParams,
} from "./sol30Report.js";

export { SOL30_STRATEGY_ID, SOL30_ENTRY_CAP_CENTS, SOL30_TARGET_CENTS, SOL30_PRINCIPAL_CAP_CENTS,
  isSol30Ticker, isSol30OpeningWindow, contractsForSol30Capacity, mayEnterSol30 } from "./sol30_50Rules.js";

export type { Sol30PositionEventParams } from "./sol30FillSync.js";
export type {
  Sol30TickerClaim, Sol30StrategyOrder, Sol30DecisionEventParams, Sol30Report,
} from "./sol30Report.js";

export interface Sol30MarketState {
  ticker: string; openTime: string | null; closeTime: string | null;
  status: string | null; bidUpdatedMs: number;
  /** Optional BBO cents (present on the shared evaluator's state). Used only
   *  for passive first-executable-50¢ evidence — never for order placement. */
  yesBid?: number | null; noBid?: number | null;
}

/**
 * Store interface for SOL_30_50. Mirrors Eth30Store but references sol30_*
 * API function names. The tradeStore implementations are added in parallel;
 * until then this interface documents the expected contract.
 */
export interface Sol30Store {
  /** Production uses this transaction to reserve the claim and both paired
   * child rows together. Test stores may omit it and therefore cannot exercise
   * a live paired submission. */
  reserveSol30PairedEntry?: typeof realStore.reserveSol30PairedEntry;
  claimSol30Ticker(ticker: string, easternDate: string, entryClientOrderId: string): Promise<boolean>;
  recordSol30StrategyOrder(params: Sol30StrategyOrderParams): Promise<boolean>;
  updateSol30StrategyOrder(update: {
    id: string; kalshiOrderId?: string | null; outcome?: Sol30StrategyOrder["outcome"];
    filledContracts?: number | null; averageFillPriceCents?: number | null;
  }): Promise<boolean>;
  listSol30StrategyOrders(ticker: string): Promise<Sol30StrategyOrder[]>;
  appendSol30PositionEvent(params: Sol30PositionEventParams): Promise<boolean>;
  listSol30PositionEvents(ticker: string): Promise<Sol30PositionEventParams[]>;
  listSol30TickerClaimsForDate(easternDate: string): Promise<Sol30TickerClaim[]>;
  listSol30TickerClaimsForDates(dates: string[]): Promise<Sol30TickerClaim[]>;
  deleteSol30PositionEvents(ids: string[]): Promise<boolean>;
  appendSol30DecisionEvent(params: Sol30DecisionEventParams): Promise<boolean>;
  listSol30DecisionEvents(ticker: string): Promise<Sol30DecisionEventParams[]>;
  listRecentSol30DecisionEvents(limit?: number): Promise<Sol30DecisionEventParams[]>;
  listAllSol30TickerClaims(): Promise<Sol30TickerClaim[]>;
  listSettledSol30Tickers(): Promise<string[]>;
}

function liveEnabled(): boolean {
  // Retired at the ETH-only martingale cutover. Keep its historical data
  // readable, but permanently block all new order submissions.
  return false;
}
function outcomeBookSide(side: "yes" | "no"): "bid" | "ask" { return side === "yes" ? "bid" : "ask"; }
function bookPrice(side: "yes" | "no", cents: number): string {
  return ((side === "yes" ? cents : 100 - cents) / 100).toFixed(4);
}

const inFlight = new Set<string>();
type Sol30OrderbookCapture = typeof captureOrderbook;
let _sol30OrderbookCaptureForTesting: Sol30OrderbookCapture | null = null;
let _sol30HaltProbeForTesting: (() => boolean) | null = null;
let _sol30InvestmentProbeForTesting: ((ticker: string) => ReturnType<typeof allowNewInvestment>) | null = null;
function captureSol30Orderbook(...args: Parameters<Sol30OrderbookCapture>): ReturnType<Sol30OrderbookCapture> {
  return (_sol30OrderbookCaptureForTesting ?? captureOrderbook)(...args);
}
function sol30IsTradingHalted(): boolean { return (_sol30HaltProbeForTesting ?? isTradingHalted)(); }
function sol30AllowNewInvestment(ticker: string): ReturnType<typeof allowNewInvestment> {
  return (_sol30InvestmentProbeForTesting ?? allowNewInvestment)(ticker);
}

function isSol30PairedHighEntry(order: Sol30StrategyOrder): boolean {
  return order.role === "entry"
    && new RegExp(`^entry:${order.ticker}:(yes|no)$`).test(order.id)
    && isPaired30HighLeg(order.limitPriceCents);
}

function sol30SideNeedsTarget(orders: readonly Sol30StrategyOrder[], side: "yes" | "no"): boolean {
  const filledEntry = orders.find((order) => order.role === "entry" && order.side === side && (order.filledContracts ?? 0) > 0);
  return !filledEntry || !isSol30PairedHighEntry(filledEntry);
}

/**
 * Safe recompute of the currently owned contract quantity from the durable
 * strategy-order rows: entry fills minus exit fills, floored at zero. This is
 * the single source of truth for target-exit sizing — the append-only event
 * ledger is an audit trail, not the quantity authority.
 */
export function computeSol30OwnedQuantity(orders: readonly Sol30StrategyOrder[]): number {
  let bought = 0;
  let sold = 0;
  for (const order of orders) {
    const filled = Math.max(0, order.filledContracts ?? 0);
    if (order.role === "entry") bought += filled;
    else sold += filled;
  }
  return Math.max(0, bought - sold);
}

/** Side-scoped ownership prevents a YES exit from consuming a paired NO fill. */
export function computeSol30OwnedQuantityForSide(
  orders: readonly Sol30StrategyOrder[], side: "yes" | "no",
): number {
  return computeSol30OwnedQuantity(orders.filter((order) => order.side === side));
}

/** Exchange quantities are fixed-point decimals; avoid binary floating-point churn. */
const SOL30_QUANTITY_EPSILON = 1e-6;
function sameSol30Quantity(left: number, right: number): boolean {
  return Math.abs(left - right) <= SOL30_QUANTITY_EPSILON;
}
function normalizedSol30Quantity(value: number): number {
  return Number.isFinite(value) && value > SOL30_QUANTITY_EPSILON ? value : 0;
}
function formatSol30Quantity(value: number): string {
  return value.toFixed(2);
}

/**
 * Exit outcomes that must block a replacement target. "unresolved" marks a
 * submission whose exchange acceptance is unknown (transport failure or a
 * success response with no order id): the order may be resting on the
 * exchange with no durable link to reconcile or cancel, so it is treated as
 * fully resting until resolved manually — never post beside it.
 */
export const SOL30_BLOCKING_EXIT_OUTCOMES = ["pending", "partial_fill", "unresolved"] as const;

/**
 * In-memory index of tickers with an open resting 50¢ target and the held
 * side. Used only for passive first-executable-50¢ observation recording; a
 * server restart loses it until `recoverSol30Targets` repopulates it.
 */
const openTargets = new Map<string, "yes" | "no">();

/**
 * Target-liquidity observer (pure observability): while a 50¢ target rests
 * and the held side's best bid is at/above 50¢, persists throttled snapshots
 * of the executable bid depth at/above the target plus the target order's
 * durable identity, resting size, and exchange status. Never affects trading.
 */
const targetLiquidityObserver = createTargetLiquidityObserver({
  strategy: "SOL_30_50",
  targetCents: SOL30_TARGET_CENTS,
  listOrders: async (ticker) => (await db().listSol30StrategyOrders(ticker)).map((o) => ({
    id: o.id, role: o.role, outcome: o.outcome, kalshiOrderId: o.kalshiOrderId,
    requestedContracts: o.requestedContracts, filledContracts: o.filledContracts,
    createdAtMs: o.createdAtMs ?? null,
  })),
  fetchOrderbookRaw: (ticker) => kalshiFetch<KalshiOrderbookRaw>(`/markets/${encodeURIComponent(ticker)}/orderbook`),
  fetchOrderStatus: async (kalshiOrderId) => {
    const raw = await kfetch()<Record<string, unknown>>(
      "GET", `/portfolio/orders/${encodeURIComponent(kalshiOrderId)}`);
    return parseKalshiOrderResponse(raw, 0).orderStatus ?? null;
  },
  insertSnapshot: (params) => insertTargetLiquiditySnapshot(params),
  easternDate: (nowMs) => easternDay(new Date(nowMs)),
  onCaptureError: (err, ticker) => logger.warn({ err, ticker },
    "sol30: target-liquidity snapshot capture failed (observability only — trading unaffected)"),
});

/** Test-only accessor for the target-liquidity observer arm state. */
export function _isSol30TargetLiquidityArmedForTesting(ticker: string): boolean {
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
  void db().appendSol30DecisionEvent({
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
function observeTargetExecutability(state: Sol30MarketState): void {
  const side = openTargets.get(state.ticker);
  if (!side) return;
  const bid = side === "yes" ? state.yesBid : state.noBid;
  if (bid == null || bid < SOL30_TARGET_CENTS) return;
  openTargets.delete(state.ticker);
  recordDecision(state.ticker, "target_first_executable", {
    id: `${state.ticker}:target_first_executable`, side, priceCents: bid,
    note: `held-${side} best bid ${bid}¢ ≥ ${SOL30_TARGET_CENTS}¢ target`,
  });
}

async function submitSol30PairedLeg(
  ticker: string, date: string, leg: Paired30Leg, clientOrderId: string, id: string,
): Promise<"filled" | "zero" | "unresolved"> {
  try {
    const raw = await kfetch()<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker, client_order_id: clientOrderId, side: outcomeBookSide(leg.side),
      count: formatSol30Quantity(leg.contracts), price: bookPrice(leg.side, leg.priceCents),
      time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross",
    });
    const ack = parseKalshiOrderResponse(raw, leg.contracts);
    if (!ack.rejectReason && !ack.kalshiOrderId) {
      await db().updateSol30StrategyOrder({ id, outcome: "unresolved" });
      return "unresolved";
    }
    const filled = Math.min(leg.contracts, normalizedSol30Quantity(ack.fillCount));
    await db().updateSol30StrategyOrder({
      id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
      averageFillPriceCents: filled > 0 ? leg.priceCents : null,
      outcome: ack.rejectReason ? "error" : filled === 0 ? "zero_fill" : sameSol30Quantity(filled, leg.contracts) ? "full_fill" : "partial_fill",
    });
    if (filled <= 0) return "zero";
    // A post-ack fill-sync or target failure is not submission ambiguity. Keep
    // the known order id and fill outcome so normal restart reconciliation can
    // recover it instead of permanently blocking a known position.
    try {
      await syncTickerFillEvidence(ticker);
       // The 70–80¢ paired leg is deliberately held through settlement.
       if (!isPaired30HighLeg(leg.priceCents)) await ensureSol30TargetExit(ticker, leg.side, filled, date);
    } catch (err) {
      logger.error({ err, ticker, side: leg.side, orderId: ack.kalshiOrderId },
        "SOL_30_50 paired leg accepted but post-ack evidence/target work failed; known order remains recoverable");
    }
    return "filled";
  } catch (err) {
    await db().updateSol30StrategyOrder({ id, outcome: "unresolved" });
    logger.error({ err, ticker, side: leg.side }, "SOL_30_50 paired IOC outcome unknown — keeping reservation fail closed");
    return "unresolved";
  }
}

/** Complementary-pair entry. A detected pair consumes the evaluation even when
 * reservation or fresh-book validation fails, preventing a fallback single-side
 * order after a paired intent has been durably claimed. */
async function trySol30PairedEntry(state: Sol30MarketState): Promise<boolean> {
  const initial = await Promise.all((["yes", "no"] as const).map(async (side) => {
    const book = await captureSol30Orderbook(state.ticker, side, 100);
    return { book, price: book.lowestLevelCents, depth: Math.max(0, Math.floor(book.depthAtOrBetterContracts ?? 0)) };
  }));
  if (initial[0]!.book.error || initial[1]!.book.error) return false;
  const plan = planPaired30Entry(initial[0]!.price, initial[0]!.depth, initial[1]!.price, initial[1]!.depth);
  if (!plan) return false;
  const date = easternDay(new Date());
  const clientOrderIds = { yes: `sol30-pair-${randomUUID()}:yes`, no: `sol30-pair-${randomUUID()}:no` };
  // Permanent claim + two rows are a durable market reservation prior to POST.
  const ids = { yes: `entry:${state.ticker}:yes`, no: `entry:${state.ticker}:no` };
  const pairOrders = [
    { id: ids.yes, ticker: state.ticker, easternDate: date, role: "entry" as const, sequenceNumber: 0,
      clientOrderId: clientOrderIds.yes, side: "yes" as const, limitPriceCents: plan.yes.priceCents, requestedContracts: plan.yes.contracts },
    { id: ids.no, ticker: state.ticker, easternDate: date, role: "entry" as const, sequenceNumber: 0,
      clientOrderId: clientOrderIds.no, side: "no" as const, limitPriceCents: plan.no.priceCents, requestedContracts: plan.no.contracts },
  ] as const;
  if (!await (db().reserveSol30PairedEntry?.({ ticker: state.ticker, easternDate: date, entryClientOrderId: clientOrderIds.yes, orders: pairOrders }) ?? Promise.resolve(false))) {
    recordDecision(state.ticker, "paired_reservation_failed", { note: "durable pair reservation incomplete; no exchange POST" });
    return true;
  }
  const fresh = await Promise.all((["yes", "no"] as const).map(async (side) => {
    const book = await captureSol30Orderbook(state.ticker, side, 100);
    return { error: book.error, price: book.lowestLevelCents, depth: Math.max(0, Math.floor(book.depthAtOrBetterContracts ?? 0)) };
  }));
  const refreshed = !fresh[0]!.error && !fresh[1]!.error
    ? planPaired30Entry(fresh[0]!.price, fresh[0]!.depth, fresh[1]!.price, fresh[1]!.depth) : null;
  if (!refreshed || refreshed.yes.priceCents !== plan.yes.priceCents || refreshed.no.priceCents !== plan.no.priceCents
    || refreshed.yes.contracts < plan.yes.contracts || refreshed.no.contracts < plan.no.contracts) {
    await Promise.all([db().updateSol30StrategyOrder({ id: ids.yes, outcome: "error" }), db().updateSol30StrategyOrder({ id: ids.no, outcome: "error" })]);
    recordDecision(state.ticker, "paired_freshness_failed", { note: "paired reservation retained; L2 changed before exchange POST" });
    return true;
  }
  const first = await submitSol30PairedLeg(state.ticker, date, plan.yes, clientOrderIds.yes, ids.yes);
  if (first !== "filled") {
    await db().updateSol30StrategyOrder({ id: ids.no, outcome: "error" });
    recordDecision(state.ticker, "paired_second_leg_blocked", { side: "yes", note: `YES ${first}; NO was not submitted` });
    return true;
  }
  const second = await submitSol30PairedLeg(state.ticker, date, plan.no, clientOrderIds.no, ids.no);
  recordDecision(state.ticker, "paired_entry_completed", {
    note: JSON.stringify({ yes: plan.yes, no: plan.no, secondOutcome: second, totalPrincipalCents: plan.yes.contracts * plan.yes.priceCents + plan.no.contracts * plan.no.priceCents }),
  });
  return true;
}

/** Called from the shared evaluator after the legacy evaluation; never alters it. */
export async function evaluateSol30(state: Sol30MarketState): Promise<void> {
  if (!isSol30Ticker(state.ticker)) return;
  observeTargetExecutability(state);
  targetLiquidityObserver.observe(state.ticker, { yesBid: state.yesBid, noBid: state.noBid });
  if (!isSol30OpeningWindow(state.openTime)) return;
  // This is a new-entry strategy, so it shares the global non-negotiable halt
  // and daily-loss gate. It must never make the feature-specific env flag a
  // bypass around a production kill switch.
  const investmentGuard = await sol30AllowNewInvestment(state.ticker);
  if (!mayEnterSol30(liveEnabled(), sol30IsTradingHalted(), investmentGuard.allowed)) {
    // Once-per-ticker evidence (stable id) of why an eligible window was skipped.
    // Only recorded when the strategy is enabled — a disabled flag would
    // otherwise write a row for every SOL window forever.
    if (liveEnabled()) {
      recordDecision(state.ticker, "gate_blocked", {
        id: `${state.ticker}:gate_blocked`,
          note: sol30IsTradingHalted()
            ? "global_halt"
            : `daily_investment_guard:${investmentGuard.status.state}${investmentGuard.status.reason ? `:${investmentGuard.status.reason}` : ""}`,
      });
    }
    return;
  }
  if (inFlight.has(state.ticker)) return;
  inFlight.add(state.ticker);
  try {
    if (await trySol30PairedEntry(state)) return;
    // Claim only after an executable L2 candidate exists.  The claim is
    // permanent even if the ensuing IOC fills zero: first executable side wins.
    const candidates: Array<"yes" | "no"> = ["yes", "no"];
    for (const side of candidates) {
      const book = await captureSol30Orderbook(state.ticker, side, SOL30_ENTRY_CAP_CENTS);
      const price = book.lowestLevelCents;
      const count = price == null ? 0 : contractsForSol30Capacity(SOL30_PRINCIPAL_CAP_CENTS, price, book.depthAtOrBetterContracts);
      if (book.error || price == null || count <= 0) continue;
      const clientOrderId = `sol30-entry-${randomUUID()}`;
      const date = easternDay(new Date());
      if (!await db().claimSol30Ticker(state.ticker, date, clientOrderId)) {
        recordDecision(state.ticker, "claim_conflict", {
          id: `${state.ticker}:claim_conflict`, side, priceCents: price, contracts: count,
          note: "executable candidate found but ticker already claimed (or storage degraded)",
        });
        return;
      }
      const id = `entry:${state.ticker}`;
      if (!await db().recordSol30StrategyOrder({
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
        if (!ack.rejectReason && !ack.kalshiOrderId) {
          // Accepted-looking response with no exchange order id: the IOC may
          // have executed but there is no durable link to look it up by id.
          // Mark unresolved so restart recovery can attempt a client_order_id
          // lookup before concluding no fill — fail closed until then.
          await db().updateSol30StrategyOrder({ id, outcome: "unresolved" });
          recordDecision(state.ticker, "entry_unresolved", {
            id: `${state.ticker}:entry_outcome`, side, priceCents: price, contracts: 0,
            note: "entry IOC response carried no order id — marked unresolved; restart recovery will attempt client_order_id lookup",
          });
          logger.error({ ticker: state.ticker, clientOrderId },
            "SOL_30_50 entry IOC response carried no order id — marked unresolved (recovery will lookup by client_order_id)");
        } else {
          const filled = Math.min(count, normalizedSol30Quantity(ack.fillCount));
          await db().updateSol30StrategyOrder({ id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
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
            await ensureSol30TargetExit(state.ticker, side, filled, date);
          }
        }
      } catch (err) {
        // Transport ambiguity: Kalshi may have accepted the IOC even though the
        // response was lost. Mark unresolved (NOT error) so restart recovery
        // can attempt a client_order_id lookup before concluding no fill.
        // The permanent claim prevents re-entry regardless of recovery outcome.
        await db().updateSol30StrategyOrder({ id, outcome: "unresolved" });
        recordDecision(state.ticker, "entry_unresolved", {
          id: `${state.ticker}:entry_outcome`, side, priceCents: price, contracts: 0,
          note: "entry IOC transport failure — marked unresolved; restart recovery will attempt client_order_id lookup",
        });
        logger.error({ err, ticker: state.ticker }, "SOL_30_50 entry IOC transport failure — marked unresolved (recovery will lookup by client_order_id)");
      }
      return;
    }
    // Both sides scanned inside an eligible window without an executable 20–30¢
    // candidate. Stable id ⇒ at most one skip row per ticker, so the ledger
    // stays bounded even though ticks arrive continuously.
    recordDecision(state.ticker, "no_executable_candidate", {
      id: `${state.ticker}:no_executable_candidate`,
      note: `no executable L2 level ≤ ${SOL30_ENTRY_CAP_CENTS}¢ on yes or no`,
    });
  } finally { inFlight.delete(state.ticker); }
}

/**
 * Extract an explicit, VALID fill count from a raw exchange order response.
 * Returns the fixed-point contract count, or null when the field is absent,
 * non-numeric, negative, or non-finite — any of which means the quantity is
 * ambiguous and callers must fail closed rather than trust 0.
 */
function explicitFillCountFromResponse(raw: Record<string, unknown> | undefined): number | null {
  const orderData = (raw?.["order"] ?? raw) as Record<string, unknown> | undefined;
  if (orderData == null) return null;
  const value = orderData["fill_count_fp"] ?? orderData["fill_count"];
  if (value == null) return null;
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num) || num < 0) return null;
  return normalizedSol30Quantity(num);
}

/**
 * Cancel a strategy-owned resting order via its durable exchange order id.
 * Returns true only when the exchange confirmed the cancel (any terminal fill
 * count in the cancel response is captured before the row is closed out).
 * On failure the row stays non-terminal and the caller MUST NOT post a
 * replacement — an unconfirmed resting order plus a new one could oversell.
 */
async function cancelSol30Order(order: Sol30StrategyOrder): Promise<boolean> {
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
        "SOL_30_50 cancel not confirmed terminal by exchange — leaving order pending (fail closed)",
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
        "SOL_30_50 terminal cancel response lacks an explicit fill count — leaving order pending (fail closed)",
      );
      return false;
    }
    const prior = order.filledContracts ?? 0;
    const filled = Math.min(order.requestedContracts, Math.max(prior, reportedFillCount));
    await db().updateSol30StrategyOrder({
      id: order.id, outcome: "cancelled", filledContracts: filled,
      averageFillPriceCents: filled > 0 ? (order.averageFillPriceCents ?? order.limitPriceCents) : null,
    });
    // A cancel ack can confirm fills that were never acked before; append the
    // delta so the audit ledger stays consistent with the durable order row.
    const delta = Math.max(0, filled - prior);
    if (delta > 0) {
      const sign = order.role === "exit" ? -1 : 1;
      const events = await db().listSol30PositionEvents(order.ticker);
      const before = events.at(-1)?.contractsAfter ?? 0;
      await db().appendSol30PositionEvent({
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
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId }, "SOL_30_50 cancel of resting target failed — leaving order pending (fail closed)");
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
): Promise<Sol30AuthoritativeFillChunk[] | null> {
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
        feeCents: Math.round(normalized.feeDollars * 100),
        occurredAtMs: Number.isFinite(ts) ? ts : Date.now(),
      }];
    });
    return chunks.length > 0 ? chunks : null;
  } catch (err) {
    logger.warn({ err, orderId: kalshiOrderId }, "SOL_30_50 fill-chunk fetch failed; will retry on next reconciliation");
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
  const orders = await db().listSol30StrategyOrders(ticker);
  if (!orders.some((o) => (o.filledContracts ?? 0) > 0)) return;
  const events = await db().listSol30PositionEvents(ticker);
  const isSettled = events.some((ev) => ev.eventType === "settlement");
  if (isSettled) {
    // Ledger is finalised — no new fill or settlement events will be written.
    // However, if any canonical fill-chunk events are still missing fee_cents
    // (written before the fee column was added), fall through so the canonical
    // rebuild can backfill them via the DO UPDATE path in appendSol30PositionEvent.
    const fillChunks = events.filter(isSol30ChunkFillEvent);
    if (fillChunks.length === 0 || fillChunks.every((ev) => ev.feeCents !== null)) return;
    // Some chunks are missing fee data — continue to fee backfill below.
  }
  const chunksByOrder = new Map<string, Sol30AuthoritativeFillChunk[] | null>();
  for (const order of orders) {
    if (!(order.filledContracts ?? 0)) continue;
    chunksByOrder.set(order.id,
      order.kalshiOrderId ? await fetchOwnedFillChunks(order.kalshiOrderId, order.side) : null);
  }
  const plan = planSol30CanonicalFillLedger(orders, events, chunksByOrder);
  if (plan.deferredOrderIds.length > 0) {
    logger.warn({ ticker, deferred: plan.deferredOrderIds }, "SOL_30_50 fill evidence incomplete — canonical rebuild deferred");
    return;
  }
  if (plan.deleteIds.length > 0 && !await db().deleteSol30PositionEvents(plan.deleteIds)) return;
  for (const event of plan.appends) await db().appendSol30PositionEvent(event);
}

/**
 * Keeps exactly one valid owner-scoped resting 50¢ target for the remaining
 * owned quantity; it never invokes protective exits.
 *
 * Quantity discipline: the caller-supplied quantity is only an upper bound —
 * the posted size is always clamped to the owned remainder recomputed from
 * durable strategy-order rows, so a stale caller can never oversell.
 */
export async function ensureSol30TargetExit(ticker: string, side: "yes" | "no", quantity: number, date = easternDay(new Date())): Promise<void> {
  if (!liveEnabled() || quantity <= 0) return;
  let orders = await db().listSol30StrategyOrders(ticker);
  const owned = computeSol30OwnedQuantityForSide(orders, side);
  let open = Math.min(normalizedSol30Quantity(quantity), owned);
  if (open <= 0) return;

  // An unresolved submission (unknown exchange acceptance, no durable link)
  // permanently blocks replacements: it cannot be reconciled or cancelled, so
  // posting anything beside it could oversell. Requires manual intervention.
  if (orders.some((order) => order.side === side && order.role === "exit" && order.outcome === "unresolved")) {
    logger.warn({ ticker }, "SOL_30_50 unresolved target submission blocks replacement — manual intervention required");
    return;
  }

  const pendingExits = orders.filter((order) => order.side === side && isBlockingExit(order));
  const resting = computeSol30RestingExitQuantity(orders, side);
  // Exactly one resting target whose remaining size equals the owned remainder:
  // nothing to do — this is the no-churn fast path used on every restart.
  // Keep first-executable-50¢ observation armed (the in-memory index is lost
  // on restart).
  if (pendingExits.length === 1 && sameSol30Quantity(resting, open)) {
    openTargets.set(ticker, side);
    targetLiquidityObserver.arm(ticker, side);
    return;
  }

  if (pendingExits.length > 0) {
    // Size (or count) mismatch: cancel the stale target(s) before reposting.
    let allCancelled = true;
    for (const pending of pendingExits) {
      if (!await cancelSol30Order(pending)) allCancelled = false;
    }
    if (!allCancelled) return; // fail closed — never post beside an unconfirmed resting order
    // Cancels can race a fill; re-read the durable rows and recompute.
    orders = await db().listSol30StrategyOrders(ticker);
    open = Math.min(normalizedSol30Quantity(quantity), computeSol30OwnedQuantityForSide(orders, side));
    if (open <= 0) return;
  }

  const sequence = orders.filter((order) => order.role === "exit").length + 1;
  const id = `exit:${ticker}:${side}:${sequence}`;
  const clientOrderId = `sol30-exit-${randomUUID()}`;
  if (!await db().recordSol30StrategyOrder({ id, ticker, easternDate: date, role: "exit", sequenceNumber: sequence,
    clientOrderId, side, limitPriceCents: SOL30_TARGET_CENTS, requestedContracts: open })) return;
  try {
    // Kalshi expresses a NO position as the complement of YES. To close a held
    // YES, offer YES (ask); to close a held NO, bid YES. Sending an ask for a
    // held NO opens/acquires NO instead of closing it, and can execute at the
    // current NO price rather than rest at the target.
    const exitSide = side === "yes" ? "ask" : "bid";
    const raw = await kfetch()<Record<string, unknown>>("POST", "/portfolio/events/orders", {
      ticker, client_order_id: clientOrderId, side: exitSide, count: formatSol30Quantity(open),
      price: (SOL30_TARGET_CENTS / 100).toFixed(4), time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
    });
    const ack = parseKalshiOrderResponse(raw, open);
    if (!ack.rejectReason && !ack.kalshiOrderId) {
      // Accepted-looking response with no exchange order id: the order may be
      // resting but there is no durable link to reconcile or cancel it.
      // Fail closed — block any future replacement until resolved manually.
      await db().updateSol30StrategyOrder({ id, outcome: "unresolved" });
      logger.error({ ticker, clientOrderId }, "SOL_30_50 target response carried no order id — marked unresolved (blocks replacements)");
      return;
    }
    const filled = Math.min(open, normalizedSol30Quantity(ack.fillCount));
    await db().updateSol30StrategyOrder({ id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
      averageFillPriceCents: filled > 0 ? SOL30_TARGET_CENTS : null, outcome: ack.rejectReason ? "error" : sameSol30Quantity(filled, open) ? "full_fill" : "pending" });
    // Arm passive first-executable-50¢ observation while the target rests.
    if (!ack.rejectReason && filled < open) {
      openTargets.set(ticker, side);
      targetLiquidityObserver.arm(ticker, side);
    }
    if (filled > 0) {
      await db().appendSol30PositionEvent({
        id: `${ticker}:exit_fill:${ack.kalshiOrderId ?? clientOrderId}:initial`, ticker, easternDate: date,
        eventType: "exit_fill", contractsDelta: -filled, contractsAfter: Math.max(0, open - filled),
        strategyOrderId: id, fillPriceCents: SOL30_TARGET_CENTS, feeCents: null, settlementResult: null,
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
    await db().updateSol30StrategyOrder({ id, outcome: "unresolved" });
    logger.error({ err, ticker }, "SOL_30_50 target submission outcome unknown — marked unresolved (blocks replacements)");
  }
}

/**
 * Pre-populate the in-memory `_settledTickers` cache from SQL with a single
 * query. Called at startup (from recoverSol30Targets) so the first periodic
 * sweep incurs zero per-ticker SQL reads for already-settled markets.
 *
 * Never throws — a failed query leaves the cache empty and the sweep falls
 * back to its existing per-ticker SQL read path.
 */
export async function warmSol30SettledTickersCache(): Promise<void> {
  try {
    const settled = await db().listSettledSol30Tickers();
    for (const ticker of settled) _settledTickers.add(ticker);
    if (settled.length > 0) {
      logger.info(
        { count: settled.length },
        "SOL_30_50 settled-ticker cache warmed at startup — first sweep will skip these tickers",
      );
    }
  } catch (err) {
    logger.warn({ err }, "SOL_30_50 settled-ticker cache warmup failed — sweep will repopulate lazily");
  }
}

/**
 * Bounded restart repair for a lost local SOL ledger. Exchange fill history is
 * only a discovery index: an entry is adopted solely after its authenticated
 * order detail proves both the SOL ticker and our exact client-order prefix.
 * This deliberately cannot adopt legacy SOL activity by ticker, side, price,
 * or timing alone.
 */
async function rehydrateRecentSol30Entries(date: string): Promise<void> {
  // Unit harnesses inject an in-memory store and cover the durable recovery
  // paths independently. Historic exchange discovery is production-only.
  if (_storeImpl) return;
  type FillIndex = { order_id?: unknown; market_ticker?: unknown };
  type OrderDetail = {
    order_id?: unknown; ticker?: unknown; client_order_id?: unknown; side?: unknown;
    fill_count_fp?: unknown; fill_count?: unknown; count_fp?: unknown; count?: unknown;
    status?: unknown;
  };
  try {
    const raw = await kfetch()<{ fills?: FillIndex[] }>("GET", "/portfolio/fills?limit=200");
    const candidates = new Set(
      (raw.fills ?? [])
        .filter((fill) => typeof fill.market_ticker === "string" && /^KXSOL15M-/.test(fill.market_ticker))
        .map((fill) => typeof fill.order_id === "string" ? fill.order_id : null)
        .filter((orderId): orderId is string => orderId != null),
    );
    for (const orderId of candidates) {
      const rawDetail = await kfetch()<{ order?: OrderDetail } & OrderDetail>(
        "GET", `/portfolio/orders/${encodeURIComponent(orderId)}`,
      );
      const detail = rawDetail.order ?? rawDetail;
      const ticker = typeof detail.ticker === "string" ? detail.ticker : null;
      const clientOrderId = typeof detail.client_order_id === "string" ? detail.client_order_id : null;
      const side = detail.side === "yes" || detail.side === "no" ? detail.side : null;
      if (!ticker || !/^KXSOL15M-/.test(ticker) || !clientOrderId?.startsWith("sol30-entry-") || !side) continue;
      const fill = explicitFillCountFromResponse(detail);
      if (fill == null || fill <= SOL30_QUANTITY_EPSILON) continue;
      const requestedRaw = detail.count_fp ?? detail.count ?? fill;
      const requested = typeof requestedRaw === "number" ? requestedRaw : Number(requestedRaw);
      if (!Number.isFinite(requested) || requested + SOL30_QUANTITY_EPSILON < fill) continue;
      if (!await db().claimSol30Ticker(ticker, date, clientOrderId)) continue;
      const id = `entry:${ticker}`;
      if (!await db().recordSol30StrategyOrder({
        id, ticker, easternDate: date, role: "entry", sequenceNumber: 0,
        clientOrderId, side, limitPriceCents: 0, requestedContracts: requested,
      })) continue;
      await db().updateSol30StrategyOrder({
        id, kalshiOrderId: orderId, filledContracts: fill, averageFillPriceCents: null,
        outcome: sameSol30Quantity(fill, requested) ? "full_fill" : "partial_fill",
      });
    }
  } catch (err) {
    logger.warn({ err }, "SOL_30_50 exact-identity ledger rehydration failed; no exchange order was adopted");
  }
}

/** Restart-safe recovery restricted to rows durably owned by this strategy. */
export async function recoverSol30Targets(date = easternDay(sweepNow())): Promise<void> {
  if (!liveEnabled()) return;
  await rehydrateRecentSol30Entries(date);
  // Also check the prior Eastern date so a position entered just before midnight
  // is not missed when the server restarts shortly after the day boundary.
  const yesterday = easternDay(new Date(Date.parse(date + "T12:00:00Z") - 86_400_000));
  for (const claim of await db().listSol30TickerClaimsForDates([date, yesterday])) {
    // Fast path: cache hit — market settled before this restart, skip entirely.
    if (_settledTickers.has(claim.ticker)) continue;
    // Fail-closed fallback: always verify via the per-ticker event ledger for
    // any ticker not already in the cache.
    const events = await db().listSol30PositionEvents(claim.ticker);
    if (events.some((ev) => ev.eventType === "settlement")) {
      _settledTickers.add(claim.ticker); // populate for future sweeps
      continue;
    }
    await reconcileSol30OwnedOrders(claim.ticker);
    // Re-read after reconciliation; stale pre-recovery rows cannot drive a
    // duplicate target or an incorrect remaining quantity.
    const orders = await db().listSol30StrategyOrders(claim.ticker);
    for (const side of ["yes", "no"] as const) {
      const open = computeSol30OwnedQuantityForSide(orders, side);
      const isPairedHighHold = !sol30SideNeedsTarget(orders, side);
      if (open > 0 && isPairedHighHold) {
        // Remove pre-deploy 50¢ targets from settlement-held high children.
        // cancelSol30Order requires a terminal exchange response, otherwise
        // the durable blocking row remains fail-closed for the next sweep.
        for (const exit of orders.filter((order) => order.role === "exit" && order.side === side && isBlockingExit(order))) {
          await cancelSol30Order(exit);
        }
        continue;
      }
      if (open > 0) {
        await ensureSol30TargetExit(claim.ticker, side, open, claim.easternDate);
      }
    }
  }
}

/**
 * Scan all SOL_30_50 ticker claims and emit a WARN log for any that have no
 * entry fills after SOL30_STALE_NO_FILL_THRESHOLD_MS. These are orphaned claims —
 * the ticker was claimed but the IOC order returned zero fills or the exchange
 * rejected the order. Call this from a periodic watchdog or on-demand.
 *
 * Returns the list of stale tickers found (empty if none).
 */
export async function checkStaleSol30Claims(nowMs = Date.now()): Promise<string[]> {
  const claims = await db().listAllSol30TickerClaims();
  const stale: string[] = [];
  for (const claim of claims) {
    if (nowMs - claim.claimedAtMs <= SOL30_STALE_NO_FILL_THRESHOLD_MS) continue;
    // Fast path: settled tickers always have entry fills and can never be stale.
    if (_settledTickers.has(claim.ticker)) continue;
    // Only flag claims with no entry fills.
    const events = await db().listSol30PositionEvents(claim.ticker);
    const entryFills = events.filter((ev) => ev.eventType === "entry_fill")
      .reduce((sum, ev) => sum + ev.contractsDelta, 0);
    if (entryFills > 0) continue;
    stale.push(claim.ticker);
    const ageMinutes = Math.round((nowMs - claim.claimedAtMs) / 60_000);
    logger.warn(
      { ticker: claim.ticker, easternDate: claim.easternDate, claimedAtMs: claim.claimedAtMs, ageMinutes },
      "SOL_30_50 stale no-fill claim detected — ticker claimed but never filled",
    );
  }
  return stale;
}

/**
 * Fetch per-chunk exchange fills for one strategy-owned order via its durable
 * kalshi_order_id link. Fail-closed: any chunk missing Kalshi's immutable
 * fill_id makes the whole response unusable for the ledger (null).
 */
async function fetchSol30OwnedOrderFills(order: Sol30StrategyOrder): Promise<NormalizedKalshiFill[] | null> {
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
          "SOL_30_50 fill chunk missing identity or exact economics — rejecting entire response (fail-closed)");
        return null;
      }
      normalized.push(chunk);
    }
    // Deterministic order for incremental attribution across restarts.
    normalized.sort((a, b) =>
      (a.fillTimestamp ?? "").localeCompare(b.fillTimestamp ?? "") || a.fillId!.localeCompare(b.fillId!));
    return normalized;
  } catch (err) {
    logger.warn({ err, ticker: order.ticker, orderId: order.kalshiOrderId }, "SOL_30_50 owned-order fills fetch failed");
    return null;
  }
}

/** Loads all sol30 ownership rows from SQL and computes the strategy-only report. */
export async function buildSol30Report(): Promise<Sol30Report> {
  const claims = await db().listAllSol30TickerClaims();
  const ordersByTicker    = new Map<string, Sol30StrategyOrder[]>();
  const eventsByTicker    = new Map<string, Sol30PositionEventParams[]>();
  const decisionsByTicker = new Map<string, Sol30DecisionEventParams[]>();
  for (const claim of claims) {
    const [orders, events, decisions] = await Promise.all([
      db().listSol30StrategyOrders(claim.ticker),
      db().listSol30PositionEvents(claim.ticker),
      db().listSol30DecisionEvents(claim.ticker),
    ]);
    ordersByTicker.set(claim.ticker, orders);
    eventsByTicker.set(claim.ticker, events);
    decisionsByTicker.set(claim.ticker, decisions);
  }
  const recentDecisions = await db().listRecentSol30DecisionEvents(100);
  return computeSol30Report({ claims, ordersByTicker, eventsByTicker, decisionsByTicker, recentDecisions });
}

export interface Sol30TargetProtectionStatus {
  ticker: string;
  ownedContracts: number;
  targetOrderId: string | null;
  targetStatus: string | null;
  targetRemainingContracts: number;
  status: "valid_target" | "missing_target_after_restart" | "fractional_remainder_unprotected" | "target_size_mismatch";
}

/**
 * Read-only, SOL-owned target audit. Reconciles only durable strategy order
 * links before classifying the protection gap; it never adopts a ticker, order,
 * or position solely because it is a SOL market.
 */
export async function buildSol30TargetProtectionReport(): Promise<Sol30TargetProtectionStatus[]> {
  const statuses: Sol30TargetProtectionStatus[] = [];
  for (const claim of await db().listAllSol30TickerClaims()) {
    await reconcileSol30OwnedOrders(claim.ticker);
    const orders = await db().listSol30StrategyOrders(claim.ticker);
    const owned = computeSol30OwnedQuantity(orders);
    if (owned <= SOL30_QUANTITY_EPSILON) continue;
    const exits = orders.filter(isBlockingExit);
    const target = exits.length === 1 ? exits[0]! : null;
    const remaining = target ? Math.max(0, target.requestedContracts - (target.filledContracts ?? 0)) : 0;
    const hasFractionalGap = Math.abs((owned - remaining) % 1) > SOL30_QUANTITY_EPSILON;
    statuses.push({
      ticker: claim.ticker,
      ownedContracts: owned,
      targetOrderId: target?.kalshiOrderId ?? null,
      targetStatus: target?.outcome ?? null,
      targetRemainingContracts: remaining,
      status: target && sameSol30Quantity(owned, remaining)
        ? "valid_target"
        : exits.length === 0
          ? "missing_target_after_restart"
          : hasFractionalGap
            ? "fractional_remainder_unprotected"
            : "target_size_mismatch",
    });
  }
  return statuses;
}

/**
 * Per-position target-liquidity report: classifies each claimed ticker with
 * fills as never-reached-50¢, insufficient depth, or sufficient depth while
 * the target rested unfilled. Read-only over sol30_* ledgers and the shared
 * target_liquidity_snapshots table.
 */
export async function buildSol30TargetLiquidityReport(): Promise<TargetLiquidityReport> {
  const claims = await db().listAllSol30TickerClaims();
  const allSnapshots = await listTargetLiquiditySnapshots("SOL_30_50");
  const snapshotsByTicker = new Map<string, typeof allSnapshots>();
  for (const snap of allSnapshots) {
    const list = snapshotsByTicker.get(snap.ticker) ?? [];
    list.push(snap);
    snapshotsByTicker.set(snap.ticker, list);
  }
  const inputs: TargetLiquidityPositionInput[] = [];
  for (const claim of claims) {
    const [orders, events, decisions] = await Promise.all([
      db().listSol30StrategyOrders(claim.ticker),
      db().listSol30PositionEvents(claim.ticker),
      db().listSol30DecisionEvents(claim.ticker),
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
      openContracts: computeSol30OwnedQuantity(orders),
      settled, firstExecutableAtMs: firstExec?.occurredAtMs ?? null,
      snapshots: snapshotsByTicker.get(claim.ticker) ?? [],
    });
  }
  return buildTargetLiquidityReport("SOL_30_50", SOL30_TARGET_CENTS, inputs);
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
export async function reconcileSol30Settlements(options?: {
  /**
   * When true, skip the fee-backfill step for already-settled tickers.
   * The backfill calls syncTickerFillEvidence, which hits the exchange fills
   * endpoint — inappropriate from the periodic sweep where settled tickers
   * should generate no exchange I/O. The backfill still runs when this
   * function is called from the report/analytics path (default: false).
   */
  skipFeeBackfill?: boolean;
}): Promise<void> {
  for (const claim of await db().listAllSol30TickerClaims()) {
    try {
      // Fast path: if a prior sweep already confirmed this ticker settled and
      // we are in the periodic-sweep path (where fee backfill is explicitly
      // disabled), skip the SQL round-trip entirely.
      if (options?.skipFeeBackfill && _settledTickers.has(claim.ticker)) continue;

      let events = await db().listSol30PositionEvents(claim.ticker);
      if (events.some((ev) => ev.eventType === "settlement")) {
        // Ledger is finalised — no new fills or settlement will be appended.
        _settledTickers.add(claim.ticker);
        // However, canonical fill-chunk events written before the fee_cents
        // column existed have feeCents=null. Backfill them now (idempotent).
        if (!options?.skipFeeBackfill) {
          const fillChunks = events.filter(isSol30ChunkFillEvent);
          if (fillChunks.length > 0 && fillChunks.some((ev) => ev.feeCents === null)) {
            await syncTickerFillEvidence(claim.ticker);
          }
        }
        continue;
      }
      // Reconcile owned orders FIRST: a resting 50¢ target may have filled
      // while the server was running and not yet be reflected in the event
      // ledger. Settling from stale events would close out contracts that
      // were already sold.
      await reconcileSol30OwnedOrders(claim.ticker);
      events = await db().listSol30PositionEvents(claim.ticker);
      const entered = events.filter((ev) => ev.eventType === "entry_fill")
        .reduce((sum, ev) => sum + ev.contractsDelta, 0);
      if (entered <= 0) continue;
      const orders = await db().listSol30StrategyOrders(claim.ticker);
      const readiness = sol30SettlementReadiness(orders, events);
      if (!readiness.ready) {
        logger.warn({ ticker: claim.ticker, missing: readiness.missingOrderIds },
          "SOL_30_50 settlement deferred — fill evidence incomplete for owned orders");
        continue;
      }
      const raw = await kfetch()<KalshiMarketResult>("GET", `/markets/${encodeURIComponent(claim.ticker)}`);
      const result = raw.market?.result;
      if (result !== "yes" && result !== "no") continue; // not settled yet
      openTargets.delete(claim.ticker);
      targetLiquidityObserver.disarm(claim.ticker);
      const open = readiness.openContracts;
      const settled = await db().appendSol30PositionEvent({
        id: `${claim.ticker}:settlement`, ticker: claim.ticker, easternDate: claim.easternDate,
        eventType: "settlement", contractsDelta: -open, contractsAfter: 0, strategyOrderId: null,
        fillPriceCents: null, feeCents: null, settlementResult: result,
        note: `market settled ${result}; ${open} owned contracts closed at settlement`,
        occurredAtMs: Date.now(),
      });
      // Only cache when the durable write confirmed.
      if (settled) _settledTickers.add(claim.ticker);
      // Mark any still-blocking exit orders as terminal.
      for (const order of orders) {
        if (order.role === "exit" && (SOL30_BLOCKING_EXIT_OUTCOMES as readonly string[]).includes(order.outcome)) {
          await db().updateSol30StrategyOrder({
            id: order.id,
            outcome: "cancelled",
            filledContracts: order.filledContracts ?? 0,
            averageFillPriceCents: (order.filledContracts ?? 0) > 0
              ? (order.averageFillPriceCents ?? order.limitPriceCents)
              : null,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, ticker: claim.ticker }, "SOL_30_50 settlement reconciliation failed");
    }
  }
}

/**
 * Authoritative lookup for an unresolved entry order whose transport failed or
 * whose POST response carried no order id. Uses the documented V2 mechanism:
 *
 *  Step 1. GET /portfolio/fills?ticker={ticker}&limit=100 (paginates if needed).
 *          Filters fills by exact ticker match AND action="buy" (entry orders).
 *          Collects the unique exchange order_ids from matching fill records.
 *          Any fill whose embedded market_ticker does not exactly equal the
 *          durable ticker is rejected — a filter-ignored response that returns
 *          fills for other tickers is treated as ambiguous and keeps the entry
 *          unresolved. If the server returns fills for multiple distinct
 *          order_ids, the result is also ambiguous (fail closed).
 *
 *  Step 2. GET /portfolio/orders/{order_id} for the single candidate.
 *          Verifies that the order response's client_order_id exactly matches
 *          the durable clientOrderId AND the ticker field matches the durable
 *          ticker. Any mismatch — including a missing client_order_id — keeps
 *          the entry unresolved; we never persist a cross-order identity link.
 *
 *  Step 3. Resolve the fill count using the same strict semantics as
 *          cancelSol30Order: require a validated explicit non-negative decimal
 *          fill_count. Only infer requestedContracts for an unambiguously
 *          fully-executed status ("executed"/"filled"). Missing, non-numeric,
 *          or negative counts keep the entry unresolved (fail closed).
 *
 * Returns the confirmed exchange order_id on success, or null to keep
 * unresolved on any ambiguity, mismatch, transport error, or missing count.
 * No durable state (kalshi_order_id, fill count, outcome) is ever written
 * unless all three steps complete with exact matches.
 */
async function lookupSol30UnresolvedEntryByClientOrderId(
  order: Sol30StrategyOrder,
): Promise<string | null> {
  try {
    // ── Step 1: find buy fills for this exact ticker ─────────────────────────
    // Use the documented fills list endpoint, filtered by ticker.  Paginate
    // to ensure we never miss a fill on a busy ticker.  A maximum of two pages
    // (200 fills) is enough to find a single IOC entry; beyond that the result
    // is treated as ambiguous to keep the response time bounded.
    const MAX_PAGES = 2;
    const matchingOrderIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    while (pages < MAX_PAGES) {
      const qs = new URLSearchParams({ ticker: order.ticker, limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const raw = await kfetch()<{ fills?: Array<Record<string, unknown>>; cursor?: string }>(
        "GET", `/portfolio/fills?${qs.toString()}`,
      );
      const fills = Array.isArray(raw.fills) ? raw.fills : [];
      for (const fill of fills) {
        // Exact ticker guard: if the server ignored the ticker filter, a fill
        // from a different market would leak through. Reject it immediately —
        // a mismatch means the filter was ignored; treat the whole response
        // as ambiguous to prevent a cross-ticker identity link.
        const fillTicker = typeof fill["market_ticker"] === "string" ? fill["market_ticker"] : null;
        if (fillTicker !== order.ticker) {
          logger.warn(
            { ticker: order.ticker, fillTicker, clientOrderId: order.clientOrderId },
            "SOL_30_50 unresolved entry fill lookup: fill ticker mismatch — filter may be ignored, keeping entry unresolved",
          );
          return null;
        }
        // Only entry (buy) fills are relevant.
        const action = fill["action"];
        if (action !== "buy") continue;
        // Collect the exchange order_id from the fill record.
        const fillOrderId = typeof fill["order_id"] === "string" && fill["order_id"].length > 0
          ? fill["order_id"] : null;
        if (!fillOrderId) continue;
        matchingOrderIds.add(fillOrderId);
      }
      const nextCursor = typeof raw.cursor === "string" && raw.cursor.length > 0 ? raw.cursor : null;
      pages++;
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    // No buy fills for this ticker: the IOC filled zero contracts (or fills are
    // still propagating). Fail closed — cannot yet conclude zero_fill safely
    // because a transport failure may have preceded fill propagation.
    if (matchingOrderIds.size === 0) {
      logger.warn(
        { ticker: order.ticker, clientOrderId: order.clientOrderId },
        "SOL_30_50 unresolved entry fill lookup: no buy fills found for ticker — keeping entry unresolved (will retry on next reconciliation)",
      );
      return null;
    }

    // Multiple distinct order_ids found: ambiguous — we cannot tell which one
    // belongs to our unresolved entry without a reliable cross-reference.
    if (matchingOrderIds.size > 1) {
      logger.warn(
        { ticker: order.ticker, clientOrderId: order.clientOrderId, orderIds: [...matchingOrderIds] },
        "SOL_30_50 unresolved entry fill lookup: multiple buy order_ids for ticker — ambiguous, keeping entry unresolved",
      );
      return null;
    }

    // ── Step 2: verify the single candidate against our durable identity ─────
    const candidateOrderId = [...matchingOrderIds][0]!;
    const orderRaw = await kfetch()<Record<string, unknown>>(
      "GET", `/portfolio/orders/${encodeURIComponent(candidateOrderId)}`,
    );
    const orderData = (orderRaw["order"] as Record<string, unknown> | undefined) ?? orderRaw;

    // Verify client_order_id matches exactly. The order detail response MUST
    // carry this field and it MUST equal our durable clientOrderId — otherwise
    // we are looking at a different order and must not link it.
    const responseClientOrderId = typeof orderData["client_order_id"] === "string"
      ? orderData["client_order_id"] : null;
    if (responseClientOrderId !== order.clientOrderId) {
      logger.warn(
        { ticker: order.ticker, durable: order.clientOrderId, fromExchange: responseClientOrderId,
          kalshiOrderId: candidateOrderId },
        "SOL_30_50 unresolved entry fill lookup: client_order_id mismatch — keeping entry unresolved (will not link a foreign order)",
      );
      return null;
    }

    // Verify ticker matches exactly (guards against unlikely but catastrophic
    // cross-ticker confusion from a server-side bug or cache collision).
    const responseTicker = typeof orderData["ticker"] === "string" ? orderData["ticker"] : null;
    if (responseTicker !== null && responseTicker !== order.ticker) {
      logger.warn(
        { durable: order.ticker, fromExchange: responseTicker, kalshiOrderId: candidateOrderId },
        "SOL_30_50 unresolved entry fill lookup: ticker mismatch on order detail — keeping entry unresolved",
      );
      return null;
    }

    // ── Step 3: resolve fill count with strict explicit-count semantics ───────
    // The shared parser defaults a missing fill count to 0, which would
    // incorrectly resolve a partially filled IOC as zero_fill. Require a
    // validated explicit non-negative integer; only infer requestedContracts
    // for an unambiguously fully-executed status.
    const parsed = parseKalshiOrderResponse({ order: orderData }, order.requestedContracts);
    const explicitFillCount = explicitFillCountFromResponse({ order: orderData });
    let filled: number;
    if (explicitFillCount != null) {
      filled = Math.min(order.requestedContracts, explicitFillCount);
    } else if (parsed.orderStatus === "executed" || parsed.orderStatus === "filled") {
      // Unambiguously fully-executed: every requested contract was filled.
      filled = order.requestedContracts;
    } else {
      // Fill count absent/invalid and status is not unambiguously full — the
      // quantity is still unknown. Fail closed: keep unresolved.
      logger.warn(
        { ticker: order.ticker, clientOrderId: order.clientOrderId,
          kalshiOrderId: candidateOrderId, status: parsed.orderStatus },
        "SOL_30_50 unresolved entry fill lookup: order found but fill count absent/invalid — keeping entry unresolved (fail closed)",
      );
      return null;
    }

    const isCancelStatus = parsed.orderStatus === "canceled" || parsed.orderStatus === "cancelled";
    const outcome = parsed.rejectReason ? "error" :
      isCancelStatus && filled === 0 ? "zero_fill" :
      isCancelStatus ? "partial_fill" :
      filled === 0 ? "zero_fill" :
      filled >= order.requestedContracts ? "full_fill" : "partial_fill";
    await db().updateSol30StrategyOrder({
      id: order.id, kalshiOrderId: candidateOrderId, filledContracts: filled,
      averageFillPriceCents: filled > 0 ? order.limitPriceCents : null, outcome,
    });
    logger.info(
      { ticker: order.ticker, clientOrderId: order.clientOrderId, kalshiOrderId: candidateOrderId, filled, outcome },
      "SOL_30_50 unresolved entry recovered via ticker-fills + order-detail lookup",
    );
    recordDecision(order.ticker, filled > 0 ? "entry_placed" : "entry_zero_fill", {
      id: `${order.ticker}:entry_outcome`, side: order.side,
      priceCents: order.limitPriceCents, contracts: filled,
      note: `recovered from unresolved via ticker-fills lookup: filled ${filled} (outcome: ${outcome})`,
    });
    return candidateOrderId;
  } catch (err) {
    logger.warn(
      { err, ticker: order.ticker, clientOrderId: order.clientOrderId },
      "SOL_30_50 unresolved entry fill lookup failed — keeping entry unresolved (will retry on next reconciliation)",
    );
    return null;
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
 * For unresolved entry orders (transport failure or id-less POST response),
 * performs an authoritative lookup by client_order_id before concluding no
 * fill. If the result is still unknown, the row stays unresolved (fail closed).
 *
 * It never attributes exchange activity by ticker or side, and it never
 * submits, changes, or cancels an order.
 */
export async function reconcileSol30OwnedOrders(ticker: string): Promise<void> {
  const orders = await db().listSol30StrategyOrders(ticker);
  const events = await db().listSol30PositionEvents(ticker);
  const knownEventIds = new Set(events.map((event) => event.id));
  // Running owned quantity for contracts_after on newly appended chunk events.
  let running = computeSol30OwnedQuantity(orders);

  for (const order of orders) {
    // Unresolved entry orders: no kalshi_order_id yet — attempt client_order_id
    // lookup to determine whether the IOC was accepted and filled.
    if (!order.kalshiOrderId && order.outcome === "unresolved" && order.role === "entry") {
      try {
        const resolvedId = await lookupSol30UnresolvedEntryByClientOrderId(order);
        if (resolvedId) {
          // Re-read the updated order row so the normal reconcile path below
          // picks up the newly linked kalshi_order_id and correct outcome.
          const refreshed = (await db().listSol30StrategyOrders(ticker)).find((o) => o.id === order.id);
          if (refreshed) {
            order.kalshiOrderId = refreshed.kalshiOrderId;
            order.outcome = refreshed.outcome;
            order.filledContracts = refreshed.filledContracts;
          }
        }
      } catch (err) {
        logger.warn({ err, ticker, orderId: order.id }, "SOL_30_50 unresolved entry lookup failed unexpectedly");
      }
      // If still unresolved after the lookup attempt, skip (fail closed).
      if (order.outcome === "unresolved") continue;
    }
    if (!order.kalshiOrderId || !["pending", "partial_fill"].includes(order.outcome)) continue;
    try {
      const raw = await kfetch()<Record<string, unknown>>("GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`);
      const parsed = parseKalshiOrderResponse(raw, Math.max(0, order.requestedContracts - (order.filledContracts ?? 0)));
      const chunks = await fetchSol30OwnedOrderFills(order);
      const prior = order.filledContracts ?? 0;
      const chunkTotal = chunks?.reduce((sum, chunk) => sum + chunk.contracts, 0) ?? null;
      const statusTotal = explicitFillCountFromResponse(raw) ?? 0;
      // The order-status fill count is a safety floor: quantities are
      // monotone — take the max of every durable signal, clamped to requested.
      const filled = Math.min(order.requestedContracts, Math.max(prior, statusTotal, chunkTotal ?? 0));
      // Never terminalize a canceled order from a response that omits (or
      // malforms) the explicit fill count.
      const explicitFillCount = explicitFillCountFromResponse(raw);
      const isCancelStatus = parsed.orderStatus === "canceled" || parsed.orderStatus === "cancelled";
      if (isCancelStatus && explicitFillCount == null) {
        logger.warn(
          { ticker, orderId: order.kalshiOrderId, status: parsed.orderStatus, chunkTotal },
          "SOL_30_50 canceled status without a validated explicit fill count — keeping row pending (fail closed)",
        );
        continue;
      }
      const avgCents = chunks && chunkTotal && chunkTotal > 0
        ? Math.round(chunks.reduce((sum, chunk) => sum + chunk.fillPriceCents * chunk.contracts, 0) / chunkTotal)
        : order.limitPriceCents;
      const terminal = parsed.rejectReason ? "error" : isCancelStatus ? "cancelled" :
        filled >= order.requestedContracts ? "full_fill" : filled > 0 ? "partial_fill" : "pending";
      await db().updateSol30StrategyOrder({ id: order.id, outcome: terminal, filledContracts: filled,
        averageFillPriceCents: filled > 0 ? avgCents : null });
      order.filledContracts = filled;
      order.outcome = terminal;

      const sign = order.role === "exit" ? -1 : 1;
      let ledgerTotalForOrder = events
        .filter((event) => event.strategyOrderId === order.id)
        .reduce((sum, event) => sum + Math.abs(event.contractsDelta), 0);
      if (chunks && chunks.length > 0) {
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
          await db().appendSol30PositionEvent({
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
          await db().appendSol30PositionEvent({
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
      logger.warn({ err, ticker, orderId: order.kalshiOrderId }, "SOL_30_50 owned-order reconciliation failed");
    }
  }
  // Ensure every owned order's exchange-reported fills are evidenced as
  // per-chunk position events at actual execution prices (canonical rebuild).
  await syncTickerFillEvidence(ticker);
}

/**
 * Interval between periodic owned-order reconciliation sweeps while the server
 * is running. 5 minutes matches ETH_30_50.
 */
const SOL30_RECONCILE_INTERVAL_MS = 5 * 60_000;

let _reconcileSweepInFlight = false;

/**
 * Single sweep: reconcile owned-order fills for all of today's SOL_30_50
 * claims. Read-only with respect to trading — it updates the durable ledger
 * and order rows from exchange data but never places or cancels an order.
 * The in-flight guard ensures sweeps never overlap.
 */
async function runSol30PeriodicReconcileSweep(): Promise<void> {
  if (!liveEnabled()) return;
  if (_reconcileSweepInFlight) {
    logger.warn("SOL_30_50 periodic reconcile sweep already in flight — skipping tick");
    return;
  }
  _reconcileSweepInFlight = true;
  try {
    const today = easternDay(sweepNow());
    // Include the preceding Eastern calendar date so positions entered just
    // before a midnight boundary continue to be reconciled after the date
    // rolls over. Use calendar-day arithmetic on the Eastern date string —
    // subtracting 24 h in milliseconds is unreliable at the spring-forward
    // DST transition.
    const [y, m, d] = today.split("-").map(Number);
    const yesterday = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
    const dates = [today, yesterday];
    const claims = await db().listSol30TickerClaimsForDates(dates);
    if (claims.length > 0) {
      logger.debug({ dates, count: claims.length }, "SOL_30_50 periodic reconcile sweep: checking owned orders");
      for (const claim of claims) {
        try {
          if (_settledTickers.has(claim.ticker)) continue;
          const events = await db().listSol30PositionEvents(claim.ticker);
          if (events.some((ev) => ev.eventType === "settlement")) {
            _settledTickers.add(claim.ticker);
            continue;
          }
          await reconcileSol30OwnedOrders(claim.ticker);
        } catch (err) {
          logger.warn({ err, ticker: claim.ticker }, "SOL_30_50 periodic reconcile sweep: per-ticker reconcile failed — continuing with remaining tickers");
        }
      }
    }
    // Check all claims (including prior days) for settled markets and close
    // out positions automatically, without waiting for a report request.
    await reconcileSol30Settlements({ skipFeeBackfill: true });
  } catch (err) {
    logger.warn({ err }, "SOL_30_50 periodic reconcile sweep failed");
  } finally {
    _reconcileSweepInFlight = false;
  }
}

/**
 * Start the periodic reconciliation timer. Returns a cleanup function that
 * cancels the interval (useful in tests or controlled shutdown).
 * Must only be called from the production runtime.
 */
export function startSol30PeriodicReconciliation(): () => void {
  // Warm the settled-ticker cache at sweep initialisation so the first periodic
  // sweep never does N SQL reads for already-settled tickers.
  void warmSol30SettledTickersCache().catch((err) =>
    logger.warn({ err }, "SOL_30_50 settled-ticker cache warmup failed at sweep init"),
  );
  const timer = setInterval(() => {
    void runSol30PeriodicReconcileSweep().catch((err) =>
      logger.warn({ err }, "SOL_30_50 periodic reconcile sweep unhandled error"),
    );
  }, SOL30_RECONCILE_INTERVAL_MS);
  // Prevent the timer from blocking process exit.
  if (typeof timer === "object" && "unref" in timer) (timer as NodeJS.Timeout).unref();
  return () => clearInterval(timer);
}

type KalshiFetch = typeof kalshiAuthFetch;
// NormalizedKalshiFill type alias used in reconcile function
type NormalizedKalshiFill = NonNullable<ReturnType<typeof normalizeKalshiFill>>;

function kfetch(): KalshiFetch { return _kalshiFetchImpl ?? kalshiAuthFetch; }

import * as realStore from "../tradeStore.js";

/**
 * Production store: thin wrappers that delegate to the sol30_* tradeStore APIs.
 *
 * The tradeStore uses slightly looser types for forward-compatibility (e.g.
 * `outcome: string` instead of the explicit union, `eventType` with an extra
 * "correction" variant). The casts below are safe because the database only
 * writes the values this strategy module produces, which always satisfy the
 * narrower types the strategy logic expects.
 */
const liveStore: Sol30Store = {
  reserveSol30PairedEntry:         realStore.reserveSol30PairedEntry,
  claimSol30Ticker:               realStore.claimSol30Ticker,
  recordSol30StrategyOrder:       (p) => realStore.recordSol30StrategyOrder(p as Parameters<typeof realStore.recordSol30StrategyOrder>[0]),
  updateSol30StrategyOrder:       realStore.updateSol30StrategyOrder,
  listSol30StrategyOrders:        async (ticker) => (await realStore.listSol30StrategyOrders(ticker)) as Sol30StrategyOrder[],
  appendSol30PositionEvent:       (p) => realStore.appendSol30PositionEvent(p as Parameters<typeof realStore.appendSol30PositionEvent>[0]),
  listSol30PositionEvents:        async (ticker) => (await realStore.listSol30PositionEvents(ticker)) as Sol30PositionEventParams[],
  listSol30TickerClaimsForDate:   realStore.listSol30TickerClaimsForDate,
  listSol30TickerClaimsForDates:  realStore.listSol30TickerClaimsForDates,
  deleteSol30PositionEvents:      realStore.deleteSol30PositionEvents,
  appendSol30DecisionEvent:       realStore.appendSol30DecisionEvent,
  listSol30DecisionEvents:        realStore.listSol30DecisionEvents,
  listRecentSol30DecisionEvents:  realStore.listRecentSol30DecisionEvents,
  listAllSol30TickerClaims:       realStore.listAllSol30TickerClaims,
  listSettledSol30Tickers:        realStore.listSettledSol30Tickers,
};

let _storeImpl: Sol30Store | null = null;

/**
 * In-memory cache of tickers confirmed as settled across periodic sweep calls.
 * Once a ticker has a settlement event it can never un-settle.
 * Populated lazily as sweeps run; cleared when the test store is swapped.
 */
const _settledTickers = new Set<string>();

export function _setSol30StoreForTesting(s: Sol30Store | null): void {
  _storeImpl = s;
  // Clear the settled-ticker cache at each test-store boundary.
  _settledTickers.clear();
}

/**
 * Read-only view of the settled-ticker cache. Tests use this to assert that a
 * ticker was added to the cache.
 */
export function _settledTickersForTesting(): ReadonlySet<string> { return _settledTickers; }

/** Override the clock used by the periodic sweep (tests only). */
let _nowFnForTesting: (() => Date) | null = null;
let _kalshiFetchImpl: KalshiFetch | null = null;

function db(): Sol30Store {
  // Test override always wins.
  if (_storeImpl) return _storeImpl;
  // Production: use the real tradeStore sol30 APIs.
  return liveStore;
}

/** Contracts still resting on the exchange across all non-terminal exit orders. */
export function computeSol30RestingExitQuantity(orders: readonly Sol30StrategyOrder[], side?: "yes" | "no"): number {
  return orders
    .filter((order) => isBlockingExit(order) && (side == null || order.side === side))
    .reduce((sum, order) => sum + Math.max(0, order.requestedContracts - (order.filledContracts ?? 0)), 0);
}

export function _setSol30KalshiFetchForTesting(fn: KalshiFetch | null): void { _kalshiFetchImpl = fn; }

/** Injects L2 evidence for evaluator-path tests. Never used by production code. */
export function _setSol30OrderbookCaptureForTesting(fn: Sol30OrderbookCapture | null): void {
  _sol30OrderbookCaptureForTesting = fn;
}

/** Overrides shared guards only in evaluator-path tests; production always uses the real guards. */
export function _setSol30EntryGuardsForTesting(
  haltProbe: (() => boolean) | null,
  investmentProbe: ((ticker: string) => ReturnType<typeof allowNewInvestment>) | null,
): void {
  _sol30HaltProbeForTesting = haltProbe;
  _sol30InvestmentProbeForTesting = investmentProbe;
}

/** Exposed only for in-flight guard tests — do not call from production paths. */
export const _runSol30PeriodicReconcileSweepForTesting = runSol30PeriodicReconcileSweep;

function isBlockingExit(order: Sol30StrategyOrder): boolean {
  return order.role === "exit" && (SOL30_BLOCKING_EXIT_OUTCOMES as readonly string[]).includes(order.outcome);
}

export function _setSol30NowForTesting(fn: (() => Date) | null): void { _nowFnForTesting = fn; }

function sweepNow(): Date { return _nowFnForTesting ? _nowFnForTesting() : new Date(); }
