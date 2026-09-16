#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const RAW=path.resolve('./kalshi-100day-research/raw/eth15m-markets-merged.json');
const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const QTR=15*60_000;
const rows=raw.map(m=>({ticker:m.ticker,t:Date.parse(m.open_time),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase()}))
.filter(r=>/^KXETH15M-/.test(String(r.ticker))&&Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>500&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const byT=new Map(rows.map((r,i)=>[r.t,{r,i}]));
function opp(s){return s==='yes'?'no':'yes'}
function trigger(i){if(i<3)return null; const cur=rows[i],one=byT.get(cur.t-QTR)?.r,two=byT.get(cur.t-2*QTR)?.r,three=byT.get(cur.t-3*QTR)?.r;if(!one||!two||!three||one.result!==two.result||three.result===one.result)return null;return opp(one.result)}
function etParts(t){const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false,weekday:'short',year:'numeric',month:'2-digit'}).formatToParts(new Date(t));const g=x=>p.find(q=>q.type===x)?.value;return {h:Number(g('hour'))%24,d:g('weekday'),ym:`${g('year')}-${g('month')}`}}
const sig=[]; for(let i=0;i<rows.length;i++){const side=trigger(i);if(!side)continue;const e=etParts(rows[i].t);sig.push({...rows[i],side,win:rows[i].result===side,...e})}
const rules={
 goodHoursNoSunThu:x=>((x.h>=4&&x.h<=7)||(x.h>=12&&x.h<=15))&&!['Sun','Thu'].includes(x.d),
 fourToSevenNoSunThu:x=>(x.h>=4&&x.h<=7)&&!['Sun','Thu'].includes(x.d)
};
function feeForStake(stake){const contracts=stake*2; return Math.ceil(0.07*contracts*50*50/10000)/100;}
function summarize(seq, mode){let pnl=0,peak=0,dd=0,wager=0,w=0,l=0,maxLossRun=0,lossRun=0,step=0; const monthly={}; for(const x of seq){let stake;if(mode.type==='flat')stake=mode.stake;else stake=[100,200,400][step];const fee=feeForStake(stake);const p=x.win?stake-fee:-stake-fee;pnl+=p;wager+=stake;peak=Math.max(peak,pnl);dd=Math.max(dd,peak-pnl);if(x.win){w++;lossRun=0;if(mode.type==='ladder')step=0}else{l++;lossRun++;maxLossRun=Math.max(maxLossRun,lossRun);if(mode.type==='ladder')step=step<2?step+1:0}const m=monthly[x.ym]??={trades:0,wins:0,losses:0,pnl:0,wager:0};m.trades++;if(x.win)m.wins++;else m.losses++;m.pnl+=p;m.wager+=stake;}
 return {trades:seq.length,wins:w,losses:l,win_rate:seq.length?w/seq.length:null,pnl:Number(pnl.toFixed(2)),roi:wager?pnl/wager:null,max_drawdown:Number(dd.toFixed(2)),max_losing_streak:maxLossRun,total_wagered:wager,monthly:Object.fromEntries(Object.entries(monthly).map(([k,v])=>[k,{...v,roi:v.wager?v.pnl/v.wager:null,pnl:Number(v.pnl.toFixed(2))}]))};}
const flats=[25,50,100,200,500].map(stake=>({name:`flat_${stake}`,type:'flat',stake})); const modes=[...flats,{name:'ladder_100_200_400',type:'ladder'}];
const out={generated_at:new Date().toISOString(),methodology:'Signal rules frozen from prior walk-forward study. Flat stake stress $25/$50/$100/$200/$500 versus 100-200-400 loss ladder. 50c theoretical fill, Kalshi fee formula approximation, no liquidity/slippage/capital blocking.',rules:{}};
for(const [name,fn] of Object.entries(rules)){const seq=sig.filter(fn);out.rules[name]={};for(const mode of modes)out.rules[name][mode.name]=summarize(seq,mode)}
// prospective frozen tests: May-selected goodHoursNoSunThu from Jun onward; May+Jun-selected fourToSevenNoSunThu from Jul onward
out.prospective={};
for(const [name,startMonth] of [['goodHoursNoSunThu','2026-06'],['fourToSevenNoSunThu','2026-07']]){const fn=rules[name];const seq=sig.filter(x=>fn(x)&&x.ym>=startMonth);out.prospective[name]={start_month:startMonth};for(const mode of modes)out.prospective[name][mode.name]=summarize(seq,mode)}
console.error(`G_SIZING ${JSON.stringify(out)}`);
fs.writeFileSync('./kalshi-100day-research/g-sizing-study.json',JSON.stringify(out,null,2));
