/**
 * Passive ETH420 boundary evidence. This module is deliberately isolated from
 * every order path: it only reads public quotes/books and appends diagnostics.
 */
import { captureOrderbook } from "./orderbookCapture.js";
import type { OrderbookSnapshot } from "./orderbookCapture.js";
import { getKrakenPrices } from "./krakenPrices.js";
import type { KrakenPriceSnapshot } from "./krakenPrices.js";
import { kalshiFetch } from "./kalshi.js";
import * as store from "./tradeStore.js";

export const ETH420_BOUNDARY_ANCHORS = [
  ["prior_close_minus_10s", -10_000], ["prior_close_minus_5s", -5_000],
  ["prior_close_minus_2s", -2_000], ["boundary_close", 0],
  ["boundary_open", 0], ["open_plus_1s", 1_000], ["open_plus_2s", 2_000],
  ["open_plus_5s", 5_000], ["open_plus_10s", 10_000],
] as const;
const timerKeys = new Set<string>();
const LADDER_SIZES = [30, 60, 120, 240, 480, 640, 960];
const BBO_MAX_AGE_MS = 15_000;
const SPOT_MAX_AGE_MS = 15_000;

export type BoundaryMarket = {
  ticker: string; openTime: string | null; closeTime: string | null;
  exchangeIndex?: number | null; yesBid: number | null; yesAsk: number | null;
  noBid: number | null; noAsk: number | null; bidUpdatedMs: number;
};

function validTime(value: string | null): number | null {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function cents(value: number | null): number | null {
  return Number.isInteger(value) && value! >= 1 && value! <= 99 ? value : null;
}

type BoundaryResearchDependencies = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => { unref?: () => void };
  captureOrderbook: (ticker: string, side: "yes" | "no", limitCents: number) => Promise<OrderbookSnapshot>;
  getKrakenPrices: (nowMs: number) => Promise<KrakenPriceSnapshot>;
  getFreshMarket: (ticker: string) => Promise<BoundaryMarket | null>;
  discoverMarketAtOpen: (openMs: number) => Promise<BoundaryMarket | null>;
  findCandidate: typeof store.findEth420CandidateLiveOrderByTicker;
  recordSnapshot: typeof store.recordEth420BoundaryResearchSnapshot;
};

function dollarsToCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const dollars = Number(value);
  return Number.isFinite(dollars) ? cents(Math.round(dollars * 100)) : null;
}

function boundaryMarketFromRaw(raw: unknown): BoundaryMarket | null {
  if (!raw || typeof raw !== "object") return null;
  const market = raw as Record<string, unknown>;
  const ticker = market["ticker"];
  const openTime = market["open_time"];
  const closeTime = market["close_time"];
  if (typeof ticker !== "string" || typeof openTime !== "string" || typeof closeTime !== "string") return null;
  return {
    ticker,
    openTime,
    closeTime,
    exchangeIndex: Number.isInteger(market["exchange_index"]) ? Number(market["exchange_index"]) : null,
    yesBid: dollarsToCents(market["yes_bid_dollars"] ?? market["yes_bid"]),
    yesAsk: dollarsToCents(market["yes_ask_dollars"] ?? market["yes_ask"]),
    noBid: dollarsToCents(market["no_bid_dollars"] ?? market["no_bid"]),
    noAsk: dollarsToCents(market["no_ask_dollars"] ?? market["no_ask"]),
    // A direct market read is a capture-time BBO observation, never stream state.
    bidUpdatedMs: Date.now(),
  };
}

const defaultDependencies: BoundaryResearchDependencies = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  captureOrderbook,
  getKrakenPrices,
  getFreshMarket: async (ticker) => {
    try {
      const response = await kalshiFetch<{ market?: unknown }>(`/markets/${ticker}`);
      return boundaryMarketFromRaw(response.market ?? response);
    } catch {
      return null;
    }
  },
  discoverMarketAtOpen: async (openMs) => {
    try {
      const response = await kalshiFetch<{ markets?: unknown[] }>("/markets", {
        series_ticker: "KXETH15M", status: "open", limit: 10,
      });
      const market = (response.markets ?? [])
        .map(boundaryMarketFromRaw)
        .find((candidate): candidate is BoundaryMarket => candidate != null && validTime(candidate.openTime) === openMs);
      return market ?? null;
    } catch {
      return null;
    }
  },
  findCandidate: store.findEth420CandidateLiveOrderByTicker,
  recordSnapshot: store.recordEth420BoundaryResearchSnapshot,
};
let dependencies = defaultDependencies;

/** Test-only dependency seam; production always uses the public-data readers above. */
export function _setEth420BoundaryResearchDependenciesForTesting(overrides: Partial<BoundaryResearchDependencies> | null): void {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
}
/** Test-only timer reset, mirroring a fresh process after a server restart. */
export function _resetEth420BoundaryResearchForTesting(): void {
  timerKeys.clear();
  dependencies = defaultDependencies;
}

function validL2(book: OrderbookSnapshot): boolean {
  const validLevel = (level: unknown): level is [string, string] => Array.isArray(level)
    && level.length === 2
    && typeof level[0] === "string" && typeof level[1] === "string"
    && Number.isFinite(Number(level[0])) && Number(level[0]) >= 0 && Number(level[0]) <= 1
    && Number.isFinite(Number(level[1])) && Number(level[1]) >= 0;
  return !book.error && Array.isArray(book.rawYesDollars) && Array.isArray(book.rawNoDollars)
    && book.rawYesDollars.every(validLevel) && book.rawNoDollars.every(validLevel);
}

function hasCompleteBbo(market: BoundaryMarket | null | undefined): market is BoundaryMarket {
  return market != null
    && cents(market.yesBid) != null && cents(market.yesAsk) != null
    && cents(market.noBid) != null && cents(market.noAsk) != null;
}

async function capture(anchor: string, scheduledAtMs: number, market: BoundaryMarket, getCurrent: () => BoundaryMarket | undefined): Promise<void> {
  const actualAtMs = dependencies.now();
  const current = getCurrent();
  const [link, freshMarket, yesBook, noBook, spot] = await Promise.all([
    dependencies.findCandidate(market.ticker),
    dependencies.getFreshMarket(market.ticker),
    dependencies.captureOrderbook(market.ticker, "yes", 99), dependencies.captureOrderbook(market.ticker, "no", 99),
    dependencies.getKrakenPrices(actualAtMs).catch(() => null),
  ]);
  const streamState = current && current.ticker === market.ticker ? current : undefined;
  // A fresh public market read is authoritative for a boundary BBO. Stream
  // state remains a fail-closed fallback only when it is complete and fresh.
  const state = hasCompleteBbo(freshMarket) ? freshMarket : streamState;
  const yesBid = cents(state?.yesBid ?? null), yesAsk = cents(state?.yesAsk ?? null);
  const noBid = cents(state?.noBid ?? null), noAsk = cents(state?.noAsk ?? null);
  const openMs = validTime(market.openTime), closeMs = validTime(market.closeTime);
  const quality: string[] = [];
  if (!state) quality.push("market_state_missing");
  if (yesBid == null || yesAsk == null || noBid == null || noAsk == null) quality.push("malformed_or_missing_bbo");
  if (!state || !Number.isFinite(state.bidUpdatedMs) || state.bidUpdatedMs > actualAtMs || actualAtMs - state.bidUpdatedMs > BBO_MAX_AGE_MS) quality.push("bbo_unavailable_or_stale");
  if (actualAtMs - scheduledAtMs > 1_500) quality.push("anchor_late");
  if (!validL2(yesBook) || !validL2(noBook)) quality.push("l2_unavailable_or_malformed");
  if (!spot || !Number.isFinite(spot.eth) || spot.eth <= 0 || !Number.isFinite(spot.cacheAgeMs)
    || spot.cacheAgeMs < 0 || spot.cacheAgeMs > SPOT_MAX_AGE_MS) quality.push("spot_unavailable_or_stale");
  if (!link || link.side == null || link.requestedContracts == null || link.filledContracts == null) quality.push("candidate_link_ambiguous");
  await dependencies.recordSnapshot({
    id: `${market.ticker}:${anchor}:${scheduledAtMs}`, ticker: market.ticker, anchor,
    marketOpenMs: openMs, marketCloseMs: closeMs, priorMarketOpenMs: openMs == null ? null : openMs - 900_000,
    scheduledAtMs, actualAtMs, latenessMs: actualAtMs - scheduledAtMs, exchangeIndex: market.exchangeIndex ?? null,
    yesBid, yesAsk, noBid, noAsk, yesSpreadCents: yesBid != null && yesAsk != null ? yesAsk - yesBid : null,
    noSpreadCents: noBid != null && noAsk != null ? noAsk - noBid : null,
    l2Json: JSON.stringify({ sizes: LADDER_SIZES, yes: yesBook.rawNoDollars, no: noBook.rawYesDollars, errors: [yesBook.error, noBook.error] }),
    spotMidpoint: spot?.eth ?? null, spotProvider: spot ? "kraken" : null,
    spotSourceTimestampMs: spot?.sourceTimestampMs ?? null, spotReceiptTimestampMs: spot?.retrievedAtMs ?? null,
    spotAgeMs: spot?.cacheAgeMs ?? null, spotIsProxy: false,
    candidateOrderId: link?.id ?? null, kalshiOrderId: link?.kalshiOrderId ?? null,
    selectedSide: link?.side ?? null, requestedContracts: link?.requestedContracts ?? null,
    primaryLimitCents: link?.limitPriceCents ?? null, orderStatus: link?.status ?? null,
    filledContracts: link?.filledContracts ?? null, quality: quality.join(",") || "complete",
  });
}

function scheduleCapture(anchor: string, scheduledAtMs: number, market: BoundaryMarket, getCurrent: () => BoundaryMarket | undefined, key: string): void {
  if (timerKeys.has(key)) return;
  timerKeys.add(key);
  const delay = Math.max(0, scheduledAtMs - dependencies.now());
  const timer = dependencies.schedule(() => { void capture(anchor, scheduledAtMs, market, getCurrent); }, delay);
  if (timer.unref) timer.unref();
}

function scheduleNextOpenCapture(anchor: string, scheduledAtMs: number, expectedOpenMs: number, getCurrent: () => BoundaryMarket | undefined): void {
  const key = `next-open:${expectedOpenMs}:${anchor}`;
  if (timerKeys.has(key)) return;
  timerKeys.add(key);
  const delay = Math.max(0, scheduledAtMs - dependencies.now());
  const timer = dependencies.schedule(() => {
    void dependencies.discoverMarketAtOpen(expectedOpenMs).then((market) => {
      // Never substitute a later/earlier market; missing discovery leaves an
      // intentionally absent anchor that downstream research excludes.
      if (market && validTime(market.openTime) === expectedOpenMs) {
        void capture(anchor, scheduledAtMs, market, getCurrent);
      }
    });
  }, delay);
  if (timer.unref) timer.unref();
}

/** Schedule append-only evidence only. Calling this can never affect trading. */
export function observeEth420BoundaryResearch(market: BoundaryMarket, getCurrent: () => BoundaryMarket | undefined): void {
  const openMs = validTime(market.openTime), closeMs = validTime(market.closeTime);
  if (!market.ticker.startsWith("KXETH15M-") || openMs == null || closeMs == null) return;
  const observedAtMs = dependencies.now();
  for (const [anchor, offset] of ETH420_BOUNDARY_ANCHORS) {
    if (anchor.startsWith("prior_") || anchor === "boundary_close") {
      const scheduledAtMs = closeMs + offset;
      if (scheduledAtMs >= observedAtMs) {
        scheduleCapture(anchor, scheduledAtMs, market, getCurrent, `${market.ticker}:${anchor}:${scheduledAtMs}`);
      }
      continue;
    }
    // The current market commonly first arrives after its opening boundary.
    // Never manufacture late opening evidence; arm the following window while
    // this market is still known, so those anchors fire at their true times.
    const scheduledAtMs = closeMs + offset;
    scheduleNextOpenCapture(anchor, scheduledAtMs, closeMs, getCurrent);
  }
}

export type Eth420BoundaryResearchResponse = {
  researchOnly: true;
  evidenceAvailability: "available" | "unavailable";
  diagnosticReason: "storage_unavailable" | "storage_read_failed" | null;
  rows: Array<Record<string, unknown>>;
  summary: {
    rowCount: number;
    completeRowCount: number;
    requiredAnchors: readonly string[];
  };
};

/** Shapes passive evidence for the raw report without exposing storage errors. */
export function buildEth420BoundaryResearchResponse(
  evidence: store.Eth420BoundaryResearchRead,
): Eth420BoundaryResearchResponse {
  const rows = evidence.rows;
  return {
    researchOnly: true,
    evidenceAvailability: evidence.availability,
    diagnosticReason: evidence.availability === "unavailable" ? evidence.diagnosticReason : null,
    rows,
    summary: {
      rowCount: rows.length,
      completeRowCount: rows.filter((row) => row["quality"] === "complete").length,
      requiredAnchors: ETH420_BOUNDARY_ANCHORS.map(([anchor]) => anchor),
    },
  };
}

/**
 * Read-only, fail-closed descriptive screen. No missing anchor is interpolated.
 * A storage-read failure makes conclusions unavailable instead of presenting
 * an empty evidence set as an evidence-free conclusion.
 */
export function buildEth420BoundaryReplay(evidence: store.Eth420BoundaryResearchRead): Record<string, unknown> {
  if (evidence.availability === "unavailable") {
    return {
      researchOnly: true,
      evidenceAvailability: "unavailable",
      conclusionsAvailable: false,
      diagnosticReason: evidence.diagnosticReason,
      sufficientEvidence: false,
      completeWindows: 0,
      excludedWindows: 0,
      exclusions: {},
      sensitivity: { momentumThresholdsCents: [2, 3, 4], ceilingCents: [69, 71, 73] },
      rows: [],
    };
  }
  const rows = evidence.rows;
  const required = new Set(ETH420_BOUNDARY_ANCHORS.map(([anchor]) => anchor));
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = String(row["market_open_ms"] ?? "");
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const exclusions: Record<string, number> = {};
  const included: Array<Record<string, unknown>> = [];
  for (const group of groups.values()) {
    const byAnchor = new Map(group.map((row) => [String(row["anchor"]), row]));
    const missing = [...required].filter((anchor) => !byAnchor.has(anchor));
    const duplicateAnchor = byAnchor.size !== group.length;
    const invalid = group.some((row) => row["quality"] !== "complete");
    const open = Number(group[0]["market_open_ms"]), priorOpen = Number(group[0]["prior_market_open_ms"]);
    if (missing.length || duplicateAnchor || invalid || !Number.isFinite(open) || priorOpen !== open - 900_000) {
      const reason = missing.length ? "missing_anchor" : duplicateAnchor ? "duplicate_anchor"
        : invalid ? "quality_exclusion" : "non_adjacent_window";
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      continue;
    }
    const prior10 = byAnchor.get("prior_close_minus_10s")!, prior5 = byAnchor.get("prior_close_minus_5s")!;
    const prior2 = byAnchor.get("prior_close_minus_2s")!, close = byAnchor.get("boundary_close")!;
    const plus10 = byAnchor.get("open_plus_10s")!;
    const ask = (r: Record<string, unknown>): number | null => {
      const side = r["selected_side"];
      const value = side === "yes" ? r["yes_ask"] : side === "no" ? r["no_ask"] : null;
      return typeof value === "number" ? value : null;
    };
    const [a10, a5, a2, ac, ap] = [ask(prior10), ask(prior5), ask(prior2), ask(close), ask(plus10)];
    if ([a10, a5, a2, ac, ap].some((v) => v == null)) { exclusions["ambiguous_order_side_or_ask"] = (exclusions["ambiguous_order_side_or_ask"] ?? 0) + 1; continue; }
    included.push({
      ticker: group[0]["ticker"], candidateOrderId: plus10["candidate_order_id"],
      prior10ToCloseCents: ac! - a10!, prior5ToCloseCents: ac! - a5!, prior2ToCloseCents: ac! - a2!,
      priorCloseToNew10Cents: ap! - ac!, full10ToNew10Cents: ap! - a10!,
      accelerationCents: (ac! - a2!) - (a2! - a5!), newPlus10AskCents: ap!,
      passesCoreScreen: ap! > 50 && ap! <= 71 && ap! - ac! >= 3,
    });
  }
  return {
    researchOnly: true,
    evidenceAvailability: "available",
    conclusionsAvailable: true,
    diagnosticReason: null,
    sufficientEvidence: included.length > 0, completeWindows: included.length,
    excludedWindows: Object.values(exclusions).reduce((a, b) => a + b, 0), exclusions,
    sensitivity: { momentumThresholdsCents: [2, 3, 4], ceilingCents: [69, 71, 73] },
    rows: included,
  };
}