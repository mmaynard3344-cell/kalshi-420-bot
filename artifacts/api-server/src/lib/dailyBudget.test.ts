/**
 * Unit tests for the daily budget pure-logic module — uses Node.js built-in
 * test runner (node:test + node:assert/strict). No external dependencies.
 *
 * All tests pass explicit `now: Date` values — no globals are mocked.
 * Eastern timezone calculations rely on Node.js built-in ICU (always present).
 *
 * Scenarios:
 *  1. Normal midnight rollover — spend resets, roll metadata correct
 *  2. Server restart before midnight — persisted spend restored
 *  3. Server restart after midnight — spend reset to 0
 *  4. Corrupted or missing date state — safe fallback to fresh state
 *  5. Two concurrent reservation attempts during rollover — atomic
 *  6. DST fall-back (Nov 2 → Nov 3, 2025 ET)
 *  7. DST spring-forward (Mar 9 → Mar 10, 2025 ET)
 *  8. releaseCents — correct subtraction and floor-at-zero
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  easternDay,
  rollIfNewDay,
  tryReserve,
  releaseCents,
  parseBudgetFile,
  nextEasternMidnight,
  type DailyBudgetState,
} from "./dailyBudget.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Shorthand: build a Date from an ISO UTC string. */
const d = (iso: string) => new Date(iso);

const MAX = 800_000; // $8,000 in cents — matches production default

// ── 1. Normal midnight rollover ───────────────────────────────────────────────

describe("rollIfNewDay", () => {
  it("leaves state unchanged when the Eastern date has not advanced", () => {
    // 3:00 PM ET on July 29 — still July 29
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 45_000 };
    const now = d("2026-07-29T19:00:00.000Z"); // 3 PM EDT (UTC-4)
    const result = rollIfNewDay(state, now);

    assert.strictEqual(result.rolled, false);
    assert.strictEqual(result.next, state);      // same reference — no allocation
    assert.strictEqual(result.priorDate, "2026-07-29");
    assert.strictEqual(result.priorSpentCents, 45_000);
  });

  it("resets spend and advances date when midnight ET passes", () => {
    // State from July 29; now it is 12:01 AM ET on July 30
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 320_000 };
    const now = d("2026-07-30T04:01:00.000Z"); // 12:01 AM EDT (UTC-4)
    const result = rollIfNewDay(state, now);

    assert.strictEqual(result.rolled, true);
    assert.strictEqual(result.next.date, "2026-07-30");
    assert.strictEqual(result.next.spentCents, 0);
    assert.strictEqual(result.priorDate, "2026-07-29");
    assert.strictEqual(result.priorSpentCents, 320_000);
  });

  it("rolls at exactly midnight ET — no off-by-one", () => {
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 1_000 };
    const atMidnight    = d("2026-07-30T04:00:00.000Z"); // midnight EDT
    const beforeMidnight = d("2026-07-30T03:59:59.999Z");

    assert.strictEqual(rollIfNewDay(state, beforeMidnight).rolled, false);
    assert.strictEqual(rollIfNewDay(state, atMidnight).rolled, true);
  });
});

// ── 2. Server restart before midnight (spend restored) ────────────────────────

describe("parseBudgetFile — restart before midnight", () => {
  it("restores spend when the stored Eastern date matches today", () => {
    const stored = { date: "2026-07-29", spentCents: 75_000 };
    const now = d("2026-07-29T18:00:00.000Z"); // 2 PM EDT
    const result = parseBudgetFile(stored, now);

    assert.strictEqual(result.date, "2026-07-29");
    assert.strictEqual(result.spentCents, 75_000);
  });

  it("handles the legacy 'day' field (old UTC-keyed format) on the same calendar date", () => {
    // Old code stored 'day' in UTC. Same calendar date in both zones for this timestamp.
    const stored = { day: "2026-07-29", spentCents: 50_000 };
    const now = d("2026-07-29T18:00:00.000Z"); // 2 PM EDT → July 29 ET
    const result = parseBudgetFile(stored, now);

    assert.strictEqual(result.date, "2026-07-29");
    assert.strictEqual(result.spentCents, 50_000);
  });
});

// ── 3. Server restart after midnight (spend reset) ────────────────────────────

describe("parseBudgetFile — restart after midnight", () => {
  it("resets spend when the stored date is a prior Eastern day", () => {
    // Stored on July 29; server restarts at 1:01 AM ET on July 30
    const stored = { date: "2026-07-29", spentCents: 400_000 };
    const now = d("2026-07-30T05:01:00.000Z"); // 1:01 AM EDT
    const result = parseBudgetFile(stored, now);

    assert.strictEqual(result.date, "2026-07-30");
    assert.strictEqual(result.spentCents, 0);
  });

  it("resets spend when the stored date is a future date (clock skew defence)", () => {
    const stored = { date: "2026-08-01", spentCents: 10_000 };
    const now = d("2026-07-29T18:00:00.000Z"); // July 29 ET
    const result = parseBudgetFile(stored, now);

    assert.strictEqual(result.date, "2026-07-29");
    assert.strictEqual(result.spentCents, 0);
  });
});

// ── 4. Corrupted or missing date state ────────────────────────────────────────

describe("parseBudgetFile — corrupted or missing state", () => {
  const now = d("2026-07-29T18:00:00.000Z");

  it("returns fresh state for null", () => {
    const r = parseBudgetFile(null, now);
    assert.strictEqual(r.date, "2026-07-29");
    assert.strictEqual(r.spentCents, 0);
  });

  it("returns fresh state for an empty object", () => {
    const r = parseBudgetFile({}, now);
    assert.strictEqual(r.spentCents, 0);
  });

  it("returns fresh state when spentCents is not a number", () => {
    const r = parseBudgetFile({ date: "2026-07-29", spentCents: "bad" }, now);
    assert.strictEqual(r.spentCents, 0);
  });

  it("returns fresh state when date field is missing", () => {
    const r = parseBudgetFile({ spentCents: 12_000 }, now);
    assert.strictEqual(r.spentCents, 0);
  });

  it("returns fresh state for non-objects (array, string, number)", () => {
    assert.strictEqual(parseBudgetFile([], now).spentCents, 0);
    assert.strictEqual(parseBudgetFile("bad", now).spentCents, 0);
    assert.strictEqual(parseBudgetFile(42, now).spentCents, 0);
  });

  it("rejects negative spentCents", () => {
    const r = parseBudgetFile({ date: "2026-07-29", spentCents: -500 }, now);
    assert.strictEqual(r.spentCents, 0);
  });
});

// ── 5. Two concurrent reservation attempts during rollover ────────────────────

describe("tryReserve — atomicity during midnight rollover", () => {
  it("first caller sees rollover, second caller sees already-current date", () => {
    // In Node.js sync code, two callers execute serially. This test verifies
    // that the second call uses the state produced by the first (as trade.ts
    // does by assigning budget = result.next before returning).
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 500_000 };
    const now = d("2026-07-30T04:01:00.000Z"); // just after midnight ET

    const r1 = tryReserve(state, 100_000, MAX, now);
    assert.strictEqual(r1.rollResult.rolled, true);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.next.date, "2026-07-30");
    assert.strictEqual(r1.next.spentCents, 100_000);

    // Second caller uses the state committed by the first
    const r2 = tryReserve(r1.next, 100_000, MAX, now);
    assert.strictEqual(r2.rollResult.rolled, false); // date already current
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.next.spentCents, 200_000); // additive, not double-init
  });

  it("second caller cannot exceed the cap even after rollover", () => {
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 0 };
    const now = d("2026-07-30T04:01:00.000Z");

    const r1 = tryReserve(state, 750_000, MAX, now); // $7,500 — ok
    assert.strictEqual(r1.ok, true);

    const r2 = tryReserve(r1.next, 75_000, MAX, now); // $750 over cap
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.next.spentCents, 750_000); // spend unchanged on rejection
  });

  it("cap rejection does not mutate the passed-in state", () => {
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 790_000 };
    const now = d("2026-07-29T18:00:00.000Z");

    const result = tryReserve(state, 11_000, MAX, now); // over cap
    assert.strictEqual(result.ok, false);
    assert.strictEqual(state.spentCents, 790_000); // original unchanged
  });
});

// ── 6. DST fall-back: Nov 2 → Nov 3, 2025 ET ─────────────────────────────────

describe("easternDay — DST fall-back (Nov 2, 2025)", () => {
  // US clocks fall back at 2:00 AM ET on Nov 2, 2025.
  // EDT (UTC-4) until the transition; EST (UTC-5) after.
  // Midnight Nov 2 ET = 04:00 UTC (EDT)
  // Midnight Nov 3 ET = 05:00 UTC (EST, after fall-back)

  it("returns Nov 2 just before midnight (EST — after fall-back)", () => {
    // By 11:59 PM on Nov 2, clocks have already fallen back to EST (UTC-5).
    // 11:59:59 PM EST = Nov 3 04:59:59 UTC.
    const justBefore = d("2025-11-03T04:59:59.999Z"); // 11:59:59 PM EST on Nov 2
    assert.strictEqual(easternDay(justBefore), "2025-11-02");
  });

  it("returns Nov 3 at midnight (EST)", () => {
    const midnight = d("2025-11-03T05:00:00.000Z"); // midnight EST
    assert.strictEqual(easternDay(midnight), "2025-11-03");
  });

  it("returns Nov 2 during the repeated 1 AM hour (fall-back interval)", () => {
    // 1:30 AM on Nov 2 occurs twice; both instances are still Nov 2 ET
    const repeated = d("2025-11-02T06:30:00.000Z"); // 1:30 AM EST on Nov 2
    assert.strictEqual(easternDay(repeated), "2025-11-02");
  });

  it("rollIfNewDay advances from Nov 2 to Nov 3 at first-EST midnight", () => {
    const state: DailyBudgetState = { date: "2025-11-02", spentCents: 99_000 };
    const midnight = d("2025-11-03T05:00:00.000Z");
    const result = rollIfNewDay(state, midnight);

    assert.strictEqual(result.rolled, true);
    assert.strictEqual(result.next.date, "2025-11-03");
    assert.strictEqual(result.next.spentCents, 0);
  });
});

// ── 7. DST spring-forward: Mar 9 → Mar 10, 2025 ET ──────────────────────────

describe("easternDay — DST spring-forward (Mar 9, 2025)", () => {
  // US clocks spring forward at 2:00 AM ET on Mar 9, 2025.
  // EST (UTC-5) before the transition; EDT (UTC-4) after.
  // Midnight Mar 9 ET = 05:00 UTC (EST)
  // Midnight Mar 10 ET = 04:00 UTC (EDT, after spring-forward)

  it("returns Mar 9 just before midnight (EDT — after spring-forward)", () => {
    // By 11:59 PM on Mar 9, clocks have already sprung forward to EDT (UTC-4).
    // 11:59:59 PM EDT = Mar 10 03:59:59 UTC.
    const justBefore = d("2025-03-10T03:59:59.999Z"); // 11:59:59 PM EDT on Mar 9
    assert.strictEqual(easternDay(justBefore), "2025-03-09");
  });

  it("returns Mar 10 at midnight (EDT)", () => {
    const midnight = d("2025-03-10T04:00:00.000Z"); // midnight EDT
    assert.strictEqual(easternDay(midnight), "2025-03-10");
  });

  it("returns Mar 9 during the non-existent 2-3 AM gap (spring-forward)", () => {
    // The 2:30 AM instant does not exist in local time — the UTC instant that
    // would have been 2:30 AM EST becomes 3:30 AM EDT, still on Mar 9.
    const gap = d("2025-03-09T07:30:00.000Z"); // 3:30 AM EDT on Mar 9
    assert.strictEqual(easternDay(gap), "2025-03-09");
  });

  it("rollIfNewDay advances from Mar 9 to Mar 10 at EDT midnight", () => {
    const state: DailyBudgetState = { date: "2025-03-09", spentCents: 150_000 };
    const midnight = d("2025-03-10T04:00:00.000Z");
    const result = rollIfNewDay(state, midnight);

    assert.strictEqual(result.rolled, true);
    assert.strictEqual(result.next.date, "2025-03-10");
    assert.strictEqual(result.next.spentCents, 0);
  });
});

// ── 9. nextEasternMidnight ────────────────────────────────────────────────────

describe("nextEasternMidnight", () => {
  it("returns the next ET midnight in EDT (summer, UTC-4)", () => {
    // 3:00 PM EDT on July 29 → next midnight is July 30 00:00 ET = 04:00 UTC
    const now = d("2026-07-29T19:00:00.000Z"); // 3 PM EDT
    const result = nextEasternMidnight(now);
    assert.strictEqual(result.toISOString(), "2026-07-30T04:00:00.000Z");
    // The result must be a different Eastern day
    assert.strictEqual(easternDay(result), "2026-07-30");
  });

  it("returns the next ET midnight in EST (winter, UTC-5)", () => {
    // 3:00 PM EST on Jan 15 → next midnight is Jan 16 00:00 ET = 05:00 UTC
    const now = d("2026-01-15T20:00:00.000Z"); // 3 PM EST
    const result = nextEasternMidnight(now);
    assert.strictEqual(result.toISOString(), "2026-01-16T05:00:00.000Z");
    assert.strictEqual(easternDay(result), "2026-01-16");
  });

  it("returns midnight on the correct side of a DST spring-forward transition", () => {
    // Mar 9, 2025: clocks spring forward at 2 AM EST → 3 AM EDT.
    // Midnight Mar 10 ET = 04:00 UTC (EDT, UTC-4).
    const now = d("2025-03-09T20:00:00.000Z"); // 3 PM EDT on Mar 9 (after spring-forward)
    const result = nextEasternMidnight(now);
    assert.strictEqual(result.toISOString(), "2025-03-10T04:00:00.000Z");
    assert.strictEqual(easternDay(result), "2025-03-10");
  });

  it("returns midnight on the correct side of a DST fall-back transition", () => {
    // Nov 2, 2025: clocks fall back at 2 AM EDT → 1 AM EST.
    // Midnight Nov 3 ET = 05:00 UTC (EST, UTC-5).
    const now = d("2025-11-02T16:00:00.000Z"); // noon EST on Nov 2 (after fall-back)
    const result = nextEasternMidnight(now);
    assert.strictEqual(result.toISOString(), "2025-11-03T05:00:00.000Z");
    assert.strictEqual(easternDay(result), "2025-11-03");
  });

  it("result is always in the future relative to now", () => {
    const now = d("2026-07-29T23:59:59.000Z"); // 7:59 PM EDT — still July 29 ET
    const result = nextEasternMidnight(now);
    assert.ok(result.getTime() > now.getTime(), "next midnight must be after now");
  });

  it("result is always on the next Eastern calendar day", () => {
    const now = d("2026-07-29T19:00:00.000Z");
    const today = easternDay(now);
    const result = nextEasternMidnight(now);
    assert.notStrictEqual(easternDay(result), today);
  });
});

// ── 8. releaseCents ───────────────────────────────────────────────────────────

describe("releaseCents", () => {
  it("subtracts correctly", () => {
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 50_000 };
    assert.strictEqual(releaseCents(state, 10_000).spentCents, 40_000);
  });

  it("floors at zero — never goes negative", () => {
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 1_000 };
    assert.strictEqual(releaseCents(state, 5_000).spentCents, 0);
  });

  it("does not mutate the original state", () => {
    const state: DailyBudgetState = { date: "2026-07-29", spentCents: 20_000 };
    releaseCents(state, 5_000);
    assert.strictEqual(state.spentCents, 20_000); // original unchanged
  });
});
