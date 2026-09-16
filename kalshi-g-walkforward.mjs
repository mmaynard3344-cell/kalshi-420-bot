#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const RAW=path.resolve('./kalshi-100day-research/raw/eth15m-markets-merged.json');
const Q=15*60_000, STAKE=10000, FEE=350;
const rows=JSON.parse(fs.readFileSync(RAW,'utf8')).map(m=>({t:Date.parse(m.open_time),floor:+m.floor_strike,result:String(m.result||'').toLowerCase(),ticker:m.ticker}))
.filter(r=>/^KXETH15M-/.test(String(r.ticker))&&Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>500&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const byT=new Map(rows.map((r,i)=>[r.t,{r,i}]));
function opp(s){return s==='yes'?'no':'yes'}
function etParts(t){const d=new Date(t); const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hour12:false,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d); const o=Object.fromEntries(parts.map(x=>[x.type,x.value])); return {hour:(+o.hour)%24,dow:o.weekday,month:`${o.year}-${o.month}`};}
function trigger(i){if(i<3)return null; const c=rows[i],a=byT.get(c.t-Q)?.r,b=byT.get(c.t-2*Q)?.r,d=byT.get(c.t-3*Q)?.r; if(!a||!b||!d||a.result!==b.result||d.result===a.result)return null; return opp(a.result);}
const trades=[]; for(let i=0;i<rows.length;i++){const side=trigger(i); if(!side)continue; const p=etParts(rows[i].t); trades.push({...rows[i],...p,side,win:rows[i].result===side});}
function score(a){let pnl=0,peak=0,dd=0,w=0,l=0; for(const x of a){const p=x.win?STAKE-FEE:-STAKE-FEE;pnl+=p;peak=Math.max(peak,pnl);dd=Math.max(dd,peak-pnl);x.win?w++:l++;} return {trades:a.length,wins:w,losses:l,win_rate:a.length?w/a.length:null,pnl:pnl/100,roi:a.length?pnl/(a.length*STAKE):null,dd:dd/100};}
const candidates={
 all:x=>true,
 excludeBadHours:x=>!((x.hour>=8&&x.hour<=11)||(x.hour>=16&&x.hour<=23)),
 goodHours:x=>(x.hour>=4&&x.hour<=7)||(x.hour>=12&&x.hour<=15),
 goodHoursNoSunThu:x=>((x.hour>=4&&x.hour<=7)||(x.hour>=12&&x.hour<=15))&&!['Sun','Thu'].includes(x.dow),
 excludeBadHoursNoSunThu:x=>!((x.hour>=8&&x.hour<=11)||(x.hour>=16&&x.hour<=23))&&!['Sun','Thu'].includes(x.dow),
 fourToSeven:x=>x.hour>=4&&x.hour<=7,
 fourToSevenNoSunThu:x=>x.hour>=4&&x.hour<=7&&!['Sun','Thu'].includes(x.dow),
};
const months=[...new Set(trades.map(x=>x.month))].sort();
// Need at least one prior complete month. For each target month, choose the candidate with highest prior ROI among candidates with >=100 prior trades.
const steps=[]; for(let mi=1;mi<months.length;mi++){const target=months[mi]; const priorMonths=months.slice(0,mi); const prior=trades.filter(x=>priorMonths.includes(x.month)); const test=trades.filter(x=>x.month===target); const ranked=Object.entries(candidates).map(([name,fn])=>({name,score:score(prior.filter(fn))})).filter(x=>x.score.trades>=100).sort((a,b)=>(b.score.roi??-9)-(a.score.roi??-9)); const chosen=ranked[0]; const testScore=chosen?score(test.filter(candidates[chosen.name])):null; steps.push({target,training_months:priorMonths,chosen,top3:ranked.slice(0,3),test:testScore});}
// Frozen-rule diagnostics: rules chosen from June only and June+July, then applied prospectively to later months.
const freeze=[]; for(const cutoffIdx of [0,1]){if(cutoffIdx>=months.length-1)continue; const trainMonths=months.slice(0,cutoffIdx+1); const future=months.slice(cutoffIdx+1); const train=trades.filter(x=>trainMonths.includes(x.month)); const ranked=Object.entries(candidates).map(([name,fn])=>({name,score:score(train.filter(fn))})).filter(x=>x.score.trades>=100).sort((a,b)=>(b.score.roi??-9)-(a.score.roi??-9)); const chosen=ranked[0]; freeze.push({train_months:trainMonths,chosen,future:future.map(m=>({month:m,score:score(trades.filter(x=>x.month===m&&candidates[chosen.name](x)))})),future_combined:score(trades.filter(x=>future.includes(x.month)&&candidates[chosen.name](x)))});}
const report={generated_at:new Date().toISOString(),months,methodology:'Walk-forward candidate selection uses only prior calendar months. Candidate must have >=100 prior trades; highest prior ROI selected. Flat $100 theoretical 50c fill, $3.50 fee. No liquidity/slippage.',steps,freeze};
console.error(`G_WALKFORWARD ${JSON.stringify(report)}`);
