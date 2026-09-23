import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

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
  '/api/trade/orders',
  '/api/trade/fills',
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

async function graceJson(path) {
  const upstream = await fetch(`${graceBase}${path}`, {
    method: 'GET',
    headers: { 'x-trade-token': graceToken, accept: 'application/json' },
    redirect: 'manual',
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`Grace ${path} returned ${upstream.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const READ_CACHE_TTL_MS = 30_000;
const READ_CACHE_STALE_MS = 5 * 60_000;
const readCache = new Map();
const readInflight = new Map();

function cacheableRead(url) {
  return url.pathname === '/api/trade/fills' || url.pathname === '/api/trade/orders';
}

async function refreshReadCache(url) {
  const key = url.pathname + url.search;
  if (readInflight.has(key)) return readInflight.get(key);
  const work = (async () => {
    const upstream = await fetch(`${graceBase}${key}`, {
      method: 'GET',
      headers: { 'x-trade-token': graceToken, accept: 'application/json' },
      redirect: 'manual',
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const value = {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      body,
      gzipBody: gzipSync(body, { level: 6 }),
      updatedAt: Date.now(),
    };
    if (upstream.ok) readCache.set(key, value);
    return value;
  })().finally(() => readInflight.delete(key));
  readInflight.set(key, work);
  return work;
}

function sendCachedRead(req, res, value, cacheStatus) {
  const acceptsGzip = String(req.headers['accept-encoding'] ?? '').includes('gzip');
  const body = acceptsGzip ? value.gzipBody : value.body;
  res.writeHead(value.status, {
    'content-type': value.contentType,
    'cache-control': 'no-store',
    'content-length': body.length,
    ...(acceptsGzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
    'x-content-type-options': 'nosniff',
    'x-shawshank-cache': cacheStatus,
  });
  res.end(body);
}

async function proxyRead(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!ALLOWED_READ_PATHS.has(url.pathname)) return send(res, 404, 'Not found');
  try {
    if (req.method === 'GET' && cacheableRead(url)) {
      const key = url.pathname + url.search;
      const cached = readCache.get(key);
      const age = cached ? Date.now() - cached.updatedAt : Infinity;
      if (cached && age <= READ_CACHE_TTL_MS) return sendCachedRead(req, res, cached, 'hit');
      if (cached && age <= READ_CACHE_STALE_MS) {
        void refreshReadCache(url).catch((error) => console.error('Grace cache refresh failed', error));
        return sendCachedRead(req, res, cached, 'stale');
      }
      return sendCachedRead(req, res, await refreshReadCache(url), 'miss');
    }

    const upstream = await fetch(`${graceBase}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { 'x-trade-token': graceToken, accept: 'application/json' },
      redirect: 'manual',
    });
    const body = req.method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch (error) {
    console.error('Grace read proxy failed', error);
    send(res, 502, JSON.stringify({ error: 'Grace API unavailable' }), 'application/json; charset=utf-8');
  }
}

async function exchangeTickerDiagnostics(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const ticker = String(url.searchParams.get('ticker') ?? '').trim();
  if (!/^KXETH15M-[A-Z0-9-]+$/.test(ticker)) {
    return send(res, 400, JSON.stringify({ error: 'A valid KXETH15M ticker is required' }), 'application/json; charset=utf-8');
  }
  try {
    const [ordersPayload, fillsPayload] = await Promise.all([
      graceJson('/api/trade/orders?limit=100'),
      graceJson('/api/trade/fills?limit=1000'),
    ]);
    const allOrders = Array.isArray(ordersPayload?.orders) ? ordersPayload.orders : [];
    const allFills = Array.isArray(fillsPayload?.fills) ? fillsPayload.fills : [];
    const orders = allOrders.filter((row) => row && typeof row === 'object' && row.ticker === ticker);
    const fills = allFills.filter((row) => row && typeof row === 'object' && row.ticker === ticker);
    const clientOrderIds = [...new Set(orders.map((row) => row.client_order_id ?? row.clientOrderId).filter(Boolean).map(String))];
    const orderIds = [...new Set(orders.map((row) => row.order_id ?? row.orderId).filter(Boolean).map(String))];
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    send(res, 200, JSON.stringify({
      ticker,
      orderCount: orders.length,
      fillCount: fills.length,
      distinctClientOrderIds: clientOrderIds,
      distinctOrderIds: orderIds,
      duplicateSubmissionEvidence: orderIds.length > 1 || clientOrderIds.length > 1,
      orders,
      fills,
    }, null, 2), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Exchange ticker diagnostic read failed', error);
    send(res, 502, JSON.stringify({ error: 'Exchange ticker diagnostic read failed' }), 'application/json; charset=utf-8');
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

async function withReadOnlyDb(work) {
  const pool = getDbPool();
  if (!pool) throw new Error('DATABASE_URL is not configured on Shawshank');
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch { /* best effort */ } }
    throw error;
  } finally {
    client?.release();
  }
}


async function serviceOwnershipDiagnostics(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  try {
    const rows = await withReadOnlyDb(async (client) => {
      const out = [];
      let savepointSeq = 0;
      const safe = async (service, sqlText, params = []) => {
        const sp = 'service_owner_' + (++savepointSeq);
        await client.query('SAVEPOINT ' + sp);
        try {
          const result = await client.query(sqlText, params);
          await client.query('RELEASE SAVEPOINT ' + sp);
          for (const row of result.rows ?? []) {
            const orderId = row.order_id == null ? '' : String(row.order_id);
            const clientOrderId = row.client_order_id == null ? '' : String(row.client_order_id);
            if (orderId || clientOrderId) out.push({ orderId, clientOrderId, service });
          }
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT ' + sp);
          await client.query('RELEASE SAVEPOINT ' + sp);
          // One absent service table must never poison the rest of the
          // ownership scan.
          console.warn('service ownership read skipped', service, String(error?.message ?? error));
        }
      };

      await safe('A · Regular',
        `SELECT kalshi_order_id AS order_id, client_order_id
           FROM eth_martingale_orders
          WHERE kalshi_order_id IS NOT NULL`);

      {
        const sp = 'service_owner_' + (++savepointSeq);
        try {
          await client.query('SAVEPOINT ' + sp);
          const candidate = await client.query(`
          SELECT kalshi_order_id AS order_id, id AS client_order_id, origin_service
            FROM eth420_candidate_live_orders
           WHERE kalshi_order_id IS NOT NULL
          UNION ALL
          SELECT original_primary_kalshi_order_id AS order_id, id AS client_order_id, origin_service
            FROM eth420_candidate_live_orders
           WHERE original_primary_kalshi_order_id IS NOT NULL
             AND original_primary_kalshi_order_id <> kalshi_order_id`);
        await client.query('RELEASE SAVEPOINT ' + sp);
        const candidateService = () => 'Legacy 420';
          for (const row of candidate.rows ?? []) {
            const orderId = row.order_id == null ? '' : String(row.order_id);
            const clientOrderId = row.client_order_id == null ? '' : String(row.client_order_id);
            if (orderId || clientOrderId) out.push({
              orderId, clientOrderId, service: candidateService(row.origin_service),
              originService: row.origin_service == null ? null : String(row.origin_service),
            });
          }
        } catch (error) {
          try { await client.query('ROLLBACK TO SAVEPOINT ' + sp); } catch {}
          try { await client.query('RELEASE SAVEPOINT ' + sp); } catch {}
          console.warn('service ownership read skipped candidate', String(error?.message ?? error));
        }
      }

      {
        const sp = 'service_owner_' + (++savepointSeq);
        await client.query('SAVEPOINT ' + sp);
        try {
          const big = await client.query(`
            SELECT kalshi_order_id AS order_id, id AS client_order_id, strategy
              FROM eth_big_bet_orders
             WHERE kalshi_order_id IS NOT NULL`);
          await client.query('RELEASE SAVEPOINT ' + sp);
          const map = {
            jump: 'B · Jump',
            reversal: 'C · Reversal',
            breakout_reversal: 'D · Breakout Reversal',
            downfade_p80_p90: 'E · Downfade',
            downfade_p90_p95: 'F · Downfade',
            probe_g: 'G · Probe',
            downfade_p95_p99: 'H · Ashley',
            ash_v2_i: 'I · Ash V2',
          };
          for (const row of big.rows ?? []) {
            const service = map[String(row.strategy ?? '')];
            if (!service) continue;
            const orderId = row.order_id == null ? '' : String(row.order_id);
            const clientOrderId = row.client_order_id == null ? '' : String(row.client_order_id);
            if (orderId || clientOrderId) out.push({ orderId, clientOrderId, service });
          }
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT ' + sp);
          await client.query('RELEASE SAVEPOINT ' + sp);
          console.warn('service ownership read skipped B-I', String(error?.message ?? error));
        }
      }

      await safe('G · Probe',
        `SELECT kalshi_order_id AS order_id, client_order_id
           FROM eth_g_streak_reversal_orders
          WHERE kalshi_order_id IS NOT NULL`);

      await safe('J · Jackpot',
        `SELECT j_kalshi_order_id AS order_id, j_client_order_id AS client_order_id
           FROM jackpot_attempts
          WHERE j_kalshi_order_id IS NOT NULL OR j_client_order_id IS NOT NULL`);

      await safe('K · Kamakazee',
        `SELECT kalshi_order_id AS order_id, client_order_id
           FROM kamakazee_orders
          WHERE kalshi_order_id IS NOT NULL OR client_order_id IS NOT NULL`);

      return out;
    });
    const counts = rows.reduce((acc, row) => {
      acc[row.service] = (acc[row.service] ?? 0) + 1;
      return acc;
    }, {});
    console.log('SERVICE_OWNERSHIP_COUNTS ' + JSON.stringify({ count: rows.length, counts }));
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify({ rows, count: rows.length, counts }), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Service ownership diagnostic read failed', error);
    return send(res, 500, JSON.stringify({ error: 'Service ownership unavailable' }), 'application/json; charset=utf-8');
  }
}

async function candidateLifecycleDiagnostics(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const ticker = String(url.searchParams.get('ticker') ?? '').trim();
  if (!/^KXETH15M-[A-Z0-9-]+$/.test(ticker)) {
    return send(res, 400, JSON.stringify({ error: 'A valid KXETH15M ticker is required' }), 'application/json; charset=utf-8');
  }
  try {
    const result = await withReadOnlyDb((client) => client.query(`
      SELECT id,ticker,status,side,requested_contracts,filled_contracts,settlement_result,
             market_open_time_ms,created_at_ms,finalized_at_ms,settled_at_ms,updated_at_ms,
             kalshi_order_id,last_recovery_outcome,last_recovery_attempt_at_ms
      FROM eth420_candidate_live_orders
      WHERE ticker = $1
      ORDER BY created_at_ms ASC
    `, [ticker]));
    const rows = result.rows.map((row) => ({
      id: String(row.id ?? ''), ticker: String(row.ticker ?? ''), status: String(row.status ?? ''), side: String(row.side ?? ''),
      requestedContracts: row.requested_contracts == null ? null : Number(row.requested_contracts),
      filledContracts: row.filled_contracts == null ? null : Number(row.filled_contracts),
      settlementResult: row.settlement_result == null ? null : String(row.settlement_result),
      marketOpenTimeMs: row.market_open_time_ms == null ? null : Number(row.market_open_time_ms),
      createdAtMs: row.created_at_ms == null ? null : Number(row.created_at_ms),
      finalizedAtMs: row.finalized_at_ms == null ? null : Number(row.finalized_at_ms),
      settledAtMs: row.settled_at_ms == null ? null : Number(row.settled_at_ms),
      updatedAtMs: row.updated_at_ms == null ? null : Number(row.updated_at_ms),
      kalshiOrderId: row.kalshi_order_id == null ? null : String(row.kalshi_order_id),
      lastRecoveryOutcome: row.last_recovery_outcome == null ? null : String(row.last_recovery_outcome),
      lastRecoveryAttemptAtMs: row.last_recovery_attempt_at_ms == null ? null : Number(row.last_recovery_attempt_at_ms),
    }));
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    send(res, 200, JSON.stringify({
      ticker,
      note: 'finalizedAtMs is the bot first durable observation of the official Kalshi result; settledAtMs is the completed candidate settlement write.',
      rows,
      count: rows.length,
    }, null, 2), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Candidate lifecycle diagnostic read failed', error);
    send(res, 500, JSON.stringify({ error: String(error?.message ?? 'Candidate lifecycle diagnostic read failed') }), 'application/json; charset=utf-8');
  }
}

const ETH_WINDOW_MS = 15 * 60_000;
function nextBoundaryFromCreated(createdAtMs) {
  return Math.floor(createdAtMs / ETH_WINDOW_MS) * ETH_WINDOW_MS + ETH_WINDOW_MS;
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
function latencySummary(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    maxMs: values.length ? Math.max(...values) : null,
    under10s: values.filter((v) => v <= 10_000).length,
    under20s: values.filter((v) => v <= 20_000).length,
    over45s: values.filter((v) => v > 45_000).length,
  };
}

async function settlementLatencyDiagnostics(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const requestedHours = Number(url.searchParams.get('hours') ?? 48);
  const hours = Number.isFinite(requestedHours) ? Math.max(1, Math.min(168, Math.trunc(requestedHours))) : 48;
  const cutoffMs = Date.now() - hours * 60 * 60_000;
  try {
    const { regularResult, candidateResult } = await withReadOnlyDb(async (client) => {
      const regularResult = await client.query(`
        SELECT id,ticker,side,outcome,filled_contracts,settlement_result,created_at_ms,settled_at_ms,updated_at_ms
        FROM eth_martingale_orders
        WHERE ticker LIKE 'KXETH15M-%' AND settled_at_ms IS NOT NULL AND settled_at_ms >= $1
        ORDER BY settled_at_ms DESC
        LIMIT 500
      `, [cutoffMs]);
      const candidateResult = await client.query(`
        SELECT id,ticker,status,side,filled_contracts,settlement_result,market_open_time_ms,
               created_at_ms,finalized_at_ms,settled_at_ms,updated_at_ms
        FROM eth420_candidate_live_orders
        WHERE settled_at_ms IS NOT NULL AND settled_at_ms >= $1
        ORDER BY settled_at_ms DESC
        LIMIT 500
      `, [cutoffMs]);
      return { regularResult, candidateResult };
    });

    const regular = regularResult.rows.map((row) => {
      const createdAtMs = Number(row.created_at_ms);
      const boundaryAtMs = nextBoundaryFromCreated(createdAtMs);
      const settledAtMs = Number(row.settled_at_ms);
      return {
        engine: 'regular_eth', id: String(row.id ?? ''), ticker: String(row.ticker ?? ''), side: String(row.side ?? ''),
        outcome: row.outcome == null ? null : String(row.outcome),
        filledContracts: row.filled_contracts == null ? null : Number(row.filled_contracts),
        settlementResult: row.settlement_result == null ? null : String(row.settlement_result),
        createdAtMs, boundaryAtMs, finalizedAtMs: null, settledAtMs,
        boundaryToFinalizedMs: null,
        boundaryToSettledMs: settledAtMs - boundaryAtMs,
      };
    });
    const candidate = candidateResult.rows.map((row) => {
      const createdAtMs = Number(row.created_at_ms);
      const openTimeMs = row.market_open_time_ms == null ? null : Number(row.market_open_time_ms);
      const boundaryAtMs = Number.isFinite(openTimeMs) ? openTimeMs + ETH_WINDOW_MS : nextBoundaryFromCreated(createdAtMs);
      const finalizedAtMs = row.finalized_at_ms == null ? null : Number(row.finalized_at_ms);
      const settledAtMs = Number(row.settled_at_ms);
      return {
        engine: 'eth420_candidate', id: String(row.id ?? ''), ticker: String(row.ticker ?? ''), side: String(row.side ?? ''),
        status: row.status == null ? null : String(row.status),
        filledContracts: row.filled_contracts == null ? null : Number(row.filled_contracts),
        settlementResult: row.settlement_result == null ? null : String(row.settlement_result),
        createdAtMs, boundaryAtMs, finalizedAtMs, settledAtMs,
        boundaryToFinalizedMs: finalizedAtMs == null ? null : finalizedAtMs - boundaryAtMs,
        boundaryToSettledMs: settledAtMs - boundaryAtMs,
      };
    });
    const all = [...regular, ...candidate].sort((a, b) => b.settledAtMs - a.settledAtMs);
    const response = {
      generatedAtMs: Date.now(), hours, cutoffMs,
      notes: [
        'Regular ETH historically stores settledAtMs but not a separate first-official-result timestamp.',
        'ETH420 boundaryToFinalizedMs measures first durable observation of the official result; boundaryToSettledMs measures completed settlement.',
        'Boundary is the exact 15-minute close derived from candidate market_open_time_ms or the order creation window.',
      ],
      summary: {
        allBoundaryToSettled: latencySummary(all, 'boundaryToSettledMs'),
        regularBoundaryToSettled: latencySummary(regular, 'boundaryToSettledMs'),
        candidateBoundaryToFinalized: latencySummary(candidate, 'boundaryToFinalizedMs'),
        candidateBoundaryToSettled: latencySummary(candidate, 'boundaryToSettledMs'),
      },
      rows: all,
      count: all.length,
    };
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    send(res, 200, JSON.stringify(response, null, 2), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Settlement latency diagnostic read failed', error);
    send(res, 500, JSON.stringify({ error: String(error?.message ?? 'Settlement latency diagnostic read failed') }), 'application/json; charset=utf-8');
  }
}

async function loadBackFlipRows() {
  return withReadOnlyDb(async (client) => {
    const result = await client.query(`
      SELECT source_candidate_order_id,source_ticker,missed_side,source_open_time_ms,target_open_time_ms,status,armed_at_ms
      FROM eth420_candidate_back_flip_overrides
      ORDER BY armed_at_ms DESC
      LIMIT 50
    `);
    return result.rows.map((row) => ({
      sourceCandidateOrderId: String(row.source_candidate_order_id ?? ''), sourceTicker: String(row.source_ticker ?? ''),
      missedSide: String(row.missed_side ?? ''), sourceOpenTimeMs: Number(row.source_open_time_ms),
      targetOpenTimeMs: Number(row.target_open_time_ms), status: String(row.status ?? ''), armedAtMs: Number(row.armed_at_ms),
    }));
  });
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function backFlipDiagnostics(req, res, asCsv = false) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!databaseUrl) {
    return send(res, 503,
      asCsv ? 'DATABASE_URL is not configured on Shawshank\n' : JSON.stringify({ available: false, error: 'DATABASE_URL is not configured on Shawshank', rows: [] }),
      asCsv ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  }
  try {
    const rows = await loadBackFlipRows();
    if (req.method === 'HEAD') return send(res, 200, '', asCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    if (asCsv) {
      const header = ['source_candidate_order_id','source_ticker','missed_side','source_open_time_ms','target_open_time_ms','status','armed_at_ms'];
      const lines = rows.map((row) => [row.sourceCandidateOrderId,row.sourceTicker,row.missedSide,row.sourceOpenTimeMs,row.targetOpenTimeMs,row.status,row.armedAtMs].map(csvEscape).join(','));
      return send(res, 200, `${header.join(',')}\n${lines.join('\n')}\n`, 'text/csv; charset=utf-8', {
        'content-disposition': 'attachment; filename="eth420-back-flip-diagnostics.csv"',
      });
    }
    send(res, 200, JSON.stringify({ available: true, rows, count: rows.length }), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Back Flip diagnostic read failed', error);
    send(res, 500, asCsv ? 'Back Flip diagnostic read failed\n' : JSON.stringify({ available: false, error: 'Back Flip diagnostic read failed', rows: [] }), asCsv ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  }
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (url.pathname === '/healthz') return send(res, 200, 'ok');
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/') relative = '/index.html';
  relative = normalize(relative).replace(/^([.][.][/\\])+/, '');
  let filePath = join(root, relative);
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(root, 'index.html');
  if (!existsSync(filePath)) return send(res, 404, 'UI build not found');
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/diagnostics/service-ownership') return void serviceOwnershipDiagnostics(req, res);
  if (url.pathname === '/api/diagnostics/exchange-ticker') return void exchangeTickerDiagnostics(req, res, url);
  if (url.pathname === '/api/diagnostics/candidate-lifecycle') return void candidateLifecycleDiagnostics(req, res, url);
  if (url.pathname === '/api/diagnostics/settlement-latency') return void settlementLatencyDiagnostics(req, res, url);
  if (url.pathname === '/api/diagnostics/back-flips') return void backFlipDiagnostics(req, res, false);
  if (url.pathname === '/api/diagnostics/back-flips.csv') return void backFlipDiagnostics(req, res, true);
  if (url.pathname.startsWith('/api/')) return void proxyRead(req, res, url);
  serveStatic(req, res, url);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Read-only ETH 420 operator UI listening on ${port}`);
  for (const path of ['/api/trade/fills?limit=10000', '/api/trade/orders?limit=1000']) {
    const url = new URL(path, 'http://shawshank.local');
    void refreshReadCache(url).catch((error) => console.error('Dashboard cache warm failed', path, error));
  }
});
