import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');
const runtimePath = join(here, '..', 'public', 'pnl-runtime.js');

// The speed patch depends on the actual-fill overlay. Install that read-only
// dashboard overlay first when a fresh Railway checkout does not contain it.
let source = readFileSync(dashboardPath, 'utf8');
if (!source.includes('actual-fill-dashboard-v1')) {
  await import('./apply-actual-fill-dashboard.mjs');
  source = readFileSync(dashboardPath, 'utf8');
}

// Dashboard-only performance repair. Never touches trading/order code.
// Paint the last successful P&L summary immediately, then refresh exchange data
// in the background. Also stop re-fetching the full fill history every 5 sec.
if (!source.includes('shawshank-pnl-fast-cache-v1')) {
  source = source.replace(
    "const daily = summarize(payload.fills || []);\n      paint(daily, Boolean(payload.stale));",
    "const daily = summarize(payload.fills || []);\n      try { localStorage.setItem('shawshank-pnl-daily-v1', JSON.stringify({savedAt:Date.now(),daily})); } catch {}\n      paint(daily, Boolean(payload.stale));",
  );
  source = source.replace(
    "  refreshActual();\n  window.setInterval(refreshActual, 5000);",
    "  /* shawshank-pnl-fast-cache-v1 */\n  try {\n    const cached = JSON.parse(localStorage.getItem('shawshank-pnl-daily-v1') || 'null');\n    if (cached && Array.isArray(cached.daily)) paint(cached.daily, true);\n  } catch {}\n  refreshActual();\n  window.setInterval(refreshActual, 60000);",
  );
}

if (!source.includes('shawshank-pnl-fast-cache-v1')) {
  throw new Error('P&L overlay anchors not found; refusing partial dashboard patch');
}
writeFileSync(dashboardPath, source);

// Keep Jackpot fills out of Regular attribution. This changes display/reporting only.
let runtime = readFileSync(runtimePath, 'utf8');
if (!runtime.includes("'J · Jackpot'")) {
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
if (!runtime.includes("if(c.endsWith(':jackpot-j'))return'J · Jackpot'")) {
  throw new Error('Jackpot P&L attribution anchor not found; refusing partial dashboard patch');
}
writeFileSync(runtimePath, runtime);

console.log('Applied dashboard-only fast P&L cache + J · Jackpot attribution');
