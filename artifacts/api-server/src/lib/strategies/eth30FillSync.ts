/**
 * Pure planning logic for the canonical ETH_30_50 fill-event ledger.
 *
 * Position events must reflect actual exchange execution prices per chunk —
 * never the book-lowest or limit price the strategy happened to submit at.
 * A single IOC entry can sweep multiple L2 levels; a resting 50¢ target can
 * fill in several chunks.
 *
 * The fill-event ledger is REBUILT deterministically from authoritative
 * Kalshi fill chunks (GET /portfolio/fills?order_id=…), each keyed by the
 * exchange-assigned fill UUID. Legacy approximate events (recorded at ack
 * time from book/limit prices before chunk evidence existed) are never
 * blended with chunk events — blending would require overlap arithmetic that
 * cannot be made contract-safe when a legacy total falls inside a chunk.
 * Instead they are deleted and replaced wholesale, and settlement stays
 * deferred until every filled order is fully covered by chunk evidence.
 */
import type { Eth30PositionEventParams } from "../tradeStore.js";
import { normalizeKalshiFill, type KalshiFillWire } from "../kalshiFillNormalizer.js";

/** Note marking an event as authoritative per-chunk exchange evidence. */
export const CHUNK_EVIDENCE_NOTE = "exchange_fill_chunk";

export function isChunkFillEvent(ev: Eth30PositionEventParams): boolean {
  return (ev.eventType === "entry_fill" || ev.eventType === "exit_fill")
    && ev.note === CHUNK_EVIDENCE_NOTE;
}

function isFillEvent(ev: Eth30PositionEventParams): boolean {
  return ev.eventType === "entry_fill" || ev.eventType === "exit_fill";
}

export interface Eth30OwnedOrderRef {
  /** eth30_strategy_orders.id — "entry:{ticker}" or "exit:{ticker}:{seq}". */
  id:          string;
  ticker:      string;
  easternDate: string;
  role:        "entry" | "exit";
  /** Order-row fill total from the ack/status endpoint, if known. */
  filledContracts: number | null;
}

export interface AuthoritativeFillChunk {
  /** Kalshi exchange-assigned fill UUID; chunks without one are unusable. */
  fillId:         string;

  contracts:      number;
  /** Actual held-side execution price for THIS chunk. */

  fillPriceCents: number;
  /** Kalshi exchange fee for this chunk in cents (rounded). Null only when the
   *  fills API did not return fee data (should not happen for canonical chunks). */

  feeCents:       number | null;

  occurredAtMs:   number;
}

/**
 * Convert raw Kalshi fills wire records into authoritative fill chunks for one
 * owned order.  Wire records missing a fill ID or any normalizable field are
 * silently dropped — the caller must verify the resulting length covers the
 * exchange-reported fill total before accepting the set as complete evidence.
 *
 * Extracted from fetchOwnedFillChunks so it can be unit-tested independently
 * of the HTTP transport layer.
 */
export function buildAuthoritativeFillChunks(
  fills: KalshiFillWire[],
  side: "yes" | "no",
  nowMs = Date.now(),
): AuthoritativeFillChunk[] {
  return fills.flatMap((wire) => {
    const normalized = normalizeKalshiFill(wire, side);
    if (!normalized || !normalized.fillId) return [];
    const ts = normalized.fillTimestamp ? Date.parse(normalized.fillTimestamp) : NaN;
    return [{
      fillId: normalized.fillId,
      contracts: normalized.contracts,
      fillPriceCents: normalized.fillPriceCents,
      feeCents: Math.round(normalized.feeDollars * 100),
      occurredAtMs: Number.isFinite(ts) ? ts : nowMs,
    }];
  });
}

export interface CanonicalLedgerPlan {
  /** Filled orders whose authoritative chunks are missing or incomplete. */
  deferredOrderIds: string[];
  /** Existing fill-event ids to delete (legacy approximations or stale rows). */
  deleteIds: string[];
  /** Canonical chunk events to append, in chronological order. */
  appends: Eth30PositionEventParams[];
}

/**
 * Plan the canonical fill-event ledger for one ticker.
 *
 * If any filled order lacks complete chunk coverage (fetch failed or the
 * chunks sum to less than the exchange-reported fill total), NOTHING is
 * written — the whole ticker is deferred so a partial rebuild can never
 * misstate the running position. Otherwise the canonical set is computed
 * from chunks alone (chronological, running position recomputed from zero)
 * and diffed against the existing events: extraneous/legacy fill events are
 * deleted, missing canonical events appended. Replaying the same inputs is a
 * no-op.
 */
export function planCanonicalFillLedger(
  orders:         Eth30OwnedOrderRef[],
  existingEvents: Eth30PositionEventParams[],
  chunksByOrder:  Map<string, AuthoritativeFillChunk[] | null>,
): CanonicalLedgerPlan {
  const filledOrders = orders.filter((o) => (o.filledContracts ?? 0) > 0);
  const deferred: string[] = [];
  const canonicalInputs: Array<{ order: Eth30OwnedOrderRef; chunk: AuthoritativeFillChunk }> = [];
  for (const order of filledOrders) {
    const chunks = (chunksByOrder.get(order.id) ?? null)?.filter((c) => c.fillId && c.contracts > 0) ?? null;
    const covered = chunks?.reduce((sum, c) => sum + c.contracts, 0) ?? 0;
    if (chunks === null || covered < (order.filledContracts ?? 0)) {
      deferred.push(order.id);
      continue;
    }
    for (const chunk of chunks) canonicalInputs.push({ order, chunk });
  }
  if (deferred.length > 0) return { deferredOrderIds: deferred, deleteIds: [], appends: [] };

  canonicalInputs.sort((a, b) =>
    a.chunk.occurredAtMs - b.chunk.occurredAtMs
    || (a.order.role === b.order.role ? 0 : a.order.role === "entry" ? -1 : 1)
    || a.chunk.fillId.localeCompare(b.chunk.fillId));

  let running = 0;
  const canonical: Eth30PositionEventParams[] = canonicalInputs.map(({ order, chunk }) => {
    const signedDelta = order.role === "exit" ? -chunk.contracts : chunk.contracts;
    running = Math.max(0, running + signedDelta);
    return {
      id: `${order.ticker}:${order.role}_fill:${chunk.fillId}`,
      ticker: order.ticker,
      easternDate: order.easternDate,
      eventType: order.role === "exit" ? "exit_fill" : "entry_fill",
      contractsDelta: signedDelta,
      contractsAfter: running,
      strategyOrderId: order.id,
      fillPriceCents: chunk.fillPriceCents,
      feeCents: chunk.feeCents,
      settlementResult: null,
      note: CHUNK_EVIDENCE_NOTE,
      occurredAtMs: chunk.occurredAtMs,
    };
  });

  const canonicalIds = new Set(canonical.map((ev) => ev.id));
  // Index existing chunk events by id so we can check their current feeCents.
  const existingChunkById = new Map(
    existingEvents.filter(isChunkFillEvent).map((ev) => [ev.id, ev]),
  );
  return {
    deferredOrderIds: [],
    deleteIds: existingEvents
      .filter((ev) => isFillEvent(ev) && (!isChunkFillEvent(ev) || !canonicalIds.has(ev.id)))
      .map((ev) => ev.id),
    // Append events that are either:
    //   (a) new — not yet in the DB, or
    //   (b) existing canonical chunks whose fee_cents is NULL and for which the
    //       authoritative chunk now supplies a fee — triggers the DO UPDATE path
    //       in appendEth30PositionEvent to backfill the fee without changing
    //       any other field.
    appends: canonical.filter((ev) => {
      const existing = existingChunkById.get(ev.id);
      if (!existing) return true; // (a) new event
      return existing.feeCents === null && ev.feeCents !== null; // (b) fee backfill
    }),
  };
}

/**
 * Settlement gate: settlement may only be recorded once every filled owned
 * order is fully evidenced by authoritative CHUNK events and no legacy
 * approximate fill events remain. Otherwise a target fill that happened while
 * the server was running (or a legacy approximation at the wrong price) would
 * cause settlement to close out — and potentially pay out — contracts that
 * were already sold.
 */
export function settlementReadiness(
  orders: Array<Pick<Eth30OwnedOrderRef, "id" | "filledContracts">>,
  events: Eth30PositionEventParams[],
): { ready: boolean; openContracts: number; missingOrderIds: string[]; hasLegacyEvents: boolean } {
  const hasLegacyEvents = events.some((ev) => isFillEvent(ev) && !isChunkFillEvent(ev));
  const missing: string[] = [];
  for (const order of orders) {
    const filled = order.filledContracts ?? 0;
    if (filled <= 0) continue;
    const recorded = events
      .filter((ev) => isChunkFillEvent(ev) && ev.strategyOrderId === order.id)
      .reduce((sum, ev) => sum + Math.abs(ev.contractsDelta), 0);
    if (recorded < filled) missing.push(order.id);
  }
  return {
    ready: missing.length === 0 && !hasLegacyEvents,
    openContracts: Math.max(0, events.at(-1)?.contractsAfter ?? 0),
    missingOrderIds: missing,
    hasLegacyEvents,
  };
}
