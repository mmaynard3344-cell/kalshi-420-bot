(() => {
  'use strict';

  const ET = 'America/New_York';
  const ALL_TIME_START = '2026-08-27';
  const byId = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (s) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  const firstNumber = (...values) => {
    for (const value of values) {
      if (value == null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const money = (cents, signed = true) => {
    const n = Number(cents || 0);
    const prefix = signed ? (n > 0 ? '+' : n < 0 ? '-' : '') : (n < 0 ? '-' : '');
    return prefix + '$' + (Math.abs(n) / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  };
  const dayKey = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone: ET, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date(ms));
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return get('year') + '-' + get('month') + '-' + get('day');
  };
  const dayLabel = (key) => new Intl.DateTimeFormat('en-US', {timeZone:'UTC', month:'short', day:'numeric', year:'numeric'}).format(new Date(key + 'T00:00:00Z'));
  const clock = (ms) => new Intl.DateTimeFormat('en-US', {timeZone: ET, hour:'numeric', minute:'2-digit', hour12:true}).format(new Date(ms));
  const rowTimeMs = (row) => {
    for (const value of [row?.created_time, row?.created_at, row?.createdAt]) {
      if (!value) continue;
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
    for (const value of [row?.created_at_ms, row?.createdAtMs]) {
      const ms = Number(value);
      if (Number.isFinite(ms)) return ms;
    }
    const ts = Number(row?.ts);
    return Number.isFinite(ts) ? ts * 1000 : null;
  };
  const isEth = (row) => String(row?.ticker || '').startsWith('KXETH15M-');
  const side = (row) => String(row?.side || '').toLowerCase();
  const orderId = (row) => String(row?.order_id ?? row?.orderId ?? '');
  const result = (row) => {
    const value = String(row?.market_result || '').toLowerCase();
    return value === 'yes' || value === 'no' ? value : '';
  };
  const fillCount = (row) => firstNumber(row?.count_fp, row?.count, 0) || 0;
  const fillPriceDollars = (row, s) => {
    const dollars = firstNumber(s === 'no' ? row?.no_price_dollars : row?.yes_price_dollars);
    if (dollars != null) return dollars;
    const cents = firstNumber(s === 'no' ? row?.no_price : row?.yes_price);
    return cents == null ? null : cents / 100;
  };
  const feeCents = (row) => Math.round((firstNumber(row?.fee_cost, row?.fee_cost_dollars, 0) || 0) * 100);
  const requested = (row) => firstNumber(row?.initial_count_fp, row?.initial_count, row?.count_fp, row?.count, row?.requested_contracts, row?.requestedContracts, 0) || 0;
  const reportedFilled = (row) => firstNumber(row?.fill_count_fp, row?.fill_count, row?.filled_count_fp, row?.filled_count, row?.filled_contracts, row?.filledContracts, 0) || 0;
  const status = (row) => String(row?.status ?? row?.order_status ?? row?.state ?? '').toUpperCase().replaceAll('_', ' ');
  const road = (row) => {
    const client = String(row?.client_order_id ?? row?.clientOrderId ?? '');
    if (client.startsWith('eth-yes-') || client.startsWith('eth-no-')) return 'Regular';
    if (client.endsWith(':eth420-live-v1')) return '420 / Back Flip';
    return 'ETH';
  };

  function summarizeFills(fills) {
    const orders = new Map();
    for (const fill of fills) {
      if (!isEth(fill)) continue;
      const ms = rowTimeMs(fill);
      const s = side(fill);
      const count = fillCount(fill);
      const price = fillPriceDollars(fill, s);
      if (ms == null || !(count > 0) || price == null || price < 0 || price > 1) continue;
      const id = orderId(fill) || String(fill?.fill_id || `${fill.ticker}:${ms}:${s}`);
      const item = orders.get(id) || {id, ticker:String(fill.ticker), side:s, atMs:ms, contracts:0, principalCents:0, feesCents:0, result:''};
      item.atMs = Math.min(item.atMs, ms);
      item.contracts += count;
      item.principalCents += Math.round(count * price * 100);
      item.feesCents += feeCents(fill);
      const r = result(fill);
      if (r) item.result = r;
      orders.set(id, item);
    }

    const days = new Map();
    for (const item of orders.values()) {
      const key = dayKey(item.atMs);
      const settled = !!item.result;
      const won = settled && item.result === item.side;
      const gross = settled ? (won ? Math.round(item.contracts * 100) - item.principalCents : -item.principalCents) : 0;
      const net = settled ? gross - item.feesCents : 0;
      const row = days.get(key) || {easternDate:key, bets:0, settled:0, wins:0, losses:0, wageredCents:0, feesCents:0, netCents:0};
      row.bets += 1;
      row.wageredCents += item.principalCents;
      row.feesCents += item.feesCents;
      if (settled) {
        row.settled += 1;
        row.wins += won ? 1 : 0;
        row.losses += won ? 0 : 1;
        row.netCents += net;
      }
      days.set(key, row);
    }
    return {orders, days:[...days.values()].sort((a,b) => a.easternDate.localeCompare(b.easternDate))};
  }

  function setMoney(id, value) {
    const node = byId(id);
    if (!node) return;
    node.textContent = money(value);
    node.classList.toggle('good', value > 0);
    node.classList.toggle('bad', value < 0);
  }

  function paintSummary(days) {
    const todayKey = dayKey(Date.now());
    const today = days.find((d) => d.easternDate === todayKey) || {netCents:0, settled:0, wins:0, losses:0};
    const [y,m,d] = todayKey.split('-').map(Number);
    const monday = new Date(Date.UTC(y, m - 1, d));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const weekKey = monday.toISOString().slice(0,10);
    const monthKey = todayKey.slice(0,7);
    const week = days.filter((x) => x.easternDate >= weekKey && x.easternDate <= todayKey).reduce((s,x) => s + x.netCents, 0);
    const month = days.filter((x) => x.easternDate.startsWith(monthKey)).reduce((s,x) => s + x.netCents, 0);
    const allDays = days.filter((x) => x.easternDate >= ALL_TIME_START);
    const all = allDays.reduce((s,x) => s + x.netCents, 0);
    const wins = allDays.reduce((s,x) => s + x.wins, 0);
    const losses = allDays.reduce((s,x) => s + x.losses, 0);
    const settled = wins + losses;

    setMoney('opPnl', today.netCents);
    setMoney('pnlToday', today.netCents);
    setMoney('pnlWeek', week);
    setMoney('pnlMonth', month);
    setMoney('pnlAll', all);

    const allCard = byId('pnlAll')?.closest('.card');
    if (allCard) {
      const eyebrow = allCard.querySelector('.eyebrow');
      const sub = allCard.querySelector('.sub');
      if (eyebrow) eyebrow.textContent = 'All Time · Since 8/27/26';
      if (sub) sub.textContent = 'Actual settled ETH fills from Aug 27, 2026 forward.';
    }
    if (byId('statWinRate')) byId('statWinRate').textContent = settled ? (wins / settled * 100).toFixed(1) + '%' : '—';
    if (byId('statAvgDay')) byId('statAvgDay').textContent = allDays.length ? money(Math.round(all / allDays.length)) : '—';
    if (byId('statBestWorst')) {
      const sorted = [...allDays].sort((a,b) => a.netCents - b.netCents);
      byId('statBestWorst').textContent = sorted.length ? money(sorted[sorted.length - 1].netCents) + ' / ' + money(sorted[0].netCents) : '—';
    }
    if (byId('dayCount')) byId('dayCount').textContent = days.length + ' days · actual fills';
    if (byId('dailyRows')) {
      byId('dailyRows').innerHTML = [...days].reverse().map((row) =>
        `<tr><td>${dayLabel(row.easternDate)}</td><td class="num">${row.settled}</td><td class="num">${row.wins}</td><td class="num">${row.losses}</td><td class="num">${row.bets}</td><td class="num">${money(row.feesCents, false)}</td><td class="num ${row.netCents > 0 ? 'good' : row.netCents < 0 ? 'bad' : ''}">${money(row.netCents)}</td></tr>`
      ).join('') || '<tr><td colspan="7" class="empty">No settled ETH fills available.</td></tr>';
    }
  }

  function paintOrders(rawOrders, fillMap) {
    const rows = rawOrders.filter(isEth).sort((a,b) => (rowTimeMs(b) || 0) - (rowTimeMs(a) || 0));
    if (byId('orderCount')) byId('orderCount').textContent = rows.length + ' actual orders';
    if (!byId('orderRows')) return;
    byId('orderRows').innerHTML = rows.map((order) => {
      const id = orderId(order);
      const fill = fillMap.get(id);
      const ms = rowTimeMs(order);
      const s = side(order);
      const req = requested(order);
      const filled = fill ? fill.contracts : reportedFilled(order);
      const principal = fill ? fill.principalCents : 0;
      const avgCents = fill && fill.contracts ? Math.round(fill.principalCents / fill.contracts) : null;
      const settlement = fill?.result ? fill.result.toUpperCase() : (filled === 0 ? 'NO FILL' : 'PENDING');
      const won = !!(fill?.result && fill.result === s);
      const pnl = fill?.result ? (won ? Math.round(fill.contracts * 100) - fill.principalCents - fill.feesCents : -fill.principalCents - fill.feesCents) : null;
      return `<tr><td>${ms == null ? '—' : dayLabel(dayKey(ms)) + ' · ' + clock(ms)}</td><td>${esc(order.ticker)}</td><td class="txn-side">${esc(road(order))} · ${esc(s.toUpperCase() || '—')}</td><td class="num">${money(principal, false)}</td><td class="num">${req} · ${filled}</td><td class="num">${avgCents == null ? '—' : avgCents + '¢'}</td><td class="txn-result">${esc(settlement + ' · ' + (status(order) || '—'))}</td><td class="num">${money(fill?.feesCents || 0, false)}</td><td class="num ${pnl > 0 ? 'good' : pnl < 0 ? 'bad' : ''}">${pnl == null ? 'Pending' : money(pnl)}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="empty">No recent ETH orders available.</td></tr>';
  }

  function ensureTabs() {
    document.querySelectorAll('.tab').forEach((button) => {
      if (button.dataset.pnlRuntimeBound === '1') return;
      button.dataset.pnlRuntimeBound = '1';
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === button));
        document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === button.dataset.tab));
      });
    });
  }

  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const [fillResult, orderResult] = await Promise.allSettled([
        fetch('/api/trade/fills?limit=10000', {cache:'no-store'}),
        fetch('/api/trade/orders?limit=100', {cache:'no-store'})
      ]);
      let fillMap = new Map();
      let fillMessage = 'fills unavailable';
      let orderMessage = 'orders unavailable';

      if (fillResult.status === 'fulfilled' && fillResult.value.ok) {
        const payload = await fillResult.value.json();
        const fills = Array.isArray(payload?.fills) ? payload.fills : [];
        const summary = summarizeFills(fills);
        fillMap = summary.orders;
        paintSummary(summary.days);
        fillMessage = summary.orders.size + ' filled orders';
      }

      if (orderResult.status === 'fulfilled' && orderResult.value.ok) {
        const payload = await orderResult.value.json();
        const orders = Array.isArray(payload?.orders) ? payload.orders : [];
        paintOrders(orders, fillMap);
        orderMessage = orders.filter(isEth).length + ' recent ETH orders';
      }

      if (byId('ledgerSub')) byId('ledgerSub').textContent = 'Actual Kalshi ETH ledger · ' + fillMessage + ' · ' + orderMessage;
    } catch (error) {
      if (byId('ledgerSub')) byId('ledgerSub').textContent = 'Actual ETH ledger unavailable · ' + String(error);
    } finally {
      busy = false;
    }
  }

  ensureTabs();
  refresh();
  window.setInterval(refresh, 5000);
})();
