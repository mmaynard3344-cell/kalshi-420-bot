import { sql } from "drizzle-orm";
import type { EthBigBetSettlementRow } from "./ethBigBetSettlementReconciler.js";

type DbLike = { execute: (query: unknown) => Promise<unknown> };
let _dbOverride: DbLike | null = null;

export function _setEthBigBetSettlementStoreDbForTesting(db: DbLike | null): void {
  _dbOverride = db;
}

async function getDb(): Promise<DbLike> {
  if (_dbOverride) return _dbOverride;
  const mod = await import("@workspace/db");
  return mod.db as unknown as DbLike;
}

export async function listUnresolvedEthBigBetSettlementRowsForTicker(
  ticker: string,
): Promise<EthBigBetSettlementRow[]> {
  if (!/^KXETH15M-/.test(ticker)) return [];
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT id, ticker, side, kalshi_order_id
    FROM eth_big_bet_orders
    WHERE ticker=${ticker} AND status IN ('submitted', 'submission_unknown')
    ORDER BY created_at_ms ASC
  `);
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows;
  if (!Array.isArray(rows)) throw new Error("eth_big_bet_orders settlement rows unavailable");
  const parsed: EthBigBetSettlementRow[] = [];
  for (const row of rows) {
    const id = typeof row["id"] === "string" ? row["id"] : null;
    const rowTicker = typeof row["ticker"] === "string" ? row["ticker"] : null;
    const side = row["side"] === "yes" || row["side"] === "no" ? row["side"] : null;
    const kalshiOrderId = row["kalshi_order_id"] == null
      ? null
      : typeof row["kalshi_order_id"] === "string" && row["kalshi_order_id"]
        ? row["kalshi_order_id"]
        : undefined;
    if (!id || rowTicker !== ticker || !side || kalshiOrderId === undefined) {
      throw new Error("malformed eth_big_bet_orders settlement row");
    }
    parsed.push({ id, ticker: rowTicker, side, kalshiOrderId });
  }
  return parsed;
}

/**
 * Bounded retry-sweep discovery. Only rows that have reached exchange
 * submission (or an ambiguous submission response) are eligible. A merely
 * reserved pre-POST row needs separate crash-recovery evidence and is never
 * silently converted into an order or settlement here.
 */
export async function listUnresolvedEthBigBetTickers(limit = 50): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("invalid B/C accounting sweep limit");
  }
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT ticker, MIN(created_at_ms) AS oldest_created_at_ms
    FROM eth_big_bet_orders
    WHERE status IN ('submitted', 'submission_unknown')
    GROUP BY ticker
    ORDER BY oldest_created_at_ms ASC
    LIMIT ${limit}
  `);
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows;
  if (!Array.isArray(rows)) throw new Error("unresolved B/C ticker list unavailable");
  const tickers: string[] = [];
  for (const row of rows) {
    const ticker = typeof row["ticker"] === "string" ? row["ticker"] : null;
    if (!ticker || !/^KXETH15M-/.test(ticker)) {
      throw new Error("malformed unresolved B/C ticker row");
    }
    tickers.push(ticker);
  }
  return tickers;
}
