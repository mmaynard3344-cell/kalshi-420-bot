import { withBoundedReadOnlyClient } from "@workspace/db";
import type { WindowLogEntry } from "../windowLog.js";

const ETH_15M_MS = 15 * 60_000;
const REVERSAL_SETTLEMENT_READ_TIMEOUT_MS = 1_000;

export type EthReversalSettlementOutcome = "yes" | "no" | "missing_or_conflict";

/**
 * Resolve the three immediately preceding ETH 15-minute market settlements
 * from the durable authoritative market_results table.
 *
 * The in-memory window log is used only to identify candidate tickers for each
 * close boundary. SQL window_log rows are also consulted as a restart-safe
 * ticker mapping fallback. The settlement value itself always comes from
 * market_results, where resolved Kalshi outcomes are durable and never null.
 *
 * Any unavailable, duplicate-conflicting, or malformed evidence fails closed.
 */
export async function resolveThreeAdjacentEthSettlements(
  entries: readonly WindowLogEntry[],
  currentOpenTimeMs: number,
): Promise<EthReversalSettlementOutcome[]> {
  if (!Number.isInteger(currentOpenTimeMs) || currentOpenTimeMs % ETH_15M_MS !== 0) {
    return ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"];
  }

  const targetCloseMs = [0, 1, 2].map((offset) => currentOpenTimeMs - offset * ETH_15M_MS);
  const targetCloseIso = targetCloseMs.map((ms) => new Date(ms).toISOString());
  const localTickersByClose = new Map<number, Set<string>>();

  for (const entry of entries) {
    if (entry.series !== "KXETH15M" || !entry.closeTime || !entry.ticker) continue;
    const closeMs = Date.parse(entry.closeTime);
    if (!targetCloseMs.includes(closeMs)) continue;
    const tickers = localTickersByClose.get(closeMs) ?? new Set<string>();
    tickers.add(entry.ticker);
    localTickersByClose.set(closeMs, tickers);
  }

  const localTickers = [...new Set([...localTickersByClose.values()].flatMap((set) => [...set]))];

  try {
    const rows = await withBoundedReadOnlyClient(REVERSAL_SETTLEMENT_READ_TIMEOUT_MS, async (client) => {
      const result = await client.query(
        `SELECT w.close_time, mr.ticker, mr.result
           FROM market_results mr
           LEFT JOIN window_log w ON w.ticker = mr.ticker
          WHERE mr.ticker = ANY($1::text[])
             OR (w.series = 'KXETH15M' AND w.close_time = ANY($2::text[]))`,
        [localTickers, targetCloseIso],
      );
      return result.rows as Array<{ close_time: string | null; ticker: string; result: string }>;
    });

    const resultByTicker = new Map<string, "yes" | "no">();
    const sqlTickersByClose = new Map<number, Set<string>>();

    for (const row of rows) {
      if (row.result === "yes" || row.result === "no") resultByTicker.set(row.ticker, row.result);
      if (!row.close_time) continue;
      const closeMs = Date.parse(row.close_time);
      if (!targetCloseMs.includes(closeMs)) continue;
      const tickers = sqlTickersByClose.get(closeMs) ?? new Set<string>();
      tickers.add(row.ticker);
      sqlTickersByClose.set(closeMs, tickers);
    }

    return targetCloseMs.map((closeMs) => {
      const tickers = new Set<string>([
        ...(localTickersByClose.get(closeMs) ?? []),
        ...(sqlTickersByClose.get(closeMs) ?? []),
      ]);
      const outcomes = new Set<"yes" | "no">();
      for (const ticker of tickers) {
        const result = resultByTicker.get(ticker);
        if (result) outcomes.add(result);
      }
      if (outcomes.size !== 1) return "missing_or_conflict";
      return [...outcomes][0]!;
    });
  } catch {
    return ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"];
  }
}
