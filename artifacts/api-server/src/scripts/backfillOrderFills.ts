#!/usr/bin/env tsx
/**
 * Backfill order_fills for every order_attempts row that has a Kalshi order_id.
 *
 * Run once after deploying the order_fills table migration to hydrate
 * historical fill data. Safe to re-run: onConflictDoNothing prevents duplicates.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillOrderFills.ts
 *
 * Writes a summary CSV to stdout showing per-order stored cost vs reconciled
 * cost and flagging rows where fill_price_source = 'limit_fallback'.
 *
 * Environment: DATABASE_URL and KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY must be set.
 */

import { db } from "@workspace/db";
import { orderAttempts, orderFills } from "@workspace/db";
import { isNull, isNotNull, eq, not, inArray } from "drizzle-orm";
import { kalshiAuthFetch } from "../lib/kalshiAuth.js";
import {
  normalizeKalshiFill,
  type KalshiFillWire,
} from "../lib/kalshiFillNormalizer.js";
interface KalshiOrderFillsResponse {
  fills?: KalshiFillWire[];
  [key: string]: unknown;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const UNRESOLVED = ["pending", "reserved", "post_started", "post_unknown", "interrupted_shutdown"];

async function main() {
  // Load all order_attempts rows that have a Kalshi order_id and are finalised.
  const rows = await db
    .select({
      id:             orderAttempts.id,
      clientOrderId:  orderAttempts.clientOrderId,
      orderId:        orderAttempts.orderId,
      ticker:         orderAttempts.ticker,
      side:           orderAttempts.side,
      fillPriceCents: orderAttempts.fillPriceCents,
      limitPriceCents:orderAttempts.limitPriceCents,
      contracts:      orderAttempts.contracts,
      notionalDollars:orderAttempts.notionalDollars,
      fillPriceSource:orderAttempts.fillPriceSource,
      outcome:        orderAttempts.outcome,
    })
    .from(orderAttempts)
    .where(isNotNull(orderAttempts.orderId));

  const eligible = rows.filter(
    (r) => r.orderId && !UNRESOLVED.includes(r.outcome ?? ""),
  );

  console.error(`backfillOrderFills: found ${eligible.length} eligible rows to process`);

  // Check which order_ids already have fills in order_fills.
  const existingOrderIds = new Set<string>();
  if (eligible.length > 0) {
    const orderIds = eligible.map((r) => r.orderId!);
    // Query in batches of 100 to avoid IN clause limits.
    for (let i = 0; i < orderIds.length; i += 100) {
      const batch = orderIds.slice(i, i + 100);
      const existing = await db
        .selectDistinct({ orderId: orderFills.orderId })
        .from(orderFills)
        .where(inArray(orderFills.orderId, batch));
      for (const r of existing) existingOrderIds.add(r.orderId);
    }
  }

  const toFetch = eligible.filter((r) => !existingOrderIds.has(r.orderId!));
  console.error(`backfillOrderFills: ${existingOrderIds.size} already have fills; fetching ${toFetch.length} new`);

  // CSV header
  console.log("attempt_id,order_id,ticker,side,stored_fill_price_cents,stored_notional_dollars,reconciled_avg_price_cents,reconciled_notional_dollars,fill_chunks,fill_price_source,discrepancy_cents");

  let ok = 0, failed = 0, skipped = 0;

  for (const row of toFetch) {
    const orderId   = row.orderId!;
    const side      = (row.side as "yes" | "no");
    const attemptId = row.clientOrderId ?? row.id;

    try {
      // Rate-limit: 200 ms between requests.
      await sleep(200);

      const data = await kalshiAuthFetch<KalshiOrderFillsResponse>(
        "GET",
        `/portfolio/fills?order_id=${encodeURIComponent(orderId)}`,
      );

      const fills = data.fills ?? [];
      if (fills.length === 0) {
        console.error(`backfillOrderFills: no fills for ${orderId} — skipping`);
        skipped++;
        continue;
      }

      let totalContracts = 0;
      let weightedSum    = 0;
      let totalNotionalDollars = 0;
      let totalFeeDollars      = 0;

      const insertRows: typeof orderFills.$inferInsert[] = [];

      for (let i = 0; i < fills.length; i++) {
        const fill  = fills[i]!;
        const normalized = normalizeKalshiFill(fill, side);
        if (!normalized) continue;
        const {
          contracts: count,
          fillPriceCents: priceCents,
          feeDollars: validFee,
          fillTimestamp,
        } = normalized;

        totalContracts += count;
        weightedSum    += priceCents * count;
        totalNotionalDollars += (priceCents * count) / 100;
        totalFeeDollars += validFee;

        insertRows.push({
          id:             `${orderId}:${i}`,
          orderId,
          attemptId,
          ticker:         row.ticker,
          side,
          fillPriceCents: priceCents,
          contracts:      count,
          costDollars:    (priceCents * count) / 100,
          feeDollars:     validFee, // already in dollars — no /100
          fillTimestamp,
        });
      }

      if (insertRows.length > 0) {
        await db.insert(orderFills).values(insertRows).onConflictDoNothing();
      }

      // Update the parent totals as well as the audit rows. The daily-profit
      // guard reads order_attempts, so only recording order_fills would leave
      // fees missing from realized P&L.
      const reconciledAvg = totalContracts > 0 ? Math.round(weightedSum / totalContracts) : 0;
      await db
        .update(orderAttempts)
        .set({
          fillPriceCents: reconciledAvg,
          contracts: totalContracts,
          notionalDollars: totalNotionalDollars,
          feeDollars: totalFeeDollars,
          fillPriceSource: "actual",
          reconciled: true,
        })
        .where(eq(orderAttempts.id, row.id));

      const reconciledNotional = totalNotionalDollars;
      const storedPrice = row.fillPriceCents ?? row.limitPriceCents ?? 0;
      const storedNotional = row.notionalDollars ?? 0;
      const discrepancy = reconciledAvg - storedPrice;

      console.log([
        attemptId,
        orderId,
        row.ticker,
        side,
        storedPrice,
        storedNotional.toFixed(4),
        reconciledAvg,
        reconciledNotional.toFixed(4),
        insertRows.length,
        row.fillPriceSource ?? "limit_fallback",
        discrepancy,
      ].join(","));

      ok++;
    } catch (err) {
      console.error(`backfillOrderFills: error for ${orderId}:`, err);
      failed++;
    }
  }

  // Audit summary: flag all rows where fill_price_source is null or 'limit_fallback'.
  const fallbackRows = await db
    .select({
      id:             orderAttempts.id,
      orderId:        orderAttempts.orderId,
      ticker:         orderAttempts.ticker,
      side:           orderAttempts.side,
      outcome:        orderAttempts.outcome,
      fillPriceCents: orderAttempts.fillPriceCents,
      fillPriceSource:orderAttempts.fillPriceSource,
    })
    .from(orderAttempts)
    .where(
      not(inArray(orderAttempts.outcome ?? "", UNRESOLVED)),
    );

  const flagged = fallbackRows.filter(
    (r) => !UNRESOLVED.includes(r.outcome ?? "") &&
           (r.fillPriceSource === null || r.fillPriceSource === "limit_fallback"),
  );

  console.error(`\nbackfillOrderFills: done. ok=${ok}, failed=${failed}, skipped=${skipped}`);
  console.error(`Rows with limit_fallback or null fill_price_source: ${flagged.length}`);
  if (flagged.length > 0) {
    console.error("  Sample (up to 5):");
    for (const r of flagged.slice(0, 5)) {
      console.error(`    attempt=${r.id} order=${r.orderId ?? "none"} ticker=${r.ticker} source=${r.fillPriceSource ?? "null"}`);
    }
  }
}

main().catch((err) => { console.error("backfillOrderFills: fatal error", err); process.exit(1); });
