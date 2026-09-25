import { kalshiFetch, kalshiSeriesFetch, normalizeMarket } from "../kalshi.js";
import { logger } from "../logger.js";
import {
  A2_INTERVAL_MS,
  loadA2BaselineReversionConfig,
  type A2BtcCandle,
  type A2DestinationMarket,
} from "./a2BaselineReversion.js";
import { evaluateA2BaselineReversionShadow } from "./a2BaselineReversionShadow.js";
import type { A2ShadowStore } from "./a2BaselineReversionShadowStore.js";

export const A2_RUNTIME_POLL_MS = 10_000;

type RawMarket = Record<string, unknown>;
type KrakenOhlcRow = unknown[];

export interface A2RuntimeDeps {
  nowMs(): number;
  fetchCurrentMarket(): Promise<RawMarket | null>;
  fetchMarket(ticker: string): Promise<RawMarket | null>;
  fetchSourceCandle(sourceOpenTimeMs: number, nowMs: number): Promise<A2BtcCandle | null>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function verifyBtcYesSettlesAboveStrike(raw: RawMarket): boolean {
  const ticker = text(raw["ticker"]).toUpperCase();
  const strike = numeric(raw["floor_strike"] ?? raw["cap_strike"]);
  if (!/^KXBTC15M-/.test(ticker) || strike == null || strike <= 0) return false;

  const authoritativeRules = [
    text(raw["rules_primary"]),
    text(raw["rules_secondary"]),
  ].filter(Boolean).join(" ");
  const yesText = [
    text(raw["yes_sub_title"]),
    text(raw["subtitle"]),
    text(raw["title"]),
  ].filter(Boolean).join(" ");

  const parseOperator = (value: string): "above" | "below" | null => {
    if (/\bat or above\b|\bgreater than or equal\b|>=|\babove\b|\bgreater than\b|\bhigher than\b|\bexceed(?:s|ed)?\b/.test(value)) {
      return "above";
    }
    if (/\bat or below\b|\bless than or equal\b|<=|\bbelow\b|\bless than\b|\blower than\b/.test(value)) {
      return "below";
    }
    return null;
  };

  const rulesOperator = parseOperator(authoritativeRules);
  if (rulesOperator != null) return rulesOperator === "above";
  return parseOperator(yesText) === "above";
}

export function destinationFromRawMarket(raw: RawMarket): A2DestinationMarket | null {
  const normalized = normalizeMarket(raw);
  const ticker = normalized["ticker"];
  const openTime = normalized["open_time"];
  const closeTime = normalized["close_time"];
  const openTimeMs = typeof openTime === "string" ? Date.parse(openTime) : NaN;
  const closeTimeMs = typeof closeTime === "string" ? Date.parse(closeTime) : NaN;
  if (typeof ticker !== "string" || !/^KXBTC15M-/.test(ticker)
    || !Number.isSafeInteger(openTimeMs) || !Number.isSafeInteger(closeTimeMs)) return null;
  const yesAsk = normalized["yes_ask"];
  return {
    ticker,
    openTimeMs,
    closeTimeMs,
    yesAskCents: typeof yesAsk === "number" && Number.isInteger(yesAsk) ? yesAsk : null,
    yesSettlesAboveStrike: verifyBtcYesSettlesAboveStrike(raw),
  };
}

export function parseKrakenBtc15mCandle(
  payload: unknown,
  sourceOpenTimeMs: number,
  nowMs: number,
): A2BtcCandle | null {
  if (!Number.isSafeInteger(sourceOpenTimeMs) || sourceOpenTimeMs % A2_INTERVAL_MS !== 0) return null;
  const result = (payload as { result?: Record<string, unknown> })?.result;
  if (!result || typeof result !== "object") return null;
  const rows = Object.entries(result)
    .filter(([key, value]) => key !== "last" && Array.isArray(value))
    .flatMap(([, value]) => value as unknown[]);
  const row = rows.find((candidate) =>
    Array.isArray(candidate) && Number(candidate[0]) * 1_000 === sourceOpenTimeMs) as KrakenOhlcRow | undefined;
  if (!row) return null;
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  const closeTimeMs = sourceOpenTimeMs + A2_INTERVAL_MS;
  return {
    openTimeMs: sourceOpenTimeMs,
    closeTimeMs,
    open,
    high,
    low,
    close,
    finalized: nowMs >= closeTimeMs,
  };
}

async function defaultFetchSourceCandle(sourceOpenTimeMs: number, nowMs: number): Promise<A2BtcCandle | null> {
  const sinceSeconds = Math.floor(sourceOpenTimeMs / 1_000);
  const response = await fetch(
    `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=15&since=${sinceSeconds}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Kraken OHLC ${response.status}`);
  return parseKrakenBtc15mCandle(await response.json(), sourceOpenTimeMs, nowMs);
}

const defaultDeps: A2RuntimeDeps = {
  nowMs: () => Date.now(),
  fetchCurrentMarket: () => kalshiSeriesFetch("KXBTC15M", { forceFresh: true }),
  fetchMarket: async (ticker) => {
    try {
      const response = await kalshiFetch<{ market?: RawMarket }>(`/markets/${ticker}`);
      return response.market ?? null;
    } catch {
      return null;
    }
  },
  fetchSourceCandle: defaultFetchSourceCandle,
};

export async function runA2BaselineReversionRuntimeOnce(
  store: A2ShadowStore,
  deps: A2RuntimeDeps = defaultDeps,
): Promise<{ evaluated: boolean; outcome: string; ticker: string | null }> {
  const nowMs = deps.nowMs();

  for (const claim of await store.listOpen()) {
    const raw = await deps.fetchMarket(claim.destinationTicker);
    if (!raw) continue;
    const normalized = normalizeMarket(raw);
    const result = normalized["result"];
    if (result === "yes" || result === "no") {
      await store.settle({ id: claim.id, settlementResult: result, settledAtMs: nowMs });
    }
  }

  const rawDestination = await deps.fetchCurrentMarket();
  if (!rawDestination) return { evaluated: false, outcome: "market_unavailable", ticker: null };
  const destination = destinationFromRawMarket(rawDestination);
  if (!destination) return { evaluated: false, outcome: "destination_invalid", ticker: null };

  const sourceOpenTimeMs = destination.openTimeMs - A2_INTERVAL_MS;
  const source = await deps.fetchSourceCandle(sourceOpenTimeMs, nowMs);
  if (!source) return { evaluated: false, outcome: "source_unavailable", ticker: destination.ticker };

  const result = await evaluateA2BaselineReversionShadow({
    config: loadA2BaselineReversionConfig(),
    source,
    destination,
    observedAtMs: nowMs,
    store,
  });
  logger.info(
    {
      strategy: "a2_baseline_reversion",
      ticker: destination.ticker,
      sourceOpenTimeMs,
      sourceDropFraction: source.open > 0 ? (source.open - source.close) / source.open : null,
      observedYesAskCents: destination.yesAskCents,
      yesSemanticsVerified: destination.yesSettlesAboveStrike,
      outcome: result.outcome,
      signal: result.signal,
    },
    "A2 baseline reversion evaluation",
  );
  return { evaluated: true, outcome: result.outcome, ticker: destination.ticker };
}

export function startA2BaselineReversionRuntime(
  store: A2ShadowStore,
  deps: A2RuntimeDeps = defaultDeps,
): () => void {
  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void runA2BaselineReversionRuntimeOnce(store, deps)
      .catch((err) => logger.warn({ err }, "A2 baseline reversion runtime iteration failed"))
      .finally(() => { inFlight = false; });
  };
  run();
  const timer = setInterval(run, A2_RUNTIME_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
