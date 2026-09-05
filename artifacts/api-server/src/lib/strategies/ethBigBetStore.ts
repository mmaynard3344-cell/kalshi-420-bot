import { sql } from "drizzle-orm";
import type { EthBigBetOrderIntent, EthBigBetSide, EthBigBetStrategy } from "./ethBigBetLifecycle.js";
import { ethBigBetContracts, ethBigBetOrderId } from "./ethBigBetLifecycle.js";

export type EthBigBetOrderStatus =
  | "reserved"
  | "submitted"
  | "submission_unknown"
  | "rejected"
  | "settled";

export interface EthBigBetLedgerRow {
  id: string;
  strategy: EthBigBetStrategy;
  orderTag: string;
  ticker: string;
  marketOpenTimeMs: number;
  side: EthBigBetSide;
  wagerCents: number;
  limitPriceCents: number;
  requestedContracts: number;
  kalshiOrderId: string | null;
  status: EthBigBetOrderStatus;
  filledContracts: number | null;
  actualNotionalCents: number | null;
  actualFeeCents: number | null;
  fillPriceCents: number | null;
  settlementResult: EthBigBetSide | null;
  realizedPnlCents: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

type DbLike = {
  execute: (query: unknown) => Promise<unknown>;
  transaction: <T>(fn: (tx: DbLike) => Promise<T>) => Promise<T>;
};

let _dbOverride: DbLike | null = null;

export function _setEthBigBetStoreDbForTesting(db: DbLike | null): void {
  _dbOverride = db;
}

async function getDb(): Promise<DbLike> {
  if (_dbOverride) return _dbOverride;
  const mod = await import("@workspace/db");
  return mod.db as unknown as DbLike;
}

export function isEthBigBetTerminalStatus(status: EthBigBetOrderStatus): boolean {
  return status === "rejected" || status === "settled";
}

export function validateEthBigBetIntentForStorage(intent: EthBigBetOrderIntent): boolean {
  return (intent.strategy === "jump" || intent.strategy === "reversal")
    && /^KXETH15M-/.test(intent.ticker)
    && (intent.side === "yes" || intent.side === "no")
    && Number.isInteger(intent.marketOpenTimeMs)
    && intent.marketOpenTimeMs > 0
    && Number.isInteger(intent.wagerCents)
    && intent.wagerCents > 0
    && Number.isInteger(intent.limitPriceCents)
    && intent.limitPriceCents >= 1
    && intent.limitPriceCents <= 99
    && ethBigBetContracts(intent.wagerCents, intent.limitPriceCents) > 0;
}

/** Dedicated B/C schema. It has no foreign key or lifecycle dependency on
 * Service A's eth420_candidate_live_orders table. Strategy+ticker uniqueness
 * blocks only an exact same-service duplicate; B and C may both own a market. */
export async function initEthBigBetStore(): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS eth_big_bet_orders (
      id text PRIMARY KEY,
      strategy text NOT NULL CHECK (strategy IN ('jump', 'reversal')),
      order_tag text NOT NULL,
      ticker text NOT NULL,
      market_open_time_ms bigint NOT NULL,
      side text NOT NULL CHECK (side IN ('yes', 'no')),
      wager_cents integer NOT NULL CHECK (wager_cents > 0),
      limit_price_cents integer NOT NULL CHECK (limit_price_cents BETWEEN 1 AND 99),
      requested_contracts numeric NOT NULL CHECK (requested_contracts > 0),
      kalshi_order_id text,
      status text NOT NULL CHECK (status IN ('reserved', 'submitted', 'submission_unknown', 'rejected', 'settled')),
      filled_contracts numeric,
      actual_notional_cents integer,
      actual_fee_cents integer,
      fill_price_cents integer,
      settlement_result text CHECK (settlement_result IS NULL OR settlement_result IN ('yes', 'no')),
      realized_pnl_cents integer,
      created_at_ms bigint NOT NULL,
      updated_at_ms bigint NOT NULL,
      UNIQUE (strategy, ticker),
      UNIQUE (order_tag, ticker)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS eth_big_bet_orders_unresolved_idx
      ON eth_big_bet_orders (strategy, status, created_at_ms)
      WHERE status NOT IN ('rejected', 'settled')
  `);
}

/** Atomic exact-market reservation. No unresolved order from an older ticker is
 * consulted, so B/C never acquire A-style cross-market lifecycle coupling. */
export async function reserveEthBigBetIntent(intent: EthBigBetOrderIntent): Promise<boolean> {
  if (!validateEthBigBetIntentForStorage(intent)) return false;
  const db = await getDb();
  const now = Date.now();
  const id = ethBigBetOrderId(intent);
  const contracts = ethBigBetContracts(intent.wagerCents, intent.limitPriceCents);
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO eth_big_bet_orders
        (id, strategy, order_tag, ticker, market_open_time_ms, side,
         wager_cents, limit_price_cents, requested_contracts, status,
         created_at_ms, updated_at_ms)
      VALUES
        (${id}, ${intent.strategy}, ${intent.orderTag}, ${intent.ticker},
         ${intent.marketOpenTimeMs}, ${intent.side}, ${intent.wagerCents},
         ${intent.limitPriceCents}, ${contracts}, 'reserved', ${now}, ${now})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const rows = (result as { rows?: unknown[] }).rows ?? [];
    return rows.length === 1;
  });
}

export async function acknowledgeEthBigBetSubmission(params: {
  id: string;
  kalshiOrderId: string;
}): Promise<boolean> {
  if (!params.id || !params.kalshiOrderId) return false;
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE eth_big_bet_orders
    SET kalshi_order_id=${params.kalshiOrderId}, status='submitted', updated_at_ms=${Date.now()}
    WHERE id=${params.id} AND status='reserved' AND kalshi_order_id IS NULL
    RETURNING id
  `);
  return ((result as { rows?: unknown[] }).rows ?? []).length === 1;
}

/** Ambiguous transport failures remain unresolved. They are never converted to
 * a rejection merely because the POST response was unavailable. */
export async function markEthBigBetSubmissionUnknown(id: string): Promise<boolean> {
  if (!id) return false;
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE eth_big_bet_orders
    SET status='submission_unknown', updated_at_ms=${Date.now()}
    WHERE id=${id} AND status='reserved'
    RETURNING id
  `);
  return ((result as { rows?: unknown[] }).rows ?? []).length === 1;
}

/** Only an authoritative exchange rejection may terminally release a B/C row. */
export async function markEthBigBetRejected(id: string): Promise<boolean> {
  if (!id) return false;
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE eth_big_bet_orders
    SET status='rejected', filled_contracts=0, realized_pnl_cents=0,
        updated_at_ms=${Date.now()}
    WHERE id=${id} AND status IN ('reserved', 'submission_unknown')
    RETURNING id
  `);
  return ((result as { rows?: unknown[] }).rows ?? []).length === 1;
}

/** Settlement is accounting-only. It never writes or reads martingale state. */
export async function settleEthBigBetOrder(params: {
  id: string;
  filledContracts: number;
  actualNotionalCents: number;
  actualFeeCents: number;
  fillPriceCents: number | null;
  settlementResult: EthBigBetSide;
  realizedPnlCents: number;
}): Promise<boolean> {
  if (!params.id
    || !Number.isFinite(params.filledContracts) || params.filledContracts < 0
    || !Number.isInteger(params.actualNotionalCents) || params.actualNotionalCents < 0
    || !Number.isInteger(params.actualFeeCents) || params.actualFeeCents < 0
    || (params.fillPriceCents != null && (!Number.isInteger(params.fillPriceCents) || params.fillPriceCents < 1 || params.fillPriceCents > 99))
    || (params.settlementResult !== "yes" && params.settlementResult !== "no")
    || !Number.isInteger(params.realizedPnlCents)) return false;
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE eth_big_bet_orders
    SET status='settled', filled_contracts=${params.filledContracts},
        actual_notional_cents=${params.actualNotionalCents},
        actual_fee_cents=${params.actualFeeCents}, fill_price_cents=${params.fillPriceCents},
        settlement_result=${params.settlementResult}, realized_pnl_cents=${params.realizedPnlCents},
        updated_at_ms=${Date.now()}
    WHERE id=${params.id} AND status IN ('submitted', 'submission_unknown')
    RETURNING id
  `);
  return ((result as { rows?: unknown[] }).rows ?? []).length === 1;
}

export async function listUnresolvedEthBigBetOrderIds(strategy?: EthBigBetStrategy): Promise<string[]> {
  const db = await getDb();
  const result = strategy
    ? await db.execute(sql`
        SELECT id FROM eth_big_bet_orders
        WHERE strategy=${strategy} AND status NOT IN ('rejected', 'settled')
        ORDER BY created_at_ms ASC
      `)
    : await db.execute(sql`
        SELECT id FROM eth_big_bet_orders
        WHERE status NOT IN ('rejected', 'settled')
        ORDER BY created_at_ms ASC
      `);
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    .map((row) => String(row["id"] ?? ""))
    .filter(Boolean);
}
