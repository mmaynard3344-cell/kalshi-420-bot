import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const operatorPath = join(here, '..', 'src', 'pages', 'Operator.tsx');
let source = readFileSync(operatorPath, 'utf8');

if (source.includes('Live quote / strike') && !source.includes('ETH 15-minute operating context')) process.exit(0);

const oldGrid = `          <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-6">\n            <Metric label="Owner" value={currentOpenTrade?.owner ?? '—'} detail="Regular · 420 Jump · Back Flip" />\n            <Metric label="Side" value={currentOpenTrade?.side ?? '—'} detail="Actual submitted side" />\n            <Metric label="Contracts" value={currentOpenTrade ? \`${'${currentOpenTrade.filled} / ${currentOpenTrade.requested}'}\` : '—'} detail="Filled / requested" />\n            <Metric label="Committed" value={currentOpenTrade ? moneyFromCents(currentOpenTrade.committedCents) : '—'} detail="Actual filled principal" />\n            <Metric label="Placed after open" value={currentOpenTrade?.placedAfterOpenMs == null ? '—' : \`+${'${(currentOpenTrade.placedAfterOpenMs / 1000).toFixed(currentOpenTrade.placedAfterOpenMs < 1000 ? 3 : 1)}'}s\`} detail="Kalshi order created − official market open" />\n            <Metric label="Window closes" value={countdown(market?.market?.closeTime, now)} detail={currentOpenTrade?.order ? 'Live order for this window' : 'No bot order found yet'} />\n          </div>`;

const newGrid = `          <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">\n            <Metric label="Owner" value={currentOpenTrade?.owner ?? '—'} detail="Regular · 420 Jump · Back Flip" />\n            <Metric label="Side" value={currentOpenTrade?.side ?? '—'} detail="Actual submitted side" />\n            <Metric label="Contracts" value={currentOpenTrade ? \`${'${currentOpenTrade.filled} / ${currentOpenTrade.requested}'}\` : '—'} detail="Filled / requested" />\n            <Metric label="Committed" value={currentOpenTrade ? moneyFromCents(currentOpenTrade.committedCents) : '—'} detail="Actual filled principal" />\n            <Metric label="Placed after open" value={currentOpenTrade?.placedAfterOpenMs == null ? '—' : \`+${'${(currentOpenTrade.placedAfterOpenMs / 1000).toFixed(currentOpenTrade.placedAfterOpenMs < 1000 ? 3 : 1)}'}s\`} detail="Kalshi order created − official market open" />\n            <Metric label="Live quote / strike" value={evidence ? \`YES ${'${evidence.yesBid}/${evidence.yesAsk}¢'} · NO ${'${evidence.noBid}/${evidence.noAsk}¢'}\` : 'Unavailable'} detail={evidence ? \`Strike ${'${evidence.floorStrike}'}\` : 'Fresh quote unavailable'} />\n            <Metric label="Jump signal" value={history?.operationalStatus.telemetry.currentMove == null ? '—' : \`${'${(history.operationalStatus.telemetry.currentMove * 100).toFixed(4)}%'}\`} detail={\`p95 ${'${history?.operationalStatus.telemetry.p95 == null ? "—" : `${(history.operationalStatus.telemetry.p95 * 100).toFixed(4)}%`}'} · p99 ${'${history?.operationalStatus.telemetry.p99 == null ? "—" : `${(history.operationalStatus.telemetry.p99 * 100).toFixed(4)}%`}'}\`} />\n            <Metric label="Window closes" value={countdown(market?.market?.closeTime, now)} detail={currentOpenTrade?.order ? 'Live order for this window' : 'No bot order found yet'} />\n          </div>`;

if (!source.includes(oldGrid)) throw new Error('Consolidated live trade: current trade grid anchor not found');
source = source.replace(oldGrid, newGrid);

const liveStart = `        <section className="border border-border bg-card">\n          <div className="p-4 sm:p-5 border-b border-border flex flex-wrap justify-between gap-3">\n            <div><div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Live market</div><h2 className="mt-1 font-semibold">ETH 15-minute operating context</h2></div>`;
const nextSection = `        <section className="grid gap-4 lg:grid-cols-3">`;
const startIndex = source.indexOf(liveStart);
if (startIndex === -1) throw new Error('Consolidated live trade: live market section start not found');
const endIndex = source.indexOf(nextSection, startIndex);
if (endIndex === -1) throw new Error('Consolidated live trade: next section anchor not found');
source = source.slice(0, startIndex) + source.slice(endIndex);

writeFileSync(operatorPath, source);
