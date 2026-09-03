/**
 * Normalize the current and legacy Kalshi fills payloads into one safe shape.
 *
 * Kalshi's current API uses fixed-point quantity and dollar-price field names
 * (`count_fp`, `*_price_dollars`). Older records use the corresponding
 * unsuffixed names. Reconciliation and historical backfill must accept both
 * shapes so a schema rollout cannot make real fills disappear from P&L.
 */

export interface KalshiFillWire {
  fill_id?: unknown;
  count?: unknown;
  count_fp?: unknown;
  yes_price?: unknown;
  yes_price_dollars?: unknown;
  no_price?: unknown;
  no_price_dollars?: unknown;
  fee_cost?: unknown;
  fee_cost_dollars?: unknown;
  created_time?: unknown;
  [key: string]: unknown;
}

export interface NormalizedKalshiFill {
  fillId: string | null;

  contracts: number;
  /** Rounded to nearest cent for display and legacy storage. */

  contractsExact: string;

  fillPriceCents: number;
  /** Exact dollar price from Kalshi — never rounded — used for exact cost accounting. */

  exactPriceDollars: string;

  exactCostDollars: string;

  feeDollars: number;

  exactFeeDollars: string;

  fillTimestamp: string | null;
  /** Kalshi's exchange-assigned fill UUID. Null when absent from the response. */
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" || typeof value === "string"
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function decimalString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  return text;
}

/** Exact non-negative decimal multiplication without binary floating-point drift. */
export function multiplyDecimalStrings(left: string, right: string): string {
  const split = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return { digits: `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0", scale: fraction.length };
  };
  const a = split(left);
  const b = split(right);
  const raw = (BigInt(a.digits) * BigInt(b.digits)).toString();
  const scale = a.scale + b.scale;
  if (scale === 0) return raw;
  const padded = raw.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Exact non-negative decimal addition without binary floating-point drift. */
export function addDecimalStrings(left: string, right: string): string {
  const split = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return { digits: `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0", scale: fraction.length };
  };
  const a = split(left);
  const b = split(right);
  const scale = Math.max(a.scale, b.scale);
  const aValue = BigInt(a.digits) * (10n ** BigInt(scale - a.scale));
  const bValue = BigInt(b.digits) * (10n ** BigInt(scale - b.scale));
  const raw = (aValue + bValue).toString();
  if (scale === 0) return raw;
  const padded = raw.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Returns the actual held-side price and quantity from a Kalshi fill, or null
 * when the record cannot support an auditable cost calculation.
 */
export function normalizeKalshiFill(
  fill: KalshiFillWire,
  side: "yes" | "no",
): NormalizedKalshiFill | null {
  const fillId = typeof fill.fill_id === "string" && fill.fill_id.trim() ? fill.fill_id : null;
  const contractsExact = decimalString(fill.count_fp ?? fill.count);
  if (contractsExact === null) return null;
  const contracts = finiteNumber(contractsExact);
  if (contracts === null || contracts <= 0) return null;

  const exactPriceDollars = decimalString(
    side === "yes"
      ? (fill.yes_price_dollars ?? fill.yes_price)
      : (fill.no_price_dollars ?? fill.no_price),
  );
  if (exactPriceDollars === null) return null;
  const priceDollars = finiteNumber(exactPriceDollars);
  if (priceDollars === null || priceDollars < 0) return null;

  // Fee must be explicitly provided as a valid decimal string. A supplied literal
  // "0" is valid (some fills genuinely have zero fee); absent or non-decimal is
  // not — it means the response is incomplete and cannot be used as canonical evidence.
  const exactFeeDollars = decimalString(fill.fee_cost_dollars ?? fill.fee_cost);
  if (exactFeeDollars === null) return null;
  const fee = finiteNumber(exactFeeDollars);
  if (fee === null) return null;

  return {
    fillId,
    contracts,
    contractsExact,
    fillPriceCents: Math.round(priceDollars * 100),
    exactPriceDollars,
    exactCostDollars: multiplyDecimalStrings(exactPriceDollars, contractsExact),
    feeDollars: fee,
    exactFeeDollars,
    fillTimestamp: typeof fill.created_time === "string" ? fill.created_time : null,
  };
}

/**
 * Extended wire shape returned by GET /portfolio/fills without an order_id
 * filter. All fields are optional/unknown — Kalshi's schema can vary across API
 * versions. The inherited [key: string]: unknown index already handles extra
 * fields, but explicit declarations help callers avoid raw string indexing.
 */
export interface KalshiAllFillsWire extends KalshiFillWire {
  /** Kalshi order ID — present on list-fills responses. */
  order_id?: unknown;
  /** Full Kalshi market ticker, e.g. "KXBTC15M-26AUG290315-15". */
  market_ticker?: unknown;
  /**
   * "yes" | "no" — documented quirk: may be reported as "yes" even for NO
   * fills. Use inferSideFromAllFillsWire() for reliable detection instead.
   */
  side?: unknown;
  /** "buy" | "sell" */
  action?: unknown;
}

/**
 * Infer the economic side (YES or NO) from a raw list-fills wire record.
 *
 * The Kalshi fills API may report side="yes" even for NO purchases (memory:
 * "fill reports always say side:'yes' even for NO buys"). We compare the price
 * magnitudes instead: the purchased side has the higher price since the bot
 * only buys in the 70–95¢ zone, making YES vs NO unambiguous.
 *
 * Returns null when neither price field is present or parseable.
 */
export function inferSideFromAllFillsWire(fill: KalshiAllFillsWire): "yes" | "no" | null {
  const parse = (v: unknown): number | null => {
    const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const yesDollars = parse(fill.yes_price_dollars ?? fill.yes_price);
  const noDollars  = parse(fill.no_price_dollars  ?? fill.no_price);

  if (yesDollars === null && noDollars === null) return null;
  if (noDollars  === null) return "yes";
  if (yesDollars === null) return "no";

  // The purchased side has the higher price in the bot's entry zone (70–95¢).
  // At exactly 50¢ the prices are equal; arbitrarily pick YES.
  return noDollars > yesDollars ? "no" : "yes";
}
