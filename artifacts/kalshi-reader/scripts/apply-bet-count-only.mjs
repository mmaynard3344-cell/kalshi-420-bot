import fs from 'node:fs';

const runtimePath = new URL('../public/pnl-runtime.js', import.meta.url);
let runtime = fs.readFileSync(runtimePath, 'utf8');

// DISPLAY-COUNT ONLY.
// Financial economics are intentionally untouched. The daily summary's count
// unit is one ETH 15-minute market (ticker), regardless of how many strategies
// or child orders traded that market.

// Remove either earlier BETS-only or client-intent count patch if present.
runtime = runtime.replace(
  "d._betKeys??=new Set;d._betKeys.add(o.ticker+'|'+o.strategy);d.bets=d._betKeys.size;d.feesCents+=o.feesCents;",
  "d.bets++;d.feesCents+=o.feesCents;",
);

const priorOrderObject = "strategy:strategy(idx.get(id)),betKey:String(idx.get(id)?.client_order_id??idx.get(id)?.clientOrderId??'')||id}";
const baseOrderObject = "strategy:strategy(idx.get(id))}";
if (runtime.includes(priorOrderObject)) runtime = runtime.replace(priorOrderObject, baseOrderObject);

const priorReturn = "const bm=new Map;for(const o of om.values()){const key=o.betKey||o.id,g=bm.get(key)||{atMs:o.atMs,settled:false,won:null};g.atMs=Math.min(g.atMs,o.atMs);if(o.result){g.settled=true;if(g.won==null)g.won=!!o.won}bm.set(key,g)}for(const d of dm.values()){d.bets=0;d.settled=0;d.wins=0;d.losses=0}for(const g of bm.values()){const d=dm.get(dk(g.atMs));if(!d)continue;d.bets++;if(g.settled){d.settled++;d.wins+=g.won?1:0;d.losses+=g.won?0:1}}return{orders:om,days:[...dm.values()].sort((a,b)=>a.easternDate.localeCompare(b.easternDate))}}";
const baseReturn = "return{orders:om,days:[...dm.values()].sort((a,b)=>a.easternDate.localeCompare(b.easternDate))}}";
if (runtime.includes(priorReturn)) runtime = runtime.replace(priorReturn, baseReturn);

// Recompute ONLY BETS / SETTLED / WINS / LOSSES at the market level after the
// existing order-level financial aggregation has completed. Net P&L and fees in
// dm are left intact. A market's win/loss is based on its combined realized P&L.
const marketReturn = "const mm=new Map;for(const o of om.values()){const key=o.ticker,g=mm.get(key)||{atMs:o.atMs,hasFill:false,settled:false,netCents:0};g.atMs=Math.min(g.atMs,o.atMs);g.hasFill=true;if(o.result&&o.netCents!=null){g.settled=true;g.netCents+=o.netCents}mm.set(key,g)}for(const d of dm.values()){d.bets=0;d.settled=0;d.wins=0;d.losses=0}for(const g of mm.values()){const d=dm.get(dk(g.atMs));if(!d||!g.hasFill)continue;d.bets++;if(g.settled){d.settled++;if(g.netCents>0)d.wins++;else if(g.netCents<0)d.losses++}}return{orders:om,days:[...dm.values()].sort((a,b)=>a.easternDate.localeCompare(b.easternDate))}}";
if (runtime.includes(baseReturn)) runtime = runtime.replace(baseReturn, marketReturn);
else if (!runtime.includes(marketReturn)) throw new Error('Market-level daily count anchor not found');

// Guardrails: exact financial accumulation remains unchanged.
if (!runtime.includes('d.netCents+=o.netCents')) throw new Error('P&L accumulation anchor unexpectedly changed');
if (!runtime.includes('d.feesCents+=o.feesCents')) throw new Error('Fee accumulation anchor unexpectedly changed');
if (!runtime.includes('o.netCents=o.result?')) throw new Error('Per-order P&L calculation unexpectedly changed');
if (!runtime.includes('const mm=new Map')) throw new Error('Market-level count overwrite missing');

fs.writeFileSync(runtimePath, runtime);
