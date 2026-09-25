import { cn } from '@/lib/utils';
import { getTradeToken } from '@/lib/tradeToken';
import { useMartingaleData, type MartingalePosition } from '@/hooks/use-martingale-data';
import { AlertCircle, Activity, Clock3, Database, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const ET = 'America/New_York';

type CandidateOrder = {
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  step: number;
  requestedContracts: number;
  effectiveWagerCents: number;
  filledContracts: number | null;
  realizedPnlDeltaCents: number | null;
  status: string;
  settlementResult: string | null;
  actualNotionalDollars?: string | null;
  actualFeeDollars?: string | null;
  fillPriceCents?: number | null;
  createdAtMs: number;
};

type CandidateHistory = {
  executionApproved: boolean;
  liveEnabled: boolean;
  shadowEnabled: boolean;
  state: { easternDate: string; side: 'yes' | 'no'; step: number; realizedPnlCents: number } | null;
  orders: CandidateOrder[];
  ordersAvailability: { available: boolean };
  dailyPnl: {
    available: boolean;
    rows: Array<{
      easternDate: string;
      totalOrderCount: number;
      settledOrderCount: number;
      winningOrderCount: number;
      losingOrderCount: number;
      zeroPnlOrderCount: number;
      totalBetsCents: number;
      totalFeesCents: number;
      grossWinningsCents: number;
      grossLossesCents: number;
      netRealizedPnlCents: number;
    }>;
  };
  operationalStatus: {
    nextNormalWagerCents: number | null;
    unresolvedLifecycleCount: number;
    safetyState: { status: string; reason: string };
    telemetry: {
      validObservationCount: number;
      requiredObservationCount: number;
      currentMove: number | null;
      p95: number | null;
      p99: number | null;
      jumpReady: boolean;
      jumpFired: boolean | null;
    };
    prospectiveDailyLoss: { status: string; reason: string };
  };
};

type LiveMarket = {
  availability: { status: 'fresh' | 'stale' | 'unavailable'; reason: string | null; quoteAgeMs?: number | null };
  market: { ticker: string; exchangeIndex: number | null; openTime: string | null; closeTime: string | null; quoteUpdatedAtMs: number | null } | null;
  evidence: { yesBid: number; yesAsk: number; noBid: number; noAsk: number; floorStrike: number; adjacentMove: number | null } | null;
  adjacentMoveAvailability: { status: 'fresh' | 'unavailable'; reason: string | null };
  candidatePosition: {
    availability: 'available' | 'unavailable';
    reason: string | null;
    position: {
      ticker: string;
      side: 'yes' | 'no';
      step: number;
      intendedWagerCents: number;
      lifecycleStatus: string;
      requestedContracts: number;
      filledContracts: number | null;
      averageFillPriceCents: number | null;
      principalCommittedDollars: string | null;
      feesDollars: string | null;
      realizedPnlDeltaCents: number | null;
      settlementResult: 'yes' | 'no' | null;
    } | null;
  };
};


type ShadowStrategySummary = {
  strategy: 'A2' | 'L';
  available: boolean;
  signals: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  simulatedPnlCents: number;
  active: number;
  blocked: number;
  averageEntryPriceCents: number | null;
  latestAtMs: number | null;
};

type ShadowTradeRow = {
  strategy: 'A2' | 'L';
  id: string;
  signalId: string;
  ticker: string;
  clientOrderId: string;
  state: string;
  entryPriceCents: number | null;
  contracts: number | null;
  principalCents: number | null;
  settlementResult: string | null;
  pnlCents: number | null;
  terminalReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  settledAtMs: number | null;
};

type ShadowServiceHealth = {
  service: 'A2' | 'L';
  status: 'healthy' | 'stale' | 'unknown' | 'unavailable';
  lastEvaluationAtMs: number | null;
  latestTicker: string | null;
  latestMarketOpenTimeMs: number | null;
  evaluationIntervalMs: number | null;
  staleAfterMs: number | null;
  latestDecision: 'no_signal' | 'qualified' | 'error' | null;
  latestReason: string | null;
  latestEvidence: Record<string, unknown> | null;
  runtimeVersion: string | null;
  evaluationsRecent: number;
  noSignalRecent: number;
  qualifiedRecent: number;
  errorRecent: number;
  wouldSubmitRecent: number;
  shadowIntentsRecent: number;
  settledIntentsRecent: number;
};

type ShadowEvaluationRow = {
  service: 'A2' | 'L';
  evaluatedAtMs: number;
  ticker: string | null;
  marketOpenTimeMs: number | null;
  decision: 'no_signal' | 'qualified' | 'error';
  primaryReason: string | null;
  wouldSubmit: boolean;
  evidence: Record<string, unknown>;
  evaluationIntervalMs: number;
  runtimeVersion: string | null;
};

type ShadowPerformance = {
  generatedAtMs: number;
  recentWindowMs: number;
  note: string;
  services: ShadowServiceHealth[];
  summaries: ShadowStrategySummary[];
  evaluations: ShadowEvaluationRow[];
  rows: ShadowTradeRow[];
};

function moneyFromCents(value: number | null | undefined, signed = false) {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  const abs = Math.abs(value) / 100;
  const prefix = signed ? (value > 0 ? '+' : value < 0 ? '-' : '') : value < 0 ? '-' : '';
  return `${prefix}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function etClock(ms: number) {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

function etDay(value: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00Z`));
}

function countdown(closeTime: string | null | undefined, now: number) {
  if (!closeTime) return 'Unavailable';
  const target = Date.parse(closeTime);
  if (!Number.isFinite(target)) return 'Unavailable';
  const sec = Math.max(0, Math.ceil((target - now) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = await getTradeToken();
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'include',
    signal,
    headers: token ? { 'X-Trade-Token': token } : undefined,
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function Metric({ label, value, detail, tone = 'normal' }: { label: string; value: string; detail: string; tone?: 'normal' | 'good' | 'bad' | 'warn' }) {
  return <div className="border border-border bg-card p-4">
    <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
    <div className={cn('mt-2 font-mono text-2xl font-semibold', tone === 'good' && 'text-emerald-600', tone === 'bad' && 'text-destructive', tone === 'warn' && 'text-amber-600')}>{value}</div>
    <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
  </div>;
}

export default function Operator() {
  const { balance, positions, status, isStale, refetchAll } = useMartingaleData();
  const [history, setHistory] = useState<CandidateHistory | null>(null);
  const [market, setMarket] = useState<LiveMarket | null>(null);
  const [shadow, setShadow] = useState<ShadowPerformance | null>(null);
  const [historyFresh, setHistoryFresh] = useState(false);
  const [marketFresh, setMarketFresh] = useState(false);
  const [shadowFresh, setShadowFresh] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      const [h, m, s] = await Promise.allSettled([
        getJson<CandidateHistory>('/api/trade/analytics/eth420-candidate-history?limit=500', controller.signal),
        getJson<LiveMarket>('/api/trade/analytics/eth420-live-market', controller.signal),
        getJson<ShadowPerformance>('/api/diagnostics/shadow-performance', controller.signal),
      ]);
      if (!active) return;
      if (h.status === 'fulfilled') { setHistory(h.value); setHistoryFresh(true); } else { setHistoryFresh(false); }
      if (m.status === 'fulfilled') { setMarket(m.value); setMarketFresh(true); } else { setMarketFresh(false); }
      if (s.status === 'fulfilled') { setShadow(s.value); setShadowFresh(true); } else { setShadowFresh(false); }
    };
    void load();
    const dataTimer = window.setInterval(() => void load(), 10_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { active = false; inFlight.current?.abort(); window.clearInterval(dataTimer); window.clearInterval(clockTimer); };
  }, []);

  const stateDay = history?.state?.easternDate ?? null;
  const today = stateDay ? history?.dailyPnl.rows.find((row) => row.easternDate === stateDay) ?? null : null;
  const orders = useMemo(() => [...(history?.orders ?? [])].sort((a, b) => b.createdAtMs - a.createdAtMs), [history]);
  const latest = orders[0] ?? null;
  const cashCents = balance?.aggregate_balance_cents ?? (balance?.balance_dollars ? Math.round(Number(balance.balance_dollars) * 100) : null);
  const equityCents = cashCents == null || balance?.portfolio_value == null ? null : cashCents + balance.portfolio_value;
  const livePosition = market?.candidatePosition.availability === 'available' ? market.candidatePosition.position : null;
  const evidence = marketFresh && market?.availability.status === 'fresh' ? market.evidence : null;
  const accountEthPositions = (positions?.market_positions ?? []).filter((p: MartingalePosition) => p.ticker.startsWith('KXETH15M-') && Number(p.position_fp) !== 0);
  const runState = !historyFresh ? 'DATA STALE' : history?.liveEnabled && history?.executionApproved ? 'LIVE ENABLED' : 'ENTRY GATED';
  const runTone = runState === 'LIVE ENABLED' ? 'good' : runState === 'ENTRY GATED' ? 'warn' : 'bad';
  const a2Shadow = shadow?.summaries.find((row) => row.strategy === 'A2') ?? null;
  const lShadow = shadow?.summaries.find((row) => row.strategy === 'L') ?? null;
  const a2Health = shadow?.services.find((row) => row.service === 'A2') ?? null;
  const lHealth = shadow?.services.find((row) => row.service === 'L') ?? null;
  const shadowRows = shadow?.rows ?? [];
  const shadowEvaluations = shadow?.evaluations ?? [];
  const totalSettledShadow = (a2Shadow?.settled ?? 0) + (lShadow?.settled ?? 0);
  const totalShadowPnl = totalSettledShadow > 0
    ? (a2Shadow?.simulatedPnlCents ?? 0) + (lShadow?.simulatedPnlCents ?? 0)
    : null;

  return <div className="min-h-[100dvh] bg-background text-foreground">
    <div className="mx-auto max-w-7xl border-x border-border min-h-[100dvh]">
      <header className="border-b border-border p-4 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-primary text-primary-foreground grid place-items-center font-bold">420</div>
          <div><h1 className="font-semibold tracking-tight">ETH 420 Operator</h1><p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Read-only production observability</p></div>
        </div>
        <div className="flex items-center gap-3">
          <span className={cn('px-2 py-1 font-mono text-[10px] uppercase', runTone === 'good' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : runTone === 'warn' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-destructive/10 text-destructive')}>{runState}</span>
          <button type="button" onClick={() => { void refetchAll(); }} className="border border-border p-2 hover:bg-muted" title="Refresh account reads"><RefreshCw className="h-4 w-4" /></button>
        </div>
      </header>

      <main className="p-4 sm:p-6 space-y-6">
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Metric label="Kalshi equity" value={moneyFromCents(equityCents)} detail={`Cash ${moneyFromCents(cashCents)} + portfolio ${moneyFromCents(balance?.portfolio_value)}${balance?.stale ? ' · stale snapshot' : ''}`} />
          <Metric label="Today realized P&L" value={moneyFromCents(today?.netRealizedPnlCents, true)} detail={today ? `${today.settledOrderCount} settled · ${today.winningOrderCount} wins / ${today.losingOrderCount} losses` : 'Candidate daily ledger unavailable'} tone={(today?.netRealizedPnlCents ?? 0) > 0 ? 'good' : (today?.netRealizedPnlCents ?? 0) < 0 ? 'bad' : 'normal'} />
          <Metric label="Next normal wager" value={moneyFromCents(history?.operationalStatus.nextNormalWagerCents)} detail={history?.state ? `${history.state.side.toUpperCase()} · Step ${history.state.step}` : 'Candidate state unavailable'} />
          <Metric label="Lifecycle" value={String(history?.operationalStatus.unresolvedLifecycleCount ?? 'Unavailable')} detail={history?.operationalStatus.unresolvedLifecycleCount === 0 ? 'No unresolved candidate orders' : 'Unresolved candidate order(s) require reconciliation'} tone={(history?.operationalStatus.unresolvedLifecycleCount ?? 0) > 0 ? 'warn' : 'good'} />
        </section>

        <section className="border border-border bg-card">
          <div className="p-4 sm:p-5 border-b border-border flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Shadow service health</div>
              <h2 className="mt-1 font-semibold">A2 + L evaluator activity</h2>
              <p className="mt-1 text-xs text-muted-foreground">Evaluator decisions are separate from qualifying shadow intents. Fresh no-signal activity means the service is alive and monitoring.</p>
            </div>
            <div className="font-mono text-[10px] uppercase text-muted-foreground">{shadowFresh ? 'Fresh API response' : 'API unavailable / stale'}</div>
          </div>

          <div className="grid gap-px bg-border md:grid-cols-2">
            {[a2Health, lHealth].map((svc, index) => {
              const service = svc?.service ?? (index === 0 ? 'A2' : 'L');
              const statusLabel = svc?.status === 'healthy'
                ? (svc.latestDecision === 'no_signal' ? 'Healthy — monitoring' : 'Healthy')
                : svc?.status === 'stale' ? 'Stale'
                : svc?.status === 'unknown' ? 'Unknown — awaiting first evaluation'
                : 'Unavailable';
              const tone = svc?.status === 'healthy' ? 'text-emerald-600'
                : svc?.status === 'stale' ? 'text-amber-600'
                : 'text-muted-foreground';
              const evidence = svc?.latestEvidence ?? {};
              const evidenceText = service === 'A2'
                ? `Move ${typeof evidence.sourceMovePct === 'number' ? evidence.sourceMovePct.toFixed(3) + '%' : '—'} · threshold ${typeof evidence.dropThresholdPct === 'number' ? evidence.dropThresholdPct.toFixed(1) + '%' : '—'}`
                : `Sweep ${String(evidence.sweptPrevious24hLow ?? '—')} · wick ${String(evidence.wickCondition ?? '—')} · upper-half close ${String(evidence.upperHalfClose ?? '—')}`;
              return <div key={service} className="bg-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-mono text-[10px] uppercase text-muted-foreground">{service} evaluator</div>
                  <span className={cn('font-mono text-[10px] uppercase', tone)}>{statusLabel}</span>
                </div>
                <div className="mt-2 font-mono text-sm">{svc?.latestTicker ?? 'No persisted evaluation yet'}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {svc?.lastEvaluationAtMs ? `Last evaluation ${etClock(svc.lastEvaluationAtMs)} · ${svc.latestDecision?.replaceAll('_', ' ') ?? '—'}` : 'Awaiting first evaluator event'}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {svc?.evaluationIntervalMs ? `Cadence ${(svc.evaluationIntervalMs / 1000).toFixed(0)}s · stale after ${((svc.staleAfterMs ?? 0) / 1000).toFixed(0)}s` : 'Cadence unavailable'}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">{svc?.latestReason ? svc.latestReason.replaceAll('_', ' ') : 'No rejection reason'} · {evidenceText}</div>
                <div className="mt-3 grid grid-cols-5 gap-2 text-center">
                  <div><div className="font-mono text-sm">{svc?.evaluationsRecent ?? 0}</div><div className="text-[10px] uppercase text-muted-foreground">evals</div></div>
                  <div><div className="font-mono text-sm">{svc?.noSignalRecent ?? 0}</div><div className="text-[10px] uppercase text-muted-foreground">no signal</div></div>
                  <div><div className="font-mono text-sm">{svc?.qualifiedRecent ?? 0}</div><div className="text-[10px] uppercase text-muted-foreground">qualified</div></div>
                  <div><div className="font-mono text-sm">{svc?.wouldSubmitRecent ?? 0}</div><div className="text-[10px] uppercase text-muted-foreground">would submit</div></div>
                  <div><div className="font-mono text-sm">{svc?.errorRecent ?? 0}</div><div className="text-[10px] uppercase text-muted-foreground">errors</div></div>
                </div>
              </div>;
            })}
          </div>

          <div className="border-t border-border">
            <div className="p-4 font-semibold">Qualification funnel</div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] font-mono text-xs">
                <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3 text-left">Metric</th><th className="p-3 text-right">A2</th><th className="p-3 text-right">L</th></tr></thead>
                <tbody className="divide-y divide-border">
                  <tr><td className="p-3">Evaluations, recent window</td><td className="p-3 text-right">{a2Health?.evaluationsRecent ?? 0}</td><td className="p-3 text-right">{lHealth?.evaluationsRecent ?? 0}</td></tr>
                  <tr><td className="p-3">No-signal decisions</td><td className="p-3 text-right">{a2Health?.noSignalRecent ?? 0}</td><td className="p-3 text-right">{lHealth?.noSignalRecent ?? 0}</td></tr>
                  <tr><td className="p-3">Qualified signals</td><td className="p-3 text-right">{a2Health?.qualifiedRecent ?? 0}</td><td className="p-3 text-right">{lHealth?.qualifiedRecent ?? 0}</td></tr>
                  <tr><td className="p-3">Would-submit decisions</td><td className="p-3 text-right">{a2Health?.wouldSubmitRecent ?? 0}</td><td className="p-3 text-right">{lHealth?.wouldSubmitRecent ?? 0}</td></tr>
                  <tr><td className="p-3">Persisted shadow intents</td><td className="p-3 text-right">{a2Health?.shadowIntentsRecent ?? 0}</td><td className="p-3 text-right">{lHealth?.shadowIntentsRecent ?? 0}</td></tr>
                  <tr><td className="p-3">Settled shadow intents</td><td className="p-3 text-right">{a2Shadow?.settled ?? 0}</td><td className="p-3 text-right">{lShadow?.settled ?? 0}</td></tr>
                  <tr><td className="p-3">Simulated realized P&amp;L</td><td className="p-3 text-right">{(a2Shadow?.settled ?? 0) === 0 ? '—' : moneyFromCents(a2Shadow?.simulatedPnlCents, true)}</td><td className="p-3 text-right">{(lShadow?.settled ?? 0) === 0 ? '—' : moneyFromCents(lShadow?.simulatedPnlCents, true)}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="border-t border-border">
            <div className="p-4 flex items-center justify-between gap-3"><h3 className="font-semibold">Recent evaluator decisions</h3><span className="font-mono text-[10px] uppercase text-muted-foreground">{shadowEvaluations.length} loaded</span></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] font-mono text-xs">
                <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3 text-left">ET time</th><th className="p-3 text-left">Service</th><th className="p-3 text-left">Market</th><th className="p-3 text-left">Decision</th><th className="p-3 text-left">Reason</th><th className="p-3 text-left">Would submit</th><th className="p-3 text-left">Evidence</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {shadowEvaluations.slice(0, 30).map((row) => {
                    const evidence = row.evidence ?? {};
                    const evidenceText = row.service === 'A2'
                      ? `move ${typeof evidence.sourceMovePct === 'number' ? evidence.sourceMovePct.toFixed(3) + '%' : '—'} / threshold ${typeof evidence.dropThresholdPct === 'number' ? evidence.dropThresholdPct.toFixed(1) + '%' : '—'}`
                      : `sweep ${String(evidence.sweptPrevious24hLow ?? '—')} · wick ${String(evidence.wickCondition ?? '—')} · upper close ${String(evidence.upperHalfClose ?? '—')}`;
                    return <tr key={row.service + ':' + row.evaluatedAtMs + ':' + (row.ticker ?? '')}>
                      <td className="p-3 whitespace-nowrap">{row.evaluatedAtMs ? etClock(row.evaluatedAtMs) : '—'}</td>
                      <td className="p-3 font-semibold">{row.service}</td>
                      <td className="p-3 max-w-56 truncate" title={row.ticker ?? undefined}>{row.ticker ?? '—'}</td>
                      <td className="p-3 uppercase">{row.decision.replaceAll('_', ' ')}</td>
                      <td className="p-3">{row.primaryReason?.replaceAll('_', ' ') ?? '—'}</td>
                      <td className="p-3">{row.wouldSubmit ? 'YES' : 'NO'}</td>
                      <td className="p-3 text-muted-foreground">{evidenceText}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
              {shadowEvaluations.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No evaluator records available yet.</div>}
            </div>
          </div>

          <div className="border-t border-border">
            <div className="p-4 flex items-center justify-between gap-3">
              <h3 className="font-semibold">Shadow intents and settlement P&amp;L</h3>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">Combined P&amp;L {totalShadowPnl == null ? '—' : moneyFromCents(totalShadowPnl, true)}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[950px] font-mono text-xs">
                <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3 text-left">ET time</th><th className="p-3 text-left">Strategy</th><th className="p-3 text-left">Ticker</th><th className="p-3 text-right">Entry</th><th className="p-3 text-right">Contracts</th><th className="p-3 text-right">Principal</th><th className="p-3 text-left">State</th><th className="p-3 text-left">Result</th><th className="p-3 text-right">Sim P&amp;L</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {shadowRows.slice(0, 30).map((row) => <tr key={row.strategy + ':' + row.id}>
                    <td className="p-3 whitespace-nowrap">{row.createdAtMs ? etClock(row.createdAtMs) : '—'}</td>
                    <td className="p-3 font-semibold">{row.strategy}</td>
                    <td className="p-3 max-w-56 truncate" title={row.ticker}>{row.ticker || '—'}</td>
                    <td className="p-3 text-right">{row.entryPriceCents == null ? '—' : `${row.entryPriceCents}¢`}</td>
                    <td className="p-3 text-right">{row.contracts ?? '—'}</td>
                    <td className="p-3 text-right">{row.principalCents == null ? '—' : moneyFromCents(row.principalCents)}</td>
                    <td className="p-3 uppercase">{row.state.replaceAll('_', ' ')}</td>
                    <td className="p-3 uppercase">{row.settlementResult ?? row.terminalReason?.replaceAll('_', ' ') ?? 'Pending'}</td>
                    <td className={cn('p-3 text-right', (row.pnlCents ?? 0) > 0 && 'text-emerald-600', (row.pnlCents ?? 0) < 0 && 'text-destructive')}>{row.pnlCents == null ? 'Pending' : moneyFromCents(row.pnlCents, true)}</td>
                  </tr>)}
                </tbody>
              </table>
              {shadowRows.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No qualifying A2 or L shadow intents yet. Evaluator activity above can still be healthy.</div>}
            </div>
          </div>
        </section>
        <section className="border border-border bg-card">
          <div className="p-4 sm:p-5 border-b border-border flex flex-wrap justify-between gap-3">
            <div><div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Live market</div><h2 className="mt-1 font-semibold">ETH 15-minute operating context</h2></div>
            <div className="font-mono text-[10px] uppercase text-muted-foreground">Closes in {countdown(market?.market?.closeTime, now)}</div>
          </div>
          <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-4">
            <div className="bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Market</div><div className="mt-2 font-mono text-sm break-all">{market?.market?.ticker ?? 'Unavailable'}</div><div className="mt-1 text-xs text-muted-foreground">Exchange {market?.market?.exchangeIndex ?? '—'} · strike {evidence?.floorStrike ?? '—'}</div></div>
            <div className="bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Quotes</div><div className="mt-2 font-mono text-sm">YES {evidence ? `${evidence.yesBid}/${evidence.yesAsk}¢` : 'Unavailable'}</div><div className="mt-1 font-mono text-sm">NO&nbsp;&nbsp; {evidence ? `${evidence.noBid}/${evidence.noAsk}¢` : 'Unavailable'}</div></div>
            <div className="bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Jump signal</div><div className="mt-2 font-mono text-sm">Move {history?.operationalStatus.telemetry.currentMove == null ? '—' : `${(history.operationalStatus.telemetry.currentMove * 100).toFixed(4)}%`}</div><div className="mt-1 text-xs text-muted-foreground">p95 {history?.operationalStatus.telemetry.p95 == null ? '—' : `${(history.operationalStatus.telemetry.p95 * 100).toFixed(4)}%`} · p99 {history?.operationalStatus.telemetry.p99 == null ? '—' : `${(history.operationalStatus.telemetry.p99 * 100).toFixed(4)}%`}</div></div>
            <div className="bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Candidate position</div><div className="mt-2 font-mono text-sm">{livePosition ? `${livePosition.side.toUpperCase()} · Step ${livePosition.step}` : 'No live position'}</div><div className="mt-1 text-xs text-muted-foreground">{livePosition ? `${livePosition.filledContracts ?? 0}/${livePosition.requestedContracts} filled · ${livePosition.lifecycleStatus.replaceAll('_', ' ')}` : market?.candidatePosition.reason?.replaceAll('_', ' ') ?? 'Durable ledger clear'}</div></div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 border border-border bg-card">
            <div className="p-4 border-b border-border flex items-center justify-between"><div className="flex items-center gap-2"><Database className="h-4 w-4"/><h2 className="font-semibold">Recent candidate orders</h2></div><span className="font-mono text-[10px] uppercase text-muted-foreground">{orders.length} loaded</span></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[850px] font-mono text-xs">
                <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3 text-left">ET time</th><th className="p-3 text-left">Ticker</th><th className="p-3 text-left">Step</th><th className="p-3 text-left">Side</th><th className="p-3 text-right">Requested / filled</th><th className="p-3 text-right">Wager</th><th className="p-3 text-left">Status</th><th className="p-3 text-right">P&L</th></tr></thead>
                <tbody className="divide-y divide-border">{orders.slice(0, 40).map(order => <tr key={order.id}><td className="p-3 whitespace-nowrap">{etClock(order.createdAtMs)}</td><td className="p-3 max-w-52 truncate" title={order.ticker}>{order.ticker}</td><td className="p-3">{order.step}</td><td className="p-3 uppercase">{order.side}</td><td className="p-3 text-right">{order.requestedContracts} / {order.filledContracts ?? '—'}</td><td className="p-3 text-right">{moneyFromCents(order.effectiveWagerCents)}</td><td className="p-3 uppercase">{order.status.replaceAll('_', ' ')}{order.settlementResult ? ` · ${order.settlementResult}` : ''}</td><td className={cn('p-3 text-right', (order.realizedPnlDeltaCents ?? 0) > 0 && 'text-emerald-600', (order.realizedPnlDeltaCents ?? 0) < 0 && 'text-destructive')}>{order.realizedPnlDeltaCents == null ? 'Pending' : moneyFromCents(order.realizedPnlDeltaCents, true)}</td></tr>)}</tbody>
              </table>
              {orders.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No candidate orders available.</div>}
            </div>
          </div>

          <div className="space-y-4">
            <div className="border border-border bg-card p-4"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4"/><h3 className="font-semibold">Safety</h3></div><div className="mt-4 font-mono text-sm uppercase">{history?.operationalStatus.safetyState.status ?? 'Unavailable'}</div><div className="mt-1 text-xs text-muted-foreground">{history?.operationalStatus.safetyState.reason?.replaceAll('_', ' ') ?? 'No safety-state detail returned'}</div><div className="mt-4 font-mono text-[10px] uppercase text-muted-foreground">Prospective daily loss</div><div className="mt-1 font-mono text-sm uppercase">{history?.operationalStatus.prospectiveDailyLoss.status ?? 'Unavailable'}</div></div>
            <div className="border border-border bg-card p-4"><div className="flex items-center gap-2"><Activity className="h-4 w-4"/><h3 className="font-semibold">Latest order</h3></div>{latest ? <><div className="mt-4 font-mono text-sm break-all">{latest.ticker}</div><div className="mt-2 text-xs text-muted-foreground">{latest.side.toUpperCase()} · Step {latest.step} · {moneyFromCents(latest.effectiveWagerCents)} · {latest.status.replaceAll('_', ' ')}</div></> : <div className="mt-4 text-sm text-muted-foreground">Unavailable</div>}</div>
            <div className="border border-border bg-card p-4"><div className="flex items-center gap-2"><WalletCards className="h-4 w-4"/><h3 className="font-semibold">Open ETH account positions</h3></div><div className="mt-4 space-y-3">{accountEthPositions.length === 0 ? <div className="text-sm text-muted-foreground">None</div> : accountEthPositions.map(p => <div key={p.ticker} className="border border-border p-3"><div className="font-mono text-xs break-all">{p.ticker}</div><div className="mt-1 text-xs text-muted-foreground">{Number(p.position_fp) > 0 ? 'YES' : 'NO'} · {Math.abs(Number(p.position_fp)).toLocaleString()} contracts</div></div>)}</div></div>
          </div>
        </section>

        <section className="border border-border bg-card p-4 flex flex-wrap gap-x-8 gap-y-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2"><Clock3 className="h-3.5 w-3.5"/> Candidate ledger: {historyFresh ? 'fresh' : 'stale'}</span>
          <span>Market evidence: {marketFresh && market?.availability.status === 'fresh' ? 'fresh' : 'unavailable/stale'}</span>
          <span>Account reads: {isStale ? 'stale' : 'current'}</span>
          <span>Trade status: {status ? 'received' : 'unavailable'}</span>
          <span>A2/L shadow: {shadowFresh ? 'fresh' : 'unavailable/stale'}</span>
          {stateDay && <span>ET ledger day: {etDay(stateDay)}</span>}
          <span className="font-medium text-foreground">No submit, cancel, reset, reconcile, or configuration controls are present on this page.</span>
        </section>
      </main>
    </div>
  </div>;
}
