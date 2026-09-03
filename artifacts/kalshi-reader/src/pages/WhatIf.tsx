import { useState } from 'react';
import { Layout } from '@/components/Layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FlaskConical, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WhatIfBucket {
  band: string;
  fills: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlDollars: number | null;
  blockedFills: number;
  blockedWins: number;
  blockedLosses: number;
  blockedNetPnlDollars: number | null;
}

interface WhatIfBlockedTrade {
  ticker: string;
  timestampMs: number;
  side: 'yes' | 'no';
  triggerPriceCents: number;
  fillPriceCents: number | null;
  contracts: number;
  win: boolean | null;
  netPnlDollars: number | null;
  blockedBy: 'floor' | 'ceiling';
}

interface WhatIfReport {
  params: { floorCents: number; ceilingCents: number; period: string };
  summary: {
    totalFills: number;
    blockedFills: number;
    keptFills: number;
    actualNetPnlDollars: number;
    hypotheticalNetPnlDollars: number;
    pnlDeltaDollars: number;
    preventedLossDollars: number;
    forfeitedWinDollars: number;
    actualWinRate: number | null;
    hypotheticalWinRate: number | null;
  };
  byBucket: WhatIfBucket[];
  blockedTrades: WhatIfBlockedTrade[];
  pendingFills: number;
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function pnlColor(v: number | null | undefined): string {
  if (v == null || v === 0) return 'text-muted-foreground';
  return v > 0 ? 'text-green-500' : 'text-red-500';
}

export default function WhatIf() {
  const [floor, setFloor] = useState('75');
  const [ceiling, setCeiling] = useState('93');
  const [period, setPeriod] = useState('all-time');
  const [report, setReport] = useState<WhatIfReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const f = Number(floor);
    const c = Number(ceiling);
    if (!Number.isInteger(f) || !Number.isInteger(c) || f < 1 || f > 99 || c < 1 || c > 99 || c < f) {
      setError('Floor and ceiling must be whole numbers between 1 and 99, with ceiling ≥ floor.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/trade/analytics/reports/what-if?floor=${f}&ceiling=${c}&period=${period}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setReport((await res.json()) as WhatIfReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const s = report?.summary;

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FlaskConical className="h-6 w-6" />
            What-If Zone Simulator
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Replay a hypothetical trigger-price floor/ceiling against actual trade history.
            Read-only — this never changes live trading parameters.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Hypothetical zone</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground" htmlFor="whatif-floor">Floor (¢)</label>
                <Input
                  id="whatif-floor"
                  type="number"
                  min={1}
                  max={99}
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                  className="w-24"
                  data-testid="input-whatif-floor"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground" htmlFor="whatif-ceiling">Ceiling (¢)</label>
                <Input
                  id="whatif-ceiling"
                  type="number"
                  min={1}
                  max={99}
                  value={ceiling}
                  onChange={(e) => setCeiling(e.target.value)}
                  className="w-24"
                  data-testid="input-whatif-ceiling"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">History</label>
                <Select value={period} onValueChange={setPeriod}>
                  <SelectTrigger className="w-32" data-testid="select-whatif-period">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="7d">Last 7 days</SelectItem>
                    <SelectItem value="all-time">All time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={run} disabled={loading} data-testid="button-whatif-run">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Simulate'}
              </Button>
            </div>
            {error && <p className="text-sm text-red-500 mt-3" data-testid="text-whatif-error">{error}</p>}
          </CardContent>
        </Card>

        {report && s && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground uppercase">P&L delta</p>
                  <p className={cn('text-xl font-semibold tabular-nums', pnlColor(s.pnlDeltaDollars))} data-testid="text-whatif-delta">
                    {s.pnlDeltaDollars > 0 ? '+' : ''}{fmtUsd(s.pnlDeltaDollars)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {s.pnlDeltaDollars >= 0 ? 'change would have helped' : 'change would have cost you'}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground uppercase">Prevented losses</p>
                  <p className="text-xl font-semibold tabular-nums text-green-500">{fmtUsd(s.preventedLossDollars)}</p>
                  <p className="text-xs text-muted-foreground mt-1">losing trades blocked</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground uppercase">Forfeited wins</p>
                  <p className="text-xl font-semibold tabular-nums text-red-500">{fmtUsd(s.forfeitedWinDollars)}</p>
                  <p className="text-xs text-muted-foreground mt-1">winning trades blocked</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground uppercase">Blocked trades</p>
                  <p className="text-xl font-semibold tabular-nums">{s.blockedFills} / {s.totalFills}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    win rate {fmtPct(s.actualWinRate)} → {fmtPct(s.hypotheticalWinRate)}
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Actual {fmtUsd(s.actualNetPnlDollars)} → Hypothetical {fmtUsd(s.hypotheticalNetPnlDollars)} net P&L
                  {report.pendingFills > 0 && (
                    <span className="text-xs font-normal text-muted-foreground ml-2">
                      ({report.pendingFills} fills pending settlement, excluded)
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-whatif-buckets">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase text-muted-foreground">
                      <th className="text-left py-2 pr-4">Trigger band</th>
                      <th className="text-right py-2 px-3">Fills</th>
                      <th className="text-right py-2 px-3">W / L</th>
                      <th className="text-right py-2 px-3">Win rate</th>
                      <th className="text-right py-2 px-3">Net P&L</th>
                      <th className="text-right py-2 px-3">Blocked</th>
                      <th className="text-right py-2 pl-3">Blocked P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byBucket.map((b) => (
                      <tr key={b.band} className="border-b border-border/50">
                        <td className="py-2 pr-4 font-mono">{b.band}¢</td>
                        <td className="text-right py-2 px-3 tabular-nums">{b.fills}</td>
                        <td className="text-right py-2 px-3 tabular-nums">{b.wins} / {b.losses}</td>
                        <td className="text-right py-2 px-3 tabular-nums">{fmtPct(b.winRate)}</td>
                        <td className={cn('text-right py-2 px-3 tabular-nums', pnlColor(b.netPnlDollars))}>{fmtUsd(b.netPnlDollars)}</td>
                        <td className="text-right py-2 px-3 tabular-nums">
                          {b.blockedFills > 0 ? `${b.blockedFills} (${b.blockedWins}W/${b.blockedLosses}L)` : '—'}
                        </td>
                        <td className={cn('text-right py-2 pl-3 tabular-nums', pnlColor(b.blockedNetPnlDollars))}>{fmtUsd(b.blockedNetPnlDollars)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Blocked trades ({report.blockedTrades.length})</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {report.blockedTrades.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No historical trades would have been blocked by this zone.</p>
                ) : (
                  <table className="w-full text-sm" data-testid="table-whatif-blocked">
                    <thead>
                      <tr className="border-b border-border text-xs uppercase text-muted-foreground">
                        <th className="text-left py-2 pr-4">Time</th>
                        <th className="text-left py-2 px-3">Ticker</th>
                        <th className="text-left py-2 px-3">Side</th>
                        <th className="text-right py-2 px-3">Trigger</th>
                        <th className="text-right py-2 px-3">Fill</th>
                        <th className="text-right py-2 px-3">Cts</th>
                        <th className="text-left py-2 px-3">Result</th>
                        <th className="text-right py-2 px-3">Net P&L</th>
                        <th className="text-left py-2 pl-3">Blocked by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.blockedTrades.map((t, i) => (
                        <tr key={`${t.ticker}-${t.timestampMs}-${i}`} className="border-b border-border/50">
                          <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                            {new Date(t.timestampMs).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </td>
                          <td className="py-2 px-3 font-mono text-xs">{t.ticker}</td>
                          <td className="py-2 px-3 uppercase">{t.side}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{t.triggerPriceCents}¢</td>
                          <td className="text-right py-2 px-3 tabular-nums">{t.fillPriceCents != null ? `${t.fillPriceCents}¢` : '—'}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{t.contracts}</td>
                          <td className="py-2 px-3">
                            {t.win == null ? '—' : (
                              <span className={t.win ? 'text-green-500' : 'text-red-500'}>{t.win ? 'WIN' : 'LOSS'}</span>
                            )}
                          </td>
                          <td className={cn('text-right py-2 px-3 tabular-nums', pnlColor(t.netPnlDollars))}>{fmtUsd(t.netPnlDollars)}</td>
                          <td className="py-2 pl-3 text-muted-foreground">{t.blockedBy}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </Layout>
  );
}
