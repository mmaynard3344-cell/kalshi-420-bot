import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');
let source = readFileSync(dashboardPath, 'utf8');

if (source.includes('actual-ledger-v3')) process.exit(0);

const oldRefresh = `  let busy=false;\n  async function refresh(){if(busy)return;busy=true;try{const [fr,or]=await Promise.all([fetch('/api/trade/fills?limit=10000',{cache:'no-store'}),fetch('/api/trade/orders?limit=1000',{cache:'no-store'})]);if(!fr.ok||!or.ok)throw new Error('fills '+fr.status+' / orders '+or.status);const fp=await fr.json(),op=await or.json(),fills=Array.isArray(fp?.fills)?fp.fills:[],orders=Array.isArray(op?.orders)?op.orders:[];const summary=summarize(fills);paintSummary(summary.days);paintOrders(orders,summary.orders);if(el('ledgerSub'))el('ledgerSub').textContent='Actual Kalshi ETH fills · '+summary.orders.size+' filled orders in available history';}catch(e){if(el('ledgerSub'))el('ledgerSub').textContent='Actual ETH ledger unavailable · '+String(e)}finally{busy=false}}\n  refresh();setInterval(refresh,5000);`;

const newRefresh = `  let busy=false;\n  async function refresh(){\n    if(busy)return;busy=true;\n    try{\n      const [fillResult,orderResult]=await Promise.allSettled([\n        fetch('/api/trade/fills?limit=1000',{cache:'no-store'}),\n        fetch('/api/trade/orders?limit=100',{cache:'no-store'})\n      ]);\n      let summary={orders:new Map(),days:[]};\n      let fillNote='fills unavailable';\n      if(fillResult.status==='fulfilled'&&fillResult.value.ok){\n        const fp=await fillResult.value.json();\n        const fills=Array.isArray(fp?.fills)?fp.fills:[];\n        summary=summarize(fills);\n        paintSummary(summary.days);\n        fillNote=summary.orders.size+' filled orders';\n      }\n      let orderNote='orders unavailable';\n      if(orderResult.status==='fulfilled'&&orderResult.value.ok){\n        const op=await orderResult.value.json();\n        const orders=Array.isArray(op?.orders)?op.orders:[];\n        paintOrders(orders,summary.orders);\n        orderNote=orders.filter(isEth).length+' recent ETH orders';\n      }\n      if(el('ledgerSub'))el('ledgerSub').textContent='Actual Kalshi ETH ledger · '+fillNote+' · '+orderNote;\n    }catch(e){\n      if(el('ledgerSub'))el('ledgerSub').textContent='Actual ETH ledger unavailable · '+String(e);\n    }finally{busy=false}\n  }\n  refresh();setInterval(refresh,5000);`;

if (!source.includes(oldRefresh)) throw new Error('actual-ledger-v3: v2 refresh block not found');
source = source.replace(oldRefresh, newRefresh);
source = source.replace('<script id="actual-ledger-v2">', '<script id="actual-ledger-v2"><!-- actual-ledger-v3 -->');
writeFileSync(dashboardPath, source);
