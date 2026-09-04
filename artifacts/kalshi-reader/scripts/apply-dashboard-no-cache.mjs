import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');
const oldCache = "    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',";
const newCache = "    'cache-control': (filePath.endsWith('.html') || filePath.endsWith('.js')) ? 'no-store' : 'public, max-age=31536000, immutable',";
if (!server.includes(newCache)) {
  if (!server.includes(oldCache)) throw new Error('dashboard no-cache: server cache anchor not found');
  server = server.replace(oldCache, newCache);
}

const healthFunction = `\nasync function upstreamHealth(req, res) {\n  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');\n  const probes = [\n    ['balance', '/api/trade/balance'],\n    ['martingale', '/api/trade/martingale'],\n    ['orders', '/api/trade/orders?limit=1'],\n    ['liveMarket', '/api/trade/analytics/eth420-live-market'],\n  ];\n  const results = {};\n  for (const [name, path] of probes) {\n    try {\n      const response = await fetch(\`${'${graceBase}'}\${path}\`, {\n        method: 'GET',\n        headers: { 'x-trade-token': graceToken, accept: 'application/json' },\n        redirect: 'manual',\n      });\n      results[name] = { ok: response.ok, status: response.status };\n    } catch (error) {\n      results[name] = { ok: false, status: null, error: String(error?.code ?? error?.message ?? 'fetch_failed') };\n    }\n  }\n  const ok = Object.values(results).every((item) => item.ok === true);\n  if (req.method === 'HEAD') return send(res, ok ? 200 : 503, '', 'application/json; charset=utf-8');\n  return send(res, ok ? 200 : 503, JSON.stringify({ ok, upstreamConfigured: Boolean(graceBase), tokenConfigured: Boolean(graceToken), results }, null, 2), 'application/json; charset=utf-8');\n}\n`;
if (!server.includes('async function upstreamHealth(req, res)')) {
  const anchor = '\nfunction serveStatic(req, res, url) {';
  if (!server.includes(anchor)) throw new Error('dashboard no-cache: serveStatic anchor not found');
  server = server.replace(anchor, healthFunction + anchor);
}
if (!server.includes("if (url.pathname === '/healthz/upstream')")) {
  const routeAnchor = "  if (url.pathname === '/api/diagnostics/exchange-ticker') return void exchangeTickerDiagnostics(req, res, url);";
  if (!server.includes(routeAnchor)) throw new Error('dashboard no-cache: server route anchor not found');
  server = server.replace(routeAnchor, "  if (url.pathname === '/healthz/upstream') return void upstreamHealth(req, res);\n" + routeAnchor);
}
fs.writeFileSync(serverPath, server);

const dashboardPath = new URL('../public/eth420-dashboard.html', import.meta.url);
let html = fs.readFileSync(dashboardPath, 'utf8');
html = html.replace('<script defer src="/pnl-runtime.js"></script>', '<script defer src="/pnl-runtime.js?v=ops-audit-v3"></script>');
if (!html.includes('/operations-core.js?v=ops-core-v1')) {
  if (!html.includes('</head>')) throw new Error('dashboard no-cache: closing head not found');
  html = html.replace('</head>', '<script defer src="/operations-core.js?v=ops-core-v1"></script>\n</head>');
}
fs.writeFileSync(dashboardPath, html);
