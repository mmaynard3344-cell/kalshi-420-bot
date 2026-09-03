/**
 * tradeStore.evalBackfill.test.ts
 *
 * Integration tests for backfillEvaluationEventsFromFiles().
 *
 * Coverage:
 *  1. Empty NDJSON dir — records completion in server_metadata, inserts 0 rows
 *  2. Single-file import — events inserted with ev: content-hash IDs;
 *     event loader sees only real events, no spurious rows
 *  3. Multi-file import — events from three date files all inserted
 *  4. Idempotent on restart — server_metadata row present → second call no-op
 *  5. DB reset triggers re-import; ev: content-hash IDs prevent duplicates
 *  6. Unreadable directory — readdirSync propagates I/O error; completion NOT written
 *  7. Retention boundary stability — same ev: hash IDs after older events age out
 *  8. Mixed live/backfill recovery — ev: row already in SQL via live writer +
 *     same event in NDJSON + deleted server_metadata → exactly 1 row (no duplicate)
 *
 * Isolation:
 *  • EVAL_EVENTS_DATA_DIR redirects all NDJSON reads to a per-test tmpdir.
 *  • All test tickers use the prefix "TEST-BF-" so afterEach can safely delete
 *    only those rows from evaluation_events — real production data is untouched.
 *  • initTradeStore() called once in before() to set _db/_healthy and create schema.
 *  • Timestamps are within the 30-day retention window so events survive the prune.
 *  • Test 6 uses POSIX chmod(000) — works on Linux/macOS (not Windows).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert                                                   from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, chmodSync,
}                                                              from "node:fs";
import { join }                                                from "node:path";
import { tmpdir }                                              from "node:os";
import { createHash }                                          from "node:crypto";
import { sql }                                                 from "drizzle-orm";
import { db }                                                  from "@workspace/db";
import {
  initTradeStore,
  backfillEvaluationEventsFromFiles,
  loadRecentEvaluationEventsFromSql,
  recordEvaluationEventToSql,
} from "./tradeStore.js";
import type { EvaluationEvent } from "./evaluationEventStore.js";

// ── Constants (must match tradeStore.ts) ─────────────────────────────────────
const EVAL_BACKFILL_META_KEY = "eval_events_backfill_complete";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid EvaluationEvent object with a recent timestamp.
 * All test tickers are prefixed "TEST-BF-" for safe targeted cleanup.
 */
function makeEvent(suffix: string, msAgo = 60_000): EvaluationEvent {
  return {
    ticker:            `TEST-BF-${suffix}`,
    series:            "KXBTC15M",
    timestampMs:       Date.now() - msAgo,
    secondsLeft:       60,
    source:            "websocket",
    yesBid:            90, yesAsk: 91, noBid: 9, noAsk: 10,
    yesDerivedAsk:     91, noDerivedAsk: 10,
    side:              "yes",
    limitCents:        91,
    outcome:           "forwarded",
    preflightDecision: null,
  };
}

/** Serialize an event the same way the NDJSON writer does. */
function toNdjsonLine(event: EvaluationEvent): string {
  return JSON.stringify(event);
}

/** Derive the shared content-hash ID used by both the live writer and the backfill. */
function hashId(rawLine: string): string {
  return `ev:${createHash("sha256").update(rawLine).digest("hex").slice(0, 16)}`;
}

/** Delete all test-owned evaluation_events rows (ticker LIKE 'TEST-BF-%'). */
async function deleteTestRows(): Promise<void> {
  await db.execute(sql`DELETE FROM evaluation_events WHERE ticker LIKE 'TEST-BF-%'`);
}

/** Delete the backfill completion key from server_metadata. */
async function deleteMetaKey(): Promise<void> {
  await db.execute(
    sql`DELETE FROM server_metadata WHERE key = ${EVAL_BACKFILL_META_KEY}`,
  );
}

/** Count test-owned evaluation_events rows (ticker LIKE 'TEST-BF-%'). */
async function countTestRows(): Promise<number> {
  const result = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM evaluation_events WHERE ticker LIKE 'TEST-BF-%'`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).rows?.[0]?.cnt ?? 0;
}

/** Return true when the completion row exists in server_metadata. */
async function metaKeyExists(): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM server_metadata WHERE key = ${EVAL_BACKFILL_META_KEY} LIMIT 1`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).rows?.length ?? 0) > 0;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("backfillEvaluationEventsFromFiles", async () => {
  let tmpDir = "";
  const origDataDir = process.env["EVAL_EVENTS_DATA_DIR"];

  before(async () => {
    await initTradeStore();
    await deleteTestRows();
    await deleteMetaKey();
  });

  after(async () => {
    await deleteTestRows();
    await deleteMetaKey();
    if (origDataDir === undefined) {
      delete process.env["EVAL_EVENTS_DATA_DIR"];
    } else {
      process.env["EVAL_EVENTS_DATA_DIR"] = origDataDir;
    }
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eval-bf-"));
    process.env["EVAL_EVENTS_DATA_DIR"] = tmpDir;
  });

  afterEach(async () => {
    // Restore permissions before cleanup so rmSync can delete the dir.
    try { chmodSync(tmpDir, 0o755); } catch { /* ignore */ }
    await deleteTestRows();
    await deleteMetaKey();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Empty directory ──────────────────────────────────────────────────────
  it("1: empty NDJSON dir — records completion in server_metadata, inserts 0 data rows", async () => {
    await backfillEvaluationEventsFromFiles();

    assert.ok(await metaKeyExists(), "server_metadata completion key must be written");
    assert.equal(await countTestRows(), 0, "no test rows should exist for an empty directory");
  });

  // ── 2. Single-file import ───────────────────────────────────────────────────
  it("2: single-file import — events inserted with ev: content-hash IDs; event loader sees no spurious rows", async () => {
    const events = [
      makeEvent("A1", 3_600_000),
      makeEvent("A2", 3_000_000),
      makeEvent("A3", 2_400_000),
    ];
    const lines = events.map(toNdjsonLine);
    writeFileSync(
      join(tmpDir, "evaluation-events-2026-08-13.ndjson"),
      lines.join("\n") + "\n",
      "utf8",
    );

    await backfillEvaluationEventsFromFiles();

    assert.equal(await countTestRows(), 3, "all three events must be inserted");
    assert.ok(await metaKeyExists(), "server_metadata completion key must be written");

    // Verify each row uses the expected content-hash ID.
    for (const [i, raw] of lines.entries()) {
      const id = hashId(raw);
      const result = await db.execute(
        sql`SELECT 1 FROM evaluation_events WHERE id = ${id} LIMIT 1`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.ok(((result as any).rows?.length ?? 0) > 0, `row ${i + 1} must use ev: content-hash ID`);
    }

    // SQL event loader must not return spurious rows from the events table.
    const loaded = await loadRecentEvaluationEventsFromSql(24 * 60 * 60 * 1_000);
    const spurious = loaded.filter((e) => e.ticker === "__backfill_complete__");
    assert.equal(spurious.length, 0, "event loader must not return sentinel or metadata artifacts");
  });

  // ── 3. Multi-file import ────────────────────────────────────────────────────
  it("3: multi-file import — 6 events across three date files all inserted", async () => {
    const fixtures: Array<{ date: string; suffixes: string[] }> = [
      { date: "2026-08-11", suffixes: ["B1", "B2"] },
      { date: "2026-08-12", suffixes: ["B3", "B4", "B5"] },
      { date: "2026-08-13", suffixes: ["B6"] },
    ];
    let msAgo = 10_000_000;
    for (const { date, suffixes } of fixtures) {
      const lines = suffixes.map((s) => toNdjsonLine(makeEvent(s, msAgo -= 60_000)));
      writeFileSync(join(tmpDir, `evaluation-events-${date}.ndjson`), lines.join("\n") + "\n", "utf8");
    }

    await backfillEvaluationEventsFromFiles();

    assert.equal(await countTestRows(), 6, "all 6 events must be inserted");
    assert.ok(await metaKeyExists(), "server_metadata completion key must be written");
  });

  // ── 4. Idempotent via server_metadata ──────────────────────────────────────
  it("4: idempotent restart — server_metadata present → second call inserts nothing new", async () => {
    const event = makeEvent("C1", 120_000);
    const line  = toNdjsonLine(event);
    writeFileSync(join(tmpDir, "evaluation-events-2026-08-14.ndjson"), line + "\n", "utf8");

    await backfillEvaluationEventsFromFiles();
    assert.equal(await countTestRows(), 1, "first run must insert 1 row");
    assert.ok(await metaKeyExists(), "server_metadata key must exist");

    // Append a live event to NDJSON (simulating writer activity after completion).
    writeFileSync(
      join(tmpDir, "evaluation-events-2026-08-14.ndjson"),
      line + "\n" + toNdjsonLine(makeEvent("C2", 60_000)) + "\n",
      "utf8",
    );

    // Second run: server_metadata row found → skipped entirely.
    await backfillEvaluationEventsFromFiles();
    assert.equal(await countTestRows(), 1, "second run must not import the appended live event");
  });

  // ── 5. DB reset triggers re-import without duplicates ──────────────────────
  it("5: DB reset (no server_metadata) re-runs safely; ev: hash IDs prevent duplicates", async () => {
    const event = makeEvent("D1", 180_000);
    const line  = toNdjsonLine(event);
    writeFileSync(join(tmpDir, "evaluation-events-2026-08-14.ndjson"), line + "\n", "utf8");

    await backfillEvaluationEventsFromFiles();
    assert.equal(await countTestRows(), 1, "first run must insert 1 row");
    const expectedId = hashId(line);

    // Simulate a database restore: delete the completion record but keep data.
    await deleteMetaKey();
    assert.ok(!(await metaKeyExists()), "server_metadata key must be absent");

    // Retry: same line → same ev: hash → onConflictDoNothing skips the duplicate.
    await backfillEvaluationEventsFromFiles();
    assert.equal(await countTestRows(), 1, "retry must not create duplicate rows");
    assert.ok(await metaKeyExists(), "server_metadata key rewritten after successful retry");

    // Confirm exactly one row for the expected content-hash ID.
    const result = await db.execute(
      sql`SELECT COUNT(*)::int AS cnt FROM evaluation_events WHERE id = ${expectedId}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((result as any).rows?.[0]?.cnt, 1, "exactly one row for the ev: content-hash ID");
  });

  // ── 6. Unreadable directory — I/O error aborts without writing completion ───
  it("6: unreadable directory — readdirSync propagates I/O error; completion NOT written", async () => {
    writeFileSync(
      join(tmpDir, "evaluation-events-2026-08-13.ndjson"),
      toNdjsonLine(makeEvent("E1", 3_600_000)) + "\n",
      "utf8",
    );
    // Make the directory unreadable so readdirSync throws EACCES.
    chmodSync(tmpDir, 0o000);

    try {
      await backfillEvaluationEventsFromFiles();
    } catch {
      // fs error propagated out of the function — also acceptable.
    } finally {
      chmodSync(tmpDir, 0o755); // restore for afterEach cleanup
    }

    assert.ok(!(await metaKeyExists()), "completion must NOT be recorded when the directory scan fails");
    assert.equal(await countTestRows(), 0, "no test rows must be inserted when the scan fails");
  });

  // ── 7. Retention boundary stability — content-hash IDs don't shift ─────────
  it("7: retained events keep same ev: hash IDs across retry after older events age out", async () => {
    const recentEvent = makeEvent("F1",  1_800_000);         // 30 min ago — retained
    const oldEvent    = makeEvent("F2", 35 * 86_400_000);    // ~35 days ago — outside window

    const recentLine = toNdjsonLine(recentEvent);
    const oldLine    = toNdjsonLine(oldEvent);
    writeFileSync(
      join(tmpDir, "evaluation-events-2026-08-14.ndjson"),
      recentLine + "\n" + oldLine + "\n",
      "utf8",
    );

    // First run: only the recent event is within the retention window.
    await backfillEvaluationEventsFromFiles();
    assert.equal(await countTestRows(), 1, "only the recent event should be inserted");
    const expectedId = hashId(recentLine);
    const r1 = await db.execute(
      sql`SELECT 1 FROM evaluation_events WHERE id = ${expectedId} LIMIT 1`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.ok(((r1 as any).rows?.length ?? 0) > 0, "retained event must use ev: content-hash ID");

    // Simulate DB reset then retry — same line → same hash.
    await deleteMetaKey();
    await backfillEvaluationEventsFromFiles();
    assert.equal(await countTestRows(), 1, "retry must not produce a second row");
    const r2 = await db.execute(
      sql`SELECT 1 FROM evaluation_events WHERE id = ${expectedId} LIMIT 1`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.ok(((r2 as any).rows?.length ?? 0) > 0, "ev: content-hash ID must be stable across retries");
  });

  // ── 8. Mixed live/backfill recovery — shared ev: identity prevents duplicates
  it("8: live ev: row + same event in NDJSON + deleted server_metadata → exactly 1 row", async () => {
    // Build the event and its canonical NDJSON line.
    const event   = makeEvent("G1", 240_000);
    const rawLine = toNdjsonLine(event);
    const id      = hashId(rawLine);

    // Write the event to NDJSON (as the live evaluationEventStore would).
    writeFileSync(
      join(tmpDir, "evaluation-events-2026-08-14.ndjson"),
      rawLine + "\n",
      "utf8",
    );

    // Simulate the live SQL writer inserting the same event via recordEvaluationEventToSql.
    // The live writer uses JSON.stringify(event) → same hash → same ev: ID.
    recordEvaluationEventToSql(event);
    // Give the durable-write buffer time to flush (it fires setImmediate-style).
    await new Promise((r) => setTimeout(r, 300));

    // Verify the live row is present with the expected ID.
    const liveResult = await db.execute(
      sql`SELECT id FROM evaluation_events WHERE id = ${id} LIMIT 1`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.ok(((liveResult as any).rows?.length ?? 0) > 0, "live row must exist before backfill");

    // Delete server_metadata to simulate a DB restore that lost the completion record.
    await deleteMetaKey();

    // Run the backfill: should find the ev: row, skip it via onConflictDoNothing,
    // insert 0 new rows, and still commit the completion record.
    await backfillEvaluationEventsFromFiles();

    // Exactly 1 row for this event — no duplicate.
    assert.equal(await countTestRows(), 1, "must not create a duplicate row alongside the live ev: row");
    assert.ok(await metaKeyExists(), "server_metadata completion key must be written after successful backfill");

    // Confirm the single row is the expected hash ID.
    const finalResult = await db.execute(
      sql`SELECT COUNT(*)::int AS cnt FROM evaluation_events WHERE id = ${id}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((finalResult as any).rows?.[0]?.cnt, 1, "exactly one row with the shared ev: content-hash ID");
  });
});
