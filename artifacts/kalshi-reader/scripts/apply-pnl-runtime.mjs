import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(here, '..', 'public', 'eth420-dashboard.html');
const runtimePath = join(here, '..', 'public', 'pnl-runtime.js');

let source = readFileSync(dashboardPath, 'utf8');
source = source.replace('Step · side', 'Service · side');
source = source.replace('STEP · SIDE', 'SERVICE · SIDE');
if (!source.includes('pnl-runtime.js')) {
  if (!source.includes('</head>')) throw new Error('pnl-runtime: closing head not found');
  source = source.replace('</head>', '<script defer src="/pnl-runtime.js"></script>\n</head>');
}
writeFileSync(dashboardPath, source);

let runtime = readFileSync(runtimePath, 'utf8');
const strategyLine = "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.endsWith(':eth-jump-v1'))return'Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'Reversal';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';return'Regular'};";
const strategyLineAshV2 = "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.endsWith(':eth-ash-v2-i-v1'))return'Ash V2';if(c.endsWith(':eth-jump-v1'))return'Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'Reversal';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';return'Regular'};";
const serviceLine = "const serviceLabel=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.endsWith(':eth-jump-v1'))return'B · Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'C · Reversal';if(c.endsWith(':eth-no3-upperband-v1'))return'D · Breakout Reversal';if(c.endsWith(':eth-downfade-p80-p99-v2'))return'E · Downfade';if(c.endsWith(':eth-downfade-p90-p99-v2'))return'F · Downfade';if(c.endsWith(':eth-probe-g-5m-30c-v1'))return'G · Probe';if(c.endsWith(':eth-ashley-h-v1'))return'H · Ashley';if(c.endsWith(':eth-ash-v2-i-v1'))return'I · Ash V2';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';if(c.startsWith('eth-yes-')||c.startsWith('eth-no-'))return'A · Regular';return'ETH'};";
if (!runtime.includes('const serviceLabel=')) {
  const classifier = runtime.includes(strategyLineAshV2) ? strategyLineAshV2 : strategyLine;
  if (!runtime.includes(classifier)) {
    console.log('pnl-runtime: classifier already customized; skipping legacy classifier injection');
  } else {
    runtime = runtime.replace(classifier, classifier + '\n' + serviceLine);
  }
} else {
  if (!runtime.includes(":eth-ashley-h-v1'))return'H · Ashley'")) {
    const oldService = "if(c.endsWith(':eth-probe-g-5m-30c-v1'))return'G · Probe';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';";
    const newService = "if(c.endsWith(':eth-probe-g-5m-30c-v1'))return'G · Probe';if(c.endsWith(':eth-ashley-h-v1'))return'H · Ashley';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';";
    if (!runtime.includes(oldService)) throw new Error('pnl-runtime: Ashley service classifier anchor not found');
    runtime = runtime.replace(oldService, newService);
  }
  if (!runtime.includes(":eth-ash-v2-i-v1'))return'I · Ash V2'")) {
    const ashleyAnchor = "if(c.endsWith(':eth-ashley-h-v1'))return'H · Ashley';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';";
    const ashV2Service = "if(c.endsWith(':eth-ashley-h-v1'))return'H · Ashley';if(c.endsWith(':eth-ash-v2-i-v1'))return'I · Ash V2';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';";
    if (!runtime.includes(ashleyAnchor)) throw new Error('pnl-runtime: Ash V2 service classifier anchor not found');
    runtime = runtime.replace(ashleyAnchor, ashV2Service);
  }
}
runtime = runtime.replace("<td class=\"txn-side\">${strategy(o)} · ${s.toUpperCase()}</td>", "<td class=\"txn-side\">${serviceLabel(o)} · ${s.toUpperCase()}</td>");
writeFileSync(runtimePath, runtime);