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

replaceOnce(
  "S=['Regular','Jump','Legacy 420','Reversal','Ash V2']",
  "S=['Regular','Jump','Legacy 420','Reversal','G · Reversal','Ash V2']",
  'strategy list',
);
replaceOnce(
  "C={Regular:'#4f8cff',Jump:'#35b66f','Legacy 420':'#d9a441',Reversal:'#d56cf0','Ash V2':'#8b5cf6'}",
  "C={Regular:'#4f8cff',Jump:'#35b66f','Legacy 420':'#d9a441',Reversal:'#d56cf0','G · Reversal':'#7c8cff','Ash V2':'#8b5cf6'}",
  'strategy colors',
);
replaceOnce(
  "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.endsWith(':eth-ash-v2-i-v1'))return'Ash V2';if(c.endsWith(':eth-jump-v1'))return'Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'Reversal';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';return'Regular'};",
  "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.startsWith('g-streak-reversal-v1:'))return'G · Reversal';if(c.endsWith(':eth-ash-v2-i-v1'))return'Ash V2';if(c.endsWith(':eth-jump-v1'))return'Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'Reversal';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';return'Regular'};",
  'strategy classifier',
);
replaceOnce(
  "filled=f?f.contracts:reported(o),p=f?f.principalCents:0,av=f?.contracts?Math.round(f.principalCents/f.contracts):null,settle=",
  "filled=f?f.contracts:reported(o),op=price(o,s),p=f?f.principalCents:(filled!=null&&filled>0&&op!=null?Math.round(filled*op*100):0),av=f?.contracts?Math.round(f.principalCents/f.contracts):(filled!=null&&filled>0&&op!=null?Math.round(op*100):null),settle=",
  'order wager display',
);

writeFileSync(runtimePath, source);
console.log('Patched dashboard: G reversal classification and executed-order wager fallback');
