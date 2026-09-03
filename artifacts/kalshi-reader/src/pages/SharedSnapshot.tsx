import { useEffect, useState } from 'react';
import { Activity, BarChart3, Clock3, ShieldCheck, TrendingDown, TrendingUp, Wallet } from 'lucide-react';

interface AssetSummary {
  submissions: number;
  fills: number;
  zeroFills: number;
  winsCount: number;
  lossesCount: number;
  netPnlDollars: number | null;
  avgPnlDollars: number | null;
}

interface RecentTrade {
  timestampMs: number;
  asset: 'BTC' | 'ETH';
  outcome: 'win' | 'loss';
  netPnlDollars: number | null;
}

interface SharedSnapshotData {
  cutoffIso: string;
  generatedAt: string;
  accountDataStale?: boolean;
  balanceDollars: number | null;
  portfolioValueDollars: number | null;
  positions: {
    openCount: number | null;
    openExposureDollars: number | null;
  };
  combined: AssetSummary & {
    windowsObserved: number;
    windowsEnteringZone: number;
    zeroFills: number;
    fillRatePct: number | null;
    winRatePct: number | null;
  };
  btc: AssetSummary;
  eth: AssetSummary;
  recentTrades: RecentTrade[];
}

const REFRESH_MS = 60_000;

function signedDollar(value: number | null): string {
  if (value == null) return 'Pending';
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
}

function dollar(value: number | null): string {
  if (value == null) return '—';
  return `$${value.toFixed(2)}`;
}

function Metric({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'positive' | 'negative';
}) {
  const toneClass = tone === 'positive'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'negative'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-foreground';

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tracking-tight ${toneClass}`}>{value}</p>
      {detail && <p className="mt-2 text-sm text-muted-foreground">{detail}</p>}
    </div>
  );
}

function AssetCard({ label, data }: { label: string; data: AssetSummary }) {
  const pnlTone = data.netPnlDollars == null
    ? 'text-muted-foreground'
    : data.netPnlDollars >= 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-rose-600 dark:text-rose-400';

  const resolved = data.winsCount + data.lossesCount;
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">{label}</h2>
        <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Fills</p>
          <p className="mt-1 text-2xl font-semibold">{data.fills}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Net P&amp;L</p>
          <p className={`mt-1 text-2xl font-semibold ${pnlTone}`}>{signedDollar(data.netPnlDollars)}</p>
        </div>
        <div className="col-span-2 border-t border-border pt-4 text-sm text-muted-foreground">
          {resolved > 0 ? `${data.winsCount} wins · ${data.lossesCount} losses` : 'No settled results yet'}
        </div>
      </div>
    </section>
  );
}

export default function SharedSnapshot() {
  const [data, setData] = useState<SharedSnapshotData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const response = await fetch('/api/trade/public/snapshot', { cache: 'no-store' });
        if (!response.ok) throw new Error('Snapshot unavailable');
        const snapshot = await response.json() as SharedSnapshotData;
        if (active) {
          setData(snapshot);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const combined = data?.combined;
  const pnlTone = combined?.netPnlDollars == null
    ? 'default'
    : combined.netPnlDollars >= 0
      ? 'positive'
      : 'negative';

  return (
    <main className="min-h-[100dvh] bg-muted/30 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="rounded-2xl border border-border bg-card px-6 py-7 shadow-sm sm:px-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
                Shared Teal
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">Shared Teal trading summary</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                A read-only aggregate view since Aug 9, 2026, 11:00 AM ET. It refreshes automatically and does not include account access, trade controls, market details, or individual orders.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Read only
            </div>
          </div>
        </header>

        <figure className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <img
            src="/shared/shawshank-investments.png"
            alt="Shawshank Investments partners shaking hands by the waterfront"
            className="aspect-[2/1] w-full object-cover object-center"
          />
          <figcaption className="border-t border-border px-5 py-3 text-sm text-muted-foreground">
            Shawshank Investments · Investing in Tomorrow, Together.
          </figcaption>
        </figure>

        {error && !data && (
          <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
            The shared summary is temporarily unavailable. Please refresh in a moment.
          </div>
        )}

        {!data && !error && (
          <div className="mt-6 rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Loading shared summary…
          </div>
        )}

        {data && combined && (
          <>
            {data.accountDataStale && (
              <div className="mt-6 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                Account figures are temporarily showing the last known values while the exchange is busy. They will refresh automatically.
              </div>
            )}
            <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Portfolio value" value={dollar(data.portfolioValueDollars)} detail="Cash plus open positions" />
              <Metric label="Cash balance" value={dollar(data.balanceDollars)} detail="Available account balance" />
              <Metric
                label="Open positions"
                value={data.positions.openCount == null ? '—' : String(data.positions.openCount)}
                detail={`Open exposure ${dollar(data.positions.openExposureDollars)}`}
              />
              <Metric
                label="Average settled P&L"
                value={signedDollar(combined.avgPnlDollars)}
                detail="Per resolved filled trade"
                tone={combined.avgPnlDollars == null ? 'default' : combined.avgPnlDollars >= 0 ? 'positive' : 'negative'}
              />
            </section>

            <section className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Filled trades" value={String(combined.fills)} detail={`${combined.zeroFills} unfilled`} />
              <Metric label="Fill rate" value={combined.fillRatePct == null ? '—' : `${combined.fillRatePct}%`} detail="Across submitted attempts" />
              <Metric label="Settled win rate" value={combined.winRatePct == null ? 'Pending' : `${combined.winRatePct}%`} detail="Only resolved markets" />
              <Metric
                label="Net P&L"
                value={signedDollar(combined.netPnlDollars)}
                detail={combined.netPnlDollars == null ? 'Awaiting settlement' : 'Settled results only'}
                tone={pnlTone}
              />
            </section>

            <section className="mt-6 grid gap-4 md:grid-cols-2">
              <AssetCard label="Bitcoin" data={data.btc} />
              <AssetCard label="Ethereum" data={data.eth} />
            </section>

            <section className="mt-6 rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex gap-3">
                {combined.netPnlDollars != null && combined.netPnlDollars >= 0
                  ? <TrendingUp className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  : <TrendingDown className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <div>
                  <h2 className="font-medium text-foreground">Session activity</h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {combined.windowsObserved} market windows observed, with {combined.windowsEnteringZone} qualifying opportunities. Results are aggregated for privacy.
                  </p>
                </div>
              </div>
            </section>

            <section className="mt-6 rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Wallet className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                <h2 className="font-medium text-foreground">Recent settled outcomes</h2>
              </div>
              {data.recentTrades.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">No settled trades since the report baseline.</p>
              ) : (
                <div className="mt-4 divide-y divide-border">
                  {data.recentTrades.map((trade) => {
                    const positive = trade.outcome === 'win';
                    return (
                      <div key={`${trade.timestampMs}-${trade.asset}`} className="flex items-center justify-between gap-4 py-3 text-sm">
                        <div>
                          <p className="font-medium text-foreground">{trade.asset} · {positive ? 'Win' : 'Loss'}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {new Date(trade.timestampMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </p>
                        </div>
                        <p className={positive ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'font-semibold text-rose-600 dark:text-rose-400'}>
                          {signedDollar(trade.netPnlDollars)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <footer className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
              Since Aug 9, 2026, 11:00 AM ET · Last refreshed {new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </footer>
          </>
        )}
      </div>
    </main>
  );
}