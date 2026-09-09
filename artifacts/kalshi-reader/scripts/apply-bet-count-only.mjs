import fs from 'node:fs';

const runtimePath = new URL('../public/pnl-runtime.js', import.meta.url);
let runtime = fs.readFileSync(runtimePath, 'utf8');

// DISPLAY-COUNT ONLY.
// Financial economics are intentionally untouched. BETS should represent one
// economic strategy bet per ETH market, not multiple child/retry exchange orders.
const old = "d.bets++;d.feesCents+=o.feesCents;";
const replacement = "d._betKeys??=new Set;d._betKeys.add(o.ticker+'|'+o.strategy);d.bets=d._betKeys.size;d.feesCents+=o.feesCents;";

if (runtime.includes(old)) runtime = runtime.replace(old, replacement);
else if (!runtime.includes(replacement)) throw new Error('Daily BETS count anchor not found');

// Guardrails: this count-only stage must not alter any financial calculation.
if (!runtime.includes('d.netCents+=o.netCents')) throw new Error('P&L accumulation anchor unexpectedly changed');
if (!runtime.includes('d.wins+=o.won?1:0')) throw new Error('Win-count anchor unexpectedly changed');
if (!runtime.includes('d.losses+=o.won?0:1')) throw new Error('Loss-count anchor unexpectedly changed');
if (!runtime.includes('d.feesCents+=o.feesCents')) throw new Error('Fee-count anchor unexpectedly changed');

fs.writeFileSync(runtimePath, runtime);
