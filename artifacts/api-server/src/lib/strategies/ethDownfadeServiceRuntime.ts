import { fetchCompleteEth15mSettledHistory, kalshiFetch, type KalshiEth15mHistoricalFact } from "../kalshi.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthDownfadeIntent, ETH_DOWNFADE_CONFIG, type EthDownfadeEvidence, type EthDownfadeRole } from "./ethDownfadeSignal.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

const ETH_15M_MS = 15 * 60_000;
const HISTORY_MS = 28 * 86_400_000;
const MIN_HISTORY = 50;
const DIRECT_RETRY_MS = 5_000;
const PROBE_START_MS = 10 * 60_000;

let historicalFacts: KalshiEth15mHistoricalFact[] | null = null;
let historyLoad: Promise<KalshiEth15mHistoricalFact[] | null> | null = null;
const directAttemptMs = new Map<string, number>();

type MarketFetcher = typeof kalshiFetch;
let marketFetcher: MarketFetcher = kalshiFetch;

export function _resetEthDownfadeEvidenceForTesting(): void {
  historicalFacts = null;
  historyLoad = null;
  directAttemptMs.clear();
  marketFetcher = kalshiFetch;
}

export function _setEthDownfadeMarketFetcherForTesting(fetcher: MarketFetcher | null): void {
  marketFetcher = fetcher ?? kalshiFetch;
  directAttemptMs.clear();
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return low === high ? sorted[low]! : sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

function positiveStrike(raw: Record<string, unknown> | null | undefined): number | null {
  if (!raw) return null;
  const value = raw["floor_strike"] ?? raw["cap_strike"];
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function quoteCents(dollarValue: unknown, centValue: unknown): number | null {
  const dollars = typeof dollarValue === "number" ? dollarValue
    : typeof dollarValue === "string" && dollarValue.trim() !== "" ? Number(dollarValue) : NaN;
  if (Number.isFinite(dollars) && dollars >= 0 && dollars <= 1) return Math.round(dollars * 100);
  const cents = typeof centValue === "number" ? centValue
    : typeof centValue === "string" && centValue.trim() !== "" ? Number(centValue) : NaN;
  if (!Number.isFinite(cents) || cents < 0) return null;
  const normalized = cents <= 1 ? Math.round(cents * 100) : Math.round(cents);
  return normalized >= 0 && normalized <= 100 ? normalized : null;
}

async function ensureHistory(currentOpenTimeMs: number): Promise<KalshiEth15mHistoricalFact[] | null> {
  if (historicalFacts) return historicalFacts;
  historyLoad ??= fetchCompleteEth15mSettledHistory(currentOpenTimeMs)
    .then((facts) => {
      historicalFacts = facts ? [...facts] : null;
      return historicalFacts;
    })
    .finally(() => { historyLoad = null; });
  return historyLoad;
}

function addOrReplaceFact(fact: KalshiEth15mHistoricalFact): void {
  if (!historicalFacts) return;
  const retained = historicalFacts.filter((row) => row.openTimeMs !== fact.openTimeMs && row.ticker !== fact.ticker);
  retained.push(fact);
  retained.sort((a, b) => a.openTimeMs - b.openTimeMs);
  historicalFacts = retained;
}

async function readExactPriorFact(currentOpenTimeMs: number): Promise<KalshiEth15mHistoricalFact | null> {
  const target = currentOpenTimeMs - ETH_15M_MS;
  const existing = historicalFacts?.filter((fact) => fact.openTimeMs === target) ?? [];
  if (existing.length === 1) return existing[0]!;
  if (existing.length > 1) return null;

  try {
    const response = await marketFetcher<{ markets?: Array<Record<string, unknown>> }>(
      "/markets",
      { series_ticker: "KXETH15M", status: "settled", limit: 100 },
    );
    const matches = (response.markets ?? []).filter((row) => {
      const openMs = typeof row["open_time"] === "string" ? Date.parse(row["open_time"] as string) : NaN;
      return openMs === target && typeof row["ticker"] === "string" && /^KXETH15M-/.test(row["ticker"] as string);
    });
    const strikes = new Set(matches.map(positiveStrike).filter((value): value is number => value != null));
    if (matches.length < 1 || strikes.size !== 1) return null;
    const ticker = matches[0]?.["ticker"];
    if (typeof ticker !== "string") return null;
    const fact = { ticker, openTimeMs: target, floorStrike: [...strikes][0]! } as KalshiEth15mHistoricalFact;
    addOrReplaceFact(fact);
    return fact;
  } catch {
    return null;
  }
}

async function currentStrike(market: Eth420CandidateMarket): Promise<number | null> {
  if (Number.isFinite(market.floorStrike) && market.floorStrike! > 0) return market.floorStrike!;
  const now = Date.now();
  const last = directAttemptMs.get(market.ticker) ?? 0;
  if (now - last < DIRECT_RETRY_MS) return null;
  directAttemptMs.set(market.ticker, now);
  try {
    const response = await marketFetcher<{ market?: Record<string, unknown> }>(`/markets/${market.ticker}`);
    const raw = response.market;
    const openMs = typeof raw?.["open_time"] === "string" ? Date.parse(raw["open_time"] as string) : NaN;
    if (openMs !== market.openTimeMs) return null;
    return positiveStrike(raw);
  } catch {
    return null;
  }
}

function rollingMoves(facts: KalshiEth15mHistoricalFact[], currentOpenTimeMs: number): number[] {
  const firstMoveOpen = currentOpenTimeMs - HISTORY_MS;
  const byOpen = new Map<number, KalshiEth15mHistoricalFact>();
  const conflicting = new Set<number>();
  for (const fact of facts) {
    if (!Number.isInteger(fact.openTimeMs) || !Number.isFinite(fact.floorStrike) || fact.floorStrike <= 0) continue;
    const previous = byOpen.get(fact.openTimeMs);
    if (previous && (previous.ticker !== fact.ticker || previous.floorStrike !== fact.floorStrike)) {
      byOpen.delete(fact.openTimeMs); conflicting.add(fact.openTimeMs); continue;
    }
    if (!conflicting.has(fact.openTimeMs)) byOpen.set(fact.openTimeMs, fact);
  }
  const moves: number[] = [];
  for (const fact of byOpen.values()) {
    if (fact.openTimeMs < firstMoveOpen || fact.openTimeMs >= currentOpenTimeMs) continue;
    const prior = byOpen.get(fact.openTimeMs - ETH_15M_MS);
    if (!prior) continue;
    const move = Math.abs(fact.floorStrike - prior.floorStrike) / prior.floorStrike;
    if (Number.isFinite(move) && move >= 0) moves.push(move);
  }
  return moves.sort((a, b) => a - b);
}

export async function prepareEthDownfadeServiceIntent(input: {
  role: EthDownfadeRole;
  market: Eth420CandidateMarket;
  onEvaluation?: (evidence: EthDownfadeEvidence & { validObservationCount: number; rejectionReason: string | null }) => void;
}): Promise<EthBigBetOrderIntent | null> {
  const empty = (reason: string) => {
    input.onEvaluation?.({ ticker: input.market.ticker, marketOpenTimeMs: input.market.openTimeMs ?? 0,
      currentMove: null, direction: null, p80: null, p90: null, p95: null, p99: null,
      validObservationCount: 0, rejectionReason: reason });
    return null;
  };
  if (!/^KXETH15M-/.test(input.market.ticker) || !Number.isInteger(input.market.openTimeMs)) return empty("invalid_market_identity");

  if (input.role === "downfade_g") {
    const elapsedMs = Date.now() - input.market.openTimeMs!;
    if (elapsedMs < PROBE_START_MS) return empty("probe_waiting_for_five_minutes_remaining");
    if (elapsedMs >= ETH_15M_MS) return empty("probe_market_expired");
    try {
      const response = await marketFetcher<{ market?: Record<string, unknown> }>(`/markets/${input.market.ticker}`);
      const raw = response.market;
      if (!raw) return empty("probe_quote_unavailable");
      const rawOpenMs = typeof raw["open_time"] === "string" ? Date.parse(raw["open_time"] as string) : NaN;
      if (Number.isFinite(rawOpenMs) && rawOpenMs !== input.market.openTimeMs) return empty("probe_market_identity_mismatch");
      const yesBid = quoteCents(raw["yes_bid_dollars"], raw["yes_bid"]);
      const noBid = quoteCents(raw["no_bid_dollars"], raw["no_bid"]);
      if (yesBid == null || noBid == null) return empty("probe_quote_unavailable");
      if (yesBid === noBid) return empty("probe_tied_market");
      const config = ETH_DOWNFADE_CONFIG.downfade_g;
      input.onEvaluation?.({
        ticker: input.market.ticker,
        marketOpenTimeMs: input.market.openTimeMs!,
        currentMove: Math.min(yesBid, noBid) / 100,
        direction: yesBid < noBid ? "down" : "up",
        p80: null, p90: null, p95: null, p99: null,
        validObservationCount: 0,
        rejectionReason: null,
      });
      return {
        strategy: "probe_g",
        orderTag: config.orderTag,
        ticker: input.market.ticker,
        side: yesBid < noBid ? "yes" : "no",
        wagerCents: config.wagerCents,
        limitPriceCents: 30,
        marketOpenTimeMs: input.market.openTimeMs!,
      };
    } catch {
      return empty("probe_quote_unavailable");
    }
  }

  const facts = await ensureHistory(input.market.openTimeMs!);
  if (!facts) return empty("history_unavailable");
  const prior = await readExactPriorFact(input.market.openTimeMs!);
  const strike = await currentStrike(input.market);
  if (!prior || strike == null) return empty("adjacent_strike_unavailable");

  const moves = rollingMoves(historicalFacts ?? facts, input.market.openTimeMs!);
  const p80 = moves.length >= MIN_HISTORY ? percentile(moves, .80) : null;
  const p90 = moves.length >= MIN_HISTORY ? percentile(moves, .90) : null;
  const p95 = moves.length >= MIN_HISTORY ? percentile(moves, .95) : null;
  const p99 = moves.length >= MIN_HISTORY ? percentile(moves, .99) : null;
  const currentMove = Math.abs(strike - prior.floorStrike) / prior.floorStrike;
  const direction = strike < prior.floorStrike ? "down" as const : strike > prior.floorStrike ? "up" as const : "flat" as const;
  const evidence: EthDownfadeEvidence = {
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    currentMove,
    direction,
    p80,
    p90,
    p95,
    p99,
  };
  const intent = buildEthDownfadeIntent(input.role, evidence);
  input.onEvaluation?.({ ...evidence, validObservationCount: moves.length, rejectionReason: intent ? null : "band_or_direction_not_qualified" });
  return intent;
}
