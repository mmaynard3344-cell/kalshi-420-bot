import { sql } from "drizzle-orm";
import {
  fetchFreshKalshiBalanceForExchangeRead,
  kalshiBalanceCents,
} from "../kalshiBalance.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";

export interface EthBigBetCapitalFacts {
  exchangeIndex: number;
  availableBalanceCents: number;
  /** Conservative principal + full-fill fee headroom for every unresolved B/C row. */
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

function parseNonnegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "bigint" ? Number(value)
    : typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
      SELECT wager_cents, limit_price_cents
      FROM eth_big_bet_orders
      WHERE status NOT IN ('rejected', 'settled')
    `);
    const rows = (result as { rows?: Array<Record<string, unknown>> }).rows;
    if (!Array.isArray(rows)) return null;
    let otherBigBetReservedCents = 0;
    for (const row of rows) {
      const wagerCents = parseNonnegativeInteger(row["wager_cents"]);
      const limitPriceCents = parseNonnegativeInteger(row["limit_price_cents"]);
      if (wagerCents == null || wagerCents < 1 || limitPriceCents == null
        || limitPriceCents < 1 || limitPriceCents > 99) return null;
      const riskCents = ethBigBetCapitalRiskCents(wagerCents, limitPriceCents);
      if (!Number.isSafeInteger(riskCents) || riskCents < 1
        || !Number.isSafeInteger(otherBigBetReservedCents + riskCents)) return null;
      otherBigBetReservedCents += riskCents;
    }
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
