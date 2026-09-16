#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const RAW=path.resolve('./kalshi-100day-research/raw/eth15m-markets-merged.json');
const Q=15*60_000, DAY=86400000, STAKE=10000, FEE=350;
const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const rows=raw.map(m=>({ticker:m.ticker,t:Date.parse(m.open_time),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase()})).filter(r=>/^KXETH15M-/.test(String(r.ticker))&&Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>500&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const byT=new Map(rows.map((r,i)=>[r.t,{r,i}])); const end=rows.at(-1).t, start=end-100*DAY;
function opp(s){return s==='yes'?'no':'yes'}
function etParts(t){const d=new Date(t); const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23',weekday:'short',month:'2-digit'}).formatToParts(d); const o={}; for(const p of fmt)o[p.type]=p.value; return {hour:+o.hour,dow:o.weekday,month:o.month};}
function trigger(i){const c=rows[i],a=byT.get(c.t-Q)?.r,b=byT.get(c.t-2*Q)?.r,z=byT.get(c.t-3*Q)?.r;if(!a||!b||!z||a.result!==b.result||z.result===a.result)return null;return opp(a.result)}
function absMove(i){const a=rows[i-1],b=rows[i-2]; if(!a||!b||a.t-b.t!==Q)return null; return Math.abs((a.floor-b.floor)/b.floor);}
function score(arr){let p=0,pk=0,dd=0,w=0,l=0,run=0,maxL=0;for(const x of arr){const q=x.win?STAKE-FEE:-STAKE-FEE;p+=q;pk=Math.max(pk,p);dd=Math.max(dd,pk-p);if(x.win){w++;run=0}else{l++;run++;maxL=Math.max(maxL,run)}}return{trades:arr.length,wins:w,losses:l,win_rate:arr.length?w/arr.length:null,pnl:p/100,roi:arr.length?p/(arr.length*STAKE):null,dd:dd/100,maxL}}
const trades=[];for(let i=3;i<rows.length;i++){const r=rows[i];if(r.t<start)continue;const s=trigger(i);if(!s)continue;const e=etParts(r.t);trades.push({t:r.t,win:r.result===s,hour:e.hour,dow:e.dow,month:e.month,move:absMove(i)});} const cut=start+70*DAY;
const filters={goodHours:x=>((x.hour>=4&&x.hour<=7)||(x.hour>=12&&x.hour<=15)),excludeBad:x=>!((x.hour>=8&&x.hour<=11)||(x.hour>=16&&x.hour<=23)),move35:x=>x.move!=null&&x.move>=0.0035,goodHoursMove20:x=>((x.hour>=4&&x.hour<=7)||(x.hour>=12&&x.hour<=15))&&x.move!=null&&x.move>=0.002};
function pack(name,f){const a=trades.filter(f); const train=a.filter(x=>x.t<cut), hold=a.filter(x=>x.t>=cut); const byDow={}; for(const d of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])byDow[d]=score(a.filter(x=>x.dow===d)); const byMonth={}; for(const m of [...new Set(a.map(x=>x.month))])byMonth[m]=score(a.filter(x=>x.month===m)); const months=[...new Set(a.map(x=>x.month))]; let worstEx=null; for(const m of months){const s=score(a.filter(x=>x.month!==m)); if(!worstEx||s.roi<worstEx.score.roi)worstEx={excluded:m,score:s};} return {name,all:score(a),train:score(train),holdout:score(hold),byDow,byMonth,worstLeaveOneMonthOut:worstEx};}
const out=Object.entries(filters).map(([n,f])=>pack(n,f)); console.error('G_STABILITY '+JSON.stringify(out));
