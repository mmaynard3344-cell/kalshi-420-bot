/**
 * targetLiquidityPoller.ts
 *
 * Standalone polling loop for the ETH/SOL 30–50 target-liquidity endpoints.
 * Extracted from Dashboard.tsx so it can be tested with injected dependencies
 * (fetch and setTimeout) without a DOM or React runtime.
 *
 * Key design decisions:
 *   - The initial fetch is AWAITED before schedule() runs so the ref is current
 *     and the first timeout always uses the correct interval.
 *   - On a failed fetch the hasOpen state is preserved (not downgraded) so a
 *     transient API error does not push an open panel back to the 30 s cadence.
 */

export const TARGET_LIQUIDITY_FAST_INTERVAL_MS   = 15_000;
export const TARGET_LIQUIDITY_NORMAL_INTERVAL_MS = 30_000;

// Minimal shape needed to determine whether a position is actively open.
export interface TLPosition {
  openContracts: number;
  classification: string;
}

export interface TLReport {
  positions: TLPosition[];
  [key: string]: unknown;
}

/** True when the report contains at least one actively open (unfilled) position. */
export function reportHasOpen(report: TLReport | null): boolean {
  return (
    report?.positions.some(
      (p) => p.openContracts > 0 && p.classification !== 'target_filled',
    ) ?? false
  );
}

export interface TargetLiquidityPollerDeps {
  /** A fetch-compatible function — use the real `fetch` in production, a mock in tests. */
  fetchFn: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  /** A setTimeout-compatible function — use the real one in production, a spy in tests. */
  scheduleTimeout: (callback: () => void, delay: number) => unknown;
  /** Called whenever a fresh ETH 30–50 report is successfully parsed. */
  onEth30: (report: TLReport) => void;
  /** Called whenever a fresh SOL 30–50 report is successfully parsed. */
  onSol30: (report: TLReport) => void;
  /** Called after each fetch completes (success or failure) — used by tests to
   *  inspect the interval that was selected for the next timeout. */
  onScheduled?: (intervalMs: number) => void;
}

/**
 * Starts the target-liquidity polling loop.
 *
 * @returns A cleanup function that stops the loop (call from useEffect cleanup).
 */
export function startTargetLiquidityLoop(deps: TargetLiquidityPollerDeps): () => void {
  let alive = true;
  // Open-state is tracked per strategy so that a transient HTTP failure from
  // one endpoint does not downgrade that endpoint's prior open-state to false
  // and thereby push the combined interval back to 30 s.
  // Each flag is updated only when that endpoint successfully returns and parses
  // a new report; it is never reset by a failed or not-ok response.
  let hasOpenEth30 = false;
  let hasOpenSol30 = false;

  const doFetch = async (): Promise<void> => {
    try {
      const [eth30Res, sol30Res] = await Promise.all([
        deps.fetchFn('/api/trade/analytics/reports/eth30-50/target-liquidity', { cache: 'no-store' }),
        deps.fetchFn('/api/trade/analytics/reports/sol30-50/target-liquidity', { cache: 'no-store' }),
      ]);

      // Parse and update each strategy independently — a not-ok response from
      // one endpoint leaves that endpoint's prior open-state unchanged.
      if (eth30Res.ok) {
        const eth30 = (await eth30Res.json()) as TLReport;
        hasOpenEth30 = reportHasOpen(eth30);
        if (alive) deps.onEth30(eth30);
      }
      if (sol30Res.ok) {
        const sol30 = (await sol30Res.json()) as TLReport;
        hasOpenSol30 = reportHasOpen(sol30);
        if (alive) deps.onSol30(sol30);
      }
    } catch {
      // Swallow — non-critical.
      // Both per-strategy flags are intentionally preserved on a thrown error
      // so a transient network failure cannot downgrade an open panel to 30 s.
    }
  };

  const schedule = (): void => {
    const intervalMs = (hasOpenEth30 || hasOpenSol30)
      ? TARGET_LIQUIDITY_FAST_INTERVAL_MS
      : TARGET_LIQUIDITY_NORMAL_INTERVAL_MS;
    deps.onScheduled?.(intervalMs);
    deps.scheduleTimeout(async () => {
      await doFetch();
      if (alive) schedule();
    }, intervalMs);
  };

  // Await the initial fetch so hasOpen is correct before schedule() runs.
  // This is the critical fix: schedule() must not fire until the first fetch
  // has completed and updated hasOpen.
  void (async () => {
    await doFetch();
    if (alive) schedule();
  })();

  return () => {
    alive = false;
  };
}
