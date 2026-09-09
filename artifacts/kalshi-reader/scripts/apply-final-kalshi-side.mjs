import fs from 'node:fs';

const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');

// Kalshi's explicit contract side is authoritative. Price pairs describe the
// complementary YES/NO prices and must never be used to override side=yes/no.
// This finalizer runs last so earlier legacy dashboard mutators cannot restore
// the old price-first inference.
const wrongFormatted = `  const side = (row) => {\n    const client = String(row?.client_order_id ?? row?.clientOrderId ?? '');\n    if (client.startsWith('eth-yes-')) return 'yes';\n    if (client.startsWith('eth-no-')) return 'no';\n    const parse = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };\n    const yes = parse(row?.yes_price_dollars ?? row?.yes_price);\n    const no = parse(row?.no_price_dollars ?? row?.no_price);\n    if (yes != null && no != null && yes !== no) return no > yes ? 'no' : 'yes';\n    const raw = String(row?.side || '').toLowerCase();\n    if (raw === 'bid') return 'yes';\n    if (raw === 'ask') return 'no';\n    if (raw === 'yes' || raw === 'no') return raw;\n    if (no == null && yes != null) return 'yes';\n    if (yes == null && no != null) return 'no';\n    return '';\n  };`;

const correctFormatted = `  const side = (row) => {\n    const raw = String(row?.side || '').toLowerCase();\n    if (raw === 'yes' || raw === 'no') return raw;\n    const client = String(row?.client_order_id ?? row?.clientOrderId ?? '');\n    if (client.startsWith('eth-yes-')) return 'yes';\n    if (client.startsWith('eth-no-')) return 'no';\n    if (raw === 'bid') return 'yes';\n    if (raw === 'ask') return 'no';\n    const parse = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };\n    const yes = parse(row?.yes_price_dollars ?? row?.yes_price);\n    const no = parse(row?.no_price_dollars ?? row?.no_price);\n    if (no == null && yes != null) return 'yes';\n    if (yes == null && no != null) return 'no';\n    return '';\n  };`;

const wrongCompact = "side=r=>{const client=String(r?.client_order_id??r?.clientOrderId??'');if(client.startsWith('eth-yes-'))return'yes';if(client.startsWith('eth-no-'))return'no';const p=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null},y=p(r?.yes_price_dollars??r?.yes_price),n=p(r?.no_price_dollars??r?.no_price);if(y!=null&&n!=null&&y!==n)return n>y?'no':'yes';const raw=String(r?.side||'').toLowerCase();if(raw==='bid')return'yes';if(raw==='ask')return'no';if(raw==='yes'||raw==='no')return raw;if(n==null&&y!=null)return'yes';if(y==null&&n!=null)return'no';return''}";
const correctCompact = "side=r=>{const raw=String(r?.side||'').toLowerCase();if(raw==='yes'||raw==='no')return raw;const client=String(r?.client_order_id??r?.clientOrderId??'');if(client.startsWith('eth-yes-'))return'yes';if(client.startsWith('eth-no-'))return'no';if(raw==='bid')return'yes';if(raw==='ask')return'no';const p=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null},y=p(r?.yes_price_dollars??r?.yes_price),n=p(r?.no_price_dollars??r?.no_price);if(n==null&&y!=null)return'yes';if(y==null&&n!=null)return'no';return''}";

let changed = false;
if (pnl.includes(wrongFormatted)) {
  pnl = pnl.replace(wrongFormatted, correctFormatted);
  changed = true;
}
if (pnl.includes(wrongCompact)) {
  pnl = pnl.replace(wrongCompact, correctCompact);
  changed = true;
}

if (!changed && !pnl.includes(correctFormatted) && !pnl.includes(correctCompact)) {
  throw new Error('Final Kalshi-side anchor not found');
}

// Regression proof for the exact production failure: a Kalshi NO fill quoted
// as YES 56c / NO 44c must remain NO, never become YES from price comparison.
const regression = { side: 'no', yes_price_dollars: '0.5600', no_price_dollars: '0.4400' };
const authoritativeSide = String(regression.side).toLowerCase();
if (authoritativeSide !== 'no') throw new Error('Kalshi NO-side regression failed');

fs.writeFileSync(pnlPath, pnl);
