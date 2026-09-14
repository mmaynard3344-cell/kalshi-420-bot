import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(here, '..', 'public', 'pnl-runtime.js');
let source = readFileSync(runtimePath, 'utf8');

const replaceOnce = (from, to, label) => {
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error(`Expected exactly one ${label} anchor, found ${hits}`);
  source = source.replace(from, to);
};

// New G orders use a prefix-style client_order_id: g-streak-reversal-v1:<ticker>.
// Keep the old G probe namespace readable, but classify new G rows explicitly.
if (!source.includes("if(c.startsWith('g-streak-reversal-v1:'))return'G · Reversal';")) {
  replaceOnce(
    "if(c.endsWith(':eth-probe-g-5m-30c-v1'))return'G · Probe';",
    "if(c.startsWith('g-streak-reversal-v1:'))return'G · Reversal';if(c.endsWith(':eth-probe-g-5m-30c-v1'))return'G · Probe';",
    'G service classifier',
  );
}

// Attribute new G fills to the bot-owned account P&L instead of dropping them
// from the fill whitelist. This is display/accounting only; no trading path is touched.
if (!source.includes("c.startsWith('g-streak-reversal-v1:')||c.startsWith('eth-yes-')")) {
  replaceOnce(
    "return c.startsWith('eth-yes-')||c.startsWith('eth-no-')||",
    "return c.startsWith('g-streak-reversal-v1:')||c.startsWith('eth-yes-')||c.startsWith('eth-no-')||",
    'bot-order whitelist',
  );
}

// Retire the old G Probe scorecard slot in favor of the current G Reversal label.
source = source.replace("'G · Probe','H · Ashley'", "'G · Reversal','H · Ashley'");
source = source.replace("'G · Probe':'#d56cf0','H · Ashley'", "'G · Reversal':'#d56cf0','H · Ashley'");

// When an executed order is already reporting a fill count but the separate fill
// feed has not joined yet, derive the displayed wager and average fill from the
// exchange order itself. This prevents a 400 @ 50c G fill from rendering as $0.00.
if (!source.includes('op=price(o,s),p=f?f.principalCents:')) {
  replaceOnce(
    "filled=f?f.contracts:reported(o),p=f?f.principalCents:0,av=f?.contracts?Math.round(f.principalCents/f.contracts):null,os=status(o),",
    "filled=f?f.contracts:reported(o),op=price(o,s),p=f?f.principalCents:(filled!=null&&filled>0&&op!=null?Math.round(filled*op*100):0),av=f?.contracts?Math.round(f.principalCents/f.contracts):(filled!=null&&filled>0&&op!=null?Math.round(op*100):null),os=status(o),",
    'executed-order wager display',
  );
}

if (!source.includes("g-streak-reversal-v1:")) throw new Error('G reversal namespace missing after patch');
if (!source.includes("return'G · Reversal'")) throw new Error('G reversal display label missing after patch');
if (!source.includes("op=price(o,s),p=f?f.principalCents:")) throw new Error('G wager fallback missing after patch');

writeFileSync(runtimePath, source);
console.log('Patched final dashboard runtime: G reversal label, P&L whitelist, and wager display');
