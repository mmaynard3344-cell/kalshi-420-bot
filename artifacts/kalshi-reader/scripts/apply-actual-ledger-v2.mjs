import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');
let source = readFileSync(dashboardPath, 'utf8');

if (source.includes('actual-ledger-v2')) process.exit(0);

source = source.replace('ETH 420 transaction log', 'ETH 15-minute transaction log');
source = source.replace(
  'Newest first · Eastern Time · actual candidate lifecycle and fill data when available.',
  'Newest first · Eastern Time · actual Kalshi ETH orders and fills across Regular, 420 Jump and Back Flip roads.',
);
source = source.replace('Original-dashboard style ledger', 'Actual exchange ledger');

const renderHistoryPattern = /function renderHistory\(d\)\{[\s\S]*?\}\nasync function j/;
if (!renderHistoryPattern.test(source)) {
  throw new Error('actual-ledger-v2: candidate renderHistory block not found');
}
source = source.replace(renderHistoryPattern, `function renderHistory(d){
const state=d?.state||null,orders=[...(d?.orders||[])].sort((a,b)=>Number(b.createdAtMs)-Number(a.createdAtMs)),latest=orders[0]||null;
$('opSide').textContent=state?.side?.toUpperCase()||'—';
$('opStepWager').textContent=state?\`Step \${state.step} · \${d?.operationalStatus?.nextNormalWagerCents==null?'—':money(d.operationalStatus.nextNormalWagerCents,false)}\`:'—';
$('ledgerSub').textContent='Actual Kalshi ETH fills determine realized P&L below; candidate history is strategy telemetry only.';
if(latest){$('latestOrder').textContent=\`\${String(latest.status).replaceAll('_',' ').toUpperCase()} · \${String(latest.side).toUpperCase()} · Step \${latest.step}\`;$('latestOrderSub').textContent=\`\${latest.ticker} · \${money(latest.effectiveWagerCents,false)} · \${latest.filledContracts??'—'} filled · candidate telemetry\`}
$('rawData').textContent=JSON.stringify(d,null,2)
}
async function j`);

if (!source.includes('</body>')) throw new Error('actual-ledger-v2: body close not found');
const overlay = String.raw`
<script id="actual-ledger-v2">
(() => {
  const ET='America/New_York';
  const el=(id)=>document.getElementById(id);
  const esc=(v)=>String(v??'').replace(/[&<>"']/g,(s)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  const num=(...vals)=>{for(const v of vals){const n=Number(v);if(v!=null&&Number.isFinite(n))return n}return null};
  const money=(c,signed=true)=>{const n=Number(c||0);const p=signed?(n>0?'+':n<0?'-':''):(n<0?'-':'');return p+'$'+(Math.abs(n)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
  const dayKey=(ms)=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:ET,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));const g=(t)=>p.find(x=>x.type===t)?.value||'';return g('year')+'-'+g('month')+'-'+g('day')};
  const dayLabel=(k)=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(k+'T00:00:00Z'));
  const clock=(ms)=>new Intl.DateTimeFormat('en-US',{timeZone:ET,hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(ms));
  const atMs=(row)=>{for(const v of [row.created_time,row.created_at,row.createdAt]){if(v){const m=Date.parse(v);if(Number.isFinite(m))return m}}for(const v of [row.created_at_ms,row.createdAtMs]){const m=Number(v);if(Number.isFinite(m))return m}return null};
  const fillAtMs=(row)=>{if(row.created_time){const m=Date.parse(row.created_time);if(Number.isFinite(m))return m}const t=Number(row.ts);return Number.isFinite(t)?t*1000:null};
  const oid=(row)=>String(row.order_id??row.orderId??'');
  const isEth=(row)=>String(row?.ticker||'').startsWith('KXETH15M-');
  const side=(row)=>String(row?.side||'').toLowerCase();
  const fillCount=(row)=>num(row.count_fp,row.count,0)||0;
  const fillPrice=(row,s)=>num(s==='no'?row.no_price_dollars:row.yes_price_dollars,s==='no'?row.no_price:row.yes_price);
  const feeDollars=(row)=>num(row.fee_cost,row.fee_cost_dollars,0)||0;
  const result=(row)=>{const r=String(row.market_result||'').toLowerCase();return r==='yes'||r==='no'?r:''};
  const orderRequested=(row)=>num(row.initial_count_fp,row.initial_count,row.count_fp,row.count,row.requested_contracts,row.requestedContracts,0)||0;
  const orderFilled=(row)=>num(row.fill_count_fp,row.fill_count,row.filled_count_fp,row.filled_count,row.filled_contracts,row.filledContracts,0)||0;
  const orderStatus=(row)=>String(row.status??row.order_status??row.state??'').toUpperCase().replaceAll('_',' ');
  const clientId=(row)=>String(row.client_order_id??row.clientOrderId??'');
  const road=(row)=>{const c=clientId(row);if(c.startsWith('eth-yes-')||c.startsWith('eth-no-'))return'Regular';if(c.endsWith(':eth420-live-v1'))return'420 / Back Flip';return'ETH'};

  function summarize(fills){
    const orders=new Map();
    for(const f of fills){if(!isEth(f))continue;const ms=fillAtMs(f);if(ms==null)continue;const s=side(f),count=fillCount(f),price=fillPrice(f,s);if(!(count>0)||price==null)continue;const id=oid(f)||String(f.fill_id||f.ticker+':'+ms+':'+s);const x=orders.get(id)||{id,ticker:String(f.ticker),side:s,atMs:ms,contracts:0,principal:0,fees:0,result:''};x.atMs=Math.min(x.atMs,ms);x.contracts+=count;x.principal+=Math.round(count*price*(price>1?1:100));x.fees+=Math.round(feeDollars(f)*100);const r=result(f);if(r)x.result=r;orders.set(id,x)}
    const days=new Map();
    for(const o of orders.values()){const k=dayKey(o.atMs),settled=!!o.result,won=settled&&o.result===o.side,gross=settled?(won?Math.round(o.contracts*100)-o.principal:-o.principal):0,net=settled?gross-o.fees:0;const d=days.get(k)||{easternDate:k,settled:0,wins:0,losses:0,wagered:0,fees:0,net:0};d.wagered+=o.principal;d.fees+=o.fees;if(settled){d.settled++;d.wins+=won?1:0;d.losses+=won?0:1;d.net+=net}days.set(k,d)}
    return {orders,days:[...days.values()].sort((a,b)=>a.easternDate.localeCompare(b.easternDate))};
  }

  function paintSummary(daily){
    const todayKey=dayKey(Date.now()),today=daily.find(d=>d.easternDate===todayKey)||{net:0,settled:0,wins:0,losses:0};
    const [yy,mm,dd]=todayKey.split('-').map(Number),tmp=new Date(Date.UTC(yy,mm-1,dd)),dow=tmp.getUTCDay();tmp.setUTCDate(tmp.getUTCDate()-((dow+6)%7));const weekKey=tmp.toISOString().slice(0,10),month=todayKey.slice(0,7);
    const week=daily.filter(d=>d.easternDate>=weekKey&&d.easternDate<=todayKey).reduce((s,d)=>s+d.net,0),mon=daily.filter(d=>d.easternDate.startsWith(month)).reduce((s,d)=>s+d.net,0),all=daily.reduce((s,d)=>s+d.net,0),wins=daily.reduce((s,d)=>s+d.wins,0),losses=daily.reduce((s,d)=>s+d.losses,0),den=wins+losses;
    for(const [id,v] of [['opPnl',today.net],['pnlToday',today.net],['pnlWeek',week],['pnlMonth',mon],['pnlAll',all]]){if(el(id)){el(id).textContent=money(v);el(id).classList.toggle('good',v>0);el(id).classList.toggle('bad',v<0)}}
    if(el('statWinRate'))el('statWinRate').textContent=den?(wins/den*100).toFixed(1)+'%':'—';
    if(el('statAvgDay'))el('statAvgDay').textContent=daily.length?money(Math.round(all/daily.length)):'—';
    if(el('statBestWorst')){const s=[...daily].sort((a,b)=>a.net-b.net);el('statBestWorst').textContent=s.length?money(s.at(-1).net)+' / '+money(s[0].net):'—'}
    if(el('dayCount'))el('dayCount').textContent=daily.length+' days · actual fills';
    if(el('dailyRows'))el('dailyRows').innerHTML=[...daily].reverse().map(d=>'<tr><td>'+dayLabel(d.easternDate)+'</td><td class="num">'+d.settled+'</td><td class="num">'+d.wins+'</td><td class="num">'+d.losses+'</td><td class="num">'+money(d.wagered,false)+'</td><td class="num">'+money(d.fees,false)+'</td><td class="num '+(d.net>0?'good':d.net<0?'bad':'')+'">'+money(d.net)+'</td></tr>').join('')||'<tr><td colspan="7" class="empty">No actual ETH fills available.</td></tr>';
  }

  function paintOrders(rawOrders,fillMap){
    const rows=rawOrders.filter(isEth).sort((a,b)=>(atMs(b)||0)-(atMs(a)||0)).slice(0,250);
    if(el('orderCount'))el('orderCount').textContent=rows.length+' actual orders';
    if(!el('orderRows'))return;
    el('orderRows').innerHTML=rows.map(o=>{const id=oid(o),f=fillMap.get(id),ms=atMs(o),s=side(o),requested=orderRequested(o),filled=f?f.contracts:orderFilled(o),principal=f?f.principal:0,avg=f&&f.contracts?Math.round(f.principal/f.contracts):null,settlement=f?.result?f.result.toUpperCase():(filled===0?'NO FILL':'PENDING'),won=!!(f?.result&&f.result===s),pnl=f?.result?(won?Math.round(f.contracts*100)-f.principal-f.fees:-f.principal-f.fees):null,status=orderStatus(o)||'—';return'<tr><td>'+(ms==null?'—':dayLabel(dayKey(ms))+' · '+clock(ms))+'</td><td>'+esc(o.ticker)+'</td><td class="txn-side">'+esc(road(o))+' · '+esc(s.toUpperCase()||'—')+'</td><td class="num">'+money(principal,false)+'</td><td class="num">'+requested+' · '+filled+'</td><td class="num">'+(avg==null?'—':avg+'¢')+'</td><td class="txn-result">'+esc(settlement+' · '+status)+'</td><td class="num">'+money(f?.fees||0,false)+'</td><td class="num '+(pnl>0?'good':pnl<0?'bad':'')+'">'+(pnl==null?'Pending':money(pnl))+'</td></tr>'}).join('')||'<tr><td colspan="9" class="empty">No actual ETH orders available.</td></tr>';
  }

  let busy=false;
  async function refresh(){if(busy)return;busy=true;try{const [fr,or]=await Promise.all([fetch('/api/trade/fills?limit=10000',{cache:'no-store'}),fetch('/api/trade/orders?limit=1000',{cache:'no-store'})]);if(!fr.ok||!or.ok)throw new Error('fills '+fr.status+' / orders '+or.status);const fp=await fr.json(),op=await or.json(),fills=Array.isArray(fp?.fills)?fp.fills:[],orders=Array.isArray(op?.orders)?op.orders:[];const summary=summarize(fills);paintSummary(summary.days);paintOrders(orders,summary.orders);if(el('ledgerSub'))el('ledgerSub').textContent='Actual Kalshi ETH fills · '+summary.orders.size+' filled orders in available history';}catch(e){if(el('ledgerSub'))el('ledgerSub').textContent='Actual ETH ledger unavailable · '+String(e)}finally{busy=false}}
  refresh();setInterval(refresh,5000);
})();
</script>`;

source = source.replace('</body>', overlay + '\n</body>');
writeFileSync(dashboardPath, source);
