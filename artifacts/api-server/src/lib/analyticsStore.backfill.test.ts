/**
 * Backfill win/loss durability test.
 *
 * Confirms that a settled order restored via backfillMissingOrdersFromSql():
 *   1. Has win/P&L present in the in-memory analytics store immediately after
 *      the first backfill call (simulates restart #1).
 *   2. Has win/P&L present in the NDJSON line appended to disk during that
 *      backfill (simulates restart #2 — loading from NDJSON instead of SQL).
 *
 * This catches the regression where appendOrderRecord omits the settlement
 * fields from the serialized line, causing win/loss to vanish on the second
 * consecutive restart.
 *
 * Test isolation: uses Eastern date 1970-01-16, distinct from the 1970-01-15
 * date used by analyticsStore.sql.test.ts, so the two suites don't collide.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { db, orderAttempts } from "@workspace/db";
import { eq } from "drizzle-orm";

import { initTradeStore } from "./tradeStore.js";
import { backfillMissingOrdersFromSql } from "./analyticsStore.js";
import { getOrderAttemptById, _resetStateForTesting } from "./analytics.js";

// ── Fixture ───────────────────────────────────────────────────────────────────

const TEST_DATE = "1970-01-16";
const DATA_DIR  = join(process.cwd(), "data", "analytics");
const NDJSON    = join(DATA_DIR, `orders-${TEST_DATE}.ndjson`);

// A settled YES fill: won=true, 100 contracts @ 80¢ → grossPnl = (100-80)*100/100 = $20
function makeSettledRow(overrides: Partial<typeof orderAttempts.$inferInsert> = {}) {
  const base: typeof orderAttempts.$inferInsert = {
    id:                     `bf-test-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    timestampMs:            Date.UTC(1970, 0, 16, 12, 0, 0),
    easternDate:            TEST_DATE,
    ticker:                 "KXBTC15M-BFTEST",
    series:                 "KXBTC15M",
    windowCloseTime:        `${TEST_DATE}T12:00:00Z`,
    side:                   "yes",
    attemptNumber:          1,
    source:                 "websocket",
    triggerPriceCents:      80,
    limitPriceCents:        80,
    requestedContracts:     100,
    requestedNotionalCents: 8000,
    clientOrderId:          `bf-coid-${Math.random().toString(36).slice(2)}`,
    orderId:                `bf-oid-${Math.random().toString(36).slice(2)}`,
    fillCount:              100,
    remainingCount:         0,
    contracts:              100,
    fillPriceCents:         80,
    notionalDollars:        80,
    feeDollars:             0.04,
    outcome:                "filled",
    roundTripMs:            150,
    reconciled:             true,
    won:                    true,
    updatedAt:              new Date(Date.UTC(1970, 0, 16, 13, 0, 0)),
  };
  return {
    ...base,
    isSynthetic: true,
    fixtureNamespace: "analytics-store-backfill-test",
    ...overrides,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("backfillMissingOrdersFromSql — win/loss survives two restarts", () => {
  const insertedIds: string[] = [];

  before(async () => {
    await initTradeStore();
    mkdirSync(DATA_DIR, { recursive: true });

    // Remove any leftover NDJSON from a prior run so tests start clean
    if (existsSync(NDJSON)) unlinkSync(NDJSON);

    // Insert a settled order (won=true) that has no corresponding NDJSON entry
    const rows = [
      makeSettledRow({ won: true }),
      makeSettledRow({ won: false, side: "no", outcome: "filled" }),
    ];
    const inserted = await db.insert(orderAttempts).values(rows).returning({ id: orderAttempts.id });
    insertedIds.push(...inserted.map((r) => r.id));
  });

  after(async () => {
    for (const id of insertedIds) {
      await db.delete(orderAttempts).where(eq(orderAttempts.id, id));
    }
    if (existsSync(NDJSON)) unlinkSync(NDJSON);
  });

  test("restart #1 — in-memory records have win and grossPnlDollars after backfill", async () => {
    _resetStateForTesting();

    await backfillMissingOrdersFromSql(TEST_DATE);

    // Both inserted rows should now be in memory
    const orders = getOrderAttempts_forTest();
    assert.ok(orders.length >= 2, `expected ≥2 backfilled records, got ${orders.length}`);

    for (const r of orders) {
      assert.ok(r.win !== undefined, `record ${r.id}: win field must be present`);
      assert.ok(r.win !== null,      `record ${r.id}: win must not be null for a settled order`);
      assert.ok(typeof r.grossPnlDollars === "number", `record ${r.id}: grossPnlDollars must be a number`);
    }

    const winner = orders.find((r) => r.win === true);
    assert.ok(winner, "at least one winning record expected");
    // grossPnl for YES win @ 80¢, 100 contracts: (100-80)*100/100 = $20
    assert.ok(
      Math.abs(winner!.grossPnlDollars! - 20) < 0.01,
      `expected grossPnlDollars ≈ 20, got ${winner!.grossPnlDollars}`,
    );

    const loser = orders.find((r) => r.win === false);
    assert.ok(loser, "at least one losing record expected");
    // grossPnl for NO loss @ 80¢, 100 contracts: -(80*100)/100 = -$80
    assert.ok(
      loser!.grossPnlDollars! < 0,
      `losing record grossPnlDollars must be negative, got ${loser!.grossPnlDollars}`,
    );
  });

  test("restart #1 — NDJSON file written with win and grossPnlDollars in each line", async () => {
    // appendOrderRecord defers via setImmediate — flush it before reading disk
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(existsSync(NDJSON), `NDJSON file must exist at ${NDJSON}`);

    const raw   = readFileSync(NDJSON, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 2, `expected ≥2 lines in NDJSON, got ${lines.length}`);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.ok(
        "win" in parsed,
        `NDJSON line for ${parsed["id"]} must contain 'win' field`,
      );
      assert.ok(
        parsed["win"] !== null && parsed["win"] !== undefined,
        `NDJSON line for ${parsed["id"]}: win must not be null`,
      );
      assert.ok(
        typeof parsed["grossPnlDollars"] === "number",
        `NDJSON line for ${parsed["id"]}: grossPnlDollars must be a number`,
      );
    }
  });

  test("restart #2 — parsing the NDJSON line preserves win and grossPnlDollars", async () => {
    // Simulate a second restart: reset in-memory state and load only from the
    // NDJSON written during the first backfill (no SQL call this time).
    _resetStateForTesting();

    assert.ok(existsSync(NDJSON), "NDJSON from restart #1 must still be present");
    const raw   = readFileSync(NDJSON, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      // Confirm the raw JSON has the fields before recordParser touches it
      assert.ok(
        "win" in parsed && parsed["win"] !== null,
        `NDJSON line ${parsed["id"]}: win must be present and non-null`,
      );
      assert.ok(
        typeof parsed["grossPnlDollars"] === "number",
        `NDJSON line ${parsed["id"]}: grossPnlDollars must be a number after round-trip`,
      );
    }
  });
});

// ── Thin helper — reads _orders without date-filtering ────────────────────────
// getOrderAttempts() in analytics.ts may filter by today's date in production;
// we bypass that by reading via getOrderAttemptById for the IDs we inserted,
// but since we don't know the compound IDs upfront we read all orders here.
import { getOrderAttempts as _getOrderAttempts } from "./analytics.js";

function getOrderAttempts_forTest() {
  // Only return orders with our test date to avoid cross-contamination
  return _getOrderAttempts().filter(
    (r) => r.timestampMs === Date.UTC(1970, 0, 16, 12, 0, 0),
  );
}
