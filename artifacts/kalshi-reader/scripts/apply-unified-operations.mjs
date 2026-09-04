import fs from 'node:fs';

const path = new URL('../public/eth420-dashboard.html', import.meta.url);
let html = fs.readFileSync(path, 'utf8');

const marker = 'data-unified-operations-runtime="v3"';
if (html.includes(marker)) process.exit(0);

html = html.replace(
  '<button class="tab" data-tab="balance">Balance Sheet</button>',
  '<button class="tab" data-tab="balance" style="display:none" aria-hidden="true" tabindex="-1">Balance Sheet</button>',
);
html = html.replace('Our current ETH 420 position', 'Current ETH order / position');
html = html.replace('Latest candidate order', 'Latest ETH order');
html = html.replace('<div class="eyebrow">Side / step</div><div class="v" id="positionSideStep">', '<div class="eyebrow">Owner / side</div><div class="v" id="positionSideStep">');
html = html.replace('<div class="eyebrow">Intended wager</div><div class="v" id="positionWager">', '<div class="eyebrow">Order principal</div><div class="v" id="positionWager">');
html = html.replace('<div class="eyebrow">Filled / resting</div><div class="v" id="positionFilled">', '<div class="eyebrow">Filled / remaining</div><div class="v" id="positionFilled">');

const runtime = String.raw`
<script data-unified-operations-runtime="v3">
(()=>{
  const $=id=>document.getElementById(id);
  const first=(o,n)=>{for(const k of n)if(o&&o[k]!=null)return o[k];return null};
  const num=v=>v==null?null:Number(v);
  const fmtMoney=d=>d==null||!Number.isFinite(Number(d))?'—':('$'+Number(d).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
  const fmtTime=v=>{const ms=typeof v==='number'?v:Date.parse(v);return Number.isFinite(ms)?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).format(new Date(ms)):'—'};
  const esc=v=>String(v??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  const orderTime=o=>{const v=first(o,['created_time','created_at','createdAt','created_at_ms','createdAtMs']);if(v==null)return 0;const n=Number(v);if(Number.isFinite(n))return n<1e12?n*1000:n;const d=Date.parse(v);return Number.isFinite(d)?d:0};
  const orderTicker=o=>String(first(o,['ticker','market_ticker'])??'');
  const orderClient=o=>String(first(o,['client_order_id','clientOrderId'])??'');
  const sideOf=o=>{const c=orderClient(o);if(c.startsWith('eth-yes-'))return'YES';if(c.startsWith('eth-no-'))return'NO';const s=String(first(o,['side','order_side'])??'').toLowerCase();if(s==='yes')return'YES';if(s==='no')return'NO';const action=String(first(o,['action'])??'').toLowerCase();return action?action.toUpperCase():'—'};
  const reqOf=o=>num(first(o,['initial_count_fp','initial_count','count','requested_count','requestedContracts','requested_contracts']));
  const fillOf=o=>num(first(o,['fill_count_fp','fill_count','filled_count_fp','filled_count','filledContracts','filled_contracts','filled']));
  const remOf=o=>{const v=num(first(o,['remaining_count_fp','remaining_count','remainingContracts','remaining_contracts','remaining']));if(v!=null)return v;const q=reqOf(o),f=fillOf(o);return q!=null&&f!=null?Math.max(0,q-f):null};
  const normalizePrice=v=>{if(v==null)return null;const n=Number(v);if(!Number.isFinite(n))return null;return n<=1?n*100:n};
  const priceOf=o=>{const s=sideOf(o);const keys=s==='YES'?['yes_price','yes_price_dollars']:s==='NO'?['no_price','no_price_dollars']:[];return normalizePrice(first(o,[...keys,'price_cents','price','limit_price']));};
  const statusOf=o=>String(first(o,['status','order_status','state'])??'unknown').replaceAll('_',' ').toUpperCase();
  const rowsOf=p=>Array.isArray(p)?p:Array.isArray(p?.orders)?p.orders:[];
  const fillsOf=p=>Array.isArray(p)?p:Array.isArray(p?.fills)?p.fills:[];
  const fillOrderId=f=>String(first(f,['order_id','orderId'])??'');
  const resultByTicker=fills=>{const m=new Map;for(const f of fills){const t=String(first(f,['ticker','market_ticker'])??'');const r=String(first(f,['market_result','result'])??'').toLowerCase();if(t&&(r==='yes'||r==='no'))m.set(t,r.toUpperCase())}return m};
  const backFlipTickers=p=>{const s=new Set;const rows=Array.isArray(p)?p:Array.isArray(p?.rows)?p.rows:Array.isArray(p?.backFlips)?p.backFlips:[];for(const r of rows){const t=first(r,['targetTicker','target_ticker','ticker']);if(t)s.add(String(t))}return s};
  const routeOf=(o,bf,bfAvailable)=>{const c=orderClient(o);if(c.startsWith('eth-yes-')||c.startsWith('eth-no-'))return'Regular';if(c.endsWith(':eth420-live-v1'))return bfAvailable?(bf.has(orderTicker(o))?'Back Flip':'420 Jump'):'420 Special';return'ETH Order'};
  const filledPrincipal=(o,fills)=>{const oid=String(first(o,['order_id','id'])??'');if(!oid)return null;let total=0,seen=false;for(const f of fills){if(fillOrderId(f)!==oid)continue;const count=num(first(f,['count_fp','count','fill_count','contracts']));if(count==null||count<=0)continue;const side=sideOf(o);const p=normalizePrice(first(f,side==='YES'?['yes_price_dollars','yes_price']:['no_price_dollars','no_price']));if(p==null)continue;total+=count*p/100;seen=true}return seen?total:null};
  const orderPrincipal=o=>{const q=reqOf(o),p=priceOf(o);return q!=null&&p!=null?q*p/100:null};
  const isOpen=o=>{const st=statusOf(o).toLowerCase(),r=remOf(o);return r!=null&&r>0||['open','resting','pending','submitted','active','partially filled','partially-filled'].includes(st)};
  const statusTone=st=>{const s=String(st).toLowerCase();if(/cancel|reject|fail|error/.test(s))return'warn';if(/execut|fill|open|rest|active|submitted/.test(s))return'good';return''};
  const martingaleState=p=>p?.state??p?.martingale?.state??p?.dashboard?.state??p?.martingale??p??null;
  const renderMartingaleState=p=>{
    const s=martingaleState(p);if(!s)return;
    const side=String(first(s,['next_side','side','currentSide','current_side'])??'').toUpperCase();
    const rawStep=num(first(s,['martingale_step','martingaleStep','step']));
    const principalCents=num(first(s,['next_principal_cents','nextPrincipalCents']));
    if(side==='YES'||side==='NO')$('opSide').textContent=side;
    if(rawStep!=null&&Number.isFinite(rawStep)){
      const human=Math.max(0,Math.trunc(rawStep))+1;
      const wager=principalCents==null?null:principalCents/100;
      $('opStepWager').textContent='Step '+human+(wager==null?'':' · '+fmtMoney(wager));
    }
  };
  const renderOpenOrders=orders=>{
    const open=orders.filter(isOpen);
    $('openOrderCount').textContent=open.length+' open order'+(open.length===1?'':'s');
    $('openOrderRows').innerHTML=open.length?open.map(o=>{
      const price=priceOf(o),f=fillOf(o),r=remOf(o);
      return '<tr><td>'+esc(orderTicker(o)||'—')+'</td><td>'+esc(sideOf(o))+'</td><td class="num">'+(price==null?'—':price.toFixed(0)+'¢')+'</td><td class="num">'+esc(f??'—')+'</td><td class="num">'+esc(r??'—')+'</td><td>'+esc(statusOf(o))+'</td><td>'+esc(fmtTime(orderTime(o)))+'</td></tr>';
    }).join(''):'<tr><td colspan="7" class="empty">No open or resting exchange orders.</td></tr>';
  };
  async function j(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw Error(String(r.status));return r.json()}
  async function refreshUnifiedOps(){
    const [or,mk,fl,bf,mg]=await Promise.allSettled([j('/api/trade/orders?limit=100'),j('/api/trade/analytics/eth420-live-market'),j('/api/trade/fills?limit=1000'),j('/api/diagnostics/back-flips'),j('/api/trade/martingale')]);
    if(mg.status==='fulfilled')renderMartingaleState(mg.value);
    if(or.status!=='fulfilled'){
      $('openOrderCount').textContent='Orders unavailable';
      $('openOrderRows').innerHTML='<tr><td colspan="7" class="empty">Exchange order snapshot unavailable.</td></tr>';
      return;
    }
    const orders=rowsOf(or.value).filter(o=>/^KXETH15M-/.test(orderTicker(o))).sort((a,b)=>orderTime(b)-orderTime(a));
    renderOpenOrders(orders);
    const fills=fl.status==='fulfilled'?fillsOf(fl.value):[];
    const bfAvailable=bf.status==='fulfilled';
    const bfSet=bfAvailable?backFlipTickers(bf.value):new Set;
    const results=resultByTicker(fills);
    const currentTicker=mk.status==='fulfilled'?String(mk.value?.market?.ticker??''):'';
    const currentOrders=currentTicker?orders.filter(o=>orderTicker(o)===currentTicker):[];
    const current=currentOrders.find(o=>(fillOf(o)??0)>0)??currentOrders.find(isOpen)??currentOrders[0]??null;
    const latest=orders[0]??null;

    if(current){
      const route=routeOf(current,bfSet,bfAvailable),side=sideOf(current),req=reqOf(current),filled=fillOf(current),rem=remOf(current),price=priceOf(current),actual=filledPrincipal(current,fills),maxPrincipal=orderPrincipal(current);
      $('positionTitle').textContent=currentTicker;
      const st=statusOf(current),duplicate=currentOrders.length>1;
      $('positionStatus').textContent=duplicate?'MULTIPLE ORDERS':st;
      $('positionStatus').className='badge '+(duplicate?'warn':statusTone(st));
      $('positionSideStep').textContent=route+' · '+side;
      $('positionWager').textContent=actual!=null?fmtMoney(actual):fmtMoney(maxPrincipal);
      $('positionRequested').textContent=req??'—';
      $('positionFilled').textContent=(filled??'—')+' / '+(rem??'—');
      const settle=results.get(currentTicker);
      const noFill=(filled??0)===0&&/cancel|reject/.test(st.toLowerCase());
      const principalKind=actual!=null?'actual filled principal':'maximum order principal';
      $('positionDetail').textContent=(price==null?'Price unavailable':price.toFixed(0)+'¢ order price')+' · '+principalKind+(duplicate?' · WARNING: '+currentOrders.length+' exchange order records for this ticker':'')+' · '+(settle?'settlement '+settle:noFill?'no fill; terminal order':'current exchange order');
    }else{
      $('positionTitle').textContent=currentTicker?'No order yet for current window':'Current market unavailable';
      $('positionStatus').textContent='NONE';$('positionStatus').className='badge';
      $('positionSideStep').textContent='—';$('positionWager').textContent='—';$('positionRequested').textContent='—';$('positionFilled').textContent='— / —';
      $('positionDetail').textContent=currentTicker?'No Regular, 420 Jump, or Back Flip exchange order is recorded for the current ticker.':'Live market ticker unavailable.';
    }

    if(latest){
      const route=routeOf(latest,bfSet,bfAvailable),side=sideOf(latest),req=reqOf(latest),filled=fillOf(latest),settle=results.get(orderTicker(latest)),st=statusOf(latest);
      const noFill=(filled??0)===0&&/cancel|reject/.test(st.toLowerCase());
      $('latestOrder').textContent=route+' · '+side+' · '+st;
      $('latestOrderSub').textContent=orderTicker(latest)+' · '+(req??'—')+' requested · '+(filled??'—')+' filled · '+(settle?'settlement '+settle:noFill?'no fill':'settlement pending')+' · '+fmtTime(orderTime(latest));
    }else{
      $('latestOrder').textContent='No ETH orders returned';$('latestOrderSub').textContent='Unified exchange order feed returned no KXETH15M orders.';
    }
  }
  refreshUnifiedOps();setInterval(refreshUnifiedOps,5000);
})();
</script>`;

html = html.replace('</body>', runtime + '\n</body>');
fs.writeFileSync(path, html);
