#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('./kalshi-100day-research');
const RAW = path.join(ROOT,'raw','eth15m-markets-merged.json');
const OUT = path.join(ROOT,'regime-analysis.json');

function pct(arr,p){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); const i=(a.length-1)*p; const lo=Math.floor(i), hi=Math.ceil(i); if(lo===hi) return a[lo]; return a[lo]+(a[hi]-a[lo])*(i-lo); }
function mean(a){ return a.length?a.reduce((s,x)=>s+x,0)/a.length:null; }
function median(a){ return pct(a,0.5); }
function rank(v,a){ if(!a.length||v==null) return null; let le=0; for(const x of a) if(x<=v) le++; return 100*le/a.length; }
function iso(ms){ return new Date(ms).toISOString(); }
function streakStats(results){ let max=0,cur=0,prev=null, yesMax=0,noMax=0; for(const r of results){ if(r!== 'yes'&&r!=='no') continue; cur=(r===prev)?cur+1:1; prev=r; max=Math.max(max,cur); if(r==='yes') yesMax=Math.max(yesMax,cur); else noMax=Math.max(noMax,cur); } return {max_streak:max,max_yes_streak:yesMax,max_no_streak:noMax}; }
function features(rows){
  if(rows.length<2) return null;
  const floors=rows.map(r=>r.floor);
  const rets=[]; for(let i=1;i<rows.length;i++) rets.push((rows[i].floor-rows[i-1].floor)/rows[i-1].floor);
  const abs=rets.map(Math.abs);
  const first=floors[0], last=floors[floors.length-1], min=Math.min(...floors), max=Math.max(...floors);
  const pathLen=abs.reduce((s,x)=>s+x,0);
  const net=(last-first)/first;
  const st=streakStats(rows.map(r=>r.result));
  return {
    n:rows.length,
    range_pct:100*(max-min)/first,
    net_pct:100*net,
    path_pct:100*pathLen,
    efficiency:pathLen?Math.abs(net)/pathLen:0,
    mean_abs15_pct:100*mean(abs),
    median_abs15_pct:100*median(abs),
    p80_abs15_pct:100*pct(abs,.80),
    p90_abs15_pct:100*pct(abs,.90),
    p95_abs15_pct:100*pct(abs,.95),
    p99_abs15_pct:100*pct(abs,.99),
    max_abs15_pct:100*Math.max(...abs),
    ...st
  };
}
function sliceWindow(rows,endMs,hours){ const start=endMs-hours*3600e3; return rows.filter(r=>r.t>start&&r.t<=endMs); }
function futureStats(rows,endMs,hours){ const end=endMs+hours*3600e3; const w=rows.filter(r=>r.t>endMs&&r.t<=end); if(w.length<2) return null; return features(w); }

const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const now=Date.now();
const rows=raw.map(m=>({t:Date.parse(m.open_time||m.close_time||m.settlement_ts),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase(),ticker:m.ticker}))
  .filter(r=>Number.isFinite(r.t)&&r.t<=now&&Number.isFinite(r.floor)&&r.floor>0)
  .sort((a,b)=>a.t-b.t);
if(rows.length<100) throw new Error('insufficient market rows');
const endMs=rows[rows.length-1].t;
const horizons=[6,12,24,48,72,120,168,336,672];
const fields=['range_pct','net_pct','path_pct','efficiency','mean_abs15_pct','p95_abs15_pct','max_abs15_pct','max_streak'];
const horizonResults=[];

for(const h of horizons){
  const cur=features(sliceWindow(rows,endMs,h));
  const hist=[];
  const step=4; // hourly endpoints at 15m cadence
  for(let i=0;i<rows.length;i+=step){
    const e=rows[i].t;
    if(e>=endMs-h*3600e3) continue;
    const w=sliceWindow(rows,e,h); if(w.length<Math.max(8,Math.floor(h*4*.8))) continue;
    const f=features(w); if(f) hist.push({end:e,f});
  }
  const percentiles={}; for(const k of fields) percentiles[k]=rank(cur[k],hist.map(x=>x.f[k]));
  const anomaly=mean(fields.map(k=>Math.abs(percentiles[k]-50)/50));
  horizonResults.push({hours:h,current:cur,percentiles,anomaly_score:anomaly,historical_windows:hist.length});
}

const mostUnusual=[...horizonResults].sort((a,b)=>b.anomaly_score-a.anomaly_score)[0];
const H=mostUnusual.hours;
const histCandidates=[];
for(let i=0;i<rows.length;i+=4){
  const e=rows[i].t;
  if(e>=endMs-H*3600e3-48*3600e3) continue;
  const w=sliceWindow(rows,e,H); if(w.length<Math.max(8,Math.floor(H*4*.8))) continue;
  const f=features(w); if(f) histCandidates.push({end:e,f});
}
const compareFields=['range_pct','path_pct','efficiency','mean_abs15_pct','p95_abs15_pct','max_abs15_pct','max_streak'];
const scales={};
for(const k of compareFields){ const vals=histCandidates.map(x=>x.f[k]); const mu=mean(vals); const sd=Math.sqrt(mean(vals.map(v=>(v-mu)**2)))||1; scales[k]={mu,sd}; }
const cf=mostUnusual.current;
for(const c of histCandidates){ c.distance=Math.sqrt(mean(compareFields.map(k=>((c.f[k]-cf[k])/scales[k].sd)**2))); }
const analogs=histCandidates.sort((a,b)=>a.distance-b.distance).slice(0,5).map(c=>({
  window_end:iso(c.end),distance:c.distance,features:c.f,
  next24:futureStats(rows,c.end,24),next48:futureStats(rows,c.end,48)
}));

const report={generated_at:new Date().toISOString(),data_start:iso(rows[0].t),data_end:iso(endMs),market_rows:rows.length,horizons:horizonResults,most_unusual_horizon_hours:H,analogs};
fs.writeFileSync(OUT,JSON.stringify(report,null,2));
console.error(`REGIME_SUMMARY ${JSON.stringify({data_start:report.data_start,data_end:report.data_end,market_rows:rows.length,most_unusual_horizon_hours:H})}`);
for(const x of horizonResults) console.error(`REGIME_HORIZON ${JSON.stringify(x)}`);
for(const a of analogs) console.error(`REGIME_ANALOG ${JSON.stringify(a)}`);
