#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const RAW=path.resolve('./kalshi-100day-research/raw/eth15m-markets-merged.json');
const Q=15*60_000, DAY=86400000, STAKE=10000, FEE=350;
const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const rows=raw.map(m=>({ticker:m.ticker,t:Date.parse(m.open_time),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase()})).filter(r=>/^KXETH15M-/.test(String(r.ticker))&&Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>500&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const end=rows.at(-1).t,start=end-100*DAY,cut=start+70*DAY,byT=new Map(rows.map((r,i)=>[r.t,r]));
const opp=s=>s==='yes'?'no':'yes', pct=(a,b)=>(b-a)/a;
function h(cur,k){return byT.get(cur.t-k*Q)||null}
function trail(cur,n){const a=[];for(let k=n;k>=1;k--){const x=h(cur,k);if(!x)return null;a.push(x)}return a}
function stat(fs){let p=0;for(let i=1;i<fs.length;i++)p+=Math.abs(pct(fs[i-1],fs[i]));const net=pct(fs[0],fs.at(-1));return{eff:p?Math.abs(net)/p:0,path:p,net}}
function rev(a){let n=0;for(let i=1;i<a.length;i++)if(a[i].result!==a[i-1].result)n++;return n/(a.length-1)}
function hour(t){return Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hour12:false}).format(new Date(t)))%24}
function month(t){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit'}).format(new Date(t))}
const ts=[];
for(const r of rows){if(r.t<start)continue;const a=h(r,1),b=h(r,2),c=h(r,3);if(!a||!b||!c||a.result!==b.result||c.result===a.result)continue;const p8=trail(r,8),p16=trail(r,16),p24=trail(r,24);if(!p8||!p16||!p24)continue;const side=opp(a.result),m1=Math.abs(pct(a.floor,r.floor));ts.push({t:r.t,win:r.result===side,side,pair:a.result,hour:hour(r.t),month:month(r.t),abs:m1,eff1:stat([...trail(r,4).map(x=>x.floor),r.floor]).eff,eff2:stat([...p8.map(x=>x.floor),r.floor]).eff,eff4:stat([...p16.map(x=>x.floor),r.floor]).eff,eff6:stat([...p24.map(x=>x.floor),r.floor]).eff,rev8:rev(p8),rev16:rev(p16),pattern:trail(r,4).map(x=>x.result[0].toUpperCase()).join('')});}
function sum(a){let pnl=0,pk=0,dd=0,w=0,l=0,lr=0,ml=0;for(const x of a){const q=x.win?STAKE-FEE:-STAKE-FEE;pnl+=q;pk=Math.max(pk,pnl);dd=Math.max(dd,pk-pnl);if(x.win){w++;lr=0}else{l++;lr++;ml=Math.max(ml,lr)}}return{trades:a.length,wins:w,losses:l,win_rate:a.length?w/a.length:null,pnl:pnl/100,roi:a.length?pnl/(a.length*STAKE):null,dd:dd/100,maxL:ml}}
function report(a){return{all:sum(a),train:sum(a.filter(x=>x.t<cut)),holdout:sum(a.filter(x=>x.t>=cut))}}
const rules=[];const add=(name,f)=>rules.push({name,...report(ts.filter(f))});
add('4-7 ET',x=>x.hour>=4&&x.hour<8);
add('12-15 ET',x=>x.hour>=12&&x.hour<16);
add('4-7 OR 12-15 ET',x=>(x.hour>=4&&x.hour<8)||(x.hour>=12&&x.hour<16));
add('exclude 8-11,16-23 ET',x=>x.hour<8||(x.hour>=12&&x.hour<16));
add('4-7 + abs>=0.20%',x=>x.hour>=4&&x.hour<8&&x.abs>=.002);
add('4-7 + abs>=0.35%',x=>x.hour>=4&&x.hour<8&&x.abs>=.0035);
add('4-7 + abs 0.20-0.60%',x=>x.hour>=4&&x.hour<8&&x.abs>=.002&&x.abs<.006);
add('4-7 + eff1>=.75',x=>x.hour>=4&&x.hour<8&&x.eff1>=.75);
add('4-7 + eff6<.10',x=>x.hour>=4&&x.hour<8&&x.eff6<.10);
add('4-7 + rev16=.60',x=>x.hour>=4&&x.hour<8&&Math.abs(x.rev16-.6)<1e-9);
add('4-7 + rev8>=.714',x=>x.hour>=4&&x.hour<8&&x.rev8>=5/7);
add('4-7 + NYNN',x=>x.hour>=4&&x.hour<8&&x.pattern==='NYNN');
add('12-15 + abs>=0.20%',x=>x.hour>=12&&x.hour<16&&x.abs>=.002);
add('12-15 + eff1>=.75',x=>x.hour>=12&&x.hour<16&&x.eff1>=.75);
add('eff1>=.75 all hours',x=>x.eff1>=.75);
add('eff1>=.75 excluding 16-23',x=>x.eff1>=.75&&x.hour<16);
add('abs>=.35% all hours',x=>x.abs>=.0035);
add('abs>=.35% excluding 16-23',x=>x.abs>=.0035&&x.hour<16);
add('rev16=.60 all hours',x=>Math.abs(x.rev16-.6)<1e-9);
add('eff6<.10 all hours',x=>x.eff6<.10);
const monthly={};for(const R of rules){monthly[R.name]=[...new Set(ts.map(x=>x.month))].map(m=>({month:m,...sum(ts.filter(x=>x.month===m).filter(x=>{switch(R.name){case'4-7 ET':return x.hour>=4&&x.hour<8;case'12-15 ET':return x.hour>=12&&x.hour<16;case'4-7 OR 12-15 ET':return(x.hour>=4&&x.hour<8)||(x.hour>=12&&x.hour<16);case'eff1>=.75 all hours':return x.eff1>=.75;default:return false}}))})).filter(x=>x.trades>0)}
const stable=rules.filter(r=>r.train.trades>=30&&r.holdout.trades>=15&&r.train.pnl>0&&r.holdout.pnl>0).sort((a,b)=>(b.holdout.roi??-9)-(a.holdout.roi??-9));
console.error(`G_COMBO_STABLE ${JSON.stringify(stable)}`);console.error(`G_COMBO_MONTHLY ${JSON.stringify(monthly)}`);
fs.writeFileSync('./kalshi-100day-research/g-combo-study.json',JSON.stringify({generated_at:new Date().toISOString(),rules,stable,monthly},null,2));