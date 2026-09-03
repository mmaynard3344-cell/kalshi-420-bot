/**
 * Read-only report loader regression tests.
 *
 * These tests exercise only injected disk/SQL readers. They never import order
 * submission code, reserve budget, or make HTTP requests.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadMergedAnalyticsOrders,
  mergeAnalyticsOrderRecords,
  type AnalyticsOrderLoaders,
} from "./analyticsStore.js";
import type { OrderAttemptRecord } from "./analytics.js";

function record(id: string, overrides: Partial<OrderAttemptRecord> = {}): OrderAttemptRecord {
  return {
    id,
    timestampMs: 1_700_000_000_000,
    ticker: "KXBTC15M-TEST",
    series: "KXBTC15M",
    windowCloseTime: "2023-11-14T22:15:00Z",
    side: "yes",
    attemptNumber: 1,
    source: "rest_fallback",
    triggerPriceCents: 80,
    limitPriceCents: 80,
    requestedContracts: 10,
    requestedNotionalCents: 800,
    clientOrderId: `client-${id}`,
    orderId: `order-${id}`,
    fillCount: 10,
    remainingCount: 0,
    contracts: { value: 10, source: "confirmed_from_response" },
    fillPriceCents: { value: 80, source: "confirmed_from_response" },
    notionalDollars: { value: 8, source: "confirmed_from_response" },
    feeDollars: { value: 0.01, source: "confirmed_from_response" },
    outcome: "full_fill",
    roundTripMs: 100,
    reconciled: true,
    win: false,
    grossPnlDollars: -8,
    netPnlDollars: -8.01,
    ...overrides,
  };
}

function loaders(
  disk: OrderAttemptRecord[],
  sql: () => Promise<OrderAttemptRecord[]>,
): AnalyticsOrderLoaders {
  return { loadDisk: () => disk, storageHealthy: () => true, loadSql: sql };
}

describe("loadMergedAnalyticsOrders — durable report adapter", () => {
  test("keeps NDJSON-only records unchanged", async () => {
    const local = record("local-only");
    const result = await loadMergedAnalyticsOrders(1, loaders([local], async () => []));
    assert.deepEqual(result, [local]);
  });

  test("includes a normalized SQL-only record", async () => {
    // SQL normalization is owned by tradeStore; this is the normalized shape it returns.
    const sqlOnly = record("sql-only", {
      side: "no",
      fillPriceCents: { value: 24, source: "confirmed_from_fills_api" },
      win: true,
      grossPnlDollars: 7.6,
    });
    const result = await loadMergedAnalyticsOrders(1, loaders([], async () => [sqlOnly]));
    assert.deepEqual(result, [sqlOnly]);
    assert.equal(result[0]?.fillPriceCents.value, 24);
    assert.equal(result[0]?.win, true);
  });

  test("deduplicates canonical IDs and keeps the authoritative SQL record", () => {
    const local = record("same-id", { outcome: "full_fill", win: true, netPnlDollars: 1.99 });
    const staleSql = record("same-id", { outcome: "zero_fill", win: null, netPnlDollars: null });
    const sqlOnly = record("sql-only");
    const merged = mergeAnalyticsOrderRecords([local], [staleSql, sqlOnly]);

    assert.deepEqual(merged, [staleSql, sqlOnly]);
  });

  test("uses local records unchanged when the SQL read fails", async () => {
    const local = record("local-survives-error");
    const result = await loadMergedAnalyticsOrders(
      1,
      loaders([local], async () => { throw new Error("database unavailable"); }),
    );
    assert.deepEqual(result, [local]);
  });

  test("is confined to analytics read paths and has no trading imports", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/analyticsStore.ts"), "utf8");
    assert.match(source, /loadOrdersFromSqlForRange/);
    assert.doesNotMatch(source, /from "\.\/autoTrader\.js"/);
    assert.doesNotMatch(source, /from "\.\.\/routes\/trade\.js"/);
    assert.doesNotMatch(source, /\bcheckAndPlace\b|\bplaceOrder\b|\breserveBudget\b/);
  });
});