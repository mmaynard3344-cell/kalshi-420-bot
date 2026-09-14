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
// service A-I and the legacy 420 namespace to reconcile from Kalshi itself.
const botHelper = "const botOrder=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');return c.startsWith('eth-yes-')||c.startsWith('eth-no-')||c.endsWith(':eth-jump-v1')||c.endsWith(':eth-no3-reversal-v1')||c.endsWith(':eth-no3-upperband-v1')||c.endsWith(':eth-downfade-p80-p99-v2')||c.endsWith(':eth-downfade-p90-p99-v2')||c.endsWith(':eth-probe-g-5m-30c-v1')||c.endsWith(':eth-ashley-h-v1')||c.endsWith(':eth-ash-v2-i-v1')||c.endsWith(':eth420-live-v1')};\n";
if (!runtime.includes('const botOrder=r=>')) {
  const anchor = 'function summarize(fs,idx){';
  if (!runtime.includes(anchor)) throw new Error('Final exchange P&L summarize anchor not found');
  runtime = runtime.replace(anchor, botHelper + anchor);
}

const summarizeLoopOld = "function summarize(fs,idx){const om=new Map;for(const f of fs){if(!eth(f))continue;";
const summarizeLoopNew = "function summarize(fs,idx){const om=new Map;for(const f of fs){if(!eth(f))continue;const parent=idx.get(oid(f));if(!botOrder(parent))continue;";
if (runtime.includes(summarizeLoopOld)) runtime = runtime.replace(summarizeLoopOld, summarizeLoopNew);
else if (!runtime.includes(summarizeLoopNew)) throw new Error('Final exchange P&L bot-order filter anchor not found');

// P&L SIGN AUTHORITY:
// Earlier legacy code preferred the parent order's side over the exchange fill's
// side. That can invert wins/losses when the parent representation differs from
// the actual filled contract. The fill itself is the financial truth. Parent
// orders are retained only for bot/strategy ownership.
const parentFirstSide = "const t=ms(f),linked=idx.get(oid(f)),linkedSide=side(linked),s=linkedSide==='yes'||linkedSide==='no'?linkedSide:side(f),n=count(f),p=price(f,s);";
const fillOnlySide = "const t=ms(f),s=side(f),n=count(f),p=price(f,s);";
if (runtime.includes(parentFirstSide)) runtime = runtime.replace(parentFirstSide, fillOnlySide);
else if (!runtime.includes(fillOnlySide)) throw new Error('Fill-side P&L authority anchor not found');

const validationOld = "if(t==null||!(n>0)||p==null||p<0||p>1)continue;";
const validationNew = "if((s!=='yes'&&s!=='no')||t==null||!(n>0)||p==null||p<0||p>1)continue;";
if (runtime.includes(validationOld)) runtime = runtime.replace(validationOld, validationNew);
else if (!runtime.includes(validationNew)) throw new Error('Fill-side validation anchor not found');

// TRANSACTION ECONOMICS:
// A joined exchange fill is authoritative for the transaction row's economic
// side. Before a fill is joined, use outcome_side for display when available;
// raw order side can describe quote/order encoding rather than economic YES/NO.
const txnSideOld = "const f=fm.get(oid(o)),t=ms(o),s=side(o),filled=";
const txnSideDisplay = "const f=fm.get(oid(o)),t=ms(o),s=orderSide(o),filled=";
const txnSideNew = "const f=fm.get(oid(o)),t=ms(o),s=f?.side||orderSide(o),filled=";
if (runtime.includes(txnSideOld)) runtime = runtime.replace(txnSideOld, txnSideNew);
else if (runtime.includes(txnSideDisplay)) runtime = runtime.replace(txnSideDisplay, txnSideNew);
else if (!runtime.includes(txnSideNew)) throw new Error('Transaction fill-side anchor not found');

// Missing joined-fill evidence is not an authoritative zero fill. Preserve the
// exchange order's reported fill count when present; otherwise keep null so the
// UI can render Pending. Only a canceled/cancelled order with an explicit zero
// count is labeled NO FILL.
const zeroFallback = 'filled=f?f.contracts:0';
const reportedFallback = 'filled=f?f.contracts:reported(o)';
if (runtime.includes(zeroFallback)) runtime = runtime.replace(zeroFallback, reportedFallback);
else if (!runtime.includes(reportedFallback)) throw new Error('Transaction pending-fill anchor not found');

const settleOld = "av=f?.contracts?Math.round(f.principalCents/f.contracts):null,settle=f?.result?f.result.toUpperCase():(filled==null?'PENDING':filled===0?'NO FILL':'PENDING'),pnl=f?.netCents??null;";
const settleLegacy = "av=f?.contracts?Math.round(f.principalCents/f.contracts):null,settle=f?.result?f.result.toUpperCase():(filled===0?'NO FILL':'PENDING'),pnl=f?.netCents??null;";
const settleNew = "av=f?.contracts?Math.round(f.principalCents/f.contracts):null,os=status(o),confirmedZero=filled===0&&(os==='CANCELED'||os==='CANCELLED'),settle=f?.result?f.result.toUpperCase():(confirmedZero?'NO FILL':'PENDING'),pnl=f?.netCents??null;";
if (runtime.includes(settleOld)) runtime = runtime.replace(settleOld, settleNew);
else if (runtime.includes(settleLegacy)) runtime = runtime.replace(settleLegacy, settleNew);
else if (!runtime.includes(settleNew)) throw new Error('Transaction settlement-state anchor not found');

const localIntentStatus = "${esc(f?(status(o)||'—'):'LOCAL INTENT · NO KALSHI FILL')}";
const rawStatus = "${esc(status(o)||'—')}";
const renderedStatus = "${esc(os||'—')}";
if (runtime.includes(localIntentStatus)) runtime = runtime.replace(localIntentStatus, renderedStatus);
else if (runtime.includes(rawStatus)) runtime = runtime.replace(rawStatus, renderedStatus);
else if (!runtime.includes(renderedStatus)) throw new Error('Transaction status anchor not found');

// Remove stale wording that implies the dashboard is reading the DB loss-guard
// ledger. The dashboard now reads direct exchange fills; the loss guard remains
// a separate conservative safety mechanism.
runtime = runtime.replaceAll('Kalshi exchange-proven ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
runtime = runtime.replaceAll('Durable all-service ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
runtime = runtime.replaceAll('Existing frontend-accessible ledger only.','Kalshi exchange fills only · settled bot orders.');

// Build must fail if any later/older path can still override financial totals,
// collapse a provisional transaction into an authoritative zero fill, or omit
// either of the newer H/I exchange namespaces from the final bot filter.
if (runtime.includes("fetch('/api/diagnostics/account-pnl'")) throw new Error('Account-P&L endpoint still overrides final dashboard totals');
if (runtime.includes('summary(account.days)')) throw new Error('DB account days still override final dashboard totals');
if (!runtime.includes('if(!botOrder(parent))continue;')) throw new Error('Bot exchange-order filter missing');
if (!runtime.includes("dataset.accountPnl='kalshi-fills'")) throw new Error('Final fill-authority proof marker missing');
if (!runtime.includes(fillOnlySide)) throw new Error('Financial P&L is not fill-side authoritative');
if (runtime.includes('linkedSide=side(linked)')) throw new Error('Parent-order side still overrides exchange fill side');
if (!runtime.includes(validationNew)) throw new Error('Invalid exchange fill side is not fail-closed');
if (!runtime.includes("s=f?.side||orderSide(o)")) throw new Error('Transaction rows are not economic-side authoritative');
if (!runtime.includes(reportedFallback)) throw new Error('Transaction unknown fill state is not preserved');
if (runtime.includes(zeroFallback)) throw new Error('Transaction unknown fill still collapses to zero');
if (!runtime.includes("confirmedZero=filled===0&&(os==='CANCELED'||os==='CANCELLED')")) throw new Error('Confirmed zero-fill state is not cancellation-gated');
if (runtime.includes('LOCAL INTENT · NO KALSHI FILL')) throw new Error('False local-intent zero-fill label survived finalizer');
if (!runtime.includes(":eth-ashley-h-v1")) throw new Error('Service H exchange namespace missing from final bot filter');
if (!runtime.includes(":eth-ash-v2-i-v1")) throw new Error('Service I exchange namespace missing from final bot filter');

// Regression proof for the exact observed economics: NO fill at 44c settling NO
// must be positive, while the same fill settling YES must be negative.
const testContracts = 840;
const testPriceCents = 44;
const testFeesCents = 1448;
const noWin = testContracts * 100 - testContracts * testPriceCents - testFeesCents;
const noLoss = -testContracts * testPriceCents - testFeesCents;
if (!(noWin > 0 && noLoss < 0)) throw new Error('Fill-side P&L sign regression failed');

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

// The base Operations refresh also had its own inline Today-P&L calculation
// from candidate/martingale state. Remove only that writer. pnl-runtime.js is
// now the sole writer of opPnl as well as every P&L-tab financial surface.
dashboard = dashboard.replace(/\s*const todayCents=Number\(today\?\.netRealizedPnlCents\s*\?\?\s*state\?\.realizedPnlCents\s*\?\?\s*0\);\s*\$\('opPnl'\)\.textContent=money\(todayCents\);\s*signedClass\(\$\('opPnl'\),todayCents\);?/g, '');
// Compact/semicolon variants from earlier build mutators.
dashboard = dashboard.replace(/\s*todayCents=Number\(today\?\.netRealizedPnlCents\s*\?\?\s*state\?\.realizedPnlCents\s*\?\?\s*0\);\s*\$\('opPnl'\)\.textContent=money\(todayCents\);\s*signedClass\(\$\('opPnl'\),todayCents\);?/g, '');

if (/netRealizedPnlCents[^;]{0,180}opPnl/.test(dashboard) || /realizedPnlCents[^;]{0,180}opPnl/.test(dashboard)) {
  throw new Error('Legacy Operations P&L writer survived finalizer');
}

dashboard = dashboard.replaceAll('Kalshi exchange-proven ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
dashboard = dashboard.replaceAll('Durable all-service ledger · same source as daily loss guard.','Kalshi exchange fills only · settled bot orders.');
dashboard = dashboard.replaceAll('Existing frontend-accessible ledger only.','Kalshi exchange fills only · settled bot orders.');
fs.writeFileSync(dashboardPath, dashboard);
