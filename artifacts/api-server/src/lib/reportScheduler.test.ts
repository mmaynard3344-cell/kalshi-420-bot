/**
 * Report Scheduler — Unit Tests
 *
 * Uses an injected mock sender so all state transitions are deterministic
 * (no real email, no network, no filesystem side effects for state checks).
 *
 * Covers:
 *   1. easternNow() — IANA-correct ET hour/date, including DST boundaries
 *   2. Pre-7 AM guard — poll before 07:00 ET never fires
 *   3. 07:00 ET trigger — fires at and after 07:00 ET
 *   4. Successful send → state becomes "sent", no retry on next poll
 *   5. Failed send → state becomes "failed", retries on next poll
 *   6. `skipped` (no transport) → treated as failure, retries (not recorded as sent)
 *   7. Restart dedup — injected "sent" state prevents duplicate send
 *   8. Max-attempts cap — stops retrying after MAX_SEND_ATTEMPTS
 *   9. New-day reset — yesterday's "sent" state does not block today's send
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  easternNow,
  _maybeSendReport,
  _resetStateForTesting,
  _injectStateForTesting,
  _getStateForTesting,
  _setSenderForTesting,
  _resetSenderForTesting,
  _setStatePathForTesting,
  _resetStatePathForTesting,
  _loadStateForTesting,
} from "./reportScheduler.js";
import type { SendDailyReportResult } from "./dailyReport.js";

// ── Mock sender factories ─────────────────────────────────────────────────────

function makeOkSender(): { calls: string[]; sender: (d: string) => Promise<SendDailyReportResult> } {
  const calls: string[] = [];
  const sender = async (date: string): Promise<SendDailyReportResult> => {
    calls.push(date);
    return {
      reportData: {
        date,
        fills: [],
        combined: {
          asset: "Combined", fills: 0, wins: 0, losses: 0, pending: 0,
          grossPnl: null, netPnl: null, winRate: null, notional: 0,
        },
        byAsset: [],
        budgetSpentCents: 0,
        budgetCapCents: 800_000,
        budgetRemainingCents: 800_000,
        generatedAt: new Date().toISOString(),
        pendingCount: 0,
      },
      sendResult: { ok: true },
    };
  };
  return { calls, sender };
}

function makeFailSender(): { calls: string[]; sender: (d: string) => Promise<SendDailyReportResult> } {
  const calls: string[] = [];
  const sender = async (date: string): Promise<SendDailyReportResult> => {
    calls.push(date);
    return {
      reportData: {
        date,
        fills: [],
        combined: {
          asset: "Combined", fills: 0, wins: 0, losses: 0, pending: 0,
          grossPnl: null, netPnl: null, winRate: null, notional: 0,
        },
        byAsset: [],
        budgetSpentCents: 0,
        budgetCapCents: 800_000,
        budgetRemainingCents: 800_000,
        generatedAt: new Date().toISOString(),
        pendingCount: 0,
      },
      sendResult: { ok: false, error: "SMTP timeout" },
    };
  };
  return { calls, sender };
}

function makeSkippedSender(): { calls: string[]; sender: (d: string) => Promise<SendDailyReportResult> } {
  const calls: string[] = [];
  const sender = async (date: string): Promise<SendDailyReportResult> => {
    calls.push(date);
    return {
      reportData: {
        date,
        fills: [],
        combined: {
          asset: "Combined", fills: 0, wins: 0, losses: 0, pending: 0,
          grossPnl: null, netPnl: null, winRate: null, notional: 0,
        },
        byAsset: [],
        budgetSpentCents: 0,
        budgetCapCents: 800_000,
        budgetRemainingCents: 800_000,
        generatedAt: new Date().toISOString(),
        pendingCount: 0,
      },
      sendResult: { ok: false, skipped: true, error: "No email transport configured" },
    };
  };
  return { calls, sender };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// 07:00 EST = 12:00 UTC  (January, UTC-5)
const JAN15_07H = new Date("2024-01-15T12:00:00Z");
// 06:59 EST = 11:59 UTC
const JAN15_06H59 = new Date("2024-01-15T11:59:00Z");
// 07:30 EST = 12:30 UTC
const JAN15_07H30 = new Date("2024-01-15T12:30:00Z");
// 07:00 EDT = 11:00 UTC  (July, UTC-4)
const JUL15_07H = new Date("2024-07-15T11:00:00Z");
// 07:00 EST on the next day
const JAN16_07H = new Date("2024-01-16T12:00:00Z");

beforeEach(() => {
  _resetStateForTesting();
  _resetSenderForTesting();
});

// ── 1. easternNow() ───────────────────────────────────────────────────────────

describe("easternNow", () => {
  it("returns correct hour in EST (UTC-5): 12:00 UTC → 07:00 ET", () => {
    const { date, hour } = easternNow(JAN15_07H);
    assert.equal(date, "2024-01-15");
    assert.equal(hour, 7);
  });

  it("returns correct hour in EDT (UTC-4): 11:00 UTC → 07:00 ET", () => {
    const { date, hour } = easternNow(JUL15_07H);
    assert.equal(date, "2024-07-15");
    assert.equal(hour, 7);
  });

  it("crosses midnight correctly: 04:00 UTC on Jan 16 = 23:00 EST Jan 15", () => {
    const { date, hour } = easternNow(new Date("2024-01-16T04:00:00Z"));
    assert.equal(date, "2024-01-15");
    assert.equal(hour, 23);
  });

  it("handles DST spring-forward: 2024-03-10 07:00 UTC = 03:00 EDT (post-forward)", () => {
    const { hour } = easternNow(new Date("2024-03-10T07:00:00Z"));
    assert.equal(hour, 3);
  });

  it("handles DST fall-back: 2024-11-03 06:00 UTC = 01:00 EST (post-fallback)", () => {
    const { hour } = easternNow(new Date("2024-11-03T06:00:00Z"));
    assert.equal(hour, 1);
  });
});

// ── 2. Pre-7 AM guard ─────────────────────────────────────────────────────────

describe("pre-7 AM guard", () => {
  it("does not call sender before 07:00 ET", async () => {
    const { calls, sender } = makeOkSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_06H59);
    assert.equal(calls.length, 0, "sender must not be called before 07:00 ET");
    assert.equal(_getStateForTesting(), null);
  });
});

// ── 3. 07:00 ET trigger ───────────────────────────────────────────────────────

describe("07:00 ET trigger", () => {
  it("calls sender at exactly 07:00 ET", async () => {
    const { calls, sender } = makeOkSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H);
    assert.equal(calls.length, 1, "sender must be called once at 07:00 ET");
  });

  it("calls sender after 07:00 ET (07:30)", async () => {
    const { calls, sender } = makeOkSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H30);
    assert.equal(calls.length, 1);
  });
});

// ── 4. Successful send → "sent", no retry ────────────────────────────────────

describe("successful send", () => {
  it("records status 'sent' and date after a successful send", async () => {
    const { sender } = makeOkSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H);
    const s = _getStateForTesting();
    assert.ok(s !== null);
    assert.equal(s!.status, "sent");
    assert.equal(s!.date, "2024-01-15");
    assert.equal(s!.attempts, 1);
  });

  it("does not call sender again on the next poll after a successful send", async () => {
    const { calls, sender } = makeOkSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H);
    await _maybeSendReport(JAN15_07H30); // second poll
    assert.equal(calls.length, 1, "sender called exactly once — no re-send on second poll");
  });
});

// ── 5. Failed send → "failed", retries ───────────────────────────────────────

describe("failed send", () => {
  it("records status 'failed' when the sender returns ok:false", async () => {
    const { sender } = makeFailSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H);
    const s = _getStateForTesting();
    assert.ok(s !== null);
    assert.equal(s!.status, "failed");
    assert.equal(s!.date, "2024-01-15");
    assert.equal(s!.attempts, 1);
  });

  it("retries on the next poll after a failed send, incrementing attempts", async () => {
    const { calls, sender } = makeFailSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H);      // attempt 1 → failed
    await _maybeSendReport(JAN15_07H30);   // attempt 2 → retry
    assert.equal(calls.length, 2, "sender called twice — retry occurred");
    const s = _getStateForTesting();
    assert.equal(s!.status, "failed");
    assert.equal(s!.attempts, 2);
  });
});

// ── 6. Skipped (no transport) → treated as failure, retries ──────────────────

describe("skipped send", () => {
  it("records status 'failed' (not 'sent') when send is skipped (no transport)", async () => {
    const { sender } = makeSkippedSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H);
    const s = _getStateForTesting();
    assert.ok(s !== null);
    assert.equal(s!.status, "failed", "skipped must not be recorded as 'sent'");
  });

  it("retries a skipped send on the next poll (allows credentials to be added mid-day)", async () => {
    const { calls, sender } = makeSkippedSender();
    _setSenderForTesting(sender);
    await _maybeSendReport(JAN15_07H);
    await _maybeSendReport(JAN15_07H30);
    assert.equal(calls.length, 2, "must retry after a skipped send");
  });
});

// ── 7. Restart dedup ──────────────────────────────────────────────────────────

describe("restart dedup", () => {
  it("does not call sender when injected state shows 'sent' for today", async () => {
    const { calls, sender } = makeOkSender();
    _setSenderForTesting(sender);
    _injectStateForTesting({
      date: "2024-01-15", status: "sent", attempts: 1,
      lastAttemptAt: JAN15_07H.toISOString(),
    });
    await _maybeSendReport(JAN15_07H30);
    assert.equal(calls.length, 0, "sender must not be called — already sent today");
    assert.equal(_getStateForTesting()!.attempts, 1, "attempts must not increment");
  });
});

// ── 8. Max-attempts cap ───────────────────────────────────────────────────────

describe("max attempts cap", () => {
  it("stops calling sender once MAX_SEND_ATTEMPTS (5) is reached", async () => {
    const { calls, sender } = makeFailSender();
    _setSenderForTesting(sender);

    // Exhaust attempts
    for (let i = 0; i < 5; i++) {
      await _maybeSendReport(JAN15_07H);
    }
    const callsAtCap = calls.length;
    assert.ok(callsAtCap <= 5, `should not exceed 5 attempts, got ${callsAtCap}`);

    // Additional polls must not add more calls
    await _maybeSendReport(JAN15_07H30);
    await _maybeSendReport(JAN15_07H30);
    assert.equal(calls.length, callsAtCap, "no further sender calls after cap");
  });
});

// ── 9. New-day reset ──────────────────────────────────────────────────────────

describe("new-day reset", () => {
  it("fires again on a new day even when yesterday's state was 'sent'", async () => {
    const { calls, sender } = makeOkSender();
    _setSenderForTesting(sender);
    _injectStateForTesting({
      date: "2024-01-14", status: "sent", attempts: 1,
      lastAttemptAt: new Date("2024-01-14T12:00:00Z").toISOString(),
    });
    await _maybeSendReport(JAN16_07H); // next day
    assert.equal(calls.length, 1, "should send for the new day");
    const s = _getStateForTesting();
    assert.equal(s!.date, "2024-01-16");
    assert.equal(s!.status, "sent");
  });

  it("fires again when yesterday's state was 'failed'", async () => {
    const { calls, sender } = makeOkSender();
    _setSenderForTesting(sender);
    _injectStateForTesting({
      date: "2024-01-14", status: "failed", attempts: 3,
      lastAttemptAt: new Date("2024-01-14T14:00:00Z").toISOString(),
    });
    await _maybeSendReport(JAN16_07H);
    assert.equal(calls.length, 1, "should send fresh for the new day regardless of prior failures");
    assert.equal(_getStateForTesting()!.date, "2024-01-16");
  });
});

// ── 10. Disk durability ───────────────────────────────────────────────────────
// Verifies that _loadState() reads what _persistState() (triggered via
// _maybeSendReport) wrote, so a restart after a successful send doesn't re-send.

describe("disk durability", () => {
  let tmpDir: string;
  let tmpFile: string;

  // Use a dedicated tmp directory isolated to this suite
  const setupTmp = () => {
    tmpDir  = join(tmpdir(), `sched-test-${process.pid}-${Date.now()}`);
    tmpFile = join(tmpDir, "scheduler-state.json");
    mkdirSync(tmpDir, { recursive: true });
    _setStatePathForTesting(tmpFile);
    _resetStateForTesting();
  };

  const teardownTmp = () => {
    _resetStatePathForTesting();
    _resetStateForTesting();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  it("persists 'sent' state to disk after a successful send", async () => {
    setupTmp();
    try {
      const { sender } = makeOkSender();
      _setSenderForTesting(sender);

      await _maybeSendReport(JAN15_07H);

      // State must be on disk
      const raw  = JSON.parse(require("node:fs").readFileSync(tmpFile, "utf8"));
      assert.equal(raw.status, "sent");
      assert.equal(raw.date, "2024-01-15");
      assert.equal(raw.attempts, 1);
    } finally {
      teardownTmp();
    }
  });

  it("persists 'failed' state to disk after a failed send", async () => {
    setupTmp();
    try {
      const { sender } = makeFailSender();
      _setSenderForTesting(sender);

      await _maybeSendReport(JAN15_07H);

      const raw = JSON.parse(require("node:fs").readFileSync(tmpFile, "utf8"));
      assert.equal(raw.status, "failed");
      assert.equal(raw.date, "2024-01-15");
    } finally {
      teardownTmp();
    }
  });

  it("loading persisted 'sent' state prevents re-send after restart", async () => {
    setupTmp();
    try {
      // Simulate a prior run that successfully sent
      const prior = {
        date: "2024-01-15", status: "sent", attempts: 1,
        lastAttemptAt: JAN15_07H.toISOString(),
      };
      writeFileSync(tmpFile, JSON.stringify(prior), "utf8");

      // Simulate process restart: clear in-memory state, then load from disk
      _resetStateForTesting();
      _loadStateForTesting();  // reads from tmpFile

      // Now a post-restart poll should not fire
      const { calls, sender } = makeOkSender();
      _setSenderForTesting(sender);
      await _maybeSendReport(JAN15_07H30);

      assert.equal(calls.length, 0, "must not re-send after loading 'sent' state from disk");
    } finally {
      teardownTmp();
    }
  });

  it("loading persisted 'failed' state retries after restart", async () => {
    setupTmp();
    try {
      // Simulate a prior failed attempt (1 of 5)
      const prior = {
        date: "2024-01-15", status: "failed", attempts: 1,
        lastAttemptAt: JAN15_07H.toISOString(),
      };
      writeFileSync(tmpFile, JSON.stringify(prior), "utf8");

      _resetStateForTesting();
      _loadStateForTesting();

      const { calls, sender } = makeOkSender();
      _setSenderForTesting(sender);
      await _maybeSendReport(JAN15_07H30);

      assert.equal(calls.length, 1, "must retry after loading 'failed' state from disk");
      const s = _getStateForTesting();
      assert.equal(s!.status, "sent");
      assert.equal(s!.attempts, 2);
    } finally {
      teardownTmp();
    }
  });
});
