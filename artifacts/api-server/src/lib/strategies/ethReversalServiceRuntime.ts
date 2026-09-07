import type { WindowLogEntry } from "../windowLog.js";
import { prepareEth420StatisticalEvidence, type Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthReversalOrderIntent } from "./ethBigBetIntent.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { evaluateEthNoStreakReversal } from "./ethNoStreakReversal.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";

const ETH_15M_MS = 15 * 60_000;
type StatisticalEvidenceStore = Parameters<typeof prepareEth420StatisticalEvidence>[0];

type ReversalEvaluationContext = {
  priorOutcomes: Array<"yes" | "no" | "missing_or_conflict">;
  consecutiveNoOutcomes: number | null;
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
  rejectionReason: string | null;
};

function readThreeAdjacentSettlementOutcomes(
  entries: readonly WindowLogEntry[],
  currentOpenTimeMs: number,
): Array<"yes" | "no" | "missing_or_conflict"> {
  if (!Number.isInteger(currentOpenTimeMs) || currentOpenTimeMs % ETH_15M_MS !== 0) {
    return ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"];
  }
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
  return [0, 1, 2].map((offset) => {
    const value = byClose.get(currentOpenTimeMs - offset * ETH_15M_MS);
    return value === "yes" || value === "no" ? value : "missing_or_conflict";
  });
}

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
  onEvaluation?: (context: ReversalEvaluationContext) => void;
}): Promise<EthBigBetOrderIntent | null> {
  const role = input.role === undefined ? currentEthServiceRole() : input.role;
  const priorOutcomes = readThreeAdjacentSettlementOutcomes(
    input.windowEntries,
    input.market.openTimeMs ?? Number.NaN,
  );
  if (!serviceOwnsReversal(role)) {
    input.onEvaluation?.({
      priorOutcomes,
      consecutiveNoOutcomes: null,
      currentMove: null,
      p95: null,
      p99: null,
      rejectionReason: "service_role_not_reversal",
    });
    return null;
  }
  if (!Number.isInteger(input.market.openTimeMs)) {
    input.onEvaluation?.({
      priorOutcomes,
      consecutiveNoOutcomes: null,
      currentMove: null,
      p95: null,
      p99: null,
      rejectionReason: "invalid_market_open_time",
    });
    return null;
  }
  const streak = proveThreeAdjacentNoSettlements(input.windowEntries, input.market.openTimeMs!);
  if (streak == null) {
    input.onEvaluation?.({
      priorOutcomes,
      consecutiveNoOutcomes: null,
      currentMove: null,
      p95: null,
      p99: null,
      rejectionReason: "three_adjacent_no_not_proven",
    });
    return null;
  }
  const evidence = await prepareEth420StatisticalEvidence(input.store, input.market);
  if (!evidence) {
    input.onEvaluation?.({
      priorOutcomes,
      consecutiveNoOutcomes: streak,
      currentMove: null,
      p95: null,
      p99: null,
      rejectionReason: "statistical_evidence_unavailable",
    });
    return null;
  }
  const signal = evaluateEthNoStreakReversal({
    consecutiveNoOutcomes: streak,
    currentMove: evidence.currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
  });
  input.onEvaluation?.({
    priorOutcomes,
    consecutiveNoOutcomes: streak,
    currentMove: evidence.currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
    rejectionReason: signal.fires ? null : signal.reason,
  });
  return buildEthReversalOrderIntent({
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    consecutiveNoOutcomes: streak,
    currentMove: evidence.currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
  });
}
