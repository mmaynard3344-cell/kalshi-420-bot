// The trade token is injected at build time via the VITE_TRADE_API_TOKEN
// secret. The old GET /api/trade/client-token endpoint was removed — it
// handed the write-capable token to any unauthenticated caller.
export async function getTradeToken(): Promise<string> {
  const token = (import.meta.env.VITE_TRADE_API_TOKEN as string | undefined) ?? '';
  if (!token) {
    console.warn('[tradeToken] VITE_TRADE_API_TOKEN is not set — trade API calls will fail auth');
  }
  return token;
}
