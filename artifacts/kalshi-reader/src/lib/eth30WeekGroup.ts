/**
 * Helpers for grouping ETH 30–50 ticker rows into ISO weeks.
 *
 * Tickers are bucketed by `easternDate` (the claim date), which is the YYYY-MM-DD
 * string in Eastern time set at the moment the bot claims the market — NOT the
 * settlement date.  This means a ticker claimed on Monday but settling the
 * following Friday stays in the Monday claim week, which is the intended behaviour.
 *
 * Using claim date (not settlement date) matters at week boundaries:
 *   - A ticker claimed on Sunday (last day of the previous ISO week) belongs in
 *     that week's bucket even though it may settle several days into the next week.
 *   - A ticker claimed on Monday (first day of a new ISO week) opens a new bucket
 *     immediately, regardless of when its market closes.
 */

import {
  computeEth30WeekSummary,
  type Eth30TickerRow,
  type Eth30WeekSummary,
} from './eth30FeeWarning.js';

export interface WeekGroupRow {
  /** YYYY-MM-DD in Eastern time — the day the bot claimed this market. */
  easternDate: string;
}

/**
 * Given an `easternDate` string (YYYY-MM-DD), return the YYYY-MM-DD of the
 * Monday that starts the ISO week containing that date.
 *
 * The `T12:00:00` suffix keeps us at noon local time so daylight-saving
 * transitions near midnight can never shift the parsed date into the wrong day.
 */
export function getWeekMonday(easternDate: string): string {
  const d = new Date(easternDate + 'T12:00:00');
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, …, 6 = Saturday
  const offset = day === 0 ? -6 : 1 - day; // shift back to Monday
  const mon = new Date(d);
  mon.setDate(d.getDate() + offset);
  return mon.toISOString().slice(0, 10);
}

/**
 * Group an array of ticker rows by the ISO-week Monday of their `easternDate`.
 *
 * Returns a stable insertion-ordered map (weekMonday → rows[]) plus an array
 * of week keys sorted oldest-first, matching how Dashboard.tsx renders the table.
 *
 * Bucketing is always by `easternDate` (claim date).  Callers must never pass
 * a settlement date here — that would silently move week-boundary tickers into
 * the wrong bucket.
 */
export function groupTickersByWeek<T extends WeekGroupRow>(
  tickers: T[],
): { weekOrder: string[]; weekGroups: Record<string, T[]> } {
  const weekOrder: string[] = [];
  const weekGroups: Record<string, T[]> = {};

  for (const row of tickers) {
    const key = getWeekMonday(row.easternDate);
    if (!weekGroups[key]) {
      weekGroups[key] = [];
      weekOrder.push(key);
    }
    weekGroups[key].push(row);
  }

  weekOrder.sort(); // oldest → newest
  return { weekOrder, weekGroups };
}

// ─── Running-total accumulation ───────────────────────────────────────────────

/**
 * One entry per ISO week, oldest → newest, containing the week's summary and the
 * cumulative running-total snapshot after that week is applied.
 *
 * This is the source of truth for the running-total logic rendered in
 * Dashboard.tsx's ETH 30–50 weekly breakdown table.  Extracting it here lets
 * unit tests import and exercise the exact accumulation without re-implementing
 * it in the test file.
 */
export interface Eth30WeekRunningEntry {
  /** ISO Monday key (YYYY-MM-DD) that identifies this week's bucket. */
  weekKey: string;
  /** Ticker rows belonging to this week, in original insertion order. */
  rows: Eth30TickerRow[];
  /** Aggregated summary for this week (gross, net, fees, wins/losses). */
  weekSummary: Eth30WeekSummary;
  /**
   * Cumulative running P&L snapshot after adding this week's contribution.
   *
   * Uses `weekSummary.netPnl` when all fills for the week carry complete fee
   * data (`allFeesIncluded=true`); falls back to `weekSummary.grossPnl`
   * otherwise.  This prevents a silent mix of exact-net and gross-fallback
   * figures in the running total.
   */
  runningNetPnl: number;
  /**
   * True once any week up to and including this one had filled rows whose fee
   * data was incomplete.  Used by Dashboard.tsx to suppress the coloured
   * running-total display when the figure is not a pure net amount.
   */
  runningIsPartial: boolean;
}

/**
 * Compute the per-week running-total sequence for an ETH 30–50 ticker array.
 *
 * Weeks are returned oldest → newest (matching the weekOrder sort).  An empty
 * input returns an empty array — no zero-entry is synthesised.
 *
 * The accumulation rules are:
 *   - Each week contributes `netPnl` when `allFeesIncluded`, else `grossPnl`.
 *   - `runningIsPartial` is latched true when any filled week lacks complete
 *     fee coverage and stays true for all subsequent weeks.
 *   - A week with no fills (all rows have `entryContracts === 0`) contributes
 *     exactly 0 — never undefined or NaN.
 */
export function computeEth30WeeklyRunningTotals(
  tickers: Eth30TickerRow[],
): Eth30WeekRunningEntry[] {
  const { weekOrder, weekGroups } = groupTickersByWeek(tickers);
  let runningNetPnl = 0;
  let runningIsPartial = false;

  return weekOrder.map(weekKey => {
    const rows = weekGroups[weekKey];
    const weekSummary = computeEth30WeekSummary(rows);
    const weekFilled = rows.filter(r => r.entryContracts > 0);

    // Use net when all fees are confirmed; fall back to gross to avoid silently
    // blending exact-net and gross-fallback figures in the cumulative total.
    const verifiedWeekPnl = weekSummary.netPnl ?? weekSummary.grossPnl;
    // An unverified week must never be coerced to $0 or added into a cumulative
    // performance figure. Keep the last verified balance and mark it partial.
    if (verifiedWeekPnl !== null) runningNetPnl += verifiedWeekPnl;

    // Latch: once partial, always partial for the rest of the sequence.
    if ((!weekSummary.allFeesIncluded || verifiedWeekPnl === null) && weekFilled.length > 0) {
      runningIsPartial = true;
    }

    return {
      weekKey,
      rows,
      weekSummary,
      runningNetPnl,
      runningIsPartial,
    };
  });
}
