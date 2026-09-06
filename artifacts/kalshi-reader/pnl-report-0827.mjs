const START_DATE = '2026-08-27';
const PRICE_BANDS = [
  { band: '72-75', min: 72, max: 75 },
  { band: '76-80', min: 76, max: 80 },
  { band: '81-85', min: 81, max: 85 },
  { band: '86-90', min: 86, max: 90 },
];
const TOD = [
  { label: 'Overnight (12–6 AM)', minHour: 0, maxHour: 6 },
  { label: 'Morning (6 AM–12 PM)', minHour: 6, maxHour: 12 },
  { label: 'Afternoon (12–6 PM)', minHour: 12, maxHour: 18 },
  { label: 'Evening (6 PM–12 AM)', minHour: 18, maxHour: 24 },
];

function warning(n) {
  if (n === 0) return null;
  if (n < 30) return 'very_small';
  if (n < 100) return 'preliminary';
  return 'more_meaningful';
}

function easternHour(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(timestampMs));
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
}

function buildStats(rows, key, value) {
  const subset = key ? rows.filter((r) => r[key] === value) : rows;
  if (!subset.length) {
    const out = { fills: 0, wins: 0, losses: 0, winRate: null, grossPnlDollars: null, netPnlDollars: null, roi: null, sampleWarning: null };
    if (key === 'asset') out.asset = value;
    if (key === 'side') out.side = value;
    return out;
  }
  const wins = subset.filter((r) => r.win).length;
  const gross = subset.reduce((s, r) => s + r.gross, 0);
  const net = subset.reduce((s, r) => s + r.net, 0);
  const notional = subset.reduce((s, r) => s + r.cost, 0);
  const out = {
    fills: subset.length, wins, losses: subset.length - wins,
    winRate: wins / subset.length, grossPnlDollars: gross, netPnlDollars: net,
    notionalDeployedDollars: notional, roi: notional > 0 ? gross / notional : null,
    sampleWarning: warning(subset.length),
  };
  if (key === 'asset') out.asset = value;
  if (key === 'side') out.side = value;
  return out;
}

export async function buildPnlReportFrom0827(client) {
  const result = await client.query(`
    WITH canonical_attempts AS (
      SELECT DISTINCT ON (COALESCE(a.order_id, a.id))
        a.id, a.order_id, a.ticker, a.series, a.side, a.timestamp_ms,
        a.reconciled, a.reconcile_failed, a.won, a.fill_price_source,
        mr.result AS market_result
      FROM order_attempts a
      LEFT JOIN market_results mr ON mr.ticker = a.ticker
      WHERE a.outcome IN ('full_fill','partial_fill','filled','partially_filled')
        AND a.is_synthetic = false
        AND a.eastern_date >= $1
      ORDER BY COALESCE(a.order_id, a.id), a.reconciled DESC NULLS LAST,
               a.updated_at DESC NULLS LAST, a.id DESC
    ), fill_agg AS (
      SELECT f.order_id,
             SUM(f.contracts)::double precision AS contracts,
             SUM(COALESCE(f.exact_cost_dollars, f.cost_dollars::numeric))::double precision AS cost,
             SUM(COALESCE(f.exact_fee_dollars, f.fee_dollars::numeric))::double precision AS fee,
             CASE WHEN SUM(f.contracts) > 0
               THEN SUM(f.fill_price_cents * f.contracts) / SUM(f.contracts)
               ELSE NULL END AS avg_fill_price
      FROM order_fills f
      WHERE f.canonical_economics IS TRUE
      GROUP BY f.order_id
    )
    SELECT c.*, fa.contracts, fa.cost, fa.fee, fa.avg_fill_price
    FROM canonical_attempts c
    LEFT JOIN fill_agg fa ON fa.order_id = c.order_id
  `, [START_DATE]);

  const parents = result.rows ?? [];
  const pendingParents = parents.filter((r) =>
    r.contracts == null || r.cost == null || r.fee == null ||
    r.reconciled !== true ||
    !((r.market_result === 'yes' || r.market_result === 'no') || r.won != null)
  );

  const settled = parents.filter((r) => !pendingParents.includes(r)).map((r) => {
    const win = r.market_result === r.side || (r.market_result == null && r.won === true);
    const contracts = Number(r.contracts);
    const cost = Number(r.cost);
    const fee = Number(r.fee);
    const gross = win ? contracts - cost : -cost;
    return {
      ticker: String(r.ticker), series: String(r.series ?? ''), side: String(r.side),
      asset: String(r.series ?? '').startsWith('KXBTC') ? 'BTC' : 'ETH',
      timestampMs: Number(r.timestamp_ms), fillPrice: Number(r.avg_fill_price),
      contracts, cost, fee, gross, net: gross - fee, win,
      reconcileFailed: r.reconcile_failed === true,
      fillPriceSource: r.fill_price_source == null ? null : String(r.fill_price_source),
    };
  });

  const summary = { ...buildStats(settled), asset: 'combined' };
  const byAsset = [buildStats(settled, 'asset', 'BTC'), buildStats(settled, 'asset', 'ETH'), summary];
  const bySide = [buildStats(settled, 'side', 'yes'), buildStats(settled, 'side', 'no'), { ...buildStats(settled), side: 'combined' }];

  const byBand = PRICE_BANDS.map(({ band, min, max }) => {
    const rows = settled.filter((r) => Number.isFinite(r.fillPrice) && r.fillPrice >= min && r.fillPrice <= max);
    const base = buildStats(rows);
    return {
      band, minCents: min, maxCents: max, ...base,
      avgFillPriceCents: rows.length ? rows.reduce((s, r) => s + r.fillPrice, 0) / rows.length : null,
    };
  });

  const hourMap = new Map();
  for (const row of settled) {
    const hour = easternHour(row.timestampMs);
    if (!hourMap.has(hour)) hourMap.set(hour, []);
    hourMap.get(hour).push(row);
  }
  const byHour = [...hourMap.entries()].sort(([a], [b]) => a - b).map(([hour, rows]) => ({ easternHour: hour, ...buildStats(rows) }));
  const byTimeOfDay = TOD.map((bucket) => {
    const rows = settled.filter((r) => {
      const h = easternHour(r.timestampMs);
      return h >= bucket.minHour && h < bucket.maxHour;
    });
    return {
      ...bucket,
      combined: buildStats(rows),
      btc: buildStats(rows.filter((r) => r.asset === 'BTC')),
      eth: buildStats(rows.filter((r) => r.asset === 'ETH')),
    };
  });

  const bySeriesMap = new Map();
  for (const parent of parents) {
    const series = String(parent.series ?? 'unknown');
    if (!bySeriesMap.has(series)) bySeriesMap.set(series, { series, settledFillCount: 0, pendingVerificationCount: 0, unverifiedFillCount: 0, pnl: 0 });
    const item = bySeriesMap.get(series);
    const isPending = pendingParents.includes(parent);
    if (isPending) {
      item.pendingVerificationCount += 1;
      if (parent.reconcile_failed === true || parent.contracts == null) item.unverifiedFillCount += 1;
      continue;
    }
    item.settledFillCount += 1;
    const row = settled.find((r) => r.ticker === String(parent.ticker) && r.side === String(parent.side));
    if (row) item.pnl += row.net;
  }
  const bySeries = [...bySeriesMap.values()].map((x) => ({
    series: x.series,
    realizedNetPnlDollars: x.pendingVerificationCount > 0 ? null : x.pnl,
    settledFillCount: x.settledFillCount,
    pendingVerificationCount: x.pendingVerificationCount,
    unverifiedFillCount: x.unverifiedFillCount,
  }));
  const combinedPending = bySeries.reduce((s, x) => s + x.pendingVerificationCount, 0);
  const verified = {
    bySeries,
    combined: {
      realizedNetPnlDollars: combinedPending > 0 ? null : bySeries.reduce((s, x) => s + (x.realizedNetPnlDollars ?? 0), 0),
      settledFillCount: bySeries.reduce((s, x) => s + x.settledFillCount, 0),
      pendingVerificationCount: combinedPending,
      unverifiedFillCount: bySeries.reduce((s, x) => s + x.unverifiedFillCount, 0),
    },
  };

  const reconstructed = pendingParents.length > 0 || settled.some((r) => r.reconcileFailed || r.fillPriceSource !== 'actual');
  const toDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  return {
    period: 'all-time',
    dateRange: { from: START_DATE, to: toDate },
    summary, byAsset, byBand, bySide, byHour, byTimeOfDay,
    pending: {
      fillsTotal: parents.length,
      fillsReconciled: settled.length,
      fillsPending: pendingParents.length,
      pendingTickers: [...new Set(pendingParents.map((r) => String(r.ticker)))],
    },
    estimatedFillCount: settled.filter((r) => r.reconcileFailed || r.fillPriceSource === 'limit_fallback').length,
    reconciliationStatus: reconstructed ? 'reconstructed' : 'exchange_reconciled',
    verified,
    generatedAt: new Date().toISOString(),
  };
}
