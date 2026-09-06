import fs from 'node:fs';

const dashboardPath = new URL('../public/eth420-dashboard.html', import.meta.url);
let html = fs.readFileSync(dashboardPath, 'utf8');

// These two values come from /trade/martingale's durable Regular next-state,
// not necessarily from the special order currently owning the live window.
html = html.replace('<div class="eyebrow">Current side</div><div class="metric" id="opSide">', '<div class="eyebrow">Regular next side</div><div class="metric" id="opSide">');
html = html.replace('<div class="eyebrow">Step / next wager</div><div class="metric" id="opStepWager">', '<div class="eyebrow">Regular step / next wager</div><div class="metric" id="opStepWager">');

// The original candidate-history renderer may continue to power the P&L/charts
// tab, but it must never overwrite authoritative Operations fields.
const removals = [
  "$('opSide').textContent=state?.side?.toUpperCase()||'—';",
  "$('opStepWager').textContent=state?`Step ${state.step} · ${d?.operationalStatus?.nextNormalWagerCents==null?'—':money(d.operationalStatus.nextNormalWagerCents,false)}`:'—';",
  "$('opPnl').textContent=money(tc);signed($('opPnl'),tc);$('ledgerSub').textContent=`${orders.length} candidate records · ${daily.length} daily rows returned`;",
];
for (const text of removals) html = html.replace(text, '');

// Latest order on Operations is exchange-order state, not candidate history.
html = html.replace(
  /if\(latest\)\{\$\('latestOrder'\)\.textContent=.*?\$\('latestOrderSub'\)\.textContent=.*?\}\n?const wk=/,
  'const wk=',
);

// Keep live quote/strike evidence from renderMarket(), but remove its candidate
// position block. Current order/position is owned exclusively by unified v3.
html = html.replace(
  /;const cp=l\?\.candidatePosition,p=cp\?\.availability==='available'\?cp\.position:null;if\(p\)\{.*?\}\n?function renderOpenOrders/,
  ';\nfunction renderOpenOrders',
);

// The old open-order renderer guesses the price field without respecting YES vs
// NO. Disable that invocation; unified v3 owns this table with side-aware prices.
html = html.replace(
  /if\(o\.status==='fulfilled'\)renderOpenOrders\(o\.value\);else\{.*?\}if\(b\.status===/,
  'if(b.status===',
);

fs.writeFileSync(dashboardPath, html);

// Kalshi's list-fills side field is not authoritative for NO purchases. Mirror
// the production fill normalizer: infer economic side from the YES/NO price
// pair, using the higher purchased-side price for this strategy's fills.
const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');
const formattedOldSide = "  const side = (row) => String(row?.side || '').toLowerCase();";
const formattedNewSide = `  const side = (row) => {\n    const parse = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };\n    const yes = parse(row?.yes_price_dollars ?? row?.yes_price);\n    const no = parse(row?.no_price_dollars ?? row?.no_price);\n    if (yes != null || no != null) {\n      if (no == null) return 'yes';\n      if (yes == null) return 'no';\n      return no > yes ? 'no' : 'yes';\n    }\n    const raw = String(row?.side || '').toLowerCase();\n    return raw === 'yes' || raw === 'no' ? raw : '';\n  };`;
const compactOldSide = "side=r=>String(r?.side||'').toLowerCase()";
const compactNewSide = "side=r=>{const p=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null},y=p(r?.yes_price_dollars??r?.yes_price),n=p(r?.no_price_dollars??r?.no_price);if(y!=null||n!=null){if(n==null)return'yes';if(y==null)return'no';return n>y?'no':'yes'}const raw=String(r?.side||'').toLowerCase();return raw==='yes'||raw==='no'?raw:''}";

if (!pnl.includes(formattedNewSide) && !pnl.includes(compactNewSide)) {
  if (pnl.includes(formattedOldSide)) {
    pnl = pnl.replace(formattedOldSide, formattedNewSide);
  } else if (pnl.includes(compactOldSide)) {
    pnl = pnl.replace(compactOldSide, compactNewSide);
  } else {
    throw new Error('Operations audit: P&L side anchor not found');
  }
}
fs.writeFileSync(pnlPath, pnl);
