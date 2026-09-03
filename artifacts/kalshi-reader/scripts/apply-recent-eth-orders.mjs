import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const operatorPath = join(here, '..', 'src', 'pages', 'Operator.tsx');
let source = readFileSync(operatorPath, 'utf8');

if (source.includes('Recent ETH orders')) process.exit(0);

const typeAnchor = `type LiveMarket = {`;
const types = `type ExchangeOrder = {
  ticker?: string;
  client_order_id?: string;
  order_id?: string;
  created_time?: string;
  outcome_side?: string;
  status?: string;
  initial_count_fp?: string | number;
  fill_count_fp?: string | number;
  yes_price_dollars?: string | number;
  no_price_dollars?: string | number;
};

type BackFlipRow = {
  sourceCandidateOrderId: string;
  sourceTicker: string;
  missedSide: string;
  sourceOpenTimeMs: number;
  targetOpenTimeMs: number;
  status: string;
  armedAtMs: number;
};

type BackFlipReport = { available: boolean; rows: BackFlipRow[] };

`;
if (!source.includes(typeAnchor)) throw new Error('Recent ETH orders: type anchor not found');
source = source.replace(typeAnchor, types + typeAnchor);

const stateAnchor = `  const [accountFills, setAccountFills] = useState<AccountFill[]>([]);\n  const [fillsFresh, setFillsFresh] = useState(false);`;
const stateReplacement = `${stateAnchor}\n  const [exchangeOrders, setExchangeOrders] = useState<ExchangeOrder[]>([]);\n  const [backFlips, setBackFlips] = useState<BackFlipReport | null>(null);`;
if (!source.includes(stateAnchor)) throw new Error('Recent ETH orders: P&L state anchor not found');
source = source.replace(stateAnchor, stateReplacement);

const loadAnchor = `      const [h, m, f] = await Promise.allSettled([\n        getJson<CandidateHistory>('/api/trade/analytics/eth420-candidate-history?limit=500', controller.signal),\n        getJson<LiveMarket>('/api/trade/analytics/eth420-live-market', controller.signal),\n        getJson<{ fills?: AccountFill[]; stale?: boolean }>('/api/trade/fills?limit=1000', controller.signal),\n      ]);`;
const loadReplacement = `      const [h, m, f, o, b] = await Promise.allSettled([\n        getJson<CandidateHistory>('/api/trade/analytics/eth420-candidate-history?limit=500', controller.signal),\n        getJson<LiveMarket>('/api/trade/analytics/eth420-live-market', controller.signal),\n        getJson<{ fills?: AccountFill[]; stale?: boolean }>('/api/trade/fills?limit=1000', controller.signal),\n        getJson<{ orders?: ExchangeOrder[] }>('/api/trade/orders?limit=100', controller.signal),\n        getJson<BackFlipReport>('/api/diagnostics/back-flips', controller.signal),\n      ]);`;
if (!source.includes(loadAnchor)) throw new Error('Recent ETH orders: load anchor not found');
source = source.replace(loadAnchor, loadReplacement);

const settleAnchor = `      if (f.status === 'fulfilled') { setAccountFills(f.value.fills ?? []); setFillsFresh(!f.value.stale); } else { setFillsFresh(false); }`;
const settleReplacement = `${settleAnchor}\n      if (o.status === 'fulfilled') setExchangeOrders(o.value.orders ?? []);\n      if (b.status === 'fulfilled') setBackFlips(b.value);`;
if (!source.includes(settleAnchor)) throw new Error('Recent ETH orders: settle anchor not found');
source = source.replace(settleAnchor, settleReplacement);

const derivedAnchor = `  const pnlTotals = useMemo(() => actualPnl.rows.reduce((total, row) => ({ bets: total.bets + row.bets, wageredCents: total.wageredCents + row.wageredCents, feesCents: total.feesCents + row.feesCents, grossWinningsCents: total.grossWinningsCents + row.grossWinningsCents, netPnlCents: total.netPnlCents + row.netPnlCents }), { bets: 0, wageredCents: 0, feesCents: 0, grossWinningsCents: 0, netPnlCents: 0 }), [actualPnl.rows]);`;
const derivedReplacement = `${derivedAnchor}\n  const recentEthOrders = useMemo(() => {\n    const routerLiveAtMs = Date.parse('2026-09-03T21:47:00Z');\n    const backFlipTargets = new Set((backFlips?.rows ?? []).filter((row) => Number.isFinite(row.targetOpenTimeMs)).map((row) => row.targetOpenTimeMs));\n    return exchangeOrders\n      .filter((order) => {\n        const clientId = String(order.client_order_id ?? '');\n        return String(order.ticker ?? '').startsWith('KXETH15M-') && (clientId.startsWith('eth-yes-') || clientId.startsWith('eth-no-') || clientId.endsWith(':eth420-live-v1'));\n      })\n      .map((order) => {\n        const clientId = String(order.client_order_id ?? '');\n        const createdAtMs = order.created_time ? Date.parse(order.created_time) : NaN;\n        const targetWindow = Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 900_000) * 900_000 : null;\n        let owner = 'Regular';\n        if (!clientId.startsWith('eth-yes-') && !clientId.startsWith('eth-no-')) {\n          if (Number.isFinite(createdAtMs) && createdAtMs < routerLiveAtMs) owner = 'Legacy Candidate';\n          else if (targetWindow != null && backFlipTargets.has(targetWindow)) owner = 'Back Flip';\n          else owner = '420 Jump';\n        }\n        const side = String(order.outcome_side ?? '').toUpperCase() || '—';\n        const requested = Number(order.initial_count_fp ?? 0);\n        const filled = Number(order.fill_count_fp ?? 0);\n        const priceRaw = side === 'NO' ? Number(order.no_price_dollars) : Number(order.yes_price_dollars);\n        const limitCents = Number.isFinite(priceRaw) ? Math.round(priceRaw * 100) : null;\n        return { order, clientId, createdAtMs, owner, side, requested, filled, limitCents };\n      })\n      .sort((a, b) => (Number.isFinite(b.createdAtMs) ? b.createdAtMs : 0) - (Number.isFinite(a.createdAtMs) ? a.createdAtMs : 0))\n      .slice(0, 50);\n  }, [exchangeOrders, backFlips]);`;
if (!source.includes(derivedAnchor)) throw new Error('Recent ETH orders: derived anchor not found');
source = source.replace(derivedAnchor, derivedReplacement);

source = source.replace('Recent candidate orders', 'Recent ETH orders');
source = source.replace('{orders.length} loaded', '{recentEthOrders.length} loaded');

const oldTableAnchor = `            <div className="overflow-x-auto">\n              <table className="w-full min-w-[850px] font-mono text-xs">`;
const newTable = `            <div className="overflow-x-auto">\n              <table className="w-full min-w-[920px] font-mono text-xs">\n                <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3 text-left">ET time</th><th className="p-3 text-left">Owner</th><th className="p-3 text-left">Ticker</th><th className="p-3 text-left">Side</th><th className="p-3 text-right">Requested / filled</th><th className="p-3 text-right">Limit</th><th className="p-3 text-left">Status</th></tr></thead>\n                <tbody>\n                  {recentEthOrders.map((row) => <tr key={String(row.order.order_id ?? row.clientId)} className="border-t border-border">\n                    <td className="p-3 whitespace-nowrap">{Number.isFinite(row.createdAtMs) ? etClock(row.createdAtMs) : 'Unavailable'}</td>\n                    <td className={cn('p-3 font-semibold', row.owner === 'Back Flip' && 'text-violet-600', row.owner === '420 Jump' && 'text-amber-600', row.owner === 'Regular' && 'text-emerald-600', row.owner === 'Legacy Candidate' && 'text-muted-foreground')}>{row.owner}</td>\n                    <td className="p-3 whitespace-nowrap">{row.order.ticker}</td>\n                    <td className="p-3 font-semibold">{row.side}</td>\n                    <td className="p-3 text-right">{row.requested} / {row.filled}</td>\n                    <td className="p-3 text-right">{row.limitCents == null ? '—' : \`${'${row.limitCents}¢'}\`}</td>\n                    <td className="p-3 uppercase">{String(row.order.status ?? 'unknown').replaceAll('_', ' ')}</td>\n                  </tr>)}\n                  {recentEthOrders.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No recent ETH bot orders found.</td></tr>}\n                </tbody>\n              </table>\n            </div>\n            <div className="hidden">\n              <table className="w-full min-w-[850px] font-mono text-xs">`;
if (!source.includes(oldTableAnchor)) throw new Error('Recent ETH orders: old table anchor not found');
source = source.replace(oldTableAnchor, newTable);

writeFileSync(operatorPath, source);
