const base = (process.env.GRACE_API_BASE_URL ?? '').replace(/\/$/, '');
const token = process.env.GRACE_TRADE_API_TOKEN ?? '';
if (!base || !token) throw new Error('GRACE_API_BASE_URL and GRACE_TRADE_API_TOKEN are required');

const targets = new Set([
  'KXETH15M-26SEP091000-00',
  'KXETH15M-26SEP091015-15',
]);

const response = await fetch(`${base}/api/trade/fills?limit=1000`, {
  headers: { 'x-trade-token': token, accept: 'application/json' },
  redirect: 'manual',
});
const text = await response.text();
if (!response.ok) throw new Error(`Grace fills returned ${response.status}: ${text.slice(0, 300)}`);
const payload = JSON.parse(text);
const fills = Array.isArray(payload?.fills) ? payload.fills : [];
const selected = fills.filter((row) => targets.has(String(row?.ticker ?? '')));
const compact = selected.map((row) => ({
  ticker: String(row.ticker ?? ''),
  order_id: String(row.order_id ?? row.orderId ?? ''),
  side: String(row.side ?? ''),
  count: Number(row.count_fp ?? row.count ?? 0),
  yes_price_dollars: row.yes_price_dollars ?? null,
  no_price_dollars: row.no_price_dollars ?? null,
  fee_cost: row.fee_cost ?? row.fee_cost_dollars ?? null,
  market_result: String(row.market_result ?? ''),
  created_time: row.created_time ?? row.created_at ?? null,
}));
console.log('KALSHI_SETTLEMENT_VERIFY ' + JSON.stringify({ count: compact.length, fills: compact }));
