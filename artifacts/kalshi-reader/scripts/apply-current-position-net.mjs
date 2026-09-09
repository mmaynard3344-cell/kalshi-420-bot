import fs from 'node:fs';

const operatorPath = new URL('../src/pages/Operator.tsx', import.meta.url);
let source = fs.readFileSync(operatorPath, 'utf8');

const start = source.indexOf('  const currentOpenTrade = useMemo(() => {');
const endAnchor = '  const accountEthPositions = (positions?.market_positions ?? []).filter((p: MartingalePosition) => p.ticker.startsWith(\'KXETH15M-\') && Number(p.position_fp) !== 0);';
const end = source.indexOf(endAnchor, start);
if (start === -1 || end === -1) throw new Error('Net current-position anchor not found');

const replacement = `  const currentOpenTrade = useMemo(() => {\n    const ticker = market?.market?.ticker ?? null;\n    if (!ticker) return null;\n\n    // Presentation truth for the live card: Kalshi account net position for this ticker.\n    // Individual A-F orders remain visible in the transaction log, but the card should\n    // match the aggregate position shown by Kalshi after opposing strategy fills net.\n    const net = (positions?.market_positions ?? []).find((p: MartingalePosition) => String(p.ticker) === ticker) ?? null;\n    const netContracts = net ? Number(net.position_fp) : 0;\n    if (net && Number.isFinite(netContracts) && netContracts !== 0) {\n      const exposureDollars = Number(net.market_exposure_dollars);\n      const committedCents = Number.isFinite(exposureDollars) ? Math.round(Math.abs(exposureDollars) * 100) : 0;\n      const contracts = Math.abs(netContracts);\n      return {\n        ticker,\n        order: { order_id: 'kalshi-net-position', status: 'open_position' },\n        owner: 'Kalshi account net',\n        side: netContracts > 0 ? 'YES' : 'NO',\n        requested: contracts,\n        filled: contracts,\n        status: 'OPEN POSITION',\n        committedCents,\n        placedAfterOpenMs: null,\n      };\n    }\n\n    const row = recentEthOrders.find((item) => String(item.order.ticker ?? '') === ticker) ?? null;\n    if (!row) return { ticker, order: null, owner: 'Awaiting order', side: '—', requested: 0, filled: 0, status: 'NO ORDER YET', committedCents: 0, placedAfterOpenMs: null };\n\n    const orderId = String(row.order.order_id ?? '');\n    let committedCents = 0;\n    for (const fill of accountFills) {\n      if (String(fill.order_id ?? '') !== orderId) continue;\n      const count = Number(fill.count_fp ?? fill.count ?? 0);\n      const price = row.side === 'NO' ? Number(fill.no_price_dollars) : Number(fill.yes_price_dollars);\n      if (Number.isFinite(count) && count > 0 && Number.isFinite(price) && price >= 0 && price <= 1) committedCents += Math.round(count * price * 100);\n    }\n    if (committedCents === 0 && row.filled > 0 && row.limitCents != null) committedCents = Math.round(row.filled * row.limitCents);\n    const marketOpenMs = market?.market?.openTime ? Date.parse(market.market.openTime) : NaN;\n    const placedAfterOpenMs = Number.isFinite(row.createdAtMs) && Number.isFinite(marketOpenMs) ? row.createdAtMs - marketOpenMs : null;\n    return { ticker, order: row.order, owner: row.owner, side: row.side, requested: row.requested, filled: row.filled, status: String(row.order.status ?? 'unknown').replaceAll('_', ' ').toUpperCase(), committedCents, placedAfterOpenMs };\n  }, [market?.market?.ticker, market?.market?.openTime, positions?.market_positions, recentEthOrders, accountFills]);\n`;

source = source.slice(0, start) + replacement + source.slice(end);

// Display-label cleanup only. Financial P&L runtime is untouched by this script.
source = source.replace('detail="Actual submitted side"', 'detail="Net Kalshi position side"');
source = source.replace('detail="Filled / requested"', 'detail="Net contracts held"');
source = source.replace('detail="Actual filled principal"', 'detail="Kalshi market exposure"');

if (!source.includes("owner: 'Kalshi account net'")) throw new Error('Net-position presentation proof missing');
fs.writeFileSync(operatorPath, source);
