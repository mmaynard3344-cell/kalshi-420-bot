import { sql } from "drizzle-orm";
import type { EthBigBetSettlementRow } from "./ethBigBetSettlementReconciler.js";

type DbLike = { execute: (query: unknown) => Promise<unknown> };
let _dbOverride: DbLike | null = null;

export const ETH_BIG_BET_STALE_RESERVED_RECOVERY_AGE_MS = 15 * 60_000;

export function _setEthBigBetSettlementStoreDbForTesting(db: DbLike | null): void {
  _dbOverride = db;
}

async function getDb(): Promise<DbLike> {
  if (_dbOverride) return _dbOverride;
  const mod = await import("@workspace/db");
  return mod.db as unknown as DbLike;
}

async function ethBigBetLedgerExists(db: DbLike): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT to_regclass('public.eth_big_bet_orders') AS table_name
  `);
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("B/C ledger existence evidence unavailable");
  }
  const tableName = rows[0]?.["table_name"];
  if (tableName == null) return false;
  if (typeof tableName !== "string" || tableName.length === 0) {
    throw new Error("malformed B/C ledger existence evidence");
  }
  return true;
}

export async function listUnresolvedEthBigBetSettlementRowsForTicker(
  ticker: string,
): Promise<EthBigBetSettlementRow[]> {
  if (!/^KXETH15M-/.test(ticker)) return [];
  const db = await getDb();
  if (!await ethBigBetLedgerExists(db)) return [];
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
 * Crash-recovery visibility only. A process can die after the durable capital
 * reservation is inserted but before the exchange response is acknowledged.
 * After a full 15-minute market window, such an unacknowledged reservation is
 * classified as submission_unknown so immutable client-order-ID recovery can
 * inspect Kalshi. This NEVER marks rejection, zero fill, settlement, or releases
 * reserved capital. Recent reservations and any row with a Kalshi order ID are
 * untouched.
 */
export async function promoteStaleReservedEthBigBetsToSubmissionUnknown(
  nowMs = Date.now(),
): Promise<number> {
  if (!Number.isSafeInteger(nowMs) || nowMs < ETH_BIG_BET_STALE_RESERVED_RECOVERY_AGE_MS) {
    throw new Error("invalid B/C reserved recovery timestamp");
  }
  const db = await getDb();
  if (!await ethBigBetLedgerExists(db)) return 0;
  const cutoffMs = nowMs - ETH_BIG_BET_STALE_RESERVED_RECOVERY_AGE_MS;
  const result = await db.execute(sql`
    UPDATE eth_big_bet_orders
    SET status='submission_unknown', updated_at_ms=${nowMs}
    WHERE status='reserved'
      AND kalshi_order_id IS NULL
      AND created_at_ms <= ${cutoffMs}
    RETURNING id
  `);
  const rows = (result as { rows?: unknown[] }).rows;
  if (!Array.isArray(rows)) throw new Error("B/C reserved recovery result unavailable");
  return rows.length;
}

/**
 * Bounded retry-sweep discovery. Only rows that have reached exchange
 * submission (or an ambiguous submission response) are eligible. Stale
 * pre-ack crash rows enter submission_unknown only through the explicit
 * age-gated recovery above; no absence is interpreted as rejection or zero fill.
 */
export async function listUnresolvedEthBigBetTickers(limit = 50): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("invalid B/C accounting sweep limit");
  }
  const db = await getDb();
  if (!await ethBigBetLedgerExists(db)) return [];
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
