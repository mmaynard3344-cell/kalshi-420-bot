import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

const marker = 'async function authoritativePnlDiagnostics(req, res) {';
if (!server.includes(marker)) {
  const anchor = 'function serveStatic(req, res, url) {';
  if (!server.includes(anchor)) throw new Error('authoritative P&L server anchor not found');
  const block = `function etDayKey(ms) {\n  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));\n  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';\n  return part('year') + '-' + part('month') + '-' + part('day');\n}\n\nfunction numeric(value) {\n  const n = Number(value);\n  return Number.isFinite(n) ? n : null;\n}\n\nfunction fillTimeMs(fill) {\n  for (const value of [fill?.created_time, fill?.created_at, fill?.createdAt]) {\n    if (!value) continue;\n    const ms = Date.parse(value);\n    if (Number.isFinite(ms)) return ms;\n  }\n  for (const value of [fill?.created_at_ms, fill?.createdAtMs]) {\n    const ms = numeric(value);\n    if (ms != null) return ms;\n  }\n  const ts = numeric(fill?.ts);\n  return ts == null ? null : ts * 1000;\n}\n\nfunction fillCountValue(fill) {\n  return numeric(fill?.count_fp ?? fill?.count ?? fill?.contracts) ?? 0;\n}\n\nfunction fillFeeCents(fill) {\n  const dollars = numeric(fill?.fee_cost_dollars ?? fill?.fee_cost);\n  return dollars == null ? 0 : Math.round(dollars * 100);\n}\n\nfunction fillSidePriceDollars(fill, side) {\n  const dollars = numeric(side === 'no' ? fill?.no_price_dollars : fill?.yes_price_dollars);\n  if (dollars != null) return dollars;\n  const cents = numeric(side === 'no' ? fill?.no_price : fill?.yes_price);\n  return cents == null ? null : cents / 100;\n}\n\nasync function authoritativePnlDiagnostics(req, res) {\n  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');\n  try {\n    const [fillsPayload, sideRows] = await Promise.all([\n      graceJson('/api/trade/fills?limit=1000'),\n      withReadOnlyDb(async (client) => {\n        const result = await client.query(\`\n          SELECT kalshi_order_id, side, ticker, 'regular' AS engine\n          FROM eth_martingale_orders\n          WHERE kalshi_order_id IS NOT NULL AND ticker LIKE 'KXETH15M-%'\n          UNION ALL\n          SELECT kalshi_order_id, side, ticker, 'candidate' AS engine\n          FROM eth420_candidate_live_orders\n          WHERE kalshi_order_id IS NOT NULL AND ticker LIKE 'KXETH15M-%'\n        \`);\n        return result.rows;\n      }),\n    ]);\n    const fills = Array.isArray(fillsPayload?.fills) ? fillsPayload.fills : [];\n    const sideByOrderId = new Map();\n    for (const row of sideRows) {\n      const id = String(row.kalshi_order_id ?? '');\n      const side = String(row.side ?? '').toLowerCase();\n      if (id && (side === 'yes' || side === 'no')) sideByOrderId.set(id, { side, engine: String(row.engine ?? ''), ticker: String(row.ticker ?? '') });\n    }\n\n    const grouped = new Map();\n    let unresolvedSideFillCount = 0;\n    for (const fill of fills) {\n      const ticker = String(fill?.ticker ?? '');\n      if (!ticker.startsWith('KXETH15M-')) continue;\n      const orderId = String(fill?.order_id ?? fill?.orderId ?? '');\n      const owner = sideByOrderId.get(orderId);\n      if (!owner) { unresolvedSideFillCount += 1; continue; }\n      const count = fillCountValue(fill);\n      const price = fillSidePriceDollars(fill, owner.side);\n      const ms = fillTimeMs(fill);\n      if (!(count > 0) || price == null || price < 0 || price > 1 || ms == null) continue;\n      const resultRaw = String(fill?.market_result ?? '').toLowerCase();\n      const result = resultRaw === 'yes' || resultRaw === 'no' ? resultRaw : '';\n      const item = grouped.get(orderId) ?? { orderId, ticker, side: owner.side, engine: owner.engine, atMs: ms, contracts: 0, principalCents: 0, feesCents: 0, result: '' };\n      item.atMs = Math.min(item.atMs, ms);\n      item.contracts += count;\n      item.principalCents += Math.round(count * price * 100);\n      item.feesCents += fillFeeCents(fill);\n      if (result) item.result = result;\n      grouped.set(orderId, item);\n    }\n\n    const days = new Map();\n    const rows = [];\n    for (const item of grouped.values()) {\n      if (!item.result) continue;\n      const won = item.result === item.side;\n      const pnlCents = (won ? Math.round(item.contracts * 100) - item.principalCents : -item.principalCents) - item.feesCents;\n      const easternDate = etDayKey(item.atMs);\n      rows.push({ ...item, easternDate, won, pnlCents });\n      const day = days.get(easternDate) ?? { easternDate, settled: 0, wins: 0, losses: 0, wageredCents: 0, feesCents: 0, netCents: 0 };\n      day.settled += 1;\n      day.wins += won ? 1 : 0;\n      day.losses += won ? 0 : 1;\n      day.wageredCents += item.principalCents;\n      day.feesCents += item.feesCents;\n      day.netCents += pnlCents;\n      days.set(easternDate, day);\n    }\n    rows.sort((a, b) => b.atMs - a.atMs);\n    const dayRows = [...days.values()].sort((a, b) => a.easternDate.localeCompare(b.easternDate));\n    const response = {\n      available: true,\n      generatedAtMs: Date.now(),\n      method: 'durable_order_side_plus_actual_kalshi_fills',\n      unresolvedSideFillCount,\n      resolvedOrderCount: grouped.size,\n      days: dayRows,\n      rows,\n    };\n    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');\n    return send(res, 200, JSON.stringify(response), 'application/json; charset=utf-8');\n  } catch (error) {\n    console.error('Authoritative P&L diagnostic failed', error);\n    return send(res, 500, JSON.stringify({ available: false, error: String(error?.message ?? 'Authoritative P&L diagnostic failed') }), 'application/json; charset=utf-8');\n  }\n}\n\n`;
  server = server.replace(anchor, block + anchor);
}

const route = "  if (url.pathname === '/api/diagnostics/authoritative-pnl') return void authoritativePnlDiagnostics(req, res);";
if (!server.includes(route)) {
  const routeAnchor = "  if (url.pathname === '/api/diagnostics/back-flips') return void backFlipDiagnostics(req, res, false);";
  if (!server.includes(routeAnchor)) throw new Error('authoritative P&L route anchor not found');
  server = server.replace(routeAnchor, routeAnchor + '\n' + route);
}
fs.writeFileSync(serverPath, server);

const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');

// The current P&L runtime pages the actual fill ledger back to the Aug 27 cutoff.
// Do not overwrite that complete-history calculation with this legacy diagnostic,
// which intentionally reads only one 1,000-fill page.
if (pnl.includes('fetchAllFillsSinceCutoff')) {
  fs.writeFileSync(pnlPath, pnl);
  process.exit(0);
}

const fetchAnchor = "        fetch('/api/trade/orders?limit=1000', {cache:'no-store'})";
if (!pnl.includes("fetch('/api/diagnostics/authoritative-pnl'")) {
  if (!pnl.includes(fetchAnchor)) throw new Error('authoritative P&L runtime fetch anchor not found');
  pnl = pnl.replace(fetchAnchor, fetchAnchor + ",\n        fetch('/api/diagnostics/authoritative-pnl', {cache:'no-store'})");
  pnl = pnl.replace('      const [fillResult, orderResult] = await Promise.allSettled([', '      const [fillResult, orderResult, authoritativeResult] = await Promise.allSettled([');
}
const paintAnchor = "      if (orderResult.status === 'fulfilled' && orderResult.value.ok) paintOrders(orders, fillMap);";
const paintReplacement = `      if (authoritativeResult.status === 'fulfilled' && authoritativeResult.value.ok) {\n        const authoritative = await authoritativeResult.value.json();\n        if (Array.isArray(authoritative?.days)) paintSummary(authoritative.days);\n      }\n\n      if (orderResult.status === 'fulfilled' && orderResult.value.ok) paintOrders(orders, fillMap);`;
if (!pnl.includes(paintReplacement)) {
  if (!pnl.includes(paintAnchor)) throw new Error('authoritative P&L runtime paint anchor not found');
  pnl = pnl.replace(paintAnchor, paintReplacement);
}
fs.writeFileSync(pnlPath, pnl);
