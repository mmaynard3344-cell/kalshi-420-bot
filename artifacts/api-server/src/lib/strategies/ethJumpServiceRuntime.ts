import { prepareEth420CandidateDecision, type Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthJumpOrderIntent } from "./ethBigBetIntent.js";
import { currentEthServiceRole, serviceOwnsJump } from "./ethServiceRole.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { kalshiFetch } from "../kalshi.js";

type JumpEvidenceStore = Parameters<typeof prepareEth420CandidateDecision>[0];
const ETH_15M_MS = 15 * 60_000;
const JUMP_DIRECT_MOVE_RETRY_MS = 5_000;

export interface EthJumpEvaluationObservation {
  currentMove: number | null;
  p95: number | null;
  p99: number | null;
  rejectionReason: string | null;
}

type JumpMarketFetcher = typeof kalshiFetch;
let jumpMarketFetcher: JumpMarketFetcher = kalshiFetch;
const directMoveCache = new Map<string, number>();
const directMoveLastAttemptMs = new Map<string, number>();

/** Test-only seam. Production always uses Kalshi's public market API. */
export function _setEthJumpMarketFetcherForTesting(fetcher: JumpMarketFetcher | null): void {
  jumpMarketFetcher = fetcher ?? kalshiFetch;
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
 * Direct authoritative fallback for the one datum Jump cannot safely infer when
 * service-local live telemetry is stale or absent: the adjacent 15-minute move.
 *
 * The current market is read by ticker. The immediately preceding market is
 * selected only by its exact open_time from Kalshi's settled ETH catalog.
 * Successful evidence is immutable for the life of that ticker and cached;
 * unavailable evidence is retried at most once every five seconds.
 */
async function readDirectAdjacentMove(market: Eth420CandidateMarket): Promise<number | null> {
  if (!/^KXETH15M-/.test(market.ticker) || !Number.isInteger(market.openTimeMs)) return null;
  const cached = directMoveCache.get(market.ticker);
  if (cached != null) return cached;

  const now = Date.now();
  const lastAttempt = directMoveLastAttemptMs.get(market.ticker) ?? 0;
  if (now - lastAttempt < JUMP_DIRECT_MOVE_RETRY_MS) return null;
  directMoveLastAttemptMs.set(market.ticker, now);

  try {
    const currentResponse = await jumpMarketFetcher<{ market?: Record<string, unknown> }>(
      `/markets/${market.ticker}`,
    );
    const currentRaw = currentResponse.market;
    const currentOpenMs = typeof currentRaw?.["open_time"] === "string"
      ? Date.parse(currentRaw["open_time"] as string)
      : NaN;
    const currentStrike = positiveStrike(currentRaw);
    if (!Number.isInteger(currentOpenMs) || currentOpenMs !== market.openTimeMs || currentStrike == null) return null;

    const priorOpenMs = currentOpenMs - ETH_15M_MS;
    const priorResponse = await jumpMarketFetcher<{ markets?: Array<Record<string, unknown>> }>(
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

function jumpBandReason(currentMove: number | null, p95: number | null, p99: number | null): string {
  if (![currentMove, p95, p99].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return "unavailable";
  }
  if (currentMove! < p95!) return "below_p95";
  if (currentMove! >= p99!) return "at_or_above_p99";
  return "intent_rejected";
}

/**
 * Service B's read-only signal-preparation seam.
 *
 * It deliberately reuses the existing authoritative rolling-28-day evidence
 * preparation so A and B cannot drift on p95/p99 or carried-side semantics.
 * If that shared evidence path cannot produce the current adjacent move, B
 * obtains only that missing datum directly from Kalshi's current + immediately
 * prior market metadata. B never saves, advances, resets, or settles A state.
 *
 * This function performs no exchange submission and no B-order persistence.
 */
export async function prepareEthJumpServiceIntent(input: {
  store: JumpEvidenceStore;
  market: Eth420CandidateMarket;
  role?: ReturnType<typeof currentEthServiceRole>;
  onEvaluation?: (observation: EthJumpEvaluationObservation) => void;
}): Promise<EthBigBetOrderIntent | null> {
  const role = input.role === undefined ? currentEthServiceRole() : input.role;
  if (!serviceOwnsJump(role)) {
    input.onEvaluation?.({ currentMove: null, p95: null, p99: null, rejectionReason: "service_role_not_jump" });
    return null;
  }
  if (!Number.isInteger(input.market.openTimeMs)) {
    input.onEvaluation?.({ currentMove: null, p95: null, p99: null, rejectionReason: "invalid_open_time" });
    return null;
  }

  const prepared = await prepareEth420CandidateDecision(input.store, input.market);
  if (!prepared) {
    input.onEvaluation?.({ currentMove: null, p95: null, p99: null, rejectionReason: "candidate_decision_unavailable" });
    return null;
  }

  const currentMove = prepared.decision.currentMove ?? await readDirectAdjacentMove(input.market);
  const p95 = prepared.decision.p95;
  const p99 = prepared.decision.p99;

  const intent = buildEthJumpOrderIntent({
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    carriedSide: prepared.state.side,
    currentMove,
    p95,
    p99,
  });

  const rejectionReason = intent
    ? null
    : !/^KXETH15M-/.test(input.market.ticker)
      ? "invalid_ticker"
      : jumpBandReason(currentMove, p95, p99);

  input.onEvaluation?.({
    currentMove,
    p95,
    p99,
    rejectionReason,
  });

  return intent;
}
