import fs from 'node:fs';

const path = new URL('../public/eth420-dashboard.html', import.meta.url);
let html = fs.readFileSync(path, 'utf8');

const marker = 'data-unified-operations-runtime="v1"';
if (html.includes(marker)) process.exit(0);

html = html.replace(
  '<button class="tab" data-tab="balance">Balance Sheet</button>',
  '<button class="tab" data-tab="balance" style="display:none" aria-hidden="true" tabindex="-1">Balance Sheet</button>',
);
html = html.replace('Our current ETH 420 position', 'Current ETH order / position');
html = html.replace('Latest candidate order', 'Latest ETH order');

const runtime = String.raw`
<script data-unified-operations-runtime="v1">
(()=>{
  const $=id=>document.getElementById(id);
  const first=(o,n)=>{for(const k of n)if(o&&o[k]!=null)return o[k];return null};
  const num=v=>v==null?null:Number(v);
  const fmtMoney=d=>d==null||!Number.isFinite(Number(d))?'—':('$'+Number(d).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
  const fmtTime=v=>{const ms=typeof v==='number'?v:Date.parse(v);return Number.isFinite(ms)?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).format(new Date(ms)):'—'};
  const orderTime=o=>{const v=first(o,['created_time','created_at','createdAt','created_at_ms','createdAtMs']);if(v==null)return 0;const n=Number(v);if(Number.isFinite(n))return n<1e12?n*1000:n;const d=Date.parse(v);return Number.isFinite(d)?d:0};
  const orderTicker=o=>String(first(o,['ticker','market_ticker'])??'');
  const orderClient=o=>String(first(o,['client_order_id','clientOrderId'])??'');
  const sideOf=o=>{const c=orderClient(o);if(c.startsWith('eth-yes-'))return'YES';if(c.startsWith('eth-no-'))return'NO';const s=String(first(o,['side','order_side','action'])??'').toLowerCase();if(s==='yes'||s==='bid')return'YES';if(s==='no'||s==='ask')return'NO';return s?s.toUpperCase():'—'};
  const reqOf=o=>num(first(o,['initial_count','initial_count_fp','count','requested_count','requestedContracts','requested_contracts']));
  const fillOf=o=>num(first(o,['fill_count','fill_count_fp','filled_count','filled_count_fp','filledContracts','filled_contracts','filled']));
  const remOf=o=>{const v=num(first(o,['remaining_count','remaining_count_fp','remainingContracts','remaining_contracts','remaining']));if(v!=null)return v;const q=reqOf(o),f=fillOf(o);return q!=null&&f!=null?Math.max(0,q-f):null};
  const priceOf=o=>{const s=sideOf(o);const keys=s==='YES'?['yes_price','yes_price_dollars']:s==='NO'?['no_price','no_price_dollars']:[];let v=first(o,[...keys,'price_cents','price','limit_price']);if(v==null)return null;const n=Number(v);if(!Number.isFinite(n))return null;return n<=1?n*100:n};
  const statusOf=o=>String(first(o,['status','order_status','state'])??'unknown').replaceAll('_',' ').toUpperCase();
  const rowsOf=p=>Array.isArray(p)?p:Array.isArray(p?.orders)?p.orders:[];
  const fillsOf=p=>Array.isArray(p)?p:Array.isArray(p?.fills)?p.fills:[];
  const resultByTicker=fills=>{const m=new Map;for(const f of fills){const t=String(first(f,['ticker','market_ticker'])??'');const r=String(first(f,['market_result','result'])??'').toLowerCase();if(t&&(r==='yes'||r==='no'))m.set(t,r.toUpperCase())}return m};
  const backFlipTickers=p=>{const s=new Set;const rows=Array.isArray(p)?p:Array.isArray(p?.rows)?p.rows:Array.isArray(p?.backFlips)?p.backFlips:[];for(const r of rows){const t=first(r,['targetTicker','target_ticker','ticker']);if(t)s.add(String(t))}return s};
  const routeOf=(o,bf)=>{const c=orderClient(o);if(c.startsWith('eth-yes-')||c.startsWith('eth-no-'))return'Regular';if(c.endsWith(':eth420-live-v1'))return bf.has(orderTicker(o))?'Back Flip':'420 Jump';return'ETH Order'};
  const committedFor=(o,fills)=>{const oid=String(first(o,['order_id','id'])??'');if(!oid)return null;let total=0,seen=false;for(const f of fills){const foid=String(first(f,['order_id','orderId'])??'');if(foid!==oid)continue;const count=num(first(f,['count','count_fp','fill_count','contracts']));if(count==null)continue;const side=sideOf(o);let p=first(f,side==='YES'?['yes_price','yes_price_dollars']:['no_price','no_price_dollars']);if(p==null)p=first(f,['price','price_cents']);let pn=Number(p);if(!Number.isFinite(pn))continue;if(pn<=1)pn*=100;total+=count*pn/100;seen=true}return seen?total:null};
  async function j(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw Error(String(r.status));return r.json()}
  async function refreshUnifiedOps(){
    const [or,mk,fl,bf]=await Promise.allSettled([j('/api/trade/orders?limit=100'),j('/api/trade/analytics/eth420-live-market'),j('/api/trade/fills?limit=1000'),j('/api/diagnostics/back-flips')]);
    if(or.status!=='fulfilled')return;
    const orders=rowsOf(or.value).filter(o=>/^KXETH15M-/.test(orderTicker(o))).sort((a,b)=>orderTime(b)-orderTime(a));
    const fills=fl.status==='fulfilled'?fillsOf(fl.value):[];
    const bfSet=bf.status==='fulfilled'?backFlipTickers(bf.value):new Set;
    const results=resultByTicker(fills);
    const currentTicker=mk.status==='fulfilled'?String(mk.value?.market?.ticker??''):'';
    const current=currentTicker?orders.find(o=>orderTicker(o)===currentTicker):null;
    const latest=orders[0]??null;

    if(current){
      const route=routeOf(current,bfSet),side=sideOf(current),req=reqOf(current),filled=fillOf(current),rem=remOf(current),price=priceOf(current),committed=committedFor(current,fills);
      $('positionTitle').textContent=currentTicker;
      $('positionStatus').textContent=statusOf(current);
      $('positionStatus').className='badge good';
      $('positionSideStep').textContent=route+' · '+side;
      $('positionWager').textContent=committed!=null?fmtMoney(committed):(req!=null&&price!=null?fmtMoney(req*price/100):'—');
      $('positionRequested').textContent=req??'—';
      $('positionFilled').textContent=(filled??'—')+' / '+(rem??'—');
      const settle=results.get(currentTicker);
      $('positionDetail').textContent=(price==null?'Price unavailable':price.toFixed(0)+'¢ order price')+' · '+(settle?'settlement '+settle:'current exchange order');
    }else{
      $('positionTitle').textContent=currentTicker?'No order yet for current window':'Current market unavailable';
      $('positionStatus').textContent='NONE';$('positionStatus').className='badge';
      $('positionSideStep').textContent='—';$('positionWager').textContent='—';$('positionRequested').textContent='—';$('positionFilled').textContent='— / —';
      $('positionDetail').textContent=currentTicker?'No Regular, 420 Jump, or Back Flip order is recorded for the current ticker.':'Live market ticker unavailable.';
    }

    if(latest){
      const route=routeOf(latest,bfSet),side=sideOf(latest),req=reqOf(latest),filled=fillOf(latest),settle=results.get(orderTicker(latest));
      $('latestOrder').textContent=route+' · '+side+' · '+statusOf(latest);
      $('latestOrderSub').textContent=orderTicker(latest)+' · '+(req??'—')+' requested · '+(filled??'—')+' filled · '+(settle?'settlement '+settle:'settlement pending')+' · '+fmtTime(orderTime(latest));
    }else{
      $('latestOrder').textContent='No ETH orders returned';$('latestOrderSub').textContent='Unified exchange order feed returned no KXETH15M orders.';
    }
  }
  refreshUnifiedOps();setInterval(refreshUnifiedOps,5000);
})();
</script>`;

html = html.replace('</body>', runtime + '\n</body>');
fs.writeFileSync(path, html);
