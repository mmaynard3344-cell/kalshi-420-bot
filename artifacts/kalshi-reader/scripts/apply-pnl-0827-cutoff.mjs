import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../server.mjs', import.meta.url);
let source = await readFile(path, 'utf8');

const importLine = "import { buildPnlReportFrom0827 } from './pnl-report-0827.mjs';\n";
if (!source.includes(importLine.trim())) {
  const anchor = "import { createRequire } from 'node:module';\n";
  if (!source.includes(anchor)) throw new Error('P&L cutoff patch: import anchor missing');
  source = source.replace(anchor, `${anchor}${importLine}`);
}

const allowedPath = "  '/api/trade/analytics/reports/pnl',\n";
if (!source.includes(allowedPath.trim())) {
  const anchor = "  '/api/trade/analytics/boundary-discovery',\n";
  if (!source.includes(anchor)) throw new Error('P&L cutoff patch: allowlist anchor missing');
  source = source.replace(anchor, `${anchor}${allowedPath}`);
}

if (!source.includes('async function pnlReport0827(')) {
  const anchor = 'async function candidateLifecycleDiagnostics(req, res, url) {';
  if (!source.includes(anchor)) throw new Error('P&L cutoff patch: handler anchor missing');
  const handler = `async function pnlReport0827(req, res, url) {\n  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');\n  const period = String(url.searchParams.get('period') ?? 'all-time');\n  if (period === 'today' || period === '7d') return proxyRead(req, res, url);\n  if (period !== 'all-time') return send(res, 400, JSON.stringify({ error: 'Invalid P&L period' }), 'application/json; charset=utf-8');\n  try {\n    const report = await withReadOnlyDb((client) => buildPnlReportFrom0827(client));\n    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');\n    return send(res, 200, JSON.stringify(report), 'application/json; charset=utf-8');\n  } catch (error) {\n    console.error('All-time P&L read failed', error);\n    return send(res, 500, JSON.stringify({ error: 'All-time P&L unavailable' }), 'application/json; charset=utf-8');\n  }\n}\n\n`;
  source = source.replace(anchor, `${handler}${anchor}`);
}

const route = "  if (url.pathname === '/api/trade/analytics/reports/pnl') return void pnlReport0827(req, res, url);\n";
if (!source.includes(route.trim())) {
  const anchor = "  if (url.pathname.startsWith('/api/')) return void proxyRead(req, res, url);\n";
  if (!source.includes(anchor)) throw new Error('P&L cutoff patch: route anchor missing');
  source = source.replace(anchor, `${route}${anchor}`);
}

// The live Shawshank P&L runtime paints its summary from the newer
// /api/diagnostics/authoritative-pnl route. Apply the same Eastern-date cutoff
// there so the visible All Time P&L is truly Aug 27, 2026 onward.
const authoritativeDayRows = "    const dayRows = [...days.values()].sort((a, b) => a.easternDate.localeCompare(b.easternDate));";
if (source.includes(authoritativeDayRows) && !source.includes("const pnlCutoffDate = '2026-08-27';")) {
  source = source.replace(
    authoritativeDayRows,
    "    const pnlCutoffDate = '2026-08-27';\n    const cutoffRows = rows.filter((row) => row.easternDate >= pnlCutoffDate);\n    const dayRows = [...days.values()].filter((day) => day.easternDate >= pnlCutoffDate).sort((a, b) => a.easternDate.localeCompare(b.easternDate));",
  );
  source = source.replace(
    "      resolvedOrderCount: grouped.size,\n      days: dayRows,\n      rows,",
    "      resolvedOrderCount: cutoffRows.length,\n      days: dayRows,\n      rows: cutoffRows,",
  );
}

if (source.includes('async function authoritativePnlDiagnostics(req, res) {') && !source.includes("const pnlCutoffDate = '2026-08-27';")) {
  throw new Error('P&L cutoff patch: authoritative route found but cutoff was not applied');
}

await writeFile(path, source, 'utf8');
console.log('Applied dashboard all-time P&L cutoff: 2026-08-27 Eastern (reports + authoritative runtime)');