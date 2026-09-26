import { kalshiFetch } from "../kalshi.js";
import type { Eth420CandidateMarket } from "./eth420SixStepCandidate.js";
import { buildEthAshV2Intent, type EthAshV2Evidence } from "./ethAshV2Signal.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

const ETH_15M_MS = 15 * 60_000;
const DIRECT_RETRY_MS = 2_000;
const directAttemptMs = new Map<string, number>();

type MarketFetcher = typeof kalshiFetch;
let marketFetcher: MarketFetcher = kalshiFetch;

export function _setEthAshV2MarketFetcherForTesting(fetcher: MarketFetcher | null): void {
  marketFetcher = fetcher ?? kalshiFetch;
  directAttemptMs.clear();
}

function positiveStrike(raw: Record<string, unknown> | null | undefined): number | null {
  if (!raw) return null;
  const value = raw["floor_strike"] ?? raw["cap_strike"];
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readExactPriorStrike(currentOpenTimeMs: number): Promise<number | null> {
  const target = currentOpenTimeMs - ETH_15M_MS;
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
    return strikes.size === 1 ? [...strikes][0]! : null;
  } catch {
    return null;
  }
}

async function readCurrentStrike(market: Eth420CandidateMarket): Promise<number | null> {
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

export async function prepareEthAshV2Intent(input: {
  market: Eth420CandidateMarket;
  nowMs?: number;
  onEvaluation?: (evidence: EthAshV2Evidence & { rejectionReason: string | null }) => void;
}): Promise<EthBigBetOrderIntent | null> {
  const nowMs = input.nowMs ?? Date.now();
  const empty = (reason: string, partial: Partial<EthAshV2Evidence> = {}) => {
    input.onEvaluation?.({
      ticker: input.market.ticker,
      marketOpenTimeMs: input.market.openTimeMs ?? 0,
      currentStrike: null,
      priorStrike: null,
      moveRatio: null,
      ageMs: input.market.openTimeMs == null ? null : nowMs - input.market.openTimeMs,
      ...partial,
      rejectionReason: reason,
    });
    return null;
  };

  if (!/^KXETH15M-/.test(input.market.ticker) || !Number.isInteger(input.market.openTimeMs)) {
    return empty("invalid_market_identity");
  }
  const ageMs = nowMs - input.market.openTimeMs!;
  if (ageMs < 0 || ageMs > 15 * 60_000) return empty("outside_entry_window", { ageMs });

  const [priorStrike, currentStrike] = await Promise.all([
    readExactPriorStrike(input.market.openTimeMs!),
    readCurrentStrike(input.market),
  ]);
  if (priorStrike == null || currentStrike == null) {
    return empty("adjacent_strike_unavailable", { priorStrike, currentStrike, ageMs });
  }

  const moveRatio = (currentStrike - priorStrike) / priorStrike;
  const evidence: EthAshV2Evidence = {
    ticker: input.market.ticker,
    marketOpenTimeMs: input.market.openTimeMs!,
    currentStrike,
    priorStrike,
    moveRatio,
    ageMs,
  };
  const intent = buildEthAshV2Intent(evidence);
  input.onEvaluation?.({ ...evidence, rejectionReason: intent ? null : "band_or_direction_not_qualified" });
  return intent;
}
