import fs from 'node:fs';

const serverPath = new URL('../server.mjs', import.meta.url);
let server = fs.readFileSync(serverPath, 'utf8');

const functionAnchor = '\nfunction serveStatic(req, res, url) {';
const functionBlock = `
async function sequenceAuditDiagnostics(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!databaseUrl) return send(res, 503, JSON.stringify({ available: false, error: 'DATABASE_URL is not configured on Shawshank' }), 'application/json; charset=utf-8');
  const date = String(url.searchParams.get('date') ?? '2026-09-04');
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) return send(res, 400, JSON.stringify({ error: 'date must be YYYY-MM-DD' }), 'application/json; charset=utf-8');
  // Sep 4, 2026 is EDT (UTC-4). This diagnostic is deliberately scoped to the incident date.
  const startMs = Date.parse(date + 'T04:00:00Z');
  const endMs = startMs + 24 * 60 * 60_000;
  try {
    const { regular, candidate } = await withReadOnlyDb(async (client) => {
      const regularResult = await client.query(\`
        SELECT id,ticker,side,martingale_step,requested_contracts,filled_contracts,
               settlement_result,outcome,created_at_ms,settled_at_ms
        FROM eth_martingale_orders
        WHERE created_at_ms >= $1 AND created_at_ms < $2
        ORDER BY created_at_ms ASC
      \`, [startMs, endMs]);
      const candidateResult = await client.query(\`
        SELECT id,ticker,side,martingale_step,requested_contracts,filled_contracts,
               limit_price_cents,effective_wager_cents,settlement_result,status,
               created_at_ms,settled_at_ms
        FROM eth420_candidate_live_orders
        WHERE created_at_ms >= $1 AND created_at_ms < $2
        ORDER BY created_at_ms ASC
      \`, [startMs, endMs]);
      return { regular: regularResult.rows, candidate: candidateResult.rows };
    });
    const rows = [
      ...regular.map((row) => ({
        road: 'regular', id: String(row.id ?? ''), ticker: String(row.ticker ?? ''), side: String(row.side ?? ''),
        step: row.martingale_step == null ? null : Number(row.martingale_step),
        wagerCents: row.requested_contracts == null ? null : Math.round(Number(row.requested_contracts) * 50),
        requestedContracts: row.requested_contracts == null ? null : Number(row.requested_contracts),
        filledContracts: row.filled_contracts == null ? null : Number(row.filled_contracts),
        settlementResult: row.settlement_result == null ? null : String(row.settlement_result),
        status: row.outcome == null ? null : String(row.outcome), createdAtMs: Number(row.created_at_ms), settledAtMs: row.settled_at_ms == null ? null : Number(row.settled_at_ms),
      })),
      ...candidate.map((row) => ({
        road: 'candidate', id: String(row.id ?? ''), ticker: String(row.ticker ?? ''), side: String(row.side ?? ''),
        step: row.martingale_step == null ? null : Number(row.martingale_step),
        wagerCents: row.effective_wager_cents == null ? null : Number(row.effective_wager_cents),
        requestedContracts: row.requested_contracts == null ? null : Number(row.requested_contracts),
        filledContracts: row.filled_contracts == null ? null : Number(row.filled_contracts),
        settlementResult: row.settlement_result == null ? null : String(row.settlement_result),
        status: row.status == null ? null : String(row.status), createdAtMs: Number(row.created_at_ms), settledAtMs: row.settled_at_ms == null ? null : Number(row.settled_at_ms),
      })),
    ].sort((a, b) => a.createdAtMs - b.createdAtMs);
    const oneTwenties = rows.filter((row) => row.wagerCents === 12000);
    const audits = oneTwenties.map((row) => {
      const index = rows.indexOf(row);
      const next = rows.slice(index + 1).find((candidateRow) => candidateRow.createdAtMs > row.createdAtMs) ?? null;
      const side = row.side.toLowerCase();
      const result = String(row.settlementResult ?? '').toLowerCase();
      return { row, lost: !!result && result !== side, nextOrder: next };
    });
    const response = { available: true, date, startMs, endMs, count: rows.length, rows, oneTwentyAudits: audits };
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify(response, null, 2), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Sequence audit diagnostic failed', error);
    return send(res, 500, JSON.stringify({ available: false, error: String(error?.message ?? 'Sequence audit diagnostic failed') }), 'application/json; charset=utf-8');
  }
}
`;
if (!server.includes('async function sequenceAuditDiagnostics')) {
  if (!server.includes(functionAnchor)) throw new Error('sequence audit function anchor not found');
  server = server.replace(functionAnchor, functionBlock + functionAnchor);
}

const routeAnchor = "  if (url.pathname === '/api/diagnostics/back-flips.csv') return void backFlipDiagnostics(req, res, true);";
const routeLine = "  if (url.pathname === '/api/diagnostics/sequence-audit') return void sequenceAuditDiagnostics(req, res, url);";
if (!server.includes(routeLine)) {
  if (!server.includes(routeAnchor)) throw new Error('sequence audit route anchor not found');
  server = server.replace(routeAnchor, routeAnchor + '\n' + routeLine);
}

fs.writeFileSync(serverPath, server);
