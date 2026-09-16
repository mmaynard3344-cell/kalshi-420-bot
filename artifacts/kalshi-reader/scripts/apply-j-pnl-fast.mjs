import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(here, '..', 'public', 'pnl-runtime.js');
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');

let runtime = readFileSync(runtimePath, 'utf8');

// Dashboard-only repair: restore explicit J / Jackpot attribution in the final
// generated P&L runtime. This does not touch trading, orders, sizing, or services.
if (!runtime.includes("':jackpot-j'")) {
  runtime = runtime.replace(
    "S=['Regular','Jump','Legacy 420','Reversal','Ash V2']",
    "S=['Regular','Jump','Legacy 420','Reversal','Ash V2','J · Jackpot']",
  );
  runtime = runtime.replace(
    "'Ash V2':'#8b5cf6'",
    "'Ash V2':'#8b5cf6','J · Jackpot':'#64748b'",
  );
  runtime = runtime.replace(
    "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');",
    "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.endsWith(':jackpot-j'))return'J · Jackpot';",
  );
}

if (!runtime.includes("c.endsWith(':jackpot-j')") || !runtime.includes("'J · Jackpot'")) {
  throw new Error('J P&L attribution anchors not found; refusing partial dashboard patch');
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
