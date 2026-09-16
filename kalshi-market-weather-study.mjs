#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// MARKET-ONLY research. No Shawshank service/order/fill/P&L inputs.
const ROOT=path.resolve('./kalshi-100day-research');
const RAW=path.join(ROOT,'raw','eth15m-markets-merged.json');
const OUT=path.join(ROOT,'market-weather-study.json');
const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const rows=raw.map(m=>({t:Date.parse(m.open_time||m.close_time||m.settlement_ts),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase(),ticker:m.ticker})).filter(r=>Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>0&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))||1};
const pct=(a,p)=>{const b=[...a].sort((x,y)=>x-y);if(!b.length)return 0;const x=(b.length-1)*p,l=Math.floor(x),h=Math.ceil(x);return l===h?b[l]:b[l]+(b[h]-b[l])*(x-l)};
const etDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
function feat(a){if(a.length<20)return null;let rets=[],switches=0,cur=0,maxStreak=0,prev=null;for(let i=0;i<a.length;i++){if(i&&a[i].t-a[i-1].t>=10*60e3&&a[i].t-a[i-1].t<=20*60e3)rets.push((a[i].floor-a[i-1].floor)/a[i-1].floor);if(prev&&a[i].result!==prev)switches++;cur=a[i].result===prev?cur+1:1;maxStreak=Math.max(maxStreak,cur);prev=a[i].result}if(!rets.length)return null;const abs=rets.map(Math.abs),first=a[0].floor,last=a.at(-1).floor,net=(last-first)/first,path=abs.reduce((s,x)=>s+x,0),hi=Math.max(...a.map(x=>x.floor)),lo=Math.min(...a.map(x=>x.floor));let accel=0;for(let i=1;i<abs.length;i++)if(abs[i]>abs[i-1])accel++;return {n:a.length,range:100*(hi-lo)/first,net:100*net,path:100*path,meanAbs15:100*mean(abs),p95Abs15:100*pct(abs,.95),maxAbs15:100*Math.max(...abs),efficiency:path?Math.abs(net)/path:0,switchRate:switches/Math.max(1,a.length-1),maxStreak,accelerationRate:accel/Math.max(1,abs.length-1)} }
const groups=new Map();for(const r of rows){const d=etDay(r.t);if(!groups.has(d))groups.set(d,[]);groups.get(d).push(r)}
const days=[...groups].map(([date,a])=>({date,features:feat(a)})).filter(x=>x.features&&x.features.n>=80);
const keys=['range','path','meanAbs15','p95Abs15','efficiency','switchRate','maxStreak','accelerationRate'];const scales={};for(const k of keys){const v=days.map(d=>d.features[k]);scales[k]={m:mean(v),s:sd(v)}}
function dist(a,b){return Math.sqrt(mean(keys.map(k=>((a[k]-b[k])/scales[k].s)**2)))}
for(const d of days){d.neighbors=days.filter(x=>x!==d).map(x=>({date:x.date,distance:dist(d.features,x.features)})).sort((a,b)=>a.distance-b.distance).slice(0,5)}
const vals=k=>days.map(d=>d.features[k]);const q={};for(const k of keys)q[k]={p25:pct(vals(k),.25),p50:pct(vals(k),.5),p75:pct(vals(k),.75),p90:pct(vals(k),.9)};
function label(f){const intensity=f.meanAbs15>=q.meanAbs15.p90?'Severe':f.meanAbs15>=q.meanAbs15.p75?'Rough':f.meanAbs15>=q.meanAbs15.p25?'Active':'Calm';const structure=f.maxStreak>=q.maxStreak.p75&&f.switchRate<=q.switchRate.p25?'Persistent':f.switchRate>=q.switchRate.p75?'Choppy':'Mixed';const direction=Math.abs(f.net)>=q.range.p50*.5?(f.net>0?'Up':'Down'):'Neutral';return {intensity,structure,direction}}
for(const d of days)d.weather=label(d.features);
const families={};for(const d of days){const k=`${d.weather.intensity} + ${d.weather.structure}`;(families[k]??=[]).push(d.date)}
const report={generated_at:new Date().toISOString(),independence:'ETH/Kalshi market outcomes and floor strikes only; no trading-service signals, orders, fills, wagers, or P&L.',market_rows:rows.length,complete_et_days:days.length,feature_keys:keys,thresholds:q,families:Object.fromEntries(Object.entries(families).map(([k,v])=>[k,{days:v.length,dates:v}])),days};fs.writeFileSync(OUT,JSON.stringify(report,null,2));
console.error(`MARKET_WEATHER_SUMMARY ${JSON.stringify({market_rows:rows.length,complete_et_days:days.length,families:Object.fromEntries(Object.entries(families).map(([k,v])=>[k,v.length]))})}`);
for(const d of days.slice(-10))console.error(`MARKET_WEATHER_DAY ${JSON.stringify({date:d.date,weather:d.weather,features:d.features,neighbors:d.neighbors})}`);
