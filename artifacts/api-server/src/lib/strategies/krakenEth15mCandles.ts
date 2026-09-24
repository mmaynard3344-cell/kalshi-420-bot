/**
 * Read-only canonical ETH/USD 15-minute OHLC source for L — Sweep/Reclaim.
 * Uses Kraken public OHLC. The trailing in-progress row is never finalized.
 */
import { ETH_15M_MS, type Eth15mCandle } from "./sweepReclaimV1.js";

export const KRAKEN_ETH_OHLC_PAIR = "ETHUSD" as const;
export const KRAKEN_ETH_OHLC_INTERVAL_MINUTES = 15 as const;
export const KRAKEN_ETH_OHLC_URL = "https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=15";

export interface KrakenEthCandleBatch {
  source: "kraken";
  pair: typeof KRAKEN_ETH_OHLC_PAIR;
  intervalMinutes: typeof KRAKEN_ETH_OHLC_INTERVAL_MINUTES;
  fetchedAtMs: number;
  candles: Eth15mCandle[];
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeOpenTimeMs(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = Math.trunc(seconds * 1000);
  return ms % ETH_15M_MS === 0 ? ms : null;
}

export function parseKrakenEth15mRow(row: unknown, finalizedThroughMs: number): Eth15mCandle | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const openTimeMs = normalizeOpenTimeMs(row[0]);
  const open = finitePositive(row[1]);
  const high = finitePositive(row[2]);
  const low = finitePositive(row[3]);
  const close = finitePositive(row[4]);
  if (openTimeMs == null || open == null || high == null || low == null || close == null) return null;
  if (high < low || open < low || open > high || close < low || close > high) return null;
  const closeTimeMs = openTimeMs + ETH_15M_MS;
  if (closeTimeMs > finalizedThroughMs) return null;
  return { openTimeMs, closeTimeMs, open, high, low, close, finalized: true };
}

export function parseKrakenEth15mPayload(payload: unknown, finalizedThroughMs: number): Eth15mCandle[] {
  if (payload == null || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root["error"]) || (root["error"] as unknown[]).length !== 0) return [];
  const result = root["result"];
  if (result == null || typeof result !== "object") return [];
  const arrays = Object.entries(result as Record<string, unknown>)
    .filter(([key, value]) => key !== "last" && Array.isArray(value))
    .map(([, value]) => value as unknown[]);
  if (arrays.length !== 1) return [];
  const byOpen = new Map<number, Eth15mCandle>();
  for (const row of arrays[0]!) {
    const candle = parseKrakenEth15mRow(row, finalizedThroughMs);
    if (candle) byOpen.set(candle.openTimeMs, candle);
  }
  return [...byOpen.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function isContiguousFinalizedEth15m(candles: readonly Eth15mCandle[]): boolean {
  if (candles.length === 0) return false;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    if (!candle.finalized || candle.closeTimeMs - candle.openTimeMs !== ETH_15M_MS) return false;
    if (i > 0 && candle.openTimeMs !== candles[i - 1]!.closeTimeMs) return false;
  }
  return true;
}

export function selectContiguousPriorCandles(
  candles: readonly Eth15mCandle[],
  expectedSourceOpenMs: number,
  count: number,
): Eth15mCandle[] | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  const eligible = candles.filter((c) => c.finalized && c.closeTimeMs <= expectedSourceOpenMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  const selected = eligible.slice(-count);
  if (selected.length !== count) return null;
  if (!isContiguousFinalizedEth15m(selected)) return null;
  if (selected[selected.length - 1]!.closeTimeMs !== expectedSourceOpenMs) return null;
  return selected;
}

export async function fetchKrakenEth15mCandles(
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<KrakenEthCandleBatch> {
  const response = await fetchImpl(KRAKEN_ETH_OHLC_URL, {
    headers: { "User-Agent": "shawshank-sweep-reclaim/1.0" },
  });
  if (!response.ok) throw new Error("Kraken OHLC HTTP " + response.status);
  const payload = await response.json() as unknown;
  const candles = parseKrakenEth15mPayload(payload, nowMs);
  if (candles.length === 0) throw new Error("Kraken OHLC returned no finalized ETH 15m candles");
  return {
    source: "kraken",
    pair: KRAKEN_ETH_OHLC_PAIR,
    intervalMinutes: KRAKEN_ETH_OHLC_INTERVAL_MINUTES,
    fetchedAtMs: nowMs,
    candles,
  };
}
