import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const operatorPath = join(here, '..', 'src', 'pages', 'Operator.tsx');
let source = readFileSync(operatorPath, 'utf8');

const alreadyApplied =
  source.includes('const actualTodayStats = useMemo(() => {') &&
  source.includes('value={moneyFromCents(actualTodayStats.netPnlCents, true)}');
if (alreadyApplied) process.exit(0);

const derivedAnchor = `  const pnlTotals = useMemo(() => actualPnl.rows.reduce((total, row) => ({ bets: total.bets + row.bets, wageredCents: total.wageredCents + row.wageredCents, feesCents: total.feesCents + row.feesCents, grossWinningsCents: total.grossWinningsCents + row.grossWinningsCents, netPnlCents: total.netPnlCents + row.netPnlCents }), { bets: 0, wageredCents: 0, feesCents: 0, grossWinningsCents: 0, netPnlCents: 0 }), [actualPnl.rows]);`;
const derivedReplacement = `${derivedAnchor}\n  const actualTodayStats = useMemo(() => {\n    const todayKey = easternDateKey(Date.now());\n    const pnlRow = actualPnl.rows.find((row) => row.easternDate === todayKey) ?? null;\n    const settledOrders = new Map<string, { side: string; result: string }>();\n    for (const fill of accountFills) {\n      if (!String(fill.ticker ?? '').startsWith('KXETH15M-')) continue;\n      const atMs = accountFillTimeMs(fill);\n      if (atMs == null || easternDateKey(atMs) !== todayKey) continue;\n      const result = String(fill.market_result ?? '').toLowerCase();\n      const side = String(fill.side ?? '').toLowerCase();\n      if ((result !== 'yes' && result !== 'no') || (side !== 'yes' && side !== 'no')) continue;\n      const key = String(fill.order_id ?? fill.fill_id ?? \`${'${fill.ticker}:${side}:${atMs}'}\`);\n      settledOrders.set(key, { side, result });\n    }\n    let wins = 0;\n    let losses = 0;\n    for (const order of settledOrders.values()) {\n      if (order.side === order.result) wins += 1;\n      else losses += 1;\n    }\n    return {\n      netPnlCents: pnlRow?.netPnlCents ?? 0,\n      settled: settledOrders.size,\n      wins,\n      losses,\n    };\n  }, [actualPnl.rows, accountFills]);`;
if (!source.includes(derivedAnchor)) throw new Error('Actual today P&L: derived anchor not found');
source = source.replace(derivedAnchor, derivedReplacement);

const oldMetric = `<Metric label="Today realized P&L" value={moneyFromCents(today?.netRealizedPnlCents, true)} detail={today ? \`${'${today.settledOrderCount} settled · ${today.winningOrderCount} wins / ${today.losingOrderCount} losses'}\` : 'Candidate daily ledger unavailable'} tone={(today?.netRealizedPnlCents ?? 0) > 0 ? 'good' : (today?.netRealizedPnlCents ?? 0) < 0 ? 'bad' : 'normal'} />`;
const newMetric = `<Metric label="Today realized P&L" value={moneyFromCents(actualTodayStats.netPnlCents, true)} detail={\`${'${actualTodayStats.settled} settled · ${actualTodayStats.wins} wins / ${actualTodayStats.losses} losses'}\`} tone={actualTodayStats.netPnlCents > 0 ? 'good' : actualTodayStats.netPnlCents < 0 ? 'bad' : 'normal'} />`;
if (!source.includes(oldMetric)) throw new Error('Actual today P&L: metric anchor not found');
source = source.replace(oldMetric, newMetric);

source = source.replace('Candidate daily ledger unavailable', 'Actual settled ETH orders today');

writeFileSync(operatorPath, source);
