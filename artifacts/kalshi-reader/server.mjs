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
        const candidateService = (origin) => {
          const s = String(origin ?? '').toLowerCase();
          if (s === 'kalshi-420-bot' || s === 'martingale') return 'A · Regular';
          if (s === 'eth-jump-service' || s === 'jump') return 'B · Jump';
          if (s === 'eth-reversal-service' || s === 'reversal') return 'C · Reversal';
          if (s === 'eth-breakout-reversal' || s === 'eth-breakout-reversal-service') return 'D · Breakout Reversal';
          if (s === 'eth-downfade-e' || s === 'downfade_e') return 'E · Downfade';
          if (s === 'eth-downfade-f' || s === 'downfade_f') return 'F · Downfade';
          if (s === 'eth-downfade-g' || s === 'downfade_g') return 'G · Streak Reversal';
          if (s === 'ashley' || s === 'eth-ashley') return 'H · Ashley';
          return 'Unattributed';
        };
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

function easternDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const g = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return g('year') + '-' + g('month') + '-' + g('day');
}

async function serviceLedgerTodayDiagnostics(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const easternDate = easternDateKey();
  try {
    const data = await withReadOnlyDb(async (client) => {
      const a = await client.query(`
        SELECT COUNT(*)::int AS n,
               COALESCE(SUM(
                 CASE WHEN settlement_result = side
                   THEN (COALESCE(filled_contracts,0)::numeric - COALESCE(actual_notional_dollars,0)::numeric - COALESCE(actual_fee_dollars,0)::numeric)
                   ELSE -(COALESCE(actual_notional_dollars,0)::numeric + COALESCE(actual_fee_dollars,0)::numeric)
                 END
               ),0)::numeric AS pnl_dollars
        FROM eth_martingale_orders
        WHERE eastern_date=$1
          AND settlement_result IN ('yes','no')
          AND COALESCE(filled_contracts,0)::numeric > 0
      `, [easternDate]);

      const candidate = await client.query(`
        SELECT origin_service,
               COUNT(*)::int AS n,
               COALESCE(SUM(realized_pnl_delta_cents),0)::int AS pnl_cents
        FROM eth420_candidate_live_orders
        WHERE eastern_date=$1
          AND realized_pnl_delta_cents IS NOT NULL
        GROUP BY origin_service
      `, [easternDate]);

      const big = await client.query(`
        SELECT strategy, COUNT(*)::int AS n,
               COALESCE(SUM(realized_pnl_cents),0)::int AS pnl_cents
        FROM eth_big_bet_orders
        WHERE to_char(to_timestamp(created_at_ms/1000.0) AT TIME ZONE 'America/New_York','YYYY-MM-DD')=$1
          AND realized_pnl_cents IS NOT NULL
        GROUP BY strategy
      `, [easternDate]);

      const rows = [];
      const aDollars = Number(a.rows?.[0]?.pnl_dollars ?? 0);
      const aCount = Number(a.rows?.[0]?.n ?? 0);
      rows.push({ service:'A · Regular', settled:aCount, pnlCents:Math.round(aDollars*100) });

      const originMap = {
        'kalshi-420-bot':'A · Regular',
        'martingale':'A · Regular',
        'eth-jump-service':'B · Jump',
        'jump':'B · Jump',
        'eth-reversal-service':'C · Reversal',
        'reversal':'C · Reversal',
        'eth-breakout-reversal':'D · Breakout Reversal',
        'eth-breakout-reversal-service':'D · Breakout Reversal',
        'eth-downfade-e':'E · Downfade',
        'downfade_e':'E · Downfade',
        'eth-downfade-f':'F · Downfade',
        'downfade_f':'F · Downfade',
      };
      for (const row of candidate.rows ?? []) {
        const service = originMap[String(row.origin_service ?? '').toLowerCase()] ?? 'Unattributed';
        rows.push({ service, settled:Number(row.n ?? 0), pnlCents:Number(row.pnl_cents ?? 0) });
      }
      const strategyMap = {
        jump:'B · Jump', reversal:'C · Reversal', breakout_reversal:'D · Breakout Reversal',
        downfade_p80_p90:'E · Downfade', downfade_p90_p95:'F · Downfade',
        probe_g:'G · Streak Reversal', downfade_p95_p99:'H · Ashley', ash_v2_i:'I · Ash V2',
      };
      for (const row of big.rows ?? []) {
        const service = strategyMap[String(row.strategy ?? '')];
        if (service) rows.push({ service, settled:Number(row.n ?? 0), pnlCents:Number(row.pnl_cents ?? 0) });
      }
      const combined = new Map();
      for (const row of rows) {
        const prior = combined.get(row.service) ?? {service:row.service, settled:0, pnlCents:0};
        prior.settled += row.settled;
        prior.pnlCents += row.pnlCents;
        combined.set(row.service, prior);
      }
      const byService = [...combined.values()];
      const totalPnlCents = byService.reduce((s,r)=>s+r.pnlCents,0);
      const settledCount = byService.reduce((s,r)=>s+r.settled,0);
      return { easternDate, totalPnlCents, settledCount, byService };
    });
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Service ledger today read failed', error);
    return send(res, 500, JSON.stringify({ error:'Service ledger today unavailable' }), 'application/json; charset=utf-8');
  }
}


async function shadowPerformanceDiagnostics(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  try {
    const data = await withReadOnlyDb(async (client) => {
      const tableExists = async (name) => {
        const q = await client.query(
          \`SELECT to_regclass($1) IS NOT NULL AS present\`,
          ['public.' + name],
        );
        return q.rows?.[0]?.present === true;
      };

      const [a2Exists, lExists] = await Promise.all([
        tableExists('a2_execution_intents'),
        tableExists('l_sweep_reclaim_dry_run_intents'),
      ]);

      let a2Rows = [];
      let lRows = [];

      if (a2Exists) {
        const q = await client.query(\`
          SELECT id, signal_id, market_ticker, client_order_id, state,
                 executable_yes_price_cents, quantity, max_notional_cents,
                 filled_quantity, fill_cost_cents, fill_fee_cents,
                 terminal_reason, settlement_result, realized_pnl_cents,
                 created_at_ms, updated_at_ms, settled_at_ms
            FROM a2_execution_intents
           ORDER BY created_at_ms DESC
           LIMIT 100
        \`);
        a2Rows = q.rows.map((row) => ({
          strategy: 'A2',
          id: String(row.id ?? ''),
          signalId: String(row.signal_id ?? ''),
          ticker: String(row.market_ticker ?? ''),
          clientOrderId: String(row.client_order_id ?? ''),
          state: String(row.state ?? ''),
          entryPriceCents: row.executable_yes_price_cents == null ? null : Number(row.executable_yes_price_cents),
          contracts: row.quantity == null ? null : Number(row.quantity),
          principalCents: row.max_notional_cents == null ? null : Number(row.max_notional_cents),
          filledContracts: row.filled_quantity == null ? null : Number(row.filled_quantity),
          fillCostCents: row.fill_cost_cents == null ? null : Number(row.fill_cost_cents),
          fillFeeCents: row.fill_fee_cents == null ? null : Number(row.fill_fee_cents),
          terminalReason: row.terminal_reason == null ? null : String(row.terminal_reason),
          settlementResult: row.settlement_result == null ? null : String(row.settlement_result),
          pnlCents: row.realized_pnl_cents == null ? null : Number(row.realized_pnl_cents),
          createdAtMs: Number(row.created_at_ms ?? 0),
          updatedAtMs: Number(row.updated_at_ms ?? 0),
          settledAtMs: row.settled_at_ms == null ? null : Number(row.settled_at_ms),
        }));
      }

      if (lExists) {
        const q = await client.query(\`
          SELECT id, source_open_time_ms, destination_ticker, state,
                 executable_yes_price_cents, contracts, principal_cents,
                 fee_headroom_cents, requested_risk_cents,
                 settlement_result, simulated_pnl_cents,
                 created_at_ms, updated_at_ms
            FROM l_sweep_reclaim_dry_run_intents
           ORDER BY created_at_ms DESC
           LIMIT 100
        \`);
        lRows = q.rows.map((row) => ({
          strategy: 'L',
          id: String(row.id ?? ''),
          signalId: String(row.id ?? ''),
          ticker: String(row.destination_ticker ?? ''),
          clientOrderId: String(row.id ?? ''),
          state: String(row.state ?? ''),
          entryPriceCents: row.executable_yes_price_cents == null ? null : Number(row.executable_yes_price_cents),
          contracts: row.contracts == null ? null : Number(row.contracts),
          principalCents: row.principal_cents == null ? null : Number(row.principal_cents),
          feeHeadroomCents: row.fee_headroom_cents == null ? null : Number(row.fee_headroom_cents),
          requestedRiskCents: row.requested_risk_cents == null ? null : Number(row.requested_risk_cents),
          terminalReason: null,
          settlementResult: row.settlement_result == null ? null : String(row.settlement_result),
          pnlCents: row.simulated_pnl_cents == null ? null : Number(row.simulated_pnl_cents),
          createdAtMs: Number(row.created_at_ms ?? 0),
          updatedAtMs: Number(row.updated_at_ms ?? 0),
          settledAtMs: String(row.state ?? '') === 'SETTLED' ? Number(row.updated_at_ms ?? 0) : null,
        }));
      }

      const summarize = (strategy, rows, available) => {
        const settled = rows.filter((row) => row.settlementResult === 'yes' || row.settlementResult === 'no');
        const wins = settled.filter((row) => row.settlementResult === 'yes').length;
        const losses = settled.filter((row) => row.settlementResult === 'no').length;
        const pnlRows = settled.filter((row) => Number.isFinite(row.pnlCents));
        const pnlCents = pnlRows.reduce((sum, row) => sum + Number(row.pnlCents), 0);
        const priced = rows.filter((row) => Number.isFinite(row.entryPriceCents));
        const active = rows.filter((row) => !['EXPOSURE_RELEASED','SETTLED','REJECTED','PRICE_TOO_HIGH','EXPIRED_UNSUBMITTED'].includes(row.state)).length;
        const blocked = rows.filter((row) =>
          row.state === 'REJECTED'
          || row.state === 'PRICE_TOO_HIGH'
          || row.state === 'EXPIRED_UNSUBMITTED'
          || String(row.terminalReason ?? '').length > 0
        ).length;
        return {
          strategy,
          available,
          signals: rows.length,
          settled: settled.length,
          wins,
          losses,
          winRate: settled.length ? wins / settled.length : null,
          simulatedPnlCents: pnlRows.length ? pnlCents : 0,
          active,
          blocked,
          averageEntryPriceCents: priced.length
            ? priced.reduce((sum, row) => sum + Number(row.entryPriceCents), 0) / priced.length
            : null,
          latestAtMs: rows.length ? Math.max(...rows.map((row) => Number(row.updatedAtMs || row.createdAtMs || 0))) : null,
        };
      };

      const rows = [...a2Rows, ...lRows]
        .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
        .slice(0, 100);

      return {
        generatedAtMs: Date.now(),
        note: 'Live shadow-trading results only. No live Kalshi orders are submitted by A2 or L.',
        summaries: [
          summarize('A2', a2Rows, a2Exists),
          summarize('L', lRows, lExists),
        ],
        rows,
      };
    });

    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Shadow performance diagnostic read failed', error);
    return send(res, 500, JSON.stringify({
      error: 'Shadow performance unavailable',
      generatedAtMs: Date.now(),
      summaries: [],
      rows: [],
    }), 'application/json; charset=utf-8');
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
  if (url.pathname === '/api/diagnostics/service-ledger-today') return void serviceLedgerTodayDiagnostics(req, res);
  if (url.pathname === '/api/diagnostics/shadow-performance') return void shadowPerformanceDiagnostics(req, res);
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
  void Promise.all([
    graceJson('/api/trade/status').then((s) => console.log('TRADE_STATUS_PNL_DIAGNOSTIC', JSON.stringify({
      date: s?.date ?? null,
      daily_realized_net_pnl_dollars: s?.daily_realized_net_pnl_dollars ?? null,
      daily_realized_settled_fill_count: s?.daily_realized_settled_fill_count ?? null,
      daily_realized_pending_fill_count: s?.daily_realized_pending_fill_count ?? null,
      daily_realized_unverified_fill_count: s?.daily_realized_unverified_fill_count ?? null,
    }))),
    withReadOnlyDb(async (client) => {
      const tables = ['eth_martingale_orders','eth420_candidate_live_orders','eth_big_bet_orders','eth_g_streak_reversal_orders','jackpot_attempts','kamakazee_orders'];
      const q = await client.query(`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position
      `, [tables]);
      console.log('SERVICE_LEDGER_SCHEMA_DIAGNOSTIC', JSON.stringify(q.rows));
      const [a,cand,big,g,j,k] = await Promise.all([
        client.query(`
          SELECT COUNT(*)::int AS n,
                 COALESCE(SUM(
                   CASE WHEN settlement_result = side
                     THEN (COALESCE(filled_contracts,0)::numeric - COALESCE(actual_notional_dollars,0)::numeric - COALESCE(actual_fee_dollars,0)::numeric)
                     ELSE -(COALESCE(actual_notional_dollars,0)::numeric + COALESCE(actual_fee_dollars,0)::numeric)
                   END
                 ),0) AS pnl
          FROM eth_martingale_orders
          WHERE eastern_date='2026-09-23'
            AND settlement_result IN ('yes','no')
            AND COALESCE(filled_contracts,0)::numeric > 0
        `),
        client.query(`
          SELECT COUNT(*)::int AS n, COALESCE(SUM(realized_pnl_delta_cents),0)::int AS pnl_cents
          FROM eth420_candidate_live_orders
          WHERE eastern_date='2026-09-23' AND realized_pnl_delta_cents IS NOT NULL
        `),
        client.query(`
          SELECT strategy, COUNT(*)::int AS n, COALESCE(SUM(realized_pnl_cents),0)::int AS pnl_cents
          FROM eth_big_bet_orders
          WHERE created_at_ms >= 1790136000000
            AND created_at_ms < 1790222400000
            AND realized_pnl_cents IS NOT NULL
          GROUP BY strategy ORDER BY strategy
        `),
        client.query(`
          SELECT COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE settlement_result IN ('yes','no'))::int AS settled,
                 COUNT(*) FILTER (WHERE won IS TRUE)::int AS wins,
                 COUNT(*) FILTER (WHERE won IS FALSE)::int AS losses
          FROM eth_g_streak_reversal_orders
          WHERE created_at_ms >= 1790136000000 AND created_at_ms < 1790222400000
        `),
        client.query(`
          SELECT COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE official_result IN ('yes','no'))::int AS settled,
                 COALESCE(SUM(j_fee_cents),0)::int AS fees_cents
          FROM jackpot_attempts
          WHERE detected_at_ms >= 1790136000000 AND detected_at_ms < 1790222400000
            AND j_kalshi_order_id IS NOT NULL
        `),
        client.query(`
          SELECT COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE official_result IN ('yes','no'))::int AS settled
          FROM kamakazee_orders
          WHERE created_at_ms >= 1790136000000 AND created_at_ms < 1790222400000
            AND kalshi_order_id IS NOT NULL
        `)
      ]);
      console.log('SERVICE_LEDGER_TODAY_DIAGNOSTIC', JSON.stringify({
        A:a.rows, candidate:cand.rows, BI:big.rows, G:g.rows, J:j.rows, K:k.rows
      }));
    }),
  ]).catch((error) => console.error('PNL_SCHEMA_DIAGNOSTIC_FAILED', String(error?.message ?? error)));
  void withReadOnlyDb(async (client) => {
    const r = await client.query(`
      SELECT id, kalshi_order_id, origin_service, created_at_ms
        FROM eth420_candidate_live_orders
       WHERE id IN (
         'KXETH15M-26SEP231345-45:eth420-live-v1',
         'KXETH15M-26SEP231400-00:eth420-live-v1',
         'KXETH15M-26SEP231415-15:eth420-live-v1'
       )
       ORDER BY created_at_ms DESC
    `);
    console.log('CANDIDATE_ORIGIN_DIAGNOSTIC', JSON.stringify(r.rows));
    const early = await client.query(`
      SELECT id, ticker, kalshi_order_id, origin_service, requested_contracts, fill_price_cents, created_at_ms
      FROM eth420_candidate_live_orders
      WHERE ticker IN (
        'KXETH15M-26SEP230530-30',
        'KXETH15M-26SEP230615-15',
        'KXETH15M-26SEP230815-15',
        'KXETH15M-26SEP231145-45',
        'KXETH15M-26SEP231300-00',
        'KXETH15M-26SEP231315-15'
      )
      ORDER BY created_at_ms
    `);
    console.log('EARLY_CANDIDATE_ORIGIN_DIAGNOSTIC', JSON.stringify(early.rows));
  }).catch((error) => console.error('CANDIDATE_ORIGIN_DIAGNOSTIC_FAILED', String(error?.message ?? error)));
  for (const path of ['/api/trade/fills?limit=10000', '/api/trade/orders?limit=1000']) {
    const url = new URL(path, 'http://shawshank.local');
    void refreshReadCache(url).catch((error) => console.error('Dashboard cache warm failed', path, error));
  }
});
