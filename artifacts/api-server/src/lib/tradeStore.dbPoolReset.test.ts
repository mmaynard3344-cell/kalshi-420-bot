/**
 * Controlled transient-outage test for the DB reconnect path.
 *
 * Reproduces the 2026-08-15 production pattern: repeated "timeout exceeded
 * when trying to connect" pings against a pool that never heals. Verifies:
 *   1. Persistent ping failures trigger the pool-reset hook (fresh pool).
 *   2. Recovery drains buffered fire-and-forget writes.
 *   3. The infrastructure_incidents audit row is UPSERTED — a "failed" row
 *      written mid-outage must end up recovery_outcome='recovered' (the old
 *      ON CONFLICT DO NOTHING left it permanently 'failed').
 *
 * Uses the real dev database (same convention as tradeStore.test.ts).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  initTradeStore,
  isStorageHealthy,
  upsertWindowLogEntryInSql,
  getPendingDurableWriteCount,
  _drainPendingDurableWritesForTesting,
  _setPoolResetHookForTesting,
  _getConsecutivePingFailuresForTesting,
  _runRetryAttemptNowForTesting,
} from "./tradeStore.js";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tradeStore — pool reset under controlled transient outage", () => {
  after(async () => { await pool.end().catch(() => {}); });

  it("persistent ping failures → pool reset hook fires → recovery drains buffer and upserts audit to 'recovered'", async () => {
    const testStartMs = Date.now();
    const ticker = `TEST-POOLRESET-${testStartMs}`;

    // Partial-outage proxy: SELECT 1 pings fail while the outage is active,
    // every other statement is delegated to the real dev DB — so the mid-outage
    // "failed" audit row actually lands in infrastructure_incidents, letting us
    // verify the recovered upsert overwrites it.
    let outageActive = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flakyDb = new Proxy(db as any, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (query: any) => {
            if (outageActive && inspect(query, { depth: 4 }).includes("SELECT 1")) {
              throw new Error("timeout exceeded when trying to connect (simulated)");
            }
            return target.execute(query);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Step 1: init against the flaky DB — startup ping fails → degraded.
    await initTradeStore(flakyDb);
    assert.equal(isStorageHealthy(), false, "storage must be degraded during outage");
    assert.equal(_getConsecutivePingFailuresForTesting(), 1);

    // Step 2: a fire-and-forget write during the outage must buffer, not drop.
    const before = getPendingDurableWriteCount();
    upsertWindowLogEntryInSql({
      ticker, series: "KXBTC15M", closeTime: null, firstSeenMs: Date.now(),
      entered: true, inZone: true, yesDerivedAsk: 85, noDerivedAsk: null,
      outcome: "traded", side: "yes", priceCents: 85, contractsFilled: 1,
      spentDollars: 0.85, skipReason: null, settlementResult: null,
    } as Parameters<typeof upsertWindowLogEntryInSql>[0]);
    assert.equal(getPendingDurableWriteCount(), before + 1, "write must buffer while degraded");

    // Step 3: register the pool-reset hook. "Recreating the pool" here means
    // ending the simulated outage — exactly what a fresh pool does in prod
    // when the provider endpoint has moved and stale sockets are discarded.
    let resetCalls = 0;
    _setPoolResetHookForTesting(async () => {
      resetCalls++;
      outageActive = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return flakyDb as any;
    });
    // _setPoolResetHookForTesting zeroes the failure counter; re-accumulate.

    // Step 4: two failed retry attempts → 2 consecutive failures, hook must
    // NOT have fired yet (threshold is 3); a "failed" audit row is persisted.
    await _runRetryAttemptNowForTesting();
    await _runRetryAttemptNowForTesting();
    assert.equal(resetCalls, 0, "pool reset must not fire below the failure threshold");
    assert.equal(_getConsecutivePingFailuresForTesting(), 2);
    assert.equal(isStorageHealthy(), false);

    // Third failure crosses the threshold.
    await _runRetryAttemptNowForTesting();
    assert.equal(_getConsecutivePingFailuresForTesting(), 3);

    // The failed-audit write is fire-and-forget — give it a moment to land.
    await sleep(750);

    // The mid-outage "failed" audit must exist (proves the upsert test below
    // exercises the conflict path, not a fresh insert).
    const failedRows = await db.execute(sql`
      SELECT id, recovery_outcome FROM infrastructure_incidents
      WHERE kind = 'database' AND started_at_ms >= ${testStartMs}
    `);
    assert.ok((failedRows.rows ?? []).length >= 1, "mid-outage 'failed' audit row must be persisted");
    assert.equal(failedRows.rows[0]!["recovery_outcome"], "failed");

    // Step 5: next attempt — threshold reached, hook fires, outage ends,
    // ping succeeds, recovery audit upserts the SAME row to 'recovered'.
    await _runRetryAttemptNowForTesting();
    assert.equal(resetCalls, 1, "pool reset hook must fire exactly once after persistent failures");
    assert.equal(isStorageHealthy(), true, "storage must recover after pool reset");
    assert.equal(_getConsecutivePingFailuresForTesting(), 0);

    // Step 6: buffered write drains to SQL.
    await _drainPendingDurableWritesForTesting();
    assert.equal(getPendingDurableWriteCount(), 0, "buffer must be empty after recovery drain");
    const wl = await db.execute(sql`SELECT entered FROM window_log WHERE ticker = ${ticker}`);
    assert.equal(wl.rows[0]?.["entered"], true, "buffered window_log write must be persisted");

    // Step 7: audit row for this outage must now read 'recovered' with a
    // later ended_at_ms — the DO UPDATE fix (DO NOTHING left it 'failed').
    const audit = await db.execute(sql`
      SELECT id, recovery_outcome, ended_at_ms, reconnect_attempts
      FROM infrastructure_incidents
      WHERE kind = 'database' AND started_at_ms >= ${testStartMs}
      ORDER BY started_at_ms DESC
    `);
    assert.equal(audit.rows.length, 1, "one incident row per outage — failed + recovered must not duplicate");
    assert.equal(audit.rows[0]!["recovery_outcome"], "recovered",
      "audit must be upserted to 'recovered' — ON CONFLICT DO NOTHING previously froze it at 'failed'");
    assert.ok(Number(audit.rows[0]!["reconnect_attempts"]) >= 3);

    // Cleanup: restore a healthy store for any subsequent suites; remove rows.
    _setPoolResetHookForTesting(null);
    await initTradeStore(db);
    await db.execute(sql`DELETE FROM window_log WHERE ticker = ${ticker}`);
    await db.execute(sql`
      DELETE FROM infrastructure_incidents WHERE kind = 'database' AND started_at_ms >= ${testStartMs}
    `);
  });
});
