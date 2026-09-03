/**
 * Pure orderbook parsing helpers — no I/O, no logging, no external deps.
 *
 * Isolated here so tests can import these functions without pulling in
 * the pino/kalshiFetch dependency chain that captureOrderbook() needs.
 *
 * ── Kalshi counterparty-side selection ───────────────────────────────────────
 * Kalshi binary markets only have BUY orders — no explicit SELL orders.
 * Selling YES = buying NO at the complement price, so:
 *
 *   orderbook_fp.yes_dollars  — resting BUY YES orders (YES buyers)
 *   orderbook_fp.no_dollars   — resting BUY NO  orders (NO  buyers)
 *
 * For a new IOC BUY NO at limit X¢ (NO price):
 *   - Counterparty supply is in yes_dollars (YES buyers = implicit NO sellers)
 *   - A YES buyer at Y¢ will cross with our BUY NO when Y ≥ (100 − X)
 *     (they get YES at Y¢, we get NO at 100−Y¢ ≤ X¢)
 *   - We convert: outcomePriceCents = 100 − rawYesPriceCents
 *   - "At-or-better depth" = levels where outcomePriceCents ≤ X
 *
 * For a new IOC BUY YES at limit X¢ (YES price):
 *   - Counterparty supply is in no_dollars (NO buyers = implicit YES sellers)
 *   - A NO buyer at Y¢ will cross when Y ≥ (100 − X)
 *   - We convert: outcomePriceCents = 100 − rawNoPriceCents
 *   - "At-or-better depth" = levels where outcomePriceCents ≤ X
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface L2Level {
  /**
   * Outcome-side price in whole cents.
   * For side="no": NO-equivalent cents (= 100 − rawYesPriceCents).
   * For side="yes": YES-equivalent cents (= 100 − rawNoPriceCents).
   */
  priceCents:      number;
  /** Resting notional in dollars (contracts × raw counterparty unit price). */
  notionalDollars: number;
  /** Contract count (raw second-tuple element, rounded to nearest integer). */
  contractsApprox: number;
}

/** Subset of OrderbookSnapshot returned by the pure compute path. */
export interface ComputedSnapshotFields {
  totalLevels:                number;
  lowestLevelCents:           number | null;
  lowestLevelDollars:         number | null;
  lowestLevelContractsApprox: number | null;
  highestLevelCents:          number | null;
  highestLevelDollars:        number | null;
  nearLimitLevels:            L2Level[];
  depthAtOrBetterDollars:     number;
  depthAtOrBetterContracts:   number;
}

// ── Internal types matching the Kalshi API response ──────────────────────────

interface KalshiLevelSchema {
  price:    number;
  quantity: number;
}

interface KalshiOrderbookFp {
  no_dollars?:  [string, string][];
  yes_dollars?: [string, string][];
}

export interface KalshiOrderbookRaw {
  orderbook_fp?: KalshiOrderbookFp;
  no?:           KalshiLevelSchema[];
  yes?:          KalshiLevelSchema[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Aggregate parsed levels that share the same priceCents, summing notional
 * and contracts.  Input must be pre-filtered (no null/invalid entries).
 * Returns a new array sorted ascending by priceCents.
 */
function aggregateByPrice(levels: L2Level[]): L2Level[] {
  const map = new Map<number, L2Level>();
  for (const lv of levels) {
    const existing = map.get(lv.priceCents);
    if (existing) {
      existing.notionalDollars += lv.notionalDollars;
      existing.contractsApprox += lv.contractsApprox;
    } else {
      map.set(lv.priceCents, { ...lv });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.priceCents - b.priceCents);
}

// ── Public pure functions ─────────────────────────────────────────────────────

/**
 * Parse a raw Kalshi orderbook response body into a sorted, aggregated list of
 * {@link L2Level} records representing **counterparty supply** for `side`.
 *
 * Side selection:
 *  - side="no"  → reads yes_dollars (YES buyers are NO sellers)
 *  - side="yes" → reads no_dollars  (NO  buyers are YES sellers)
 *
 * Price conversion: each raw entry's price is in the counterparty's outcome
 * terms.  We convert to our outcome-side equivalent so that the standard
 * "priceCents ≤ limitCents" depth accumulation in computeSnapshotFields works
 * correctly for both sides:
 *  - side="no" : outcomePriceCents = 100 − rawYesPriceCents
 *  - side="yes": outcomePriceCents = 100 − rawNoPriceCents
 *
 * Duplicate raw entries at the same raw price are aggregated (notional and
 * contracts summed) into a single level before returning.
 *
 * Pure function — no I/O, safe to call from tests.
 */
export function parseOrderbookResponse(
  raw:  KalshiOrderbookRaw,
  side: "yes" | "no",
): L2Level[] {
  // BUY NO → counterparty is YES buyers → yes_dollars
  // BUY YES → counterparty is NO buyers → no_dollars
  const counterpartySide = side === "no" ? "yes" : "no";

  const fpEntries: [string, string][] =
    counterpartySide === "yes"
      ? (raw?.orderbook_fp?.yes_dollars ?? [])
      : (raw?.orderbook_fp?.no_dollars  ?? []);

  if (fpEntries.length > 0) {
    const parsed = fpEntries
      .map(([pStr, dStr]): L2Level | null => {
        const rawPriceDecimal = parseFloat(pStr);
        // The second tuple element is the contract count at this price level,
        // NOT a notional-dollar value — confirmed against Kalshi's live API:
        // ["0.0010", "174433.00"] means 174,433 contracts at 0.1¢ each ($174.43
        // notional), not $174,433 (which would imply 174 million contracts).
        const rawContracts    = parseFloat(dStr);
        const notionalDollars = rawContracts * rawPriceDecimal; // contracts × unit price
        // Reject malformed, zero, or out-of-range entries.
        // rawPriceDecimal must be strictly between 0 and 1 (exclusive) so
        // outcomePriceCents falls in [1, 99].
        if (
          !isFinite(rawPriceDecimal) ||
          !isFinite(rawContracts) ||
          rawPriceDecimal <= 0 ||
          rawPriceDecimal >= 1
        ) {
          return null;
        }
        const rawPriceCents     = Math.round(rawPriceDecimal * 100);
        const outcomePriceCents = 100 - rawPriceCents;
        // Guard against edge cases where rounding puts outcome out of [1, 99]
        if (outcomePriceCents <= 0 || outcomePriceCents >= 100) return null;
        return {
          priceCents:      outcomePriceCents,
          notionalDollars,
          contractsApprox: Math.round(rawContracts),
        };
      })
      .filter((x): x is L2Level => x !== null);

    return aggregateByPrice(parsed);
  }

  // Fallback: schema format (price in cents, quantity in contracts).
  // Schema uses the counterparty outcome's price in cents.
  const schemaEntries = counterpartySide === "yes"
    ? (raw?.yes ?? [])
    : (raw?.no  ?? []);

  const parsed = schemaEntries
    .map((lv): L2Level | null => {
      const rawPriceCents     = Math.round(lv.price);
      const outcomePriceCents = 100 - rawPriceCents;
      if (outcomePriceCents <= 0 || outcomePriceCents >= 100) return null;
      return {
        priceCents:      outcomePriceCents,
        notionalDollars: lv.quantity * (lv.price / 100),
        contractsApprox: lv.quantity,
      };
    })
    .filter((x): x is L2Level => x !== null);

  return aggregateByPrice(parsed);
}

/**
 * Parse resting buyers for an exit of the specified held outcome.
 *
 * This deliberately does not use the entry helper above: an entry finds
 * counterparties willing to SELL to us; a protective exit needs buyers willing
 * to BUY the exact outcome we already hold.  YES holdings use `yes_dollars`;
 * NO holdings use `no_dollars`; prices are returned without complementing.
 */
export function parseExitSellBids(
  raw: KalshiOrderbookRaw,
  heldSide: "yes" | "no",
): L2Level[] {
  const fpEntries = heldSide === "yes"
    ? (raw?.orderbook_fp?.yes_dollars ?? [])
    : (raw?.orderbook_fp?.no_dollars ?? []);
  const schemaEntries = heldSide === "yes" ? (raw?.yes ?? []) : (raw?.no ?? []);
  const fromFixedPoint = fpEntries.map(([price, quantity]): L2Level | null => {
    const decimal = Number.parseFloat(price);
    const contracts = Number.parseFloat(quantity);
    if (!Number.isFinite(decimal) || !Number.isFinite(contracts) ||
        decimal <= 0 || decimal >= 1 || contracts <= 0) return null;
    const priceCents = Math.round(decimal * 100);
    if (priceCents <= 0 || priceCents >= 100) return null;
    return {
      priceCents,
      contractsApprox: Math.round(contracts),
      notionalDollars: decimal * contracts,
    };
  }).filter((value): value is L2Level => value !== null);
  if (fromFixedPoint.length > 0) return aggregateByPrice(fromFixedPoint);
  return aggregateByPrice(schemaEntries.map((level): L2Level | null => {
    const priceCents = Math.round(level.price);
    if (!Number.isFinite(priceCents) || !Number.isFinite(level.quantity) ||
        priceCents <= 0 || priceCents >= 100 || level.quantity <= 0) return null;
    return {
      priceCents,
      contractsApprox: Math.round(level.quantity),
      notionalDollars: (priceCents / 100) * level.quantity,
    };
  }).filter((value): value is L2Level => value !== null));
}

/**
 * Given a sorted, aggregated level list and a limit price, compute the derived
 * snapshot fields used for logging and miss classification.
 *
 * "At-or-better" means priceCents ≤ limitCents, which is valid for both sides
 * because parseOrderbookResponse already converts counterparty prices to
 * outcome-side equivalents.
 *
 * Pure function.
 */
export function computeSnapshotFields(
  levels:     L2Level[],
  limitCents: number,
): ComputedSnapshotFields {
  let depthAtOrBetterDollars   = 0;
  let depthAtOrBetterContracts = 0;
  for (const lv of levels) {
    if (lv.priceCents <= limitCents) {
      depthAtOrBetterDollars   += lv.notionalDollars;
      depthAtOrBetterContracts += lv.contractsApprox;
    }
  }

  // Up to 5 at-or-below + up to 5 above limit
  const atOrBelow       = levels.filter((l) => l.priceCents <= limitCents).slice(-5);
  const above           = levels.filter((l) => l.priceCents >  limitCents).slice(0, 5);
  const nearLimitLevels = [...atOrBelow, ...above];

  const lowest  = levels[0]     ?? null;
  const highest = levels.at(-1) ?? null;

  return {
    totalLevels:                levels.length,
    lowestLevelCents:           lowest?.priceCents           ?? null,
    lowestLevelDollars:         lowest?.notionalDollars       ?? null,
    lowestLevelContractsApprox: lowest?.contractsApprox       ?? null,
    highestLevelCents:          highest?.priceCents           ?? null,
    highestLevelDollars:        highest?.notionalDollars       ?? null,
    nearLimitLevels,
    depthAtOrBetterDollars,
    depthAtOrBetterContracts,
  };
}
