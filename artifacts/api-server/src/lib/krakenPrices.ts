/**
 * Shared read-only Kraken BTC/ETH price source. It is independent of trading
 * logic and may be used by display routes or passive research workers only.
 */
export const KRAKEN_PRICE_CACHE_MS = 5_000;

export interface KrakenPriceSnapshot {
  btc: number;
  eth: number;
  sol: number;
  sourceTimestampMs: number;
  retrievedAtMs: number;
  cacheAgeMs: number;
  cached: boolean;
}

let cached: Omit<KrakenPriceSnapshot, "cacheAgeMs" | "cached"> | null = null;
let inFlight: Promise<Omit<KrakenPriceSnapshot, "cacheAgeMs" | "cached">> | null = null;

async function fetchFresh(): Promise<Omit<KrakenPriceSnapshot, "cacheAgeMs" | "cached">> {
  const response = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD");
  if (!response.ok) throw new Error(`Kraken ${response.status}`);
  const data = await response.json() as { result?: { XXBTZUSD?: { c?: string[] }; XETHZUSD?: { c?: string[] }; SOLUSD?: { c?: string[] } } };
  const btc = parseFloat(data.result?.XXBTZUSD?.c?.[0] ?? "0");
  const eth = parseFloat(data.result?.XETHZUSD?.c?.[0] ?? "0");
  const sol = parseFloat(data.result?.SOLUSD?.c?.[0] ?? "0");
  if (!Number.isFinite(btc) || btc <= 0 || !Number.isFinite(eth) || eth <= 0 || !Number.isFinite(sol) || sol <= 0) {
    throw new Error("Missing price data from Kraken");
  }
  const retrievedAtMs = Date.now();
  return { btc, eth, sol, sourceTimestampMs: retrievedAtMs, retrievedAtMs };
}

export async function getKrakenPrices(nowMs = Date.now()): Promise<KrakenPriceSnapshot> {
  const age = cached ? Math.max(0, nowMs - cached.retrievedAtMs) : null;
  if (cached && age != null && age <= KRAKEN_PRICE_CACHE_MS) return { ...cached, cacheAgeMs: age, cached: true };
  if (!inFlight) {
    inFlight = fetchFresh().then((result) => {
      cached = result;
      return result;
    }).finally(() => { inFlight = null; });
  }
  const fresh = await inFlight;
  return { ...fresh, cacheAgeMs: Math.max(0, nowMs - fresh.retrievedAtMs), cached: false };
}

export function _resetKrakenPricesForTesting(): void {
  cached = null;
  inFlight = null;
}