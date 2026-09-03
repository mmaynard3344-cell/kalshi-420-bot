import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';

const ET = 'America/New_York';

type CandidateOrder = {
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  step: number;
  requestedContracts: number;
  filledContracts: number | null;
  status: string;
  createdAtMs: number;
};

type CandidateHistory = {
  orders: CandidateOrder[];
};

type BoundaryEvent = {
  ticker: string;
  openTimeMs: number;
  atMs: number;
  stage: string;
  reason: string | null;
};

type BoundaryTimeline = {
  ticker: string;
  openTimeMs: number;
  metadataState: string;
  events: BoundaryEvent[];
};

type BoundaryReport = {
  available: boolean;
  timelines: BoundaryTimeline[];
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'include' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function easternDate(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function etTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ms));
}

function offset(event: BoundaryEvent | undefined, openTimeMs: number): number | null {
  return event ? event.atMs - openTimeMs : null;
}

function formatOffset(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  return `${sign}${(abs / 1000).toFixed(3)}s`;
}

function timingLabel(reservationMs: number | null): { label: string; className: string } {
  if (reservationMs == null) return { label: 'NO RESERVATION EVIDENCE', className: 'text-muted-foreground' };
  if (reservationMs <= 1500) return { label: 'FAST', className: 'text-emerald-600' };
  if (reservationMs <= 5000) return { label: 'MODERATE', className: 'text-amber-600' };
  return { label: 'LATE', className: 'text-destructive' };
}

export default function Diagnostics() {
  const [history, setHistory] = useState<CandidateHistory | null>(null);
  const [boundary, setBoundary] = useState<BoundaryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const load = async () => {
    try {
      const [h, b] = await Promise.all([
        getJson<CandidateHistory>('/api/trade/analytics/eth420-candidate-history?limit=500'),
        getJson<BoundaryReport>('/api/trade/analytics/boundary-discovery?limit=100'),
      ]);
      setHistory(h);
      setBoundary(b);
      setError(null);
      setLastLoadedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diagnostics unavailable');
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => {
    const today = easternDate(Date.now());
    const orders = [...(history?.orders ?? [])]
      .filter((order) => easternDate(order.createdAtMs) === today)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    const timelineByTicker = new Map((boundary?.timelines ?? []).map((timeline) => [timeline.ticker, timeline]));

    return orders.map((order) => {
      const timeline = timelineByTicker.get(order.ticker);
      const events = timeline?.events ?? [];
      const probe = events.find((event) => event.stage === 'probe_started');
      const active = events.find((event) => event.stage === 'active_response');
      const usable = events.find((event) => event.stage === 'usable_metadata');
      const evaluation = events.find((event) => event.stage === 'evaluation_started');
      const reservation = events.find((event) => event.stage === 'reservation');
      const submission = events.find((event) => event.stage === 'exchange_submission');
      const openTimeMs = timeline?.openTimeMs ?? order.createdAtMs;
      const reservationMs = offset(reservation, openTimeMs);
      const submissionMs = offset(submission, openTimeMs);
      const filled = order.filledContracts ?? 0;
      return {
        order,
        openTimeMs,
        probeMs: offset(probe, openTimeMs),
        activeMs: offset(active, openTimeMs),
        usableMs: offset(usable, openTimeMs),
        evaluationMs: offset(evaluation, openTimeMs),
        reservationMs,
        submissionMs,
        timing: timingLabel(reservationMs),
        fillLabel: `${filled}/${order.requestedContracts}`,
        zeroFill: filled === 0,
        evidenceMissing: !timeline,
      };
    });
  }, [history, boundary]);

  const zeroFills = rows.filter((row) => row.zeroFill);
  const reservations = zeroFills.map((row) => row.reservationMs).filter((value): value is number => value != null);
  const fastZeroFills = reservations.filter((value) => value <= 1500).length;
  const lateZeroFills = reservations.filter((value) => value > 5000).length;
  const medianReservation = reservations.length
    ? [...reservations].sort((a, b) => a - b)[Math.floor(reservations.length / 2)]
    : null;

  return <div className="min-h-[100dvh] bg-background text-foreground">
    <div className="mx-auto max-w-7xl min-h-[100dvh] border-x border-border">
      <header className="border-b border-border p-4 sm:p-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Read-only production evidence</div>
          <h1 className="mt-1 text-xl font-semibold">ETH 420 Zero-Fill & Boundary Diagnostics</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/" className="border border-border px-3 py-2 text-xs hover:bg-muted">Operator</Link>
          <button type="button" onClick={() => void load()} className="border border-border px-3 py-2 text-xs hover:bg-muted">Refresh</button>
        </div>
      </header>

      <main className="p-4 sm:p-6 space-y-5">
        {error && <div className="border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="border border-border bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Today's attempts</div><div className="mt-2 font-mono text-2xl">{rows.length}</div></div>
          <div className="border border-border bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Zero fills</div><div className="mt-2 font-mono text-2xl">{zeroFills.length}</div></div>
          <div className="border border-border bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Median reservation</div><div className="mt-2 font-mono text-2xl">{formatOffset(medianReservation)}</div></div>
          <div className="border border-border bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Zero-fill timing split</div><div className="mt-2 font-mono text-sm">{fastZeroFills} fast · {lateZeroFills} late</div><div className="mt-1 text-xs text-muted-foreground">Fast ≤1.5s · Late &gt;5s</div></div>
        </section>

        <section className="border border-border bg-card">
          <div className="border-b border-border p-4 flex flex-wrap justify-between gap-2">
            <div><h2 className="font-semibold">Today's order timing</h2><p className="mt-1 text-xs text-muted-foreground">Offsets are measured from the exchange-provided market open time. This panel reads the existing append-only boundary audit ledger; it does not affect trading.</p></div>
            <div className="font-mono text-[10px] uppercase text-muted-foreground">{lastLoadedAt ? `Loaded ${etTime(lastLoadedAt)} ET` : 'Loading'}</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] font-mono text-xs">
              <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground">
                <tr><th className="p-3 text-left">Open ET</th><th className="p-3 text-left">Ticker</th><th className="p-3 text-left">Fill</th><th className="p-3 text-left">Timing</th><th className="p-3 text-right">Probe</th><th className="p-3 text-right">Active</th><th className="p-3 text-right">Usable</th><th className="p-3 text-right">Evaluate</th><th className="p-3 text-right">Reserve</th><th className="p-3 text-right">Submit</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => <tr key={row.order.id} className={row.zeroFill ? 'border-t border-border bg-amber-500/5' : 'border-t border-border'}>
                  <td className="p-3 whitespace-nowrap">{etTime(row.openTimeMs)}</td>
                  <td className="p-3 whitespace-nowrap">{row.order.ticker}</td>
                  <td className={row.zeroFill ? 'p-3 font-semibold text-amber-600' : 'p-3'}>{row.fillLabel}</td>
                  <td className={`p-3 font-semibold ${row.timing.className}`}>{row.evidenceMissing ? 'NO AUDIT' : row.timing.label}</td>
                  <td className="p-3 text-right">{formatOffset(row.probeMs)}</td>
                  <td className="p-3 text-right">{formatOffset(row.activeMs)}</td>
                  <td className="p-3 text-right">{formatOffset(row.usableMs)}</td>
                  <td className="p-3 text-right">{formatOffset(row.evaluationMs)}</td>
                  <td className="p-3 text-right font-semibold">{formatOffset(row.reservationMs)}</td>
                  <td className="p-3 text-right">{formatOffset(row.submissionMs)}</td>
                </tr>)}
                {rows.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">No ETH 420 candidate attempts found for today.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="border border-border bg-muted/20 p-4 text-sm">
          <div className="font-semibold">How to read this</div>
          <p className="mt-2 text-muted-foreground">A zero fill with a fast reservation/submission is evidence against discovery latency as the primary cause. A cluster of zero fills with reservations several seconds after open points back toward runtime discovery or lifecycle timing. This panel deliberately reports timing evidence rather than changing the 50¢ order policy.</p>
        </section>
      </main>
    </div>
  </div>;
}
