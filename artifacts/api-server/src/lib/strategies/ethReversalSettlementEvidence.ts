import { kalshiAuthFetch } from "../kalshiAuth.js";
import { upsertMarketResultInSql } from "../tradeStore.js";
import type { WindowLogEntry } from "../windowLog.js";

const ETH_15M_MS = 15 * 60_000;
const UNRESOLVED_RETRY_MS = 5_000;

export type EthReversalSettlementOutcome = "yes" | "no" | "missing_or_conflict";

type KalshiMarketResponse = {
  market?: {
    result?: string | null;
  } | null;
};

type CachedSettlement = {
  result: "yes" | "no" | null;
  checkedAtMs: number;
};

const settlementCache = new Map<string, CachedSettlement>();
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

function tickerForEth15mClose(closeTimeMs: number): string | null {
  if (!Number.isInteger(closeTimeMs) || closeTimeMs % ETH_15M_MS !== 0) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(closeTimeMs));

  const value = (type: Intl.DateTimeFormatPartTypes): string | null =>
    parts.find((part) => part.type === type)?.value ?? null;

  const year = value("year");
  const monthRaw = value("month");
  const day = value("day");
  const hour = value("hour");
  const minute = value("minute");
  if (!year || !monthRaw || !day || !hour || !minute) return null;

  const monthIndex = Number(monthRaw) - 1;
  const month = MONTHS[monthIndex];
  if (!month) return null;

  return `KXETH15M-${year}${month}${day}${hour}${minute}-${minute}`;
}

async function fetchAuthoritativeSettlement(ticker: string): Promise<"yes" | "no" | null> {
  const cached = settlementCache.get(ticker);
  const now = Date.now();
  if (cached?.result === "yes" || cached?.result === "no") return cached.result;
  if (cached && now - cached.checkedAtMs < UNRESOLVED_RETRY_MS) return null;

  try {
    const response = await kalshiAuthFetch<KalshiMarketResponse>("GET", `/markets/${ticker}`);
    const result = response.market?.result;
    if (result === "yes" || result === "no") {
      settlementCache.set(ticker, { result, checkedAtMs: now });
      upsertMarketResultInSql(ticker, result);
      return result;
    }
    settlementCache.set(ticker, { result: null, checkedAtMs: now });
    return null;
  } catch {
    settlementCache.set(ticker, { result: null, checkedAtMs: now });
    return null;
  }
}

/**
 * Resolve the three immediately preceding ETH 15-minute market settlements
 * directly from Kalshi's authoritative market result endpoint.
 *
 * The required tickers are derived deterministically from the three exact close
 * boundaries in America/New_York, so this evidence path does not depend on our
 * betting history, fills, window-log freshness, or whether another strategy
 * happened to reconcile the market. Resolved YES/NO values are immutable and
 * cached in-process; unresolved markets are retried at a bounded cadence.
 *
 * Any unavailable or malformed evidence fails closed.
 */
export async function resolveThreeAdjacentEthSettlements(
  _entries: readonly WindowLogEntry[],
  currentOpenTimeMs: number,
): Promise<EthReversalSettlementOutcome[]> {
  if (!Number.isInteger(currentOpenTimeMs) || currentOpenTimeMs % ETH_15M_MS !== 0) {
    return ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"];
  }

  const targetCloseMs = [0, 1, 2].map((offset) => currentOpenTimeMs - offset * ETH_15M_MS);
  const tickers = targetCloseMs.map(tickerForEth15mClose);
  if (tickers.some((ticker) => ticker == null)) {
    return ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"];
  }

  const settlements = await Promise.all(tickers.map((ticker) => fetchAuthoritativeSettlement(ticker!)));
  return settlements.map((result) => result ?? "missing_or_conflict");
}
