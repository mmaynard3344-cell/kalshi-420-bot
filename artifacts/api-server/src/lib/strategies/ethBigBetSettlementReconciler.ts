import { addDecimalStrings, normalizeKalshiFill, type KalshiFillWire } from "../kalshiFillNormalizer.js";
import { kalshiAuthFetch } from "../kalshiAuth.js";
import { settleEthBigBetOrder } from "./ethBigBetStore.js";
import { adjustProductionEthLongReversalRiskBySourceOrderId, transitionProductionEthLongReversalBySourceOrderId } from "./ethLongReversalExposure.js";

export interface EthBigBetSettlementRow {
  id: string;
  ticker: string;
  side: "yes" | "no";
  kalshiOrderId: string | null;
}

export interface EthBigBetSettlementStore {
  listUnresolvedForTicker(ticker: string): Promise<EthBigBetSettlementRow[]>;
  settle(input: {
    id: string;
    filledContracts: number;
    actualNotionalCents: number;
    actualFeeCents: number;
    fillPriceCents: number | null;
    settlementResult: "yes" | "no";
    realizedPnlCents: number;
  }): Promise<boolean>;
}

interface KalshiOrderWire {
  order_id?: unknown;
  client_order_id?: unknown;
  status?: unknown;
  fill_count?: unknown;
  fill_count_fp?: unknown;
  [key: string]: unknown;
}

interface KalshiOrderResponse { order?: KalshiOrderWire; [key: string]: unknown }
interface KalshiOrdersResponse { orders?: KalshiOrderWire[]; [key: string]: unknown }
interface KalshiFillsResponse { fills?: KalshiFillWire[]; cursor?: unknown; [key: string]: unknown }

type BigBetAuthFetch = <T>(method: string, path: string) => Promise<T>;

const ZERO_FILL_TERMINAL_ORDER_STATUSES = new Set(["canceled", "cancelled"]);
const TERMINAL_ORDER_STATUSES = new Set(["canceled", "cancelled", "executed", "filled"]);

function decimalText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return /^\d+(?:\.\d+)?$/.test(text) ? text : null;
}

function decimalToNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function dollarsToRoundedCents(value: string): number | null {
  const dollars = decimalToNumber(value);
  if (dollars == null) return null;
  const cents = Math.round(dollars * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function orderFillCountExact(order: KalshiOrderWire): string | null {
  return decimalText(order.fill_count_fp ?? order.fill_count);
}

function exactOrderId(order: KalshiOrderWire): string | null {
  return typeof order.order_id === "string" && order.order_id.trim() ? order.order_id : null;
}

async function resolveOrder(
  row: EthBigBetSettlementRow,
  authFetch: BigBetAuthFetch,
): Promise<KalshiOrderWire | null> {
  if (row.kalshiOrderId) {
    const response = await authFetch<KalshiOrderResponse>("GET", `/portfolio/orders/${encodeURIComponent(row.kalshiOrderId)}`);
    const order = response?.order;
    return order && exactOrderId(order) === row.kalshiOrderId ? order : null;
  }

  // Ambiguous POST recovery is fail-closed: discover by the immutable client
  // order ID, but never interpret an absent response as authoritative rejection.
  const response = await authFetch<KalshiOrdersResponse>(
    "GET",
    `/portfolio/orders?client_order_id=${encodeURIComponent(row.id)}&limit=10`,
  );
  const matches = Array.isArray(response?.orders)
    ? response.orders.filter((order) => order.client_order_id === row.id && exactOrderId(order) != null)
    : [];
  return matches.length === 1 ? matches[0] : null;
}

async function fetchAllOrderFills(
  orderId: string,
  authFetch: BigBetAuthFetch,
): Promise<KalshiFillWire[] | null> {
  const all: KalshiFillWire[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const path: string = `/portfolio/fills?order_id=${encodeURIComponent(orderId)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response: KalshiFillsResponse = await authFetch<KalshiFillsResponse>("GET", path);
    if (!Array.isArray(response?.fills)) return null;
    all.push(...response.fills);
    const next: string | null = typeof response.cursor === "string" && response.cursor.trim() ? response.cursor : null;
    if (!next) return all;
    if (seen.has(next)) return null;
    seen.add(next);
    cursor = next;
  }
  return null;
}

export interface EthBigBetTerminalExposureEvidence {
  terminalStatus: string;
  filledContracts: number;
  actualNotionalCents: number;
  actualFeeCents: number;
  activeRiskCents: number;
  terminalZeroFill: boolean;
}

/**
 * Read terminal pre-settlement exposure using authenticated order/fill evidence.
 * Open/resting partial fills intentionally return null so their full original
 * reservation remains active: the unfilled remainder can still execute.
 */
export async function readEthBigBetTerminalExposureEvidence(input: {
  row: EthBigBetSettlementRow;
  authFetch?: BigBetAuthFetch;
}): Promise<EthBigBetTerminalExposureEvidence | null> {
  const authFetch = input.authFetch ?? (kalshiAuthFetch as unknown as BigBetAuthFetch);
  let order: KalshiOrderWire;
  try {
    const resolved = await resolveOrder(input.row, authFetch);
    if (!resolved) return null;
    order = resolved;
  } catch {
    return null;
  }

  const status = typeof order.status === "string" ? order.status.toLowerCase() : "";
  if (!TERMINAL_ORDER_STATUSES.has(status)) return null;

  const fillCountExact = orderFillCountExact(order);
  if (fillCountExact == null) return null;
  const authoritativeFilled = decimalToNumber(fillCountExact);
  if (authoritativeFilled == null) return null;
  const orderId = exactOrderId(order);
  if (!orderId) return null;

  if (authoritativeFilled === 0) {
    if (!ZERO_FILL_TERMINAL_ORDER_STATUSES.has(status)) return null;
    return {
      terminalStatus: status,
      filledContracts: 0,
      actualNotionalCents: 0,
      actualFeeCents: 0,
      activeRiskCents: 0,
      terminalZeroFill: true,
    };
  }

  let fills: KalshiFillWire[] | null;
  try {
    fills = await fetchAllOrderFills(orderId, authFetch);
  } catch {
    return null;
  }
  if (!fills || fills.length === 0) return null;

  let contractsExact = "0";
  let costDollarsExact = "0";
  let feeDollarsExact = "0";
  for (const fill of fills) {
    const normalized = normalizeKalshiFill(fill, input.row.side);
    if (!normalized) return null;
    contractsExact = addDecimalStrings(contractsExact, normalized.contractsExact);
    costDollarsExact = addDecimalStrings(costDollarsExact, normalized.exactCostDollars);
    feeDollarsExact = addDecimalStrings(feeDollarsExact, normalized.exactFeeDollars);
  }
  const filledContracts = decimalToNumber(contractsExact);
  if (filledContracts == null || Math.abs(filledContracts - authoritativeFilled) > 1e-9) return null;
  const actualNotionalCents = dollarsToRoundedCents(costDollarsExact);
  const actualFeeCents = dollarsToRoundedCents(feeDollarsExact);
  if (actualNotionalCents == null || actualFeeCents == null) return null;
  const activeRiskCents = actualNotionalCents + actualFeeCents;
  if (!Number.isSafeInteger(activeRiskCents) || activeRiskCents <= 0) return null;

  return {
    terminalStatus: status,
    filledContracts,
    actualNotionalCents,
    actualFeeCents,
    activeRiskCents,
    terminalZeroFill: false,
  };
}

export async function refreshEthBigBetLongReversalExposureForTicker(input: {
  ticker: string;
  store: Pick<EthBigBetSettlementStore, "listUnresolvedForTicker">;
  authFetch?: BigBetAuthFetch;
  adjustRisk?: typeof adjustProductionEthLongReversalRiskBySourceOrderId;
}): Promise<{ adjusted: number; retained: number }> {
  if (!/^KXETH15M-/.test(input.ticker)) return { adjusted: 0, retained: 0 };
  let rows: EthBigBetSettlementRow[];
  try {
    rows = await input.store.listUnresolvedForTicker(input.ticker);
  } catch {
    return { adjusted: 0, retained: 1 };
  }
  const adjustRisk = input.adjustRisk ?? adjustProductionEthLongReversalRiskBySourceOrderId;
  let adjusted = 0;
  let retained = 0;
  for (const row of rows) {
    const evidence = await readEthBigBetTerminalExposureEvidence({
      row,
      authFetch: input.authFetch,
    });
    if (!evidence) {
      retained++;
      continue;
    }
    try {
      const wrote = await adjustRisk({
        sourceOrderId: row.id,
        activeRiskCents: evidence.activeRiskCents,
        filledContracts: evidence.filledContracts,
        actualNotionalCents: evidence.actualNotionalCents,
        actualFeeCents: evidence.actualFeeCents,
        terminalZeroFill: evidence.terminalZeroFill,
        reason: evidence.terminalZeroFill
          ? "authoritative_terminal_zero_fill"
          : "authoritative_terminal_fill_evidence",
      });
      if (wrote) adjusted++;
      else retained++;
    } catch {
      retained++;
    }
  }
  return { adjusted, retained };
}

export interface EthBigBetSettlementEconomics {
  filledContracts: number;
  actualNotionalCents: number;
  actualFeeCents: number;
  fillPriceCents: number | null;
  realizedPnlCents: number;
}

/**
 * Build auditable settlement economics. Empty fills are accepted only when the
 * authenticated order itself proves an authoritative terminal zero fill.
 * Nonzero fills must completely match the order's authoritative fill count and
 * every fill must carry valid price + fee evidence.
 */
export async function readEthBigBetSettlementEconomics(input: {
  row: EthBigBetSettlementRow;
  officialResult: "yes" | "no";
  authFetch?: BigBetAuthFetch;
}): Promise<EthBigBetSettlementEconomics | null> {
  const authFetch = input.authFetch ?? (kalshiAuthFetch as unknown as BigBetAuthFetch);
  let order: KalshiOrderWire;
  try {
    const resolved = await resolveOrder(input.row, authFetch);
    if (!resolved) return null;
    order = resolved;
  } catch {
    return null;
  }

  const fillCountExact = orderFillCountExact(order);
  if (fillCountExact == null) return null;
  const authoritativeFilled = decimalToNumber(fillCountExact);
  if (authoritativeFilled == null) return null;
  const orderId = exactOrderId(order);
  if (!orderId) return null;

  if (authoritativeFilled === 0) {
    const status = typeof order.status === "string" ? order.status.toLowerCase() : "";
    if (!ZERO_FILL_TERMINAL_ORDER_STATUSES.has(status)) return null;
    return {
      filledContracts: 0,
      actualNotionalCents: 0,
      actualFeeCents: 0,
      fillPriceCents: null,
      realizedPnlCents: 0,
    };
  }

  let fills: KalshiFillWire[] | null;
  try {
    fills = await fetchAllOrderFills(orderId, authFetch);
  } catch {
    return null;
  }
  if (!fills || fills.length === 0) return null;

  let contractsExact = "0";
  let costDollarsExact = "0";
  let feeDollarsExact = "0";
  for (const fill of fills) {
    const normalized = normalizeKalshiFill(fill, input.row.side);
    if (!normalized) return null;
    contractsExact = addDecimalStrings(contractsExact, normalized.contractsExact);
    costDollarsExact = addDecimalStrings(costDollarsExact, normalized.exactCostDollars);
    feeDollarsExact = addDecimalStrings(feeDollarsExact, normalized.exactFeeDollars);
  }

  const filledContracts = decimalToNumber(contractsExact);
  if (filledContracts == null || Math.abs(filledContracts - authoritativeFilled) > 1e-9) return null;
  const actualNotionalCents = dollarsToRoundedCents(costDollarsExact);
  const actualFeeCents = dollarsToRoundedCents(feeDollarsExact);
  if (actualNotionalCents == null || actualFeeCents == null) return null;

  const averagePriceCents = filledContracts > 0
    ? Math.round(actualNotionalCents / filledContracts)
    : null;
  if (averagePriceCents == null || averagePriceCents < 0 || averagePriceCents > 100) return null;
  const payoutCents = input.officialResult === input.row.side
    ? Math.round(filledContracts * 100)
    : 0;
  const realizedPnlCents = payoutCents - actualNotionalCents - actualFeeCents;
  if (!Number.isSafeInteger(realizedPnlCents)) return null;

  return {
    filledContracts,
    actualNotionalCents,
    actualFeeCents,
    fillPriceCents: averagePriceCents,
    realizedPnlCents,
  };
}

/**
 * Accounting-only reconciler. It never reads or mutates martingale state and
 * never gates evaluation of a later B/C market. Incomplete evidence simply
 * leaves the row unresolved, retaining its capital reservation fail-closed.
 */
export async function reconcileEthBigBetAccountingForTicker(input: {
  ticker: string;
  officialResult: "yes" | "no";
  store: EthBigBetSettlementStore;
  authFetch?: BigBetAuthFetch;
}): Promise<{ settled: number; unresolved: number }> {
  if (!/^KXETH15M-/.test(input.ticker)) return { settled: 0, unresolved: 0 };
  let rows: EthBigBetSettlementRow[];
  try {
    rows = await input.store.listUnresolvedForTicker(input.ticker);
  } catch {
    return { settled: 0, unresolved: 1 };
  }
  let settled = 0;
  let unresolved = 0;
  for (const row of rows) {
    const economics = await readEthBigBetSettlementEconomics({
      row,
      officialResult: input.officialResult,
      authFetch: input.authFetch,
    });
    if (!economics) {
      unresolved++;
      continue;
    }
    try {
      const wrote = await input.store.settle({
        id: row.id,
        ...economics,
        settlementResult: input.officialResult,
      });
      if (wrote) {
        // Authoritative final settlement (including terminal zero-fill) releases
        // correlated long-reversal capacity. Non-member orders have no matching
        // reservation and therefore leave this as a harmless false result.
        await transitionProductionEthLongReversalBySourceOrderId({
          sourceOrderId: row.id,
          to: "settled",
        }).catch(() => false);
        settled++;
      } else unresolved++;
    } catch {
      unresolved++;
    }
  }
  return { settled, unresolved };
}

/** Production store adapter is imported lazily by the outcome sidecar. */
export async function reconcilePersistedEthBigBetsForTicker(
  ticker: string,
  officialResult: "yes" | "no",
): Promise<{ settled: number; unresolved: number }> {
  const { listUnresolvedEthBigBetSettlementRowsForTicker } = await import("./ethBigBetSettlementStore.js");
  return reconcileEthBigBetAccountingForTicker({
    ticker,
    officialResult,
    store: {
      listUnresolvedForTicker: listUnresolvedEthBigBetSettlementRowsForTicker,
      settle: settleEthBigBetOrder,
    },
  });
}
