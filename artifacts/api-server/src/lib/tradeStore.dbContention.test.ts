/**
 * Real-development-DB regression coverage for dashboard-read congestion.
 *
 * Four bounded dashboard reads hold actual PostgreSQL clients. A fifth status
 * read must remain queued, leaving the final pool client available for the
 * durable heartbeat and settlement-reconciliation writes. No order API or
 * order_attempt row is created by this suite.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { db, getBoundedReadOnlyStatus, pool, withBoundedReadOnlyClient } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  _drainPendingDurableWritesForTesting,
  initTradeStore,
  isStorageHealthy,
  getStorageStatus,
  persistMarketResultAwaited,
  recordRuntimeHeartbeat,
  upsertWindowLogEntryInSql,
} from "./tradeStore.js";

const fixtureId = `TEST-DB-CONTENTION-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const heartbeatRunId = `${fixtureId}-heartbeat`;
const marketTicker = `${fixtureId}-market`;
const windowTicker = `${fixtureId}-window`;

const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

describe("tradeStore — database congestion safety lane", () => {
  after(async () => {
    await _drainPendingDurableWritesForTesting().catch(() => {});
    await db.execute(sql`DELETE FROM window_log WHERE ticker = ${windowTicker}`).catch(() => {});
    await db.execute(sql`DELETE FROM market_results WHERE ticker = ${marketTicker}`).catch(() => {});
    await db.execute(sql`DELETE FROM runtime_heartbeats WHERE run_id = ${heartbeatRunId}`).catch(() => {});
    await pool.end().catch(() => {});
  });

  it("keeps one real client for heartbeat and reconciliation persistence while dashboard reads queue", async () => {
    await initTradeStore();
    assert.equal(isStorageHealthy(), true, "development database must be healthy before contention starts");

    const releaseReads: Array<() => void> = [];
    let startedReads = 0;
    const dashboardReads = Array.from({ length: 4 }, () =>
      withBoundedReadOnlyClient(5_000, async (client) => {
        await client.query("SELECT current_timestamp");
        startedReads++;
        await new Promise<void>((resolve) => releaseReads.push(resolve));
      }),
    );
    let dashboardBacklog: Promise<void> | null = null;
    try {
      await waitFor(() => startedReads === 4, "four dashboard reads must hold real PostgreSQL clients");

      let backlogReadStarted = false;
      dashboardBacklog = withBoundedReadOnlyClient(5_000, async (client) => {
        backlogReadStarted = true;
        await client.query("SELECT current_timestamp");
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(backlogReadStarted, false, "fifth dashboard/status read must queue behind the bounded-read lane");
       assert.deepEqual(getBoundedReadOnlyStatus(), {
         activeReadCount: 4,
         queueDepth: 1,
         maxConcurrentReads: 4,
         reservedSafetyClients: 1,
       });
       const storageStatus = await getStorageStatus();
       assert.deepEqual(storageStatus.dashboardReadProtection, {
         activeReadCount: 4,
         queueDepth: 1,
         maxConcurrentReads: 4,
         reservedSafetyClients: 1,
         dashboardTrafficThrottled: true,
         message: "Dashboard reads are waiting to keep a database client available for trading heartbeats and settlement reconciliation.",
       });

      const occurredAtMs = Date.now();
      await Promise.all([
        recordRuntimeHeartbeat({
          runId: heartbeatRunId,
          occurredAtMs,
          pid: process.pid,
          environment: "workspace",
          components: { runner: true, collector: true, watchdog: true, websocket: true, protectiveExit: true },
        }),
        persistMarketResultAwaited(marketTicker, "yes"),
      ]);

      assert.equal(
        backlogReadStarted,
        false,
        "heartbeat and settlement reconciliation must persist before the dashboard backlog receives capacity",
      );
      const [heartbeat, reconciliation] = await Promise.all([
        db.execute(sql`SELECT run_id FROM runtime_heartbeats WHERE run_id = ${heartbeatRunId}`),
        db.execute(sql`SELECT result FROM market_results WHERE ticker = ${marketTicker}`),
      ]);
      assert.equal(heartbeat.rows[0]?.["run_id"], heartbeatRunId);
      assert.equal(reconciliation.rows[0]?.["result"], "yes");

      for (const release of releaseReads) release();
      await Promise.all([...dashboardReads, dashboardBacklog]);
      assert.equal(backlogReadStarted, true);
       assert.deepEqual(getBoundedReadOnlyStatus(), {
         activeReadCount: 0,
         queueDepth: 0,
         maxConcurrentReads: 4,
         reservedSafetyClients: 1,
       });
    } finally {
      // Assertions above intentionally run while clients are held. Always
      // release them on failure so cleanup can use the pool and report the
      // original assertion instead of hanging behind the synthetic contention.
      for (const release of releaseReads) release();
      await Promise.allSettled([...dashboardReads, ...(dashboardBacklog ? [dashboardBacklog] : [])]);
    }
  });

  it("retains a newer same-key durable update when the first SQL write is delayed", async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("LOCK TABLE window_log IN ACCESS EXCLUSIVE MODE");

      upsertWindowLogEntryInSql({
        ticker: windowTicker, series: "TEST", closeTime: null, firstSeenMs: Date.now(),
        entered: false, inZone: false, yesDerivedAsk: 70, noDerivedAsk: null,
        outcome: "pending", side: null, priceCents: null, contractsFilled: null,
        spentDollars: null, skipReason: "first", settlementResult: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      upsertWindowLogEntryInSql({
        ticker: windowTicker, series: "TEST", closeTime: null, firstSeenMs: Date.now(),
        entered: true, inZone: true, yesDerivedAsk: 81, noDerivedAsk: null,
        outcome: "traded", side: "yes", priceCents: 81, contractsFilled: 2,
        spentDollars: 1.62, skipReason: null, settlementResult: "yes",
      });
    } finally {
      await lockClient.query("ROLLBACK").catch(() => {});
      lockClient.release();
    }

    await _drainPendingDurableWritesForTesting();
    const persisted = await db.execute(sql`
      SELECT entered, in_zone, outcome, side, price_cents, contracts_filled, settlement_result
      FROM window_log WHERE ticker = ${windowTicker}
    `);
    assert.deepEqual(persisted.rows[0], {
      entered: true, in_zone: true, outcome: "traded", side: "yes",
      price_cents: 81, contracts_filled: 2, settlement_result: "yes",
    });
  });
});