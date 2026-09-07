import type { WindowLogEntry } from "../windowLog.js";
import { prepareEth420StatisticalEvidence, type Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthBreakoutReversalOrderIntent } from "./ethBigBetIntent.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { evaluateEthBreakoutReversal } from "./ethBreakoutReversal.js";
import { resolveThreeAdjacentEthSettlements } from "./ethReversalSettlementEvidence.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";

type StatisticalEvidenceStore = Parameters<typeof prepareEth420StatisticalEvidence>[0];

type BreakoutReversalEvaluationContext = {
  priorOutcomes: Array<"yes" | "no" | "missing_or_conflict">;
  consecutiveNoOutcomes: number | null;
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
  upperBandFloor: number | null;
  rejectionReason: string | null;
};

/**
 * Service D is independent of A/B/C strategy state. It combines only:
 *  - the exact three immediately preceding authoritative NO settlements; and
 *  - the same read-only rolling 28-day p95/p99 evidence; and
 *  - the upper half of that p95-to-p99 band.
 * It performs no persistence and no exchange submission.
 *
 * The isolated Railway Service D branch intentionally reuses the existing
 * fail-closed "reversal" process role so it cannot accidentally run martingale
 * or Jump logic. Its distinct live flag and order tag provide independent
 * execution ownership.
 */
export async function prepareEthBreakoutReversalServiceIntent(input: {
  store: StatisticalEvidenceStore;
  market: Eth420CandidateMarket;
  windowEntries: readonly WindowLogEntry[];
  role?: ReturnType<typeof currentEthServiceRole>;
  onEvaluation?: (context: BreakoutReversalEvaluationContext) => void;
}): Promise<EthBigBetOrderIntent | null> {
  const role = input.role === undefined ? currentEthServiceRole() : input.role;
  if (!serviceOwnsReversal(role)) {
    input.onEvaluation?.({
      priorOutcomes: ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"],
      consecutiveNoOutcomes: null,
      currentMove: null,
      p95: null,
      p99: null,
      upperBandFloor: null,
      rejectionReason: "service_role_not_reversal",
    });
    return null;
  }
  if (!Number.isInteger(input.market.openTimeMs)) {
    input.onEvaluation?.({
      priorOutcomes: ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"],
      consecutiveNoOutcomes: null,
      currentMove: null,
      p95: null,
      p99: null,
      upperBandFloor: null,
      rejectionReason: "invalid_market_open_time",
    });
    return null;
  }

  const priorOutcomes = await resolveThreeAdjacentEthSettlements(
    input.windowEntries,
    input.market.openTimeMs!,
  );
  const streak = priorOutcomes.every((result) => result === "no") ? 3 : null;
  if (streak == null) {
    input.onEvaluation?.({
      priorOutcomes,
      consecutiveNoOutcomes: null,
      currentMove: null,
      p95: null,
      p99: null,
      upperBandFloor: null,
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
      upperBandFloor: null,
      rejectionReason: "statistical_evidence_unavailable",
    });
    return null;
  }

  const signal = evaluateEthBreakoutReversal({
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
    upperBandFloor: signal.upperBandFloor,
    rejectionReason: signal.fires ? null : signal.reason,
  });

  return buildEthBreakoutReversalOrderIntent({
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    consecutiveNoOutcomes: streak,
    currentMove: evidence.currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
  });
}
