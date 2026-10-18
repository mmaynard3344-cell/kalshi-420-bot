/**
 * Development-only same-origin operator gateway. No money-moving URL allowed.
 * The upstream trade credential is server-side; the operator credential comes
 * only from a user-initiated login request and is never persisted here.
 */
const ROUTES = Object.freeze({
  '/api/operator/shards/login': '/api/trade/shard-transfer/operator-login',
  '/api/operator/shards/preview': '/api/trade/shard-transfer/session-preview',
});
export function operatorGatewayUpstreamPath(path) { return ROUTES[path] ?? null; }
export function operatorGatewayAllowed(req, path, origin) {
  if (!operatorGatewayUpstreamPath(path) || req.method !== 'POST' || !origin) return false;
  if (req.headers.origin !== origin || req.headers['sec-fetch-site'] !== 'same-origin') return false;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return false;
  const n = req.headers['content-length'];
  return typeof n === 'string' && /^[1-9][0-9]{0,3}$/.test(n) && Number(n) <= 4096;
}
export async function operatorGateway(req, res, path, config) {
  if (config.enabled !== true || !operatorGatewayAllowed(req, path, config.origin)) {
    res.writeHead(403, { 'cache-control': 'no-store' }); res.end('Operator gateway disabled or rejected'); return;
  }
  const upstreamPath = operatorGatewayUpstreamPath(path);
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw) > 4096) throw Error('too large');
    }
    if (Buffer.byteLength(raw) !== Number(req.headers['content-length'])) throw Error('size mismatch');
    JSON.parse(raw);
    const headers = {
      'x-trade-token': config.tradeToken, 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(raw)), 'origin': config.origin,
      'sec-fetch-site': 'same-origin', 'accept': 'application/json',
    };
    if (path.endsWith('/preview')) {
      const cookie = req.headers.cookie ?? '';
      const match = cookie.match(/(?:^|;\s*)(__Host-shard_operator=[A-Za-z0-9_.-]+)/);
      if (match) headers.cookie = match[1];
      const csrf = req.headers['x-shard-operator-csrf'];
      if (typeof csrf === 'string') headers['x-shard-operator-csrf'] = csrf;
    }
    const upstream = await fetch(config.baseUrl + upstreamPath, {
      method: 'POST', headers, body: raw, redirect: 'manual',
    });
    const body = await upstream.text();
    const responseHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };
    if (path.endsWith('/login') && upstream.ok) {
      const cookie = upstream.headers.get('set-cookie');
      const match = typeof cookie === 'string'
        ? cookie.match(/^__Host-shard_operator=([A-Za-z0-9_.-]{20,1024})(?:;|$)/)
        : null;
      if (match && /(?:^|;)\\s*HttpOnly(?:;|$)/i.test(cookie) &&
          /(?:^|;)\\s*Secure(?:;|$)/i.test(cookie) &&
          /(?:^|;)\\s*SameSite=Strict(?:;|$)/i.test(cookie)) {
        // Reissue on the dashboard origin; never forward Domain or other
        // upstream attributes that might expand cookie scope.
        responseHeaders['set-cookie'] = '__Host-shard_operator=' + match[1] +
          '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900';
      } else {
        res.writeHead(502, responseHeaders); res.end('{"error":"Invalid operator session response"}'); return;
      }
    }
    res.writeHead(upstream.status, responseHeaders); res.end(body);
  } catch {
    res.writeHead(502, { 'cache-control': 'no-store' }); res.end('Operator gateway unavailable');
  }
}
