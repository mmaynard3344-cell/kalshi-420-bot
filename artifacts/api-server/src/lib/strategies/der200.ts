import { isTrueEth15MinuteAdjacency, percentile } from "./eth420SixStepCandidate.js";

export const DER200_MIN_HISTORY = 200;
export const DER200_PERCENTILE = 0.97;
export const DER200_SIDE = "yes" as const;
export const DER200_CONTRACTS = 1;
export const DER200_LIMIT_PRICE_CENTS = 50;

export interface Der200FloorFact {
  ticker: string;
  openTimeMs: number;
  floorStrike: number | null;
}

export interface Der200Decision {
  strategy: "DER200";
  ticker: string;
  validHistoricalMoves: number;
  thresholdP97: number | null;
  currentDownMove: number | null;
  qualifies: boolean;
  reason:
    | "insufficient_history"
    | "invalid_current_adjacency"
    | "not_downward"
    | "below_p97"
    | "qualified";
  orderIntent: {
    side: typeof DER200_SIDE;
    contracts: typeof DER200_CONTRACTS;
    limitPriceCents: typeof DER200_LIMIT_PRICE_CENTS;
    timeInForce: "good_till_canceled";
  } | null;
}

function validFact(fact: Der200FloorFact): boolean {
  return Number.isInteger(fact.openTimeMs)
    && fact.openTimeMs % (15 * 60_000) === 0
    && Number.isFinite(fact.floorStrike)
    && (fact.floorStrike ?? 0) > 0;
}

export function der200HistoricalAbsoluteMoves(
  facts: readonly Der200FloorFact[],
  currentOpenTimeMs: number,
): number[] {
  const eligible = facts
    .filter((fact) => validFact(fact) && fact.openTimeMs < currentOpenTimeMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  const byOpen = new Map(eligible.map((fact) => [fact.openTimeMs, fact]));
  const moves: Array<{ openTimeMs: number; move: number }> = [];
  for (const fact of eligible) {
    const prior = byOpen.get(fact.openTimeMs - 15 * 60_000);
    if (!prior || !isTrueEth15MinuteAdjacency(fact.openTimeMs, prior.openTimeMs)) continue;
    const move = Math.abs(fact.floorStrike! - prior.floorStrike!) / prior.floorStrike!;
    if (Number.isFinite(move) && move >= 0) moves.push({ openTimeMs: fact.openTimeMs, move });
  }
  return moves.slice(-DER200_MIN_HISTORY).map((entry) => entry.move);
}

export function evaluateDer200(params: {
  ticker: string;
  currentOpenTimeMs: number;
  currentFloorStrike: number | null;
  priorOpenTimeMs: number | null;
  priorFloorStrike: number | null;
  historyFacts: readonly Der200FloorFact[];
}): Der200Decision {
  const history = der200HistoricalAbsoluteMoves(params.historyFacts, params.currentOpenTimeMs);
  if (history.length < DER200_MIN_HISTORY) {
    return {
      strategy: "DER200", ticker: params.ticker, validHistoricalMoves: history.length,
      thresholdP97: null, currentDownMove: null, qualifies: false,
      reason: "insufficient_history", orderIntent: null,
    };
  }

  const thresholdP97 = percentile([...history].sort((a, b) => a - b), DER200_PERCENTILE);
  const currentValid = Number.isFinite(params.currentFloorStrike)
    && (params.currentFloorStrike ?? 0) > 0
    && Number.isFinite(params.priorFloorStrike)
    && (params.priorFloorStrike ?? 0) > 0
    && isTrueEth15MinuteAdjacency(params.currentOpenTimeMs, params.priorOpenTimeMs);

  if (!currentValid || thresholdP97 == null) {
    return {
      strategy: "DER200", ticker: params.ticker, validHistoricalMoves: history.length,
      thresholdP97, currentDownMove: null, qualifies: false,
      reason: "invalid_current_adjacency", orderIntent: null,
    };
  }

  const currentDownMove = (params.priorFloorStrike! - params.currentFloorStrike!) / params.priorFloorStrike!;
  if (!(currentDownMove > 0)) {
    return {
      strategy: "DER200", ticker: params.ticker, validHistoricalMoves: history.length,
      thresholdP97, currentDownMove, qualifies: false,
      reason: "not_downward", orderIntent: null,
    };
  }

  const qualifies = currentDownMove >= thresholdP97;
  return {
    strategy: "DER200", ticker: params.ticker, validHistoricalMoves: history.length,
    thresholdP97, currentDownMove, qualifies,
    reason: qualifies ? "qualified" : "below_p97",
    orderIntent: qualifies ? {
      side: DER200_SIDE,
      contracts: DER200_CONTRACTS,
      limitPriceCents: DER200_LIMIT_PRICE_CENTS,
      timeInForce: "good_till_canceled",
    } : null,
  };
}
