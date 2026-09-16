import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');
let source = readFileSync(dashboardPath, 'utf8');

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
