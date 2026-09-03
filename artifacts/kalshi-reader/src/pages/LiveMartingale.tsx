import { cn } from '@/lib/utils';
import { getTradeToken } from '@/lib/tradeToken';
import { type MartingaleBalance, type MartingaleLedgerOrder, type MartingalePosition, useMartingaleData } from '@/hooks/use-martingale-data';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { isMartingaleEntryExplicitlyPermitted } from '@/lib/martingaleStatus';
import { AlertCircle, Activity, CircleDollarSign, Check, X, ShieldAlert, BarChart3, Database, Clock3, WalletCards, RefreshCw } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

function formatSessionStart(startedAtMs: number | undefined): string {
  if (startedAtMs == null || !Number.isFinite(startedAtMs)) {
    return 'session start unavailable';
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(startedAtMs));
}

const TICKER_MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function formatEthWindow(ticker: string): string | null {
  const match = ticker.match(/^KXETH15M-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})-\d+$/);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const month = TICKER_MONTHS[monthText];
  if (month == null) return null;

  const closesAt = new Date(Date.UTC(
    2000 + Number(yearText),
    month,
    Number(dayText),
    Number(hourText),
    Number(minuteText),
  ));
  const opensAt = new Date(closesAt.getTime() - 15 * 60 * 1000);
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(closesAt);
  const clock = (value: Date) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(value);

  return `${dateLabel} · ${clock(opensAt)}–${clock(closesAt)} ET`;
}

function formatContracts(contracts: number): string {
  return contracts.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

interface Eth420CandidateData {
  executionApproved: boolean; liveEnabled: boolean; shadowEnabled: boolean;
  state: { easternDate: string; side: 'yes' | 'no'; step: number; realizedPnlCents: number } | null;
  orders: Array<{ id: string; ticker: string; side: 'yes' | 'no'; step: number; requestedContracts: number; effectiveWagerCents: number; filledContracts: number | null; realizedPnlDeltaCents: number | null; status: string; settlementResult: string | null; lastRecoveryOutcome?: string | null; actualNotionalDollars?: string | null; actualFeeDollars?: string | null; fillPriceCents?: number | null; createdAtMs: number }>;
  ordersAvailability: { available: boolean };
  finalizedReconciliation: {
    available: boolean;
    thresholdMs: number;
    alerts: Array<{
      ticker: string;
      latestRecoveryOutcome: string | null;
      finalizedAtMs: number;
      ageMs: number;
      nextSafeAction: 'await_automatic_reconciliation';
    }>;
  };
  dailyPnl: {
    available: boolean;
    rows: Array<{ easternDate: string; totalOrderCount: number; settledOrderCount: number; winningOrderCount: number; losingOrderCount: number; zeroPnlOrderCount: number; totalBetsCents: number; totalFeesCents: number; grossWinningsCents: number; grossLossesCents: number; netRealizedPnlCents: number }>;
  };
  operationalStatus: { nextNormalWagerCents: number | null; unresolvedLifecycleCount: number; safetyState: { status: string; reason: string }; telemetry: { validObservationCount: number; requiredObservationCount: number; currentMove: number | null; p95: number | null; p99: number | null; jumpReady: boolean; jumpFired: boolean | null }; prospectiveDailyLoss: { status: string; reason: string } };
}

export type Eth420CandidateLedgerFreshness = 'fresh' | 'stale';

function formatCandidatePnl(cents: number): string {
  return `${cents >= 0 ? '+' : '-'}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function getEth420OrderHistoryDisplayState(data: {
  ordersAvailability?: { available: boolean };
} | null): { kind: 'loading' | 'unavailable' | 'available'; detail: string } {
  if (data == null) return { kind: 'loading', detail: 'Loading candidate order history' };
  if (data.ordersAvailability?.available === false) {
    return { kind: 'unavailable', detail: 'Recent ETH 420 order history is temporarily unavailable.' };
  }
  return { kind: 'available', detail: '' };
}

function easternDateKey(timestampMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestampMs));
}

function easternClock(timestampMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestampMs));
}

function displayEasternDate(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${dateKey}T00:00:00Z`));
}

function formatDollars(cents: number | null | undefined): string {
  return cents == null || !Number.isFinite(cents) ? 'Unavailable' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatExchangeDollars(value: string | null | undefined): string {
  if (value == null) return 'Unavailable';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'Unavailable';
}

function formatCandidateLedgerDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAlertAge(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return minutes > 0 ? `${minutes}m ${totalSeconds % 60}s` : `${totalSeconds}s`;
}

function formatConfirmedCloseTime(value: string | null | undefined): string {
  if (value == null || !Number.isFinite(Date.parse(value))) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

export function Eth420DailyTransactionLog({
  data,
}: {
  data: Pick<Eth420CandidateData, 'orders' | 'ordersAvailability'>;
}) {
  const orderHistoryDisplay = getEth420OrderHistoryDisplayState(data);
  // Keep every record the refreshed history endpoint returns, newest first.
  // A display-only date boundary here would hide new candidate orders.
  const transactionOrders = [...data.orders].sort((left, right) => right.createdAtMs - left.createdAtMs);

  return <section className="p-4 sm:p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Read-only order ledger</p><h3 className="mt-1 text-lg font-semibold tracking-tight">Daily transaction log</h3><p className="mt-1 text-sm text-muted-foreground">Latest candidate orders from the existing history interface; refreshed automatically every 30 seconds.</p></div>
      <span className="font-mono text-[10px] uppercase text-muted-foreground">{transactionOrders.length} records shown</span>
    </div>
    <div className="mt-5 overflow-x-auto border border-border">
      {orderHistoryDisplay.kind === 'unavailable' ? <div className="p-6 text-center text-sm font-mono text-muted-foreground">{orderHistoryDisplay.detail}</div> : transactionOrders.length === 0 ? <div className="p-6 text-center text-sm font-mono text-muted-foreground">No candidate orders are currently available.</div> :
        <table className="w-full min-w-[900px] text-left font-mono text-xs"><thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3">ET day / time</th><th className="p-3">Ticker</th><th className="p-3">Step</th><th className="p-3">Side</th><th className="p-3 text-right">Requested / filled</th><th className="p-3 text-right">Wager</th><th className="p-3">Status</th><th className="p-3 text-right">Realized P&amp;L</th></tr></thead><tbody className="divide-y divide-border">{transactionOrders.map((order) => <tr key={order.id}><td className="p-3 whitespace-nowrap">{displayEasternDate(easternDateKey(order.createdAtMs))} · {easternClock(order.createdAtMs)}</td><td className="p-3 max-w-56 truncate" title={order.ticker}>{order.ticker}</td><td className="p-3">Step {order.step}</td><td className="p-3 uppercase">{order.side}</td><td className="p-3 text-right">{order.requestedContracts} / {order.filledContracts ?? '—'}</td><td className="p-3 text-right">${(order.effectiveWagerCents / 100).toFixed(2)}</td><td className="p-3 uppercase">{order.status.replaceAll('_', ' ')}{order.settlementResult ? ` · ${order.settlementResult}` : ''}</td><td className={cn('p-3 text-right font-medium', (order.realizedPnlDeltaCents ?? 0) > 0 ? 'text-emerald-600' : (order.realizedPnlDeltaCents ?? 0) < 0 ? 'text-destructive' : '')}>{order.realizedPnlDeltaCents == null ? 'Pending' : formatCandidatePnl(order.realizedPnlDeltaCents)}</td></tr>)}</tbody></table>}
    </div>
    <p className="mt-3 text-xs text-muted-foreground">This read-only table does not create, change, reconcile, or backfill records.</p>
  </section>;
}

export function Eth420BalanceSheet({
  data,
  balance,
  ledgerFreshness,
}: {
  data: Pick<Eth420CandidateData, 'state' | 'dailyPnl'>;
  balance: MartingaleBalance | undefined;
  ledgerFreshness: Eth420CandidateLedgerFreshness;
}) {
  const easternDate = data.state?.easternDate ?? null;
  const dailySummary = easternDate == null ? null : data.dailyPnl.rows.find((summary) => summary.easternDate === easternDate) ?? null;
  const cashCents = balance?.aggregate_balance_cents
    ?? (balance?.balance_dollars == null ? null : Math.round(Number(balance.balance_dollars) * 100));
  const portfolioCents = balance?.portfolio_value ?? null;
  const equityCents = cashCents == null || portfolioCents == null ? null : cashCents + portfolioCents;
  const hasCurrentLedger = easternDate != null && data.dailyPnl.available && ledgerFreshness === 'fresh';
  const currentDailySummary = hasCurrentLedger ? dailySummary : null;
  const currentState = hasCurrentLedger ? data.state : null;
  const candidatePnlCents = currentDailySummary?.netRealizedPnlCents ?? null;

  return <section className="p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Live candidate-ledger reconciliation</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight">ETH 420 balance sheet</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasCurrentLedger && easternDate
            ? `Current Eastern Time day: ${displayEasternDate(easternDate)}. Candidate-ledger totals refresh automatically every 30 seconds.`
            : ledgerFreshness === 'stale'
              ? 'The latest candidate-ledger refresh failed. Retained values below are stale and must not be used as the current balance sheet.'
              : 'Current candidate-ledger data is unavailable. Historical figures below are archival context, not a current balance sheet.'}
        </p>
      </div>
      <span className={cn(
        'px-2 py-1 font-mono text-[10px] uppercase',
        hasCurrentLedger ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}>{hasCurrentLedger && easternDate ? `Live · ${displayEasternDate(easternDate)}` : ledgerFreshness === 'stale' ? 'Retained ledger · stale' : 'Current ledger unavailable'}</span>
    </div>
    <div className="mt-5 grid gap-4 lg:grid-cols-3">
      <div className="border border-border p-4"><div className="text-[10px] font-mono uppercase text-muted-foreground">Live Kalshi equity</div><div className="mt-2 font-mono text-2xl font-semibold">{equityCents == null ? 'Unavailable' : formatCandidateLedgerDollars(equityCents)}</div><div className="mt-2 text-xs text-muted-foreground">Current cash {formatDollars(cashCents)} + open position value {formatDollars(portfolioCents)}{balance?.stale ? ' · exchange snapshot stale' : ''}</div></div>
      <div className="border border-border p-4"><div className="text-[10px] font-mono uppercase text-muted-foreground">{hasCurrentLedger && easternDate ? `${displayEasternDate(easternDate)} realized P&L` : 'Candidate-ledger realized P&L unavailable'}</div><div className={cn('mt-2 font-mono text-2xl font-semibold', candidatePnlCents == null ? 'text-muted-foreground' : candidatePnlCents > 0 ? 'text-emerald-600' : candidatePnlCents < 0 ? 'text-destructive' : '')}>{candidatePnlCents == null ? 'Unavailable' : formatCandidatePnl(candidatePnlCents)}</div><div className="mt-2 text-xs text-muted-foreground">{currentDailySummary ? `${currentDailySummary.settledOrderCount} settled candidate order${currentDailySummary.settledOrderCount === 1 ? '' : 's'} · Eastern Time day` : 'No current-day P&L is available without the complete candidate ledger'}</div></div>
      <div className="border border-border p-4"><div className="text-[10px] font-mono uppercase text-muted-foreground">Current candidate state</div><div className="mt-2 font-mono text-2xl font-semibold">{currentState ? `Step ${currentState.step}` : 'Unavailable'}</div><div className="mt-2 text-xs text-muted-foreground">{currentState ? `Next side ${currentState.side.toUpperCase()} · cumulative realized P&L ${formatCandidatePnl(currentState.realizedPnlCents)}` : 'Current candidate state is unavailable without the complete candidate ledger'}</div></div>
    </div>
    <div className="mt-5 grid gap-px border border-border bg-border lg:grid-cols-2">
      <div className="bg-card p-4"><h4 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{hasCurrentLedger ? 'Live data scope' : 'Candidate-ledger data unavailable'}</h4><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-6"><dt>Ledger day</dt><dd className="font-mono">{hasCurrentLedger && easternDate ? displayEasternDate(easternDate) : 'Unavailable'}</dd></div><div className="flex justify-between gap-6"><dt>Candidate orders</dt><dd className="font-mono">{currentDailySummary?.totalOrderCount ?? 'Unavailable'}</dd></div><div className="flex justify-between gap-6"><dt>Candidate fees</dt><dd className="font-mono">{currentDailySummary ? formatCandidateLedgerDollars(currentDailySummary.totalFeesCents) : 'Unavailable'}</dd></div><div className="flex justify-between gap-6 border-t border-border pt-2 font-medium"><dt>Current-day total wagered</dt><dd className="font-mono">{currentDailySummary ? formatCandidateLedgerDollars(currentDailySummary.totalBetsCents) : 'Unavailable'}</dd></div></dl></div>
      <div className="bg-card p-4"><h4 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Archival restoration context</h4><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-6"><dt>Aug. 9 fixed opening equity</dt><dd className="font-mono">$1,000.00</dd></div><div className="flex justify-between gap-6"><dt>Later Maynard net deposits</dt><dd className="font-mono">+$1,470.00</dd></div><div className="flex justify-between gap-6"><dt>Teal capital restored</dt><dd className="font-mono text-emerald-600">$500.00 · complete</dd></div><div className="flex justify-between gap-6 border-t border-border pt-2 font-medium"><dt>Maynard capital remaining</dt><dd className="font-mono">$1,644.7597</dd></div></dl></div>
    </div>
    <p className="mt-4 text-xs text-muted-foreground">The restoration context is a fixed historical convention: $1,785 reimbursable expenses, $2,000 Maynard capital, and $500 Teal capital. It is not used to calculate the live date, equity, or P&amp;L above and performs no account, trading, or database action.</p>
  </section>;
}

/** Read-only operational context. It deliberately has no order or allocation controls. */
function EthLiveMarketCard({
  balance,
  positions,
}: {
  balance: MartingaleBalance | undefined;
  positions: { market_positions?: MartingalePosition[]; stale?: boolean } | undefined;
}) {
  const [data, setData] = useState<Eth420LiveMarketData | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (inFlight.current) return;
      const controller = new AbortController();
      inFlight.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const token = await getTradeToken();
        const headers = token ? { 'X-Trade-Token': token } : undefined;
        const response = await fetch('/api/trade/analytics/eth420-live-market', {
          cache: 'no-store', headers, signal: controller.signal,
        });
        if (!active) return;
        setData(response.ok ? await response.json() as Eth420LiveMarketData : null);
      } catch {
        if (active) {
          setData(null);
        }
      } finally {
        window.clearTimeout(timeout);
        if (inFlight.current === controller) inFlight.current = null;
      }
    };
    void load();
    const refresh = window.setInterval(() => void load(), 10_000);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => { active = false; inFlight.current?.abort(); window.clearInterval(refresh); window.clearInterval(clock); };
  }, []);
  const market = data?.market;
  const evidenceDisplay = getEthMarketEvidenceDisplayState(data);
  const evidence = evidenceDisplay.evidence;
  const closeMs = market?.closeTime == null ? null : Date.parse(market.closeTime);
  const secondsRemaining = closeMs == null || !Number.isFinite(closeMs) ? null : Math.max(0, Math.ceil((closeMs - nowMs) / 1000));
  const countdown = secondsRemaining == null ? 'Unavailable' : `${Math.floor(secondsRemaining / 60)}m ${secondsRemaining % 60}s`;
  const aggregateCents = balance?.aggregate_balance_cents ?? (balance?.balance_dollars == null ? null : Math.round(Number(balance.balance_dollars) * 100));
  const position = data?.candidatePosition;
  const livePosition = position?.position;
  const positionDisplay = getEthPositionDisplayState(data);
  const accountEthPositions = positions?.market_positions?.filter((accountPosition) =>
    accountPosition.ticker.startsWith('KXETH15M-') && Number.isFinite(Number(accountPosition.position_fp))
      && Number(accountPosition.position_fp) !== 0,
  ) ?? [];
  return <section className="border border-border bg-card">
    <div className="p-4 sm:p-5 border-b border-border flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Live market</p><h2 className="mt-1 font-semibold tracking-tight">ETH 15-minute operating context</h2></div>
      <span className={cn('font-mono text-[10px] px-1.5 py-0.5', evidence ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>{evidence ? 'RUNNER QUOTE FRESH' : 'RUNNER QUOTE UNAVAILABLE'}</span>
    </div>
    <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-px bg-border">
      <div className="bg-card p-4 font-mono text-xs"><div className="text-[10px] text-muted-foreground uppercase">Current market</div><div className="mt-2 break-all font-medium text-foreground">{market?.ticker ?? 'Unavailable'}</div><div className="mt-1 text-muted-foreground">Closes in {countdown}</div><div className="mt-1 text-muted-foreground">Exchange {market?.exchangeIndex ?? '—'} · strike {evidence?.floorStrike ?? '—'}</div></div>
      <div className="bg-card p-4 font-mono text-xs"><div className="text-[10px] text-muted-foreground uppercase">Best quotes</div><div className="mt-2 text-foreground">YES {evidence ? `${evidence.yesBid} / ${evidence.yesAsk}¢` : 'Unavailable'}</div><div className="mt-1 text-foreground">NO&nbsp;&nbsp; {evidence ? `${evidence.noBid} / ${evidence.noAsk}¢` : 'Unavailable'}</div><div className="mt-1 text-muted-foreground">Adjacent move {evidenceDisplay.adjacentMove}</div></div>
      <div className="bg-card p-4 font-mono text-xs"><div className="text-[10px] text-muted-foreground uppercase">Account</div><div className="mt-2 text-foreground">Cash {formatDollars(aggregateCents)}{balance?.stale ? ' · stale' : ''}</div><div className="mt-1 text-foreground">Portfolio {formatDollars(balance?.portfolio_value)}</div><div className="mt-1 text-muted-foreground">ETH shard {balance?.active_eth_exchange_balance?.exchange_index ?? balance?.active_eth_exchange_index ?? '—'} · {formatDollars(balance?.active_eth_exchange_balance?.available_balance_cents)}</div></div>
      <div className="bg-card p-4 font-mono text-xs"><div className="text-[10px] text-muted-foreground uppercase">Live ETH position</div><div className="mt-2 text-foreground">{positionDisplay.kind === 'position' && livePosition ? `${livePosition.side.toUpperCase()} · Step ${livePosition.step}` : positionDisplay.detail}</div><div className="mt-1 text-muted-foreground">{positionDisplay.kind === 'position' && livePosition ? `${formatContracts(livePosition.filledContracts ?? 0)} filled · ${livePosition.lifecycleStatus.replaceAll('_', ' ')}` : 'Durable candidate ledger'}</div></div>
    </div>
    <details className="border-t border-border p-4 font-mono text-xs">
      <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-muted-foreground">Read-only account position details</summary>
      <div className="mt-3">
        {positions?.stale && <span className="text-[10px] uppercase text-amber-700 dark:text-amber-300">Stale exchange snapshot</span>}
        {positions == null ? <div className="mt-2 text-muted-foreground">Account position snapshot unavailable</div>
          : accountEthPositions.length === 0 ? <div className="mt-2 text-muted-foreground">No open account-held ETH 15-minute position</div>
            : <div className="mt-3 space-y-3">
            {accountEthPositions.map((accountPosition) => {
              const signedContracts = Number(accountPosition.position_fp);
              const heldSide = signedContracts > 0 ? 'YES' : 'NO';
              return <div key={`${accountPosition.ticker}:${accountPosition.position_fp}`} className="border border-border p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="break-all">{accountPosition.ticker}</span>
                  <span className={cn('px-1.5 py-0.5 text-[10px]', heldSide === 'YES' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-destructive/10 text-destructive')}>{heldSide}</span>
                  <span>{formatContracts(Math.abs(signedContracts))} contracts</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-3 mt-3 text-muted-foreground">
                  <div><div className="text-[10px] uppercase">Exchange exposure</div><div className="mt-1 text-foreground">{formatExchangeDollars(accountPosition.market_exposure_dollars)}</div></div>
                  <div><div className="text-[10px] uppercase">Exchange reported traded</div><div className="mt-1 text-foreground">{formatExchangeDollars(accountPosition.total_traded_dollars)}</div></div>
                  <div><div className="text-[10px] uppercase">Exchange reported fees</div><div className="mt-1 text-foreground">{formatExchangeDollars(accountPosition.fees_paid_dollars)}</div></div>
                  <div><div className="text-[10px] uppercase">Exchange realized P&L</div><div className="mt-1 text-foreground">{formatExchangeDollars(accountPosition.realized_pnl_dollars)}</div></div>
                  <div><div className="text-[10px] uppercase">Confirmed market close</div><div className="mt-1 text-foreground">{formatConfirmedCloseTime(accountPosition.close_time)}</div></div>
                </div>
              </div>;
            })}
            </div>}
      </div>
    </details>
    <details className="border-t border-border p-4 font-mono text-xs">
      <summary className="cursor-pointer text-[10px] text-muted-foreground uppercase">ETH 420 candidate order diagnostics</summary>
      <div className="mt-3">
        {positionDisplay.kind !== 'position' ? <div className="text-muted-foreground">{positionDisplay.detail}</div>
          : livePosition && <>
            <div>{livePosition.lifecycleStatus.replaceAll('_', ' ').toUpperCase()} · {livePosition.ticker} · {livePosition.side.toUpperCase()} · Step {livePosition.step} · {formatDollars(livePosition.intendedWagerCents)}</div>
            <div className="mt-1 text-muted-foreground">
              {livePosition.lifecycleStatus === 'submitted'
                ? 'Awaiting exchange reconciliation; no fill economics are confirmed yet.'
                : 'Candidate lifecycle is shown from the durable ETH 420 ledger.'}
            </div>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
              <div><div className="text-[10px] text-muted-foreground uppercase">Order ID</div><div className="mt-1 break-all">{livePosition.kalshiOrderId ?? 'Unavailable'}</div></div>
              <div><div className="text-[10px] text-muted-foreground uppercase">Requested contracts</div><div className="mt-1">{formatContracts(livePosition.requestedContracts)}</div></div>
              {livePosition.filledContracts != null && <div><div className="text-[10px] text-muted-foreground uppercase">Confirmed filled</div><div className="mt-1">{formatContracts(livePosition.filledContracts)}</div></div>}
              {livePosition.averageFillPriceCents != null && <div><div className="text-[10px] text-muted-foreground uppercase">Average fill price</div><div className="mt-1">{livePosition.averageFillPriceCents}¢</div></div>}
              {livePosition.principalCommittedDollars != null && <div><div className="text-[10px] text-muted-foreground uppercase">Confirmed principal</div><div className="mt-1">${livePosition.principalCommittedDollars}</div></div>}
              {livePosition.feesDollars != null && <div><div className="text-[10px] text-muted-foreground uppercase">Confirmed fees</div><div className="mt-1">${livePosition.feesDollars}</div></div>}
              {livePosition.realizedPnlDeltaCents != null && <div><div className="text-[10px] text-muted-foreground uppercase">Realized P&L</div><div className="mt-1">{formatCandidatePnl(livePosition.realizedPnlDeltaCents)}</div></div>}
              {livePosition.settlementResult != null && <div><div className="text-[10px] text-muted-foreground uppercase">Settlement</div><div className="mt-1">{livePosition.settlementResult.toUpperCase()}</div></div>}
            </div>
          </>}
      </div>
    </details>
  </section>;
}

export interface Eth420LiveMarketData {
  availability: { status: 'fresh' | 'stale' | 'unavailable'; reason: string | null; quoteAgeMs?: number | null };
  market: { ticker: string; exchangeIndex: number | null; openTime: string | null; closeTime: string | null; quoteUpdatedAtMs: number | null } | null;
  evidence: { yesBid: number; yesAsk: number; noBid: number; noAsk: number; yesSpreadCents: number; noSpreadCents: number; floorStrike: number; adjacentMove: number | null } | null;
  adjacentMoveAvailability: { status: 'fresh' | 'unavailable'; reason: string | null };
  candidatePosition: {
    availability: 'available' | 'unavailable'; reason: string | null;
    position: {
      ticker: string; side: 'yes' | 'no'; step: number; intendedWagerCents: number; kalshiOrderId: string | null; lifecycleStatus: string;
      requestedContracts: number; filledContracts: number | null; restingContracts: number | null; averageFillPriceCents: number | null;
      principalCommittedDollars: string | null; feesDollars: string | null; realizedPnlDeltaCents: number | null; settlementResult: 'yes' | 'no' | null;
    } | null;
  };
}

export function getEthMarketEvidenceDisplayState(data: Eth420LiveMarketData | null): {
  evidence: Eth420LiveMarketData['evidence'];
  adjacentMove: string;
} {
  const evidence = data?.availability.status === 'fresh' ? data.evidence : null;
  if (evidence?.adjacentMove != null) {
    return { evidence, adjacentMove: `${(evidence.adjacentMove * 100).toFixed(4)}%` };
  }
  const reason = data?.adjacentMoveAvailability?.reason?.replaceAll('_', ' ');
  return {
    evidence,
    adjacentMove: reason ? `Unavailable · ${reason}` : 'Unavailable',
  };
}

export function getEthPositionDisplayState(data: Eth420LiveMarketData | null): {
  kind: 'loading' | 'unavailable' | 'empty' | 'position'; detail: string;
} {
  if (data == null) return { kind: 'loading', detail: 'Waiting for the durable position ledger' };
  if (data.candidatePosition == null) {
    return { kind: 'unavailable', detail: 'Position unavailable · durable position data was not returned' };
  }
  if (data.candidatePosition.availability === 'unavailable') {
    return {
      kind: 'unavailable',
      detail: `Position unavailable · ${data.candidatePosition.reason?.replaceAll('_', ' ') ?? 'durable ledger unavailable'}`,
    };
  }
  return data.candidatePosition.position == null
    ? { kind: 'empty', detail: 'No live ETH position' }
    : { kind: 'position', detail: '' };
}

function formatLiveCountdown(target: string | null, nowMs: number): string {
  if (!target || !Number.isFinite(Date.parse(target))) return 'Unavailable';
  const seconds = Math.max(0, Math.ceil((Date.parse(target) - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Display-only: reads the standalone candidate ledger without trading controls. */
function Eth420CandidatePanel({
  balance,
  positions,
}: {
  balance: MartingaleBalance | undefined;
  positions: { market_positions?: MartingalePosition[]; stale?: boolean } | undefined;
}) {
  const [data, setData] = useState<Eth420CandidateData | null>(null);
  const [ledgerFreshness, setLedgerFreshness] = useState<Eth420CandidateLedgerFreshness>('stale');
  const [activeView, setActiveView] = useState<'overview' | 'balance-sheet' | 'transactions'>('overview');
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const token = await getTradeToken();
        const response = await fetch('/api/trade/analytics/eth420-candidate-history?limit=500', {
          cache: 'no-store', headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (!response.ok) {
          if (active) setLedgerFreshness('stale');
          return;
        }
        const nextData = await response.json() as Eth420CandidateData;
        if (active) {
          setData(nextData);
          setLedgerFreshness('fresh');
        }
      } catch {
        // Retain the last confirmed read for context, but never present it as current.
        if (active) setLedgerFreshness('stale');
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);
  const pnl = data?.state?.realizedPnlCents ?? 0;
  const orderHistoryDisplay = getEth420OrderHistoryDisplayState(data);
  const chronologicalOrders = data == null ? [] : [...data.orders].sort((left, right) => right.createdAtMs - left.createdAtMs);
  const latestOrder = chronologicalOrders[0] ?? null;
  const dailyPnl = data?.dailyPnl.rows ?? [];
  const transactionOrders = chronologicalOrders;
  const reconciliation = data?.finalizedReconciliation;
  return <section className="border border-border bg-card">
    <div className="p-4 sm:p-5 border-b border-border flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Active strategy</p><h2 className="mt-1 font-semibold tracking-tight">ETH 420 · six-step candidate</h2></div>
      <div className="flex flex-wrap gap-2">
      {data && <span className={cn('text-[10px] font-mono px-1.5 py-0.5', data.executionApproved && data.liveEnabled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>{data.executionApproved && data.liveEnabled ? 'LIVE ENABLED' : 'NOT ENABLED'}</span>}
      {data?.shadowEnabled && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-amber-500/10 text-amber-700">SHADOW ON</span>}
      </div>
    </div>
    {!data ? <div className="p-6 text-center text-sm font-mono text-muted-foreground">Loading independent candidate ledger…</div> : <>
      <div className="flex flex-wrap gap-1 border-b border-border bg-muted/20 p-2" role="tablist" aria-label="ETH 420 dashboard views">
        {[
          ['overview', 'Operations'],
          ['balance-sheet', 'Balance sheet'],
          ['transactions', 'Daily transaction log'],
        ].map(([view, label]) => <button
          key={view}
          type="button"
          role="tab"
          aria-selected={activeView === view}
          onClick={() => setActiveView(view as typeof activeView)}
          className={cn('px-3 py-2 text-[10px] font-mono uppercase tracking-wider transition-colors', activeView === view ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background hover:text-foreground')}
        >{label}</button>)}
      </div>
      {activeView === 'overview' && <>
      {!reconciliation?.available ? <div className="border-b border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200"><div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider"><AlertCircle className="h-4 w-4" /> Finalized-order reconciliation status unavailable</div><p className="mt-1 text-xs">Candidate history could not be read, so unresolved finalized orders cannot be confirmed. Trading remains fail-closed.</p></div>
        : reconciliation.alerts.length > 0 && <div className="border-b border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"><div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider"><ShieldAlert className="h-4 w-4" /> Finalized ETH 420 order still unreconciled</div>{reconciliation.alerts.map((alert) => <div key={alert.ticker} className="mt-2 border-l-2 border-destructive/60 pl-3 text-xs text-foreground"><div className="break-all font-mono font-medium">{alert.ticker}</div><div className="mt-1">Latest recovery outcome: <span className="font-mono">{alert.latestRecoveryOutcome?.replaceAll('_', ' ') ?? 'not yet recorded'}</span> · unresolved for {formatAlertAge(alert.ageMs)}</div><div className="mt-1 text-muted-foreground">Next safe action: wait for automatic reconciliation. Do not place, cancel, or settle this order manually.</div></div>)}</div>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border">
        {[['Current side', data.state?.side?.toUpperCase() ?? '—'], ['Ladder step', data.state ? `Step ${data.state.step}` : 'Unavailable'], ['Next wager', data.operationalStatus.nextNormalWagerCents == null ? 'Unavailable' : `$${(data.operationalStatus.nextNormalWagerCents / 100).toFixed(0)}`], ['Candidate P&L · ET', formatCandidatePnl(pnl)]].map(([label, value]) =>
          <div key={label} className="bg-card p-4"><div className="text-[10px] font-mono text-muted-foreground uppercase">{label}</div><div className={cn('mt-1 font-mono text-base font-medium', label === 'Candidate P&L · ET' && pnl > 0 ? 'text-emerald-600' : label === 'Candidate P&L · ET' && pnl < 0 ? 'text-destructive' : '')}>{value}</div></div>)}
      </div>
      <div className="border-y border-border bg-card p-4 text-xs font-mono">
        <div className="text-muted-foreground uppercase text-[10px]">Latest order & settlement</div>
        {orderHistoryDisplay.kind === 'unavailable' ? <div className="mt-1 text-muted-foreground">{orderHistoryDisplay.detail}</div> : latestOrder ? <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1"><span className="uppercase font-medium">{latestOrder.status.replaceAll('_', ' ')} · {latestOrder.side} · Step {latestOrder.step}</span><span className="text-muted-foreground">${(latestOrder.effectiveWagerCents / 100).toFixed(0)} · {latestOrder.filledContracts ?? '—'} filled · settlement {latestOrder.settlementResult?.toUpperCase() ?? 'pending'}</span></div> : <div className="mt-1 text-muted-foreground">No candidate order recorded</div>}
      </div>
      <EthLiveMarketCard balance={balance} positions={positions} />
      <section className="border-b border-border p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Daily P&L summary</p><h3 className="mt-1 font-medium">Realized ETH 420 candidate P&L by ET day</h3></div>
          <span className="font-mono text-[10px] text-muted-foreground">{dailyPnl.length} day{dailyPnl.length === 1 ? '' : 's'} in full ledger</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Read-only totals from the complete candidate ledger, grouped by its persisted Eastern Time day.</p>
        <div className="mt-4 overflow-x-auto border border-border">
          {!data.dailyPnl.available ? <div className="p-5 text-sm text-muted-foreground">Full-ledger Daily P&amp;L is temporarily unavailable.</div> : dailyPnl.length === 0 ? <div className="p-5 text-sm text-muted-foreground">No candidate order history is currently available.</div> :
            <table className="w-full min-w-[950px] text-left font-mono text-xs"><thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground"><tr><th className="p-3">ET day</th><th className="p-3 text-right">Orders</th><th className="p-3 text-right">Settled</th><th className="p-3 text-right">Won / lost / flat</th><th className="p-3 text-right">Total wagered</th><th className="p-3 text-right">Fees</th><th className="p-3 text-right">Gross winnings</th><th className="p-3 text-right">Gross losses</th><th className="p-3 text-right">Realized P&amp;L</th></tr></thead><tbody className="divide-y divide-border">{dailyPnl.map((summary) => <tr key={summary.easternDate}><td className="p-3">{displayEasternDate(summary.easternDate)}</td><td className="p-3 text-right">{summary.totalOrderCount}</td><td className="p-3 text-right">{summary.settledOrderCount}</td><td className="p-3 text-right">{summary.winningOrderCount} / {summary.losingOrderCount} / {summary.zeroPnlOrderCount}</td><td className="p-3 text-right">{formatDollars(summary.totalBetsCents)}</td><td className="p-3 text-right">{formatDollars(summary.totalFeesCents)}</td><td className="p-3 text-right text-emerald-600">{formatCandidatePnl(summary.grossWinningsCents)}</td><td className="p-3 text-right text-destructive">{formatCandidatePnl(summary.grossLossesCents)}</td><td className={cn('p-3 text-right font-medium', summary.netRealizedPnlCents > 0 ? 'text-emerald-600' : summary.netRealizedPnlCents < 0 ? 'text-destructive' : '')}>{formatCandidatePnl(summary.netRealizedPnlCents)}</td></tr>)}</tbody></table>}
        </div>
      </section>
      <details className="border-b border-border">
        <summary className="cursor-pointer p-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Admin / debug · candidate history and signal detail</summary>
        <div className="border-t border-border">
        <div className="grid md:grid-cols-2 gap-px bg-border text-xs font-mono">
          <div className="bg-card p-4"><div className="text-muted-foreground uppercase text-[10px]">Jump signal detail</div><div className="mt-1">Move {data.operationalStatus.telemetry.currentMove ?? '—'} · p95 {data.operationalStatus.telemetry.p95 ?? '—'} · p99 {data.operationalStatus.telemetry.p99 ?? '—'}</div><div className="mt-1 text-muted-foreground">Fires at ≥ p95 and &lt; p99; current result is persisted only after a decision.</div></div>
          <div className="bg-card p-4"><div className="text-muted-foreground uppercase text-[10px]">Safety reason</div><div className="mt-1 uppercase">{data.operationalStatus.safetyState.reason.replaceAll('_', ' ')}</div><div className="mt-1 text-muted-foreground">Prospective daily loss: {data.operationalStatus.prospectiveDailyLoss.status.replaceAll('_', ' ')}</div></div>
        </div>
      <div className="overflow-x-auto">
        {orderHistoryDisplay.kind === 'unavailable' ? <div className="p-6 text-center text-sm font-mono text-muted-foreground">{orderHistoryDisplay.detail}</div> : data.orders.length === 0 ? <div className="p-6 text-center text-sm font-mono text-muted-foreground">No ETH 420 candidate orders recorded yet.</div> :
          <table className="w-full text-left text-sm whitespace-nowrap"><thead className="bg-muted/5 font-mono text-[10px] text-muted-foreground uppercase border-y border-border"><tr><th className="p-3">Time</th><th className="p-3">Ticker</th><th className="p-3">Step / wager</th><th className="p-3">Side</th><th className="p-3">Contracts</th><th className="p-3">Order / recovery</th><th className="p-3">Settlement</th></tr></thead><tbody className="divide-y divide-border/50 font-mono text-xs">{data.orders.map((order) => <tr key={order.id}><td className="p-3">{new Date(order.createdAtMs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })}</td><td className="p-3 max-w-48 truncate">{order.ticker}</td><td className="p-3">Step {order.step} · ${(order.effectiveWagerCents / 100).toFixed(0)}</td><td className="p-3 uppercase">{order.side}</td><td className="p-3">{order.requestedContracts} requested · {order.filledContracts ?? '—'} filled</td><td className="p-3 uppercase">{order.status.replaceAll('_', ' ')}{order.lastRecoveryOutcome ? ` · ${order.lastRecoveryOutcome.replaceAll('_', ' ')}` : ''}</td><td className="p-3 uppercase">{order.settlementResult ?? '—'}</td></tr>)}</tbody></table>}
      </div>
        </div>
      </details>
      </>}
      {activeView === 'balance-sheet' && <Eth420BalanceSheet data={data} balance={balance} ledgerFreshness={ledgerFreshness} />}
      {activeView === 'transactions' && <Eth420DailyTransactionLog data={data} />}
    </>}
  </section>;
}

export default function LiveMartingale() {
  const { 
    balance, 
    status, 
    positions, 
    ledger,
    isLoading, 
    isError, 
    isLedgerLoading,
    isLedgerError,
    isStale,
    ledgerError,
    refetchAll,
  } = useMartingaleData();

  if (isLedgerError && !ledger) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center p-8 text-center">
        <AlertCircle className="w-8 h-8 mb-4" />
        <h1 className="font-mono text-sm tracking-widest uppercase text-destructive">3-Step Martingale ledger unavailable</h1>
        <p className="max-w-md mt-3 text-sm text-muted-foreground">
          The live 3-step martingale ledger could not be reached. Trading remains protected while storage recovers.
        </p>
        <p className="mt-2 text-xs font-mono text-muted-foreground">
          {ledgerError instanceof Error ? ledgerError.message : 'Check your connection and try again.'}
        </p>
        <button
          type="button"
          onClick={() => { void refetchAll(); }}
          className="mt-6 inline-flex items-center gap-2 border border-border bg-card px-4 py-2 text-xs font-mono uppercase tracking-wider text-foreground transition-colors hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry connection
        </button>
      </div>
    );
  }

  if (isLedgerLoading && !ledger) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center p-8 text-muted-foreground gap-4">
        <LoadingSpinner />
        <span className="font-mono text-sm tracking-widest uppercase">Initializing terminal...</span>
      </div>
    );
  }

  if (isError && !ledger) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center p-8 text-center">
        <AlertCircle className="w-8 h-8 mb-4" />
        <h1 className="font-mono text-sm tracking-widest uppercase text-destructive">3-Step Martingale ledger unavailable</h1>
        <p className="max-w-md mt-3 text-sm text-muted-foreground">
          The live 3-step martingale ledger could not be reached. Trading remains protected while storage recovers.
        </p>
        <p className="mt-2 text-xs font-mono text-muted-foreground">
          {ledgerError instanceof Error ? ledgerError.message : 'Check your connection and try again.'}
        </p>
        <button
          type="button"
          onClick={() => { void refetchAll(); }}
          className="mt-6 inline-flex items-center gap-2 border border-border bg-card px-4 py-2 text-xs font-mono uppercase tracking-wider text-foreground transition-colors hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry connection
        </button>
      </div>
    );
  }

  const balDollars = balance?.aggregate_balance_cents != null
    ? balance.aggregate_balance_cents / 100
    : parseFloat(balance?.balance_dollars || '0');
  const portValue = (balance?.portfolio_value || 0) / 100;
  const activeEthExchangeBalance = balance?.active_eth_exchange_balance;
  const ethExchangeIndex = activeEthExchangeBalance?.exchange_index
    ?? balance?.active_eth_exchange_index
    ?? status?.eth_martingale_blocker?.exchangeIndex;
  const ethExchangeBalance = activeEthExchangeBalance?.available_balance_cents != null
    ? activeEthExchangeBalance.available_balance_cents / 100
    : status?.eth_martingale_blocker?.availableBalanceCents != null
      ? status.eth_martingale_blocker.availableBalanceCents / 100
      : null;
  
  // Do not display an active trading state until the authenticated status
  // response has explicitly confirmed that the new-entry gate is open. A
  // missing/slow status read must be visible as verification in progress, not
  // as permission to trade.
  const statusVerified = status != null;
  const isEntryPermitted = isMartingaleEntryExplicitlyPermitted(status);
  const isHalted = statusVerified && !isEntryPermitted;
  const headerStatus = !statusVerified
    ? 'VERIFYING STATUS'
    : isHalted
      ? 'HALTED'
      : isStale
        ? 'STALE DATA'
        : 'ACTIVE';
  const orders = ledger?.orders ?? [];
  const currentStreak = ledger?.session.streak ?? 0;
  const streakType = ledger?.session.streak_type ?? 'none';
  const realizedPnl = ledger?.state.realized_pnl_dollars ?? 0;
  const sessionProfit = ledger?.session_profit;
  const sessionRealizedPnl = sessionProfit?.realized_pnl_dollars ?? null;
  const dailyInvested = ledger?.session.actual_notional_dollars ?? null;
  const dailyInvestmentVerified = ledger?.session.fill_economics_verified ?? false;
  const openMartingalePosition = ledger?.open_position ?? null;
  const openMartingaleWindow = openMartingalePosition == null
    ? null
    : formatEthWindow(openMartingalePosition.ticker);
  const manualRecovery = ledger?.manual_recovery ?? null;
  const manualRecoveryTickers = ledger?.manual_recovery_tickers ?? null;
  const manualRecoveryTickerSet = new Set([
    ...(manualRecoveryTickers ?? []),
    ...(manualRecovery == null ? [] : [manualRecovery.ticker]),
  ]);
  const activeMartingaleTicker = openMartingalePosition?.ticker ?? null;
  const noFillVerification = status?.eth_martingale_blocker?.code === 'zero_fill_verification_pending'
    ? status.eth_martingale_blocker
    : null;

  const openPositions = positions?.market_positions?.filter((p: any) => 
    Number(p.position_fp) !== 0
  ) || [];

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col max-w-7xl mx-auto border-l border-r border-border">
      {/* HEADER / STATUS BAR */}
      <header className="border-b border-border p-4 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm">
            420
          </div>
          <div>
           <h1 className="font-sans font-bold tracking-tight leading-none">ETH 420 Operations</h1>
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground mt-1">
               <span className={cn(
                 "inline-block w-2 h-2 rounded-full",
                 !statusVerified || isStale ? "bg-amber-500" : isHalted ? "bg-destructive" : "bg-emerald-500",
               )}></span>
               ETH 420 operational status
              {status?.environment_lock && <span className="text-amber-500 border border-amber-500/30 px-1 ml-1 bg-amber-500/10">LOCKED</span>}
            </div>
          </div>
        </div>
        
        <div className="sm:text-right font-mono text-xs text-muted-foreground">
          Read-only candidate state · no manual trading controls
        </div>
      </header>

       {/* MAIN DASHBOARD */}
      <main className="flex-1 p-4 sm:p-6 flex flex-col gap-6">
        <Eth420CandidatePanel balance={balance} positions={positions} />
          <details className="border border-border bg-card">
            <summary className="cursor-pointer p-4 font-mono text-xs uppercase tracking-widest text-muted-foreground">Admin / debug · legacy ETH 3-step material</summary>
           <div className="p-4 pt-0 flex flex-col gap-6">
        {/* TOP METRICS ROW */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
          
          {/* SESSION PROFIT */}
          <div className="border border-border p-5 relative overflow-hidden bg-card flex flex-col justify-between">
            <div>
               <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-4">ETH 3-Step Martingale realized session profit</div>
              
              <div className="flex items-end justify-between mb-2">
                 <span className={cn(
                   "font-mono text-xl sm:text-3xl font-medium",
                   sessionRealizedPnl == null ? "text-muted-foreground" : sessionRealizedPnl >= 0 ? "text-emerald-600" : "text-destructive",
                 )}>
                   {sessionRealizedPnl == null
                     ? "VERIFYING"
                     : `${sessionRealizedPnl >= 0 ? "+" : "-"}$${Math.abs(sessionRealizedPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                </span>
              </div>
              
              <div className="h-1.5 w-full bg-muted mt-4">
              </div>
            </div>
              <div className="text-xs text-muted-foreground mt-4 font-mono">
                 Since {formatSessionStart(sessionProfit?.started_at_ms)} · {sessionProfit?.settled_order_count ?? 0} settled orders
                {sessionProfit?.fill_economics_verified === false && " · exchange fees verifying"}
            </div>
          </div>

          {/* DAILY INVESTED */}
          <div className="border border-border p-5 relative overflow-hidden bg-card flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
                <WalletCards className="w-3.5 h-3.5" /> ETH 3-Step Martingale invested today
              </div>
              <div className="font-mono text-xl sm:text-3xl font-medium">
                {dailyInvestmentVerified && dailyInvested != null
                  ? `$${dailyInvested.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'VERIFYING'}
              </div>
            </div>
            <div className="text-xs text-muted-foreground mt-4 font-mono">
              {ledger?.eastern_date ?? 'Current ET day'} · actual filled notional only
            </div>
          </div>

          {/* ACTIVE ETH WINDOW */}
          <div className="border border-border p-5 relative overflow-hidden bg-card flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
                <Clock3 className="w-3.5 h-3.5" /> ETH 3-Step Martingale open position
              </div>
              {openMartingalePosition == null ? (
                <div className="font-mono text-base sm:text-lg font-medium text-muted-foreground">NO ACTIVE WINDOW</div>
              ) : (
                <>
                  <div className="font-mono text-base sm:text-lg font-medium">
                    {openMartingaleWindow ?? openMartingalePosition.ticker}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 uppercase tracking-wider",
                      openMartingalePosition.side === 'yes' ? "text-emerald-600 bg-emerald-500/10" : "text-destructive bg-destructive/10",
                    )}>
                      {openMartingalePosition.side}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatContracts(openMartingalePosition.filled_contracts)} filled / {formatContracts(openMartingalePosition.remaining_contracts)} remaining
                    </span>
                  </div>
                </>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-4 font-mono truncate" title={openMartingalePosition?.ticker}>
              {openMartingalePosition == null
                ? 'No unsettled ETH 3-step martingale fill'
                : openMartingalePosition.ticker}
            </div>
          </div>

          {/* STREAK */}
          <div className="border border-border p-5 relative bg-card flex flex-col justify-between">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-4">ETH 3-Step Martingale current streak</div>
            
            <div className="flex items-baseline gap-3 mb-2">
              <span className={cn("font-mono text-5xl font-bold leading-none", 
                streakType === 'win' ? "text-emerald-600" : streakType === 'loss' ? "text-destructive" : "text-muted-foreground"
              )}>
                {currentStreak}
              </span>
              <span className="font-mono text-lg text-muted-foreground uppercase tracking-widest">
                {streakType === 'win' ? 'WINS' : streakType === 'loss' ? 'LOSSES' : 'FLAT'}
              </span>
            </div>
            
            <div className="text-xs text-muted-foreground mt-auto pt-4 border-t border-border/50 font-mono">
                {ledger?.eastern_date ?? 'Current ET day'} · {ledger?.session.wins ?? 0} wins / {ledger?.session.losses ?? 0} losses
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* OPEN POSITIONS */}
          <div className="lg:col-span-1 border border-border bg-card flex flex-col">
            <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
                <h2 className="font-mono text-xs uppercase tracking-widest font-semibold flex items-center gap-2">
                 <Database className="w-3.5 h-3.5" /> Account-wide open positions
              </h2>
              <span className="bg-primary text-primary-foreground text-[10px] font-mono px-2 py-0.5">{openPositions.length}</span>
            </div>
            
            <div className="flex-1 overflow-auto max-h-[400px]">
              {openPositions.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground font-mono">
                   No account-wide active exposures.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {openPositions.map((pos: any, idx: number) => {
                    const contracts = Number(pos.position_fp);
                    const isYes = contracts > 0;
                     const isManualRecoveryResidual = manualRecoveryTickerSet.has(pos.ticker);
                     const isCurrentMartingalePosition = pos.ticker === activeMartingaleTicker;
                    return (
                      <li key={idx} className="p-4 flex flex-col gap-2">
                        <div className="flex justify-between items-start">
                          <span className="font-mono text-sm font-bold truncate pr-4" title={pos.ticker}>{pos.ticker}</span>
                          <span className={cn("text-[10px] font-mono px-1.5 py-0.5 uppercase tracking-wider shrink-0", 
                            isYes ? "bg-emerald-500/10 text-emerald-700 border border-emerald-500/20" : "bg-destructive/10 text-destructive border border-destructive/20"
                          )}>
                            {isYes ? 'YES' : 'NO'}
                          </span>
                        </div>
                         <div className={cn(
                           "text-[10px] font-mono uppercase tracking-wider",
                           isManualRecoveryResidual ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
                         )}>
                           {isManualRecoveryResidual
                             ? 'Manual-release residual — exchange position remains'
                             : isCurrentMartingalePosition
                              ? 'Current 3-step martingale exchange exposure'
                               : manualRecoveryTickers == null
                                 ? 'Recovery-audit classification unavailable'
                                : 'Exchange position outside current 3-step martingale window'}
                         </div>
                        <div className="flex justify-between items-end mt-2">
                          <div>
                            <div className="text-[10px] text-muted-foreground font-mono uppercase">Contracts</div>
                            <div className="font-mono font-medium">{Math.abs(contracts)}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-muted-foreground font-mono uppercase">Exposure</div>
                            <div className="font-mono font-medium">${Number(pos.market_exposure_dollars || 0).toFixed(2)}</div>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* WINDOW LOG */}
          <div className="lg:col-span-2 border border-border bg-card flex flex-col">
            <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
              <h2 className="font-mono text-xs uppercase tracking-widest font-semibold flex items-center gap-2">
                <BarChart3 className="w-3.5 h-3.5" /> ETH 3-Step Martingale recent windows
              </h2>
                <span className="text-[10px] font-mono text-muted-foreground">ETH 3-step ledger-backed · ${realizedPnl.toFixed(2)} realized</span>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-muted/5 font-mono text-[10px] text-muted-foreground uppercase border-b border-border">
                  <tr>
                    <th className="p-4 font-medium">Ticker</th>
                    <th className="p-4 font-medium">Side</th>
                    <th className="p-4 font-medium text-right">Spent</th>
                    <th className="p-4 font-medium text-right">Contracts</th>
                    <th className="p-4 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50 font-mono text-sm">
                   {orders.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-muted-foreground">
                        No window data available.
                      </td>
                    </tr>
                  ) : (
                     orders.map((w: MartingaleLedgerOrder) => {
                       const isManualRecovery = w.settlementResult === 'manual_yes' || w.settlementResult === 'manual_no';
                        const isZeroFill = w.filledContracts === 0;
                        const isVerifiedNoFillHandoff = w.outcome === 'zero_fill_verified';
                        const isThisNoFillVerification = noFillVerification?.ticker === w.ticker;
                       const outcome = !isManualRecovery && !isZeroFill && w.settlementResult
                         ? (w.settlementResult === w.side ? 'win' : 'loss')
                         : null;
                      const isWin = outcome === 'win';
                      const isLoss = outcome === 'loss';
                       const resultLabel = isManualRecovery
                         ? `MANUAL OVERRIDE · ${w.settlementResult === 'manual_yes' ? 'YES' : 'NO'} · NOT P&L`
                          : isVerifiedNoFillHandoff
                            ? 'NO FILL · VERIFIED HANDOFF'
                            : isZeroFill
                           ? w.settlementResult
                             ? `NO FILL · RESULT ${w.settlementResult.toUpperCase()}`
                              : isThisNoFillVerification
                                ? noFillVerification.retryScheduled
                                  ? 'NO FILL · RETRYING'
                                  : 'NO FILL · NEEDS ATTENTION'
                                : 'NO FILL · VERIFYING'
                           : w.settlementResult || w.outcome || 'PENDING';
                      
                      return (
                         <tr key={w.id} className="hover:bg-muted/10 transition-colors">
                          <td className="p-4">
                            <div className="truncate max-w-[200px]" title={w.ticker}>{w.ticker}</div>
                             {w.martingaleStep > 0 && (
                               <div className="text-[10px] text-muted-foreground mt-0.5">Step {w.martingaleStep + 1}</div>
                            )}
                          </td>
                          <td className="p-4">
                            {w.side ? (
                              <span className={cn("text-[10px] px-1.5 py-0.5 uppercase tracking-wider",
                                w.side.toLowerCase() === 'yes' ? "text-emerald-600 bg-emerald-500/10" : "text-destructive bg-destructive/10"
                              )}>
                                {w.side}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                          <td className="p-4 text-right">
                             {isZeroFill
                               ? '—'
                               : w.actualNotionalDollars != null
                                 ? `$${w.actualNotionalDollars.toFixed(2)}`
                                 : 'FILL CHECKING'}
                          </td>
                          <td className="p-4 text-right">
                              {w.filledContracts == null ? '—' : formatContracts(w.filledContracts)}
                          </td>
                          <td className="p-4">
                            <div className="flex items-center gap-2">
                              {isWin && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                              {isLoss && <X className="w-3.5 h-3.5 text-destructive" />}
                               {isManualRecovery && <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />}
                              <span className={cn(
                                "text-xs",
                                isWin ? "text-emerald-600 font-medium" : 
                                isLoss ? "text-destructive font-medium" : 
                                 isManualRecovery ? "text-amber-700 dark:text-amber-300 font-medium" :
                                "text-muted-foreground"
                              )}>
                                  {resultLabel}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
           </div>
         </details>
      </main>
    </div>
  );
}
