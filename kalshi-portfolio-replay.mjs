#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('./kalshi-100day-research');
const RAW = path.join(ROOT, 'raw', 'eth15m-markets-merged.json');
const OUT = path.join(ROOT, 'portfolio-replay-100d.json');
const CSV = path.join(ROOT, 'portfolio-replay-100d-daily.csv');
const DAY = 86_400_000;
const QTR = 15 * 60_000;
const SCORE_DAYS = 100;
const HISTORY_DAYS = 28;
const MIN_HISTORY = 50;

const SOURCES = {
  A: 'c964e5575231117f73220eb35427dc24c733931c',
  B: '41be546ba25d90dd6481a4f60a465177ad418a6d',
  C: 'be56a20dad5e8ac6dc69301ebe698c8fc0893d7e',
  D: '885c0d14629c215db55200a55f101b8fb53eb525',
  EF: '4886c04a5db7419cb310555237145f6e8afd9a39',
  H: 'fa4391d8a04cd313ebb7d581e494ff89a9b33f73',
  I: '4238ef48a2e5aeb5667f62da3598a83646259414',
};

// Research-only temporary sizing scenario: B-I fixed at $100 each; G excluded. A remains unchanged.
const stakes = { B:10000, C:10000, D:10000, E:10000, F:10000, H:10000, I:10000 };
const aStakes = [1500,3000,6000,12000,24000,32000];

function pct(sorted,p){ if(!sorted.length) return null; const i=(sorted.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return lo===hi?sorted[lo]:sorted[lo]+(sorted[hi]-sorted[lo])*(i-lo); }
function fee(wager){ const contracts=Math.floor(Math.max(0,wager)/50); return Math.ceil(0.07*contracts*50*50/100); }
function pnl(wager,win){ const f=fee(wager); return win ? wager-f : -wager-f; }
function money(c){ return Math.round(c)/100; }
function etDay(ms){ const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms)); const o={}; for(const p of parts) o[p.type]=p.value; return `${o.year}-${o.month}-${o.day}`; }
function esc(x){ const s=String(x??''); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }

const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const rows=raw.map(m=>({
  ticker:m.ticker,
  t:Date.parse(m.open_time),
  floor:Number(m.floor_strike),
  result:String(m.result||'').toLowerCase(),
})).filter(r=>/^KXETH15M-/.test(String(r.ticker))&&Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>0)
.sort((a,b)=>a.t-b.t);
if(rows.length<5000) throw new Error(`insufficient market data: ${rows.length}`);
const end=rows.at(-1).t;
const scoreStart=end-SCORE_DAYS*DAY;

for(let i=0;i<rows.length;i++){
  const r=rows[i], p=rows[i-1];
  if(p && r.t-p.t===QTR){ r.signedMove=(r.floor-p.floor)/p.floor; r.absMove=Math.abs(r.signedMove); r.prior=p; }
  else { r.signedMove=null; r.absMove=null; r.prior=null; }
}

function trailingBands(t){
  const start=t-HISTORY_DAYS*DAY;
  const m=[];
  for(const r of rows){ if(r.t>=t) break; if(r.t>=start && r.absMove!=null) m.push(r.absMove); }
  m.sort((a,b)=>a-b);
  if(m.length<MIN_HISTORY) return {n:m.length,p80:null,p90:null,p95:null,p99:null};
  return {n:m.length,p80:pct(m,.80),p90:pct(m,.90),p95:pct(m,.95),p99:pct(m,.99)};
}

const services=['A','B','C','D','E','F','H','I'];
const stat=Object.fromEntries(services.map(s=>[s,{trades:0,wins:0,losses:0,pnl:0,peak:0,maxDrawdown:0,lastSignal:null}]));
const daily=new Map();
const trades=[];
let portfolio=0, portfolioPeak=0, portfolioMaxDD=0;
let a={day:null,side:'no',step:0};

function addTrade(service,r,side,wager,extra={}){
  if(r.t<scoreStart || (r.result!=='yes'&&r.result!=='no')) return;
  const win=r.result===side;
  const pc=pnl(wager,win);
  const s=stat[service]; s.trades++; s[win?'wins':'losses']++; s.pnl+=pc; s.peak=Math.max(s.peak,s.pnl); s.maxDrawdown=Math.max(s.maxDrawdown,s.peak-s.pnl); s.lastSignal=r.t;
  const d=etDay(r.t); if(!daily.has(d)) daily.set(d,Object.fromEntries([...services.map(x=>[x,0]),['total',0],['trades',0]]));
  const dr=daily.get(d); dr[service]+=pc; dr.total+=pc; dr.trades++;
  trades.push({t:r.t,date:d,ticker:r.ticker,service,side,result:r.result,wager_cents:wager,fee_cents:fee(wager),pnl_cents:pc,...extra});
  return pc;
}

for(let i=0;i<rows.length;i++){
  const r=rows[i];
  if(r.result!=='yes'&&r.result!=='no') continue;
  const day=etDay(r.t);
  if(a.day!==day){ a={day,side:'no',step:0}; }
  const aSideBefore=a.side;
  const bands=(r.t>=scoreStart || r.t>=scoreStart-HISTORY_DAYS*DAY) ? trailingBands(r.t) : null;
  const prev3=i>=3 ? rows.slice(i-3,i) : [];
  const prev3No=prev3.length===3 && prev3.every((x,j)=>x.result==='no' && (j===0? x.t===r.t-3*QTR : x.t===prev3[j-1].t+QTR));

  if(r.t>=scoreStart){
    const wager=aStakes[a.step];
    addTrade('A',r,a.side,wager,{step:a.step});
  }

  if(r.absMove!=null && bands?.p95!=null && r.absMove>=bands.p95 && r.absMove<bands.p99){
    addTrade('B',r,aSideBefore,stakes.B,{move:r.absMove,p95:bands.p95,p99:bands.p99});
  }
  if(prev3No && r.absMove!=null && bands?.p95!=null && r.absMove>=bands.p95 && r.absMove<bands.p99){
    addTrade('C',r,'yes',stakes.C,{move:r.absMove,p95:bands.p95,p99:bands.p99});
  }
  if(prev3No && r.absMove!=null && bands?.p95!=null){
    const upper=bands.p95+(bands.p99-bands.p95)/2;
    if(r.absMove>=upper && r.absMove<bands.p99) addTrade('D',r,'yes',stakes.D,{move:r.absMove,p95:bands.p95,p99:bands.p99,upperBandFloor:upper});
  }
  if(r.signedMove!=null && r.signedMove<0 && bands?.p80!=null){
    const m=Math.abs(r.signedMove);
    if(m>=bands.p80 && m<bands.p90) addTrade('E',r,'yes',stakes.E,{move:m,p80:bands.p80,p90:bands.p90});
    if(m>=bands.p90 && m<bands.p95) addTrade('F',r,'yes',stakes.F,{move:m,p90:bands.p90,p95:bands.p95});
  }
  if(r.signedMove!=null && r.signedMove<0){
    const d=-r.signedMove;
    if(d>=0.0070 && d<0.0095) addTrade('H',r,'yes',stakes.H,{move:d});
  }
  if(r.signedMove!=null){
    if(r.signedMove<0){ const d=-r.signedMove; if(d>=0.0060&&d<0.0099) addTrade('I',r,'yes',stakes.I,{move:d}); }
    else if(r.signedMove>0){ const u=r.signedMove; if(u>=0.0050&&u<0.0080) addTrade('I',r,'no',stakes.I,{move:u}); }
  }

  const aWin=r.result===a.side;
  if(aWin){ a.side=a.side==='yes'?'no':'yes'; a.step=0; }
  else { a.step=a.step<5?a.step+1:0; }
}

const byT=new Map(); for(const t of trades){ if(!byT.has(t.t)) byT.set(t.t,[]); byT.get(t.t).push(t); }
for(const [t,ts] of [...byT.entries()].sort((a,b)=>a[0]-b[0])){
  portfolio += ts.reduce((s,x)=>s+x.pnl_cents,0); portfolioPeak=Math.max(portfolioPeak,portfolio); portfolioMaxDD=Math.max(portfolioMaxDD,portfolioPeak-portfolio);
}

const summaries={};
for(const svc of services){ const s=stat[svc]; summaries[svc]={trades:s.trades,wins:s.wins,losses:s.losses,win_rate:s.trades?s.wins/s.trades:null,net_pnl_dollars:money(s.pnl),max_drawdown_dollars:money(s.maxDrawdown),last_signal:s.lastSignal?new Date(s.lastSignal).toISOString():null,hours_since_last_signal:s.lastSignal?(end-s.lastSignal)/3600e3:null}; }
const days=[...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,x])=>({date,...Object.fromEntries(services.map(s=>[s,money(x[s])])),total:money(x.total),trades:x.trades}));
const dailyTotals=days.map(d=>d.total);
const report={
  generated_at:new Date().toISOString(),
  methodology:'Research-only temporary sizing: B,C,D,E,F,H,I fixed at $100 each; A unchanged; G excluded. Theoretical full fill at 50c for every qualifying signal; 50c Kalshi fee estimate; no liquidity/queue/zero-fill/slippage/capital-block modeling.',
  source_commits:SOURCES,
  raw_market_window:{start:new Date(rows[0].t).toISOString(),end:new Date(end).toISOString(),usable_markets:rows.length},
  scored_window:{start:new Date(scoreStart).toISOString(),end:new Date(end).toISOString(),days:SCORE_DAYS},
  percentile_warmup_days:HISTORY_DAYS,
  services:summaries,
  portfolio:{net_pnl_dollars:money(portfolio),max_drawdown_dollars:money(portfolioMaxDD),positive_days:days.filter(d=>d.total>0).length,negative_days:days.filter(d=>d.total<0).length,flat_days:days.filter(d=>d.total===0).length,best_day:days.reduce((a,b)=>!a||b.total>a.total?b:a,null),worst_day:days.reduce((a,b)=>!a||b.total<a.total?b:a,null),avg_daily_pnl_dollars:dailyTotals.length?dailyTotals.reduce((a,b)=>a+b,0)/dailyTotals.length:null},
  daily:days,
  trades,
};
fs.writeFileSync(OUT,JSON.stringify(report,null,2));
const head=['date',...services,'total','trades'];
fs.writeFileSync(CSV,[head.join(','),...days.map(d=>head.map(k=>esc(d[k])).join(','))].join('\n')+'\n');
console.error(`PORTFOLIO_REPLAY_SUMMARY ${JSON.stringify({scored_start:report.scored_window.start,scored_end:report.scored_window.end,portfolio:report.portfolio,services:report.services})}`);
for(const d of days.slice(-14)) console.error(`PORTFOLIO_REPLAY_DAY ${JSON.stringify(d)}`);
