import { logger } from "../logger.js";
import {
  fetchCompleteEth15mSettledHistory,
  KALSHI_ETH_15M_INTERVAL_MS,
  type KalshiEth15mHistoricalFact,
} from "../kalshi.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetExecutionStore } from "./ethBigBetExecutionStoreAdapter.js";
import { claimDer200Market, initEthBigBetStore } from "./ethBigBetStore.js";
import { ethBigBetCapitalRiskCents, type EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";
import { evaluateEthAccountCapital } from "./ethAccountCapitalGuard.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";

export const DER200_MIN_HISTORY = 200;
export const DER200_PERCENTILE = 0.97;
export const DER200_SIDE = "yes" as const;
export const DER200_WAGER_CENTS = 50;
export const DER200_LIMIT_PRICE_CENTS = 50;
export const DER200_ORDER_TAG = "DER200";

export interface Der200Decision {
  ticker: string;
  validHistoricalMoves: number;
  thresholdP97: number | null;
  currentDownMove: number | null;
  qualifies: boolean;
  reason:
    | "insufficient_history"
    | "missing_exact_predecessor"
    | "invalid_current_market"
    | "not_downward"
    | "below_p97"
    | "qualified";
}

export type Der200Route = "regular" | "der200" | "hold";

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high
    ? sorted[low]!
    : sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

export function der200HistoricalAbsoluteMoves(
  facts: readonly KalshiEth15mHistoricalFact[],
  currentOpenTimeMs: number,
): number[] {
  const eligible = facts
    .filter((fact) =>
      Number.isInteger(fact.openTimeMs)
      && fact.openTimeMs < currentOpenTimeMs
      && Number.isFinite(fact.floorStrike)
      && fact.floorStrike > 0
    )
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  const byOpen = new Map(eligible.map((fact) => [fact.openTimeMs, fact]));
  const moves: number[] = [];
  for (const fact of eligible) {
    const prior = byOpen.get(fact.openTimeMs - KALSHI_ETH_15M_INTERVAL_MS);
    if (!prior) continue;
    const move = Math.abs(fact.floorStrike - prior.floorStrike) / prior.floorStrike;
    if (Number.isFinite(move) && move >= 0) moves.push(move);
  }
  return moves.slice(-DER200_MIN_HISTORY);
}

export function evaluateDer200(input: {
  ticker: string;
  currentOpenTimeMs: number;
  currentFloorStrike: number | null;
  historyFacts: readonly KalshiEth15mHistoricalFact[];
}): Der200Decision {
  if (!/^KXETH15M-/.test(input.ticker)
    || !Number.isInteger(input.currentOpenTimeMs)
    || input.currentOpenTimeMs % KALSHI_ETH_15M_INTERVAL_MS !== 0
    || !Number.isFinite(input.currentFloorStrike)
    || (input.currentFloorStrike ?? 0) <= 0) {
    return {
      ticker: input.ticker, validHistoricalMoves: 0, thresholdP97: null,
      currentDownMove: null, qualifies: false, reason: "invalid_current_market",
    };
  }

  const prior = input.historyFacts.find(
    (fact) => fact.openTimeMs === input.currentOpenTimeMs - KALSHI_ETH_15M_INTERVAL_MS,
  ) ?? null;
  if (!prior) {
    return {
      ticker: input.ticker, validHistoricalMoves: 0, thresholdP97: null,
      currentDownMove: null, qualifies: false, reason: "missing_exact_predecessor",
    };
  }

  const history = der200HistoricalAbsoluteMoves(input.historyFacts, input.currentOpenTimeMs);
  if (history.length < DER200_MIN_HISTORY) {
    return {
      ticker: input.ticker, validHistoricalMoves: history.length, thresholdP97: null,
      currentDownMove: null, qualifies: false, reason: "insufficient_history",
    };
  }

  const thresholdP97 = percentile([...history].sort((a, b) => a - b), DER200_PERCENTILE);
  const currentDownMove = (prior.floorStrike - input.currentFloorStrike!) / prior.floorStrike;
  if (!(currentDownMove > 0)) {
    return {
      ticker: input.ticker, validHistoricalMoves: history.length, thresholdP97,
      currentDownMove, qualifies: false, reason: "not_downward",
    };
  }
  const qualifies = thresholdP97 != null && currentDownMove >= thresholdP97;
  return {
    ticker: input.ticker, validHistoricalMoves: history.length, thresholdP97,
    currentDownMove, qualifies, reason: qualifies ? "qualified" : "below_p97",
  };
}

let storeReady: Promise<void> | null = null;
let historyCacheOpenMs: number | null = null;
let historyCacheFacts: KalshiEth15mHistoricalFact[] | null = null;
let historyLastFetchMs = 0;
const HISTORY_REFETCH_MS = 5_000;

async function ensureStoreReady(): Promise<void> {
  storeReady ??= initEthBigBetStore();
  return storeReady;
}

async function loadHistory(currentOpenTimeMs: number): Promise<KalshiEth15mHistoricalFact[] | null> {
  const hasExactPredecessor = historyCacheOpenMs === currentOpenTimeMs
    && historyCacheFacts?.some((fact) =>
      fact.openTimeMs === currentOpenTimeMs - KALSHI_ETH_15M_INTERVAL_MS) === true;
  if (hasExactPredecessor) return historyCacheFacts;

  const now = Date.now();
  if (historyCacheOpenMs === currentOpenTimeMs
    && historyCacheFacts != null
    && now - historyLastFetchMs < HISTORY_REFETCH_MS) {
    return historyCacheFacts;
  }
  historyLastFetchMs = now;
  const fetched = await fetchCompleteEth15mSettledHistory(currentOpenTimeMs);
  if (fetched) {
    historyCacheOpenMs = currentOpenTimeMs;
    historyCacheFacts = fetched;
  }
  return fetched;
}

export function isDer200ExecutionPermitted(
  rawRole: string | undefined = process.env["ETH_SERVICE_ROLE"],
): boolean {
  const roleAllowed = rawRole == null || rawRole === "martingale";
  return roleAllowed && process.env["DER200_LIVE_ENABLED"] === "true";
}

export async function routeDer200WhenExplicitlyEnabled(input: {
  ticker: string;
  exchangeIndex: number | null;
  openTime: string | null;
  closeTime: string | null;
  status: string | null;
  floorStrike: number | null;
}): Promise<Der200Route> {
  if (!isDer200ExecutionPermitted()) return "regular";
  const openTimeMs = input.openTime == null ? NaN : Date.parse(input.openTime);
  if (!Number.isInteger(openTimeMs)
    || openTimeMs % KALSHI_ETH_15M_INTERVAL_MS !== 0
    || input.status?.toLowerCase() !== "open"
    || input.exchangeIndex == null
    || !Number.isInteger(input.exchangeIndex)
    || input.exchangeIndex < 0) {
    logger.warn({ ticker: input.ticker }, "DER200 holding ETH window: market identity/routing unavailable");
    return "hold";
  }

  const facts = await loadHistory(openTimeMs);
  if (!facts) {
    logger.warn({ ticker: input.ticker }, "DER200 holding ETH window: complete history unavailable");
    return "hold";
  }
  const decision = evaluateDer200({
    ticker: input.ticker,
    currentOpenTimeMs: openTimeMs,
    currentFloorStrike: input.floorStrike,
    historyFacts: facts,
  });
  logger.info({
    ticker: input.ticker,
    validHistoricalMoves: decision.validHistoricalMoves,
    thresholdP97: decision.thresholdP97,
    currentDownMove: decision.currentDownMove,
    qualifies: decision.qualifies,
    reason: decision.reason,
  }, "DER200 evaluation");

  if (decision.reason === "missing_exact_predecessor" || decision.reason === "invalid_current_market") {
    return "hold";
  }
  if (!decision.qualifies) return "regular";

  const intent: EthBigBetOrderIntent = {
    strategy: "der200",
    orderTag: DER200_ORDER_TAG,
    ticker: input.ticker,
    side: DER200_SIDE,
    wagerCents: DER200_WAGER_CENTS,
    limitPriceCents: DER200_LIMIT_PRICE_CENTS,
    marketOpenTimeMs: openTimeMs,
  };

  try {
    await ensureStoreReady();
  } catch {
    logger.error({ ticker: input.ticker }, "DER200 qualified but storage is unavailable");
    return "der200";
  }

  const claimed = await claimDer200Market(input.ticker);
  if (!claimed) {
    logger.info({ ticker: input.ticker }, "DER200 qualified but market is already owned by A/B/C/Back Flip");
    return "der200";
  }

  const capitalBase = await readApprovedEthBigBetCapitalBase(input.exchangeIndex);
  if (!capitalBase) {
    logger.warn({ ticker: input.ticker }, "DER200 qualified but fresh capital evidence is unavailable");
    return "der200";
  }
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  const capital = evaluateEthAccountCapital({ ...capitalBase, requestedRiskCents });
  if (!capital.allowed) {
    logger.warn({ ticker: input.ticker, reason: capital.reason }, "DER200 qualified but capital guard blocked entry");
    return "der200";
  }
  const exchange = createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) {
    logger.warn({ ticker: input.ticker }, "DER200 qualified but exchange route is unavailable");
    return "der200";
  }

  const outcome = await submitEthBigBetIntent({
    intent,
    store: ethBigBetExecutionStore,
    exchange,
    capital: capitalBase,
    requestedRiskCents,
  });
  logger.info({ ticker: input.ticker, outcome }, "DER200 live submission result");
  return "der200";
}
