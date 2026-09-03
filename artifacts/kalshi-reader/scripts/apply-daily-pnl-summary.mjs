import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const operatorPath = join(here, '..', 'src', 'pages', 'Operator.tsx');
let source = readFileSync(operatorPath, 'utf8');

if (source.includes('P&L since Aug 27')) process.exit(0);

const typeAnchor = `type LiveMarket = {`;
const fillType = `type AccountFill = {
  ticker: string;
  side: string;
  count_fp?: string | number;
  count?: string | number;
  yes_price_dollars?: string | number;
  no_price_dollars?: string | number;
  fee_cost?: string | number;
  fee_cost_dollars?: string | number;
  created_time?: string;
  ts?: number;
  order_id?: string;
  fill_id?: string;
  market_result?: string;
};

type DailyFillPnl = {
  easternDate: string;
  bets: number;
  wageredCents: number;
  feesCents: number;
  grossWinningsCents: number;
  netPnlCents: number;
};

`;
if (!source.includes(typeAnchor)) throw new Error('Operator fill type anchor not found');
source = source.replace(typeAnchor, fillType + typeAnchor);

const helperAnchor = `function countdown(closeTime: string | null | undefined, now: number) {`;
const helpers = `function easternDateKey(ms: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const part = (name: string) => parts.find((p) => p.type === name)?.value ?? '';
  return \`${'${part(\'year\')}-${part(\'month\')}-${part(\'day\')}'}\`;
}

function accountFillTimeMs(fill: AccountFill) {
  if (fill.created_time) {
    const parsed = Date.parse(fill.created_time);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Number.isFinite(fill.ts)) return Number(fill.ts) * 1000;
  return null;
}

function summarizeActualEthFills(fills: AccountFill[]): { rows: DailyFillPnl[]; coverageLimited: boolean } {
  const startDate = '2026-08-27';
  const days = new Map<string, { orderIds: Set<string>; wageredCents: number; feesCents: number; grossWinningsCents: number; netPnlCents: number }>();
  let oldestMs: number | null = null;

  for (const fill of fills) {
    if (!fill.ticker?.startsWith('KXETH15M-')) continue;
    const atMs = accountFillTimeMs(fill);
    if (atMs == null) continue;
    oldestMs = oldestMs == null ? atMs : Math.min(oldestMs, atMs);
    const day = easternDateKey(atMs);
    if (day < startDate) continue;

    const count = Number(fill.count_fp ?? fill.count ?? 0);
    const price = fill.side === 'no' ? Number(fill.no_price_dollars) : Number(fill.yes_price_dollars);
    const feeDollars = Number(fill.fee_cost ?? fill.fee_cost_dollars ?? 0);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(price) || price < 0 || price > 1 || !Number.isFinite(feeDollars) || feeDollars < 0) continue;

    const principalCents = Math.round(count * price * 100);
    const feesCents = Math.round(feeDollars * 100);
    const result = String(fill.market_result ?? '').toLowerCase();
    const won = result === fill.side;
    const settled = result === 'yes' || result === 'no';
    const grossPnlCents = settled ? (won ? Math.round(count * 100) - principalCents : -principalCents) : 0;
    const grossWinningsCents = settled && won ? Math.round(count * 100) - principalCents : 0;

    const row = days.get(day) ?? { orderIds: new Set<string>(), wageredCents: 0, feesCents: 0, grossWinningsCents: 0, netPnlCents: 0 };
    row.orderIds.add(String(fill.order_id ?? fill.fill_id ?? \`${'${fill.ticker}:${atMs}:${fill.side}'}\`));
    row.wageredCents += principalCents;
    row.feesCents += feesCents;
    row.grossWinningsCents += grossWinningsCents;
    row.netPnlCents += grossPnlCents - feesCents;
    days.set(day, row);
  }

  const rows = [...days.entries()]
    .map(([easternDate, row]) => ({ easternDate, bets: row.orderIds.size, wageredCents: row.wageredCents, feesCents: row.feesCents, grossWinningsCents: row.grossWinningsCents, netPnlCents: row.netPnlCents }))
    .sort((a, b) => b.easternDate.localeCompare(a.easternDate));
  const coverageLimited = fills.length >= 1000 && (oldestMs == null || easternDateKey(oldestMs) > startDate);
  return { rows, coverageLimited };
}

`;
if (!source.includes(helperAnchor)) throw new Error('Operator helper anchor not found');
source = source.replace(helperAnchor, helpers + helperAnchor);

const stateAnchor = `  const [market, setMarket] = useState<LiveMarket | null>(null);`;
const stateReplacement = `${stateAnchor}\n  const [accountFills, setAccountFills] = useState<AccountFill[]>([]);\n  const [fillsFresh, setFillsFresh] = useState(false);`;
if (!source.includes(stateAnchor)) throw new Error('Operator state anchor not found');
source = source.replace(stateAnchor, stateReplacement);

const loadAnchor = `      const [h, m] = await Promise.allSettled([
        getJson<CandidateHistory>('/api/trade/analytics/eth420-candidate-history?limit=500', controller.signal),
        getJson<LiveMarket>('/api/trade/analytics/eth420-live-market', controller.signal),
      ]);`;
const loadReplacement = `      const [h, m, f] = await Promise.allSettled([
        getJson<CandidateHistory>('/api/trade/analytics/eth420-candidate-history?limit=500', controller.signal),
        getJson<LiveMarket>('/api/trade/analytics/eth420-live-market', controller.signal),
        getJson<{ fills?: AccountFill[]; stale?: boolean }>('/api/trade/fills?limit=1000', controller.signal),
      ]);`;
if (!source.includes(loadAnchor)) throw new Error('Operator load anchor not found');
source = source.replace(loadAnchor, loadReplacement);

const settleAnchor = `      if (h.status === 'fulfilled') { setHistory(h.value); setHistoryFresh(true); } else { setHistoryFresh(false); }
      if (m.status === 'fulfilled') { setMarket(m.value); setMarketFresh(true); } else { setMarketFresh(false); }`;
const settleReplacement = `${settleAnchor}\n      if (f.status === 'fulfilled') { setAccountFills(f.value.fills ?? []); setFillsFresh(!f.value.stale); } else { setFillsFresh(false); }`;
if (!source.includes(settleAnchor)) throw new Error('Operator settle anchor not found');
source = source.replace(settleAnchor, settleReplacement);

const derivedAnchor = `  const orders = useMemo(() => [...(history?.orders ?? [])].sort((a, b) => b.createdAtMs - a.createdAtMs), [history]);`;
const derivedReplacement = `${derivedAnchor}\n  const actualPnl = useMemo(() => summarizeActualEthFills(accountFills), [accountFills]);\n  const pnlTotals = useMemo(() => actualPnl.rows.reduce((total, row) => ({ bets: total.bets + row.bets, wageredCents: total.wageredCents + row.wageredCents, feesCents: total.feesCents + row.feesCents, grossWinningsCents: total.grossWinningsCents + row.grossWinningsCents, netPnlCents: total.netPnlCents + row.netPnlCents }), { bets: 0, wageredCents: 0, feesCents: 0, grossWinningsCents: 0, netPnlCents: 0 }), [actualPnl.rows]);`;
if (!source.includes(derivedAnchor)) throw new Error('Operator derived anchor not found');
source = source.replace(derivedAnchor, derivedReplacement);

const sectionAnchor = `        <section className="border border-border bg-card">
          <div className="p-4 sm:p-5 border-b border-border flex flex-wrap justify-between gap-3">
            <div><div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Live market</div><h2 className="mt-1 font-semibold">ETH 15-minute operating context</h2></div>`;
const pnlSection = `        <section className="border border-border bg-card">
          <div className="p-4 sm:p-5 border-b border-border flex flex-wrap items-start justify-between gap-3">
            <div><div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">P&L since Aug 27</div><h2 className="mt-1 font-semibold">Actual Kalshi ETH fills</h2><p className="mt-1 text-xs text-muted-foreground">All executed KXETH15M fills · actual fill prices and exchange fees · Eastern Time</p></div>
            <span className={cn('font-mono text-[10px] uppercase', fillsFresh ? 'text-emerald-600' : 'text-amber-600')}>{fillsFresh ? 'Exchange data fresh' : 'Exchange data stale'}</span>
          </div>
          <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-5">
            <Metric label="Total bets" value={String(pnlTotals.bets)} detail="Unique filled Kalshi orders" />
            <Metric label="Total wagered" value={moneyFromCents(pnlTotals.wageredCents)} detail="Actual principal paid" />
            <Metric label="Fees" value={moneyFromCents(pnlTotals.feesCents)} detail="Actual exchange fees" />
            <Metric label="Gross winnings" value={moneyFromCents(pnlTotals.grossWinningsCents)} detail="Profit on winning fills before fees" tone="good" />
            <Metric label="Net P&L" value={moneyFromCents(pnlTotals.netPnlCents, true)} detail="Wins − losses − fees" tone={pnlTotals.netPnlCents > 0 ? 'good' : pnlTotals.netPnlCents < 0 ? 'bad' : 'normal'} />
          </div>
          {actualPnl.coverageLimited && <div className="border-t border-border bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">The 1,000-fill exchange limit was reached before Aug 27. Totals shown may be incomplete.</div>}
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[720px] font-mono text-xs">
              <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3 text-left">ET date</th><th className="p-3 text-right">Bets</th><th className="p-3 text-right">Wagered</th><th className="p-3 text-right">Fees</th><th className="p-3 text-right">Winnings</th><th className="p-3 text-right">Net P&L</th></tr></thead>
              <tbody>{actualPnl.rows.map((row) => <tr key={row.easternDate} className="border-t border-border"><td className="p-3">{etDay(row.easternDate)}</td><td className="p-3 text-right">{row.bets}</td><td className="p-3 text-right">{moneyFromCents(row.wageredCents)}</td><td className="p-3 text-right">{moneyFromCents(row.feesCents)}</td><td className="p-3 text-right text-emerald-600">{moneyFromCents(row.grossWinningsCents)}</td><td className={cn('p-3 text-right font-semibold', row.netPnlCents > 0 && 'text-emerald-600', row.netPnlCents < 0 && 'text-destructive')}>{moneyFromCents(row.netPnlCents, true)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

`;
if (!source.includes(sectionAnchor)) throw new Error('Operator live market section anchor not found');
source = source.replace(sectionAnchor, pnlSection + sectionAnchor);

writeFileSync(operatorPath, source);
