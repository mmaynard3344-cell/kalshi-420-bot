#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const RAW = path.resolve('./kalshi-100day-research/raw/eth15m-markets-merged.json');
const OUT = path.resolve('./kalshi-100day-research/daily-streak-analysis.json');
const INTERVAL_MS = 15 * 60_000;

function etDate(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function etTime(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date(ms));
}
function pct(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x,y)=>x-y);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}
function summarize(moves) {
  if (!moves.length) return null;
  const abs = moves.map(m => Math.abs(m.ret));
  const signed = moves.map(m => m.ret);
  const path = abs.reduce((a,b)=>a+b,0);
  const start = moves[0].fromFloor;
  const end = moves[moves.length - 1].toFloor;
  const allFloors = [moves[0].fromFloor, ...moves.map(m=>m.toFloor)];
  const net = (end - start) / start;
  let reversals = 0;
  for (let i=1;i<moves.length;i++) if (moves[i].result !== moves[i-1].result) reversals++;
  return {
    markets: moves.length,
    start_et: etTime(moves[0].t),
    end_et: etTime(moves[moves.length-1].t + INTERVAL_MS),
    start_floor: start,
    end_floor: end,
    range_pct: 100 * (Math.max(...allFloors) - Math.min(...allFloors)) / start,
    net_pct: 100 * net,
    path_pct: 100 * path,
    efficiency: path ? Math.abs(net) / path : 0,
    mean_abs15_pct: 100 * abs.reduce((a,b)=>a+b,0) / abs.length,
    median_abs15_pct: 100 * pct(abs, .5),
    p80_abs15_pct: 100 * pct(abs, .8),
    p90_abs15_pct: 100 * pct(abs, .9),
    max_abs15_pct: 100 * Math.max(...abs),
    reversal_rate: moves.length > 1 ? reversals / (moves.length - 1) : 0,
    yes: moves.filter(m=>m.result==='yes').length,
    no: moves.filter(m=>m.result==='no').length,
    signed_mean15_pct: 100 * signed.reduce((a,b)=>a+b,0) / signed.length,
  };
}

const raw = JSON.parse(fs.readFileSync(RAW,'utf8'));
const rows = raw.map(m => ({
  t: Date.parse(m.open_time || m.close_time || m.settlement_ts),
  floor: Number(m.floor_strike),
  result: String(m.result || '').toLowerCase(),
  ticker: m.ticker,
})).filter(r => Number.isFinite(r.t) && Number.isFinite(r.floor) && r.floor > 500 && (r.result==='yes' || r.result==='no'))
  .sort((a,b)=>a.t-b.t);

const moves = [];
for (let i=0;i<rows.length-1;i++) {
  const a=rows[i], b=rows[i+1];
  if (b.t-a.t !== INTERVAL_MS) continue;
  moves.push({t:a.t,ticker:a.ticker,result:a.result,fromFloor:a.floor,toFloor:b.floor,ret:(b.floor-a.floor)/a.floor});
}
if (!moves.length) throw new Error('no contiguous ETH moves');
const targetDate = etDate(moves[moves.length-1].t);
const dayMoves = moves.filter(m=>etDate(m.t)===targetDate);
if (!dayMoves.length) throw new Error('no day moves');

const streaks=[];
let start=0;
for(let i=1;i<=dayMoves.length;i++) {
  const broken = i===dayMoves.length || dayMoves[i].result!==dayMoves[i-1].result || dayMoves[i].t-dayMoves[i-1].t!==INTERVAL_MS;
  if (broken) {
    const seq=dayMoves.slice(start,i);
    streaks.push({side:seq[0].result,length:seq.length,startIndex:start,endIndex:i-1,moves:seq});
    start=i;
  }
}
const maxLen=Math.max(...streaks.map(s=>s.length));
const maxStreaks=streaks.filter(s=>s.length===maxLen);
const analyses=maxStreaks.map((s,idx)=>{
  const set=new Set(s.moves.map(m=>m.ticker));
  const outside=dayMoves.filter(m=>!set.has(m.ticker));
  const before=dayMoves.filter(m=>m.t<s.moves[0].t);
  const after=dayMoves.filter(m=>m.t>s.moves[s.moves.length-1].t);
  return {
    index:idx+1,
    side:s.side,
    length:s.length,
    tickers:s.moves.map(m=>m.ticker),
    streak:summarize(s.moves),
    before:summarize(before),
    after:summarize(after),
    outside:summarize(outside),
    versus_full_day:{
      mean_abs_ratio: summarize(s.moves).mean_abs15_pct / summarize(dayMoves).mean_abs15_pct,
      median_abs_ratio: summarize(s.moves).median_abs15_pct / summarize(dayMoves).median_abs15_pct,
      efficiency_delta: summarize(s.moves).efficiency - summarize(dayMoves).efficiency,
      path_share: summarize(s.moves).path_pct / summarize(dayMoves).path_pct,
      range_share: summarize(s.moves).range_pct / summarize(dayMoves).range_pct,
    }
  };
});

const report={
  generated_at:new Date().toISOString(),
  date_et:targetDate,
  through_et:etTime(dayMoves[dayMoves.length-1].t + INTERVAL_MS),
  completed_markets:dayMoves.length,
  full_day_so_far:summarize(dayMoves),
  max_streak_length:maxLen,
  max_streak_count:maxStreaks.length,
  max_streaks:analyses,
};
fs.writeFileSync(OUT,JSON.stringify(report,null,2));
console.error(`DAILY_STREAK_COMPARE ${JSON.stringify(report)}`);
