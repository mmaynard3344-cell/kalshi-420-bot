import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const operatorPath = join(here, '..', 'src', 'pages', 'Operator.tsx');
let source = readFileSync(operatorPath, 'utf8');

if (source.includes('<th className="p-3 text-left">Settlement</th>')) process.exit(0);

const mapAnchor = `    const backFlipTargets = new Set((backFlips?.rows ?? []).filter((row) => Number.isFinite(row.targetOpenTimeMs)).map((row) => row.targetOpenTimeMs));`;
const mapReplacement = `${mapAnchor}\n    const settlementByTicker = new Map<string, string>();\n    for (const fill of accountFills) {\n      const ticker = String(fill.ticker ?? '');\n      const result = String(fill.market_result ?? '').toLowerCase();\n      if (ticker.startsWith('KXETH15M-') && (result === 'yes' || result === 'no')) settlementByTicker.set(ticker, result.toUpperCase());\n    }`;
if (!source.includes(mapAnchor)) throw new Error('Settlement column: order-map anchor not found');
source = source.replace(mapAnchor, mapReplacement);

const returnAnchor = `        return { order, clientId, createdAtMs, owner, side, requested, filled, limitCents };`;
const returnReplacement = `        const settlement = settlementByTicker.get(String(order.ticker ?? '')) ?? 'Pending';\n        return { order, clientId, createdAtMs, owner, side, requested, filled, limitCents, settlement };`;
if (!source.includes(returnAnchor)) throw new Error('Settlement column: row return anchor not found');
source = source.replace(returnAnchor, returnReplacement);

const depsAnchor = `  }, [exchangeOrders, backFlips]);`;
const depsReplacement = `  }, [exchangeOrders, backFlips, accountFills]);`;
if (!source.includes(depsAnchor)) throw new Error('Settlement column: memo dependency anchor not found');
source = source.replace(depsAnchor, depsReplacement);

const headerAnchor = `<th className="p-3 text-left">Side</th><th className="p-3 text-right">Requested / filled</th>`;
const headerReplacement = `<th className="p-3 text-left">Side</th><th className="p-3 text-left">Settlement</th><th className="p-3 text-right">Requested / filled</th>`;
if (!source.includes(headerAnchor)) throw new Error('Settlement column: table header anchor not found');
source = source.replace(headerAnchor, headerReplacement);

const cellAnchor = `<td className="p-3 font-semibold">{row.side}</td>\n                    <td className="p-3 text-right">{row.requested} / {row.filled}</td>`;
const cellReplacement = `<td className="p-3 font-semibold">{row.side}</td>\n                    <td className={cn('p-3 font-semibold', row.settlement === 'YES' && 'text-emerald-600', row.settlement === 'NO' && 'text-destructive', row.settlement === 'Pending' && 'text-muted-foreground')}>{row.settlement}</td>\n                    <td className="p-3 text-right">{row.requested} / {row.filled}</td>`;
if (!source.includes(cellAnchor)) throw new Error('Settlement column: table cell anchor not found');
source = source.replace(cellAnchor, cellReplacement);

source = source.replace('colSpan={7}', 'colSpan={8}');
source = source.replace('min-w-[920px]', 'min-w-[1020px]');

writeFileSync(operatorPath, source);
