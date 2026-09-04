import fs from 'node:fs';

const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');

const oldSide = "  const side = (row) => String(row?.side || '').toLowerCase();";
const newSide = `  const side = (row) => {\n    const parse = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };\n    const yes = parse(row?.yes_price_dollars ?? row?.yes_price);\n    const no = parse(row?.no_price_dollars ?? row?.no_price);\n    if (yes != null || no != null) {\n      if (no == null) return 'yes';\n      if (yes == null) return 'no';\n      return no > yes ? 'no' : 'yes';\n    }\n    const raw = String(row?.side || '').toLowerCase();\n    return raw === 'yes' || raw === 'no' ? raw : '';\n  };`;

if (!pnl.includes(newSide)) {
  if (!pnl.includes(oldSide)) throw new Error('P&L economic-side anchor not found');
  pnl = pnl.replace(oldSide, newSide);
}

fs.writeFileSync(pnlPath, pnl);
