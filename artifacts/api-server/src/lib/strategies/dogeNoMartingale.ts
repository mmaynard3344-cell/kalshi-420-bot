/**
 * Execution-only DOGE strategy.  It is intentionally not connected to passive
 * observation, replay, or the legacy BTC/ETH evaluator.
 */
import { randomUUID } from "node:crypto";
import { kalshiAuthFetch } from "../kalshiAuth.js";
import { captureOrderbook } from "../orderbookCapture.js";
import { parseKalshiOrderResponse } from "../orderResponseParser.js";
import { easternDay } from "../dailyBudget.js";
import { allowNewInvestment } from "../dailyProfitStop.js";
import { isDogeOrderSubmissionPermitted } from "../tradingKillSwitch.js";
import { logger } from "../logger.js";
import { kalshiFetch } from "../kalshi.js";
import * as dogeStore from "../tradeStore.js";

export interface DogeMarketState {
  ticker: string; openTime: string | null; closeTime: string | null; status: string | null;
}
export const DOGE_DAILY_CAP_CENTS = 100_000;
export const DOGE_PRINCIPALS_CENTS = [1042, 2084, 4168, 8336, 16672] as const;
/** The user-selected DOGE schedule is fixed, not price-dependent recovery sizing. */
export const DOGE_RECOVERY_SIZING = "fixed_five_step_ladder" as const;
/** A pending row has not entered POST yet, so it can be released after this bound. */
export const DOGE_PENDING_RESERVATION_EXPIRY_MS = 60_000;
const active = new Set<string>();

export function isDogeTicker(ticker: string): boolean { return ticker.startsWith("KXDOGE15M"); }
export function isDogeOpeningWindow(openTime: string | null, now = Date.now()): boolean {
  if (!openTime) return false;
  const opened = Date.parse(openTime);
  return Number.isFinite(opened) && now >= opened + 20_000 && now < opened + 25_000;
}
export function dogePrincipalForStep(step: number): number {
  return DOGE_PRINCIPALS_CENTS[Math.max(0, Math.min(4, step))]!;
}
export function dogePreWindowResetAtMs(now = Date.now()): number {
  const marketMs = 15 * 60_000;
  return Math.ceil(now / marketMs) * marketMs - 5_000;
}
/** Kalshi taker fee, rounded up to whole cents as charged by the exchange. */
export function dogeTakerFeeCents(noPriceCents: number, contracts: number): number {
  if (!Number.isInteger(noPriceCents) || noPriceCents < 1 || noPriceCents > 99
    || !Number.isInteger(contracts) || contracts < 1) return 0;
  return Math.ceil(0.07 * contracts * noPriceCents * (100 - noPriceCents) / 100);
}
/**
 * Smallest whole-contract recovery which returns the fixed base target after
 * repaying every prior filled loss (principal and charged/estimated fee).
 */
export function dogeFeeAwareRecoveryContracts(
  noPriceCents: number,
  priorLossCents: number,
  targetProfitCents: number = DOGE_PRINCIPALS_CENTS[0]!,
): number {
  if (!Number.isInteger(noPriceCents) || noPriceCents < 1 || noPriceCents > 99
    || !Number.isInteger(priorLossCents) || priorLossCents < 0
    || !Number.isInteger(targetProfitCents) || targetProfitCents < 1) return 0;
  const requiredNetProfit = priorLossCents + targetProfitCents;
  // A fee is at most 1.75¢/contract, so this bound is comfortably finite.
  for (let contracts = 1; contracts <= requiredNetProfit * 2 + 10_000; contracts++) {
    if (contracts * (100 - noPriceCents) - dogeTakerFeeCents(noPriceCents, contracts) >= requiredNetProfit) {
      return contracts;
    }
  }
  return 0;
}
/** Kalshi's established wire convention for a BUY NO at a NO-side price. */
export function dogeNoOrderPayload(ticker: string, clientOrderId: string, contracts: number, noPrice: number) {
  return {
    ticker, client_order_id: clientOrderId, side: "ask",
    count: `${contracts}.00`, price: ((100 - noPrice) / 100).toFixed(4),
    time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross",
  };
}
/**
 * DOGE execution is retired. Retain reconciliation code and historic data
 * readers, but never let an environment flag reactivate new DOGE exposure.
 */
export function isDogeMartingaleLiveEntryEnabled(): boolean { return false; }
function enabled(): boolean { return isDogeMartingaleLiveEntryEnabled(); }

type DogeDependencies = {
  authFetch: typeof kalshiAuthFetch;
  marketFetch: typeof kalshiFetch;
  captureOrderbook: typeof captureOrderbook;
  allowNewInvestment: typeof allowNewInvestment;
  isDogeOrderSubmissionPermitted: typeof isDogeOrderSubmissionPermitted;
  now: () => number;
  store: Pick<typeof dogeStore,
    "getDogeMartingaleState" | "reserveDogeMartingaleEntry" | "markDogeMartingaleOrderPostStarted"
    | "expireDogeMartingaleReservation" | "updateDogeMartingaleOrder"
    | "listUnsettledDogeMartingaleOrders" | "settleDogeMartingaleOrder" | "resetDogeMartingaleSequence">;
};
const productionDogeDependencies: DogeDependencies = {
  authFetch: kalshiAuthFetch, marketFetch: kalshiFetch, captureOrderbook,
  allowNewInvestment, isDogeOrderSubmissionPermitted, now: () => Date.now(), store: dogeStore,
};
let dogeDependencies = productionDogeDependencies;

/** Test-only seam; production always uses the authenticated exchange and SQL store. */
export function _setDogeNoMartingaleDependenciesForTesting(overrides: Partial<DogeDependencies> | null): void {
  dogeDependencies = overrides == null ? productionDogeDependencies : {
    ...productionDogeDependencies, ...overrides,
    store: overrides.store ?? productionDogeDependencies.store,
  };
}

/** Performs at most one permanently-reserved IOC attempt for a DOGE market. */
export async function evaluateDogeNoMartingale(state: DogeMarketState): Promise<void> {
  if (!enabled() || !isDogeTicker(state.ticker) || !isDogeOpeningWindow(state.openTime, dogeDependencies.now())) return;
  if (!dogeDependencies.isDogeOrderSubmissionPermitted(state.ticker)
    || !(await dogeDependencies.allowNewInvestment(state.ticker)).allowed || active.has(state.ticker)) return;
  active.add(state.ticker);
  try {
    // A martingale is one serial sequence, never concurrent independent bets.
    // Resolve/recover any accepted-or-ambiguous prior IOC first; if it remains
    // unresolved or merely awaits the market result, no later DOGE entry may
    // reserve a fresh step. This prevents duplicate/out-of-order transitions.
    await reconcileDogeMartingaleSettlements();
    if ((await dogeDependencies.store.listUnsettledDogeMartingaleOrders()).length > 0) return;
    const sequence = await dogeDependencies.store.getDogeMartingaleState();
    if (!sequence) return; // storage health is part of the order gate
    const book = await dogeDependencies.captureOrderbook(state.ticker, "no", 99);
    const noPrice = book.lowestLevelCents;
    if (book.error || noPrice == null || noPrice < 1 || noPrice > 99) return;
    // Full-fill-or-skip: compute the complete intended ladder size first, then
    // require the current executable NO-side L2 depth to cover all of it.
    const contracts = Math.floor(dogePrincipalForStep(sequence.martingaleStep) / noPrice);
    if (contracts < 1 || Math.floor(book.depthAtOrBetterContracts) < contracts) return;
    const reservedFeeCents = dogeTakerFeeCents(noPrice, contracts);
    const id = `doge-entry:${state.ticker}`;
    const clientOrderId = `doge-no-${randomUUID()}`;
    const date = easternDay(new Date());
    if (!await dogeDependencies.store.reserveDogeMartingaleEntry({
      ticker: state.ticker, easternDate: date, id, clientOrderId,
      martingaleStep: sequence.martingaleStep, noPriceCents: noPrice,
      requestedContracts: contracts, reservedFeeCents, dailyCapCents: DOGE_DAILY_CAP_CENTS,
    })) return;
    // Do not call POST unless this transition is durable. This makes a stale
    // `pending` row safely distinguishable from a request whose response died.
    if (!await dogeDependencies.store.markDogeMartingaleOrderPostStarted(id)) return;
    try {
      // Final gate immediately before the exchange POST. Unlike an uncertain
      // POST, this path knows no exchange request was made, so release the
      // reservation as a verified zero-fill rather than leaving a false
      // unresolved order behind.
      if (!dogeDependencies.isDogeOrderSubmissionPermitted(state.ticker)) {
        await dogeDependencies.store.updateDogeMartingaleOrder({
          id, filledContracts: 0, filledFeeCents: 0, outcome: "zero_fill",
        });
        return;
      }
      // Kalshi reports a BUY NO as transport side "yes", while the submitted
      // price is still the NO outcome price itself (not its complement).
      const raw = await dogeDependencies.authFetch<Record<string, unknown>>("POST", "/portfolio/events/orders",
        dogeNoOrderPayload(state.ticker, clientOrderId, contracts, noPrice));
      const ack = parseKalshiOrderResponse(raw, contracts);
      const filled = Math.min(contracts, Math.max(0, ack.fillCount));
      await dogeDependencies.store.updateDogeMartingaleOrder({
        id, kalshiOrderId: ack.kalshiOrderId, filledContracts: filled,
        // `fee_cost` is authoritative whenever Kalshi reports it, including
        // a valid zero. The quote-time formula remains the safe fallback for
        // response shapes that omit a fee.
        filledFeeCents: ack.reportedFeeCents ?? dogeTakerFeeCents(noPrice, filled),
        outcome: ack.rejectReason ? "error" : !ack.kalshiOrderId ? "unresolved"
          : filled === 0 ? "zero_fill" : filled === contracts ? "full_fill" : "partial_fill",
      });
    } catch (err) {
      await dogeDependencies.store.updateDogeMartingaleOrder({ id, outcome: "unresolved" });
      logger.error({ err, ticker: state.ticker }, "DOGE NO IOC outcome unknown; permanent reservation retained");
    }
  } finally { active.delete(state.ticker); }
}

/**
 * Persist the T−5 reset. Orders started before this fence still settle for
 * accounting, but cannot reintroduce their old loss progression afterwards.
 */
export async function resetDogeMartingaleBeforeWindow(now = dogeDependencies.now()): Promise<void> {
  const resetAtMs = dogePreWindowResetAtMs(now);
  if (now < resetAtMs || now >= resetAtMs + 5_000) return;
  await dogeDependencies.store.resetDogeMartingaleSequence(resetAtMs);
}

/** Settlement is the only thing that advances or resets the durable sequence. */
export async function reconcileDogeMartingaleSettlements(): Promise<void> {
  for (const order of await dogeDependencies.store.listUnsettledDogeMartingaleOrders()) {
    try {
      if (order.outcome === "pending") {
        if (order.submissionVersion >= 1
          && order.createdAtMs <= dogeDependencies.now() - DOGE_PENDING_RESERVATION_EXPIRY_MS) {
          await dogeDependencies.store.expireDogeMartingaleReservation(
            order.id, dogeDependencies.now() - DOGE_PENDING_RESERVATION_EXPIRY_MS,
          );
        }
        continue;
      }
      if (order.outcome === "post_started" || order.outcome === "unresolved") {
        const recoveredOutcome = await recoverDogeAmbiguousEntry(order);
        if (recoveredOutcome == null || recoveredOutcome === "zero_fill") continue;
      }
      const raw = await dogeDependencies.marketFetch(`/markets/${encodeURIComponent(order.ticker)}`) as Record<string, unknown> | null;
      const market = raw?.["market"] as Record<string, unknown> | undefined;
      const result = market?.["result"];
      if (result === "yes" || result === "no") await dogeDependencies.store.settleDogeMartingaleOrder(order.id, result);
    } catch (err) {
      logger.warn({ err, ticker: order.ticker }, "DOGE settlement reconciliation unavailable");
    }
  }
}

/** Link uncertain POSTs only through an exchange record bearing our client id. */
async function recoverDogeAmbiguousEntry(
  order: Awaited<ReturnType<typeof dogeStore.listUnsettledDogeMartingaleOrders>>[number],
): Promise<"zero_fill" | "partial_fill" | "full_fill" | null> {
  const ordersRaw = await dogeDependencies.authFetch<{ orders?: Array<Record<string, unknown>> }>(
    "GET", `/portfolio/orders?${new URLSearchParams({ ticker: order.ticker, limit: "100" })}`,
  );
  const matching = (ordersRaw.orders ?? []).filter((exchange) =>
    exchange["client_order_id"] === order.clientOrderId && exchange["ticker"] === order.ticker
      && typeof exchange["order_id"] === "string",
  );
  if (matching.length !== 1) return null;
  const kalshiOrderId = String(matching[0]!["order_id"]);
  const detailRaw = await dogeDependencies.authFetch<Record<string, unknown>>(
    "GET", `/portfolio/orders/${encodeURIComponent(kalshiOrderId)}`,
  );
  const exchange = (detailRaw["order"] as Record<string, unknown> | undefined) ?? detailRaw;
  if (exchange["client_order_id"] !== order.clientOrderId || exchange["ticker"] !== order.ticker) return null;
  const ack = parseKalshiOrderResponse({ order: exchange }, order.requestedContracts);
  const explicitFill = exchange["fill_count_fp"] ?? exchange["fill_count"];
  const parsedFill = typeof explicitFill === "number" ? explicitFill
    : typeof explicitFill === "string" ? Number(explicitFill) : NaN;
  const filled = ack.orderStatus === "executed" || ack.orderStatus === "filled"
    ? order.requestedContracts : parsedFill;
  if (!Number.isInteger(filled) || filled < 0) return null;
  const clamped = Math.min(order.requestedContracts, filled);
  const outcome = clamped === 0 ? "zero_fill" : clamped === order.requestedContracts ? "full_fill" : "partial_fill";
  const updated = await dogeDependencies.store.updateDogeMartingaleOrder({
    id: order.id, kalshiOrderId, filledContracts: clamped,
    // Recovered fills use the exchange's reported amount rather than
    // recreating it from the quote. A missing fee is the only fallback case.
    filledFeeCents: ack.reportedFeeCents ?? dogeTakerFeeCents(order.noPriceCents, clamped),
    outcome,
  });
  return updated ? outcome : null;
}