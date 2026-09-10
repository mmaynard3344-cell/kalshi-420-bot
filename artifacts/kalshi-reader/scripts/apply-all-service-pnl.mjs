import fs from 'node:fs';

const pnlPath = new URL('../public/pnl-runtime.js', import.meta.url);
let pnl = fs.readFileSync(pnlPath, 'utf8');

// The transaction ledger is account-wide, so headline/daily/weekly/monthly P&L
// must use the same settled Kalshi fills across every service. The older durable
// DB override only knows the original Regular/Candidate ledgers and therefore
// omits newer services such as D/E/F/G/H/I.
const oldSeries = "S=['Regular','Jump','Legacy 420','Reversal'],C={Regular:'#4f8cff',Jump:'#35b66f','Legacy 420':'#d9a441',Reversal:'#d56cf0'}";
const oldSeriesAshV2 = "S=['Regular','Jump','Legacy 420','Reversal','Ash V2'],C={Regular:'#4f8cff',Jump:'#35b66f','Legacy 420':'#d9a441',Reversal:'#d56cf0','Ash V2':'#8b5cf6'}";
const oldSeriesAg = "S=['A · Regular','B · Jump','C · Reversal','D · Breakout Reversal','E · Downfade','F · Downfade','G · Probe','Legacy 420'],C={'A · Regular':'#4f8cff','B · Jump':'#35b66f','C · Reversal':'#d56cf0','D · Breakout Reversal':'#d9a441','E · Downfade':'#4f8cff','F · Downfade':'#35b66f','G · Probe':'#d56cf0','Legacy 420':'#d9a441'}";
const oldSeriesAgh = "S=['A · Regular','B · Jump','C · Reversal','D · Breakout Reversal','E · Downfade','F · Downfade','G · Probe','H · Ashley','Legacy 420'],C={'A · Regular':'#4f8cff','B · Jump':'#35b66f','C · Reversal':'#d56cf0','D · Breakout Reversal':'#d9a441','E · Downfade':'#4f8cff','F · Downfade':'#35b66f','G · Probe':'#d56cf0','H · Ashley':'#7c5cff','Legacy 420':'#d9a441'}";
const newSeries = "S=['A · Regular','B · Jump','C · Reversal','D · Breakout Reversal','E · Downfade','F · Downfade','G · Probe','H · Ashley','I · Ash V2','Legacy 420'],C={'A · Regular':'#4f8cff','B · Jump':'#35b66f','C · Reversal':'#d56cf0','D · Breakout Reversal':'#d9a441','E · Downfade':'#4f8cff','F · Downfade':'#35b66f','G · Probe':'#d56cf0','H · Ashley':'#7c5cff','I · Ash V2':'#8b5cf6','Legacy 420':'#d9a441'}";
if (pnl.includes(oldSeries)) pnl = pnl.replace(oldSeries, newSeries);
else if (pnl.includes(oldSeriesAshV2)) pnl = pnl.replace(oldSeriesAshV2, newSeries);
else if (pnl.includes(oldSeriesAg)) pnl = pnl.replace(oldSeriesAg, newSeries);
else if (pnl.includes(oldSeriesAgh)) pnl = pnl.replace(oldSeriesAgh, newSeries);
else if (!pnl.includes(newSeries)) throw new Error('all-service P&L: strategy series anchor not found');

const oldStrategy = "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.endsWith(':eth-jump-v1'))return'Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'Reversal';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';return'Regular'};";
const oldStrategyAshV2 = "const strategy=r=>{const c=String(r?.client_order_id??r?.clientOrderId??'');if(c.endsWith(':eth-ash-v2-i-v1'))return'Ash V2';if(c.endsWith(':eth-jump-v1'))return'Jump';if(c.endsWith(':eth-no3-reversal-v1'))return'Reversal';if(c.endsWith(':eth420-live-v1'))return'Legacy 420';return'Regular'};";
const newStrategy = "const strategy=r=>serviceLabel(r);";
if (pnl.includes(oldStrategy)) pnl = pnl.replace(oldStrategy, newStrategy);
else if (pnl.includes(oldStrategyAshV2)) pnl = pnl.replace(oldStrategyAshV2, newStrategy);
else if (!pnl.includes(newStrategy)) throw new Error('all-service P&L: strategy classifier anchor not found');

const oldFetch = "const[fr,or,dr]=await Promise.allSettled([fills(),orders(),fetch('/api/diagnostics/db-pnl',{cache:'no-store'})]);";
const newFetch = "const[fr,or]=await Promise.allSettled([fills(),orders()]);";
if (pnl.includes(oldFetch)) pnl = pnl.replace(oldFetch, newFetch);
else if (!pnl.includes(newFetch)) throw new Error('all-service P&L: refresh fetch anchor not found');

const oldPaint = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders}if(dr.status==='fulfilled'&&dr.value.ok){const db=await dr.value.json();if(Array.isArray(db?.days)&&Array.isArray(db?.trades)){const auth=db.trades.map(t=>{const f=fm.get(String(t.orderId||''));return{...t,avgFillPriceCents:f?.avgFillPriceCents??null,atMs:f?.atMs??t.atMs}});summary(db.days);analytics(auth,db.days)}}";
const newPaint = "if(fr.status==='fulfilled'){const z=summarize(fr.value.rows,idx);fm=z.orders;summary(z.days);analytics([...z.orders.values()],z.days)}";
if (pnl.includes(oldPaint)) pnl = pnl.replace(oldPaint, newPaint);
else if (!pnl.includes(newPaint)) throw new Error('all-service P&L: authoritative paint anchor not found');

if (pnl.includes('summary(db.days)')) throw new Error('all-service P&L: incomplete durable DB override still active');
if (!pnl.includes('summary(z.days);analytics([...z.orders.values()],z.days)')) throw new Error('all-service P&L: account-wide fill aggregation missing');

fs.writeFileSync(pnlPath, pnl);