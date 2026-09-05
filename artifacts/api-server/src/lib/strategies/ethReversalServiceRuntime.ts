import type { WindowLogEntry } from "../windowLog.js";
import { prepareEth420StatisticalEvidence, type Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthReversalOrderIntent } from "./ethBigBetIntent.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";

const ETH_15M_MS = 15 * 60_000;
type StatisticalEvidenceStore = Parameters<typeof prepareEth420StatisticalEvidence>[0];

/**
 * Proves the minimum 3-NO condition from durable authoritative window results.
 * The immediately preceding ETH windows close at T, T-15m, and T-30m when the
 * candidate market opens at T. Missing or conflicting evidence fails closed.
 */
export function proveThreeAdjacentNoSettlements(
  entries: readonly WindowLogEntry[],
  currentOpenTimeMs: number,
): 3 | null {
  if (!Number.isInteger(currentOpenTimeMs) || currentOpenTimeMs % ETH_15M_MS !== 0) return null;
  const byClose = new Map<number, "yes" | "no" | "conflict">();
  for (const entry of entries) {
    if (entry.series !== "KXETH15M" || !entry.closeTime) continue;
    const closeMs = Date.parse(entry.closeTime);
    if (!Number.isInteger(closeMs) || closeMs % ETH_15M_MS !== 0) continue;
    const result = entry.settlementResult;
    if (result !== "yes" && result !== "no") continue;
    const prior = byClose.get(closeMs);
    byClose.set(closeMs, prior != null && prior !== result ? "conflict" : result);
  }
  for (let offset = 0; offset < 3; offset++) {
    if (byClose.get(currentOpenTimeMs - offset * ETH_15M_MS) !== "no") return null;
  }
  return 3;
}

/**
 * Service C is independent of A's martingale state. It combines only:
 *  - three exact adjacent authoritative NO settlements; and
 *  - the same read-only 28-day p95/p99 statistical evidence used by A/B.
 * It performs no persistence and no exchange submission.
 */
export async function prepareEthReversalServiceIntent(input: {
  store: StatisticalEvidenceStore;
  market: Eth420CandidateMarket;
  windowEntries: readonly WindowLogEntry[];
  role?: ReturnType<typeof currentEthServiceRole>;
}): Promise<EthBigBetOrderIntent | null> {
  const role = input.role === undefined ? currentEthServiceRole() : input.role;
  if (!serviceOwnsReversal(role) || !Number.isInteger(input.market.openTimeMs)) return null;
  const streak = proveThreeAdjacentNoSettlements(input.windowEntries, input.market.openTimeMs!);
  if (streak == null) return null;
  const evidence = await prepareEth420StatisticalEvidence(input.store, input.market);
  if (!evidence) return null;
  return buildEthReversalOrderIntent({
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    consecutiveNoOutcomes: streak,
    currentMove: evidence.currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
  });
}
