(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const first = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };
  const num = (v) => v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const moneyCents = (c) => c == null ? '—' : '$' + (Number(c) / 100).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const moneyDollars = (d) => d == null ? '—' : '$' + Number(d).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const priceCents = (v) => { const n = num(v); if (n == null) return null; return n <= 1 ? n * 100 : n; };
  const cents = (v) => { const n = num(v); return n == null ? '—' : Math.round(n) + '¢'; };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (s) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  const fullTime = (v) => {
    if (v == null) return '—';
    const n = Number(v); const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
    return Number.isFinite(ms) ? new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true}).format(new Date(ms)) : '—';
  };
  async function j(path) { const r = await fetch(path, {cache:'no-store'}); if (!r.ok) throw new Error(path + ' HTTP ' + r.status); return r.json(); }

  const orderRows = (p) => Array.isArray(p) ? p : Array.isArray(p?.orders) ? p.orders : [];
  const fillRows = (p) => Array.isArray(p) ? p : Array.isArray(p?.fills) ? p.fills : [];
  const orderTicker = (o) => String(first(o, ['ticker','market_ticker']) ?? '');
  const clientId = (o) => String(first(o, ['client_order_id','clientOrderId']) ?? '');
  const orderId = (o) => String(first(o, ['order_id','orderId','id']) ?? '');
  const orderTime = (o) => {
    const v = first(o, ['created_time','created_at','createdAt','created_at_ms','createdAtMs']);
    if (v == null) return 0; const n = Number(v); if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(v); return Number.isFinite(d) ? d : 0;
  };
  const sideOf = (o) => {
    const c = clientId(o); if (c.startsWith('eth-yes-')) return 'YES'; if (c.startsWith('eth-no-')) return 'NO';
    const s = String(first(o, ['side','order_side']) ?? '').toLowerCase();
    if (s === 'yes' || s === 'bid') return 'YES'; if (s === 'no' || s === 'ask') return 'NO'; return '—';
  };
  const reqOf = (o) => num(first(o, ['initial_count_fp','initial_count','count','requested_count','requestedContracts','requested_contracts']));
  const fillOf = (o) => num(first(o, ['fill_count_fp','fill_count','filled_count_fp','filled_count','filledContracts','filled_contracts','filled'])) ?? 0;
  const remOf = (o) => { const r = num(first(o, ['remaining_count_fp','remaining_count','remainingContracts','remaining_contracts','remaining'])); if (r != null) return r; const q=reqOf(o),f=fillOf(o); return q==null ? null : Math.max(0,q-f); };
  const statusOf = (o) => String(first(o, ['status','order_status','state']) ?? 'unknown').replaceAll('_',' ').toUpperCase();
  const orderPrice = (o) => { const s=sideOf(o); const keys=s==='YES'?['yes_price_dollars','yes_price']:s==='NO'?['no_price_dollars','no_price']:[]; return priceCents(first(o,[...keys,'price_cents','price','limit_price'])); };
  const isOpen = (o) => { const s=statusOf(o).toLowerCase(), r=remOf(o); return (r != null && r > 0) || ['open','resting','pending','submitted','active','partially filled','partially-filled'].includes(s); };
  const fillOrderId = (f) => String(first(f, ['order_id','orderId']) ?? '');
  const settlementMap = (fills) => { const m=new Map(); for (const f of fills) { const t=String(first(f,['ticker','market_ticker'])??''); const r=String(first(f,['market_result','result'])??'').toLowerCase(); if(t&&(r==='yes'||r==='no'))m.set(t,r.toUpperCase()); } return m; };
  const actualPrincipal = (o, fills) => { const oid=orderId(o); if(!oid)return null; let total=0,seen=false; const side=sideOf(o); for(const f of fills){if(fillOrderId(f)!==oid)continue; const count=num(first(f,['count_fp','count','contracts'])); const p=priceCents(first(f,side==='YES'?['yes_price_dollars','yes_price']:['no_price_dollars','no_price'])); if(count!=null&&count>0&&p!=null){total += count*p/100;seen=true;}} return seen?total:null; };
  const maxPrincipal = (o) => { const q=reqOf(o),p=orderPrice(o); return q==null||p==null?null:q*p/100; };
  const backFlipRows = (p) => Array.isArray(p)?p:Array.isArray(p?.rows)?p.rows:[];
  const routeOf = (o, bfRows, bfAvailable) => {
    const c=clientId(o);
    if(c.startsWith('eth-yes-')||c.startsWith('eth-no-'))return'A · Regular';
    if(c.endsWith(':eth-jump-v1'))return'B · Jump';
    if(c.endsWith(':eth-no3-reversal-v1'))return'C · Reversal';
    if(c.endsWith(':eth-breakout-reversal-v1'))return'D · Breakout';
    if(c.endsWith(':eth-downfade-p80-p99-v2'))return'E · Downfade';
    if(c.endsWith(':eth-downfade-p90-p99-v2'))return'F · Downfade';
    if(c.endsWith(':eth-probe-g-5m-30c-v1'))return'G · Probe';
    if(c.endsWith(':eth-ashley-h-v1'))return'H · Ashley';
    if(c.endsWith(':eth-ash-v2-i-v1'))return'I · Ash V2';
    if(c.endsWith(':jackpot-j'))return'J · Jackpot';
    if(c.endsWith(':eth420-live-v1')){
      if(!bfAvailable)return'420 Special';
      const oid=orderId(o),ticker=orderTicker(o);
      const proved=bfRows.some(r=>{const candidate=String(first(r,['candidateOrderId','candidate_order_id'])??'');const target=String(first(r,['targetTicker','target_ticker'])??'');return candidate&&(candidate===c||candidate===oid)&&(!target||target===ticker);});
      return proved?'420 · Back Flip':'420 · Jump';
    }
    return'Other ETH';
  };

  function renderBalance(b) {
    const cash = num(first(b,['aggregate_balance_cents'])) ?? (()=>{const d=num(first(b,['balance_dollars']));return d==null?null:Math.round(d*100)})();
    const portfolio = num(first(b,['portfolio_value'])); const equity = cash==null||portfolio==null?null:cash+portfolio;
    if($('kalshiCash'))$('kalshiCash').textContent=moneyCents(cash); if($('kalshiPortfolio'))$('kalshiPortfolio').textContent=moneyCents(portfolio); if($('kalshiEquity'))$('kalshiEquity').textContent=moneyCents(equity);
    if($('balanceFreshness')){$('balanceFreshness').textContent=b?.stale?'STALE':'LIVE';$('balanceFreshness').className='badge '+(b?.stale?'warn':'good');}
    if($('balanceDetail'))$('balanceDetail').textContent='Authenticated read-only account snapshot · equity = cash + open position value.';
  }
  function renderMartingale(p) {
    const s=p?.state??p?.martingale?.state??p?.dashboard?.state??p?.martingale??p??null; if(!s)return;
    const side=String(first(s,['next_side','side','currentSide','current_side'])??'').toUpperCase(); const step=num(first(s,['martingale_step','martingaleStep','step'])); const principal=num(first(s,['next_principal_cents','nextPrincipalCents']));
    if($('opSide')&&(side==='YES'||side==='NO'))$('opSide').textContent=side;
    if($('opStepWager')&&step!=null)$('opStepWager').textContent='Step '+(Math.max(0,Math.trunc(step))+1)+(principal==null?'':' · '+moneyCents(principal));
  }
  function renderMarket(l) {
    const a=String(l?.availability?.status??'unavailable'),m=l?.market??null,e=a==='fresh'?l?.evidence??null:null;
    if($('marketFreshness')){$('marketFreshness').textContent=a.toUpperCase();$('marketFreshness').className='badge '+(a==='fresh'?'good':a==='stale'?'warn':'');}
    if($('marketTicker'))$('marketTicker').textContent=m?.ticker??'Live market unavailable'; if($('marketWindow'))$('marketWindow').textContent=m?fullTime(m.openTime)+' – '+fullTime(m.closeTime)+' ET'+(l?.availability?.quoteAgeMs!=null?' · quote age '+Math.round(Number(l.availability.quoteAgeMs))+' ms':''):String(l?.availability?.reason??'Unavailable').replaceAll('_',' ');
    if($('yesBid'))$('yesBid').textContent=cents(e?.yesBid); if($('yesAsk'))$('yesAsk').textContent=cents(e?.yesAsk); if($('noBid'))$('noBid').textContent=cents(e?.noBid); if($('noAsk'))$('noAsk').textContent=cents(e?.noAsk);
    if($('floorStrike'))$('floorStrike').textContent=e?.floorStrike==null?'—':Number(e.floorStrike).toLocaleString(); if($('adjacentMove'))$('adjacentMove').textContent=e?.adjacentMove==null?'—':(Number(e.adjacentMove)*100).toFixed(4)+'%'; if($('yesSpread'))$('yesSpread').textContent=cents(e?.yesSpreadCents); if($('noSpread'))$('noSpread').textContent=cents(e?.noSpreadCents);
  }
  function renderOrders(orders,fills,market,bf,bfAvailable){
    const eth=orders.filter(o=>/^KXETH15M-/.test(orderTicker(o))).sort((a,b)=>orderTime(b)-orderTime(a)); const open=eth.filter(isOpen); const results=settlementMap(fills); const bfRows=backFlipRows(bf);
    if($('openOrderCount'))$('openOrderCount').textContent=open.length+' open order'+(open.length===1?'':'s');
    if($('openOrderRows'))$('openOrderRows').innerHTML=open.length?open.map(o=>'<tr><td>'+esc(orderTicker(o))+'</td><td>'+esc(sideOf(o))+'</td><td class="num">'+(orderPrice(o)==null?'—':Math.round(orderPrice(o))+'¢')+'</td><td class="num">'+fillOf(o)+'</td><td class="num">'+(remOf(o)??'—')+'</td><td>'+esc(statusOf(o))+'</td><td>'+esc(fullTime(orderTime(o)))+'</td></tr>').join(''):'<tr><td colspan="7" class="empty">No open or resting exchange orders.</td></tr>';
    const ticker=String(market?.market?.ticker??''); const currentRows=ticker?eth.filter(o=>orderTicker(o)===ticker):[]; const current=currentRows.find(o=>fillOf(o)>0)??currentRows.find(isOpen)??currentRows[0]??null; const latest=eth[0]??null;
    if($('currentOrderRows'))$('currentOrderRows').innerHTML=currentRows.length?currentRows.map(o=>{const route=routeOf(o,bfRows,bfAvailable),actual=actualPrincipal(o,fills),principal=actual??maxPrincipal(o),price=orderPrice(o);return '<div class="current-order-row"><div><div class="current-order-route">'+esc(route)+' · '+esc(sideOf(o))+'</div><div class="sub">'+esc(statusOf(o))+' · '+esc(fullTime(orderTime(o)))+'</div></div><div><div class="eyebrow">Price / principal</div><div class="v">'+(price==null?'—':Math.round(price)+'¢')+' · '+moneyDollars(principal)+'</div></div><div><div class="eyebrow">Requested</div><div class="v">'+esc(reqOf(o)??'—')+'</div></div><div><div class="eyebrow">Filled / remaining</div><div class="v">'+fillOf(o)+' / '+esc(remOf(o)??'—')+'</div></div></div>'}).join(''):'';
    if(current){const route=routeOf(current,bfRows,bfAvailable),st=statusOf(current),actual=actualPrincipal(current,fills),principal=actual??maxPrincipal(current),multiple=currentRows.length>1; $('positionTitle').textContent=ticker; $('positionStatus').textContent=multiple?currentRows.length+' ORDERS':st; $('positionStatus').className='badge '+(multiple?'warn':/cancel|reject|fail|error/i.test(st)?'warn':'good'); if(multiple){const requested=currentRows.reduce((s,o)=>s+(reqOf(o)??0),0),filled=currentRows.reduce((s,o)=>s+fillOf(o),0),remaining=currentRows.reduce((s,o)=>s+(remOf(o)??0),0),principalTotal=currentRows.reduce((s,o)=>s+(actualPrincipal(o,fills)??maxPrincipal(o)??0),0); $('positionSideStep').textContent=currentRows.length+' strategy orders'; $('positionWager').textContent=moneyDollars(principalTotal); $('positionRequested').textContent=requested; $('positionFilled').textContent=filled+' / '+remaining;}else{$('positionSideStep').textContent=route+' · '+sideOf(current); $('positionWager').textContent=moneyDollars(principal); $('positionRequested').textContent=reqOf(current)??'—'; $('positionFilled').textContent=fillOf(current)+' / '+(remOf(current)??'—');} const settle=results.get(ticker); $('positionDetail').textContent=(multiple?'Each exchange order is shown separately below.':(orderPrice(current)==null?'Price unavailable':Math.round(orderPrice(current))+'¢ order price')+' · '+(actual!=null?'actual filled principal':'maximum order principal'))+(settle?' · settlement '+settle:'');}
    else{$('positionTitle').textContent=ticker?'No order yet for current window':'Current market unavailable';$('positionStatus').textContent='NONE';$('positionStatus').className='badge';$('positionSideStep').textContent='—';$('positionWager').textContent='—';$('positionRequested').textContent='—';$('positionFilled').textContent='— / —';$('positionDetail').textContent=ticker?'No exchange order recorded for the current ticker.':'Live market ticker unavailable.';}
    if(latest){const route=routeOf(latest,bfRows,bfAvailable),settle=results.get(orderTicker(latest));$('latestOrder').textContent=route+' · '+sideOf(latest)+' · '+statusOf(latest);$('latestOrderSub').textContent=orderTicker(latest)+' · '+(reqOf(latest)??'—')+' requested · '+fillOf(latest)+' filled · '+(settle?'settlement '+settle:'settlement pending')+' · '+fullTime(orderTime(latest));}
    else{$('latestOrder').textContent='No ETH orders returned';$('latestOrderSub').textContent='Exchange order feed returned no KXETH15M orders.';}
  }

  let busy=false;
  async function refresh(){if(busy)return;busy=true;try{const [b,mk,mg,o,f,bf]=await Promise.allSettled([j('/api/trade/balance'),j('/api/trade/analytics/eth420-live-market'),j('/api/trade/martingale'),j('/api/trade/orders?limit=100'),j('/api/trade/fills?limit=1000'),j('/api/diagnostics/back-flips')]); if(b.status==='fulfilled')renderBalance(b.value); if(mg.status==='fulfilled')renderMartingale(mg.value); if(mk.status==='fulfilled')renderMarket(mk.value); if(o.status==='fulfilled')renderOrders(orderRows(o.value),f.status==='fulfilled'?fillRows(f.value):[],mk.status==='fulfilled'?mk.value:null,bf.status==='fulfilled'?bf.value:[],bf.status==='fulfilled'); const core=[b,mk,mg,o]; const failures=core.filter(x=>x.status==='rejected').length; if($('refreshStatus'))$('refreshStatus').innerHTML=failures?'<span class="warn">Operations partial</span> · '+failures+' core feed'+(failures===1?'':'s')+' unavailable':'<strong>Operations live</strong> · core feeds healthy';}finally{busy=false;}}
  refresh(); window.setInterval(refresh,5000);
})();
