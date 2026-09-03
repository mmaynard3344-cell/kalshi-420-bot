import assert from "node:assert/strict";
import test from "node:test";
import type { OrderAttemptRecord } from "./analytics.js";
import {
  canonicalFilledOrders,
  canonicalUnreconciledFilledOrders,
} from "./orderCanonicalization.js";

function fill(overrides: Partial<OrderAttemptRecord>): OrderAttemptRecord {
  return {
    id: "attempt-1",
    timestampMs: 1,
    ticker: "KXBTC15M-test",
    series: "KXBTC15M",
    side: "yes",
    attemptNumber: 1,
    orderId: "kalshi-shared-order",
    outcome: "full_fill",
    outcomeReconciledAt: null,
    reconciled: false,
    fill_price_source: null,
    ...overrides,
  } as OrderAttemptRecord;
}

test("live settlement selects one earliest attempt for duplicate exchange order IDs", () => {
  const selected = canonicalUnreconciledFilledOrders([
    fill({ id: "retry-2", attemptNumber: 2, timestampMs: 2 }),
    fill({ id: "original-1", attemptNumber: 1, timestampMs: 1 }),
  ]);
  assert.deepEqual(selected.map((order) => order.id), ["original-1"]);
});

test("restart settlement does not settle an unreconciled duplicate of an already settled order", () => {
  const selected = canonicalUnreconciledFilledOrders([
    fill({ id: "original-settled", outcomeReconciledAt: 10 }),
    fill({ id: "retry-unsettled", attemptNumber: 2, timestampMs: 2 }),
  ]);
  assert.deepEqual(selected, []);
});

test("reporting keeps one canonical settled execution per exchange order", () => {
  const selected = canonicalFilledOrders([
    fill({ id: "retry-2", attemptNumber: 2, timestampMs: 2, outcomeReconciledAt: 10 }),
    fill({ id: "original-1", outcomeReconciledAt: 10 }),
  ]);
  assert.deepEqual(selected.map((order) => order.id), ["original-1"]);
});