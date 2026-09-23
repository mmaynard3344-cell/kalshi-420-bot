import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(here, '..', 'public', 'pnl-runtime.js');
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');

let runtime = readFileSync(runtimePath, 'utf8');

// Dashboard-only finalizer: normalize every current Shawshank service label
// after all earlier P&L generators have run. Unknown order tags stay visibly
// unattributed rather than silently falling through to A/Regular.
const serviceSeries = [
  'A · ETH 420',
  'B · Jump',
  'C · Reversal',
  'D · Breakout Reversal',
  'E · Downfade',
  'F · Downfade',
  'G · Probe',
  'H · Ashley',
  'I · Ash V2',
  'J · Jackpot',
  'K · Kamakazee',
  'Unattributed',
];
const serviceColors = {
  'A · ETH 420':'#4f8cff',
  'B · Jump':'#35b66f',
  'C · Reversal':'#d56cf0',
  'D · Breakout Reversal':'#d9a441',
  'E · Downfade':'#4f8cff',
  'F · Downfade':'#35b66f',
  'G · Probe':'#d56cf0',
  'H · Ashley':'#7c5cff',
  'I · Ash V2':'#8b5cf6',
  'J · Jackpot':'#64748b',
  'K · Kamakazee':'#d9a441',
  'Unattributed':'#94a3b8',
};
const seriesStart = runtime.indexOf("S=[");
const seriesEnd = runtime.indexOf(",B=[[", seriesStart);
if (seriesStart < 0 || seriesEnd < 0) throw new Error('A-K P&L series anchors not found');
runtime = runtime.slice(0, seriesStart)
  + `S=${JSON.stringify(serviceSeries)},C=${JSON.stringify(serviceColors)}`
  + runtime.slice(seriesEnd);

const strategyStart = runtime.indexOf('const strategy=r=>');
const strategyEnd = runtime.indexOf(';\nconst wk=', strategyStart);
if (strategyStart < 0 || strategyEnd < 0) throw new Error('A-K P&L strategy anchors not found');
const serviceClassifier = `const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.includes(':eth420-live-v1'))return'A · ETH 420';if(c.endsWith(':eth-jump-v1'))return'B · Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'C · Reversal';if(c.endsWith(':eth-no3-upperband-v1'))return'D · Breakout Reversal';if(c.endsWith(':eth-downfade-p80-p99-v2'))return'E · Downfade';if(c.endsWith(':eth-downfade-p90-p99-v2'))return'F · Downfade';if(c.endsWith(':eth-probe-g-5m-30c-v1'))return'G · Probe';if(c.endsWith(':eth-ashley-h-v1'))return'H · Ashley';if(c.endsWith(':eth-ash-v2-i-v1'))return'I · Ash V2';if(c.endsWith(':jackpot-j'))return'J · Jackpot';if(c.endsWith(':kamakazee-k-v1'))return'K · Kamakazee';return'Unattributed'}`;
runtime = runtime.slice(0, strategyStart) + serviceClassifier + runtime.slice(strategyEnd + 1);

for (const required of [
  "A · ETH 420", "B · Jump", "C · Reversal", "D · Breakout Reversal",
  "E · Downfade", "F · Downfade", "G · Probe", "H · Ashley",
  "I · Ash V2", "J · Jackpot", "K · Kamakazee", "Unattributed",
  ":eth420-live-v1", ":eth-jump-v1", ":eth-no3-reversal-v1",
  ":eth-no3-upperband-v1", ":eth-downfade-p80-p99-v2",
  ":eth-downfade-p90-p99-v2", ":eth-probe-g-5m-30c-v1",
  ":eth-ashley-h-v1", ":eth-ash-v2-i-v1", ":jackpot-j",
  ":kamakazee-k-v1",
]) {
  if (!runtime.includes(required)) throw new Error(`A-K P&L attribution missing ${required}`);
}

// Paint a compact recent ledger immediately while the complete exchange history
// continues loading for P&L totals and analytics.
if (!runtime.includes('shawshank-recent-ledger-v1')) {
  runtime = runtime.replace(
    "function paintOrders(rows,fm){if($('orderCount'))$('orderCount').textContent=rows.length+' actual orders';",
    "function paintOrders(rows,fm){rows=[...rows].sort((a,b)=>(ms(b)||0)-(ms(a)||0)).slice(0,100);if($('orderCount'))$('orderCount').textContent=rows.length+' recent orders';",
  );
  runtime = runtime.replace(
    "let busy=false;async function refresh(){if(busy)return;busy=true;try{const[fr,or]=await Promise.allSettled([fills(),orders()]);",
    "let busy=false;async function refresh(){if(busy)return;busy=true;try{/* shawshank-recent-ledger-v1 */void fetch('/api/trade/orders?limit=100',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(new Error(String(r.status)))).then(j=>{const recent=(Array.isArray(j?.orders)?j.orders:[]).filter(x=>eth(x));if(recent.length)paintOrders(recent,new Map)}).catch(()=>{});const[fr,or]=await Promise.allSettled([fills(),orders()]);",
  );
}
if (!runtime.includes('shawshank-recent-ledger-v1')) {
  throw new Error('Recent P&L ledger anchors not found; refusing partial dashboard patch');
}
writeFileSync(runtimePath, runtime);

// Preserve the existing dashboard speed repair at the END of the build chain so
// later P&L generators cannot overwrite it. Some legacy generators replace the
// dashboard wholesale, so restore the read-only actual-fill overlay if needed.
let dashboard = readFileSync(dashboardPath, 'utf8');
if (!dashboard.includes('actual-fill-dashboard-v1')) {
  await import('./apply-actual-fill-dashboard.mjs');
  dashboard = readFileSync(dashboardPath, 'utf8');
}
if (!dashboard.includes('shawshank-pnl-fast-cache-v1')) {
  dashboard = dashboard.replace(
    "const daily = summarize(payload.fills || []);\n      paint(daily, Boolean(payload.stale));",
    "const daily = summarize(payload.fills || []);\n      try { localStorage.setItem('shawshank-pnl-daily-v1', JSON.stringify({savedAt:Date.now(),daily})); } catch {}\n      paint(daily, Boolean(payload.stale));",
  );
  dashboard = dashboard.replace(
    "  refreshActual();\n  window.setInterval(refreshActual, 5000);",
    "  /* shawshank-pnl-fast-cache-v1 */\n  try {\n    const cached = JSON.parse(localStorage.getItem('shawshank-pnl-daily-v1') || 'null');\n    if (cached && Array.isArray(cached.daily)) paint(cached.daily, true);\n  } catch {}\n  refreshActual();\n  window.setInterval(refreshActual, 60000);",
  );
}
if (!dashboard.includes('shawshank-pnl-fast-cache-v1')) {
  throw new Error('P&L speed anchors not found; refusing partial dashboard patch');
}
writeFileSync(dashboardPath, dashboard);
console.log('Applied dashboard-only J attribution + fast P&L finalizer');
