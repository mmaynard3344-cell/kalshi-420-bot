import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const port = Number(process.env.PORT ?? 3000);
const graceBase = (process.env.GRACE_API_BASE_URL ?? '').replace(/\/$/, '');
const graceToken = process.env.GRACE_TRADE_API_TOKEN ?? '';
const databaseUrl = process.env.DATABASE_URL ?? '';
const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist', 'public');

if (!graceBase) throw new Error('GRACE_API_BASE_URL must be set');
if (!graceToken) throw new Error('GRACE_TRADE_API_TOKEN must be set');

const ALLOWED_READ_PATHS = new Set([
  '/api/trade/balance',
  '/api/trade/status',
  '/api/trade/positions',
  '/api/trade/martingale',
  '/api/trade/analytics/eth420-candidate-history',
  '/api/trade/analytics/eth420-live-market',
  '/api/trade/analytics/boundary-discovery',
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

async function proxyRead(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }
  if (!ALLOWED_READ_PATHS.has(url.pathname)) {
    send(res, 404, 'Not found');
    return;
  }

  try {
    const upstream = await fetch(`${graceBase}${url.pathname}${url.search}`, {
      method: req.method,
      headers: {
        'x-trade-token': graceToken,
        'accept': 'application/json',
      },
      redirect: 'manual',
    });

    const body = req.method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer());
    const headers = {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    res.writeHead(upstream.status, headers);
    res.end(body);
  } catch (error) {
    console.error('Grace read proxy failed', error);
    send(res, 502, JSON.stringify({ error: 'Grace API unavailable' }), 'application/json; charset=utf-8');
  }
}

let dbPool = null;
function getDbPool() {
  if (!databaseUrl) return null;
  if (dbPool) return dbPool;
  const requireFromDb = createRequire(new URL('../../lib/db/package.json', import.meta.url));
  const { Pool } = requireFromDb('pg');
  dbPool = new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 3_000 });
  return dbPool;
}

async function loadBackFlipRows() {
  const pool = getDbPool();
  if (!pool) throw new Error('DATABASE_URL is not configured on Shawshank');
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const result = await client.query(`
      SELECT
        source_candidate_order_id,
        source_ticker,
        missed_side,
        source_open_time_ms,
        target_open_time_ms,
        status,
        armed_at_ms
      FROM eth420_candidate_back_flip_overrides
      ORDER BY armed_at_ms DESC
      LIMIT 50
    `);
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      sourceCandidateOrderId: String(row.source_candidate_order_id ?? ''),
      sourceTicker: String(row.source_ticker ?? ''),
      missedSide: String(row.missed_side ?? ''),
      sourceOpenTimeMs: Number(row.source_open_time_ms),
      targetOpenTimeMs: Number(row.target_open_time_ms),
      status: String(row.status ?? ''),
      armedAtMs: Number(row.armed_at_ms),
    }));
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* best effort */ }
    }
    throw error;
  } finally {
    client?.release();
  }
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function backFlipDiagnostics(req, res, asCsv = false) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }
  if (!databaseUrl) {
    send(res, 503, asCsv ? 'DATABASE_URL is not configured on Shawshank\n' : JSON.stringify({ available: false, error: 'DATABASE_URL is not configured on Shawshank', rows: [] }), asCsv ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
    return;
  }

  try {
    const rows = await loadBackFlipRows();
    if (req.method === 'HEAD') {
      send(res, 200, '', asCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
      return;
    }
    if (asCsv) {
      const header = ['source_candidate_order_id','source_ticker','missed_side','source_open_time_ms','target_open_time_ms','status','armed_at_ms'];
      const lines = rows.map((row) => [
        row.sourceCandidateOrderId,
        row.sourceTicker,
        row.missedSide,
        row.sourceOpenTimeMs,
        row.targetOpenTimeMs,
        row.status,
        row.armedAtMs,
      ].map(csvEscape).join(','));
      send(
        res,
        200,
        `${header.join(',')}\n${lines.join('\n')}\n`,
        'text/csv; charset=utf-8',
        { 'content-disposition': 'attachment; filename="eth420-back-flip-diagnostics.csv"' },
      );
      return;
    }
    send(res, 200, JSON.stringify({ available: true, rows, count: rows.length }), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Back Flip diagnostic read failed', error);
    send(res, 500, asCsv ? 'Back Flip diagnostic read failed\n' : JSON.stringify({ available: false, error: 'Back Flip diagnostic read failed', rows: [] }), asCsv ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  }
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  if (url.pathname === '/healthz') {
    send(res, 200, 'ok');
    return;
  }

  let relative = decodeURIComponent(url.pathname);
  if (relative === '/') relative = '/index.html';
  relative = normalize(relative).replace(/^([.][.][/\\])+/, '');
  let filePath = join(root, relative);

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(root, 'index.html');
  }

  if (!existsSync(filePath)) {
    send(res, 404, 'UI build not found');
    return;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/diagnostics/back-flips') {
    void backFlipDiagnostics(req, res, false);
    return;
  }
  if (url.pathname === '/api/diagnostics/back-flips.csv') {
    void backFlipDiagnostics(req, res, true);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    void proxyRead(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Read-only ETH 420 operator UI listening on ${port}`);
});
