import type { WindowResult } from "./analytics.js";
import type { WindowAnalytics } from "./analytics.js";

export type DashboardWindowOutcome =
  | "traded"
  | "zero_fill"
  | "skipped"
  | "out_of_zone"
  | "pending";

/**
 * Converts authoritative per-ticker analytics into the presentation status
 * used by the Dashboard's Window Log.
 *
 * The raw window log retains market/timing context, but can become stale when
 * a callback arrives after its active in-memory window has rolled over.
 */
export function dashboardOutcomeFromAnalytics(result: WindowResult): DashboardWindowOutcome {
  switch (result) {
    case "filled":
    case "partial_fill":
      return "traded";
    case "zero_fill_only":
      return "zero_fill";
    case "no_submission":
      return "skipped";
    case "outside_zone":
      return "out_of_zone";
    case "blocked":
    case "pending":
      return "pending";
  }
}

/**
 * Adds authoritative analytics to a raw Window Log entry without replacing its
 * observed market context (timestamps, zone state, and BBO fields).
 */
export function mergeDashboardWindow<T extends { outcome: string }>(
  entry: T,
  analytics: WindowAnalytics | undefined,
) {
  return {
    ...entry,
    outcome:                 analytics ? dashboardOutcomeFromAnalytics(analytics.result) : entry.outcome,
    submittedOrders:         analytics?.submittedOrders         ?? 0,
    zeroFills:               analytics?.zeroFills               ?? 0,
    partialFills:            analytics?.partialFills            ?? 0,
    fullFills:               analytics?.fullFills               ?? 0,
    attemptNumberThatFilled: analytics?.attemptNumberThatFilled ?? null,
    totalSpendDollars:       analytics?.totalSpendDollars       ?? 0,
    totalFeesDollars:        analytics?.totalFeesDollars        ?? 0,
    attempts:                analytics?.attempts                ?? [],
    analyticsResult:         analytics?.result                  ?? null,
  };
}