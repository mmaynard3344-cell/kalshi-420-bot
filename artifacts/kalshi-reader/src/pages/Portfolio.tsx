import { useCallback, useEffect, useRef, useState } from 'react';
import { getTradeToken } from '@/lib/tradeToken';
import { checkSessionAndRecover } from '@/lib/sessionGuard';
import { createRefreshCoordinator } from '@/lib/refreshCoordinator';
import {
  computePnl,
  fillEffectiveSide,
  summarizePnlCoverage,
  type PortfolioPnlFill,
} from '@/lib/portfolioPnl';
import { useListMarkets } from '@workspace/api-client-react';
import { Layout } from '@/components/Layout';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { cn } from '@/lib/utils';
import { RefreshCw, CheckCircle2, Clock, XCircle, Wallet, TrendingUp, TrendingDown, Activity, ChevronDown, ChevronRight, Trash2, BarChart2, ListOrdered } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell, Legend,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WindowLogEntry {
  ticker:          string;
  series:          string;
  closeTime:       string | null;
  firstSeenMs:     number;
  entered:         boolean;
  inZone:          boolean;
  yesDerivedAsk:   number | null;
  noDerivedAsk:    number | null;
  outcome: 'pending' | 'out_of_zone' | 'skipped' | 'zero_fill' | 'zero_fill_retried' | 'traded';
  side:            'yes' | 'no' | null;
  priceCents:      number | null;
  contractsFilled: number | null;
  spentDollars:    number | null;
  skipReason:      string | null;
}

interface Balance {
  balance_dollars: string;
  portfolio_value: number;
}

interface PortfolioAvailability {
  balance: boolean;
  positions: boolean;
  orders: boolean;
  fills: boolean;
  windowLog: boolean;
}

interface PortfolioStaleness {
  balance: boolean;
  positions: boolean;
  orders: boolean;
  fills: boolean;
  windowLog: boolean;
}

/**
 * The API server serves last-known account data marked `stale: true` while
 * Kalshi is rate-limiting (HTTP 429) instead of failing the request. A
 * fulfilled response must therefore still be checked for staleness so cached
 * values are never presented as fresh.
 */
export function responseIndicatesStale(value: unknown): boolean {
  return Boolean((value as { stale?: boolean } | null | undefined)?.stale);
}

interface Order {
  order_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: string;
  status: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  initial_count_fp: string;
  fill_count_fp: string;
  remaining_count_fp: string;
  taker_fees_dollars: string;
  created_time: string;
}

interface Fill extends PortfolioPnlFill {
  fill_id: string;
  order_id?: string;
  ticker: string;
  side: 'yes' | 'no';
  yes_price_dollars: string;
  no_price_dollars: string;
  count_fp: string;
  fee_cost: string;
  is_taker: boolean;
  ts: number;
  created_time: string;
  market_result: string; // "yes" | "no" | "" (empty = pending)
}

interface Position {
  ticker: string;
  position_fp: string;
  total_traded_dollars: string;
  market_exposure_dollars: string;
  realized_pnl_dollars: string;
  fees_paid_dollars: string;
  last_updated_ts: string;
  // enriched
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  market_status?: string;
  market_result?: string;
  close_time?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDollars(s: string | number | null | undefined) {
  // Treat missing values as unavailable — never show $0.00 for a failed fetch.
  if (s === null || s === undefined) return '—';
  const n = typeof s === 'number' ? s : parseFloat(String(s));
  if (isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPnl(pnl: number) {
  const abs = Math.abs(pnl);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (pnl >= 0 ? '+$' : '-$') + formatted;
}

function fmtCount(fp: string | undefined) {
  if (!fp) return '—';
  return parseFloat(fp).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtTime(iso: string | undefined, ts?: number) {
  const d = iso ? new Date(iso) : ts ? new Date(ts * 1000) : null;
  if (!d) return '—';
  return d.toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    executed:  'bg-chart-3/15 text-chart-3',
    resting:   'bg-primary/15 text-primary',
    cancelled: 'bg-muted text-muted-foreground',
    canceled:  'bg-muted text-muted-foreground',
  };
  const Icon = status === 'executed' ? CheckCircle2 : status === 'resting' ? Clock : XCircle;
  return (
    <span className={cn('flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full capitalize', map[status] ?? 'bg-muted text-muted-foreground')}>
      <Icon className="h-3 w-3" />
      {status}
    </span>
  );
}

function sideBadge(side: 'yes' | 'no' | '?') {
  if (side === '?') {
    return (
      <span className="text-xs font-bold px-1.5 py-0.5 rounded uppercase bg-muted text-muted-foreground">
        ?
      </span>
    );
  }
  return (
    <span className={cn(
      'text-xs font-bold px-1.5 py-0.5 rounded uppercase',
      side === 'yes' ? 'bg-primary/15 text-primary' : 'bg-destructive/15 text-destructive',
    )}>
      {side}
    </span>
  );
}

/** Win / Loss / Pending badge based on market_result vs the side bought */
function resolvedBadge(side: 'yes' | 'no', marketResult: string) {
  if (!marketResult) {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
        <Clock className="h-3 w-3" />
        Pending
      </span>
    );
  }
  const won = side === marketResult;
  return (
    <span className={cn(
      'flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full',
      won ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'bg-destructive/15 text-destructive',
    )}>
      {won ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {won ? 'Win' : 'Loss'}
    </span>
  );
}

function shortTicker(ticker: string) {
  const parts = ticker.split('-');
  if (parts.length >= 3) return parts[0] + ' ' + parts[2];
  return ticker;
}

// ─── Series helpers ───────────────────────────────────────────────────────────

// Portfolio reporting scope: BTC/ETH fills recorded on or after August 1, 2026.
// Kept client-side because this page reads the exchange fills endpoint directly.
const PORTFOLIO_SCOPE_CUTOFF_MS = Date.UTC(2026, 7, 1);

function isPortfolioScopedFill(fill: Fill): boolean {
  const createdMs = Date.parse(fill.created_time ?? "");
  return (
    (fill.ticker.startsWith("KXBTC") || fill.ticker.startsWith("KXETH")) &&
    Number.isFinite(createdMs) &&
    createdMs >= PORTFOLIO_SCOPE_CUTOFF_MS
  );
}

/** Extract the series prefix from a ticker, e.g. KXBTC15M-20240101-B1234 → KXBTC15M */
function seriesPrefix(ticker: string): string {
  return ticker.split('-')[0] ?? ticker;
}

interface SeriesStats {
  series: string;
  totalPnl: number;
  wins: number;
  losses: number;
  resolvedCount: number;
  pendingCount: number;
  fillCount: number;
}

function computeSeriesStats(fills: Fill[]): SeriesStats[] {
  const map = new Map<string, SeriesStats>();
  for (const f of fills) {
    const s = seriesPrefix(f.ticker);
    if (!map.has(s)) {
      map.set(s, { series: s, totalPnl: 0, wins: 0, losses: 0, resolvedCount: 0, pendingCount: 0, fillCount: 0 });
    }
    const stat = map.get(s)!;
    stat.fillCount++;
    const pnl = computePnl(f);
    if (pnl !== null) {
      stat.totalPnl += pnl;
      stat.resolvedCount++;
      if (fillEffectiveSide(f) === f.market_result) stat.wins++;
      else stat.losses++;
    } else {
      stat.pendingCount++;
    }
  }
  // Sort by absolute P&L descending
  return Array.from(map.values()).sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
}

/** Shape returned by GET /api/trade/tiers */
interface PriceTier {
  label: string;
  min: number;
  max: number;
}
interface TierStat {
  tier: string; min: number; max: number;
  fillCount: number; wins: number; losses: number; resolvedCount: number;
  totalContracts: number; totalCost: number; totalPnl: number;
}

/** Row returned inside verifiedByTier from GET /api/trade/analytics/reports/pnl */
interface VerifiedByTierRow {
  tierLabel: string;
  minCents: number;
  maxCents: number;
  /** Authoritative SQL fill-ledger net P&L. Null if any settled fill lacks chunks. */
  realizedNetPnlDollars: number | null;
  settledFillCount: number;
  pendingVerificationCount: number;
  unverifiedFillCount: number;
}
interface VerifiedByTierPayload {
  byTier: VerifiedByTierRow[];
  combined: {
    realizedNetPnlDollars: number | null;
    settledFillCount: number;
    pendingVerificationCount: number;
    unverifiedFillCount: number;
  };
}

function computeTierStats(fills: Fill[], tiers: PriceTier[]): TierStat[] {
  return tiers.map(({ label: tier, min, max }) => {
    const s: TierStat = { tier, min, max, fillCount: 0, wins: 0, losses: 0, resolvedCount: 0, totalContracts: 0, totalCost: 0, totalPnl: 0 };
    for (const f of fills) {
      const yesCents = Math.round(parseFloat(f.yes_price_dollars) * 100);
      // Infer outcome-side price: NO buys have yes_price < 50¢, so their
      // effective outcome price is the NO price = (100 − yes_price).
      const effectiveSide = fillEffectiveSide(f);
      const priceCents = effectiveSide === 'yes' ? yesCents : (100 - yesCents);
      if (priceCents < min || priceCents > max) continue;
      s.fillCount++;
      const cnt = parseFloat(f.count_fp);
      // yes_price_dollars is always the actual amount paid (YES-leg wire price)
      const priceD = parseFloat(f.yes_price_dollars);
      s.totalContracts += cnt;
      // Use effective-side price for cost: no_price for NO buys, yes_price for YES buys
      const effectivePriceD = effectiveSide === 'no' ? parseFloat(f.no_price_dollars) : priceD;
      s.totalCost += cnt * effectivePriceD;
      const pnl = computePnl(f);
      if (pnl !== null) { s.resolvedCount++; s.totalPnl += pnl; if (effectiveSide === f.market_result) s.wins++; else s.losses++; }
    }
    return s;
  });
}

// ─── Chart tooltip ────────────────────────────────────────────────────────────

function PnlTooltip({ active, payload, label, isPercent }: {
  active?: boolean; payload?: { value: number; name?: string; color?: string }[]; label?: string; isPercent?: boolean;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 text-xs shadow-lg space-y-0.5">
      {label && <p className="text-muted-foreground font-mono mb-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="font-mono font-semibold" style={{ color: p.color ?? (p.value >= 0 ? '#10b981' : '#ef4444') }}>
          {p.name ? `${p.name}: ` : ''}
          {isPercent ? `${p.value}%` : `$${Number(p.value).toFixed(2)}`}
        </p>
      ))}
    </div>
  );
}

// ─── Data hooks ───────────────────────────────────────────────────────────────

// ── Safe fetch helpers ─────────────────────────────────────────────────────────

/**
 * Build an absolute URL from a path, always anchored to window.location.origin.
 * Avoids the Safari SyntaxError thrown when new URL('/path') is called without
 * a base — safe on all browsers including mobile Safari.
 */
function apiUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/**
 * Parse a Response as JSON with full error context.
 * Checks response.ok first so an HTML error body (proxy 502, redirect, etc.)
 * never reaches JSON.parse — eliminating the Safari "SyntaxError: The string
 * did not match the expected pattern." caused by parsing HTML as JSON.
 */
async function safeJson(res: Response, endpoint: string): Promise<unknown> {
  const body = await res.text();
  if (!res.ok) {
    throw Object.assign(
      new Error(
        `${endpoint} — HTTP ${res.status} ${res.statusText}. ` +
        `Body: ${body.slice(0, 300)}`,
      ),
      { endpoint, httpStatus: res.status, responseBody: body },
    );
  }
  try {
    return JSON.parse(body);
  } catch (parseErr) {
    const errName = parseErr instanceof Error ? parseErr.name : 'SyntaxError';
    const errMsg  = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw Object.assign(
      new Error(
        `${endpoint} — ${errName}: ${errMsg}. ` +
        `Body (first 300 chars): ${body.slice(0, 300)}`,
      ),
      { endpoint, httpStatus: res.status, responseBody: body },
    );
  }
}

function usePortfolio() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [windowLog, setWindowLog] = useState<WindowLogEntry[]>([]);
  const [availability, setAvailability] = useState<PortfolioAvailability>({
    balance: false, positions: false, orders: false, fills: false, windowLog: false,
  });
  const [stale, setStale] = useState<PortfolioStaleness>({
    balance: false, positions: false, orders: false, fills: false, windowLog: false,
  });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowCloseError, setWindowCloseError] = useState<string | null>(null);
  const dismissWindowCloseError = useCallback(() => setWindowCloseError(null), []);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator());

  const refresh = useCallback(async (opts?: { isWindowClose?: boolean }) => {
    return refreshCoordinatorRef.current.run(async () => {
    // Build absolute URLs anchored to origin — safe on Safari and all browsers.
    const endpoints = {
      balance:   apiUrl('/api/trade/balance'),
      positions: apiUrl('/api/trade/positions'),
      orders:    apiUrl('/api/trade/orders?limit=25'),
      fills:     apiUrl('/api/trade/fills?limit=1000'),
      windowLog: apiUrl('/api/trade/window-log'),
    } as const;

    // Log final URLs before every request so Safari network failures are
    // immediately traceable in the browser console.
    console.log('[Portfolio] fetching:', endpoints);
    setLoading(true);

    try {
      const token = await getTradeToken();
      const tradeHeaders = { 'X-Trade-Token': token };
      const requestJson = (url: string, init?: RequestInit) =>
        fetch(url, init).then((response) => safeJson(response, url));

      // Account endpoints are independently useful. In particular, a temporary
      // fills/positions 429 must not hide a balance response that already
      // succeeded. Keep prior successful values for any endpoint that failed.
      const results = await Promise.allSettled([
        requestJson(endpoints.balance,   { credentials: 'include', headers: tradeHeaders }),
        requestJson(endpoints.positions, { credentials: 'include', headers: tradeHeaders }),
        requestJson(endpoints.orders,    { credentials: 'include', headers: tradeHeaders }),
        requestJson(endpoints.fills,     { credentials: 'include', headers: tradeHeaders }),
        requestJson(endpoints.windowLog),
      ]);
      const [balanceResult, positionsResult, ordersResult, fillsResult, windowLogResult] = results;
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const isRateLimited = failed.some((result) =>
        (result.reason as { httpStatus?: number } | undefined)?.httpStatus === 429,
      );

      // A fulfilled response can still carry stale (last-known) data: the
      // server serves cached values marked `stale: true` while Kalshi is
      // rate-limiting, instead of failing. Preserve that flag so cached data
      // is never presented as fresh.
      if (balanceResult.status === 'fulfilled') {
        setBalance(balanceResult.value as Balance);
        setAvailability((current) => ({ ...current, balance: true }));
        setStale((current) => ({ ...current, balance: responseIndicatesStale(balanceResult.value) }));
      }
      if (positionsResult.status === 'fulfilled') {
        setPositions(((positionsResult.value as { market_positions?: Position[] }).market_positions ?? []));
        setAvailability((current) => ({ ...current, positions: true }));
        setStale((current) => ({ ...current, positions: responseIndicatesStale(positionsResult.value) }));
      }
      if (ordersResult.status === 'fulfilled') {
        setOrders(((ordersResult.value as { orders?: Order[] }).orders ?? []).slice(0, 25));
        setAvailability((current) => ({ ...current, orders: true }));
        setStale((current) => ({ ...current, orders: false }));
      }
      if (fillsResult.status === 'fulfilled') {
        setFills((fillsResult.value as { fills?: Fill[] }).fills ?? []);
        setAvailability((current) => ({ ...current, fills: true }));
        setStale((current) => ({ ...current, fills: responseIndicatesStale(fillsResult.value) }));
      }
      if (windowLogResult.status === 'fulfilled') {
        setWindowLog(((windowLogResult.value as { windows?: WindowLogEntry[] }).windows ?? []));
        setAvailability((current) => ({ ...current, windowLog: true }));
        setStale((current) => ({ ...current, windowLog: false }));
      }

      if (results.some((result) => result.status === 'fulfilled')) setLastUpdated(new Date());
      if (failed.length === 0) {
        setError(null);
        if (opts?.isWindowClose) setWindowCloseError(null);
        return;
      }

      const msg = isRateLimited
        ? 'Kalshi is temporarily rate-limiting some portfolio data. Available balance and previously loaded values remain visible; unavailable sections will retry automatically.'
        : 'Some portfolio data is temporarily unavailable. Available values remain visible; the next refresh will retry.';
      setStale((current) => ({
        balance: current.balance || balanceResult.status === 'rejected',
        positions: current.positions || positionsResult.status === 'rejected',
        orders: current.orders || ordersResult.status === 'rejected',
        fills: current.fills || fillsResult.status === 'rejected',
        windowLog: current.windowLog || windowLogResult.status === 'rejected',
      }));
      console.error('[Portfolio] partial fetch failure:', failed.map((result) => result.reason));
      if (await checkSessionAndRecover()) {
        setError('Session expired — reconnecting…');
        return;
      }
      if (opts?.isWindowClose) setWindowCloseError(msg);
      else setError(msg);
    } catch (e) {
      // Surface endpoint, HTTP status, response body, and error name+message.
      const err = e as { endpoint?: string; httpStatus?: number; responseBody?: string; message?: string; name?: string };
      const parts: string[] = [];
      if (err.endpoint)     parts.push(`Endpoint: ${err.endpoint}`);
      if (err.httpStatus)   parts.push(`HTTP ${err.httpStatus}`);
      if (err.name && err.name !== 'Error') parts.push(err.name);
      if (err.message)      parts.push(err.message);
      const msg = err.httpStatus === 429
        ? 'Kalshi is temporarily rate-limiting portfolio data. Your last successful values remain visible; the next refresh will retry automatically.'
        : (parts.length ? parts.join(' — ') : String(e));
      console.error('[Portfolio] fetch error:', e);
      // If the Replit auth cookie expired, the fetches failed because they hit
      // the login shield — recover with a reload instead of a cryptic banner.
      if (await checkSessionAndRecover()) {
        setError('Session expired — reconnecting…');
        setLoading(false);
        return;
      }
      if (opts?.isWindowClose) {
        setWindowCloseError(msg);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
    });
  }, []);

  // Keep a ref to the interval so we can reset it from outside (e.g. after a
  // window-close refresh, to avoid a redundant poll firing shortly after).
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(refresh, 30_000);
  }, [refresh]);

  /** Cancel the current 30-s poll and start a fresh one from now. */
  const resetInterval = useCallback(() => {
    startInterval();
  }, [startInterval]);

  useEffect(() => {
    refresh();
    startInterval();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh, startInterval]);

  return { balance, positions, orders, fills, windowLog, availability, stale, loading, lastUpdated, error, windowCloseError, dismissWindowCloseError, refresh, resetInterval };
}

// ─── Window-close refresh ─────────────────────────────────────────────────────

/**
 * Watches the close_time of the active BTC and ETH 15-min windows.
 * When either countdown reaches zero it schedules two portfolio refreshes:
 *   • +2.5 s — gives Kalshi time to settle the closing window
 *   • +12.5 s — catches delayed settlement and new-window data
 * After each refresh the 30-s polling interval is reset so the next
 * automatic poll doesn't fire redundantly soon after.
 */
function useWindowCloseRefresh(refresh: (opts?: { isWindowClose?: boolean }) => void, resetInterval: () => void) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refetchOpts = { query: { refetchInterval: 5 * 60_000 } } as any;
  const { data: btcData } = useListMarkets({ series_ticker: 'KXBTC15M', status: 'open', limit: 1 }, refetchOpts);
  const { data: ethData } = useListMarkets({ series_ticker: 'KXETH15M', status: 'open', limit: 1 }, refetchOpts);

  const btcCloseTime = (btcData?.markets?.[0] as { close_time?: string } | undefined)?.close_time;
  const ethCloseTime = (ethData?.markets?.[0] as { close_time?: string } | undefined)?.close_time;

  // Track close_times we've already scheduled so we don't double-fire
  const scheduledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!btcCloseTime || scheduledRef.current.has(btcCloseTime)) return;
    const delay = new Date(btcCloseTime).getTime() - Date.now();
    if (delay <= 0) return;
    // BTC and ETH close together. Claim the shared close timestamp while
    // scheduling so both effects do not create the same pair of refreshes.
    scheduledRef.current.add(btcCloseTime);
    let secondId: ReturnType<typeof setTimeout> | undefined;
    const id = setTimeout(() => {
      refresh({ isWindowClose: true });
      resetInterval(); // push the 30-s poll back so it doesn't fire right after
      // Second refresh ~10 s later for delayed settlement / new-window data
      secondId = setTimeout(() => {
        refresh({ isWindowClose: true });
        resetInterval();
      }, 10_000);
    }, delay + 2_500);
    return () => {
      clearTimeout(id);
      if (secondId !== undefined) clearTimeout(secondId);
    };
  }, [btcCloseTime, refresh, resetInterval]);

  useEffect(() => {
    if (!ethCloseTime || scheduledRef.current.has(ethCloseTime)) return;
    const delay = new Date(ethCloseTime).getTime() - Date.now();
    if (delay <= 0) return;
    scheduledRef.current.add(ethCloseTime);
    let secondId: ReturnType<typeof setTimeout> | undefined;
    const id = setTimeout(() => {
      refresh({ isWindowClose: true });
      resetInterval();
      secondId = setTimeout(() => {
        refresh({ isWindowClose: true });
        resetInterval();
      }, 10_000);
    }, delay + 2_500);
    return () => {
      clearTimeout(id);
      if (secondId !== undefined) clearTimeout(secondId);
    };
  }, [ethCloseTime, refresh, resetInterval]);
}

// ─── Trade status (zone / window config) ──────────────────────────────────────

const DEFAULT_TIME_ALERT_SECONDS = 120;

/** Format seconds as M:SS, e.g. 120 → "2:00", 90 → "1:30". */
function fmtWindowTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function useTimeAlertSeconds(): number {
  const [secs, setSecs] = useState(DEFAULT_TIME_ALERT_SECONDS);
  useEffect(() => {
    let alive = true;
    getTradeToken()
      .then(token => fetch('/api/trade/status', {
        cache: 'no-store',
        headers: token ? { 'X-Trade-Token': token } : undefined,
      }))
      .then(r => r.ok ? r.json() : null)
      .then((d: { time_alert_seconds?: number } | null) => {
        if (alive && typeof d?.time_alert_seconds === 'number') {
          setSecs(d.time_alert_seconds);
        }
      })
      .catch(() => { /* keep default */ });
    return () => { alive = false; };
  }, []);
  return secs;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Portfolio() {
  const { balance, positions, orders, fills, windowLog, availability, stale, loading, lastUpdated, error, windowCloseError, dismissWindowCloseError, refresh, resetInterval } = usePortfolio();
  useWindowCloseRefresh(refresh, resetInterval);
  const timeAlertSeconds = useTimeAlertSeconds();
  const [seriesExpanded, setSeriesExpanded] = useState(true);

  // History clear — persisted in localStorage so it survives refreshes
  const [clearedAt, setClearedAt] = useState<string | null>(
    () => localStorage.getItem('kalshi:portfolio:clearedAt')
  );
  const clearHistory = () => {
    const ts = new Date().toISOString();
    localStorage.setItem('kalshi:portfolio:clearedAt', ts);
    setClearedAt(ts);
  };
  const showAllHistory = () => {
    localStorage.removeItem('kalshi:portfolio:clearedAt');
    setClearedAt(null);
  };

  // Apply clear filter to orders and fills
  const visibleOrders = (clearedAt ? orders.filter(o => o.created_time > clearedAt) : orders)
    .filter(o => o.status === 'executed');
  const visibleFills  = (clearedAt ? fills.filter(f => (f.created_time || '') > clearedAt) : fills)
    .filter(isPortfolioScopedFill);

  // Map order_id → submitted order price in cents (effective-side price, same logic as displayPrice)
  const orderPriceCentsById = new Map<string, number>();
  for (const o of orders) {
    const yesCents = Math.round(parseFloat(o.yes_price_dollars) * 100);
    // Trust the order's real side; fall back to the price heuristic if missing
    const effectiveSide = (o.side === 'yes' || o.side === 'no')
      ? o.side
      : (yesCents >= 50 ? 'yes' : 'no');
    const displayCents = effectiveSide === 'yes' ? yesCents : (100 - yesCents);
    orderPriceCentsById.set(o.order_id, displayCents);
  }
  const hiddenCount   = (orders.length - visibleOrders.length) + (fills.length - visibleFills.length);

  // Keep the settled total visible even when a newer exchange fill has not
  // settled yet. A missing total means "no settled evidence", never "$0".
  const pnlCoverage = summarizePnlCoverage(visibleFills);
  const totalPnl = pnlCoverage.realizedPnl;
  const resolvedCount = pnlCoverage.settledFillCount;
  const pendingSettlementCount = pnlCoverage.pendingSettlementCount;
  const { tiers } = useTiers();
  const seriesStats = computeSeriesStats(visibleFills);
  const tierStats   = computeTierStats(visibleFills, tiers);
  const [chartsExpanded, setChartsExpanded] = useState(true);
  const [tierExpanded,   setTierExpanded]   = useState(true);

  // ── SQL-backed verified tier P&L ────────────────────────────────────────────
  // The analytics endpoint returns verifiedByTier from getVerifiedPnlByTier,
  // which uses the fill-ledger SQL query with the won-column fallback.  This is
  // the authoritative source for settled P&L — computeTierStats (above) can
  // miss settlements when market_result is absent but won=true.
  const [verifiedByTier, setVerifiedByTier] = useState<VerifiedByTierPayload | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/trade/analytics/reports/pnl?period=all-time', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((d: { verifiedByTier?: VerifiedByTierPayload }) => {
        if (alive && d.verifiedByTier?.byTier) setVerifiedByTier(d.verifiedByTier);
      })
      .catch(() => { if (alive) setVerifiedByTier(null); }); // clear stale data on failure
    return () => { alive = false; };
  // Re-fetch whenever the portfolio data refreshes so the tier totals stay in sync.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUpdated]);
  // Build a label → SQL row map for O(1) lookup during render.
  const verifiedByTierMap = new Map<string, VerifiedByTierRow>(
    verifiedByTier?.byTier.map(r => [r.tierLabel, r]) ?? [],
  );

  // ── Entry Timing Report ─────────────────────────────────────────────────────
  interface EntryTimingBucket {
    label: string; minSecs: number; maxSecs: number | null;
    submissions: number; fills: number; fillRate: number | null;
    reconciled: number; wins: number; losses: number;
    winRate: number | null; avgFillPriceCents: number | null;
    avgNetPnlDollars: number | null;
    sampleWarning: 'very_small' | 'preliminary' | 'more_meaningful' | null;
  }
  interface EntryTimingReport {
    buckets: EntryTimingBucket[];
    pending: { fillsTotal: number; fillsReconciled: number; fillsPending: number };
    currentCutoffSecs: number;
    period: string;
  }
  const [entryTimingExpanded, setEntryTimingExpanded] = useState(true);
  const [entryTimingPeriod,   setEntryTimingPeriod]   = useState<'today' | '7d' | 'all-time'>('all-time');
  const [entryTimingReport,   setEntryTimingReport]   = useState<EntryTimingReport | null>(null);
  const [entryTimingLoading,  setEntryTimingLoading]  = useState(false);

  useEffect(() => {
    let alive = true;
    setEntryTimingLoading(true);
    fetch(`/api/trade/analytics/reports/entry-timing?period=${entryTimingPeriod}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((d: EntryTimingReport) => { if (alive) { setEntryTimingReport(d); setEntryTimingLoading(false); } })
      .catch(() => { if (alive) setEntryTimingLoading(false); });
    return () => { alive = false; };
  }, [entryTimingPeriod]);

  // ── Window Sensitivity Report ───────────────────────────────────────────────
  interface WindowSensitivityBand {
    label: string; minSecs: number; maxSecs: number;
    inZoneDecisions: number; submits: number;
    settled: number; wins: number; losses: number;
    winRate: number | null;
  }
  interface WindowSensitivityBySeries {
    series: string; newBandDecisions: number; newBandSubmits: number;
  }
  interface WindowSensitivityByHour {
    easternHour: number; newBandDecisions: number; newBandSubmits: number;
  }
  interface WindowSensitivityReport {
    daysAnalyzed: number;
    oldCutoffSecs: number; newCutoffSecs: number;
    zoneMinCents: number; zoneMaxCents: number;
    bands: WindowSensitivityBand[];
    bySeries: WindowSensitivityBySeries[];
    byHour: WindowSensitivityByHour[];
    totalNewBandDecisions: number; totalNewBandSubmits: number;
    sampleWarning: string | null;
  }
  const [winSensExpanded, setWinSensExpanded] = useState(true);
  const [winSensDays, setWinSensDays]         = useState<7 | 30 | 0>(7);
  const [winSensReport, setWinSensReport]     = useState<WindowSensitivityReport | null>(null);
  const [winSensLoading, setWinSensLoading]   = useState(false);

  useEffect(() => {
    let alive = true;
    setWinSensLoading(true);
    fetch(`/api/trade/analytics/reports/window-sensitivity?days=${winSensDays}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((d: WindowSensitivityReport) => { if (alive) { setWinSensReport(d); setWinSensLoading(false); } })
      .catch(() => { if (alive) setWinSensLoading(false); });
    return () => { alive = false; };
  }, [winSensDays]);

  // Tier P&L (for bar chart) — prefer SQL-backed verified P&L when available.
  // SQL data is all-time and must NOT be mixed with a clearedAt-filtered view;
  // fall back to client-computed totals whenever history is filtered.
  const tierPnlData = tierStats.map(t => {
    const vr = !clearedAt ? verifiedByTierMap.get(t.tier) : undefined;
    // When a SQL row is present, use its P&L exactly — including null, which
    // means "unavailable" (pending fill chunks). Recharts skips null bars so
    // the chart stays honest: no bar = no verified data, not a break-even.
    // Only fall back to the client estimate when no SQL row exists at all.
    const rawPnl: number | null = vr != null ? vr.realizedNetPnlDollars : t.totalPnl;
    const pnl = rawPnl != null ? parseFloat(rawPnl.toFixed(2)) : null;
    // Win-rate uses client fills so it stays consistent with the W/L display.
    const winRate = t.resolvedCount > 0
      ? parseFloat(((t.wins / t.resolvedCount) * 100).toFixed(1))
      : 0;
    return { name: t.tier, pnl, winRate };
  });

  // ── Chart data ──────────────────────────────────────────────────────────────
  // Cumulative P&L: resolved fills sorted oldest → newest
  const cumulativePnlData = (() => {
    const resolved = [...visibleFills]
      .filter(f => computePnl(f) !== null)
      .sort((a, b) => {
        const ta = a.created_time ? new Date(a.created_time).getTime() : (a.ts ?? 0) * 1000;
        const tb = b.created_time ? new Date(b.created_time).getTime() : (b.ts ?? 0) * 1000;
        return ta - tb;
      });
    let running = 0;
    return resolved.map((f, i) => {
      running += computePnl(f)!;
      const label = f.created_time
        ? new Date(f.created_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : `#${i + 1}`;
      return { name: label, pnl: parseFloat(running.toFixed(2)) };
    });
  })();

  // P&L by asset (BTC / ETH)
  const assetPnlData = (() => {
    const map = new Map<string, number>();
    for (const f of visibleFills) {
      const pnl = computePnl(f);
      if (pnl === null) continue;
      const asset = f.ticker.includes('BTC') ? 'BTC' : f.ticker.includes('ETH') ? 'ETH' : 'Other';
      map.set(asset, (map.get(asset) ?? 0) + pnl);
    }
    return Array.from(map.entries()).map(([name, pnl]) => ({ name, pnl: parseFloat(pnl.toFixed(2)) }));
  })();

  // Wins vs losses by hour-of-day
  const hourData = (() => {
    const map = new Map<number, { wins: number; losses: number }>();
    for (const f of visibleFills) {
      if (!f.market_result) continue;
      const h = f.created_time ? new Date(f.created_time).getHours() : null;
      if (h === null) continue;
      if (!map.has(h)) map.set(h, { wins: 0, losses: 0 });
      const s = map.get(h)!;
      if (fillEffectiveSide(f) === f.market_result) s.wins++; else s.losses++;
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([h, { wins, losses }]) => ({
        name: `${String(h).padStart(2, '0')}:00`,
        wins, losses,
      }));
  })();

  // Derive the held side for each position from the most recent fill per ticker.
  // Fills from usePortfolio are already sorted newest-first by the API.
  // Use fillEffectiveSide() instead of fill.side because Kalshi always reports
  // side:"yes" in fills — even for NO buys — so we must infer from the price.
  const positionSideMap = new Map<string, 'yes' | 'no'>();
  for (const f of fills) {
    if (!positionSideMap.has(f.ticker)) {
      positionSideMap.set(f.ticker, fillEffectiveSide(f));
    }
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Portfolio</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Account balance, orders, and trade history</p>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-muted-foreground">
                {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            {clearedAt ? (
              <button
                onClick={showAllHistory}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 border rounded-lg transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Show all history
              </button>
            ) : (
              <button
                onClick={clearHistory}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive px-3 py-1.5 border rounded-lg transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear history
              </button>
            )}
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 border rounded-lg transition-colors"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {windowCloseError && (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                <strong>Portfolio may be out of date.</strong> The automatic refresh after the window close
                failed — try refreshing manually.
              </span>
            </div>
            <button
              onClick={dismissWindowCloseError}
              className="shrink-0 text-amber-600 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200 transition-colors"
              aria-label="Dismiss"
            >
              <XCircle className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Balance cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="border rounded-xl p-5 bg-card col-span-2 sm:col-span-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Wallet className="h-3.5 w-3.5" />
              Available Balance
            </div>
            {loading && !availability.balance
              ? <LoadingSpinner className="py-1" />
              : <div className="text-3xl font-bold font-mono text-foreground">
                  {fmtDollars(balance?.balance_dollars)}
                </div>}
            {!availability.balance && !loading && (
              <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">Balance temporarily unavailable</div>
            )}
            {availability.balance && stale.balance && (
              <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">Last successful value — retrying</div>
            )}
          </div>

          <div className="border rounded-xl p-5 bg-card">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <TrendingUp className="h-3.5 w-3.5" />
              Amount Invested
            </div>
            {loading && !availability.positions
              ? <LoadingSpinner className="py-1" />
              : <div className="text-3xl font-bold font-mono text-foreground">
                  {availability.positions
                    ? fmtDollars(positions.filter(p => !p.market_result && p.market_status !== 'finalized').reduce((sum, p) => sum + parseFloat(p.total_traded_dollars), 0))
                    : '—'}
                </div>}
          </div>

          {/* Total P&L card */}
          <div className="border rounded-xl p-5 bg-card">
            <div className={cn(
              'flex items-center gap-2 text-xs text-muted-foreground mb-2',
            )}>
              {totalPnl !== null && totalPnl >= 0
                ? <TrendingUp className="h-3.5 w-3.5" />
                : <TrendingDown className="h-3.5 w-3.5" />}
              Realised P&amp;L
            </div>
            {loading && !availability.fills
              ? <LoadingSpinner className="py-1" />
              : !availability.fills || totalPnl === null
                ? <div className="text-3xl font-bold font-mono text-muted-foreground">—</div>
                : <div className={cn(
                    'text-3xl font-bold font-mono',
                    totalPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
                  )}>
                    {fmtPnl(totalPnl)}
                  </div>
            }
            <div className="text-xs text-muted-foreground mt-1">
              {!availability.fills
                ? 'Fills temporarily unavailable'
                : resolvedCount > 0
                ? `${resolvedCount} settled fill${resolvedCount !== 1 ? 's' : ''}`
                : 'No settled fills yet'}
            </div>
            {pendingSettlementCount > 0 && (
              <div className="text-xs mt-1 text-amber-700 dark:text-amber-400">
                {pendingSettlementCount} fill{pendingSettlementCount !== 1 ? 's are' : ' is'} awaiting settlement and excluded
              </div>
            )}
            {pendingSettlementCount === 0 && resolvedCount > 0 && (
              <div className="text-xs text-muted-foreground mt-1">
                All visible fills are settled
              </div>
            )}
          </div>

          <div className="border rounded-xl p-5 bg-card">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Activity className="h-3.5 w-3.5" />
              Portfolio Value
            </div>
            {loading && !availability.balance
              ? <LoadingSpinner className="py-1" />
              : <div className="text-3xl font-bold font-mono text-foreground">
                  {balance?.portfolio_value != null
                    ? fmtDollars(balance.portfolio_value / 100)
                    : '—'}
                </div>}
            <div className="text-xs text-muted-foreground mt-1">
              {stale.balance ? 'last successful open position value' : 'open position value'}
            </div>
          </div>
        </div>

        {/* Open Positions */}
        <div className="border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Open Positions</h2>
            </div>
            <span className="text-xs text-muted-foreground">
              {availability.positions ? `${positions.length} position${positions.length !== 1 ? 's' : ''}` : 'Unavailable'}
            </span>
          </div>

          {loading && !availability.positions ? (
            <LoadingSpinner className="py-8" />
          ) : !availability.positions ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Positions are temporarily unavailable — retrying automatically.</div>
          ) : positions.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No open positions</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Market</th>
                    <th className="text-left px-4 py-2.5 font-medium">Side</th>
                    <th className="text-right px-4 py-2.5 font-medium">Contracts</th>
                    <th className="text-right px-4 py-2.5 font-medium">Avg Cost</th>
                    <th className="text-right px-4 py-2.5 font-medium">Bid</th>
                    <th className="text-right px-4 py-2.5 font-medium">Mark Value</th>
                    <th className="text-right px-4 py-2.5 font-medium">Unreal. P&amp;L</th>
                    <th className="text-right px-4 py-2.5 font-medium">Real. P&amp;L</th>
                    <th className="text-right px-4 py-2.5 font-medium">Fees</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {positions.map((p) => {
                    const contractsFp = parseFloat(p.position_fp);
                    // Negative position_fp = short YES = NO position (sell-YES / side:"ask" orders)
                    const positionSide = contractsFp < 0 ? 'no' : 'yes';
                    const contracts = Math.abs(contractsFp);
                    const costBasis = parseFloat(p.total_traded_dollars);
                    const markValue = parseFloat(p.market_exposure_dollars);
                    const unrealizedPnl = markValue - costBasis;
                    const realizedPnl = parseFloat(p.realized_pnl_dollars);
                    // Avg cost from fills — more accurate than total_traded_dollars
                    // which reflects mark value not purchase price
                    const tickerFills = fills.filter(f => f.ticker === p.ticker);
                    const fillContracts = tickerFills.reduce((s, f) => s + parseFloat(f.count_fp || '0'), 0);
                    const fillCost = tickerFills.reduce((s, f) => {
                      const cnt = parseFloat(f.count_fp || '0');
                      // Kalshi always reports side:"yes" even for NO buys — use fillEffectiveSide()
                      const price = parseFloat(fillEffectiveSide(f) === 'yes' ? f.yes_price_dollars : f.no_price_dollars);
                      return s + cnt * price;
                    }, 0);
                    const avgCostCents = fillContracts > 0
                      ? Math.round((fillCost / fillContracts) * 100)
                      : contracts > 0 ? Math.round((costBasis / contracts) * 100) : 0;
                    // Show the bid for the side held — YES bid for YES positions, NO bid for NO positions
                    const bidCents = positionSide === 'no'
                      ? (p.no_bid != null ? Math.round((p.no_bid as number) * 100) : null)
                      : (p.yes_bid != null ? Math.round((p.yes_bid as number) * 100) : null);
                    const isSettled = p.market_status === 'finalized' || !!p.market_result;
                    return (
                      <tr key={p.ticker} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs text-foreground">{shortTicker(p.ticker)}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate max-w-[160px]">{p.ticker}</div>
                          {p.close_time && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              closes {new Date(p.close_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {sideBadge(positionSide)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold">
                          {contracts.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">{avgCostCents}¢</td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {bidCents != null ? `${bidCents}¢` : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">{fmtDollars(markValue)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                          <span className={unrealizedPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                            {fmtPnl(unrealizedPnl)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                          {realizedPnl !== 0
                            ? <span className={realizedPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                {fmtPnl(realizedPnl)}
                              </span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                          {fmtDollars(p.fees_paid_dollars)}
                        </td>
                        <td className="px-4 py-3">
                          {isSettled
                            ? resolvedBadge(positionSide, p.market_result ?? '')
                            : <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/15 text-primary">
                                <Activity className="h-3 w-3" />
                                Open
                              </span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* By Market Series */}
        <div className="border rounded-xl overflow-hidden">
          <button
            className="w-full px-4 py-3 bg-muted/30 border-b flex items-center justify-between hover:bg-muted/50 transition-colors"
            onClick={() => setSeriesExpanded(v => !v)}
          >
            <h2 className="text-sm font-semibold text-foreground">By Market Series</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {seriesStats.length} series · {resolvedCount} resolved fill{resolvedCount !== 1 ? 's' : ''}
              </span>
              {seriesExpanded
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          </button>

          {seriesExpanded && (
            loading && !availability.fills ? (
              <LoadingSpinner className="py-8" />
            ) : !availability.fills ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Fills are temporarily unavailable — retrying automatically.</div>
            ) : seriesStats.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No fills found</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left px-4 py-2.5 font-medium">Series</th>
                      <th className="text-right px-4 py-2.5 font-medium">Fills</th>
                      <th className="text-right px-4 py-2.5 font-medium">Resolved</th>
                      <th className="text-right px-4 py-2.5 font-medium">Win Rate</th>
                      <th className="text-right px-4 py-2.5 font-medium">W / L</th>
                      <th className="text-right px-4 py-2.5 font-medium">Net P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {seriesStats.map((s) => {
                      const winRate = s.resolvedCount > 0 ? s.wins / s.resolvedCount : null;
                      return (
                        <tr key={s.series} className="hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-3">
                            <span className="font-mono text-xs font-semibold text-foreground">{s.series}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground tabular-nums">
                            {s.fillCount}
                            {s.pendingCount > 0 && (
                              <span className="ml-1 text-muted-foreground/60">({s.pendingCount} pending)</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-foreground">
                            {s.resolvedCount}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                            {winRate === null
                              ? <span className="text-muted-foreground">—</span>
                              : <span className={winRate >= 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                  {(winRate * 100).toFixed(0)}%
                                </span>
                            }
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                            <span className="text-emerald-600 dark:text-emerald-400">{s.wins}W</span>
                            {' / '}
                            <span className="text-destructive">{s.losses}L</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                            {s.resolvedCount === 0
                              ? <span className="text-muted-foreground">—</span>
                              : <span className={s.totalPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                  {fmtPnl(s.totalPnl)}
                                </span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>

        {/* ── Performance Charts ───────────────────────────────────────── */}
        <div className="border rounded-xl overflow-hidden">
          <button
            className="w-full px-4 py-3 bg-muted/30 border-b flex items-center justify-between hover:bg-muted/50 transition-colors"
            onClick={() => setChartsExpanded(v => !v)}
          >
            <div className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Performance Charts</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{resolvedCount} resolved fills</span>
              {chartsExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          </button>

          {chartsExpanded && (
            <div className="p-5 space-y-6">
              {cumulativePnlData.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No resolved fills yet</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Cumulative P&L */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-3">Cumulative P&amp;L</p>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={cumulativePnlData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={v => `$${v}`} width={48} />
                        <Tooltip content={<PnlTooltip />} />
                        <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1.5} />
                        <Line
                          type="monotone" dataKey="pnl" dot={false} strokeWidth={2}
                          stroke={cumulativePnlData[cumulativePnlData.length - 1]?.pnl >= 0 ? '#10b981' : '#ef4444'}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* P&L by Asset */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-3">P&amp;L by Asset</p>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={assetPnlData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                        <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={v => `$${v}`} width={48} />
                        <Tooltip content={<PnlTooltip />} />
                        <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1.5} />
                        <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                          {assetPnlData.map((entry, i) => (
                            <Cell key={i} fill={entry.pnl >= 0 ? '#10b981' : '#ef4444'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* P&L by Entry Tier */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-3">P&amp;L by Entry Tier</p>
                    <ResponsiveContainer width="100%" height={180}>
                      <ComposedChart data={tierPnlData} margin={{ top: 4, right: 32, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                        <YAxis yAxisId="pnl" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={v => `$${v}`} width={48} />
                        <YAxis yAxisId="wr" orientation="right" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={v => `${v}%`} width={36} domain={[0, 100]} />
                        <Tooltip content={<PnlTooltip />} />
                        <ReferenceLine yAxisId="pnl" y={0} stroke="hsl(var(--border))" strokeWidth={1.5} />
                        <Bar yAxisId="pnl" dataKey="pnl" radius={[4, 4, 0, 0]}>
                          {tierPnlData.map((entry, i) => (
                            <Cell key={i} fill={(entry.pnl ?? 0) >= 0 ? '#10b981' : '#ef4444'} />
                          ))}
                        </Bar>
                        <Line yAxisId="wr" type="monotone" dataKey="winRate" dot={{ r: 3 }} strokeWidth={2} stroke="#f59e0b" />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <p className="text-xs text-muted-foreground mt-1 text-right">bars = net P&amp;L · line = win rate %</p>
                  </div>

                  {/* Trades by Hour */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-3">Wins vs Losses by Hour</p>
                    {hourData.length === 0 ? (
                      <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">No data</div>
                    ) : (
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={hourData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} width={28} />
                          <Tooltip contentStyle={{ fontSize: 11 }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar dataKey="wins"   name="Wins"   stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="losses" name="Losses" stackId="a" fill="#ef4444" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Tier Breakdown ───────────────────────────────────────────────── */}
        <div className="border rounded-xl overflow-hidden">
          <button
            className="w-full px-4 py-3 bg-muted/30 border-b flex items-center justify-between hover:bg-muted/50 transition-colors"
            onClick={() => setTierExpanded(v => !v)}
          >
            <h2 className="text-sm font-semibold text-foreground">By Entry Tier</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{tiers.map((tier) => tier.label).join(' · ')}</span>
              {tierExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          </button>

          {tierExpanded && (
            !availability.fills ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Fills are temporarily unavailable — retrying automatically.</div>
            ) : tierStats.every(t => t.fillCount === 0) ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No fills to break down</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left px-4 py-2.5 font-medium">Tier</th>
                      <th className="text-right px-4 py-2.5 font-medium">Fills</th>
                      <th className="text-right px-4 py-2.5 font-medium">Contracts</th>
                      <th className="text-right px-4 py-2.5 font-medium">Avg Cost</th>
                      <th className="text-right px-4 py-2.5 font-medium">Resolved</th>
                      <th className="text-right px-4 py-2.5 font-medium">Win Rate</th>
                      <th className="text-right px-4 py-2.5 font-medium">W / L</th>
                      <th className="text-right px-4 py-2.5 font-medium">Net P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {tierStats.map(t => {
                      // SQL overlay is skipped when clearedAt is set: the SQL result is
                      // all-time and must not be mixed with a filtered client view.
                      const vr = !clearedAt ? verifiedByTierMap.get(t.tier) : undefined;
                      // If the SQL row exists but realizedNetPnlDollars is null, the
                      // server signals "unavailable" (pending fill chunks) — show —.
                      // Only fall back to client P&L when no SQL row is present at all.
                      const sqlPnl     = vr != null ? vr.realizedNetPnlDollars : undefined;
                      const displayPnl = vr != null ? sqlPnl : t.totalPnl;
                      // W/L and win-rate are always client-derived so they stay consistent
                      // with each other regardless of the SQL resolved count.
                      const winRate = t.resolvedCount > 0 ? t.wins / t.resolvedCount : null;
                      const avgCost = t.totalContracts > 0 ? Math.round((t.totalCost / t.totalContracts) * 100) : null;
                      return (
                        <tr key={t.tier} className={cn('hover:bg-muted/20 transition-colors', t.fillCount === 0 && 'opacity-40')}>
                          <td className="px-4 py-3 font-mono text-xs font-semibold text-foreground">{t.tier}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground tabular-nums">{t.fillCount}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{t.totalContracts.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                            {avgCost != null ? `${avgCost}¢` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{t.resolvedCount}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                            {winRate === null
                              ? <span className="text-muted-foreground">—</span>
                              : <span className={winRate >= 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                  {(winRate * 100).toFixed(0)}%
                                </span>}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                            <span className="text-emerald-600 dark:text-emerald-400">{t.wins}W</span>
                            {' / '}
                            <span className="text-destructive">{t.losses}L</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                            {displayPnl == null
                              ? <span className="text-muted-foreground">—</span>
                              : <span className={displayPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                  {fmtPnl(displayPnl)}
                                </span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>

        {/* ── Entry Timing Analysis ────────────────────────────────────────── */}
        <div className="border rounded-xl overflow-hidden">
          <button
            className="w-full px-4 py-3 bg-muted/30 border-b flex items-center justify-between hover:bg-muted/50 transition-colors"
            onClick={() => setEntryTimingExpanded(v => !v)}
          >
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Entry Timing Analysis</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">win rate by time-remaining at entry</span>
              {entryTimingExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          </button>

          {entryTimingExpanded && (
            <div className="p-4 space-y-4">
              {/* Period selector */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Period:</span>
                {(['today', '7d', 'all-time'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setEntryTimingPeriod(p)}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md border transition-colors',
                      entryTimingPeriod === p
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'text-muted-foreground hover:text-foreground border-border hover:border-foreground/40',
                    )}
                  >
                    {p}
                  </button>
                ))}
                {entryTimingLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
              </div>

              {!entryTimingReport && !entryTimingLoading ? (
                <div className="py-6 text-center text-sm text-muted-foreground">No data available</div>
              ) : entryTimingLoading && !entryTimingReport ? (
                <LoadingSpinner className="py-6" />
              ) : entryTimingReport && (
                <>
                  {/* Info strip */}
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>
                      Current cutoff: <span className="font-mono font-medium text-foreground">{Math.floor((entryTimingReport.currentCutoffSecs ?? 120) / 60)}:{String((entryTimingReport.currentCutoffSecs ?? 120) % 60).padStart(2, '0')} left</span>
                    </span>
                    {entryTimingReport.pending.fillsPending > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {entryTimingReport.pending.fillsPending} fill{entryTimingReport.pending.fillsPending !== 1 ? 's' : ''} pending reconciliation
                      </span>
                    )}
                  </div>

                  {/* Bucket table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground">
                          <th className="text-left px-3 py-2.5 font-medium">Time Remaining</th>
                          <th className="text-right px-3 py-2.5 font-medium">Submissions</th>
                          <th className="text-right px-3 py-2.5 font-medium">Fills</th>
                          <th className="text-right px-3 py-2.5 font-medium">Fill Rate</th>
                          <th className="text-right px-3 py-2.5 font-medium">Resolved</th>
                          <th className="text-right px-3 py-2.5 font-medium">Win Rate</th>
                          <th className="text-right px-3 py-2.5 font-medium">W / L</th>
                          <th className="text-right px-3 py-2.5 font-medium">Avg Fill</th>
                          <th className="text-right px-3 py-2.5 font-medium">Avg Net P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {entryTimingReport.buckets.map((b) => {
                          // Highlight the bucket that contains the current cutoff
                          const cutoff = entryTimingReport.currentCutoffSecs ?? 120;
                          const isCurrent = b.minSecs <= cutoff && (b.maxSecs === null || cutoff < b.maxSecs);
                          return (
                            <tr
                              key={b.label}
                              className={cn(
                                'hover:bg-muted/20 transition-colors',
                                isCurrent && 'bg-primary/5',
                                b.submissions === 0 && 'opacity-40',
                              )}
                            >
                              <td className="px-3 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs font-semibold text-foreground">{b.label}</span>
                                  {isCurrent && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium uppercase tracking-wide">current</span>
                                  )}
                                  {b.sampleWarning === 'very_small' && (
                                    <span className="text-[10px] text-amber-600 dark:text-amber-400" title="Fewer than 30 fills — treat with caution">⚠ small</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground tabular-nums">{b.submissions}</td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">{b.fills}</td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {b.fillRate === null ? '—' : `${(b.fillRate * 100).toFixed(0)}%`}
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">{b.reconciled}</td>
                              <td className="px-3 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                                {b.winRate === null
                                  ? <span className="text-muted-foreground">—</span>
                                  : <span className={b.winRate >= 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                      {(b.winRate * 100).toFixed(0)}%
                                    </span>
                                }
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {b.reconciled === 0 ? '—' : (
                                  <>
                                    <span className="text-emerald-600 dark:text-emerald-400">{b.wins}W</span>
                                    {' / '}
                                    <span className="text-destructive">{b.losses}L</span>
                                  </>
                                )}
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {b.avgFillPriceCents === null ? '—' : `${Math.round(b.avgFillPriceCents)}¢`}
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                                {b.avgNetPnlDollars === null
                                  ? <span className="text-muted-foreground">—</span>
                                  : <span className={b.avgNetPnlDollars >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                      {b.avgNetPnlDollars >= 0 ? '+' : ''}{b.avgNetPnlDollars.toFixed(3)}
                                    </span>
                                }
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Win rate and P&amp;L use only outcome-reconciled fills ({entryTimingReport.pending.fillsReconciled} of {entryTimingReport.pending.fillsTotal}).
                    {' '}Buckets with ⚠ small have fewer than 30 fills — treat as preliminary.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Window Sensitivity */}
        <div className="border rounded-xl overflow-hidden">
          <button
            className="w-full px-4 py-3 bg-muted/30 border-b flex items-center justify-between hover:bg-muted/50 transition-colors"
            onClick={() => setWinSensExpanded(v => !v)}
          >
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Window Sensitivity</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">2:30 vs 3:00 cutoff — historical comparison</span>
              {winSensExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          </button>

          {winSensExpanded && (
            <div className="p-4 space-y-4">
              {/* Lookback selector */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Lookback:</span>
                {([7, 30, 0] as const).map(d => (
                  <button
                    key={d}
                    onClick={() => setWinSensDays(d)}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md border transition-colors',
                      winSensDays === d
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'text-muted-foreground hover:text-foreground border-border hover:border-foreground/40',
                    )}
                  >
                    {d === 0 ? 'all-time' : `${d}d`}
                  </button>
                ))}
                {winSensLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
              </div>

              {!winSensReport && !winSensLoading ? (
                <div className="py-6 text-center text-sm text-muted-foreground">No data available</div>
              ) : winSensLoading && !winSensReport ? (
                <LoadingSpinner className="py-6" />
              ) : winSensReport && (
                <>
                  {/* Sample warning */}
                  {winSensReport.sampleWarning && (
                    <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
                      {winSensReport.sampleWarning}
                    </div>
                  )}

                  {/* Headline: new-band count */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">New-band evals</div>
                      <div className="text-xl font-mono font-bold tabular-nums">{winSensReport.totalNewBandDecisions}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">in-zone ticks, 2:30–3:00 left (historical)</div>
                    </div>
                    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">New-band submits</div>
                      <div className="text-xl font-mono font-bold tabular-nums">{winSensReport.totalNewBandSubmits}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">orders gate allowed through</div>
                    </div>
                    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Old-window evals</div>
                      <div className="text-xl font-mono font-bold tabular-nums">{winSensReport.bands[0]?.inZoneDecisions ?? '—'}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">in-zone ticks, &lt; 2:00 left</div>
                    </div>
                    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Zone</div>
                      <div className="text-xl font-mono font-bold tabular-nums">{winSensReport.zoneMinCents}–{winSensReport.zoneMaxCents}¢</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">entry-price zone</div>
                    </div>
                  </div>

                  {/* Band comparison table */}
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Band comparison</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-xs text-muted-foreground">
                            <th className="text-left px-3 py-2 font-medium">Window band</th>
                            <th className="text-right px-3 py-2 font-medium">In-zone evals</th>
                            <th className="text-right px-3 py-2 font-medium">Submits</th>
                            <th className="text-right px-3 py-2 font-medium">Submit rate</th>
                            <th className="text-right px-3 py-2 font-medium">Settled</th>
                            <th className="text-right px-3 py-2 font-medium">Win rate</th>
                            <th className="text-right px-3 py-2 font-medium">W / L</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {winSensReport.bands.map((b, i) => (
                            <tr key={b.label} className={cn('hover:bg-muted/20 transition-colors', i === 1 && 'bg-primary/5')}>
                              <td className="px-3 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs font-semibold text-foreground">{b.label}</span>
                                  {i === 1 && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium uppercase tracking-wide">new</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">{b.inZoneDecisions}</td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">{b.submits}</td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {b.inZoneDecisions === 0 ? '—' : `${((b.submits / b.inZoneDecisions) * 100).toFixed(0)}%`}
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">{b.settled}</td>
                              <td className="px-3 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                                {b.winRate === null
                                  ? <span className="text-muted-foreground">—</span>
                                  : <span className={b.winRate >= 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                      {(b.winRate * 100).toFixed(0)}%
                                    </span>
                                }
                              </td>
                              <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {b.settled === 0 ? '—' : (
                                  <>
                                    <span className="text-emerald-600 dark:text-emerald-400">{b.wins}W</span>
                                    {' / '}
                                    <span className="text-destructive">{b.losses}L</span>
                                  </>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* By series */}
                  {winSensReport.bySeries.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">New-band by series</div>
                      <div className="flex flex-wrap gap-3">
                        {winSensReport.bySeries.map(s => (
                          <div key={s.series} className="rounded-lg border bg-muted/20 px-3 py-2.5 min-w-[140px]">
                            <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{s.series.replace('KXBTC15M', 'BTC').replace('KXETH15M', 'ETH')}</div>
                            <div className="flex items-baseline gap-2">
                              <span className="text-lg font-mono font-bold tabular-nums">{s.newBandDecisions}</span>
                              <span className="text-xs text-muted-foreground">evals</span>
                              <span className="text-xs font-mono text-primary">{s.newBandSubmits} submitted</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* By hour (small bar chart) */}
                  {winSensReport.byHour.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">New-band evals by Eastern hour</div>
                      <div className="h-28">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={winSensReport.byHour.map(h => ({
                            name: `${String(h.easternHour).padStart(2, '0')}:00`,
                            evals: h.newBandDecisions,
                            submits: h.newBandSubmits,
                          }))} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                            <XAxis dataKey="name" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                            <YAxis allowDecimals={false} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                            <Tooltip
                              contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                              formatter={(v: number, name: string) => [v, name === 'evals' ? 'in-zone evals' : 'submits']}
                            />
                            <Bar dataKey="evals" fill="hsl(var(--primary) / 0.25)" radius={[2, 2, 0, 0]} />
                            <Bar dataKey="submits" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    "In-zone evals" = preflight evaluations where price was {winSensReport.zoneMinCents}–{winSensReport.zoneMaxCents}¢ and time-remaining was in the band.
                    {' '}Win rate uses market results for submitted orders only; ticks that were blocked by the gate are not counted.
                    {' '}Data covers {winSensReport.daysAnalyzed} day{winSensReport.daysAnalyzed !== 1 ? 's' : ''} of preflight logs.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Fills table */}
        <div className="border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Trade History (Fills)</h2>
            <span className="text-xs text-muted-foreground">{visibleFills.length} shown</span>
          </div>

          {loading && !availability.fills ? (
            <LoadingSpinner className="py-8" />
          ) : !availability.fills ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Fills are temporarily unavailable — retrying automatically.
            </div>
          ) : visibleFills.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {clearedAt ? 'No fills since last clear' : 'No fills found'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Market</th>
                    <th className="text-left px-4 py-2.5 font-medium">Side</th>
                    <th className="text-right px-4 py-2.5 font-medium">Fill Price</th>
                    <th className="text-right px-4 py-2.5 font-medium">Order Price</th>
                    <th className="text-right px-4 py-2.5 font-medium">Contracts</th>
                    <th className="text-right px-4 py-2.5 font-medium">Cost</th>
                    <th className="text-right px-4 py-2.5 font-medium">Fee</th>
                    <th className="text-left px-4 py-2.5 font-medium">Result</th>
                    <th className="text-right px-4 py-2.5 font-medium">P&amp;L</th>
                    <th className="text-right px-4 py-2.5 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleFills.map((f) => {
                    const contracts = parseFloat(f.count_fp);
                    const effectiveSide = fillEffectiveSide(f);
                    // The actual amount paid is the price on the side actually held
                    const priceD = effectiveSide === 'no'
                      ? parseFloat(f.no_price_dollars)
                      : parseFloat(f.yes_price_dollars);
                    const cost = contracts * priceD;
                    const yesPriceCents = Math.round(parseFloat(f.yes_price_dollars) * 100);
                    const displayPrice = effectiveSide === 'yes' ? yesPriceCents : (100 - yesPriceCents);
                    // Order price lookup — improvement when fill is cheaper than the submitted limit
                    const orderPriceCents = f.order_id != null ? orderPriceCentsById.get(f.order_id) : undefined;
                    const improvement = orderPriceCents != null && orderPriceCents > displayPrice
                      ? orderPriceCents - displayPrice
                      : null;
                    const pnl = computePnl(f);
                    return (
                      <tr key={f.fill_id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs text-foreground">{shortTicker(f.ticker)}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate max-w-[140px]">{f.ticker}</div>
                        </td>
                        <td className="px-4 py-3">{sideBadge(effectiveSide)}</td>
                        <td className="px-4 py-3 text-right font-mono font-medium">
                          <div className="flex items-center justify-end gap-1">
                            <span>{displayPrice}¢</span>
                            {improvement != null && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 leading-none">
                                ↓{improvement}¢
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground tabular-nums">
                          {orderPriceCents != null ? `${orderPriceCents}¢` : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {contracts.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-foreground">
                          {fmtDollars(cost)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                          {fmtDollars(f.fee_cost)}
                        </td>
                        <td className="px-4 py-3">
                          {resolvedBadge(effectiveSide, f.market_result)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums">
                          {pnl === null
                            ? <span className="text-muted-foreground">—</span>
                            : <span className={pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                                {fmtPnl(pnl)}
                              </span>
                          }
                        </td>
                        <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums">
                          {fmtTime(f.created_time, f.ts)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Window Log ──────────────────────────────────────────────── */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div className="flex items-center gap-2">
              <ListOrdered className="h-4 w-4 text-muted-foreground" />
              <span className="font-semibold text-sm">Window Log</span>
              {windowLog.length > 0 && (
                <span className="text-xs text-muted-foreground">({windowLog.length})</span>
              )}
            </div>
          </div>

          {loading && !availability.windowLog ? (
            <LoadingSpinner className="py-6" />
          ) : !availability.windowLog ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              Window history is temporarily unavailable — retrying automatically.
            </div>
          ) : windowLog.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              No windows recorded yet — data appears once the server enters the last {fmtWindowTime(timeAlertSeconds)} of a window.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="px-4 py-2 text-left font-medium">Series</th>
                    <th className="px-4 py-2 text-left font-medium">Window closes</th>
                    <th className="px-4 py-2 text-left font-medium">In zone?</th>
                    <th className="px-4 py-2 text-left font-medium">Outcome</th>
                    <th className="px-4 py-2 text-right font-medium">Spent</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {windowLog.map((w, i) => {
                    const closeLabel = w.closeTime
                      ? new Date(w.closeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      : '—';
                    const zoneLabel = !w.entered
                      ? <span className="text-muted-foreground text-xs">not entered</span>
                      : w.inZone
                        ? <span className="text-xs text-amber-600 dark:text-amber-400 font-mono">
                            YES {w.yesDerivedAsk ?? '?'}¢ / NO {w.noDerivedAsk ?? '?'}¢
                          </span>
                        : <span className="text-xs text-muted-foreground">outside zone</span>;

                    const outcomeBadge = (() => {
                      switch (w.outcome) {
                        case 'traded':
                          return <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                            ✓ {w.side?.toUpperCase()} {w.priceCents}¢
                          </span>;
                        case 'zero_fill':
                          return <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                            title={w.skipReason === 'zero_fill_retry_budget_exhausted' ? 'retry cap hit' : undefined}
                          >
                            0-fill{w.skipReason === 'zero_fill_retry_budget_exhausted' ? ' · retry cap hit' : ''}
                          </span>;
                        case 'zero_fill_retried':
                          return <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
                            0-fill · retried
                          </span>;
                        case 'skipped':
                          return <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">
                            skipped{w.skipReason ? `: ${w.skipReason}` : ''}
                          </span>;
                        case 'out_of_zone':
                          return <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
                            out of zone
                          </span>;
                        case 'pending':
                          return <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                            pending…
                          </span>;
                      }
                    })();

                    return (
                      <tr key={i} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 font-mono text-xs font-medium">{w.series}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{closeLabel}</td>
                        <td className="px-4 py-2.5">{zoneLabel}</td>
                        <td className="px-4 py-2.5">{outcomeBadge}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
                          {w.spentDollars != null
                            ? <span className="text-foreground">${w.spentDollars.toFixed(2)}</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </Layout>
  );
}

/** Fallback tiers used when the server endpoint is unreachable. */
const FALLBACK_TIERS: PriceTier[] = [
  { label: '89–95¢', min: 89, max: 95 },
];

interface TiersResult {
  tiers: PriceTier[];
  /** Server-authoritative version string. Include as tier_version in any
   *  POST /api/trade/order body so the server can reject stale-tier requests. */
  version: string | null;
}
function useTiers(): TiersResult {
  const [result, setResult] = useState<TiersResult>({ tiers: FALLBACK_TIERS, version: null });
  useEffect(() => {
    let alive = true;
    fetch('/api/trade/tiers', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { tiers: PriceTier[]; version?: string }) => {
        if (alive && Array.isArray(data.tiers) && data.tiers.length > 0) {
          setResult({ tiers: data.tiers, version: data.version ?? null });
        }
      })
      .catch(() => { /* keep FALLBACK_TIERS, version stays null */ });
    return () => { alive = false; };
  }, []);
  return result;
}
