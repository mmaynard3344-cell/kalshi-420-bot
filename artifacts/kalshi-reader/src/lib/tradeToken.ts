// The standalone operator UI never receives a Grace trade credential.
// Its same-origin UI server proxies an explicit allowlist of GET-only
// observability endpoints and injects the credential server-side.
export async function getTradeToken(): Promise<string> {
  return '';
}
