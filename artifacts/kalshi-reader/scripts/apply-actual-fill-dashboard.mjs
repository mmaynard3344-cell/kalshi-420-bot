import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');
let source = readFileSync(dashboardPath, 'utf8');

if (source.includes('actual-fill-dashboard-v1')) process.exit(0);
if (!source.includes('</body>')) throw new Error('standalone dashboard closing body not found');

source = source.replace(
  'Operational display only. This page has no trading controls and uses the existing read-only ETH 420 candidate-history interface.',
  'Operational display only. This page has no trading controls. P&L and statistics use actual Kalshi ETH fills; candidate history remains supplemental strategy telemetry.',
);
source = source.replace('Waiting for candidate ledger…', 'Waiting for live ETH account data…');
source = source.replace('Client-side chart from existing daily P&amp;L rows.', 'Client-side chart from actual settled Kalshi ETH fills.');
source = source.replace('Each bar is one Eastern Time day returned by the ledger.', 'Each bar is one Eastern Time day from actual settled Kalshi ETH fills.');

const overlay = String.raw`
<script id="actual-fill-dashboard-v1">
(() => {
  const ET = 'America/New_York';
  const el = (id) => document.getElementById(id);
  const moneyActual = (cents, signed=true) => {
    const n = Number(cents || 0);
    const prefix = signed ? (n > 0 ? '+' : n < 0 ? '-' : '') : (n < 0 ? '-' : '');
    return prefix + String.fromCharCode(36) + (Math.abs(n) / 100).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  };
  const easternKey = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US',{timeZone:ET,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));
    const get = (t) => parts.find((p)=>p.type===t)?.value || '';
    return get('year')+'-'+get('month')+'-'+get('day');
  };
  const fillTime = (fill) => {
    if (fill.created_time) { const ms = Date.parse(fill.created_time); if (Number.isFinite(ms)) return ms; }
    if (Number.isFinite(Number(fill.ts))) return Number(fill.ts) * 1000;
    return null;
  };
  const sideOf = (fill) => String(fill.side || '').toLowerCase();
  const priceOf = (fill, side) => Number(side === 'no' ? fill.no_price_dollars : fill.yes_price_dollars);
  const feeOf = (fill) => Number(fill.fee_cost ?? fill.fee_cost_dollars ?? 0);
  const resultOf = (fill) => String(fill.market_result || '').toLowerCase();

  function summarize(fills) {
    const orders = new Map();
    for (const fill of fills || []) {
      if (!String(fill.ticker || '').startsWith('KXETH15M-')) continue;
      const atMs = fillTime(fill); if (atMs == null) continue;
      const count = Number(fill.count_fp ?? fill.count ?? 0);
      const side = sideOf(fill), price = priceOf(fill, side), feeDollars = feeOf(fill);
      if (!(count > 0) || !Number.isFinite(price) || price < 0 || price > 1 || !Number.isFinite(feeDollars) || feeDollars < 0) continue;
      const orderId = String(fill.order_id || fill.fill_id || (fill.ticker+':'+atMs+':'+side));
      const row = orders.get(orderId) || {orderId,ticker:String(fill.ticker),side,atMs,contracts:0,principalCents:0,feesCents:0,result:''};
      row.atMs = Math.min(row.atMs, atMs);
      row.contracts += count;
      row.principalCents += Math.round(count * price * 100);
      row.feesCents += Math.round(feeDollars * 100);
      const result = resultOf(fill); if (result === 'yes' || result === 'no') row.result = result;
      orders.set(orderId,row);
    }
    const days = new Map();
    for (const order of orders.values()) {
      const day = easternKey(order.atMs);
      const settled = order.result === 'yes' || order.result === 'no';
      const won = settled && order.result === order.side;
      const gross = settled ? (won ? Math.round(order.contracts * 100) - order.principalCents : -order.principalCents) : 0;
      const net = settled ? gross - order.feesCents : 0;
      const d = days.get(day) || {easternDate:day,bets:0,settled:0,wins:0,losses:0,wageredCents:0,feesCents:0,netRealizedPnlCents:0};
      d.bets += 1;
      d.wageredCents += order.principalCents;
      d.feesCents += order.feesCents;
      if (settled) { d.settled += 1; d.wins += won ? 1 : 0; d.losses += won ? 0 : 1; d.netRealizedPnlCents += net; }
      days.set(day,d);
    }
    return [...days.values()].sort((a,b)=>a.easternDate.localeCompare(b.easternDate));
  }

  const startOfWeekKeyActual = (key) => {
    const [y,m,d] = key.split('-').map(Number);
    const date = new Date(Date.UTC(y,m-1,d));
    const dow = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - ((dow + 6) % 7));
    return date.toISOString().slice(0,10);
  };
  const aggregateActual = (daily, keyFn) => {
    const m = new Map();
    for (const r of daily) { const k = keyFn(r.easternDate); m.set(k,(m.get(k)||0)+Number(r.netRealizedPnlCents||0)); }
    return [...m.entries()].map(([label,value])=>({label,value}));
  };

  function paint(daily, stale) {
    const todayKey = easternKey(Date.now());
    const today = daily.find((r)=>r.easternDate===todayKey) || {netRealizedPnlCents:0,settled:0,wins:0,losses:0,bets:0,wageredCents:0,feesCents:0};
    const weekKey = startOfWeekKeyActual(todayKey);
    const monthKey = todayKey.slice(0,7);
    const weekCents = daily.filter((r)=>r.easternDate>=weekKey && r.easternDate<=todayKey).reduce((s,r)=>s+r.netRealizedPnlCents,0);
    const monthCents = daily.filter((r)=>r.easternDate.startsWith(monthKey)).reduce((s,r)=>s+r.netRealizedPnlCents,0);
    const allCents = daily.reduce((s,r)=>s+r.netRealizedPnlCents,0);
    const wins = daily.reduce((s,r)=>s+r.wins,0), losses = daily.reduce((s,r)=>s+r.losses,0), denom = wins+losses;

    if (el('opPnl')) el('opPnl').textContent = moneyActual(today.netRealizedPnlCents);
    if (el('pnlToday')) el('pnlToday').textContent = moneyActual(today.netRealizedPnlCents);
    if (el('pnlWeek')) el('pnlWeek').textContent = moneyActual(weekCents);
    if (el('pnlMonth')) el('pnlMonth').textContent = moneyActual(monthCents);
    if (el('pnlAll')) el('pnlAll').textContent = moneyActual(allCents);
    if (el('statWinRate')) el('statWinRate').textContent = denom ? (wins/denom*100).toFixed(1)+'%' : '—';
    if (el('statAvgDay')) el('statAvgDay').textContent = daily.length ? moneyActual(Math.round(allCents/daily.length)) : '—';
    if (el('statBestWorst')) {
      if (!daily.length) el('statBestWorst').textContent='—';
      else { const sorted=[...daily].sort((a,b)=>a.netRealizedPnlCents-b.netRealizedPnlCents); el('statBestWorst').textContent=moneyActual(sorted.at(-1).netRealizedPnlCents)+' / '+moneyActual(sorted[0].netRealizedPnlCents); }
    }
    if (el('dayCount')) el('dayCount').textContent = daily.length+' day'+(daily.length===1?'':'s')+' · actual fills';
    if (el('dailyRows')) el('dailyRows').innerHTML = [...daily].reverse().map((r)=>'<tr><td>'+r.easternDate+'</td><td class="num">'+r.settled+'</td><td class="num">'+r.wins+'</td><td class="num">'+r.losses+'</td><td class="num">'+moneyActual(r.wageredCents,false)+'</td><td class="num">'+moneyActual(r.feesCents,false)+'</td><td class="num '+(r.netRealizedPnlCents>0?'good':r.netRealizedPnlCents<0?'bad':'')+'">'+moneyActual(r.netRealizedPnlCents)+'</td></tr>').join('') || '<tr><td colspan="7">No settled ETH fills available.</td></tr>';

    let running=0;
    const cumulative=daily.map((r)=>({label:r.easternDate,value:(running+=r.netRealizedPnlCents)}));
    const dayPts=daily.map((r)=>({label:r.easternDate,value:r.netRealizedPnlCents}));
    if (typeof lineChart === 'function' && el('cumChart')) lineChart(el('cumChart'),cumulative);
    if (typeof barChart === 'function') {
      if (el('dailyChart')) barChart(el('dailyChart'),dayPts);
      if (el('weeklyChart')) barChart(el('weeklyChart'),aggregateActual(daily,startOfWeekKeyActual));
      if (el('monthlyChart')) barChart(el('monthlyChart'),aggregateActual(daily,(k)=>k.slice(0,7)));
    }
    if (el('refreshStatus')) el('refreshStatus').innerHTML = '<strong>'+(stale?'Actual ETH fills stale':'Actual ETH fills fresh')+'</strong> · '+today.settled+' settled today · '+today.wins+' wins / '+today.losses+' losses';
  }

  let running = false;
  async function refreshActual() {
    if (running) return; running = true;
    try {
      const response = await fetch('/api/trade/fills?limit=10000',{cache:'no-store',credentials:'include'});
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      const daily = summarize(payload.fills || []);
      paint(daily, Boolean(payload.stale));
    } catch (err) {
      if (el('refreshStatus')) el('refreshStatus').innerHTML = '<strong>Actual fill stats unavailable</strong> · '+String(err);
    } finally { running = false; }
  }
  refreshActual();
  window.setInterval(refreshActual, 5000);
})();
</script>
`;

source = source.replace('</body>', overlay + '\n</body>');
writeFileSync(dashboardPath, source);
