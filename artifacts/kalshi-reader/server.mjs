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

async function proxyRead(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!ALLOWED_READ_PATHS.has(url.pathname)) return send(res, 404, 'Not found');
  try {
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

async function pnlReport(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const period = String(url.searchParams.get('period') ?? 'all-time').trim();
  
  // For 'today' and '7d', proxy upstream unchanged
  if (period === 'today' || period === '7d') {
    return proxyRead(req, res, new URL(`/api/trade/analytics/reports/pnl?period=${period}`, `http://${req.headers.host}`));
  }
  
  if (period !== 'all-time') {
    return send(res, 400, JSON.stringify({ error: 'period must be "today", "7d", or "all-time"' }), 'application/json; charset=utf-8');
  }

  // Handle 'all-time' with cutoff at 2026-08-27
  if (!databaseUrl) {
    return send(res, 503, JSON.stringify({ error: 'DATABASE_URL is not configured on Shawshank' }), 'application/json; charset=utf-8');
  }

  try {
    const report = await withReadOnlyDb(async (client) => {
      // Query all-time filled attempts with eastern_date >= '2026-08-27'
      const attemptsResult = await client.query(`
        SELECT
          a.id, a.order_id, a.ticker, a.series, a.side, a.won,
          a.reconciled, a.reconcile_failed, a.eastern_date,
          mr.result as market_result
        FROM order_attempts a
        LEFT JOIN market_results mr ON mr.ticker = a.ticker
        WHERE a.outcome IN ('full_fill', 'partial_fill', 'filled', 'partially_filled')
          AND a.is_synthetic = false
          AND a.eastern_date >= '2026-08-27'
        ORDER BY COALESCE(a.order_id, a.id), a.reconciled DESC NULLS LAST, a.updated_at DESC NULLS LAST, a.id DESC
      `);

      const attempts = attemptsResult.rows || [];
      
      // Query canonical fills for those attempts
      const attemptIds = [...new Set(attempts.map(a => a.order_id || a.id))];
      if (attemptIds.length === 0) {
        // No data in period
        return {
          period: 'all-time (from 2026-08-27)',
          summary: { asset: 'combined', fills: 0, wins: 0, losses: 0, winRate: null, grossPnlDollars: null, netPnlDollars: null },
          byBand: [],
          byAsset: [{ asset: 'combined', fills: 0, wins: 0, losses: 0, winRate: null, grossPnlDollars: null, netPnlDollars: null }],
          pending: { fillsTotal: 0, fillsPending: 0 },
          reconciliationStatus: 'exchange_reconciled',
        };
      }

      const placeholders = attemptIds.map((_, i) => `$${i + 1}`).join(',');
      const fillsResult = await client.query(`
        SELECT
          f.order_id,
          f.contracts,
          f.cost_dollars,
          f.exact_cost_dollars,
          f.fee_dollars,
          f.exact_fee_dollars,
          f.canonical_economics
        FROM order_fills f
        WHERE f.order_id = ANY($1::text[])
          AND f.canonical_economics = true
      `, [attemptIds]);

      const fills = fillsResult.rows || [];
      
      // Build dedup map: (order_id or id) -> latest canonical attempt
      const dedup = new Map();
      for (const att of attempts) {
        const key = att.order_id || att.id;
        if (!dedup.has(key)) {
          dedup.set(key, att);
        }
      }

      // Verify no pending verification: all attempts must have settlement outcome (market_result or won)
      const pendingVerif = Array.from(dedup.values()).filter(a => 
        a.market_result == null && a.won == null
      );
      if (pendingVerif.length > 0) {
        // At least one attempt is pending settlement verification - fail closed
        return send(res, 503, JSON.stringify({ 
          error: 'Some orders in the all-time period are still pending settlement verification. Cannot compute reliable all-time P&L.',
          pendingCount: pendingVerif.length
        }), 'application/json; charset=utf-8');
      }

      // Group by asset and compute aggregates
      const byAssetMap = new Map();
      let totalFills = 0, totalWins = 0, totalLosses = 0, totalGrossPnl = 0, totalNetPnl = 0;

      for (const att of Array.from(dedup.values())) {
        const asset = att.ticker?.includes('BTC') ? 'BTC' : att.ticker?.includes('SOL') ? 'SOL' : 'ETH';
        if (!byAssetMap.has(asset)) {
          byAssetMap.set(asset, { fills: 0, wins: 0, losses: 0, grossPnl: 0, netPnl: 0 });
        }
        const stat = byAssetMap.get(asset);

        const atts = fills.filter(f => f.order_id === (att.order_id || att.id));
        const numFills = atts.length;
        if (numFills === 0) continue; // No fills for this attempt

        stat.fills += numFills;
        totalFills += numFills;

        // Determine win/loss based on market_result or won fallback
        const won = att.market_result === att.side || (att.market_result == null && att.won === true);
        if (won) {
          stat.wins += numFills;
          totalWins += numFills;
        } else {
          stat.losses += numFills;
          totalLosses += numFills;
        }

        // Compute P&L from fills
        for (const f of atts) {
          const cost = f.exact_cost_dollars ?? f.cost_dollars;
          const fee = f.exact_fee_dollars ?? f.fee_dollars;
          const gross = f.contracts - (cost || 0);
          const net = gross - (fee || 0);
          stat.grossPnl += gross;
          stat.netPnl += net;
          totalGrossPnl += gross;
          totalNetPnl += net;
        }
      }

      // Build byAsset array
      const byAsset = [];
      for (const [asset, stat] of byAssetMap) {
        byAsset.push({
          asset,
          fills: stat.fills,
          wins: stat.wins,
          losses: stat.losses,
          winRate: stat.fills > 0 ? stat.wins / stat.fills : null,
          grossPnlDollars: stat.grossPnl,
          netPnlDollars: stat.netPnl,
        });
      }

      // Add combined
      byAsset.push({
        asset: 'combined',
        fills: totalFills,
        wins: totalWins,
        losses: totalLosses,
        winRate: totalFills > 0 ? totalWins / totalFills : null,
        grossPnlDollars: totalGrossPnl,
        netPnlDollars: totalNetPnl,
      });

      return {
        period: 'all-time (from 2026-08-27)',
        summary: byAsset.find(a => a.asset === 'combined') || { asset: 'combined', fills: 0, wins: 0, losses: 0, winRate: null, grossPnlDollars: null, netPnlDollars: null },
        byBand: [],
        byAsset,
        pending: { fillsTotal: totalFills, fillsPending: 0 },
        reconciliationStatus: 'exchange_reconciled',
      };
    });

    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    send(res, 200, JSON.stringify(report, null, 2), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('PnL report read failed', error);
    send(res, 500, JSON.stringify({ error: String(error?.message ?? 'PnL report read failed') }), 'application/json; charset=utf-8');
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
      SELECT source_candidate_order_id,source_ticker,missed_side,source_open_time_ms,target_open_time_ms,status,armed_at_ms,
             target_ticker,selected_side,execution_mode,execution_limit_price_cents,candidate_order_id,fallback_reason,resolved_at_ms
      FROM eth420_candidate_back_flip_overrides
      ORDER BY armed_at_ms DESC
      LIMIT 50
    `);
    return result.rows.map((row) => ({
      sourceCandidateOrderId: String(row.source_candidate_order_id ?? ''), sourceTicker: String(row.source_ticker ?? ''),
      missedSide: String(row.missed_side ?? ''), sourceOpenTimeMs: Number(row.source_open_time_ms),
      targetOpenTimeMs: Number(row.target_open_time_ms), status: String(row.status ?? ''), armedAtMs: Number(row.armed_at_ms),
      targetTicker: row.target_ticker == null ? null : String(row.target_ticker),
      selectedSide: row.selected_side == null ? null : String(row.selected_side),
      executionMode: row.execution_mode == null ? null : String(row.execution_mode),
      executionLimitPriceCents: row.execution_limit_price_cents == null ? null : Number(row.execution_limit_price_cents),
      candidateOrderId: row.candidate_order_id == null ? null : String(row.candidate_order_id),
      fallbackReason: row.fallback_reason == null ? null : String(row.fallback_reason),
      resolvedAtMs: row.resolved_at_ms == null ? null : Number(row.resolved_at_ms),
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

function etDayKey(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return part('year') + '-' + part('month') + '-' + part('day');
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fillTimeMs(fill) {
  for (const value of [fill?.created_time, fill?.created_at, fill?.createdAt]) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  for (const value of [fill?.created_at_ms, fill?.createdAtMs]) {
    const ms = numeric(value);
    if (ms != null) return ms;
  }
  const ts = numeric(fill?.ts);
  return ts == null ? null : ts * 1000;
}

function fillCountValue(fill) {
  return numeric(fill?.count_fp ?? fill?.count ?? fill?.contracts) ?? 0;
}

function fillFeeCents(fill) {
  const dollars = numeric(fill?.fee_cost_dollars ?? fill?.fee_cost);
  return dollars == null ? 0 : Math.round(dollars * 100);
}

function fillSidePriceDollars(fill, side) {
  const dollars = numeric(side === 'no' ? fill?.no_price_dollars : fill?.yes_price_dollars);
  if (dollars != null) return dollars;
  const cents = numeric(side === 'no' ? fill?.no_price : fill?.yes_price);
  return cents == null ? null : cents / 100;
}

async function authoritativePnlDiagnostics(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  try {
    const [fillsPayload, sideRows] = await Promise.all([
      graceJson('/api/trade/fills?limit=1000'),
      withReadOnlyDb(async (client) => {
        const result = await client.query(`
          SELECT kalshi_order_id, side, ticker, 'regular' AS engine
          FROM eth_martingale_orders
          WHERE kalshi_order_id IS NOT NULL AND ticker LIKE 'KXETH15M-%'
          UNION ALL
          SELECT kalshi_order_id, side, ticker, 'candidate' AS engine
          FROM eth420_candidate_live_orders
          WHERE kalshi_order_id IS NOT NULL AND ticker LIKE 'KXETH15M-%'
        `);
        return result.rows;
      }),
    ]);
    const fills = Array.isArray(fillsPayload?.fills) ? fillsPayload.fills : [];
    const sideByOrderId = new Map();
    for (const row of sideRows) {
      const id = String(row.kalshi_order_id ?? '');
      const side = String(row.side ?? '').toLowerCase();
      if (id && (side === 'yes' || side === 'no')) sideByOrderId.set(id, { side, engine: String(row.engine ?? ''), ticker: String(row.ticker ?? '') });
    }

    const grouped = new Map();
    let unresolvedSideFillCount = 0;
    for (const fill of fills) {
      const ticker = String(fill?.ticker ?? '');
      if (!ticker.startsWith('KXETH15M-')) continue;
      const orderId = String(fill?.order_id ?? fill?.orderId ?? '');
      const owner = sideByOrderId.get(orderId);
      if (!owner) { unresolvedSideFillCount += 1; continue; }
      const count = fillCountValue(fill);
      const price = fillSidePriceDollars(fill, owner.side);
      const ms = fillTimeMs(fill);
      if (!(count > 0) || price == null || price < 0 || price > 1 || ms == null) continue;
      const resultRaw = String(fill?.market_result ?? '').toLowerCase();
      const result = resultRaw === 'yes' || resultRaw === 'no' ? resultRaw : '';
      const item = grouped.get(orderId) ?? { orderId, ticker, side: owner.side, engine: owner.engine, atMs: ms, contracts: 0, principalCents: 0, feesCents: 0, result: '' };
      item.atMs = Math.min(item.atMs, ms);
      item.contracts += count;
      item.principalCents += Math.round(count * price * 100);
      item.feesCents += fillFeeCents(fill);
      if (result) item.result = result;
      grouped.set(orderId, item);
    }

    const days = new Map();
    const rows = [];
    for (const item of grouped.values()) {
      if (!item.result) continue;
      const won = item.result === item.side;
      const pnlCents = (won ? Math.round(item.contracts * 100) - item.principalCents : -item.principalCents) - item.feesCents;
      const easternDate = etDayKey(item.atMs);
      rows.push({ ...item, easternDate, won, pnlCents });
      const day = days.get(easternDate) ?? { easternDate, settled: 0, wins: 0, losses: 0, wageredCents: 0, feesCents: 0, netCents: 0 };
      day.settled += 1;
      day.wins += won ? 1 : 0;
      day.losses += won ? 0 : 1;
      day.wageredCents += item.principalCents;
      day.feesCents += item.feesCents;
      day.netCents += pnlCents;
      days.set(easternDate, day);
    }
    rows.sort((a, b) => b.atMs - a.atMs);
    const dayRows = [...days.values()].sort((a, b) => a.easternDate.localeCompare(b.easternDate));
    const response = {
      available: true,
      generatedAtMs: Date.now(),
      method: 'durable_order_side_plus_actual_kalshi_fills',
      unresolvedSideFillCount,
      resolvedOrderCount: grouped.size,
      days: dayRows,
      rows,
    };
    if (req.method === 'HEAD') return send(res, 200, '', 'application/json; charset=utf-8');
    return send(res, 200, JSON.stringify(response), 'application/json; charset=utf-8');
  } catch (error) {
    console.error('Authoritative P&L diagnostic failed', error);
    return send(res, 500, JSON.stringify({ available: false, error: String(error?.message ?? 'Authoritative P&L diagnostic failed') }), 'application/json; charset=utf-8');
  }
}

async function sequenceAuditDiagnostics(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!databaseUrl) return send(res, 503, JSON.stringify({ available: false, error: 'DATABASE_URL is not configured on Shawshank' }), 'application/json; charset=utf-8');
  const date = String(url.searchParams.get('date') ?? '2026-09-04');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, JSON.stringify({ error: 'date must be YYYY-MM-DD' }), 'application/json; charset=utf-8');
  // Sep 4, 2026 is EDT (UTC-4). This diagnostic is deliberately scoped to the incident date.
  const startMs = Date.parse(date + 'T04:00:00Z');
  const endMs = startMs + 24 * 60 * 60_000;
  try {
    const { regular, candidate } = await withReadOnlyDb(async (client) => {
      const regularResult = await client.query(`
        SELECT id,ticker,side,martingale_step,requested_contracts,filled_contracts,
               settlement_result,outcome,created_at_ms,settled_at_ms
        FROM eth_martingale_orders
        WHERE created_at_ms >= $1 AND created_at_ms < $2
        ORDER BY created_at_ms ASC
      `, [startMs, endMs]);
      const candidateResult = await client.query(`
        SELECT id,ticker,side,martingale_step,requested_contracts,filled_contracts,
               limit_price_cents,effective_wager_cents,settlement_result,status,
               created_at_ms,settled_at_ms
        FROM eth420_candidate_live_orders
        WHERE created_at_ms >= $1 AND created_at_ms < $2
        ORDER BY created_at_ms ASC
      `, [startMs, endMs]);
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

async function upstreamHealth(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const probes = [
    ['balance', '/api/trade/balance'],
    ['martingale', '/api/trade/martingale'],
    ['orders', '/api/trade/orders?limit=1'],
    ['liveMarket', '/api/trade/analytics/eth420-live-market'],
  ];
  const results = {};
  for (const [name, path] of probes) {
    try {
      const response = await fetch(`${graceBase}${path}`, {
        method: 'GET',
        headers: { 'x-trade-token': graceToken, accept: 'application/json' },
        redirect: 'manual',
      });
      results[name] = { ok: response.ok, status: response.status };
    } catch (error) {
      results[name] = { ok: false, status: null, error: String(error?.code ?? error?.message ?? 'fetch_failed') };
    }
  }
  const ok = Object.values(results).every((item) => item.ok === true);
  if (req.method === 'HEAD') return send(res, ok ? 200 : 503, '', 'application/json; charset=utf-8');
  return send(res, ok ? 200 : 503, JSON.stringify({ ok, upstreamConfigured: Boolean(graceBase), tokenConfigured: Boolean(graceToken), results }, null, 2), 'application/json; charset=utf-8');
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
    'cache-control': (filePath.endsWith('.html') || filePath.endsWith('.js')) ? 'no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/trade/analytics/reports/pnl') return void pnlReport(req, res, url);
  if (url.pathname === '/healthz/upstream') return void upstreamHealth(req, res);
  if (url.pathname === '/api/diagnostics/exchange-ticker') return void exchangeTickerDiagnostics(req, res, url);
  if (url.pathname === '/api/diagnostics/candidate-lifecycle') return void candidateLifecycleDiagnostics(req, res, url);
  if (url.pathname === '/api/diagnostics/settlement-latency') return void settlementLatencyDiagnostics(req, res, url);
  if (url.pathname === '/api/diagnostics/back-flips') return void backFlipDiagnostics(req, res, false);
  if (url.pathname === '/api/diagnostics/authoritative-pnl') return void authoritativePnlDiagnostics(req, res);
  if (url.pathname === '/api/diagnostics/back-flips.csv') return void backFlipDiagnostics(req, res, true);
  if (url.pathname === '/api/diagnostics/sequence-audit') return void sequenceAuditDiagnostics(req, res, url);
  if (url.pathname.startsWith('/api/')) return void proxyRead(req, res, url);
  serveStatic(req, res, url);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Read-only ETH 420 operator UI listening on ${port}`);
});

