/**
 * Entry-series policy control.
 *
 * BTC and ETH remain tracked for quotes, evaluations, preflights, settlement,
 * analytics, and research. This module controls only whether a *new* entry may
 * be sent to the exchange for a given ticker.
 *
 * New entries are permanently limited to KXETH15M. Environment configuration
 * is intentionally not consulted: no policy setting may reopen BTC or another
 * legacy strategy.
 *
 * Protective exits, reductions, and hedges bypass this module entirely; they
 * are controlled by protectiveExit.ts and are never gated by entry policy.
 */

export const WEEK_2_PRODUCTION_NEW_ENTRY_SERIES = "KXETH15M" as const;
export const WEEK_2_RESEARCH_AND_TELEMETRY_SERIES = ["KXBTC15M", "KXETH15M"] as const;
export const WEEK_2_ETH_ONLY_ENTRY_SKIP_REASON = "week2_eth_only_new_entries" as const;

/** Compatibility export for status payloads; the only permitted policy is ETH. */
export const ACTIVE_ENTRY_SERIES_POLICY = "eth_only" as const;
export type EntrySeriesPolicy = typeof ACTIVE_ENTRY_SERIES_POLICY;

/**
 * Read the series token exactly rather than using a substring match. A ticker
 * such as KXETH15MTEST-... must not be mistaken for the approved ETH series.
 */
export function seriesTokenFromTicker(ticker: string): string {
  return ticker.split("-", 1)[0] ?? "";
}

/** True only for a well-formed KXETH15M market ticker. */
export function isWeek2ProductionNewEntryTicker(ticker: string): boolean {
  return seriesTokenFromTicker(ticker) === WEEK_2_PRODUCTION_NEW_ENTRY_SERIES;
}

/**
 * Pure inner check — not coupled to the module-level env constant.
 * Call this directly in unit tests to assert behaviour under a specific policy
 * without manipulating `process.env` or reloading the module.
 */
export function _isNewEntryPermittedForPolicy(ticker: string, _policy?: string): boolean {
  // The unused compatibility argument ensures older callers cannot make a
  // configuration value reopen another series.
  return isWeek2ProductionNewEntryTicker(ticker);
}

/**
 * True when the ticker's series is permitted to place a new entry under the
 * the immutable ETH-only policy.
 *
 * This function is **not** used by protective-exit or reduction paths.
 * Those paths are independent of entry policy.
 */
export function isNewEntryPermitted(ticker: string): boolean {
  return _isNewEntryPermittedForPolicy(ticker, ACTIVE_ENTRY_SERIES_POLICY);
}
