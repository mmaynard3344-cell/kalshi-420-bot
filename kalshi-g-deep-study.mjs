#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const RAW=path.resolve('./kalshi-100day-research/raw/eth15m-markets-merged.json');
const OUT=path.resolve('./kalshi-100day-research/g-deep-study.json');
const Q=15*60_000, H=60*60_000, DAY=86_400_000;
const STAKE=10000, FEE=350;

const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const rows=raw.map(m=>({ticker:m.ticker,t:Date.parse(m.open_time),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase()}))
 .filter(r=>/^KXETH15M-/.test(String(r.ticker))&&Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>500&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const end=rows.at(-1).t, start=end-100*DAY, cut=start+70*DAY;
const byT=new Map(rows.map((r,i)=>[r.t,{r,i}]));
function opp(s){return s==='yes'?'no':'yes'}
function pct(a,b){return (b-a)/a}
function hist(cur,k){return byT.get(cur.t-k*Q)?.r||null}
function exactTwo(i){const cur=rows[i],a=hist(cur,1),b=hist(cur,2),c=hist(cur,3); if(!a||!b||!c||a.result!==b.result||c.result===a.result)return null; return {side:opp(a.result), pair:a.result, p1:a,p2:b,p3:c};}
function trailing(i,n){const cur=rows[i], out=[]; for(let k=n;k>=1;k--){const r=hist(cur,k); if(!r)return null; out.push(r);} return out;}
function reversalRate(rs){let n=0;for(let j=1;j<rs.length;j++)if(rs[j].result!==rs[j-1].result)n++;return rs.length>1?n/(rs.length-1):0}
function pathStats(floors){let path=0; const moves=[]; for(let j=1;j<floors.length;j++){const m=pct(floors[j-1],floors[j]);moves.push(m);path+=Math.abs(m);} const net=pct(floors[0],floors.at(-1)); return {net,path,eff:path?Math.abs(net)/path:0,moves};}
function etHour(t){return Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hour12:false}).format(new Date(t)))%24}
function feePnl(win){return win?STAKE-FEE:-STAKE-FEE}
function summarize(ts){let p=0,peak=0,dd=0,w=0,l=0,run=0,maxL=0;for(const x of ts){const q=feePnl(x.win);p+=q;peak=Math.max(peak,p);dd=Math.max(dd,peak-p);if(x.win){w++;run=0}else{l++;run++;maxL=Math.max(maxL,run)}}return {trades:ts.length,wins:w,losses:l,win_rate:ts.length?w/ts.length:null,net_pnl_dollars:p/100,roi:ts.length?p/(ts.length*STAKE):null,max_drawdown_dollars:dd/100,longest_losing_streak:maxL};}
function split(ts){return {all:summarize(ts),train:summarize(ts.filter(x=>x.t<cut)),holdout:summarize(ts.filter(x=>x.t>=cut))}}

const trades=[];
for(let i=0;i<rows.length;i++){
 const r=rows[i]; if(r.t<start)continue; const tr=exactTwo(i); if(!tr)continue;
 const p4=trailing(i,4), p8=trailing(i,8), p16=trailing(i,16), p24=trailing(i,24); if(!p4||!p8||!p16||!p24)continue;
 const s4=pathStats([...p4.map(x=>x.floor),r.floor]);
 const s8=pathStats([...p8.map(x=>x.floor),r.floor]);
 const s16=pathStats([...p16.map(x=>x.floor),r.floor]);
 const s24=pathStats([...p24.map(x=>x.floor),r.floor]);
 const m1=pct(tr.p1.floor,r.floor); // latest completed floor -> current floor
 const m2=pct(tr.p2.floor,tr.p1.floor);
 const m3=pct(tr.p3.floor,tr.p2.floor);
 const pairDir=tr.pair==='yes'?1:-1;
 const currentMoveWithPair=Math.sign(m1)===pairDir;
 const priorMoveWithPair=Math.sign(m2)===pairDir;
 const twoMoveNet=pct(tr.p2.floor,r.floor);
 const accel=Math.abs(m1)-Math.abs(m2);
 const hour=etHour(r.t);
 trades.push({t:r.t,ticker:r.ticker,side:tr.side,pair:tr.pair,result:r.result,win:r.result===tr.side,hour,
   pattern4:p4.map(x=>x.result[0].toUpperCase()).join(''),rev4:reversalRate(p4),rev8:reversalRate(p8),rev16:reversalRate(p16),rev24:reversalRate(p24),
   eff1h:s4.eff,eff2h:s8.eff,eff4h:s16.eff,eff6h:s24.eff,path1h:s4.path,path2h:s8.path,path4h:s16.path,path6h:s24.path,net1h:s4.net,net2h:s8.net,net4h:s16.net,net6h:s24.net,
   m1,m2,m3,absM1:Math.abs(m1),absM2:Math.abs(m2),twoMoveNet,currentMoveWithPair,priorMoveWithPair,accel});
}

function bucket(name,keyFn){const m=new Map();for(const x of trades){const k=keyFn(x);if(k==null)continue;if(!m.has(k))m.set(k,[]);m.get(k).push(x)}return {name,rows:[...m.entries()].map(([k,v])=>({bucket:String(k),...split(v)})).sort((a,b)=>b.all.trades-a.all.trades)};}
function band(v,cuts,labels){for(let i=0;i<cuts.length;i++)if(v<cuts[i])return labels[i];return labels.at(-1)}
const buckets=[
 bucket('pattern4',x=>x.pattern4),
 bucket('pair_side',x=>x.pair),
 bucket('hour_block_et',x=>`${Math.floor(x.hour/4)*4}-${Math.floor(x.hour/4)*4+3}`),
 bucket('current_floor_move_vs_pair',x=>x.currentMoveWithPair?'with_pair':'against_pair'),
 bucket('prior_floor_move_vs_pair',x=>x.priorMoveWithPair?'with_pair':'against_pair'),
 bucket('latest_move_abs',x=>band(x.absM1,[.001,.002,.0035,.006],['<0.10%','0.10-0.20%','0.20-0.35%','0.35-0.60%','>=0.60%'])),
 bucket('one_hour_efficiency',x=>band(x.eff1h,[.15,.30,.45,.60,.75],['<.15','.15-.30','.30-.45','.45-.60','.60-.75','>=.75'])),
 bucket('two_hour_efficiency',x=>band(x.eff2h,[.15,.30,.45,.60,.75],['<.15','.15-.30','.30-.45','.45-.60','.60-.75','>=.75'])),
 bucket('four_hour_efficiency',x=>band(x.eff4h,[.10,.20,.30,.45,.60],['<.10','.10-.20','.20-.30','.30-.45','.45-.60','>=.60'])),
 bucket('six_hour_efficiency',x=>band(x.eff6h,[.10,.20,.30,.45,.60],['<.10','.10-.20','.20-.30','.30-.45','.45-.60','>=.60'])),
 bucket('rev8',x=>x.rev8.toFixed(3)),bucket('rev16',x=>x.rev16.toFixed(3)),
 bucket('two_move_net_direction',x=>Math.sign(x.twoMoveNet)===(x.pair==='yes'?1:-1)?'with_pair':'against_pair'),
 bucket('latest_vs_previous_move',x=>x.accel>0?'accelerating':'decelerating')
];

// Predefined simple rules, intentionally limited to avoid mining thousands of combinations.
const rules=[]; function rule(name,fn){const v=trades.filter(fn);rules.push({name,...split(v)});} 
rule('ALL exact-two triggers',()=>true);
rule('1h eff < .15',x=>x.eff1h<.15);
rule('1h eff .15-.30',x=>x.eff1h>=.15&&x.eff1h<.30);
rule('1h eff .30-.45',x=>x.eff1h>=.30&&x.eff1h<.45);
rule('2h eff < .20',x=>x.eff2h<.20);
rule('2h eff .20-.40',x=>x.eff2h>=.20&&x.eff2h<.40);
rule('4h eff < .20',x=>x.eff4h<.20);
rule('4h eff .20-.40',x=>x.eff4h>=.20&&x.eff4h<.40);
rule('current floor move against pair',x=>!x.currentMoveWithPair);
rule('current floor move with pair',x=>x.currentMoveWithPair);
rule('pair move decelerating',x=>x.accel<=0);
rule('pair move accelerating',x=>x.accel>0);
rule('against pair + 1h eff < .30',x=>!x.currentMoveWithPair&&x.eff1h<.30);
rule('against pair + 2h eff < .30',x=>!x.currentMoveWithPair&&x.eff2h<.30);
rule('against pair + decelerating',x=>!x.currentMoveWithPair&&x.accel<=0);
rule('with pair + decelerating',x=>x.currentMoveWithPair&&x.accel<=0);
rule('latest abs move < .20%',x=>x.absM1<.002);
rule('latest abs move .20-.50%',x=>x.absM1>=.002&&x.absM1<.005);
rule('rev8 >= .57',x=>x.rev8>=4/7);
rule('rev8 < .43',x=>x.rev8<3/7);
rule('rev8 >= .57 + 2h eff < .30',x=>x.rev8>=4/7&&x.eff2h<.30);
rule('pattern YNYY',x=>x.pattern4==='YNYY');
rule('pattern NYNN',x=>x.pattern4==='NYNN');
rule('pattern NNY Y?'.replace(' ',''),x=>x.pattern4==='NNYY');
rule('pattern YYNN',x=>x.pattern4==='YYNN');
for(const lo of [0,4,8,12,16,20]) rule(`hour ${lo}-${lo+3} ET`,x=>x.hour>=lo&&x.hour<lo+4);

const robust=rules.filter(r=>r.train.trades>=50&&r.holdout.trades>=20&&r.train.net_pnl_dollars>0&&r.holdout.net_pnl_dollars>0)
 .sort((a,b)=>(b.holdout.roi??-99)-(a.holdout.roi??-99));
const report={generated_at:new Date().toISOString(),window:{start:new Date(start).toISOString(),cut:new Date(cut).toISOString(),end:new Date(end).toISOString()},methodology:'Research-only exact-two G trigger study. Features use only information available at the current market open: prior settled outcomes/floors plus current market floor. Flat $100 theoretical fill at 50c and $3.50 modeled fee. Holdout is final 30 days.',baseline:split(trades),buckets,rules,robust_rules:robust};
fs.writeFileSync(OUT,JSON.stringify(report,null,2));
console.error(`G_DEEP_BASELINE ${JSON.stringify(report.baseline)}`);
console.error(`G_DEEP_ROBUST ${JSON.stringify(robust)}`);
for(const b of buckets) console.error(`G_DEEP_BUCKET ${b.name} ${JSON.stringify(b.rows)}`);
