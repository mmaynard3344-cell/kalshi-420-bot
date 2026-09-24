import { sql } from "drizzle-orm";
import type { EthBigBetExecutionStore, EthBigBetExecutionReservationResult } from "./ethBigBetExecutor.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { ethBigBetCapitalRiskCents } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { initEthBigBetStore } from "./ethBigBetStore.js";
import { evaluateBkFreshBalanceOnly, isBkFreshBalanceCapitalPolicyEnabled } from "./bkFreshBalanceCapitalPolicy.js";

const DOWNFADE_STRATEGIES = new Set([
  "downfade_p80_p90",
  "downfade_p90_p95",
  "downfade_p95_p99",
  "probe_g",
  "ash_v2_i",
]);

type DbLike = { execute: (query: unknown) => Promise<unknown>; transaction: <T>(fn: (tx: DbLike) => Promise<T>) => Promise<T>; };
async function getDb(): Promise<DbLike> { const mod = await import("@workspace/db"); return mod.db as unknown as DbLike; }
function positiveInteger(value: unknown): number | null { const n = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null; }
async function allUnresolvedRiskCents(tx: DbLike): Promise<number | null> { const result = await tx.execute(sql`SELECT wager_cents, limit_price_cents FROM eth_big_bet_orders WHERE status NOT IN ('rejected', 'settled')`); const rows = (result as { rows?: Array<Record<string, unknown>> }).rows; if (!Array.isArray(rows)) return null; let total = 0; for (const row of rows) { const wager = positiveInteger(row["wager_cents"]); const price = positiveInteger(row["limit_price_cents"]); if (wager == null || price == null || price > 99) return null; const risk = ethBigBetCapitalRiskCents(wager, price); if (risk < 1 || !Number.isSafeInteger(total + risk)) return null; total += risk; } return total; }

export async function initEthDownfadeExecutionStore(): Promise<void> {
  await initEthBigBetStore();
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(42015001)`);
    await tx.execute(sql`ALTER TABLE eth_big_bet_orders DROP CONSTRAINT IF EXISTS eth_big_bet_orders_strategy_check`);
    await tx.execute(sql`ALTER TABLE eth_big_bet_orders ADD CONSTRAINT eth_big_bet_orders_strategy_check CHECK (strategy IN ('jump', 'reversal', 'breakout_reversal', 'downfade_p80_p90', 'downfade_p90_p95', 'downfade_p95_p99', 'probe_g', 'ash_v2_i'))`);
  });
}

function validIntent(intent: EthBigBetOrderIntent): boolean {
  if (!DOWNFADE_STRATEGIES.has(intent.strategy) || !/^KXETH15M-/.test(intent.ticker) || !Number.isInteger(intent.marketOpenTimeMs) || intent.marketOpenTimeMs <= 0 || !Number.isInteger(intent.wagerCents) || intent.wagerCents <= 0) return false;
  if (intent.strategy === "probe_g") return (intent.side === "yes" || intent.side === "no") && intent.wagerCents === 500 && intent.limitPriceCents === 30;
  if (intent.strategy === "ash_v2_i") return (intent.side === "yes" || intent.side === "no") && intent.wagerCents === 1_500 && intent.limitPriceCents === 50;
  return intent.side === "yes" && intent.limitPriceCents === 50;
}

export const ethDownfadeExecutionStore: EthBigBetExecutionStore = {
  async listUnresolvedEthBigBetOrderIds(strategy) { if (!DOWNFADE_STRATEGIES.has(strategy)) return []; const db = await getDb(); const result = await db.execute(sql`SELECT id FROM eth_big_bet_orders WHERE strategy=${strategy} AND status NOT IN ('rejected', 'settled') ORDER BY created_at_ms ASC`); return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []).map((row) => typeof row["id"] === "string" ? row["id"] : "").filter(Boolean); },
  async reserveEthBigBetOrder(input): Promise<EthBigBetExecutionReservationResult> { if (!validIntent(input.intent) || !Number.isInteger(input.requestedContracts) || input.requestedContracts < 1 || !Number.isSafeInteger(input.requestedRiskCents) || input.requestedRiskCents < 1) return "reservation_failed"; if (input.requestedRiskCents !== ethBigBetCapitalRiskCents(input.intent.wagerCents, input.intent.limitPriceCents)) return "reservation_failed"; const db = await getDb(); try { return await db.transaction(async (tx) => { await tx.execute(sql`SELECT pg_advisory_xact_lock(42015000)`); if (isBkFreshBalanceCapitalPolicyEnabled()) { if (evaluateBkFreshBalanceOnly(input.capital.availableBalanceCents, input.requestedRiskCents) !== "allow") return "capital_blocked"; } else { const otherBigBetReservedCents = await allUnresolvedRiskCents(tx); if (otherBigBetReservedCents == null) return "reservation_failed"; const capital = evaluateEthAccountCapital({ ...input.capital, otherBigBetReservedCents, requestedRiskCents: input.requestedRiskCents }); if (!capital.allowed) return "capital_blocked"; } const result = await tx.execute(sql`INSERT INTO eth_big_bet_orders (id, strategy, order_tag, ticker, market_open_time_ms, side, wager_cents, limit_price_cents, requested_contracts, status, created_at_ms, updated_at_ms) VALUES (${input.orderId}, ${input.intent.strategy}, ${input.intent.orderTag}, ${input.intent.ticker}, ${input.intent.marketOpenTimeMs}, ${input.intent.side}, ${input.intent.wagerCents}, ${input.intent.limitPriceCents}, ${input.requestedContracts}, 'reserved', ${input.reservedAtMs}, ${input.reservedAtMs}) ON CONFLICT DO NOTHING RETURNING id`); const rows = (result as { rows?: unknown[] }).rows ?? []; return rows.length === 1 ? "reserved" : "reservation_failed"; }); } catch { return "reservation_failed"; } },
  async acknowledgeEthBigBetOrder(input) { const db = await getDb(); if (input.status === "submitted") { if (!input.exchangeOrderId) return false; const result = await db.execute(sql`UPDATE eth_big_bet_orders SET kalshi_order_id=${input.exchangeOrderId}, status='submitted', updated_at_ms=${input.acknowledgedAtMs} WHERE id=${input.orderId} AND status='reserved' AND kalshi_order_id IS NULL RETURNING id`); return ((result as { rows?: unknown[] }).rows ?? []).length === 1; } if (input.status === "rejected") { const result = await db.execute(sql`UPDATE eth_big_bet_orders SET status='rejected', filled_contracts=0, realized_pnl_cents=0, updated_at_ms=${input.acknowledgedAtMs} WHERE id=${input.orderId} AND status='reserved' RETURNING id`); return ((result as { rows?: unknown[] }).rows ?? []).length === 1; } const result = await db.execute(sql`UPDATE eth_big_bet_orders SET status='submission_unknown', updated_at_ms=${input.acknowledgedAtMs} WHERE id=${input.orderId} AND status='reserved' RETURNING id`); return ((result as { rows?: unknown[] }).rows ?? []).length === 1; },
};
