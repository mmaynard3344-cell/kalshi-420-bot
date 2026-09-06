import { kalshiAuthFetch } from "../kalshiAuth.js";
import { reconcilePersistedEthBigBetsForTicker } from "./ethBigBetSettlementReconciler.js";
import { listUnresolvedEthBigBetTickers } from "./ethBigBetSettlementStore.js";

interface MarketResponse {
  market?: { result?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

type SweepAuthFetch = <T>(method: string, path: string) => Promise<T>;
type SweepListTickers = (limit?: number) => Promise<string[]>;
type SweepReconcile = (
  ticker: string,
  result: "yes" | "no",
) => Promise<{ settled: number; unresolved: number }>;

export interface EthBigBetAccountingSweepResult {
  tickersChecked: number;
  tickersUnsettled: number;
  settledRows: number;
  unresolvedRows: number;
  errors: number;
}

/**
 * Retry B/C accounting only. No strategy state is read or written, and no
 * future market is blocked by this function. Missing market-result or fill
 * evidence leaves the row unresolved so its capital remains conservatively
 * reserved for a later retry.
 */
export async function sweepUnresolvedEthBigBetAccounting(input: {
  limit?: number;
  authFetch?: SweepAuthFetch;
  listTickers?: SweepListTickers;
  reconcile?: SweepReconcile;
} = {}): Promise<EthBigBetAccountingSweepResult> {
  const limit = input.limit ?? 50;
  const authFetch = input.authFetch ?? (kalshiAuthFetch as unknown as SweepAuthFetch);
  const listTickers = input.listTickers ?? listUnresolvedEthBigBetTickers;
  const reconcile = input.reconcile ?? reconcilePersistedEthBigBetsForTicker;
  const result: EthBigBetAccountingSweepResult = {
    tickersChecked: 0,
    tickersUnsettled: 0,
    settledRows: 0,
    unresolvedRows: 0,
    errors: 0,
  };

  let tickers: string[];
  try {
    tickers = await listTickers(limit);
  } catch {
    result.errors++;
    return result;
  }

  for (const ticker of tickers) {
    result.tickersChecked++;
    let officialResult: "yes" | "no" | null = null;
    try {
      const response = await authFetch<MarketResponse>("GET", `/markets/${encodeURIComponent(ticker)}`);
      const raw = response?.market?.result;
      officialResult = raw === "yes" || raw === "no" ? raw : null;
    } catch {
      result.errors++;
      continue;
    }
    if (!officialResult) {
      result.tickersUnsettled++;
      continue;
    }
    try {
      const reconciled = await reconcile(ticker, officialResult);
      result.settledRows += reconciled.settled;
      result.unresolvedRows += reconciled.unresolved;
    } catch {
      result.errors++;
    }
  }
  return result;
}

let sweepInFlight: Promise<EthBigBetAccountingSweepResult> | null = null;

/** Production single-flight wrapper used by startup + periodic scheduling. */
export function runEthBigBetAccountingSweepSingleFlight(): Promise<EthBigBetAccountingSweepResult> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = sweepUnresolvedEthBigBetAccounting()
    .finally(() => { sweepInFlight = null; });
  return sweepInFlight;
}
