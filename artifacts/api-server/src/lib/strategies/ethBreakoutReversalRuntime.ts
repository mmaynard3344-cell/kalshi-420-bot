import type { WindowLogEntry } from "../windowLog.js";
import { kalshiFetch } from "../kalshi.js";
import { prepareEth420StatisticalEvidence, type Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthBreakoutReversalOrderIntent } from "./ethBigBetIntent.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { evaluateEthBreakoutReversal } from "./ethBreakoutReversal.js";
import { resolveThreeAdjacentEthSettlements } from "./ethReversalSettlementEvidence.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";

const ETH_15M_MS = 15 * 60_000;
const BREAKOUT_DIRECT_MOVE_RETRY_MS = 5_000;
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

type BreakoutMarketFetcher = typeof kalshiFetch;
let breakoutMarketFetcher: BreakoutMarketFetcher = kalshiFetch;
const directMoveCache = new Map<string, number>();
const directMoveLastAttemptMs = new Map<string, number>();

/** Test-only seam. Production always uses Kalshi's public market API. */
export function _setEthBreakoutMarketFetcherForTesting(fetcher: BreakoutMarketFetcher | null): void {
  breakoutMarketFetcher = fetcher ?? kalshiFetch;
  directMoveCache.clear();
  directMoveLastAttemptMs.clear();
}

function positiveStrike(raw: Record<string, unknown> | null | undefined): number | null {
  if (!raw) return null;
  const value = raw["floor_strike"] ?? raw["cap_strike"];
  const strike = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
    : NaN;
  return Number.isFinite(strike) && strike > 0 ? strike : null;
}

/**
 * Direct authoritative fallback for the exact adjacent 15-minute move when
 * Service D's service-local strike telemetry is stale or absent. This is
 * read-only and fails closed on missing, ambiguous, malformed, or non-adjacent
 * evidence. Successful evidence is immutable for the life of the ticker.
 */
async function readDirectAdjacentMove(market: Eth420CandidateMarket): Promise<number | null> {
  if (!/^KXETH15M-/.test(market.ticker) || !Number.isInteger(market.openTimeMs)) return null;
  const cached = directMoveCache.get(market.ticker);
  if (cached != null) return cached;

  const now = Date.now();
  const lastAttempt = directMoveLastAttemptMs.get(market.ticker) ?? 0;
  if (now - lastAttempt < BREAKOUT_DIRECT_MOVE_RETRY_MS) return null;
  directMoveLastAttemptMs.set(market.ticker, now);

  try {
    const currentResponse = await breakoutMarketFetcher<{ market?: Record<string, unknown> }>(
      `/markets/${market.ticker}`,
    );
    const currentRaw = currentResponse.market;
    const currentOpenMs = typeof currentRaw?.["open_time"] === "string"
      ? Date.parse(currentRaw["open_time"] as string)
      : NaN;
    const currentStrike = positiveStrike(currentRaw);
    if (!Number.isInteger(currentOpenMs) || currentOpenMs !== market.openTimeMs || currentStrike == null) return null;

    const priorOpenMs = currentOpenMs - ETH_15M_MS;
    const priorResponse = await breakoutMarketFetcher<{ markets?: Array<Record<string, unknown>> }>(
      "/markets",
      { series_ticker: "KXETH15M", status: "settled", limit: 100 },
    );
    const exactPrior = (priorResponse.markets ?? []).filter((row) => {
      if (typeof row["ticker"] !== "string" || !/^KXETH15M-/.test(row["ticker"] as string)) return false;
      const openMs = typeof row["open_time"] === "string" ? Date.parse(row["open_time"] as string) : NaN;
      return openMs === priorOpenMs;
    });
    if (exactPrior.length === 0) return null;

    const priorStrikes = new Set<number>();
    for (const row of exactPrior) {
      const strike = positiveStrike(row);
      if (strike != null) priorStrikes.add(strike);
    }
    if (priorStrikes.size !== 1) return null;
    const priorStrike = [...priorStrikes][0]!;
    const move = Math.abs(currentStrike - priorStrike) / priorStrike;
    if (!Number.isFinite(move)) return null;

    directMoveCache.set(market.ticker, move);
    return move;
  } catch {
    return null;
  }
}

/** Test-only direct probe for deterministic fallback evidence rules. */
export async function _readEthBreakoutDirectAdjacentMoveForTesting(
  market: Eth420CandidateMarket,
): Promise<number | null> {
  return readDirectAdjacentMove(market);
}

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

  const currentMove = evidence.currentMove ?? await readDirectAdjacentMove(input.market);
  const signal = evaluateEthBreakoutReversal({
    consecutiveNoOutcomes: streak,
    currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
  });
  input.onEvaluation?.({
    priorOutcomes,
    consecutiveNoOutcomes: streak,
    currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
    upperBandFloor: signal.upperBandFloor,
    rejectionReason: signal.fires ? null : signal.reason,
  });

  return buildEthBreakoutReversalOrderIntent({
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    consecutiveNoOutcomes: streak,
    currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
  });
}
