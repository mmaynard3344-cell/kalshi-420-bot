(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const first = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };
  const moneyCents = (cents) => cents == null || !Number.isFinite(Number(cents)) ? '—' : '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cents = (v) => v == null || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)) + '¢';
  const fullTime = (v) => {
    if (v == null) return '—';
    const ms = typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(ms)) return '—';
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(ms));
  };
  async function j(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
    return r.json();
  }
  function renderBalance(b) {
    const cashCents = first(b, ['aggregate_balance_cents']);
    const balanceDollars = first(b, ['balance_dollars']);
    const cash = cashCents != null ? Number(cashCents) : balanceDollars != null ? Math.round(Number(balanceDollars) * 100) : null;
    const portfolioRaw = first(b, ['portfolio_value']);
    const portfolio = portfolioRaw == null ? null : Number(portfolioRaw);
    const equity = cash == null || portfolio == null ? null : cash + portfolio;
    if ($('kalshiCash')) $('kalshiCash').textContent = moneyCents(cash);
    if ($('kalshiPortfolio')) $('kalshiPortfolio').textContent = moneyCents(portfolio);
    if ($('kalshiEquity')) $('kalshiEquity').textContent = moneyCents(equity);
    if ($('balanceFreshness')) {
      $('balanceFreshness').textContent = b?.stale ? 'STALE' : 'LIVE';
      $('balanceFreshness').className = 'badge ' + (b?.stale ? 'warn' : 'good');
    }
    if ($('balanceDetail')) $('balanceDetail').textContent = 'Authenticated read-only account snapshot · equity = cash + open position value.';
  }
  function renderMartingale(p) {
    const s = p?.state ?? p?.martingale?.state ?? p?.dashboard?.state ?? p?.martingale ?? p ?? null;
    if (!s) return;
    const side = String(first(s, ['next_side', 'side', 'currentSide', 'current_side']) ?? '').toUpperCase();
    const rawStep = Number(first(s, ['martingale_step', 'martingaleStep', 'step']));
    const principalCents = Number(first(s, ['next_principal_cents', 'nextPrincipalCents']));
    if ($('opSide') && (side === 'YES' || side === 'NO')) $('opSide').textContent = side;
    if ($('opStepWager') && Number.isFinite(rawStep)) {
      const step = Math.max(0, Math.trunc(rawStep)) + 1;
      $('opStepWager').textContent = 'Step ' + step + (Number.isFinite(principalCents) ? ' · ' + moneyCents(principalCents) : '');
    }
  }
  function renderMarket(l) {
    const availability = String(l?.availability?.status ?? 'unavailable');
    const market = l?.market ?? null;
    const evidence = availability === 'fresh' ? l?.evidence ?? null : null;
    if ($('marketFreshness')) {
      $('marketFreshness').textContent = availability.toUpperCase();
      $('marketFreshness').className = 'badge ' + (availability === 'fresh' ? 'good' : availability === 'stale' ? 'warn' : '');
    }
    if ($('marketTicker')) $('marketTicker').textContent = market?.ticker ?? 'Live market unavailable';
    if ($('marketWindow')) $('marketWindow').textContent = market ? fullTime(market.openTime) + ' – ' + fullTime(market.closeTime) + ' ET' + (l?.availability?.quoteAgeMs != null ? ' · quote age ' + Math.round(Number(l.availability.quoteAgeMs)) + ' ms' : '') : String(l?.availability?.reason ?? 'Unavailable').replaceAll('_', ' ');
    if ($('yesBid')) $('yesBid').textContent = cents(evidence?.yesBid);
    if ($('yesAsk')) $('yesAsk').textContent = cents(evidence?.yesAsk);
    if ($('noBid')) $('noBid').textContent = cents(evidence?.noBid);
    if ($('noAsk')) $('noAsk').textContent = cents(evidence?.noAsk);
    if ($('floorStrike')) $('floorStrike').textContent = evidence?.floorStrike == null ? '—' : Number(evidence.floorStrike).toLocaleString();
    if ($('adjacentMove')) $('adjacentMove').textContent = evidence?.adjacentMove == null ? '—' : (Number(evidence.adjacentMove) * 100).toFixed(4) + '%';
    if ($('yesSpread')) $('yesSpread').textContent = cents(evidence?.yesSpreadCents);
    if ($('noSpread')) $('noSpread').textContent = cents(evidence?.noSpreadCents);
  }
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const [balance, martingale, market] = await Promise.allSettled([
        j('/api/trade/balance'),
        j('/api/trade/martingale'),
        j('/api/trade/analytics/eth420-live-market'),
      ]);
      if (balance.status === 'fulfilled') renderBalance(balance.value);
      if (martingale.status === 'fulfilled') renderMartingale(martingale.value);
      if (market.status === 'fulfilled') renderMarket(market.value);
      const failures = [balance, martingale, market].filter((x) => x.status === 'rejected').length;
      const status = $('refreshStatus');
      if (status) status.innerHTML = failures ? '<span class="warn">Operations partial</span> · ' + failures + ' core feed' + (failures === 1 ? '' : 's') + ' unavailable' : '<strong>Operations live</strong> · core feeds healthy';
    } finally {
      busy = false;
    }
  }
  refresh();
  window.setInterval(refresh, 5000);
})();
