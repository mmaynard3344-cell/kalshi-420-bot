import fs from 'node:fs';

const runtimePath = new URL('../public/pnl-runtime.js', import.meta.url);
let runtime = fs.readFileSync(runtimePath, 'utf8');

// Financial execution truth comes only from /api/trade/fills. Local strategy
// rows may describe an intent/reservation, but they cannot supply a fill count.
const fillFallbackPatterns = [
  /filled=f\?f\.contracts:reported\(o\)/g,
  /filled=f\?f\.contracts:orderFilled\(o\)/g,
];
let fillFallbackChanged = false;
for (const pattern of fillFallbackPatterns) {
  const next = runtime.replace(pattern, 'filled=f?f.contracts:0');
  if (next !== runtime) {
    runtime = next;
    fillFallbackChanged = true;
  }
}

// If no exchange fill is joined, never display a local lifecycle status such
// as EXECUTED as proof of exchange execution. The current compact runtime emits
// status directly inside the result-cell template, so patch that render site.
const statusRenderPatterns = [
  {
    pattern: /\$\{esc\(status\(o\)\|\|'—'\)\}/g,
    replacement: "${esc(f?(status(o)||'—'):'LOCAL INTENT · NO KALSHI FILL')}",
  },
  {
    pattern: /\$\{esc\(orderStatus\(o\)\|\|'—'\)\}/g,
    replacement: "${esc(f?(orderStatus(o)||'—'):'LOCAL INTENT · NO KALSHI FILL')}",
  },
];
let statusChanged = false;
for (const { pattern, replacement } of statusRenderPatterns) {
  const next = runtime.replace(pattern, replacement);
  if (next !== runtime) {
    runtime = next;
    statusChanged = true;
  }
}

if (!fillFallbackChanged && !runtime.includes('filled=f?f.contracts:0')) {
  throw new Error('Exchange-truth fill anchor not found');
}
if (!statusChanged && !runtime.includes('LOCAL INTENT · NO KALSHI FILL')) {
  throw new Error('Exchange-truth status anchor not found');
}

// Regression proofs: neither local filled-contract fallback nor an unguarded
// local lifecycle status may remain in the live transaction-row renderer.
if (/filled=f\?f\.contracts:(?:reported|orderFilled)\(o\)/.test(runtime)) {
  throw new Error('Local fill fallback survived exchange-truth finalizer');
}
if (/\$\{esc\((?:status|orderStatus)\(o\)\|\|'—'\)\}/.test(runtime)) {
  throw new Error('Local status fallback survived exchange-truth finalizer');
}

fs.writeFileSync(runtimePath, runtime);
