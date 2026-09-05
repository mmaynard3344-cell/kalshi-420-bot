import { sql } from "drizzle-orm";
import {
  fetchFreshKalshiBalanceForExchangeRead,
  kalshiBalanceCents,
} from "../kalshiBalance.js";

export interface EthBigBetCapitalFacts {
  exchangeIndex: number;
  availableBalanceCents: number;
  /** Conservative full intended wagers for every unresolved B/C row. */
  otherBigBetReservedCents: number;
  observedAtMs: number;
}

type DbLike = { execute: (query: unknown) => Promise<unknown> };
type FreshBalanceRead = typeof fetchFreshKalshiBalanceForExchangeRead;

let dbOverride: DbLike | null = null;
let balanceRead: FreshBalanceRead = fetchFreshKalshiBalanceForExchangeRead;

export function _setEthBigBetCapitalFactsDbForTesting(db: DbLike | null): void {
  dbOverride = db;
}
export function _setEthBigBetCapitalFactsBalanceForTesting(reader: FreshBalanceRead | null): void {
  balanceRead = reader ?? fetchFreshKalshiBalanceForExchangeRead;
}

async function getDb(): Promise<DbLike> {
  if (dbOverride) return dbOverride;
  const mod = await import("@workspace/db");
  return mod.db as unknown as DbLike;
}

/**
 * Reads facts only; it deliberately does not decide A's reserve or the account
 * safety buffer. Missing, stale, malformed, or unavailable evidence returns
 * null so callers cannot authorize risk from a guessed value.
 */
export async function readEthBigBetCapitalFacts(exchangeIndex: number): Promise<EthBigBetCapitalFacts | null> {
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) return null;
  try {
    const [balance, db] = await Promise.all([balanceRead(exchangeIndex), getDb()]);
    if (balance.stale) return null;
    const availableBalanceCents = kalshiBalanceCents(balance.value);
    if (availableBalanceCents == null) return null;
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(wager_cents), 0)::bigint AS reserved_cents
      FROM eth_big_bet_orders
      WHERE status NOT IN ('rejected', 'settled')
    `);
    const raw = (result as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.["reserved_cents"];
    const otherBigBetReservedCents = typeof raw === "bigint" ? Number(raw)
      : typeof raw === "number" ? raw
      : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw)
      : NaN;
    if (!Number.isSafeInteger(otherBigBetReservedCents) || otherBigBetReservedCents < 0) return null;
    return {
      exchangeIndex,
      availableBalanceCents,
      otherBigBetReservedCents,
      observedAtMs: Date.now(),
    };
  } catch {
    return null;
  }
}
