/**
 * tradeStore.pruneIncidents.test.ts
 *
 * Integration tests for pruneCoverageIncidents().
 *
 * Coverage:
 *  1. Rows older than the retention window are deleted; recent rows survive
 *  2. Returns the exact count of pruned rows
 *  3. Returns 0 when no rows exceed the retention window (fresh rows only)
 *  4. Idempotent: a second call after the first returns 0
 *  5. Returns -1 (skipped) when storage is unavailable (degraded DB)
 *
 * Isolation and exact-count strategy:
 *  All tests run inside a db.transaction() that is always rolled back via a
 *  sentinel throw, so no rows are ever committed to the real database.
 *
 *  However, PostgreSQL READ COMMITTED isolation means existing *committed*
 *  coverage_incidents rows are still visible inside the transaction.
 *  pruneCoverageIncidents() performs an unscoped DELETE, so it will also remove
 *  any pre-existing expired rows (detected_at_ms < cutoff) that happen to exist.
 *  To keep exact-count assertions valid in any database state, each test that
 *  asserts a pruned count first measures the baseline expired-row count at that
 *  cutoff, then asserts pruned === baseline + fixture_expired_count.
 *
 *  DB-skip guard: the runner script exits 0 when DATABASE_URL is absent.
 */

import { describe, it, before, afterEach }          from "node:test";
import assert                                         from "node:assert/strict";
import { sql }                                        from "drizzle-orm";
import { db }                                         from "@workspace/db";
import {
  initTradeStore,
  pruneCoverageIncidents,
}                                                     from "./tradeStore.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Retention window used in all tests: 1 day. */
const RETENTION_DAYS = 1;
const RETENTION_MS   = RETENTION_DAYS * 86_400_000;

// ── Transaction-rollback harness ──────────────────────────────────────────────

/**
 * Sentinel thrown at the end of every test transaction to force a rollback.
 * Drizzle re-throws it from db.transaction(); we swallow it here.
 */
class RollbackSentinel extends Error {
  constructor() {
    super("__TEST_ROLLBACK__");
    Object.setPrototypeOf(this, RollbackSentinel.prototype);
  }
}

/**
 * Run `fn(tx)` inside a transaction that is ALWAYS rolled back.
 *
 * • fn receives the transaction handle; all fixture inserts and assertion
 *   queries must use this handle so they participate in the same transaction.
 * • initTradeStore(tx) is called first so _db points at the transaction
 *   handle, making pruneCoverageIncidents() operate within the transaction.
 * • Any error thrown by fn other than RollbackSentinel propagates out so
 *   failing assertions still surface normally.
 * • initTradeStore(db) is called after rollback to restore the real pool.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRolledBackTx(fn: (tx: any) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await initTradeStore(tx as any);
      await fn(tx);
      throw new RollbackSentinel(); // always rollback
    });
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) throw err;
  }
  await initTradeStore(db);
}

// ── In-transaction helpers ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertIncident(tx: any, id: string, detectedAtMs: number): Promise<void> {
  const easternDate = new Date(detectedAtMs).toISOString().slice(0, 10);
  await tx.execute(sql`
    INSERT INTO coverage_incidents (
      incident_id, ticker, series, close_time,
      detected_at_ms, seconds_left_at_detect,
      ws_connected, recovery_attempts, status,
      eastern_date
    ) VALUES (
      ${"test-ci-" + id},
      ${"TEST-CI-" + id},
      ${"KXBTC15M"},
      ${"2026-08-15T14:00:00Z"},
      ${detectedAtMs},
      ${45},
      ${false},
      ${"[]"},
      ${"unresolved"},
      ${easternDate}
    )
    ON CONFLICT (incident_id) DO NOTHING
  `);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rowExists(tx: any, idSuffix: string): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT 1 FROM coverage_incidents
        WHERE incident_id = ${"test-ci-" + idSuffix} LIMIT 1`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).rows?.length ?? 0) > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countTestRows(tx: any): Promise<number> {
  const result = await tx.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM coverage_incidents
        WHERE ticker LIKE 'TEST-CI-%'`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).rows?.[0]?.cnt ?? 0;
}

/**
 * Count existing committed rows that pruneCoverageIncidents(retentionDays) will
 * delete, EXCLUDING our own test-CI fixtures (which haven't been inserted yet
 * when this is called).  This is the baseline we must add to fixture-derived
 * expected counts so assertions remain valid in any database state.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function baselineExpiredCount(tx: any): Promise<number> {
  const cutoffMs = Date.now() - RETENTION_MS;
  const result   = await tx.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM coverage_incidents
        WHERE detected_at_ms < ${cutoffMs}
          AND ticker NOT LIKE 'TEST-CI-%'`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).rows?.[0]?.cnt ?? 0;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("pruneCoverageIncidents", async () => {
  before(async () => {
    // Establish a healthy connection and run schema migrations.
    await initTradeStore(db);
  });

  afterEach(async () => {
    // Unconditionally restore the real pool (guards the degraded-storage test).
    await initTradeStore(db);
  });

  // ── 1. Old rows deleted; recent rows survive ─────────────────────────────────
  it("1: rows older than retentionDays are deleted; recent rows survive", async () => {
    await withRolledBackTx(async (tx) => {
      const now         = Date.now();
      const twoAgo      = now - 2 * RETENTION_MS;
      const thirtyAgo   = now - 30 * RETENTION_MS;
      const halfHourAgo = now - 30 * 60_000;

      await insertIncident(tx, "old-2d",  twoAgo);
      await insertIncident(tx, "old-30d", thirtyAgo);
      await insertIncident(tx, "recent",  halfHourAgo);

      assert.equal(await countTestRows(tx), 3, "pre-condition: 3 test rows inserted");

      await pruneCoverageIncidents(RETENTION_DAYS);

      // Row-existence checks are scoped to individual incident IDs — unaffected
      // by any baseline expired rows from elsewhere in the database.
      assert.ok(!(await rowExists(tx, "old-2d")),  "2-day-old row must be deleted");
      assert.ok(!(await rowExists(tx, "old-30d")), "30-day-old row must be deleted");
      assert.ok(  await rowExists(tx, "recent"),   "recent row must survive");
      assert.equal(await countTestRows(tx), 1,     "exactly 1 test row should remain");
    });
  });

  // ── 2. Returns the exact count of pruned rows ────────────────────────────────
  //
  // Measure the baseline expired-row count from committed data before inserting
  // fixtures.  pruneCoverageIncidents() deletes all expired rows (not just
  // test-owned ones), so expected = baseline + 2 fixture old rows.
  it("2: returns the exact count of rows deleted", async () => {
    await withRolledBackTx(async (tx) => {
      // Snapshot existing expired rows BEFORE inserting any fixtures.
      const baseline = await baselineExpiredCount(tx);

      const now   = Date.now();
      const oldMs = now - 2 * RETENTION_MS;

      await insertIncident(tx, "cnt-a", oldMs);
      await insertIncident(tx, "cnt-b", oldMs);
      await insertIncident(tx, "cnt-c", now - 10_000); // recent — survives

      const pruned = await pruneCoverageIncidents(RETENTION_DAYS);

      assert.equal(pruned, baseline + 2,
        `expected baseline(${baseline}) + 2 fixture-old rows = ${baseline + 2}; got ${pruned}`);
      assert.ok(!(await rowExists(tx, "cnt-a")), "cnt-a must be deleted");
      assert.ok(!(await rowExists(tx, "cnt-b")), "cnt-b must be deleted");
      assert.ok(  await rowExists(tx, "cnt-c"),  "cnt-c must survive");
    });
  });

  // ── 3. Returns 0 (plus any baseline expired rows) when all fixtures are fresh ─
  //
  // We insert only fresh fixtures.  The prune must return exactly baseline (the
  // pre-existing expired rows it cleans up from committed data) and leave all
  // fresh fixtures intact.
  it("3: returns baseline count when all fixture rows are within the retention window", async () => {
    await withRolledBackTx(async (tx) => {
      const baseline = await baselineExpiredCount(tx);

      const now = Date.now();
      await insertIncident(tx, "fresh-a", now - 60_000);
      await insertIncident(tx, "fresh-b", now - 120_000);

      const pruned = await pruneCoverageIncidents(RETENTION_DAYS);

      assert.equal(pruned, baseline,
        `expected baseline(${baseline}) with no fixture-old rows; got ${pruned}`);
      assert.ok(await rowExists(tx, "fresh-a"), "fresh-a must survive");
      assert.ok(await rowExists(tx, "fresh-b"), "fresh-b must survive");
      assert.equal(await countTestRows(tx), 2,  "both fresh test rows should remain");
    });
  });

  // ── 4. Idempotent: second call returns 0 ────────────────────────────────────
  //
  // After the first prune deletes baseline + 1 old rows (including the baseline
  // committed rows), the second call finds nothing left to delete.
  it("4: idempotent — second call after first prune returns 0", async () => {
    await withRolledBackTx(async (tx) => {
      const baseline = await baselineExpiredCount(tx);

      const now   = Date.now();
      const oldMs = now - 2 * RETENTION_MS;

      await insertIncident(tx, "idem-old",    oldMs);
      await insertIncident(tx, "idem-recent", now - 10_000);

      const first  = await pruneCoverageIncidents(RETENTION_DAYS);
      const second = await pruneCoverageIncidents(RETENTION_DAYS);

      assert.equal(first, baseline + 1,
        `first call must prune baseline(${baseline}) + 1 fixture-old row; got ${first}`);
      assert.equal(second, 0, "second call must find nothing to prune");
      assert.ok(  await rowExists(tx, "idem-recent"), "recent row must survive both calls");
      assert.ok(!(await rowExists(tx, "idem-old")),   "old row must be gone after first call");
    });
  });

  // ── 5. Returns -1 when storage is unavailable ────────────────────────────────
  //
  // Does NOT use withRolledBackTx: replacing _db with a broken proxy is
  // incompatible with an active transaction.  afterEach restores the real pool.
  // Placed last so degraded state does not affect tests 1–4.
  it("5: returns -1 (skipped) when storage is degraded", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = new Proxy(db, {
      get(_target: typeof db, prop: string | symbol) {
        if (prop === "execute") {
          return () => Promise.reject(new Error("SIMULATED_OUTAGE"));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (db as any)[prop as string];
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await initTradeStore(broken as any);

    const result = await pruneCoverageIncidents(RETENTION_DAYS);
    assert.equal(result, -1, "must return -1 when storage is degraded");
    // afterEach restores initTradeStore(db).
  });
});
