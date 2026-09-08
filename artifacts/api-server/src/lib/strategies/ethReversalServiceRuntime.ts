import type { WindowLogEntry } from "../windowLog.js";
import { kalshiFetch } from "../kalshi.js";
import { prepareEth420StatisticalEvidence, type Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthReversalOrderIntent } from "./ethBigBetIntent.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { evaluateEthNoStreakReversal } from "./ethNoStreakReversal.js";
import { resolveThreeAdjacentEthSettlements } from "./ethReversalSettlementEvidence.js";
import { currentEthServiceRole, serviceOwnsReversal } from "./ethServiceRole.js";

const ETH_15M_MS = 15 * 60_000;
const REVERSAL_DIRECT_MOVE_RETRY_MS = 5_000;
type StatisticalEvidenceStore = Parameters<typeof prepareEth420StatisticalEvidence>[0];

type ReversalEvaluationContext = {
  priorOutcomes: Array<"yes" | "no" | "missing_or_conflict">;
  consecutiveNoOutcomes: number | null;
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
  rejectionReason: string | null;
};

type ReversalMarketFetcher = typeof kalshiFetch;
let reversalMarketFetcher: ReversalMarketFetcher = kalshiFetch;
const directMoveCache = new Map<string, number>();
const directMoveLastAttemptMs = new Map<string, number>();

/** Test-only seam. Production always uses Kalshi's public market API. */
export function _setEthReversalMarketFetcherForTesting(fetcher: ReversalMarketFetcher | null): void {
  reversalMarketFetcher = fetcher ?? kalshiFetch;
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
 * Direct authoritative fallback for the one datum Service C cannot safely infer
 * when its service-local strike telemetry is stale or absent: the exact
 * adjacent 15-minute move. It mirrors Service B's proven fallback and remains
 * read-only. Missing, ambiguous, non-adjacent, or malformed evidence fails
 * closed. Successful evidence is immutable for the life of the ticker.
 */
async function readDirectAdjacentMove(market: Eth420CandidateMarket): Promise<number | null> {
  if (!/^KXETH15M-/.test(market.ticker) || !Number.isInteger(market.openTimeMs)) return null;
  const cached = directMoveCache.get(market.ticker);
  if (cached != null) return cached;

  const now = Date.now();
  const lastAttempt = directMoveLastAttemptMs.get(market.ticker) ?? 0;
  if (now - lastAttempt < REVERSAL_DIRECT_MOVE_RETRY_MS) return null;
  directMoveLastAttemptMs.set(market.ticker, now);

  try {
    const currentResponse = await reversalMarketFetcher<{ market?: Record<string, unknown> }>(
      `/markets/${market.ticker}`,
    );
    const currentRaw = currentResponse.market;
    const currentOpenMs = typeof currentRaw?.["open_time"] === "string"
      ? Date.parse(currentRaw["open_time"] as string)
      : NaN;
    const currentStrike = positiveStrike(currentRaw);
    if (!Number.isInteger(currentOpenMs) || currentOpenMs !== market.openTimeMs || currentStrike == null) return null;

    const priorOpenMs = currentOpenMs - ETH_15M_MS;
    const priorResponse = await reversalMarketFetcher<{ markets?: Array<Record<string, unknown>> }>(
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

/** Test-only direct probe for the fallback's deterministic evidence rules. */
export async function _readEthReversalDirectAdjacentMoveForTesting(
  market: Eth420CandidateMarket,
): Promise<number | null> {
  return readDirectAdjacentMove(market);
}

/**
 * Proves the minimum 3-NO condition from durable authoritative window results.
 * The immediately preceding ETH windows close at T, T-15m, and T-30m when the
 * candidate market opens at T. Missing or conflicting evidence fails closed.
 *
 * This pure helper remains for deterministic tests. Live Service C evaluation
 * resolves the same three outcomes from durable market_results immediately
 * before applying this condition, so process-local window state cannot go stale.
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
  if (!serviceOwnsReversal(role)) {
    input.onEvaluation?.({
      priorOutcomes: ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"],
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
      priorOutcomes: ["missing_or_conflict", "missing_or_conflict", "missing_or_conflict"],
      consecutiveNoOutcomes: null,
      currentMove: null,
      p95: null,
      p99: null,
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
  const currentMove = evidence.currentMove ?? await readDirectAdjacentMove(input.market);
  const signal = evaluateEthNoStreakReversal({
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
    rejectionReason: signal.fires ? null : signal.reason,
  });
  return buildEthReversalOrderIntent({
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    consecutiveNoOutcomes: streak,
    currentMove,
    p95: evidence.p95,
    p99: evidence.p99,
  });
}
