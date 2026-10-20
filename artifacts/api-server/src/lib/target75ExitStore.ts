import { sql } from "drizzle-orm";
import type { Target75FillEvidence } from "./target75FillEvidence.js";
import { validateTarget75FillEvidence } from "./target75FillEvidence.js";

export type ExitDb = {
  execute(query: unknown): Promise<unknown>;
  transaction<T>(action: (db: ExitDb) => Promise<T>): Promise<T>;
};
const rows = (x: unknown) => (x as { rows?: Record<string, unknown>[] }).rows ?? [];

export async function reserveExit(db: ExitDb, p: {
  key: string; strategy: string; ticker: string; entryId: string;
  side: "yes" | "no"; quantity: number; bidCents: number;
}): Promise<boolean> {
  if (!/^KXETH[A-Z0-9]*-[A-Z0-9-]+$/.test(p.ticker) ||
      !p.key || !p.strategy || !p.entryId ||
      !Number.isSafeInteger(p.quantity) || p.quantity <= 0 ||
      !Number.isSafeInteger(p.bidCents) || p.bidCents < 75 || p.bidCents > 99)
    return false;
  const now = Date.now();
  const result = await db.execute(sql`
    INSERT INTO eth_target75_exits
      (exit_client_order_id,strategy,ticker,entry_order_id,held_side,
       requested_contracts,minimum_held_bid_cents,status,created_at_ms,updated_at_ms)
    VALUES (${p.key},${p.strategy},${p.ticker},${p.entryId},${p.side},
      ${p.quantity},${p.bidCents},'reserved',${now},${now})
    ON CONFLICT DO NOTHING RETURNING exit_client_order_id
  `);
  return rows(result).length === 1;
}

export async function fenceExitPost(db: ExitDb, key: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE eth_target75_exits SET status='post_started', updated_at_ms=${Date.now()}
    WHERE exit_client_order_id=${key} AND status='reserved'
    RETURNING exit_client_order_id
  `);
  return rows(result).length === 1;
}

export async function recordExitFill(db: ExitDb, fill: Target75FillEvidence): Promise<boolean> {
  return db.transaction(async tx => {
    const record = rows(await tx.execute(sql`
      SELECT * FROM eth_target75_exits
      WHERE exit_client_order_id=${fill.exitClientOrderId} FOR UPDATE
    `))[0];
    if (!record || !["submitted", "partial", "filled"].includes(String(record["status"])) ||
        typeof record["provider_order_id"] !== "string" || !record["provider_order_id"]) return false;
    const previous = rows(await tx.execute(sql`
      SELECT COALESCE(SUM(contracts),0) AS filled FROM eth_target75_exit_fills
      WHERE exit_client_order_id=${fill.exitClientOrderId}
    `))[0];
    const remaining = Number(record["requested_contracts"]) - Number(previous?.["filled"] ?? 0);
    const verdict = validateTarget75FillEvidence(fill, {
      strategy: String(record["strategy"]), ticker: String(record["ticker"]),
      entryOrderId: String(record["entry_order_id"]),
      exitClientOrderId: String(record["exit_client_order_id"]),
      providerOrderId: record["provider_order_id"] as string,
      heldSide: record["held_side"] === "no" ? "no" : "yes",
      maxOpenContracts: remaining, seenFillIds: new Set(),
    });
    if (verdict !== "ok") return false;
    const inserted = rows(await tx.execute(sql`
      INSERT INTO eth_target75_exit_fills
        (provider_fill_id,exit_client_order_id,provider_order_id,
         contracts,gross_proceeds_cents,fee_cents,observed_at_ms)
      VALUES (${fill.providerFillId},${fill.exitClientOrderId},
        ${fill.providerOrderId},${fill.contracts},
        ${fill.grossProceedsCents},${fill.feeCents},${Date.now()})
      ON CONFLICT DO NOTHING RETURNING provider_fill_id
    `));
    if (inserted.length !== 1) return false;
    const changed = rows(await tx.execute(sql`
      UPDATE eth_target75_exits SET status=${remaining === fill.contracts ? "filled" : "partial"},
        updated_at_ms=${Date.now()}
      WHERE exit_client_order_id=${fill.exitClientOrderId}
      RETURNING exit_client_order_id
    `));
    if (changed.length !== 1) throw new Error("exit_fill_status_commit_failed");
    return true;
  });
}

/** Persist an authenticated exchange order identity before accepting fills. */
export async function linkExitProviderOrder(
  db: ExitDb, key: string, providerOrderId: string,
): Promise<boolean> {
  if (!key || !providerOrderId) return false;
  const result = await db.execute(sql`
    UPDATE eth_target75_exits
    SET provider_order_id=${providerOrderId},status='submitted',updated_at_ms=${Date.now()}
    WHERE exit_client_order_id=${key} AND status='post_started'
      AND provider_order_id IS NULL
    RETURNING exit_client_order_id
  `);
  return rows(result).length === 1;
}

/**
 * Read-only identity recovery for an uncertain IOC POST.
 * Exactly one authenticated matching order is required; ambiguity remains
 * fenced for manual/independent reconciliation. This function does not retry.
 */
export function identifyTarget75ExchangeOrder(input: {
  clientOrderId: string; ticker: string; orderCandidates: ReadonlyArray<Record<string,unknown>>;
}): string | null {
  if (!input.clientOrderId || !/^KXETH[A-Z0-9]*-[A-Z0-9-]+$/.test(input.ticker)) return null;
  const matches = input.orderCandidates.filter(order =>
    order["client_order_id"] === input.clientOrderId &&
    order["ticker"] === input.ticker &&
    typeof order["order_id"] === "string" && (order["order_id"] as string).length > 0);
  return matches.length === 1 ? matches[0]!["order_id"] as string : null;
}

/**
 * Recover a known exchange order only after a read-only authenticated query
 * identifies exactly one matching client order ID and ticker. The durable
 * post_started fence remains in force if identification is ambiguous.
 */
export async function recoverTarget75ProviderOrder(db: ExitDb, input: {
  clientOrderId: string; ticker: string;
  orderCandidates: ReadonlyArray<Record<string, unknown>>;
}): Promise<boolean> {
  const providerOrderId = identifyTarget75ExchangeOrder(input);
  if (!providerOrderId) return false;
  const existing = rows(await db.execute(sql`
    SELECT exit_client_order_id, ticker, status, provider_order_id
    FROM eth_target75_exits WHERE exit_client_order_id=${input.clientOrderId}
  `))[0];
  if (!existing || existing["ticker"] !== input.ticker ||
      existing["status"] !== "post_started" ||
      existing["provider_order_id"] !== null) return false;
  return linkExitProviderOrder(db, input.clientOrderId, providerOrderId);
}
