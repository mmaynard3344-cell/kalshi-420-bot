import test from "node:test";
import assert from "node:assert/strict";
import { completedEasternWeek, easternMidnightMs } from "./weeklyReportCalendar.js";

test("completed report interval is Saturday-to-Saturday in Eastern time", () => {
  assert.deepEqual(completedEasternWeek(new Date("2026-08-15T15:00:00Z")), {
    weekStart: "2026-08-08", weekEndExclusive: "2026-08-15",
  });
  assert.deepEqual(completedEasternWeek(new Date("2026-03-10T16:00:00Z")), {
    weekStart: "2026-02-28", weekEndExclusive: "2026-03-07",
  });
});

test("Eastern midnight remains correct across the spring DST boundary", () => {
  assert.equal(easternMidnightMs("2026-03-08"), Date.parse("2026-03-08T05:00:00Z"));
  assert.equal(easternMidnightMs("2026-03-09"), Date.parse("2026-03-09T04:00:00Z"));
});