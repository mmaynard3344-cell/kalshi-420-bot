#!/usr/bin/env node
import fs from 'node:fs';
const Q=900000,DAY=86400000,STAKE=10000,FEE=350;
const raw=JSON.parse(fs.readFileSync('./kalshi-100day-research/raw/eth15m-markets-merged.json','utf8'));
const rows=raw.map(m=>({t:Date.parse(m.open_time),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase()})).filter(r=>Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>500&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const byT=new Map(rows.map((r,i)=>[r.t,{r,i}]));const end=rows.at(-1).t,start=end-100*DAY,cut=start+70*DAY;
function opp(s){return s==='yes'?'no':'yes'}
function et(t){const d=new Date(t);const f=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(d);const o={};for(const p of f)o[p.type]=p.value;return{h:+o.hour,d:o.weekday}}
function trig(i){const c=rows[i],a=byT.get(c.t-Q)?.r,b=byT.get(c.t-2*Q)?.r,z=byT.get(c.t-3*Q)?.r;if(!a||!b||!z||a.result!==b.result||z.result===a.result)return null;return opp(a.result)}
function score(a){let p=0,pk=0,dd=0,w=0,l=0,r=0,m=0;for(const x of a){const q=x.win?STAKE-FEE:-STAKE-FEE;p+=q;pk=Math.max(pk,p);dd=Math.max(dd,pk-p);if(x.win){w++;r=0}else{l++;r++;m=Math.max(m,r)}}return{trades:a.length,wins:w,losses:l,win_rate:a.length?w/a.length:null,pnl:p/100,roi:a.length?p/(a.length*STAKE):null,dd:dd/100,maxL:m}}
const T=[];for(let i=3;i<rows.length;i++){if(rows[i].t<start)continue;const s=trig(i);if(!s)continue;const x=et(rows[i].t);T.push({t:rows[i].t,win:rows[i].result===s,h:x.h,d:x.d})}
const F={
'excludeBadHours':x=>!((x.h>=8&&x.h<=11)||(x.h>=16&&x.h<=23)),
'excludeBadHours+excludeSunThu':x=>!((x.h>=8&&x.h<=11)||(x.h>=16&&x.h<=23))&&!['Sun','Thu'].includes(x.d),
'goodHours':x=>((x.h>=4&&x.h<=7)||(x.h>=12&&x.h<=15)),
'goodHours+excludeSunThu':x=>((x.h>=4&&x.h<=7)||(x.h>=12&&x.h<=15))&&!['Sun','Thu'].includes(x.d),
'4-7':x=>x.h>=4&&x.h<=7,
'4-7+excludeSunThu':x=>x.h>=4&&x.h<=7&&!['Sun','Thu'].includes(x.d)
};
function weekly(a){const m=new Map();for(const x of a){const dt=new Date(x.t);const key=`${dt.getUTCFullYear()}-${String(Math.floor((x.t-Date.UTC(dt.getUTCFullYear(),0,1))/604800000)+1).padStart(2,'0')}`;(m.get(key)||m.set(key,[]).get(key)).push(x)}return [...m.entries()].map(([week,v])=>({week,...score(v)}))}
for(const [name,f] of Object.entries(F)){const a=T.filter(f),tr=a.filter(x=>x.t<cut),ho=a.filter(x=>x.t>=cut),wk=weekly(a);const pos=wk.filter(x=>x.pnl>0).length,neg=wk.filter(x=>x.pnl<0).length;console.error('G_WEEKDAY '+JSON.stringify({name,all:score(a),train:score(tr),holdout:score(ho),weeks:{positive:pos,negative:neg,total:wk.length,worst:[...wk].sort((a,b)=>a.pnl-b.pnl).slice(0,3),best:[...wk].sort((a,b)=>b.pnl-a.pnl).slice(0,3)}}));}
