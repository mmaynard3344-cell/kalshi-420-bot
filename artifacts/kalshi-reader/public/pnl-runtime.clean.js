(() => {
'use strict';
const ET='America/New_York', START='2026-09-22', PAGE=250, MAX_PAGES=10;
const SERVICES=[
  'A · Regular','B · Jump','C · Reversal','D · Breakout Reversal','E · Downfade',
  'F · Downfade','G · Streak Reversal','H · Ashley','I · Ash V2','J · Jackpot','K · Kamakazee',
  'Unattributed'
];
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const num=(...xs)=>{for(const v of xs){const n=Number(v);if(v!=null&&v!==''&&Number.isFinite(n))return n}return null};
const money=(c,signed=true)=>{if(c==null||!Number.isFinite(Number(c)))return'—';const n=Number(c);return (signed?(n>0?'+':n<0?'-':''):(n<0?'-':''))+'$'+(Math.abs(n)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
const ms=r=>{for(const v of[r?.created_time,r?.created_at,r?.createdAt]){const n=v?Date.parse(v):NaN;if(Number.isFinite(n))return n}for(const v of[r?.created_at_ms,r?.createdAtMs]){const n=Number(v);if(Number.isFinite(n))return n}const t=Number(r?.ts);return Number.isFinite(t)?t*1000:null};
const dk=t=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:ET,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(t));const g=x=>p.find(y=>y.type===x)?.value||'';return g('year')+'-'+g('month')+'-'+g('day')};
const time=t=>new Intl.DateTimeFormat('en-US',{timeZone:ET,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date(t));
const today=()=>dk(Date.now());
const eth=r=>String(r?.ticker??r?.market_ticker??'').startsWith('KXETH15M-');
const oid=r=>String(r?.order_id??r?.orderId??'');
const side=r=>{
  const c=String(r?.client_order_id??r?.clientOrderId??'').toLowerCase();
  if(c.startsWith('eth-yes-'))return'yes';
  if(c.startsWith('eth-no-'))return'no';
  const s=String(r?.side??r?.order_side??r?.outcome_side??'').toLowerCase();
  const a=String(r?.action??r?.order_action??'').toLowerCase();
  if(s==='bid')return'yes';
  if(s==='ask')return'no';
  if(s==='yes'&&a==='buy')return'yes';
  if(s==='yes'&&a==='sell')return'no';
  if(s==='no'&&a==='buy')return'no';
  if(s==='no'&&a==='sell')return'yes';
  if(s==='yes'||s==='no')return s;
  return'';
};
const count=r=>num(r?.count_fp,r?.count,0)||0;
const feeCents=r=>Math.round((num(r?.fee_cost_dollars,r?.fee_cost,r?.fee_dollars,0)||0)*100);
const result=r=>{const x=String(r?.market_result??r?.result??'').toLowerCase();return x==='yes'||x==='no'?x:''};
const priceDollars=(r,s)=>{const d=num(s==='no'?r?.no_price_dollars:r?.yes_price_dollars);if(d!=null)return d;const c=num(s==='no'?r?.no_price:r?.yes_price);return c==null?null:c/100};
const status=r=>String(r?.status??r?.order_status??r?.state??'').toUpperCase().replaceAll('_',' ');
const requested=r=>num(r?.initial_count_fp,r?.initial_count,r?.requested_contracts,r?.requestedContracts,r?.count_fp,r?.count);
function ownershipIndex(payload){
  const byOrder=new Map,byClient=new Map;
  for(const r of(Array.isArray(payload?.rows)?payload.rows:[])){
    if(r?.orderId)byOrder.set(String(r.orderId),String(r.service||'Unattributed'));
    if(r?.clientOrderId)byClient.set(String(r.clientOrderId),String(r.service||'Unattributed'));
  }
  return{byOrder,byClient};
}
function service(r,owners){
  const id=oid(r),c=String(r?.client_order_id??r?.clientOrderId??'');
  if(id&&owners?.byOrder?.has(id))return owners.byOrder.get(id);
  if(c&&owners?.byClient?.has(c))return owners.byClient.get(c);
  // Only retain deterministic service tags that are unique by construction.
  if(c.startsWith('g-streak-reversal-v1:'))return'G · Streak Reversal';
  if(c.endsWith(':kamakazee-k-v1'))return'K · Kamakazee';
  return'Unattributed';
}
async function j(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error(path+' HTTP '+r.status);return r.json()}
async function paged(path,key){
  let rows=[],cursor='',pages=0;const seen=new Set();
  while(pages<MAX_PAGES){
    const q=new URLSearchParams({limit:String(PAGE)});if(cursor)q.set('cursor',cursor);
    const x=await j(path+'?'+q),p=Array.isArray(x?.[key])?x[key]:[];
    rows.push(...p);pages++;
    const oldest=p.reduce((v,r)=>{const t=ms(r);return t==null?v:Math.min(v,t)},Infinity);
    if(oldest!==Infinity&&dk(oldest)<START)break;
    const n=String(x?.cursor??x?.next_cursor??x?.nextCursor??'');if(!n||seen.has(n)||!p.length)break;seen.add(n);cursor=n;
  }
  return rows.filter(r=>{const t=ms(r);return t!=null&&dk(t)>=START});
}
function fillsByOrder(fills,orders,owners,canonicalResults){
  const idx=new Map(orders.map(o=>[oid(o),o])),m=new Map;
  for(const f of fills){
    if(!eth(f))continue;const t=ms(f),id=oid(f);if(t==null||!id)continue;
    const ord=idx.get(id),s=ord?side(ord):side(f),n=count(f),p=priceDollars(f,s);if(!(n>0)||p==null)continue;
    const o=m.get(id)||{id,ticker:String(f.ticker??f.market_ticker??''),side:s,atMs:t,contracts:0,principalCents:0,feesCents:0,weighted:0,result:'',service:service(f,owners)!=='Unattributed'?service(f,owners):service(ord,owners)};
    o.contracts+=n;o.principalCents+=Math.round(n*p*100);o.feesCents+=feeCents(f);o.weighted+=n*p*100;o.atMs=Math.min(o.atMs,t);
    const rr=result(f);if(rr)o.result=rr;m.set(id,o);
  }
  for(const o of m.values()){
    const canonical=canonicalResults?.get(o.ticker);
    if(canonical==='yes'||canonical==='no')o.result=canonical;
    o.avgFillPriceCents=o.contracts?o.weighted/o.contracts:null;
    o.won=!!o.result&&o.side===o.result;
    o.netCents=o.result?(o.won?o.contracts*100-o.principalCents-o.feesCents:-o.principalCents-o.feesCents):null
  }
  return m;
}
function renderAccount(b){
  const cash=num(b?.aggregate_balance_cents,b?.balance_cents,b?.balance!=null?Number(b.balance):null,b?.balance_dollars!=null?Number(b.balance_dollars)*100:null);
  const port=num(b?.portfolio_value,b?.portfolio_value_cents,0);
  const equity=cash==null?null:cash+(port??0);
  $('cash').textContent=money(cash,false);$('portfolio').textContent=money(port,false);$('equity').textContent=money(equity,false);
  $('accountState').textContent=b?.stale?'STALE':'LIVE';$('accountState').className='pill '+(b?.stale?'warn':'good');
}
function renderMarket(x){
  const m=x?.market??null,e=x?.availability?.status==='fresh'?x?.evidence:null;
  $('ticker').textContent=m?.ticker||'Unavailable';
  $('window').textContent=m?time(Date.parse(m.openTime))+' – '+time(Date.parse(m.closeTime)):'Live ETH market unavailable';
  $('yesBid').textContent=e?.yesBid==null?'—':e.yesBid+'¢';$('yesAsk').textContent=e?.yesAsk==null?'—':e.yesAsk+'¢';
  $('noBid').textContent=e?.noBid==null?'—':e.noBid+'¢';$('noAsk').textContent=e?.noAsk==null?'—':e.noAsk+'¢';
}
function renderOpenOrders(raw,owners){
  const rows=Array.isArray(raw)?raw:Array.isArray(raw?.orders)?raw.orders:[];
  const open=rows.filter(o=>{const s=String(o?.status??o?.order_status??'').toLowerCase(),r=num(o?.remaining_count_fp,o?.remaining_count,o?.remainingContracts,0)||0;return r>0||['open','resting','pending','submitted','active','partially_filled'].includes(s)});
  $('openCount').textContent=open.length+' open';
  $('openRows').innerHTML=open.length?open.map(o=>`<tr><td>${esc(service(o,owners))}</td><td>${esc(o.ticker??o.market_ticker??'—')}</td><td>${esc(String(side(o)||'—').toUpperCase())}</td><td class="num">${esc(requested(o)??'—')}</td><td class="num">${esc(num(o?.fill_count_fp,o?.filled_count_fp,o?.filled_count,o?.filledContracts)??'—')}</td><td class="num">${esc(num(o?.remaining_count_fp,o?.remaining_count,o?.remainingContracts)??'—')}</td><td>${esc(status(o)||'—')}</td></tr>`).join(''):'<tr><td colspan="7" class="empty">No open orders.</td></tr>';
}
function renderShadow(d){
  const sums=Array.isArray(d?.summaries)?d.summaries:[],a2=sums.find(x=>x?.strategy==='A2')||null,l=sums.find(x=>x?.strategy==='L')||null,rows=Array.isArray(d?.rows)?d.rows:[];
  const total=Number(a2?.simulatedPnlCents||0)+Number(l?.simulatedPnlCents||0),active=Number(a2?.active||0)+Number(l?.active||0),blocked=Number(a2?.blocked||0)+Number(l?.blocked||0),settled=Number(a2?.settled||0)+Number(l?.settled||0);
  const metric=(id,v)=>{const e=$(id);e.textContent=money(v);e.className='metric '+(v>0?'good':v<0?'bad':'')};
  metric('shadowCombined',total);metric('shadowA2',Number(a2?.simulatedPnlCents||0));metric('shadowL',Number(l?.simulatedPnlCents||0));
  $('shadowA2Meta').textContent=a2?`${a2.settled||0} settled · ${a2.wins||0}W / ${a2.losses||0}L · ${a2.winRate==null?'—':(Number(a2.winRate)*100).toFixed(1)+'%'}`:'No A2 summary';
  $('shadowLMeta').textContent=l?`${l.settled||0} settled · ${l.wins||0}W / ${l.losses||0}L · ${l.winRate==null?'—':(Number(l.winRate)*100).toFixed(1)+'%'}`:'No L summary';
  $('shadowActive').textContent=String(active);$('shadowBlocked').textContent=`${blocked} blocked/released`;$('shadowSettled').textContent=String(settled);
  $('shadowFresh').textContent=d?.generatedAtMs?'Updated '+new Intl.DateTimeFormat('en-US',{timeZone:ET,hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date(Number(d.generatedAtMs))):'Shadow ledger loaded';
  const healthRows=Array.isArray(d?.services)?d.services:[];
  $('shadowEvalRows').innerHTML=healthRows.length?healthRows.map(s=>{
    const h=String(s?.health??'unknown'),decision=String(s?.latestDecision??'—').replaceAll('_',' '),reason=String(s?.latestReason??'—').replaceAll('_',' ');
    const cls=h==='healthy'?'good':h==='stale'||h==='unavailable'?'bad':'';
    return`<tr><td>${esc(s?.service??'—')}</td><td class="${cls}">${esc(h.toUpperCase())}</td><td>${s?.lastEvaluationAtMs?time(Number(s.lastEvaluationAtMs)):'—'}</td><td>${esc(s?.latestTicker??'—')}</td><td>${esc(decision)}</td><td>${esc(reason)}</td><td class="num">${esc(s?.evaluationsRecent??0)}</td><td class="num">${esc(s?.noSignalRecent??0)}</td><td class="num">${esc(s?.wouldSubmitRecent??0)}</td></tr>`;
  }).join(''):'<tr><td colspan="9" class="empty">No evaluator health data yet.</td></tr>';
  $('shadowRows').innerHTML=rows.length?rows.slice(0,100).map(r=>{const p=r?.pnlCents==null?null:Number(r.pnlCents),why=r?.settlementResult??r?.terminalReason?.replaceAll('_',' ')??'Pending';return`<tr><td>${r?.createdAtMs?time(Number(r.createdAtMs)):'—'}</td><td>${esc(r?.strategy??'—')}</td><td>${esc(r?.ticker??'—')}</td><td class="num">${r?.entryPriceCents==null?'—':Number(r.entryPriceCents).toFixed(0)+'¢'}</td><td class="num">${esc(r?.contracts??'—')}</td><td class="num">${r?.principalCents==null?'—':money(r.principalCents,false)}</td><td>${esc(String(r?.state??'—').replaceAll('_',' '))}</td><td>${esc(why)}</td><td class="num ${p>0?'good':p<0?'bad':''}">${p==null?'Pending':money(p)}</td></tr>`}).join(''):'<tr><td colspan="9" class="empty">No A2 or L shadow intents have qualified yet.</td></tr>';
}
function renderPnl(fills,orders,owners,ledgerToday,marketResults,bigBetRows,restartPnl){
  const canonicalResults=new Map((Array.isArray(marketResults?.rows)?marketResults.rows:[]).map(r=>[String(r?.ticker??''),String(r?.result??'').toLowerCase()]));
  const canonicalBigBets=new Map((Array.isArray(bigBetRows?.rows)?bigBetRows.rows:[]).map(r=>[(String(r?.strategy??'').toLowerCase()+'|'+String(r?.ticker??'')),r]));
  const fm=fillsByOrder(fills,orders,owners,canonicalResults);
  for(const row of fm.values()){
    const strategyKey=row.service==='B · Jump'?'jump':row.service==='C · Reversal'?'reversal':'';
    if(!strategyKey)continue;
    const canonical=canonicalBigBets.get(strategyKey+'|'+row.ticker);
    if(!canonical)continue;
    const contracts=num(canonical?.filled_contracts),avg=num(canonical?.fill_price_cents),fees=num(canonical?.actual_fee_cents),pnl=num(canonical?.canonical_pnl_cents);
    const result=String(canonical?.market_result??'').toLowerCase();
    if(contracts!=null)row.contracts=contracts;
    if(avg!=null)row.avgFillPriceCents=avg;
    if(fees!=null)row.feesCents=fees;
    if(result==='yes'||result==='no'){row.result=result;row.won=row.side===result}
    row.netCents=pnl;
  }
  const td=today(),settled=[...fm.values()].filter(x=>x.result&&x.netCents!=null&&dk(x.atMs)===td);
  const canonicalDay=(Array.isArray(restartPnl?.days)?restartPnl.days:[]).find(x=>x?.easternDate===td)||null;
  const canonicalSvcRows=(Array.isArray(restartPnl?.byService)?restartPnl.byService:[]).filter(x=>x?.easternDate===td);
  const wins=canonicalDay?Number(canonicalDay.wins||0):settled.filter(x=>x.won).length;
  const losses=canonicalDay?Number(canonicalDay.losses||0):settled.length-wins;
  const fees=canonicalDay?Number(canonicalDay.feesCents||0):settled.reduce((s,x)=>s+Number(x.feesCents||0),0);
  const total=canonicalDay?Number(canonicalDay.pnlCents||0):settled.reduce((s,x)=>s+Number(x.netCents||0),0);
  const settledCount=canonicalDay?Number(canonicalDay.settled||0):settled.length;
  $('pnl').textContent=money(total);
  $('pnl').className='metric '+(total>0?'good':total<0?'bad':'');
  $('settled').textContent=String(settledCount);
  $('wins').textContent=String(wins);$('losses').textContent=String(losses);$('fees').textContent=money(fees,false);
  const canonicalByService=new Map(canonicalSvcRows.map(r=>[String(r?.service??'Unattributed'),{name:String(r?.service??'Unattributed'),n:Number(r?.settled||0),pnl:Number(r?.pnlCents||0)}]));
  const fallbackByService=new Map();
  for(const row of settled){
    const name=row.service||'Unattributed',prior=fallbackByService.get(name)||{name,n:0,pnl:0};
    prior.n+=1;prior.pnl+=Number(row.netCents||0);fallbackByService.set(name,prior);
  }
  const sourceByService=canonicalDay?canonicalByService:fallbackByService;
  const svc=SERVICES.map(name=>sourceByService.get(name)||{name,n:0,pnl:0}).filter(x=>x.n>0||x.name!=='Unattributed');
  $('serviceRows').innerHTML=svc.map(x=>`<tr><td>${esc(x.name)}</td><td class="num">${x.n}</td><td class="num ${x.pnl>0?'good':x.pnl<0?'bad':''}">${money(x.pnl)}</td></tr>`).join('');
  const rows=orders.filter(eth).sort((a,b)=>(ms(b)||0)-(ms(a)||0)).slice(0,100);
  $('tradeCount').textContent=rows.length+' recent';
  $('tradeRows').innerHTML=rows.length?rows.map(o=>{
    const f=fm.get(oid(o)),t=ms(o),svc=service(o,owners),filled=f?.contracts??num(o?.fill_count_fp,o?.filled_count_fp,o?.filled_count,o?.filledContracts),avg=f?.avgFillPriceCents,pnl=f?.netCents,fee=f?.feesCents;
    return`<tr><td>${t==null?'—':time(t)}</td><td>${esc(svc)}</td><td>${esc(o.ticker??'—')}</td><td>${esc(String(side(o)||'—').toUpperCase())}</td><td class="num">${esc(requested(o)??'—')}</td><td class="num">${esc(filled??'—')}</td><td class="num">${avg==null?'—':Number(avg).toFixed(1)+'¢'}</td><td>${esc(status(o)||'—')}</td><td class="num">${fee==null?'—':money(fee,false)}</td><td class="num ${pnl>0?'good':pnl<0?'bad':''}">${pnl==null?'Pending':money(pnl)}</td></tr>`
  }).join(''):'<tr><td colspan="10" class="empty">No Sep. 22-forward ETH orders.</td></tr>';
}
let busy=false;
async function refresh(){
  if(busy)return;busy=true;$('stamp').textContent='Refreshing…';
  try{
    const [b,m,o,f,w,l,sh,mr,bb,rp]=await Promise.allSettled([j('/api/trade/balance'),j('/api/trade/analytics/eth420-live-market'),paged('/api/trade/orders','orders'),paged('/api/trade/fills','fills'),j('/api/diagnostics/service-ownership'),j('/api/diagnostics/service-ledger-today'),j('/api/diagnostics/shadow-performance'),j('/api/diagnostics/market-results-recent'),j('/api/diagnostics/big-bet-rows-recent'),j('/api/diagnostics/restart-daily-pnl')]);
    if(b.status==='fulfilled')renderAccount(b.value);else $('accountState').textContent='UNAVAILABLE';
    if(m.status==='fulfilled')renderMarket(m.value);
    const orderRows=o.status==='fulfilled'?o.value:[];
    const owners=w.status==='fulfilled'?ownershipIndex(w.value):ownershipIndex(null);
    renderOpenOrders(orderRows,owners);
    if(f.status==='fulfilled')renderPnl(f.value,orderRows,owners,l.status==='fulfilled'?l.value:null,mr.status==='fulfilled'?mr.value:null,bb.status==='fulfilled'?bb.value:null,rp.status==='fulfilled'?rp.value:null);
    if(sh.status==='fulfilled')renderShadow(sh.value);else{$('shadowFresh').textContent='Shadow ledger unavailable';$('shadowRows').innerHTML='<tr><td colspan="9" class="empty">A2/L shadow endpoint unavailable.</td></tr>'}
    $('stamp').textContent='Updated '+new Intl.DateTimeFormat('en-US',{timeZone:ET,hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date());
  }catch(e){$('stamp').textContent='Partial data · '+String(e?.message??e)}
  finally{busy=false}
}
refresh();setInterval(refresh,60000);
})();