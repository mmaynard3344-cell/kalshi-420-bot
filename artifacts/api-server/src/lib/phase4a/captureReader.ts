import type { ReplayCapture, ReplaySide } from "./types.js";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sideOrNull(value: unknown): ReplaySide | null {
  return value === "yes" || value === "no" ? value : null;
}

function field(payload: Readonly<Record<string, unknown>>, name: string): unknown {
  return payload[name];
}

/**
 * Normalizes one stored JSON payload into an immutable offline replay capture.
 * It never reads current market data or fills absent historical values.
 */
export function normalizeStaleGapCapture(payload: Readonly<Record<string, unknown>>): ReplayCapture {
  const counterfactual = field(payload, "counterfactual") as Readonly<Record<string, unknown>> | undefined;
  const timestampMs = numberOrNull(field(payload, "timestampMs"));
  const tickerValue = field(payload, "ticker");
  const ticker = typeof tickerValue === "string" ? tickerValue : "";
  const side = sideOrNull(field(payload, "side"));
  if (!timestampMs || !ticker || !side) {
    throw new Error("Invalid stale-gap capture: captureId, timestampMs, ticker, and side are required");
  }

  const entryPriceCents = numberOrNull(counterfactual?.["hypotheticalLimitCents"])
    ?? numberOrNull(field(payload, "executableBestAskCents"));
  const contracts = numberOrNull(counterfactual?.["finalHypotheticalContracts"]);
  const captureIdValue = field(payload, "captureId");
  const easternDateValue = field(payload, "easternDate");
  const seriesValue = field(payload, "series");
  const date = new Date(timestampMs);
  const easternParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const easternHour = Number(easternParts.find((part) => part.type === "hour")?.value);
  const weekdayName = easternParts.find((part) => part.type === "weekday")?.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    captureId: typeof captureIdValue === "string"
      ? captureIdValue
      : `${ticker}:${side}:${timestampMs}`,
    timestampMs,
    easternDate: typeof easternDateValue === "string"
      ? easternDateValue
      : date.toISOString().slice(0, 10),
    ticker,
    series: typeof seriesValue === "string" ? seriesValue : "",
    side,
    entryPriceCents,
    contracts,
    secondsLeft: numberOrNull(field(payload, "secondsLeft")),
    staleGapCents: numberOrNull(field(payload, "bboToL2GapCents")),
    spreadCents: numberOrNull(field(payload, "quotedBboAsk")) == null || numberOrNull(field(payload, "yesBid")) == null
      ? null
      : Math.abs(numberOrNull(field(payload, "quotedBboAsk"))! - numberOrNull(field(payload, "yesBid"))!),
    executableDepthContracts: numberOrNull(counterfactual?.["executableDepthContracts"]),
    liquidityDollars: numberOrNull(counterfactual?.["executableDepthDollars"]),
    priorDirectionalMoveCents: numberOrNull(field(payload, "priorDirectionalMoveCents")),
    easternHour: Number.isInteger(easternHour) ? easternHour : null,
    easternWeekday: weekdayName ? weekdayMap[weekdayName] ?? null : null,
    rawPayload: { ...payload },
  };
}

/** Parses a complete NDJSON export. Empty lines are ignored; malformed rows fail explicitly. */
export function readStaleGapCapturesFromNdjson(ndjson: string): ReplayCapture[] {
  return ndjson
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => normalizeStaleGapCapture(JSON.parse(line) as Record<string, unknown>))
    .sort((a, b) => a.timestampMs - b.timestampMs || a.captureId.localeCompare(b.captureId));
}