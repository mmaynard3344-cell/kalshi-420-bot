#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const RAW=path.resolve('./kalshi-100day-research/raw/eth15m-markets-merged.json');
const OUT=path.resolve('./kalshi-100day-research/g2-fresh-confirmation.json');
const QTR=15*60_000, DAY=86_400_000;
const STAKE=10000; // $100 flat
const FEE=350; // 200 contracts at 50c => $3.50 model fee
const OFF_EFF=.75, OFF_STREAK=3, OFF_STREAK_EFF=.55, ON_EFF=.35, ON_REV=.50;

const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
const rows=raw.map(m=>({ticker:m.ticker,t:Date.parse(m.open_time),floor:Number(m.floor_strike),result:String(m.result||'').toLowerCase()}))
.filter(r=>/^KXETH15M-/.test(String(r.ticker))&&Number.isFinite(r.t)&&Number.isFinite(r.floor)&&r.floor>500&&(r.result==='yes'||r.result==='no')).sort((a,b)=>a.t-b.t);
const end=rows.at(-1).t, start=end-100*DAY;
const byT=new Map(rows.map((r,i)=>[r.t,{r,i}]));
function opp(s){return s==='yes'?'no':'yes'}
function streakAt(i){ const side=rows[i-1]?.result; if(!side)return 0; let n=0, expected=rows[i].t-QTR; for(let j=i-1;j>=0;j--){const r=rows[j]; if(r.t!==expected||r.result!==side)break;n++;expected-=QTR;} return n; }
function metrics(i){
  if(i<4)return null; const cur=rows[i]; const prior=[]; for(let k=4;k>=1;k--){const x=byT.get(cur.t-k*QTR)?.r;if(!x)return null;prior.push(x);} const floors=[...prior.map(x=>x.floor),cur.floor]; let path=0; for(let j=1;j<floors.length;j++)path+=Math.abs((floors[j]-floors[j-1])/floors[j-1]); if(!(path>0))return null; const net=(floors.at(-1)-floors[0])/floors[0]; let rev=0; for(let j=1;j<prior.length;j++)if(prior[j].result!==prior[j-1].result)rev++; return {efficiency:Math.min(1,Math.abs(net)/path), reversalRate:rev/3, currentStreak:streakAt(i)};
}
function trigger(i){ if(i<3)return null; const cur=rows[i], one=byT.get(cur.t-QTR)?.r, two=byT.get(cur.t-2*QTR)?.r, three=byT.get(cur.t-3*QTR)?.r; if(!one||!two||!three||one.result!==two.result||three.result===one.result)return null; return opp(one.result); }
function summarize(trades){ let pnl=0,peak=0,dd=0,w=0,l=0,maxL=0,runL=0; for(const x of trades){const p=x.win?STAKE-FEE:-STAKE-FEE;pnl+=p;peak=Math.max(peak,pnl);dd=Math.max(dd,peak-pnl);if(x.win){w++;runL=0}else{l++;runL++;maxL=Math.max(maxL,runL)}} return {trades:trades.length,wins:w,losses:l,win_rate:trades.length?w/trades.length:null,net_pnl_dollars:pnl/100,roi_on_principal:trades.length?pnl/(trades.length*STAKE):null,max_drawdown_dollars:dd/100,longest_losing_streak:maxL}; }
let state='off'; const current=[],g2=[];
for(let i=0;i<rows.length;i++){
  const r=rows[i]; if(r.t<start)continue; const m=metrics(i); const side=trigger(i); if(!m||!side) { // still advance current regime state when metrics available
    if(m){ if(m.efficiency>=OFF_EFF)state='off'; else if(m.currentStreak>=OFF_STREAK&&m.efficiency>=OFF_STREAK_EFF)state='off'; else if(m.currentStreak<OFF_STREAK&&m.efficiency<=ON_EFF&&m.reversalRate>=ON_REV)state='on'; }
    continue;
  }
  if(m.efficiency>=OFF_EFF)state='off'; else if(m.currentStreak>=OFF_STREAK&&m.efficiency>=OFF_STREAK_EFF)state='off'; else if(m.currentStreak<OFF_STREAK&&m.efficiency<=ON_EFF&&m.reversalRate>=ON_REV)state='on';
  const win=r.result===side;
  if(state==='on')current.push({t:r.t,ticker:r.ticker,side,result:r.result,win,...m});
  if(m.currentStreak<3&&m.efficiency<=.35&&m.reversalRate>=2/3)g2.push({t:r.t,ticker:r.ticker,side,result:r.result,win,...m});
}
function split(arr){const cut=start+70*DAY; return {train:summarize(arr.filter(x=>x.t<cut)),holdout:summarize(arr.filter(x=>x.t>=cut))};}
const report={generated_at:new Date().toISOString(),window:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},methodology:'Exact-two streak reversal trigger. Flat $100 theoretical fill at 50c; $3.50 modeled fee. Current gate replay uses live hysteresis rules. G2 requires fresh entry qualification every market: reversalRate>=2/3, efficiency<=0.35, currentStreak<3. No liquidity/queue/slippage/capital blocking.',current_hysteresis:{...summarize(current),...split(current)},g2_fresh_confirmation:{...summarize(g2),...split(g2)}};
fs.writeFileSync(OUT,JSON.stringify(report,null,2));
console.error(`G2_FRESH_CONFIRMATION ${JSON.stringify(report)}`);
