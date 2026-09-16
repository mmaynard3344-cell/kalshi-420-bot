#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const R=path.resolve('./kalshi-100day-research');
const replay=JSON.parse(fs.readFileSync(path.join(R,'portfolio-replay-100d.json'),'utf8'));
const weather=JSON.parse(fs.readFileSync(path.join(R,'market-weather-study.json'),'utf8'));
const OUT=path.join(R,'weather-bot-performance.json');
const wm=new Map(weather.days.map(d=>[d.date,d]));
const svcs=[...new Set(replay.trades.map(t=>t.service))];
function summarize(xs){const n=xs.length,w=xs.filter(x=>x.result===x.side).length,p=xs.reduce((s,x)=>s+(x.pnl_cents||0),0);return{trades:n,wins:w,losses:n-w,winRate:n?w/n:null,pnlDollars:p/100,avgPnl:n?p/100/n:null};}
const result={generated_at:new Date().toISOString(),methodology:'Overlay theoretical 100-day replay trades onto independently computed full-ET-day ETH market-weather labels. Descriptive association only; full-day labels include information after early-day trades and therefore are not a live gate or causal/predictive test.',services:{}};
for(const s of svcs){const ts=replay.trades.filter(t=>t.service===s&&wm.has(t.date));const groups={};for(const t of ts){const w=wm.get(t.date),k=`${w.weather.intensity} + ${w.weather.structure}`;(groups[k]??=[]).push(t);}const families=Object.fromEntries(Object.entries(groups).map(([k,x])=>[k,summarize(x)]));const byIntensity={},byStructure={},byDirection={};for(const t of ts){const w=wm.get(t.date).weather;(byIntensity[w.intensity]??=[]).push(t);(byStructure[w.structure]??=[]).push(t);(byDirection[w.direction]??=[]).push(t);}result.services[s]={overall:summarize(ts),families,byIntensity:Object.fromEntries(Object.entries(byIntensity).map(([k,x])=>[k,summarize(x)])),byStructure:Object.fromEntries(Object.entries(byStructure).map(([k,x])=>[k,summarize(x)])),byDirection:Object.fromEntries(Object.entries(byDirection).map(([k,x])=>[k,summarize(x)]))};}
fs.writeFileSync(OUT,JSON.stringify(result,null,2));console.error('WEATHER_BOT_PERFORMANCE '+JSON.stringify(result));
