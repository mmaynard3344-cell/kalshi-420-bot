import fs from 'node:fs';

const runtimePath = new URL('../public/pnl-runtime.js', import.meta.url);
let runtime = fs.readFileSync(runtimePath, 'utf8');

// FINAL ACCOUNTING AUTHORITY:
// Financial P&L is derived only from actual Kalshi fills joined to an exchange
// order whose client_order_id belongs to one of our bot namespaces. No local
// reservation, strategy table, reconstructed parent, or loss-guard ledger may
// override fill-side economics.

const tripleFetch = "const[fr,or,ar]=await Promise.allSettled([fills(),orders(),fetch('/api/diagnostics/account-pnl',{cache:'no-store'})]);";
const doubleFetch = "const[fr,or]=await Promise.allSettled([fills(),orders()]);";
if (runtime.includes(tripleFetch)) runtime = runtime.replace(tripleFetch, doubleFetch);

const sharedPaint = "let fillItems=[],fillDays=[];if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;fillItems=[...z.orders.values()];fillDays=z.days}if(ar.status==='fulfilled'&&ar.value.ok){const account=await ar.value.json();if(Array.isArray(account?.days)){summary(account.days);analytics(fillItems,account.days);if($('ledgerSub')&&account?.today){$('ledgerSub').dataset.accountPnl='1';$('ledgerSub').title='Exchange-proven realized P&L '+money(account.today.realizedPnlCents)+' · open risk '+money(account.today.openRiskCents,false)+' · same ledger as daily loss guard'}}}else if(fillDays.length){summary(fillDays);analytics(fillItems,fillDays)}";
const fillPaint = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days);if($('ledgerSub')){$('ledgerSub').dataset.accountPnl='kalshi-fills';$('ledgerSub').title='Kalshi-settled bot fills only · exchange side, price, fee and market result'}}";
if (runtime.includes(sharedPaint)) runtime = runtime.replace(sharedPaint, fillPaint);
else if (!runtime.includes(fillPaint)) {
  const oldFillPaint = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days)}";
  if (runtime.includes(oldFillPaint)) runtime = runtime.replace(oldFillPaint, fillPaint);
  else throw new Error('Final exchange P&L paint anchor not found');
}

// Restrict financial P&L to known bot exchange orders. This prevents manual ETH
// activity from being mislabeled as Service A while still allowing every bot
// service A-G and the legacy 420 namespace to reconcile from Kalshi itself.
const botHelper = "const botOrder=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');return c.startsWith('eth-yes-')||c.startsWith('eth-no-')||c.endsWith(':eth-jump-v1')||c.endsWith(':eth-no3-reversal-v1')||c.endsWith(':eth-no3-upperband-v1')||c.endsWith(':eth-downfade-p80-p99-v2')||c.endsWith(':eth-downfade-p90-p99-v2')||c.endsWith(':eth-probe-g-5m-30c-v1')||c.endsWith(':eth420-live-v1')};\n";
if (!runtime.includes('const botOrder=r=>')) {
  const anchor = 'function summarize(fs,idx){';
  if (!runtime.includes(anchor)) throw new Error('Final exchange P&L summarize anchor not found');
  runtime = runtime.replace(anchor, botHelper + anchor);
}

const summarizeLoopOld = "function summarize(fs,idx){const om=new Map;for(const f of fs){if(!eth(f))continue;";
const summarizeLoopNew = "function summarize(fs,idx){const om=new Map;for(const f of fs){if(!eth(f))continue;const parent=idx.get(oid(f));if(!botOrder(parent))continue;";
if (runtime.includes(summarizeLoopOld)) runtime = runtime.replace(summarizeLoopOld, summarizeLoopNew);
else if (!runtime.includes(summarizeLoopNew)) throw new Error('Final exchange P&L bot-order filter anchor not found');

// Remove stale wording that implies the dashboard is reading the DB loss-guard
// ledger. The dashboard now reads direct exchange fills; the loss guard remains
// a separate conservative safety mechanism.
runtime = runtime.replaceAll('Kalshi exchange-proven ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
runtime = runtime.replaceAll('Durable all-service ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
runtime = runtime.replaceAll('Existing frontend-accessible ledger only.','Kalshi exchange fills only · settled bot orders.');

// Build must fail if any later/older path can still override financial totals.
if (runtime.includes("fetch('/api/diagnostics/account-pnl'")) throw new Error('Account-P&L endpoint still overrides final dashboard totals');
if (runtime.includes('summary(account.days)')) throw new Error('DB account days still override final dashboard totals');
if (!runtime.includes('if(!botOrder(parent))continue;')) throw new Error('Bot exchange-order filter missing');
if (!runtime.includes("dataset.accountPnl='kalshi-fills'")) throw new Error('Final fill-authority proof marker missing');
if (/filled=f\?f\.contracts:(?:reported|orderFilled)\(o\)/.test(runtime)) throw new Error('Local fill fallback survived final exchange P&L stage');

fs.writeFileSync(runtimePath, runtime);

const dashboardPath = new URL('../public/eth420-dashboard.html', import.meta.url);
let dashboard = fs.readFileSync(dashboardPath, 'utf8');

// The historical actual-fill-dashboard-v1 overlay independently recalculates
// and repaints opPnl/pnlToday/pnlWeek/pnlMonth/pnlAll every five seconds. It
// predates the canonical runtime, has no bot-order filter, and can overwrite the
// correct exchange-only numbers after page load. Remove it completely here,
// after all earlier dashboard mutators have run.
dashboard = dashboard.replace(/\n?<script id="actual-fill-dashboard-v1">[\s\S]*?<\/script>\n?/g, '\n');
if (dashboard.includes('actual-fill-dashboard-v1')) {
  throw new Error('Legacy actual-fill P&L repaint overlay survived finalizer');
}

dashboard = dashboard.replaceAll('Kalshi exchange-proven ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
dashboard = dashboard.replaceAll('Durable all-service ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
dashboard = dashboard.replaceAll('Existing frontend-accessible ledger only.','Kalshi exchange fills only · settled bot orders.');
fs.writeFileSync(dashboardPath, dashboard);
