import fs from 'node:fs';

const runtimePath = new URL('../public/pnl-runtime.js', import.meta.url);
let runtime = fs.readFileSync(runtimePath, 'utf8');

// DISPLAY-COUNT ONLY.
// Financial economics are intentionally untouched. One economic bet is keyed by
// the bot's immutable client_order_id. Child/retry exchange orders with the same
// client_order_id must not inflate BETS / SETTLED / WINS / LOSSES.

// Remove the earlier market+strategy BETS-only patch if present. We recompute all
// four count columns together below so the table never mixes counting units.
runtime = runtime.replace(
  "d._betKeys??=new Set;d._betKeys.add(o.ticker+'|'+o.strategy);d.bets=d._betKeys.size;d.feesCents+=o.feesCents;",
  "d.bets++;d.feesCents+=o.feesCents;",
);

// Attach the immutable economic-bet identity to each fill-derived exchange order.
// This is metadata only; no side, price, result, fee, or P&L expression changes.
const orderObjectOld = "strategy:strategy(idx.get(id))}";
const orderObjectNew = "strategy:strategy(idx.get(id)),betKey:String(idx.get(id)?.client_order_id??idx.get(id)?.clientOrderId??'')||id}";
if (runtime.includes(orderObjectOld)) runtime = runtime.replace(orderObjectOld, orderObjectNew);
else if (!runtime.includes(orderObjectNew)) throw new Error('Economic-bet identity anchor not found');

// After the existing financial aggregation is complete, overwrite ONLY the four
// display counts from unique economic bets. Financial fields in dm are preserved.
const returnOld = "return{orders:om,days:[...dm.values()].sort((a,b)=>a.easternDate.localeCompare(b.easternDate))}}";
const returnNew = "const bm=new Map;for(const o of om.values()){const key=o.betKey||o.id,g=bm.get(key)||{atMs:o.atMs,settled:false,won:null};g.atMs=Math.min(g.atMs,o.atMs);if(o.result){g.settled=true;if(g.won==null)g.won=!!o.won}bm.set(key,g)}for(const d of dm.values()){d.bets=0;d.settled=0;d.wins=0;d.losses=0}for(const g of bm.values()){const d=dm.get(dk(g.atMs));if(!d)continue;d.bets++;if(g.settled){d.settled++;d.wins+=g.won?1:0;d.losses+=g.won?0:1}}return{orders:om,days:[...dm.values()].sort((a,b)=>a.easternDate.localeCompare(b.easternDate))}}";
if (runtime.includes(returnOld)) runtime = runtime.replace(returnOld, returnNew);
else if (!runtime.includes(returnNew)) throw new Error('Daily count recompute anchor not found');

// Guardrails: the exact financial accumulation expressions must survive unchanged.
if (!runtime.includes('d.netCents+=o.netCents')) throw new Error('P&L accumulation anchor unexpectedly changed');
if (!runtime.includes('d.feesCents+=o.feesCents')) throw new Error('Fee accumulation anchor unexpectedly changed');
if (!runtime.includes('o.netCents=o.result?')) throw new Error('Per-order P&L calculation unexpectedly changed');
if (!runtime.includes('betKey:String(')) throw new Error('Economic-bet identity missing');
if (!runtime.includes('for(const d of dm.values()){d.bets=0;d.settled=0;d.wins=0;d.losses=0}')) throw new Error('Count-only overwrite missing');

fs.writeFileSync(runtimePath, runtime);
