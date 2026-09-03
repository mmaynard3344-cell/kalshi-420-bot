/**
 * Unit tests for ETH 30–50 weekly P&L grouping.
 *
 * Verifies that `getWeekMonday` and `groupTickersByWeek` bucket tickers by
 * their `easternDate` (claim date), NOT their settlement date.  Week-boundary
 * cases — Sunday, Monday, and tickers whose claim and settlement fall in
 * different weeks — receive explicit coverage.
 *
 * These helpers live in @/lib/eth30WeekGroup and are imported by Dashboard.tsx.
 * Changing the grouping key in Dashboard.tsx to settlement date would leave
 * these tests green (because the lib is unchanged), so the comment in
 * Dashboard.tsx pointing here and the "claim vs settlement" cases below act
 * as a combined guard.
 *
 * Run via the api-server test harness:
 *   cd artifacts/api-server && \
 *   node_modules/.bin/esbuild \
 *     ../kalshi-reader/src/pages/Dashboard.eth30WeekGroup.test.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=/tmp/eth30-week-group.mjs && \
 *   node --test /tmp/eth30-week-group.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getWeekMonday, groupTickersByWeek } from '../lib/eth30WeekGroup';

// ---------------------------------------------------------------------------
// Calendar notes used in the tests (2026):
//
//   Mon 2026-08-10  Tue 2026-08-11  Wed 2026-08-12  Thu 2026-08-13
//   Fri 2026-08-14  Sat 2026-08-15  Sun 2026-08-16
//   Mon 2026-08-17  …
//
//   Mon 2026-08-03  …  Sun 2026-08-09
//   Mon 2026-08-10  …  Sun 2026-08-16
//   Mon 2026-08-17  …  Sun 2026-08-23
// ---------------------------------------------------------------------------

// ─── getWeekMonday ───────────────────────────────────────────────────────────

describe('getWeekMonday', () => {
  it('Monday maps to itself', () => {
    // 2026-08-10 is a Monday
    assert.equal(getWeekMonday('2026-08-10'), '2026-08-10');
  });

  it('Tuesday maps to the preceding Monday', () => {
    assert.equal(getWeekMonday('2026-08-11'), '2026-08-10');
  });

  it('Wednesday maps to the preceding Monday', () => {
    assert.equal(getWeekMonday('2026-08-12'), '2026-08-10');
  });

  it('Friday maps to the preceding Monday', () => {
    assert.equal(getWeekMonday('2026-08-14'), '2026-08-10');
  });

  it('Saturday maps to the preceding Monday', () => {
    assert.equal(getWeekMonday('2026-08-15'), '2026-08-10');
  });

  it('Sunday maps to the PREVIOUS Monday (6 days back), not the coming Monday', () => {
    // Sunday 2026-08-16 belongs to the week that started Mon 2026-08-10
    assert.equal(getWeekMonday('2026-08-16'), '2026-08-10');
  });

  it('the Monday after Sunday starts a new week', () => {
    // Monday 2026-08-17 starts a new ISO week
    assert.equal(getWeekMonday('2026-08-17'), '2026-08-17');
  });

  it('handles a month boundary: Sunday is in the preceding month\'s week', () => {
    // 2026-08-31 is a Monday, so 2026-08-30 (Sunday) maps to 2026-08-24 (Monday)
    assert.equal(getWeekMonday('2026-08-30'), '2026-08-24');
    assert.equal(getWeekMonday('2026-08-31'), '2026-08-31');
  });

  it('handles year boundary: Sunday 2025-12-28 maps to Mon 2025-12-22', () => {
    // 2025-12-22 is a Monday, 2025-12-28 is a Sunday
    assert.equal(getWeekMonday('2025-12-28'), '2025-12-22');
  });

  it('handles year boundary: Monday 2026-01-05 maps to itself', () => {
    assert.equal(getWeekMonday('2026-01-05'), '2026-01-05');
  });
});

// ─── groupTickersByWeek: core bucketing ──────────────────────────────────────

describe('groupTickersByWeek', () => {
  it('places tickers in the same week when they share the same Monday key', () => {
    const rows = [
      { easternDate: '2026-08-10' }, // Monday
      { easternDate: '2026-08-12' }, // Wednesday — same week
      { easternDate: '2026-08-14' }, // Friday — same week
    ];
    const { weekOrder, weekGroups } = groupTickersByWeek(rows);
    assert.deepEqual(weekOrder, ['2026-08-10'], 'all three dates share one week bucket');
    assert.equal(weekGroups['2026-08-10'].length, 3);
  });

  it('separates tickers into distinct weeks', () => {
    const rows = [
      { easternDate: '2026-08-10' }, // week of Aug 10
      { easternDate: '2026-08-17' }, // week of Aug 17
    ];
    const { weekOrder, weekGroups } = groupTickersByWeek(rows);
    assert.deepEqual(weekOrder, ['2026-08-10', '2026-08-17']);
    assert.equal(weekGroups['2026-08-10'].length, 1);
    assert.equal(weekGroups['2026-08-17'].length, 1);
  });

  it('returns weekOrder sorted oldest-first regardless of input order', () => {
    const rows = [
      { easternDate: '2026-08-17' }, // newer week first in input
      { easternDate: '2026-08-10' }, // older week second
    ];
    const { weekOrder } = groupTickersByWeek(rows);
    assert.deepEqual(weekOrder, ['2026-08-10', '2026-08-17'], 'weeks must be sorted oldest → newest');
  });

  it('groups by easternDate (claim date) — settlement date has no effect on bucketing', () => {
    // Ticker claimed Monday 2026-08-10, but suppose it settles Friday 2026-08-21 (next week).
    // The row only carries easternDate (claim date); the grouper must use that.
    // We model this by giving the row an easternDate of Monday and verifying
    // it lands in the Aug-10 bucket, not the Aug-17 bucket that contains the settlement week.
    const claimedMonday = { easternDate: '2026-08-10', settlementDate: '2026-08-21' };
    const claimedFriday = { easternDate: '2026-08-14', settlementDate: '2026-08-21' };
    const { weekOrder, weekGroups } = groupTickersByWeek([claimedMonday, claimedFriday]);

    assert.deepEqual(weekOrder, ['2026-08-10'], 'both rows land in the Aug-10 week despite settling in Aug-21');
    assert.equal(weekGroups['2026-08-10'].length, 2, 'both tickers are in the claim-date week bucket');
    assert.equal(weekGroups['2026-08-17'], undefined, 'no bucket is created for the settlement week');
  });

  it('Sunday claim stays in the PREVIOUS week bucket, not the next-week bucket', () => {
    // Sunday 2026-08-16 → week key 2026-08-10 (the Mon that started that ISO week)
    // Monday 2026-08-17 → week key 2026-08-17 (a new week starts)
    const sundayClaim  = { easternDate: '2026-08-16' }; // Sunday — belongs to Aug-10 week
    const mondayClaim  = { easternDate: '2026-08-17' }; // Monday — starts Aug-17 week
    const { weekOrder, weekGroups } = groupTickersByWeek([sundayClaim, mondayClaim]);

    assert.deepEqual(weekOrder, ['2026-08-10', '2026-08-17'],
      'Sunday claim is in Aug-10 week; Monday claim opens Aug-17 week');
    assert.deepEqual(weekGroups['2026-08-10'], [sundayClaim],
      'Sunday ticker is in the Aug-10 bucket');
    assert.deepEqual(weekGroups['2026-08-17'], [mondayClaim],
      'Monday ticker opens the Aug-17 bucket');
  });

  it('a ticker claimed on Sunday but settling the following Friday stays in the Sunday\'s week', () => {
    // Real scenario: market claimed Sunday 2026-08-16 (settles Fri 2026-08-21)
    // Must bucket under 2026-08-10 (the Monday of the claim week).
    const row = { easternDate: '2026-08-16', settlementDate: '2026-08-21' };
    const { weekOrder } = groupTickersByWeek([row]);
    assert.deepEqual(weekOrder, ['2026-08-10'],
      'Sunday claim must land in the preceding-Monday bucket, not the next week');
  });

  it('a ticker claimed on Monday starts a fresh bucket even if a Sunday was claimed the day before', () => {
    // Sunday 2026-08-16 → bucket 2026-08-10
    // Monday 2026-08-17 → bucket 2026-08-17  (a day later, but a new ISO week)
    const sunday = { easternDate: '2026-08-16' };
    const monday = { easternDate: '2026-08-17' };
    const { weekOrder } = groupTickersByWeek([sunday, monday]);
    assert.deepEqual(weekOrder, ['2026-08-10', '2026-08-17'],
      'Monday claim always opens a new bucket, one day after Sunday does not merge them');
  });

  it('handles an empty ticker list', () => {
    const { weekOrder, weekGroups } = groupTickersByWeek([]);
    assert.deepEqual(weekOrder, []);
    assert.deepEqual(weekGroups, {});
  });

  it('handles a single ticker', () => {
    const { weekOrder, weekGroups } = groupTickersByWeek([{ easternDate: '2026-08-12' }]);
    assert.deepEqual(weekOrder, ['2026-08-10']);
    assert.equal(weekGroups['2026-08-10'].length, 1);
  });
});
