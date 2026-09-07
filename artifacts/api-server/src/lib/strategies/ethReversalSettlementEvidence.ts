import { withBoundedReadOnlyClient } from "@workspace/db";
import type { WindowLogEntry } from "../windowLog.js";

const ETH_15M_MS = 15 * 60_000;
const REVERSAL_SETTLEMENT_READ_TIMEOUT_MS = 1_000;

export type EthReversalSettlementOutcome = "yes" | "no" | "missing_or_conflict";

/**
 * Resolve the three immediately preceding ETH 15-minute market settlements
 * from the durable authoritative market_results table.
 *
 * Window-log rows are used only to map each exact close boundary to its ticker.
 * SQL matching is done by parsed timestamp milliseconds rather than exact text,
 * so equivalent ISO timestamp renderings cannot break the mapping. The YES/NO
 * value itself always comes from market_results.
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
  const localTickersByClose = new Map<number, Set<string>>();

  for (const entry of entries) {
    if (entry.series !== "KXETH15M" || !entry.closeTime || !entry.ticker) continue;
    const closeMs = Date.parse(entry.closeTime);
    if (!targetCloseMs.includes(closeMs)) continue;
    const tickers = localTickersByClose.get(closeMs) ?? new Set<string>();
    tickers.add(entry.ticker);
    localTickersByClose.set(closeMs, tickers);
  }

  try {
    const rows = await withBoundedReadOnlyClient(REVERSAL_SETTLEMENT_READ_TIMEOUT_MS, async (client) => {
      const result = await client.query(
        `WITH target_windows AS (
           SELECT
             ticker,
             (EXTRACT(EPOCH FROM close_time::timestamptz) * 1000)::bigint AS close_ms
           FROM window_log
           WHERE series = 'KXETH15M'
             AND close_time IS NOT NULL
             AND (EXTRACT(EPOCH FROM close_time::timestamptz) * 1000)::bigint = ANY($1::bigint[])
         )
         SELECT tw.close_ms, tw.ticker, mr.result
           FROM target_windows tw
           LEFT JOIN market_results mr ON mr.ticker = tw.ticker`,
        [targetCloseMs],
      );
      return result.rows as Array<{ close_ms: string | number; ticker: string; result: string | null }>;
    });

    const sqlTickersByClose = new Map<number, Set<string>>();
    const resultByTicker = new Map<string, "yes" | "no">();

    for (const row of rows) {
      const closeMs = Number(row.close_ms);
      if (!Number.isInteger(closeMs) || !targetCloseMs.includes(closeMs)) continue;
      const tickers = sqlTickersByClose.get(closeMs) ?? new Set<string>();
      tickers.add(row.ticker);
      sqlTickersByClose.set(closeMs, tickers);
      if (row.result === "yes" || row.result === "no") resultByTicker.set(row.ticker, row.result);
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
