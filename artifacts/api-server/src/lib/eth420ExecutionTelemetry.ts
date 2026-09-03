/**
 * Passive, bounded execution evidence for ETH420 candidate orders.
 * Nothing in this module is read by reservation, submission, settlement, or strategy decisions.
 */
import { kalshiAuthFetch } from "./kalshiAuth.js";
import { captureOrderbook } from "./orderbookCapture.js";
import { parseExitSellBids, parseOrderbookResponse } from "./orderbookParsing.js";
import type { Eth420CandidateLiveOrder, Eth420CandidateExecutionSnapshot } from "./tradeStore.js";

export const ETH420_EXECUTION_SNAPSHOT_OFFSETS_MS = [0, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000] as const;
let telemetryAuthFetch = kalshiAuthFetch;
let telemetryOrderbookCapture = captureOrderbook;

/** Test-only dependency seam; production readers are restored when null. */
export function _setEth420ExecutionTelemetryReadersForTesting(readers: {
  authFetch?: typeof kalshiAuthFetch;
  orderbookCapture?: typeof captureOrderbook;
} | null): void {
  telemetryAuthFetch = readers?.authFetch ?? kalshiAuthFetch;
  telemetryOrderbookCapture = readers?.orderbookCapture ?? captureOrderbook;
}

export interface Eth420ExecutionTelemetryStore {
  recordEth420CandidateExecutionSnapshot(snapshot: Eth420CandidateExecutionSnapshot): Promise<boolean>;
  listRecentUnsettledEth420CandidateLiveOrders(sinceMs: number): Promise<Eth420CandidateLiveOrder[]>;
  getEth420CandidateLiveOrder(id: string): Promise<Eth420CandidateLiveOrder | null>;
}

type Timer = ReturnType<typeof setTimeout>;
const armed = new Set<string>();

function requestedSizePrice(levels: Array<{ priceCents: number; contractsApprox: number }>, requested: number): number | null {
  let available = 0;
  for (const level of levels) {
    available += level.contractsApprox;
    if (available >= requested) return level.priceCents;
  }
  return null;
}

function parseFilledContracts(order: Record<string, unknown>): number | null {
  const value = order["fill_count_fp"] ?? order["filled_count"] ?? order["filled_contracts"];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

async function readOrder(order: Eth420CandidateLiveOrder): Promise<{ status: string; filled: number | null }> {
  if (!order.kalshiOrderId) return { status: "unavailable", filled: null };
  try {
    const response = await telemetryAuthFetch<{ order?: Record<string, unknown> }>(
      "GET", `/portfolio/orders/${encodeURIComponent(order.kalshiOrderId)}`,
    );
    const raw = response.order;
    if (!raw || String(raw["order_id"] ?? "") !== order.kalshiOrderId
      || String(raw["client_order_id"] ?? "") !== order.id || String(raw["ticker"] ?? "") !== order.ticker) {
      return { status: "unavailable", filled: null };
    }
    const status = typeof raw["status"] === "string" && raw["status"] ? raw["status"] : "unavailable";
    return { status, filled: parseFilledContracts(raw) };
  } catch {
    return { status: "unavailable", filled: null };
  }
}

async function capture(store: Eth420ExecutionTelemetryStore, order: Eth420CandidateLiveOrder,
  offsetMs: number, scheduledAtMs: number, state: "captured" | "missed_on_restart"): Promise<void> {
  const currentOrder = await store.getEth420CandidateLiveOrder(order.id) ?? order;
  const snapshotId = `${currentOrder.id}:execution:${offsetMs}`;
  if (state === "missed_on_restart") {
    await store.recordEth420CandidateExecutionSnapshot({
      snapshotId, candidateOrderId: currentOrder.id, ticker: currentOrder.ticker, scheduledOffsetMs: offsetMs, scheduledAtMs,
      observedAtMs: Date.now(), selectedSide: currentOrder.side, requestedContracts: currentOrder.requestedContracts,
      kalshiOrderId: currentOrder.kalshiOrderId, orderStatus: "unavailable", filledContracts: null,
      selectedBestBidCents: null, selectedBestAskCents: null, depthAt50Contracts: null,
      fullSizeExecutablePriceCents: null, quoteAgeMs: null, quoteFreshness: "unavailable", observationState: state,
    });
    return;
  }
  const [book, authenticated] = await Promise.all([
    telemetryOrderbookCapture(currentOrder.ticker, currentOrder.side, 50),
    readOrder(currentOrder),
  ]);
  const asks = book.error ? [] : parseOrderbookResponse({
    orderbook_fp: { yes_dollars: book.rawYesDollars, no_dollars: book.rawNoDollars },
  }, currentOrder.side);
  const bids = book.error ? [] : parseExitSellBids({
    orderbook_fp: { yes_dollars: book.rawYesDollars, no_dollars: book.rawNoDollars },
  }, currentOrder.side);
  const quoteAvailable = !book.error;
  await store.recordEth420CandidateExecutionSnapshot({
    snapshotId, candidateOrderId: currentOrder.id, ticker: currentOrder.ticker, scheduledOffsetMs: offsetMs, scheduledAtMs, observedAtMs: Date.now(),
    selectedSide: currentOrder.side, requestedContracts: currentOrder.requestedContracts, kalshiOrderId: currentOrder.kalshiOrderId,
    orderStatus: authenticated.status, filledContracts: authenticated.filled,
    selectedBestBidCents: bids.at(-1)?.priceCents ?? null,
    selectedBestAskCents: asks[0]?.priceCents ?? null,
    depthAt50Contracts: quoteAvailable ? book.depthAtOrBetterContracts : null,
    fullSizeExecutablePriceCents: quoteAvailable ? requestedSizePrice(asks, currentOrder.requestedContracts) : null,
    // The public orderbook response has no exchange quote timestamp. Do not
    // misrepresent HTTP latency as quote age or freshness.
    quoteAgeMs: null, quoteFreshness: "unavailable",
    observationState: state,
  });
}

/** Test-only direct runner; production uses the seven-offset scheduler. */
export async function _captureEth420CandidateExecutionSnapshotForTesting(
  store: Eth420ExecutionTelemetryStore, order: Eth420CandidateLiveOrder, offsetMs: number,
): Promise<void> {
  await capture(store, order, offsetMs, order.createdAtMs + offsetMs, "captured");
}

/** Schedules exactly seven fire-and-forget, unref'd observations. */
export function scheduleEth420CandidateExecutionTelemetry(
  store: Eth420ExecutionTelemetryStore, order: Eth420CandidateLiveOrder, reservationAtMs = Date.now(), resumeOnly = false,
): void {
  for (const offsetMs of ETH420_EXECUTION_SNAPSHOT_OFFSETS_MS) {
    const key = `${order.id}:${offsetMs}`;
    if (armed.has(key)) continue;
    armed.add(key);
    const scheduledAtMs = reservationAtMs + offsetMs;
    if (resumeOnly && scheduledAtMs < Date.now()) {
      armed.delete(key);
      continue;
    }
    const delayMs = Math.max(0, scheduledAtMs - Date.now());
    const timer: Timer = setTimeout(() => {
      armed.delete(key);
      void capture(store, order, offsetMs, scheduledAtMs, "captured");
    }, delayMs);
    timer.unref();
  }
}

/** On restart, record elapsed offsets as unavailable and re-arm only remaining offsets. */
export async function resumeEth420CandidateExecutionTelemetry(store: Eth420ExecutionTelemetryStore): Promise<void> {
  const now = Date.now();
  const orders = await store.listRecentUnsettledEth420CandidateLiveOrders(now - ETH420_EXECUTION_SNAPSHOT_OFFSETS_MS.at(-1)!);
  for (const order of orders) {
    for (const offsetMs of ETH420_EXECUTION_SNAPSHOT_OFFSETS_MS) {
      const scheduledAtMs = order.createdAtMs + offsetMs;
      if (scheduledAtMs < now) void capture(store, order, offsetMs, scheduledAtMs, "missed_on_restart");
    }
    scheduleEth420CandidateExecutionTelemetry(store, order, order.createdAtMs, true);
  }
}