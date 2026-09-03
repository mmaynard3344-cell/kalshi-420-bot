/**
 * Orderbook snapshot capture for order submission diagnostics.
 *
 * Fetches the Kalshi Level 2 orderbook immediately before (concurrently with)
 * each live order submission so that zero-fill post-mortems can distinguish
 * "no executable depth" from "BBO was stale" from "depth present but IOC failed."
 *
 * ── Kalshi counterparty-side selection ───────────────────────────────────────
 * Kalshi binary markets only have BUY orders (no explicit SELL).
 *
 *   orderbook_fp.yes_dollars  — resting BUY YES orders (YES buyers)
 *   orderbook_fp.no_dollars   — resting BUY NO  orders (NO  buyers)
 *
 * For a BUY NO IOC at limit X¢:
 *   Counterparty supply = yes_dollars entries at YES prices ≥ (100−X)¢.
 *   After price conversion (outcomePriceCents = 100−rawYesPriceCents),
 *   "at-or-better depth" = levels where priceCents ≤ X.
 *
 * For a BUY YES IOC at limit X¢:
 *   Counterparty supply = no_dollars entries at NO prices ≥ (100−X)¢.
 *   After price conversion (outcomePriceCents = 100−rawNoPriceCents),
 *   "at-or-better depth" = levels where priceCents ≤ X.
 *
 * Both raw arrays (yes_dollars, no_dollars) are preserved in the snapshot for
 * post-hoc audit without re-fetching.
 *
 * ── Rate-limit posture ────────────────────────────────────────────────────────
 * This module calls an UNAUTHENTICATED public endpoint. It does not consume
 * portfolio API quota. On failure it returns a snapshot with error != null
 * and NEVER throws so it is safe to run concurrently with the order submission.
 */

import { kalshiFetch } from "./kalshi.js";
import { logger }      from "./logger.js";
import {
  parseOrderbookResponse,
  computeSnapshotFields,
  type L2Level,
  type KalshiOrderbookRaw,
} from "./orderbookParsing.js";

// Re-export pure helpers so callers that already import from this file don't break.
export { parseOrderbookResponse, computeSnapshotFields, type L2Level } from "./orderbookParsing.js";
export { parseExitSellBids } from "./orderbookParsing.js";

// ── OrderbookSnapshot type ─────────────────────────────────────────────────────

/**
 * L2 snapshot captured just before an order is submitted to Kalshi.
 *
 * Prices in the computed fields are in **outcome-side cents** (NO¢ for a NO
 * buy, YES¢ for a YES buy) so "at-or-better" is always priceCents ≤ limitCents.
 *
 * `lowestLevelCents` is the cheapest counterparty offer seen (best ask from
 * our perspective).  `depthAtOrBetterDollars` is the total counterparty
 * notional at prices ≤ our limit.
 *
 * Both raw Kalshi arrays are preserved for audit:
 *  - `rawYesDollars` = yes_dollars from response (counterparty for BUY NO)
 *  - `rawNoDollars`  = no_dollars  from response (counterparty for BUY YES)
 */
export interface OrderbookSnapshot {
  ticker:                   string;
  capturedAtMs:             number;
  side:                     "yes" | "no";
  /** Our submitted limit price in outcome-side cents. */
  limitCents:               number;
  /** Raw entry count in the counterparty array (before price-conversion + aggregation). */
  rawEntryCount:            number;
  /** Aggregated price-level count after conversion and deduplication. */
  totalLevels:              number;
  /** Lowest outcome-equivalent price in book (best potential counterparty offer). */
  lowestLevelCents:         number | null;
  /** Notional at the lowest level, USD. */
  lowestLevelDollars:       number | null;
  /** Contracts approx. at the lowest level. */
  lowestLevelContractsApprox: number | null;
  /** Highest outcome-equivalent price in book. */
  highestLevelCents:        number | null;
  /** Notional at the highest level, USD. */
  highestLevelDollars:      number | null;
  /**
   * Up to 10 levels nearest our limit price (outcome-side cents).
   * For a NO buy at 90¢: 5 levels ≤ 90¢ + 5 levels > 90¢.
   */
  nearLimitLevels:          L2Level[];
  /** Sum of counterparty notional at prices ≤ limitCents (executable depth). */
  depthAtOrBetterDollars:   number;
  /** Approximate contract total at prices ≤ limitCents (executable depth). */
  depthAtOrBetterContracts: number;
  /** Fetch round-trip latency in milliseconds. */
  fetchLatencyMs:           number;
  /** Non-null when the fetch failed; book fields will be zero/null. */
  error:                    string | null;
  /** Raw yes_dollars array from Kalshi response (counterparty for BUY NO). */
  rawYesDollars:            [string, string][];
  /** Raw no_dollars array from Kalshi response (counterparty for BUY YES). */
  rawNoDollars:             [string, string][];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch and parse the Level 2 orderbook for `ticker` at the moment of order
 * submission.  Returns a complete {@link OrderbookSnapshot} even on failure.
 *
 * @param ticker     - Kalshi market ticker (e.g. KXETH15M-26JUL301200-00)
 * @param side       - Order side ("yes" | "no"); selects the counterparty array
 * @param limitCents - Outcome-side limit price in whole cents (e.g. 90 for NO at 90¢)
 */
export async function captureOrderbook(
  ticker:     string,
  side:       "yes" | "no",
  limitCents: number,
): Promise<OrderbookSnapshot> {
  const t0 = Date.now();

  const baseFields = { ticker, capturedAtMs: t0, side, limitCents };
  const emptyFields = {
    rawEntryCount:              0,
    totalLevels:                0,
    lowestLevelCents:           null,
    lowestLevelDollars:         null,
    lowestLevelContractsApprox: null,
    highestLevelCents:          null,
    highestLevelDollars:        null,
    nearLimitLevels:            [] as L2Level[],
    depthAtOrBetterDollars:     0,
    depthAtOrBetterContracts:   0,
    rawYesDollars:              [] as [string, string][],
    rawNoDollars:               [] as [string, string][],
  };

  try {
    const raw = await kalshiFetch<KalshiOrderbookRaw>(
      `/markets/${ticker}/orderbook`,
    );

    // Preserve both raw arrays for audit (only one is used for depth calculation).
    const rawYesDollars = raw?.orderbook_fp?.yes_dollars ?? [];
    const rawNoDollars  = raw?.orderbook_fp?.no_dollars  ?? [];

    // Count raw entries in the counterparty array (before conversion + aggregation).
    const rawEntryCount = side === "no" ? rawYesDollars.length : rawNoDollars.length;

    const levels  = parseOrderbookResponse(raw, side);
    const derived = computeSnapshotFields(levels, limitCents);

    return {
      ...baseFields,
      ...derived,
      rawEntryCount,
      rawYesDollars,
      rawNoDollars,
      fetchLatencyMs: Date.now() - t0,
      error:          null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { ticker, side, limitCents, err: msg },
      "orderbookCapture: fetch failed — order proceeds without L2 snapshot",
    );
    return {
      ...baseFields,
      ...emptyFields,
      fetchLatencyMs: Date.now() - t0,
      error:          msg,
    };
  }
}
