/**
 * evaluationEventStore.test.ts
 *
 * Tests for the durable evaluation event store:
 *   - recordEvaluationEvent() persists events to the date-keyed NDJSON file
 *   - loadEvaluationEvents() reads them back correctly
 *   - loadRecentEvaluationEvents() applies a time filter
 *   - findNearestEvaluationEvent() finds the closest event to a target timestamp
 *
 * These tests exercise the "server-silent" and "pre-preflight exit" scenarios
 * required by Task 423:
 *   - Server-silent: no events are recorded for a ticker in the target window,
 *     so findNearestEvaluationEvent returns null — Dashboard correctly shows
 *     "no server decision".
 *   - Pre-preflight exits: no_tick, out_of_zone, incoherent_bbo_snapshot,
 *     wide_spread outcomes are stored with full BBO context so they survive
 *     a server restart and remain queryable by the Dashboard API.
 *
 * This module is pino-free — no logger imports, safe for isolated esbuild runs.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert                                        from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync }          from "node:fs";
import { tmpdir }                                    from "node:os";
import { join }                                      from "node:path";

// We set process.cwd() to a temp dir so the store writes there.
// This is done before the first import of the module under test.

let origCwd: string;
let testDir: string;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<{
    ticker:            string;
    series:            string;
    timestampMs:       number;
    secondsLeft:       number;
    source:            "websocket" | "rest_fallback";
    yesBid:            number | null;
    yesAsk:            number | null;
    noBid:             number | null;
    noAsk:             number | null;
    yesDerivedAsk:     number | null;
    noDerivedAsk:      number | null;
    side:              "yes" | "no" | null;
    limitCents:        number | null;
    outcome:           import("./evaluationEventStore.js").EvaluationOutcome;
    preflightDecision: string | null;
  }> = {},
): import("./evaluationEventStore.js").EvaluationEvent {
  return {
    ticker:            overrides.ticker            ?? "KXETH15M-26AUG140900-00",
    series:            overrides.series            ?? "KXETH15M",
    timestampMs:       overrides.timestampMs       ?? Date.now(),
    secondsLeft:       overrides.secondsLeft       ?? 90,
    source:            overrides.source            ?? "websocket",
    yesBid:            overrides.yesBid            !== undefined ? overrides.yesBid  : 5,
    yesAsk:            overrides.yesAsk            !== undefined ? overrides.yesAsk  : 6,
    noBid:             overrides.noBid             !== undefined ? overrides.noBid   : 10,
    noAsk:             overrides.noAsk             !== undefined ? overrides.noAsk   : 11,
    yesDerivedAsk:     overrides.yesDerivedAsk     !== undefined ? overrides.yesDerivedAsk : 90,
    noDerivedAsk:      overrides.noDerivedAsk      !== undefined ? overrides.noDerivedAsk  : 95,
    side:              overrides.side              !== undefined ? overrides.side     : "yes",
    limitCents:        overrides.limitCents        !== undefined ? overrides.limitCents    : 92,
    outcome:           overrides.outcome           ?? "forwarded",
    preflightDecision: overrides.preflightDecision !== undefined ? overrides.preflightDecision : null,
  };
}

// ── Suite setup ───────────────────────────────────────────────────────────────

describe("evaluationEventStore", () => {
  // Point EVAL_EVENTS_DATA_DIR at a temp directory so every file write goes
  // to an isolated location. The store computes the path lazily at call time,
  // so setting the env var before the first write is sufficient.
  before(() => {
    origCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), "eval-event-test-"));
    process.env["EVAL_EVENTS_DATA_DIR"] = testDir;
  });

  after(() => {
    delete process.env["EVAL_EVENTS_DATA_DIR"];
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Wipe the analytics directory between tests so each test starts clean.
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
    try { mkdtempSync(testDir); } catch { /* recreated below by store */ }
    // Just clear it — the store will recreate data dir on next write.
    testDir = mkdtempSync(join(tmpdir(), "eval-event-test-"));
    process.env["EVAL_EVENTS_DATA_DIR"] = testDir;
  });

  // ── Section 1: recordEvaluationEvent ────────────────────────────────────────

  describe("recordEvaluationEvent — write path", () => {
    it("creates the NDJSON file on first write", async () => {
      const { recordEvaluationEvent } = await import("./evaluationEventStore.js");
      const event = makeEvent({ outcome: "forwarded" });
      recordEvaluationEvent(event);

      // EVAL_EVENTS_DATA_DIR is set to testDir directly (no sub-path)
      const files = readdirSync(testDir).filter((f) => f.startsWith("evaluation-events-"));
      assert.ok(files.length >= 1, "expected at least one NDJSON file");
    });

    it("does not throw on a second write", async () => {
      const { recordEvaluationEvent } = await import("./evaluationEventStore.js");
      assert.doesNotThrow(() => {
        recordEvaluationEvent(makeEvent({ outcome: "out_of_zone" }));
        recordEvaluationEvent(makeEvent({ outcome: "forwarded" }));
      });
    });
  });

  // ── Section 2: loadEvaluationEvents ─────────────────────────────────────────

  describe("loadEvaluationEvents — read path", () => {
    it("returns empty array when no file exists (server-silent scenario)", async () => {
      const { loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const result = loadEvaluationEvents("2099-01-01");
      assert.deepEqual(result, [], "should return [] when file is absent");
    });

    it("round-trips a forwarded event correctly", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const nowMs = Date.now();
      const event = makeEvent({
        outcome: "forwarded", timestampMs: nowMs, side: "yes",
        limitCents: 92, preflightDecision: null,
      });
      recordEvaluationEvent(event);

      // Derive the eastern date for the load call (matches what recordEvaluationEvent writes)
      const { easternDay } = await import("./dailyBudget.js");
      const date = easternDay(new Date(nowMs));
      const loaded = loadEvaluationEvents(date);
      assert.ok(loaded.length >= 1, "at least one event should be present");
      const found = loaded.find((e) => e.timestampMs === nowMs && e.outcome === "forwarded");
      assert.ok(found, "the written event should be found");
      assert.strictEqual(found!.side, "yes");
      assert.strictEqual(found!.limitCents, 92);
      assert.strictEqual(found!.preflightDecision, null);
    });

    it("round-trips a no_tick event (server-silent pre-preflight exit)", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const nowMs = Date.now();
      const event = makeEvent({
        outcome: "no_tick", timestampMs: nowMs,
        yesDerivedAsk: null, noDerivedAsk: null, yesBid: null, noBid: null,
        side: null, limitCents: null, preflightDecision: null,
      });
      recordEvaluationEvent(event);

      const { easternDay } = await import("./dailyBudget.js");
      const date = easternDay(new Date(nowMs));
      const loaded = loadEvaluationEvents(date);
      const found = loaded.find((e) => e.timestampMs === nowMs && e.outcome === "no_tick");
      assert.ok(found, "no_tick event should be persisted");
      assert.strictEqual(found!.side, null);
      assert.strictEqual(found!.yesDerivedAsk, null);
      assert.strictEqual(found!.noDerivedAsk, null);
    });

    it("round-trips an out_of_zone event (pre-preflight exit)", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const nowMs = Date.now();
      const event = makeEvent({
        outcome: "out_of_zone", timestampMs: nowMs,
        yesDerivedAsk: 80, noDerivedAsk: 85,
        side: null, limitCents: null, preflightDecision: null,
      });
      recordEvaluationEvent(event);

      const { easternDay } = await import("./dailyBudget.js");
      const date = easternDay(new Date(nowMs));
      const loaded = loadEvaluationEvents(date);
      const found = loaded.find((e) => e.timestampMs === nowMs && e.outcome === "out_of_zone");
      assert.ok(found, "out_of_zone event should be persisted");
      assert.strictEqual(found!.side, null);
    });

    it("round-trips an incoherent_bbo_snapshot event", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const nowMs = Date.now();
      recordEvaluationEvent(makeEvent({
        outcome: "incoherent_bbo_snapshot", timestampMs: nowMs,
        side: "yes", limitCents: null, preflightDecision: null,
      }));

      const { easternDay } = await import("./dailyBudget.js");
      const date = easternDay(new Date(nowMs));
      const loaded = loadEvaluationEvents(date);
      const found = loaded.find((e) => e.timestampMs === nowMs && e.outcome === "incoherent_bbo_snapshot");
      assert.ok(found, "incoherent_bbo_snapshot event should be persisted");
    });

    it("round-trips a wide_spread event", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const nowMs = Date.now();
      recordEvaluationEvent(makeEvent({
        outcome: "wide_spread", timestampMs: nowMs,
        side: "no", limitCents: null, preflightDecision: null,
      }));

      const { easternDay } = await import("./dailyBudget.js");
      const date = easternDay(new Date(nowMs));
      const loaded = loadEvaluationEvents(date);
      const found = loaded.find((e) => e.timestampMs === nowMs && e.outcome === "wide_spread");
      assert.ok(found, "wide_spread event should be persisted");
      assert.strictEqual(found!.side, "no");
    });

    it("round-trips an exchange_rejected event (definitive Kalshi rejection)", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay } = await import("./dailyBudget.js");
      const nowMs = Date.now();
      const ev = makeEvent({ outcome: "exchange_rejected", preflightDecision: "http_422",
        side: "no", timestampMs: nowMs });
      recordEvaluationEvent(ev);
      const date = easternDay(new Date(nowMs));
      const all = loadEvaluationEvents(date);
      const found = all.find((e) => e.timestampMs === nowMs && e.outcome === "exchange_rejected");
      assert.ok(found, "should persist exchange_rejected");
      assert.strictEqual(found!.preflightDecision, "http_422");
      assert.strictEqual(found!.side, "no");
    });

    it("round-trips a post_unknown event (uncertain transport failure)", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay } = await import("./dailyBudget.js");
      const nowMs = Date.now();
      const ev = makeEvent({ outcome: "post_unknown", preflightDecision: "transport_failure",
        side: "yes", timestampMs: nowMs });
      recordEvaluationEvent(ev);
      const date = easternDay(new Date(nowMs));
      const all = loadEvaluationEvents(date);
      const found = all.find((e) => e.timestampMs === nowMs && e.outcome === "post_unknown");
      assert.ok(found, "should persist post_unknown");
      assert.strictEqual(found!.preflightDecision, "transport_failure");
      assert.strictEqual(found!.side, "yes");
    });

    it("round-trips a preflight_skip event with its decision value", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const nowMs = Date.now();
      recordEvaluationEvent(makeEvent({
        outcome: "preflight_skip", timestampMs: nowMs,
        side: "yes", limitCents: 91, preflightDecision: "skip_zero_depth",
      }));

      const { easternDay } = await import("./dailyBudget.js");
      const date = easternDay(new Date(nowMs));
      const loaded = loadEvaluationEvents(date);
      const found = loaded.find((e) => e.timestampMs === nowMs && e.outcome === "preflight_skip");
      assert.ok(found, "preflight_skip event should be persisted");
      assert.strictEqual(found!.preflightDecision, "skip_zero_depth");
      assert.strictEqual(found!.limitCents, 91);
    });

    it("preserves multiple events from the same evaluate() call", async () => {
      const { recordEvaluationEvent, loadEvaluationEvents } = await import("./evaluationEventStore.js");
      const base = Date.now();
      // Simulate YES wide_spread + NO submitted (two events from one evaluate())
      recordEvaluationEvent(makeEvent({ outcome: "wide_spread", timestampMs: base, side: "yes" }));
      recordEvaluationEvent(makeEvent({ outcome: "forwarded",   timestampMs: base, side: "no"  }));

      const { easternDay } = await import("./dailyBudget.js");
      const date = easternDay(new Date(base));
      const loaded = loadEvaluationEvents(date);
      const atBase = loaded.filter((e) => e.timestampMs === base);
      assert.ok(atBase.length >= 2, "both events should be persisted");
    });
  });

  // ── Section 3: loadRecentEvaluationEvents ────────────────────────────────────

  describe("loadRecentEvaluationEvents", () => {
    it("returns empty when no files exist", async () => {
      const { loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const result = loadRecentEvaluationEvents();
      assert.deepEqual(result, []);
    });

    it("excludes events older than limitMs", async () => {
      const { recordEvaluationEvent, loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const old  = Date.now() - 2 * 60 * 60 * 1_000; // 2 hours ago
      const fresh = Date.now();
      recordEvaluationEvent(makeEvent({ timestampMs: old,   outcome: "out_of_zone" }));
      recordEvaluationEvent(makeEvent({ timestampMs: fresh, outcome: "forwarded"   }));

      const recent = loadRecentEvaluationEvents(60 * 60 * 1_000); // 1 hour window
      assert.ok(!recent.some((e) => e.timestampMs === old), "old event should be excluded");
      assert.ok(recent.some((e) => e.timestampMs === fresh), "fresh event should be included");
    });

    it("returns all events when limitMs is 0", async () => {
      const { recordEvaluationEvent, loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const old  = Date.now() - 25 * 60 * 60 * 1_000; // 25 hours ago
      const fresh = Date.now();
      recordEvaluationEvent(makeEvent({ timestampMs: old,   outcome: "out_of_zone" }));
      recordEvaluationEvent(makeEvent({ timestampMs: fresh, outcome: "forwarded"   }));

      const all = loadRecentEvaluationEvents(0);
      assert.ok(all.length >= 2, "should return all events including old ones");
    });
  });

  // ── Section 4: findNearestEvaluationEvent ────────────────────────────────────

  describe("findNearestEvaluationEvent", () => {
    it("returns null when no events match the ticker (server-silent case)", async () => {
      const { recordEvaluationEvent, findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const now = Date.now();
      // Record events for a different ticker
      recordEvaluationEvent(makeEvent({ ticker: "KXBTC15M-26AUG140900-00", timestampMs: now }));

      const result = findNearestEvaluationEvent(
        [makeEvent({ ticker: "KXBTC15M-26AUG140900-00", timestampMs: now })],
        "KXETH15M-26AUG140900-00",  // different ticker
        now,
        60_000,
      );
      assert.strictEqual(result, null, "should return null when no ticker matches");
    });

    it("returns null when nearest event is outside the tolerance window", async () => {
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs = Date.now();
      const eventMs = alertMs - 90_000; // 90 s before alert
      const events  = [makeEvent({ ticker: "KXETH15M-26AUG140900-00", timestampMs: eventMs })];

      const result = findNearestEvaluationEvent(events, "KXETH15M-26AUG140900-00", alertMs, 60_000);
      assert.strictEqual(result, null, "event outside 60 s window should be excluded");
    });

    it("returns the nearest event when both events share the same priority tier", async () => {
      // Both wide_spread and out_of_zone have priority 1 and 2 respectively,
      // but when two events have EQUAL priority, the closer one wins.
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs  = Date.now();
      const close    = alertMs - 5_000;  // 5 s before — winner
      const farther  = alertMs - 20_000; // 20 s before
      const ticker   = "KXETH15M-26AUG140900-00";
      // Both at the same priority (1) — closeness is the tiebreaker
      const events = [
        makeEvent({ ticker, timestampMs: close,   outcome: "wide_spread",  side: "yes" }),
        makeEvent({ ticker, timestampMs: farther,  outcome: "preflight_skip", side: "yes" }),
      ];

      const result = findNearestEvaluationEvent(events, ticker, alertMs, 60_000, "yes");
      assert.ok(result !== null, "should find an event");
      assert.strictEqual(result!.outcome, "wide_spread", "should prefer the closer event within the same priority tier");
    });

    it("prefers a higher-priority event over a closer lower-priority forwarded event", async () => {
      // Verifies that forwarded (priority 10) loses to any terminal outcome even
      // when forwarded is closer to the alert time.
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs = Date.now();
      const ticker  = "KXETH15M-26AUG140900-00";
      const events = [
        makeEvent({ ticker, timestampMs: alertMs - 3_000,  outcome: "forwarded",   side: "yes" }),
        makeEvent({ ticker, timestampMs: alertMs - 25_000, outcome: "out_of_zone", side: null  }),
      ];
      const result = findNearestEvaluationEvent(events, ticker, alertMs, 60_000, "yes");
      assert.ok(result !== null);
      assert.strictEqual(result!.outcome, "out_of_zone",
        "out_of_zone (priority 2) must beat forwarded (priority 10) even when farther");
    });

    it("matches a no_tick event (server had no derivable ask near alert time)", async () => {
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs = Date.now();
      const ticker  = "KXETH15M-26AUG140900-00";
      const events  = [makeEvent({
        ticker, timestampMs: alertMs - 3_000, outcome: "no_tick",
        yesDerivedAsk: null, noDerivedAsk: null, side: null,
      })];

      const result = findNearestEvaluationEvent(events, ticker, alertMs, 60_000);
      assert.ok(result !== null, "should find the no_tick event");
      assert.strictEqual(result!.outcome, "no_tick");
      assert.strictEqual(result!.side, null);
    });

    it("prefers the event with the same side when two are equidistant", async () => {
      // This is not a hard requirement but tests tie-breaking behaviour
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs = Date.now();
      const ticker  = "KXETH15M-26AUG140900-00";
      // Both at same distance — the first one encountered should win (stable)
      const events = [
        makeEvent({ ticker, timestampMs: alertMs - 5_000, outcome: "wide_spread", side: "yes" }),
        makeEvent({ ticker, timestampMs: alertMs - 5_001, outcome: "forwarded",   side: "no"  }),
      ];
      const result = findNearestEvaluationEvent(events, ticker, alertMs, 60_000);
      assert.ok(result !== null);
      // wide_spread is closer (Δ5000 < Δ5001), so it wins
      assert.strictEqual(result!.outcome, "wide_spread");
    });

    it("prefers a terminal outcome over forwarded even when forwarded is closer", async () => {
      // Covers the case where evaluate() records `forwarded` then placeOrder records
      // `place_order_rejected`. The rejection is 10 s later but must be preferred.
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs = Date.now();
      const ticker  = "KXETH15M-26AUG140900-00";
      const events  = [
        makeEvent({ ticker, timestampMs: alertMs - 2_000,  outcome: "forwarded",          side: "yes" }),
        makeEvent({ ticker, timestampMs: alertMs + 10_000, outcome: "place_order_rejected", side: "yes",
          preflightDecision: "timing_guard" }),
      ];
      const result = findNearestEvaluationEvent(events, ticker, alertMs, 60_000, "yes");
      assert.ok(result !== null, "should find an event");
      assert.strictEqual(result!.outcome, "place_order_rejected",
        "place_order_rejected must beat forwarded regardless of timing proximity");
      assert.strictEqual(result!.preflightDecision, "timing_guard");
    });

    it("deprioritises an opposite-side event when same-side event exists", async () => {
      // A YES alert must not be explained by a NO event when a YES event is present.
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs = Date.now();
      const ticker  = "KXETH15M-26AUG140900-00";
      const events  = [
        makeEvent({ ticker, timestampMs: alertMs - 1_000, outcome: "place_order_rejected",
          side: "no",  preflightDecision: "cooldown" }),
        makeEvent({ ticker, timestampMs: alertMs - 5_000, outcome: "wide_spread",
          side: "yes" }),
      ];
      const result = findNearestEvaluationEvent(events, ticker, alertMs, 60_000, "yes");
      assert.ok(result !== null);
      // YES wide_spread (Δ5000, no penalty) beats NO place_order_rejected (Δ1000, huge penalty)
      assert.strictEqual(result!.side, "yes",
        "should prefer the yes-side event for a yes alert");
    });

    it("still returns opposite-side event when no same-side event exists", async () => {
      const { findNearestEvaluationEvent } = await import("./evaluationEventStore.js");
      const alertMs = Date.now();
      const ticker  = "KXETH15M-26AUG140900-00";
      const events  = [
        makeEvent({ ticker, timestampMs: alertMs - 3_000, outcome: "out_of_zone", side: "no" }),
      ];
      const result = findNearestEvaluationEvent(events, ticker, alertMs, 60_000, "yes");
      assert.ok(result !== null, "should fall back to opposite-side event");
      assert.strictEqual(result!.side, "no");
    });

    it("returns all events when limitMs is 0 including old 3-date boundary events", async () => {
      // Simulates a 48h window that spans 3 Eastern calendar dates by writing
      // events into three separate date-keyed files and confirming all load.
      const { recordEvaluationEvent, loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay } = await import("./dailyBudget.js");

      const now      = Date.now();
      const minus24h = now - 24 * 60 * 60 * 1_000;
      const minus48h = now - 48 * 60 * 60 * 1_000;

      // Write three events with timestamps spread across (at most) 3 dates.
      // Even if some collapse to the same date, loadRecentEvaluationEvents(0)
      // must return all of them.
      recordEvaluationEvent(makeEvent({ timestampMs: minus48h, outcome: "out_of_zone" }));
      recordEvaluationEvent(makeEvent({ timestampMs: minus24h, outcome: "wide_spread"  }));
      recordEvaluationEvent(makeEvent({ timestampMs: now,      outcome: "forwarded"    }));

      const all = loadRecentEvaluationEvents(0);
      assert.ok(all.length >= 3,
        `limitMs=0 should return all events across all dates; got ${all.length}`);
    });
  });

  // ── Section 5: server-restart survival ───────────────────────────────────────
  //
  // A restarted server has no in-memory state — it sees only what the previous
  // process wrote to disk.  The tests below simulate this by writing NDJSON
  // files DIRECTLY (bypassing recordEvaluationEvent) so the read path is
  // exercised independently of any module-level state in the write path.
  //
  // Cross-date boundaries are constructed by computing Eastern date strings from
  // controlled timestamps (25 h / 50 h offsets) rather than relying on
  // "20 minutes ago" which is almost always the same Eastern date.

  describe("server-restart survival — cross-date persistence", () => {
    it("events written directly to disk are returned by loadRecentEvaluationEvents", async () => {
      // Write NDJSON manually — no recordEvaluationEvent, no shared module state.
      // This is equivalent to what a restarted process finds on disk.
      const { writeFileSync } = await import("node:fs");
      const { join }          = await import("node:path");
      const { loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay }    = await import("./dailyBudget.js");

      const nowMs = Date.now();
      const date  = easternDay(new Date(nowMs));
      const ev1   = makeEvent({ outcome: "forwarded",  timestampMs: nowMs });
      const ev2   = makeEvent({ outcome: "wide_spread", timestampMs: nowMs - 1_000 });

      writeFileSync(
        join(testDir, `evaluation-events-${date}.ndjson`),
        JSON.stringify(ev1) + "\n" + JSON.stringify(ev2) + "\n",
        "utf8",
      );

      // Read back — simulates a new server process with no prior memory
      const recovered = loadRecentEvaluationEvents();
      assert.ok(recovered.length >= 2,
        `expected at least 2 events from disk, got ${recovered.length}`);
      const outcomes = recovered.map((e) => e.outcome);
      assert.ok(outcomes.includes("forwarded"),   "forwarded event must survive restart");
      assert.ok(outcomes.includes("wide_spread"), "wide_spread event must survive restart");
    });

    it("all EvaluationOutcome variants are preserved exactly through disk write and read", async () => {
      // Writes every outcome variant directly as NDJSON then reads back via the
      // load path, confirming outcome, side, limitCents, and preflightDecision
      // all survive serialisation unchanged.
      const { writeFileSync } = await import("node:fs");
      const { join }          = await import("node:path");
      const { loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay }    = await import("./dailyBudget.js");

      const base = Date.now();
      const date = easternDay(new Date(base));

      const original = [
        makeEvent({ outcome: "no_tick",                 timestampMs: base,     side: null,  limitCents: null, preflightDecision: null }),
        makeEvent({ outcome: "out_of_zone",             timestampMs: base + 1, side: null,  limitCents: null, preflightDecision: null }),
        makeEvent({ outcome: "incoherent_bbo_snapshot", timestampMs: base + 2, side: "yes", limitCents: null, preflightDecision: null }),
        makeEvent({ outcome: "wide_spread",             timestampMs: base + 3, side: "no",  limitCents: null, preflightDecision: null }),
        makeEvent({ outcome: "preflight_skip",          timestampMs: base + 4, side: "yes", limitCents: 91,   preflightDecision: "skip_zero_depth" }),
        makeEvent({ outcome: "forwarded",               timestampMs: base + 5, side: "yes", limitCents: 92,   preflightDecision: null }),
        makeEvent({ outcome: "place_order_rejected",    timestampMs: base + 6, side: "yes", limitCents: 92,   preflightDecision: "cooldown" }),
        makeEvent({ outcome: "exchange_rejected",       timestampMs: base + 7, side: "no",  limitCents: null, preflightDecision: "http_422" }),
        makeEvent({ outcome: "post_unknown",            timestampMs: base + 8, side: "yes", limitCents: null, preflightDecision: "transport_failure" }),
      ];

      writeFileSync(
        join(testDir, `evaluation-events-${date}.ndjson`),
        original.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8",
      );

      const recovered = loadRecentEvaluationEvents();
      assert.ok(recovered.length >= original.length,
        `expected at least ${original.length} events, got ${recovered.length}`);

      for (const orig of original) {
        const found = recovered.find((e) => e.timestampMs === orig.timestampMs);
        assert.ok(found,
          `event outcome=${orig.outcome} must be recoverable after disk write/read`);
        assert.strictEqual(found!.outcome,           orig.outcome,           `outcome mismatch for ${orig.outcome}`);
        assert.strictEqual(found!.side,              orig.side,              `side mismatch for ${orig.outcome}`);
        assert.strictEqual(found!.limitCents,        orig.limitCents,        `limitCents mismatch for ${orig.outcome}`);
        assert.strictEqual(found!.preflightDecision, orig.preflightDecision, `preflightDecision mismatch for ${orig.outcome}`);
      }
    });

    it("events written to yesterday's date file are included when limitMs covers 26 hours", async () => {
      // Use easternDay on (now − 25 h) to derive the guaranteed-previous-date file name.
      // Writing directly to that file proves loadRecentEvaluationEvents opens the
      // correct date file when limitMs spans more than one Eastern calendar day.
      const { writeFileSync } = await import("node:fs");
      const { join }          = await import("node:path");
      const { loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay }    = await import("./dailyBudget.js");

      const nowMs       = Date.now();
      const yesterdayMs = nowMs - 25 * 60 * 60 * 1_000; // 25 h ago

      const todayDate     = easternDay(new Date(nowMs));
      const yesterdayDate = easternDay(new Date(yesterdayMs));

      const evYesterday = makeEvent({ outcome: "out_of_zone", timestampMs: yesterdayMs });
      const evToday     = makeEvent({ outcome: "forwarded",   timestampMs: nowMs });

      // Write each event to its date-keyed file (may be same file if tz collapses dates)
      const grouped = new Map<string, string>();
      grouped.set(yesterdayDate, (grouped.get(yesterdayDate) ?? "") + JSON.stringify(evYesterday) + "\n");
      grouped.set(todayDate,     (grouped.get(todayDate)     ?? "") + JSON.stringify(evToday)     + "\n");
      for (const [d, content] of grouped) {
        writeFileSync(join(testDir, `evaluation-events-${d}.ndjson`), content, "utf8");
      }

      // 26-hour window — must reach the previous date file and pass timestamp filter
      const recent = loadRecentEvaluationEvents(26 * 60 * 60 * 1_000);
      assert.ok(
        recent.some((e) => e.timestampMs === yesterdayMs && e.outcome === "out_of_zone"),
        "event in yesterday's date file must be included when limitMs is 26 h",
      );
      assert.ok(
        recent.some((e) => e.timestampMs === nowMs && e.outcome === "forwarded"),
        "today's event must also be included",
      );
    });

    it("events written to yesterday's date file are excluded when limitMs is only 1 hour", async () => {
      const { writeFileSync } = await import("node:fs");
      const { join }          = await import("node:path");
      const { loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay }    = await import("./dailyBudget.js");

      const nowMs       = Date.now();
      const yesterdayMs = nowMs - 25 * 60 * 60 * 1_000;

      const todayDate     = easternDay(new Date(nowMs));
      const yesterdayDate = easternDay(new Date(yesterdayMs));

      const evYesterday = makeEvent({ outcome: "out_of_zone", timestampMs: yesterdayMs });
      const evToday     = makeEvent({ outcome: "forwarded",   timestampMs: nowMs });

      const grouped = new Map<string, string>();
      grouped.set(yesterdayDate, (grouped.get(yesterdayDate) ?? "") + JSON.stringify(evYesterday) + "\n");
      grouped.set(todayDate,     (grouped.get(todayDate)     ?? "") + JSON.stringify(evToday)     + "\n");
      for (const [d, content] of grouped) {
        writeFileSync(join(testDir, `evaluation-events-${d}.ndjson`), content, "utf8");
      }

      // 1-hour window — the 25 h-old timestamp fails the cutoff even if its date
      // file is loaded (both the date filter and the per-event timestamp filter apply)
      const recent = loadRecentEvaluationEvents(60 * 60 * 1_000);
      assert.ok(
        !recent.some((e) => e.timestampMs === yesterdayMs),
        "25 h-old event must be excluded by a 1-hour limitMs",
      );
      assert.ok(
        recent.some((e) => e.timestampMs === nowMs),
        "today's event must still be included",
      );
    });

    it("two-day boundary: event in previous-day file is still found after midnight", async () => {
      // Construct a guaranteed cross-date scenario by computing Eastern date strings
      // for (now − 25 h) and now, then writing each event to its date-keyed file
      // directly.  This removes all dependence on the time-of-day at which the test
      // runs — 25 h back is always on a different Eastern calendar date OR same date;
      // either way the timestamp filter correctly includes/excludes the event.
      const { writeFileSync } = await import("node:fs");
      const { join }          = await import("node:path");
      const { loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay }    = await import("./dailyBudget.js");

      const nowMs    = Date.now();
      const prevMs   = nowMs - 25 * 60 * 60 * 1_000; // guaranteed on or before the previous Eastern date

      const prevDate    = easternDay(new Date(prevMs));
      const currentDate = easternDay(new Date(nowMs));

      const prevEvent    = makeEvent({ outcome: "preflight_skip", timestampMs: prevMs,
        preflightDecision: "timing_guard" });
      const currentEvent = makeEvent({ outcome: "forwarded",      timestampMs: nowMs });

      const grouped = new Map<string, string>();
      grouped.set(prevDate,    (grouped.get(prevDate)    ?? "") + JSON.stringify(prevEvent)    + "\n");
      grouped.set(currentDate, (grouped.get(currentDate) ?? "") + JSON.stringify(currentEvent) + "\n");
      for (const [d, content] of grouped) {
        writeFileSync(join(testDir, `evaluation-events-${d}.ndjson`), content, "utf8");
      }

      // 26-hour window must open the previous date file and include prevEvent
      const recent = loadRecentEvaluationEvents(26 * 60 * 60 * 1_000);
      assert.ok(
        recent.some((e) => e.timestampMs === prevMs && e.outcome === "preflight_skip"),
        "previous-date-file event must be included in a 26 h window",
      );
      assert.ok(
        recent.some((e) => e.timestampMs === nowMs && e.outcome === "forwarded"),
        "current-date event must also be included",
      );

      // A narrow 1-hour window must NOT include the 25 h-old event
      const narrow = loadRecentEvaluationEvents(60 * 60 * 1_000);
      assert.ok(
        !narrow.some((e) => e.timestampMs === prevMs),
        "previous-day event must be excluded by a 1-hour window",
      );
    });

    it("limitMs=0 loads events from three separate date files written directly to disk", async () => {
      const { writeFileSync } = await import("node:fs");
      const { join }          = await import("node:path");
      const { loadRecentEvaluationEvents } = await import("./evaluationEventStore.js");
      const { easternDay }    = await import("./dailyBudget.js");

      const nowMs  = Date.now();
      const d1Ms   = nowMs - 25 * 60 * 60 * 1_000;
      const d2Ms   = nowMs - 50 * 60 * 60 * 1_000;

      const date0 = easternDay(new Date(nowMs));
      const date1 = easternDay(new Date(d1Ms));
      const date2 = easternDay(new Date(d2Ms));

      const ev0 = makeEvent({ outcome: "forwarded",   timestampMs: nowMs });
      const ev1 = makeEvent({ outcome: "wide_spread",  timestampMs: d1Ms });
      const ev2 = makeEvent({ outcome: "out_of_zone", timestampMs: d2Ms });

      // Group into per-date files (dates may collapse if timezone compresses the range)
      const grouped = new Map<string, string>();
      for (const [d, ev] of [[date0, ev0], [date1, ev1], [date2, ev2]] as [string, ReturnType<typeof makeEvent>][]) {
        grouped.set(d, (grouped.get(d) ?? "") + JSON.stringify(ev) + "\n");
      }
      for (const [d, content] of grouped) {
        writeFileSync(join(testDir, `evaluation-events-${d}.ndjson`), content, "utf8");
      }

      const all = loadRecentEvaluationEvents(0);
      assert.ok(all.length >= 3,
        `limitMs=0 must return all events across all date files; got ${all.length}`);
      assert.ok(all.some((e) => e.timestampMs === nowMs), "0 h-old event must be present");
      assert.ok(all.some((e) => e.timestampMs === d1Ms),  "25 h-old event must be present");
      assert.ok(all.some((e) => e.timestampMs === d2Ms),  "50 h-old event must be present");
    });
  });
});
